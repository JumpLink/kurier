import { describe, expect, it } from '@gjsify/unit';

import { AcpClient } from '@kurier/acp/client';
import type { TranscriptEntry } from '@kurier/session';

import { AgentSession, type AgentSnapshot } from '../../../src/core/agent-session.ts';
import { OPENCODE_COMMAND } from '../../../src/core/agents/opencode.ts';
import { FixtureAgent, type FixtureAgentOptions } from '../../support/fixture-agent.ts';

const SESSION = { id: 'ses_fixture_0001', cwd: '/fixture' };
const AT = '2026-10-01T12:00:00.000Z';

interface Harness {
  readonly session: AgentSession;
  readonly agent: FixtureAgent;
  readonly snapshots: AgentSnapshot[];
  readonly entries: TranscriptEntry[];
  readonly persisted: { sessionId: string; entries: TranscriptEntry[] }[];
  readonly notices: string[];
  /** True once `onSpawn`'s closer has been called — the "nothing unowned" assertion. */
  spawnCloserUsed(): boolean;
  /** One tick of the microtask queue, which is where the fixture's turn replies land. */
  flush(): Promise<void>;
}

interface HarnessOptions extends FixtureAgentOptions {
  /** Make `openAgent` reject, to exercise the "failed to start" path without a missing binary. */
  failWith?: Error;
  /**
   * Bind a session in the harness. Off by default, so a test can observe the state *before* anything
   * has happened to it — which is the only way to assert what the constructor does and does not do.
   */
  bind?: boolean;
}

/**
 * A controller over `FixtureAgent` — a real ACP peer, in this process.
 *
 * **The `open` seam is what makes this possible without a subprocess.** `openAgent` builds a
 * `StdioChannel` and nothing else; swap the transport for `FixtureAgent.transport` and the whole
 * controller — connect, reattach, stream, persist, cancel, settle — runs on both runtimes with no
 * process anywhere. This is the Node half of the rule AGENTS.md states: a change that made the Node run
 * impossible would be in the wrong file.
 */
function harness(options: HarnessOptions = {}): Harness {
  const agent = new FixtureAgent(options);
  const snapshots: AgentSnapshot[] = [];
  const entries: TranscriptEntry[] = [];
  const persisted: { sessionId: string; entries: TranscriptEntry[] }[] = [];
  const notices: string[] = [];
  let spawnCloserUsed = false;
  let tick = 0;
  const clock = (): string => {
    tick += 1;
    return new Date(Date.parse(AT) + tick * 1000).toISOString();
  };

  const session = new AgentSession({
    command: OPENCODE_COMMAND,
    now: clock,
    events: {
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onEntries: (batch) => entries.push(...batch),
      onNotice: (message) => notices.push(message),
    },
    append: (sessionId, batch) => persisted.push({ sessionId, entries: batch }),
    // The gate kurier passes is the gate the client answers with, so the refusal assertions are about
    // the wire and not about a local array — that is what makes guardrail 2 a measurement.
    open: async (openOptions) => {
      openOptions.onSpawn?.(() => {
        spawnCloserUsed = true;
      });
      if (options.failWith) throw options.failWith;
      const client = new AcpClient({ transport: agent.transport, gate: openOptions.gate });
      await client.initialize();
      return { client, logLines: [], agentInfo: 'FixtureAgent 0.1.0', close: () => client.close() };
    },
  });

  if (options.bind !== false) session.bind(SESSION);
  return {
    session,
    agent,
    snapshots,
    entries,
    persisted,
    notices,
    spawnCloserUsed: () => spawnCloserUsed,
    flush: async () => {
      // The fixture's turn runs on the microtask queue, so a fixed number of ticks is what "the turn has
      // progressed" means here. A real timer would make the suite slow and no more correct.
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    },
  };
}

export default async () => {
  await describe('agent-session — spawning', async () => {
    await it('emits nothing from its constructor', async () => {
      // Measured, not assumed. A caller that has just constructed the controller holds the only state
      // there is, so it can read `snapshot` — and an emit here reached a caller whose widgets were not
      // built yet, which is a crash inside a constructor, before there was a window to report it on.
      // `refresh()` is the explicit, safe way to ask for the first render.
      const h = harness({ bind: false });
      expect(h.snapshots.length).toBe(0);
      h.session.refresh();
      expect(h.snapshots.length).toBe(1);
      expect(h.snapshots[0]?.state).toBe('idle');
    });

    await it('starts no agent on bind — a stored transcript is shown with no process', async () => {
      // Plan §6, and the reason a person can click through thirty sessions without thirty `opencode`s.
      const h = harness({ bind: false });
      expect(h.snapshots.length).toBe(0);
      h.session.bind(SESSION);
      expect(h.snapshots.every((snapshot) => snapshot.attachment.status === 'none')).toBe(true);
      expect(h.session.snapshot.sessionId).toBe(SESSION.id);
    });

    await it('starts the agent on the first prompt, not before', async () => {
      const h = harness();
      await h.session.prompt('why is this slow?');
      expect(h.snapshots.map((s) => s.attachment.status)).toContain('attached');
      expect(h.snapshots.map((s) => s.attachment.status)).toContain('attaching');
    });

    await it('reports the agent it attached, by name', async () => {
      const h = harness();
      await h.session.prompt('hello');
      const attached = h.snapshots.find((s) => s.attachment.status === 'attached');
      expect(attached?.attachment).toStrictEqual({ status: 'attached', name: 'FixtureAgent 0.1.0' });
    });

    await it('reuses one process for a second turn — one agent per window', async () => {
      const h = harness();
      await h.session.prompt('first');
      const spawnsAfterFirst = h.snapshots.filter((s) => s.attachment.status === 'attaching').length;
      await h.session.prompt('second');
      expect(h.snapshots.filter((s) => s.attachment.status === 'attaching').length).toBe(spawnsAfterFirst);
    });

    await it('registers the spawn-time closer before the handshake, so no process is unowned', async () => {
      // The whole reason `onSpawn` exists: a cold `opencode acp` takes seconds to answer `initialize`,
      // and a close in that window used to leave the agent running with nothing owning it.
      const h = harness();
      await h.session.prompt('hello');
      expect(h.session.agentRunning).toBe(true);
      expect(h.spawnCloserUsed()).toBe(false); // Registered, not yet used — nothing has closed it.
    });
  });

  await describe('agent-session — the stream', async () => {
    await it("records the person's own prompt before anything is sent", async () => {
      // It has to be on screen while the handshake is still running; a prompt that appeared only after
      // `session/prompt` was accepted would look lost for the seconds a cold agent takes.
      const h = harness();
      const sent = h.session.prompt('why is this slow?');
      await h.flush();
      expect(h.entries[0]).toStrictEqual({
        kind: 'user',
        text: 'why is this slow?',
        at: h.entries[0]?.at,
        sessionId: SESSION.id,
      });
      await sent;
    });

    await it("streams the agent's chunks in arrival order, one batch at a time", async () => {
      const h = harness({ chunks: ['first ', 'answer'] });
      await h.session.prompt('hello');
      const texts = h.entries.filter((e) => e.kind === 'agent').map((e) => e.text);
      expect(texts).toStrictEqual(['first ', 'answer']);
      // Two notifications, two batches: batching would hold the first token the person is waiting for.
      const batches = h.persisted.filter((batch) => batch.entries.some((entry) => entry.kind === 'agent'));
      expect(batches.length).toBe(2);
    });

    await it("drops the agent's echo of our prompt, and keeps anything else", async () => {
      const h = harness();
      await h.session.prompt('why is this slow?');
      // `FixtureAgent` echoes the prompt as `user_message_chunk`, exactly like opencode does.
      const users = h.entries.filter((entry) => entry.kind === 'user');
      expect(users.length).toBe(1);
      expect(users[0]?.text).toBe('why is this slow?');
    });

    await it('ignores an update that belongs to another session', async () => {
      // opencode announces child sessions on the same connection; filing one in this record would make
      // the file disagree with the agent.
      const h = harness();
      await h.session.prompt('hello');
      const before = h.entries.length;
      h.agent.calls('session/prompt');
      // Push an update for a different session straight down the fixture's transport.
      const listener = h.agent.transport as unknown as { write: (data: string) => void };
      listener.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 9999,
          method: 'session/prompt',
          params: { sessionId: 'ses_other', prompt: [{ type: 'text', text: 'child' }] },
        }),
      );
      await h.flush();
      expect(h.entries.length).toBe(before);
    });

    await it('persists every batch to the session it belongs to', async () => {
      const h = harness({ chunks: ['one', 'two'] });
      await h.session.prompt('hello');
      expect(h.persisted.length).toBeGreaterThan(0);
      for (const batch of h.persisted) expect(batch.sessionId).toBe(SESSION.id);
    });

    await it('records the history an agent replays on load exactly once, not twice', async () => {
      // `FixtureAgent.loadSession` replays its chunks as `session/update`, and it uses the same
      // `chunks` list for the prompt turn. So one `load` plus one turn would be **two** occurrences of
      // the word if kurier recorded the replay — and kurier already has that conversation on disk, so
      // writing it again is a duplication in the store, not a detail.
      //
      // `reattach` runs before `runTurn` subscribes, which is what makes this one. Measured here rather
      // than reasoned about, because the ordering is the whole claim.
      const h = harness({ chunks: ['replayed'] });
      await h.session.prompt('hello');
      expect(h.agent.calls('session/load').length).toBe(1);
      const occurrences = h.entries.filter((entry) => entry.text === 'replayed');
      expect(occurrences.length).toBe(1);
    });
  });

  await describe('agent-session — the gate', async () => {
    const PERMISSION = [
      { optionId: 'allow', name: 'Allow once', kind: 'allow_once' as const },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' as const },
    ];

    await it('refuses a permission request rather than allowing it', async () => {
      // Guardrail 2. The stand-in GUI has no dialog yet (plan §7 step 6), and "no dialog" must not
      // become "allowed".
      const h = harness({ permissionOptions: PERMISSION });
      await h.session.prompt('do a thing');
      expect(h.agent.permissionAsked.length).toBe(1);
      expect(h.agent.permissionOutcomes[0]?.outcome.outcome).toBe('cancelled');
    });

    await it('answers with no option id, because no decision was made', async () => {
      const h = harness({ permissionOptions: PERMISSION });
      await h.session.prompt('do a thing');
      const outcome = h.agent.permissionOutcomes[0]?.outcome;
      // `null` is the one answer any gate may give, and it is `cancelled` — not `reject`, because kurier
      // did not pick one of the agent's options on a person's behalf.
      expect(outcome).toStrictEqual({ outcome: 'cancelled' });
    });

    await it('writes the refusal into the transcript, so it is not a silent denial', async () => {
      const h = harness({ permissionOptions: PERMISSION });
      await h.session.prompt('do a thing');
      const refusal = h.entries.find((entry) => entry.text.startsWith('refused:'));
      expect(refusal?.text).toContain('write a file');
    });

    await it('does not hang the turn — the agent is answered while its request is fresh', async () => {
      const h = harness({ permissionOptions: PERMISSION });
      await h.session.prompt('do a thing');
      // The turn settled rather than waiting for a dialog nobody will show.
      expect(h.session.turnRunning).toBe(false);
      expect(h.snapshots[h.snapshots.length - 1]?.state).toBe('idle');
    });
  });

  await describe('agent-session — stopping', async () => {
    it('sends session/cancel and stays in thinking until the turn has answered', async () => {
      // `holdTurn` parks the fixture's turn, so the cancel lands *inside* it — the shape a real agent has
      // while it works. Asserted in that order deliberately: a controller that left `thinking` on the
      // click rather than on the answer would pass the second assertion and fail the first.
      const h = harness({ holdTurn: true });
      const sent = h.session.prompt('a long question');
      await h.flush();
      expect(h.session.snapshot.state).toBe('thinking');

      h.session.stop();
      // The cancel has gone out and the turn has not answered yet.
      expect(h.agent.calls('session/cancel').length).toBe(1);
      expect(h.session.snapshot.state).toBe('thinking');

      await sent;
      expect(h.session.snapshot.state).toBe('stopped');
    });

    await it('does not kill anything — Stop is a notification, and the process stays', async () => {
      const h = harness({ holdTurn: true });
      const sent = h.session.prompt('hello');
      await h.flush();
      h.session.stop();
      // The connection is untouched: Stop is `session/cancel`, never a kill of the subprocess (the same
      // rule the CLI's Ctrl-C obeys).
      expect(h.session.agentRunning).toBe(true);
      expect(h.agent.closed).toBe(false);
      await sent;
    });

    await it('is a no-op with no turn running', async () => {
      const h = harness();
      h.session.stop();
      expect(h.agent.calls('session/cancel').length).toBe(0);
    });

    await it('a turn that ends by itself is idle, not stopped', async () => {
      // Nobody pressed Stop, so "Stopped" would put a word in the person's mouth. `releaseTurn` is the
      // fixture's way of ending a held turn without a cancel.
      const h = harness({ holdTurn: true });
      const sent = h.session.prompt('hello');
      await h.flush();
      h.agent.releaseTurn();
      await sent;
      expect(h.agent.calls('session/cancel').length).toBe(0);
      expect(h.session.snapshot.state).toBe('idle');
    });

    await it('a stop during the handshake sends no prompt and no cancel', async () => {
      // Nothing is in flight yet: there is no turn to cancel, and no `session/prompt` to cancel it with.
      const h = harness({ failWith: new Error('handshake never finished') });
      h.session.stop();
      await h.session.prompt('hello');
      expect(h.agent.calls('session/prompt').length).toBe(0);
      expect(h.agent.calls('session/cancel').length).toBe(0);
    });

    await it('a stop while the history is still loading sends no prompt either', async () => {
      // The window the handshake test above cannot reach, and where the defect lived. `session/load`
      // replays a cold session's whole history, and prompting is what causes the load — so this is the
      // first prompt of every session, not an edge case. A Stop here arrives with no turn in flight,
      // and the one that mattered was dropped: the prompt went out anyway, the agent answered in full,
      // and the surface sat in `thinking` after the person had pressed Stop.
      const h = harness({ holdLoad: true });
      const sent = h.session.prompt('hello');
      await h.flush();
      // The load is parked, so the turn is between "handshake done" and "prompt sent" right now.
      h.session.stop();
      h.agent.releaseLoad();
      await sent;
      expect(h.agent.calls('session/prompt').length).toBe(0);
      // And the surface must have left `thinking` rather than waiting for an answer that is not coming.
      expect(h.session.snapshot.state).not.toBe('thinking');
      expect(h.session.snapshot.state).toBe('stopped');
    });
  });

  await describe('agent-session — an agent that dies', async () => {
    it('is gone, with no stopReason and the plan §6 line in the transcript', async () => {
      // The agent vanishes mid-turn: the transport ends, `session/prompt` rejects, and nothing answered.
      // Inventing an `end_turn` here is the fabrication §6 forbids.
      const h = harness({ holdTurn: true });
      const sent = h.session.prompt('hello');
      await h.flush();
      h.agent.vanish('the agent process ended');
      await sent;
      expect(h.session.snapshot.state).toBe('gone');
      const line = h.entries.find((entry) => entry.text.includes('the agent exited during this turn'));
      expect(line?.kind).toBe('system');
    });

    await it('reports the exit reason, so the state says why', async () => {
      const h = harness({ holdTurn: true });
      const sent = h.session.prompt('hello');
      await h.flush();
      h.agent.vanish('the agent process ended with code 1');
      await sent;
      const attachment = h.session.snapshot.attachment;
      expect(attachment.status).toBe('gone');
      if (attachment.status === 'gone') expect(attachment.reason).toContain('code 1');
    });

    await it('has no fabricated completion in the transcript', async () => {
      const h = harness({ holdTurn: true });
      const sent = h.session.prompt('hello');
      await h.flush();
      h.agent.vanish();
      await sent;
      const texts = h.entries.map((entry) => entry.text);
      expect(texts.some((text) => text.includes('end_turn'))).toBe(false);
    });
  });

  await describe('agent-session — failing to start', async () => {
    it('is a sentence on the surface, not an exception', async () => {
      // A bad command, a handshake timeout and a protocol mismatch all land here, and a person must be
      // able to read what to do rather than watch a spinner that will never resolve.
      const h = harness({ failWith: new Error('spawn opencode ENOENT') });
      await h.session.prompt('hello');
      expect(h.session.snapshot.attachment.status).toBe('failed');
      // `idle`, not `thinking`: a turn that never started must not leave the window looking busy, and
      // `thinking` would show a Stop button that has nothing to stop.
      expect(h.session.snapshot.state).toBe('idle');
    });

    it('leaves no turn state behind, because no turn ran', async () => {
      const h = harness({ failWith: new Error('handshake failed') });
      await h.session.prompt('hello');
      // The *final* state, not "thinking never appeared": the controller does pass through `thinking`
      // when the prompt is recorded, which is right — the turn was announced before it could fail. What
      // must not survive is a window still looking busy afterwards, because `thinking` shows a Stop
      // button with nothing to stop.
      expect(h.session.snapshot.state).toBe('idle');
      expect(h.session.turnRunning).toBe(false);
    });

    it('reports the auth hint through the attachment, which is where the composer shows it', async () => {
      const h = harness({ requireAuth: true });
      await h.session.prompt('hello');
      const attachment = h.session.snapshot.attachment;
      // `session/load` was refused, so no prompt was ever sent: this is a failure to start, not a turn
      // that went wrong half way through.
      expect(attachment.status).toBe('failed');
      if (attachment.status === 'failed') {
        // `withAuthHint`'s sentence, which names `kurier auth` — the remedy a window has no terminal
        // for (plan §6, trap 1).
        expect(attachment.message).toContain('kurier auth');
      }
    });

    await it("keeps the person's own prompt, which was recorded before the failure", async () => {
      const h = harness({ failWith: new Error('spawn ENOENT') });
      await h.session.prompt('a question worth keeping');
      expect(h.entries[0]?.text).toBe('a question worth keeping');
    });
  });

  await describe('agent-session — closing the window', async () => {
    it('cancels, waits for the turn, and only then ends the process', async () => {
      // Plan §6's ordering, and the one that is not interchangeable: terminating first SIGTERMs the agent
      // out of the turn it is in the middle of, which loses whatever it had not flushed.
      const h = harness({ holdTurn: true });
      const sent = h.session.prompt('hello');
      await h.flush();
      expect(h.session.turnRunning).toBe(true);

      await h.session.shutdown();
      // The turn answered `cancelled` *before* the connection ended, so its settlement is the record.
      expect(h.session.snapshot.state).toBe('stopped');
      expect(h.agent.calls('session/cancel').length).toBe(1);
      expect(h.agent.closed).toBe(true);
      await sent;
    });

    it('resolves rather than hanging when no turn is running', async () => {
      const h = harness();
      await h.session.prompt('hello');
      await h.session.shutdown();
      expect(h.agent.closed).toBe(true);
    });

    it('ends a process that exists with no turn — the handshake window', async () => {
      // The orphan `onSpawn` exists to prevent: a close between spawn and the first answer must not leave
      // an agent running behind the window. `agentRunning` is what the window's close-request reads, so it
      // has to become false here or the close path would not know there was anything to end.
      const h = harness();
      await h.session.prompt('hello');
      await h.session.shutdown();
      expect(h.session.agentRunning).toBe(false);
    });

    it('is idempotent, because the window calls it and its closer afterwards', async () => {
      const h = harness();
      await h.session.prompt('hello');
      await h.session.shutdown();
      await h.session.shutdown();
      expect(h.agent.closed).toBe(true);
    });
  });

  await describe('agent-session — the prompts themselves', async () => {
    it('ignores an empty prompt: there is no turn to run and nothing to record', async () => {
      const h = harness();
      await h.session.prompt('   ');
      expect(h.entries.length).toBe(0);
      expect(h.agent.calls('session/prompt').length).toBe(0);
    });

    it('ignores a prompt with no session open — nowhere to send it', async () => {
      const h = harness();
      h.session.bind(null);
      await h.session.prompt('hello');
      expect(h.agent.calls('session/prompt').length).toBe(0);
      expect(h.entries.length).toBe(0);
      // The binding is what the composer reads to decide Send is even enabled, so it has to be null here
      // — not merely unused.
      expect(h.session.snapshot.sessionId).toBe(null);
    });

    it('trims the prompt, so a stray newline is not part of the question', async () => {
      const h = harness();
      await h.session.prompt('  hello\n');
      expect(h.entries[0]?.text).toBe('hello');
    });
  });
};
