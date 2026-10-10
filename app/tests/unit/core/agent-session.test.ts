import { describe, expect, it } from '@gjsify/unit';

import { AcpClient } from '@lotse/acp/client';
import type { AgentSource, SessionRecord, TranscriptEntry } from '@lotse/session';

import {
  AgentSession,
  OPENCODE_COMMAND,
  composerView,
  failureNotice,
  unsavedMessage,
  type AgentCommand,
  type AgentSnapshot,
  type ConfigRowView,
  type McpServer,
  type PermissionQuestion,
  type RecordedResolution,
} from '@lotse/core';
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
  /** Records handed to `create`, and the ones the surface was told about, in order. */
  readonly created: SessionRecord[];
  readonly conversations: SessionRecord[];
  /** The command of every process the controller started. */
  readonly opened: AgentCommand[];
  /** How many connections the controller has ended. */
  closed(): number;
  /** Every config view handed to the surface, in order. */
  readonly configViews: ConfigRowView[];
  /** True once `onSpawn`'s closer has been called — the "nothing unowned" assertion. */
  spawnCloserUsed(): boolean;
  /** Let a `slowClose` close finish. */
  finishClose(): void;
  /** One tick of the microtask queue, which is where the fixture's turn replies land. */
  flush(): Promise<void>;
  /**
   * Wait until something the fixture only does asynchronously has happened.
   *
   * **`flush` cannot express this.** A gate question is put to the surface after the handshake, the
   * `session/load` and the prompt — several awaits deep — so "the question is on screen" has no fixed
   * tick count, and a fixed count is a number that happens to work today. A one-millisecond timer with
   * a bound fails loudly instead: it is the difference between waiting for the event and guessing when
   * it happens.
   */
  waitUntil(seen: () => boolean): Promise<void>;
}

interface HarnessOptions extends FixtureAgentOptions {
  /** Make `openAgent` reject, to exercise the "failed to start" path without a missing binary. */
  failWith?: Error;
  /**
   * Bind a session in the harness. Off by default, so a test can observe the state *before* anything
   * has happened to it — which is the only way to assert what the constructor does and does not do.
   */
  bind?: boolean;
  /**
   * Stand in for the surface's dialog. Absent means "no surface can ask", which is the CLI and is
   * guardrail 2 — the same path, not a special case.
   */
  onPermission?: (question: PermissionQuestion) => Promise<string | null | undefined>;
  /** Which copy the window's command is, for the record a new conversation writes. */
  source?: AgentSource;
  /** What `create` throws, to exercise a store that cannot write. */
  createFails?: Error;
  resolveAgent?: (id: string, source: AgentSource | undefined) => Promise<RecordedResolution>;
  /** `close()` returns a promise that `finishClose()` resolves, like a process that is still ending. */
  slowClose?: boolean;
  /** Refuse every `open` after the first: the fixture has one transport, so a second process cannot be real. */
  failAfterFirstOpen?: boolean;
  mcpServers?: McpServer[];
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
  const configViews: ConfigRowView[] = [];
  const created: SessionRecord[] = [];
  const conversations: SessionRecord[] = [];
  const opened: AgentCommand[] = [];
  let spawnCloserUsed = false;
  let closed = 0;
  let finishClose = (): void => {};
  const closing = new Promise<void>((resolve) => {
    finishClose = resolve;
  });
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
      // The row's own channel, collected like the snapshots: what a surface would be handed, and the
      // only way to see *when* it was handed something rather than only what it holds now.
      onConfig: (view) => configViews.push(view),
      onConversation: (record) => conversations.push(record),
      // Spread so an absent hook stays absent: `onPermission: undefined` would be a hook that exists
      // and cannot ask, which is not the same thing the CLI has.
      ...(options.onPermission ? { onPermission: options.onPermission } : {}),
    },
    append: (sessionId, batch) => persisted.push({ sessionId, entries: batch }),
    create: (record) => {
      if (options.createFails) throw options.createFails;
      created.push(record);
    },
    ...(options.source ? { source: options.source } : {}),
    ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
    ...(options.resolveAgent ? { resolveAgent: options.resolveAgent } : {}),
    // The gate kurier passes is the gate the client answers with, so the refusal assertions are about
    // the wire and not about a local array — that is what makes guardrail 2 a measurement.
    open: async (openOptions) => {
      opened.push(openOptions.command);
      openOptions.onSpawn?.(() => {
        spawnCloserUsed = true;
      });
      if (options.failWith) throw options.failWith;
      if (options.failAfterFirstOpen && opened.length > 1)
        throw new Error('the second process could not start');
      const client = new AcpClient({ transport: agent.transport, gate: openOptions.gate });
      await client.initialize();
      return {
        client,
        logLines: [],
        agentInfo: 'FixtureAgent 0.1.0',
        close: () => {
          closed += 1;
          client.close();
          return options.slowClose ? closing : undefined;
        },
      };
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
    created,
    conversations,
    opened,
    closed: () => closed,
    finishClose: () => finishClose(),
    configViews,
    spawnCloserUsed: () => spawnCloserUsed,
    flush: async () => {
      // The fixture's turn runs on the microtask queue, so a fixed number of ticks is what "the turn has
      // progressed" means here. A real timer would make the suite slow and no more correct.
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    },
    waitUntil: async (seen) => {
      for (let i = 0; i < 2_000 && !seen(); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      if (!seen()) throw new Error('the fixture never got there within two seconds');
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

  // A conversation that does not exist yet: the window opens on an empty composer, and the first prompt is
  // what makes the session. Everything here goes through the real client against `FixtureAgent`.
  await describe('agent-session — a new conversation', async () => {
    const NEW_CWD = '/synthetic/project';

    function fresh(options: HarnessOptions = {}): Harness {
      const h = harness({ bind: false, ...options });
      h.session.startConversation(NEW_CWD);
      return h;
    }

    await it('offers a first prompt and starts no process until it is sent', async () => {
      const h = fresh();
      expect(h.session.snapshot.sessionId).toBe(null);
      expect(h.session.snapshot.startsConversation).toBe(true);
      expect(h.session.agentRunning).toBe(false);
      expect(h.opened.length).toBe(0);
      expect(h.created.length).toBe(0);
    });

    await it('sends session/new with the directory, writes the record, then prompts', async () => {
      const h = fresh({ source: 'bundled' });
      await h.session.prompt('  Summarise this repository.  \nsecond line');
      const methods = h.agent.sent.map((entry) => entry.method);
      expect(methods.indexOf('session/new')).toBeGreaterThan(-1);
      expect(methods.indexOf('session/new')).toBeLessThan(methods.indexOf('session/prompt'));
      expect(methods).not.toContain('session/load');
      const params = h.agent.sent.find((entry) => entry.method === 'session/new')?.params as { cwd: string };
      expect(params.cwd).toBe(NEW_CWD);

      expect(h.created.length).toBe(1);
      const record = h.created[0]!;
      expect(record.id).toBe('ses_fixture_0001');
      expect(record.agent).toBe(OPENCODE_COMMAND.id);
      expect(record.agentSource).toBe('bundled');
      expect(record.cwd).toBe(NEW_CWD);
      expect(record.title).toBe('Summarise this repository.');
      expect(record.reattach).toBe('load');
      expect(h.conversations).toStrictEqual([record]);
    });

    await it('behaves like an opened session afterwards: bound, idle, and the next turn is a plain prompt', async () => {
      const h = fresh();
      await h.session.prompt('first');
      expect(h.session.snapshot.sessionId).toBe('ses_fixture_0001');
      expect(h.session.snapshot.startsConversation).toBe(false);
      expect(h.session.snapshot.state).toBe('idle');
      await h.session.prompt('second');
      const methods = h.agent.sent.map((entry) => entry.method);
      expect(methods.filter((method) => method === 'session/new').length).toBe(1);
      expect(methods.filter((method) => method === 'session/load').length).toBe(0);
      expect(h.opened.length).toBe(1);
    });

    await it('draws the person’s line first and persists it under the new session', async () => {
      const h = fresh();
      await h.session.prompt('hello there');
      expect(h.entries[0]).toMatchObject({ kind: 'user', text: 'hello there' });
      const user = h.persisted.flatMap((batch) => batch.entries).filter((entry) => entry.kind === 'user');
      expect(user.length).toBe(1);
      expect(user[0]).toMatchObject({ text: 'hello there', sessionId: 'ses_fixture_0001' });
      expect(h.persisted.every((batch) => batch.sessionId === 'ses_fixture_0001')).toBe(true);
      // Not drawn twice: the agent's echo of the prompt is filtered as it is for any turn.
      expect(h.entries.filter((entry) => entry.kind === 'user').length).toBe(1);
    });

    await it('shows the agent’s options for the new session', async () => {
      const h = fresh();
      await h.session.prompt('hello');
      expect(h.session.configOptions).not.toBe(null);
    });

    await it('ignores an empty prompt, and a window with neither a session nor a conversation', async () => {
      const h = fresh();
      await h.session.prompt('   ');
      expect(h.opened.length).toBe(0);
      const none = harness({ bind: false });
      await none.session.prompt('hello');
      expect(none.opened.length).toBe(0);
    });

    await it('is a sentence, and writes nothing, when the agent cannot start', async () => {
      const h = fresh({ failWith: new Error('spawn opencode ENOENT') });
      await h.session.prompt('hello');
      expect(h.session.snapshot.attachment.status).toBe('failed');
      expect(h.session.snapshot.state).toBe('idle');
      expect(h.created.length).toBe(0);
      expect(h.persisted.length).toBe(0);
      expect(h.session.snapshot.startsConversation).toBe(true);
    });

    await it('names the login trap at session/new, as it does for a reattach', async () => {
      const h = fresh({ requireAuth: true });
      await h.session.prompt('hello');
      const attachment = h.session.snapshot.attachment;
      expect(attachment.status === 'failed' && attachment.kind).toBe('auth');
      expect(h.created.length).toBe(0);
    });

    await it('is a start failure when the record cannot be written, and sends no prompt', async () => {
      const h = fresh({ createFails: new Error('EACCES: cannot write the session file') });
      await h.session.prompt('hello');
      const attachment = h.session.snapshot.attachment;
      expect(attachment.status === 'failed' && attachment.kind).toBe('start');
      expect(attachment.status === 'failed' && attachment.message).toContain('EACCES');
      expect(h.agent.sent.map((entry) => entry.method)).not.toContain('session/prompt');
      expect(h.conversations.length).toBe(0);
    });

    await it('forgives a failed start when the person asks for a new chat, and keeps a refused model', async () => {
      const h = fresh({ failWith: new Error('spawn opencode ENOENT') });
      await h.session.prompt('hello');
      expect(h.session.snapshot.attachment.status).toBe('failed');
      h.session.startConversation(NEW_CWD);
      expect(h.session.snapshot.attachment.status).toBe('none');
      expect(h.session.snapshot.startsConversation).toBe(true);

      const refused = fresh({ promptAuth: true });
      await refused.session.prompt('hello');
      const before = refused.session.snapshot.attachment;
      expect(before.status === 'failed' && before.kind).toBe('model');
      refused.session.startConversation(NEW_CWD);
      expect(refused.session.snapshot.attachment).toBe(before);
    });

    await it('restartAgent forgives a login trap and retires the process, so the next prompt starts a new one', async () => {
      const h = fresh({ requireAuth: true });
      h.session.startConversation(NEW_CWD);
      await h.session.prompt('hello');
      const before = h.session.snapshot.attachment;
      expect(before.status === 'failed' && before.kind).toBe('auth');
      const closedBefore = h.closed();
      expect(await h.session.restartAgent()).toBe(true);
      expect(h.session.snapshot.attachment.status).toBe('none');
      expect(h.closed()).toBe(closedBefore + 1);
    });

    await it('leaves the pending conversation when a stored session is opened, and comes back to it', async () => {
      const h = fresh();
      h.session.bind(SESSION);
      expect(h.session.snapshot.startsConversation).toBe(false);
      expect(h.session.snapshot.sessionId).toBe(SESSION.id);
      h.session.startConversation(NEW_CWD);
      expect(h.session.snapshot.startsConversation).toBe(true);
      expect(h.session.snapshot.sessionId).toBe(null);
    });

    await it('ends where it began when Stop lands during the handshake: no session, no record', async () => {
      const h = fresh();
      const sent = h.session.prompt('hello');
      // The turn exists the moment `prompt` returns its promise, and the handshake has not finished:
      // Stop only records the intention, and `#runNewConversation` acts on it before `session/new`.
      h.session.stop();
      await sent;
      expect(h.created.length).toBe(0);
      expect(h.agent.sent.map((entry) => entry.method)).not.toContain('session/new');
      expect(h.agent.sent.map((entry) => entry.method)).not.toContain('session/prompt');
      expect(h.session.snapshot.state).toBe('stopped');
    });
  });

  // Opening a stored session reattaches it on the copy of the agent that holds its history.
  await describe('agent-session — the agent a stored session names', async () => {
    const BUNDLED: AgentCommand = {
      ...OPENCODE_COMMAND,
      title: 'bundled',
      program: '/synthetic/bundled',
      bundled: true,
    };
    const found = async (): Promise<RecordedResolution> => ({
      agent: { command: BUNDLED, source: 'bundled', version: '1.0.0', isolation: null },
    });

    await it('uses the window’s command when no resolver is wired — the pinned dev agent wins', async () => {
      const h = harness({ bind: false });
      h.session.bind({ ...SESSION, agent: { id: 'someone-else', source: 'bundled' } });
      await h.session.prompt('hello');
      expect(h.opened).toStrictEqual([OPENCODE_COMMAND]);
    });

    await it('asks the resolver for the record’s agent and copy, on the first prompt and not on bind', async () => {
      const asked: [string, AgentSource | undefined][] = [];
      const h = harness({
        bind: false,
        resolveAgent: async (id, source) => {
          asked.push([id, source]);
          return found();
        },
      });
      h.session.bind({ ...SESSION, agent: { id: 'opencode', source: 'bundled' } });
      expect(asked.length).toBe(0);
      await h.session.prompt('hello');
      expect(asked).toStrictEqual([['opencode', 'bundled']]);
      expect(h.opened).toStrictEqual([BUNDLED]);
    });

    await it('passes an absent source through as absent, which the resolver reads as host', async () => {
      const asked: (AgentSource | undefined)[] = [];
      const h = harness({
        bind: false,
        resolveAgent: async (_id, source) => {
          asked.push(source);
          return found();
        },
      });
      h.session.bind({ ...SESSION, agent: { id: 'opencode' } });
      await h.session.prompt('hello');
      expect(asked).toStrictEqual([undefined]);
    });

    await it('is a start failure naming why when the recorded copy is gone, and starts nothing', async () => {
      const problem = 'this session was started on the bundled opencode, which is not in this install';
      const h = harness({ bind: false, resolveAgent: async () => ({ problem }) });
      h.session.bind({ ...SESSION, agent: { id: 'opencode', source: 'bundled' } });
      await h.session.prompt('hello');
      const attachment = h.session.snapshot.attachment;
      expect(attachment.status === 'failed' && attachment.kind).toBe('start');
      expect(attachment.status === 'failed' && attachment.message).toBe(problem);
      expect(h.opened.length).toBe(0);
    });

    await it('does not restart the process for a second session on the same copy', async () => {
      const h = harness({ bind: false, resolveAgent: found });
      h.session.bind({ ...SESSION, agent: { id: 'opencode', source: 'bundled' } });
      await h.session.prompt('one');
      h.session.bind({ id: 'ses_other', cwd: '/synthetic', agent: { id: 'opencode', source: 'bundled' } });
      await h.session.prompt('two');
      expect(h.opened.length).toBe(1);
    });

    await it('replaces the process for a session held by the other copy', async () => {
      const h = harness({
        bind: false,
        failAfterFirstOpen: true,
        resolveAgent: async (_id, source) =>
          source === 'bundled'
            ? found()
            : { agent: { command: OPENCODE_COMMAND, source: 'host', version: null, isolation: null } },
      });
      h.session.bind({ ...SESSION, agent: { id: 'opencode', source: 'host' } });
      await h.session.prompt('one');
      expect(h.opened).toStrictEqual([OPENCODE_COMMAND]);
      h.session.bind({ id: 'ses_other', cwd: '/synthetic', agent: { id: 'opencode', source: 'bundled' } });
      expect(h.closed()).toBe(0);
      // The fixture has one transport, so the second process is refused; what is asserted is the
      // decision: the old process is ended and one for the other command is asked for.
      await h.session.prompt('two');
      expect(h.closed()).toBe(1);
      expect(h.opened).toStrictEqual([OPENCODE_COMMAND, BUNDLED]);
      expect(h.agent.calls('session/prompt').length).toBe(1);
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
      // **One assertion, not one per batch.** The claim is "every batch belongs to this session", and
      // how many batches a turn produced is a property of how the stream arrived — so a loop here makes
      // the *assertion count* of the whole suite depend on batching, which is how a run can print a
      // different number of assertions than the run before it on the same code. Comparing the distinct
      // session ids says the same thing and always costs one.
      expect([...new Set(h.persisted.map((batch) => batch.sessionId))]).toStrictEqual([SESSION.id]);
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

  await describe('agent-session — the host’s MCP servers', async () => {
    const SERVERS: McpServer[] = [
      { name: 'steuer', command: '/app/bin/steuer', args: ['mcp'], env: [{ name: 'A', value: 'b' }] },
      { type: 'http', name: 'remote', url: 'https://example.invalid/mcp', headers: [] },
    ];

    await it('sends [] in session/new and nothing extra in session/load by default', async () => {
      const fresh = harness({ bind: false });
      fresh.session.startConversation('/synthetic/project');
      await fresh.session.prompt('hello');
      const created = fresh.agent.calls('session/new')[0]?.params as { mcpServers: unknown };
      expect(created.mcpServers).toStrictEqual([]);

      const stored = harness();
      await stored.session.prompt('hello');
      const loaded = stored.agent.calls('session/load')[0]?.params as { mcpServers: unknown };
      expect(loaded.mcpServers).toStrictEqual([]);
    });

    await it('passes the list unchanged to session/new', async () => {
      const h = harness({ bind: false, mcpServers: SERVERS });
      h.session.startConversation('/synthetic/project');
      await h.session.prompt('hello');
      const params = h.agent.calls('session/new')[0]?.params as { mcpServers: unknown };
      expect(params.mcpServers).toStrictEqual(SERVERS);
    });

    await it('passes the list unchanged to the reattach of a stored session', async () => {
      const h = harness({ mcpServers: SERVERS });
      await h.session.prompt('hello');
      const params = h.agent.calls('session/load')[0]?.params as { mcpServers: unknown };
      expect(params.mcpServers).toStrictEqual(SERVERS);
    });
  });

  await describe('agent-session — the gate, with no surface that can ask', async () => {
    const PERMISSION = [
      { optionId: 'allow', name: 'Allow once', kind: 'allow_once' as const },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' as const },
    ];

    await it('refuses a permission request rather than allowing it', async () => {
      // Guardrail 2, still true where there is nobody to ask: the CLI and any surface that does not
      // implement `onPermission` get `cancelled`, and "no dialog" must never become "allowed".
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

    await it('writes the decision into the transcript, so it is not a silent denial', async () => {
      const h = harness({ permissionOptions: PERMISSION });
      await h.session.prompt('do a thing');
      const line = h.entries.find((entry) => entry.text.startsWith('not answered:'));
      expect(line?.text).toContain('write a file');
    });

    await it('does not hang the turn — the agent is answered while its request is fresh', async () => {
      const h = harness({ permissionOptions: PERMISSION });
      await h.session.prompt('do a thing');
      // The turn settled rather than waiting for a dialog nobody will show.
      expect(h.session.turnRunning).toBe(false);
      expect(h.snapshots[h.snapshots.length - 1]?.state).toBe('idle');
    });
  });

  await describe('agent-session — the gate, with a surface that asks', async () => {
    const PERMISSION = [
      { optionId: 'allow', name: 'Allow once', kind: 'allow_once' as const },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' as const },
    ];

    await it('asks the surface, and answers the agent with the option that was pressed', async () => {
      const asked: string[] = [];
      const h = harness({
        permissionOptions: PERMISSION,
        onPermission: async (question) => {
          asked.push(question.view.tool);
          return 'allow';
        },
      });
      await h.session.prompt('do a thing');
      expect(asked.length).toBe(1);
      expect(asked[0]).toContain('write a file');
      expect(h.agent.permissionOutcomes[0]?.outcome).toStrictEqual({
        outcome: 'selected',
        optionId: 'allow',
      });
    });

    await it('a surface that never offered that id cannot get it allowed', async () => {
      // The fail-closed rule, end to end and over the wire: a dialog resolving with `"close"` — its
      // dismissal id — must not come back as an allow. This is the assertion that would break first if
      // `decideFromView` ever mapped an unknown id to `allowed`.
      const h = harness({
        permissionOptions: PERMISSION,
        onPermission: async () => 'close',
      });
      await h.session.prompt('do a thing');
      expect(h.agent.permissionOutcomes[0]?.outcome).toStrictEqual({ outcome: 'cancelled' });
    });

    await it('a dismissing surface is recorded as "not answered", not as a refusal', async () => {
      const h = harness({
        permissionOptions: PERMISSION,
        onPermission: async () => 'close',
      });
      await h.session.prompt('do a thing');
      const line = h.entries.find((entry) => entry.text.startsWith('not answered:'));
      expect(line?.text).toContain('dismissed');
    });

    await it('the turn goes into waiting-for-you while the question is up', async () => {
      // `composer-state.ts` already renders this state; the dialog is what makes it reachable, so
      // without this the state would still be dead code with a widget pointing at it.
      const h = harness({
        permissionOptions: PERMISSION,
        onPermission: async () => {
          expect(h.session.snapshot.state).toBe('waiting-for-you');
          return 'reject';
        },
      });
      await h.session.prompt('do a thing');
      // …and leaves it when the answer arrives.
      expect(h.snapshots.map((snapshot) => snapshot.state)).toContain('waiting-for-you');
      expect(h.session.snapshot.state).toBe('idle');
    });

    await it('a second request while one is up waits its turn instead of stacking', async () => {
      // **What this measures, precisely.** The fixture's burst asks twice without waiting, which is
      // how an agent doing parallel tool calls behaves — but the serialisation that makes them arrive
      // one at a time happens in `AcpClient.#enqueuePermission` (`packages/acp/src/client.ts`), not in
      // this controller, and `permission-queue.test.ts` measures that layer's concurrency peak. So this
      // is an end-to-end test, not a desk test: it says the whole chain (fixture → client queue →
      // controller gate → desk → surface) shows the person two questions, in order, and answers both.
      // The desk's own queue is tested directly in `permission.test.ts`, where nothing upstream can
      // make it pass by luck.
      const shown: string[] = [];
      const h = harness({
        permissionOptions: PERMISSION,
        permissionBurst: 2,
        onPermission: async (question) => {
          shown.push(question.id);
          return 'reject';
        },
      });
      await h.session.prompt('do a thing');
      expect(shown.length).toBe(2);
      expect(new Set(shown).size).toBe(2);
      // Both answered, both refused, and the turn ended rather than hanging.
      expect(h.agent.permissionOutcomes.length).toBe(2);
      expect(h.agent.permissionOutcomes.every((outcome) => outcome?.outcome.outcome === 'selected')).toBe(
        true,
      );
      expect(h.session.turnRunning).toBe(false);
    });

    await it('Stop with a dialog up answers it cancelled rather than leaving the turn waiting', async () => {
      // The surface never answers, which is what a dialog a person walked away from looks like from
      // here. Stop has to settle it — otherwise the turn is waiting on a question nobody will ever see.
      const states: string[] = [];
      const h = harness({
        permissionOptions: PERMISSION,
        onPermission: () => {
          states.push(h.session.snapshot.state);
          return new Promise<string | null>(() => {});
        },
      });
      const turn = h.session.prompt('do a thing');
      await h.waitUntil(() => states.length > 0);
      // The state is read from inside the hook, which is the moment the question is actually up: a
      // fixed number of microtask ticks is only an approximation of when the fixture got there.
      expect(states).toStrictEqual(['waiting-for-you']);
      h.session.stop();
      await turn;
      // `cancelled` and not `refusal`: the request was answered, and the answer was that nobody
      // chose. The fixture's own turn then ends, which is what makes `await turn` return.
      expect(h.agent.permissionOutcomes[0]?.outcome).toStrictEqual({ outcome: 'cancelled' });
      expect(h.session.turnRunning).toBe(false);
    });

    await it('an answer that arrives after the Stop cannot turn cancelled into an allow', async () => {
      // The dialog's promise resolves *after* the Stop, with the allowing id. A surface that does that
      // is not misbehaving — GTK settles a dialog in either order while it is being torn down — so the
      // question is whether the answer kurier already gave can still be an allow. It cannot: the desk
      // holds no open question, so the late id lands on nothing and the outcome is already `cancelled`.
      let release: (id: string) => void = () => {};
      const asked = new Promise<void>((resolve) => {
        release = () => resolve();
      });
      const h = harness({
        permissionOptions: PERMISSION,
        onPermission: () =>
          new Promise<string>((resolve) => {
            void asked.then(() => resolve('allow'));
          }),
      });
      const turn = h.session.prompt('do a thing');
      await h.waitUntil(() => h.snapshots.some((snapshot) => snapshot.state === 'waiting-for-you'));
      h.session.stop();
      // Only now, with the turn already over, does the surface offer the allowing id.
      release('allow');
      await turn;
      expect(h.agent.permissionOutcomes[0]?.outcome).toStrictEqual({ outcome: 'cancelled' });
      // And only one answer ever reached the wire: the late one had nothing to attach to.
      expect(h.agent.permissionOutcomes.length).toBe(1);
    });

    await it('an agent that dies mid-question settles it, and says why', async () => {
      const h = harness({
        permissionOptions: PERMISSION,
        onPermission: () => new Promise<string | null>(() => {}),
      });
      const turn = h.session.prompt('do a thing');
      await h.flush();
      // The transport ends with the question still up: `#reportFailure` is the path that settles it.
      h.agent.vanish();
      await turn;
      // Nothing goes back over a dead wire — the agent is gone — so the assertion is on kurier's own
      // record: the question is settled, and the line says `agent-gone` rather than claiming a person
      // refused anything.
      expect(h.session.snapshot.attachment.status).toBe('gone');
      const line = h.entries.find((entry) => entry.text.startsWith('not answered:'));
      expect(line?.text).toContain('agent-gone');
    });

    await it('the staged request for KU_APP_PERMISSION goes through the same gate', async () => {
      // Not a dialog built for a screenshot: the real ask, with all four option kinds on the wire, so
      // what a screenshot shows is the gate's behaviour rather than a fixture's convenience. All four
      // reach the surface, in `orderOptions`' order — the `*_always` kinds are relayed, not filtered.
      const shown: string[] = [];
      const h = harness({
        onPermission: async (question) => {
          shown.push(...question.view.options.map((option) => option.optionId));
          return 'reject-once';
        },
      });
      const answer = await h.session.stagePermissionRequest();
      expect(shown).toStrictEqual(['reject-once', 'allow-once', 'allow-always', 'reject-always']);
      expect(answer).toStrictEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } });
    });

    await it('an "always allow" pressed on the staged request goes back with that exact id', async () => {
      // The pass-through end to end, through the controller and over the wire: kurier relays the agent's
      // own option id and adds nothing. The agent is what remembers the decision, so this is not a
      // promise kurier made.
      const h = harness({
        onPermission: async () => 'allow-always',
      });
      const answer = await h.session.stagePermissionRequest();
      expect(answer).toStrictEqual({ outcome: { outcome: 'selected', optionId: 'allow-always' } });
    });

    await it('the staged request records nothing — a question no agent asked is not history', async () => {
      // The staged request is a fixture, and `AGENTS.md` is explicit that the transcript is a *record
      // of what happened*. Writing "declined: Write src/hello.ts" into a real session file because a dev
      // hook was set would put a decision nobody made into somebody's conversation history — and it
      // would land in whichever session happens to be open.
      const h = harness({ bind: false });
      h.session.bind(SESSION);
      h.session.dismissPermission('dismissed');
      await h.session.stagePermissionRequest();
      expect(h.entries.filter((entry) => entry.text.includes('src/hello.ts'))).toStrictEqual([]);
      expect(h.persisted).toStrictEqual([]);
    });

    await it('the window can name its own ending, so a Stop and a close read differently', async () => {
      // Both are `cancelled` over the wire and they are not the same sentence: `dismissPermission`
      // is how the surface says *which* one, and without it every window-closed question would be
      // recorded as the vaguer `dismissed` that the dialog's own close produces.
      const h = harness({
        permissionOptions: PERMISSION,
        onPermission: () => new Promise<string | null>(() => {}),
      });
      const turn = h.session.prompt('do a thing');
      await h.waitUntil(() => h.snapshots.some((snapshot) => snapshot.state === 'waiting-for-you'));
      h.session.dismissPermission('window-closed');
      await turn;
      expect(h.agent.permissionOutcomes[0]?.outcome).toStrictEqual({ outcome: 'cancelled' });
      const line = h.entries.find((entry) => entry.text.startsWith('not answered:'));
      expect(line?.text).toContain('window-closed');
      // A second call is a no-op rather than an error: the window's close handler and
      // `shutdown()` both ask, and only the first has a question to settle.
      expect(() => h.session.dismissPermission('turn-cancelled')).not.toThrow();
    });

    await it('a Stop names turn-cancelled rather than the vaguer dismissed', async () => {
      const h = harness({
        permissionOptions: PERMISSION,
        onPermission: () => new Promise<string | null>(() => {}),
      });
      const turn = h.session.prompt('do a thing');
      await h.waitUntil(() => h.snapshots.some((snapshot) => snapshot.state === 'waiting-for-you'));
      h.session.stop();
      await turn;
      const line = h.entries.find((entry) => entry.text.startsWith('not answered:'));
      expect(line?.text).toContain('turn-cancelled');
    });
  });

  await describe('agent-session — stopping', async () => {
    await it('sends session/cancel and stays in thinking until the turn has answered', async () => {
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

  // New chat and a sidebar row are the person leaving a chat. A turn that belongs to it is stopped the way
  // the Stop button stops it, and nothing it says afterwards reaches the pane they went to.
  await describe('agent-session — leaving a running turn', async () => {
    const NEW_CWD = '/synthetic/project';
    const OTHER = { id: 'ses_fixture_0002', cwd: '/fixture' };

    await it('New chat stops the turn through session/cancel, and keeps late text off the empty pane', async () => {
      const h = harness({ holdTurn: true, chunks: ['first words'] });
      const sent = h.session.prompt('a long question');
      await h.flush();
      expect(h.entries.some((entry) => entry.text === 'first words')).toBe(true);
      const drawn = h.entries.length;

      h.session.startConversation(NEW_CWD);
      expect(h.agent.calls('session/cancel').length).toBe(1);
      // The turn is still settling, and says more before it does.
      h.agent.say(SESSION.id, 'late words');
      await h.flush();
      await sent;

      expect(h.entries.length).toBe(drawn);
      expect(h.entries.some((entry) => entry.text === 'late words')).toBe(false);
      // …but the conversation it belonged to keeps it: the record is the truth.
      const kept = h.persisted.filter((batch) => batch.sessionId === SESSION.id).flatMap((b) => b.entries);
      expect(kept.some((entry) => entry.text === 'late words')).toBe(true);
    });

    await it('ends idle on the new chat, with Send and not Stop, and no "Stopped."', async () => {
      const h = harness({ holdTurn: true });
      const sent = h.session.prompt('a long question');
      await h.flush();
      h.session.startConversation(NEW_CWD);
      await sent;
      const snapshot = h.session.snapshot;
      expect(snapshot.state).toBe('idle');
      expect(snapshot.startsConversation).toBe(true);
      const view = composerView({ ...snapshot, agent: h.session.agent });
      expect(view.action).toBe('send');
      expect(view.buttonEnabled).toBe(true);
      expect(view.status).toBe('');
    });

    await it('settles an open permission cancelled, naming turn-cancelled, like Stop', async () => {
      const h = harness({
        permissionOptions: [
          { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject', name: 'Decline', kind: 'reject_once' },
        ],
        onPermission: () => new Promise<string | null>(() => {}),
      });
      const turn = h.session.prompt('do a thing');
      await h.waitUntil(() => h.snapshots.some((snapshot) => snapshot.state === 'waiting-for-you'));
      h.session.startConversation(NEW_CWD);
      await turn;
      expect(h.agent.permissionOutcomes[0]?.outcome.outcome).toBe('cancelled');
      const recorded = h.persisted.flatMap((batch) => batch.entries);
      expect(recorded.find((entry) => entry.text.startsWith('not answered:'))?.text).toContain(
        'turn-cancelled',
      );
      // …and the question's line is in the record of the chat it was about, not on the new pane.
      expect(h.entries.some((entry) => entry.text.startsWith('not answered:'))).toBe(false);
    });

    await it('opening another session mid-turn does the same; the same session does not stop it', async () => {
      const same = harness({ holdTurn: true });
      const stays = same.session.prompt('hello');
      await same.flush();
      same.session.bind(SESSION);
      expect(same.agent.calls('session/cancel').length).toBe(0);
      same.agent.releaseTurn();
      await stays;

      const h = harness({ holdTurn: true, chunks: ['one'] });
      const sent = h.session.prompt('hello');
      await h.flush();
      const drawn = h.entries.length;
      h.session.bind(OTHER);
      expect(h.agent.calls('session/cancel').length).toBe(1);
      h.agent.say(SESSION.id, 'late words');
      await sent;
      expect(h.entries.length).toBe(drawn);
      expect(h.session.snapshot.sessionId).toBe(OTHER.id);
      expect(h.session.snapshot.state).toBe('idle');
    });

    await it('a Stop already pressed is not sent twice, and still ends idle on the other chat', async () => {
      const h = harness({ holdTurn: true });
      const sent = h.session.prompt('hello');
      await h.flush();
      h.session.stop();
      h.session.startConversation(NEW_CWD);
      expect(h.agent.calls('session/cancel').length).toBe(1);
      await sent;
      expect(h.session.snapshot.state).toBe('idle');
    });

    await it('New chat during the handshake: stopped, and the session is listed but not opened', async () => {
      const h = harness({ bind: false });
      h.session.startConversation(NEW_CWD);
      const sent = h.session.prompt('hello');
      h.session.startConversation(NEW_CWD);
      await sent;
      expect(h.agent.sent.map((entry) => entry.method)).not.toContain('session/prompt');
      expect(h.session.snapshot.sessionId).toBe(null);
      expect(h.session.snapshot.state).toBe('idle');
    });

    await it('with nothing running, New chat and bind cancel nothing', async () => {
      const h = harness();
      await h.session.prompt('hello');
      h.session.startConversation(NEW_CWD);
      h.session.bind(OTHER);
      expect(h.agent.calls('session/cancel').length).toBe(0);
    });
  });

  await describe('agent-session — New chat after the agent exited', async () => {
    const NEW_CWD = '/synthetic/project';

    async function exited(options: HarnessOptions = {}): Promise<Harness> {
      const h = harness({ holdTurn: true, ...options });
      const sent = h.session.prompt('hello');
      await h.flush();
      h.agent.vanish('the agent process ended with code 1');
      await sent;
      expect(h.session.snapshot.state).toBe('gone');
      return h;
    }

    await it('says the true thing before: the composer and the agent note both point at New chat', async () => {
      const h = await exited();
      const view = composerView({ ...h.session.snapshot, agent: h.session.agent });
      expect(view.reason).toContain('New chat');
      expect(h.session.agent.note).toContain('New chat');
      expect(h.session.agent.note).not.toContain('window');
    });

    await it('retires the dead handle and offers a usable composer', async () => {
      const h = await exited();
      h.session.startConversation(NEW_CWD);
      expect(h.closed()).toBe(1);
      expect(h.session.agentRunning).toBe(false);
      const snapshot = h.session.snapshot;
      expect(snapshot.state).toBe('idle');
      expect(snapshot.attachment.status).toBe('none');
      const view = composerView({ ...snapshot, agent: h.session.agent });
      expect(view.action).toBe('send');
      expect(view.buttonEnabled).toBe(true);
      expect(view.entryEditable).toBe(true);
    });

    await it('the next prompt starts a fresh agent, not the dead one', async () => {
      const h = await exited({ failAfterFirstOpen: true });
      h.session.startConversation(NEW_CWD);
      await h.session.prompt('again');
      // A second process was started; the fixture refuses it, which is how the test sees the attempt.
      expect(h.opened.length).toBe(2);
      expect(h.agent.calls('session/new').length).toBe(0);
    });

    await it('waits for the old process to end before it spawns the replacement', async () => {
      const h = await exited({ slowClose: true, failAfterFirstOpen: true });
      h.session.startConversation(NEW_CWD);
      const next = h.session.prompt('again');
      await h.flush();
      expect(h.closed()).toBe(1);
      expect(h.opened.length).toBe(1);
      h.finishClose();
      await next;
      expect(h.opened.length).toBe(2);
    });
  });

  await describe('agent-session — a record that cannot be saved', async () => {
    const NEW_CWD = '/synthetic/project';

    await it('says the conversation was not saved, and why', async () => {
      const h = harness({ bind: false, createFails: new Error('EACCES: cannot write the session file') });
      h.session.startConversation(NEW_CWD);
      await h.session.prompt('hello');
      const attachment = h.session.snapshot.attachment;
      expect(attachment.status === 'failed' && attachment.message).toBe(
        unsavedMessage('EACCES: cannot write the session file'),
      );
      expect(h.session.agent.note).toContain('not saved');
      expect(h.session.agent.note).toContain('EACCES');
      expect(h.session.agent.note).toContain('New chat');
    });

    await it('leaves New chat working: the composer is usable again afterwards', async () => {
      const h = harness({ bind: false, createFails: new Error('disk full') });
      h.session.startConversation(NEW_CWD);
      await h.session.prompt('hello');
      expect(composerView({ ...h.session.snapshot, agent: h.session.agent }).buttonEnabled).toBe(false);
      h.session.startConversation(NEW_CWD);
      const view = composerView({ ...h.session.snapshot, agent: h.session.agent });
      expect(view.buttonEnabled).toBe(true);
      expect(h.session.snapshot.startsConversation).toBe(true);
    });
  });

  await describe('agent-session — an agent that dies', async () => {
    await it('is gone, with no stopReason and the plan §6 line in the transcript', async () => {
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
    await it('is a sentence on the surface, not an exception', async () => {
      // A bad command, a handshake timeout and a protocol mismatch all land here, and a person must be
      // able to read what to do rather than watch a spinner that will never resolve.
      const h = harness({ failWith: new Error('spawn opencode ENOENT') });
      await h.session.prompt('hello');
      expect(h.session.snapshot.attachment.status).toBe('failed');
      // `idle`, not `thinking`: a turn that never started must not leave the window looking busy, and
      // `thinking` would show a Stop button that has nothing to stop.
      expect(h.session.snapshot.state).toBe('idle');
    });

    await it('leaves no turn state behind, because no turn ran', async () => {
      const h = harness({ failWith: new Error('handshake failed') });
      await h.session.prompt('hello');
      // The *final* state, not "thinking never appeared": the controller does pass through `thinking`
      // when the prompt is recorded, which is right — the turn was announced before it could fail. What
      // must not survive is a window still looking busy afterwards, because `thinking` shows a Stop
      // button with nothing to stop.
      expect(h.session.snapshot.state).toBe('idle');
      expect(h.session.turnRunning).toBe(false);
    });

    await it('reports the auth hint through the attachment, which is where the composer shows it', async () => {
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
        // **And the kind, which is what lets a surface tell this from a bad command.** The message
        // alone cannot: both reach the composer as one caption, and only one of them has a command to
        // run elsewhere. `core/failure.ts` decides the rest from this.
        expect(attachment.kind).toBe('auth');
      }
    });

    await it('a bad command is a failure to start, and gets no kind that has a dialog', async () => {
      // The other half of the split: if ENOENT also came out as `auth`, every missing binary would
      // put a modal naming `kurier auth` on screen, which is a remedy for a problem the person does
      // not have.
      const h = harness({ failWith: new Error('spawn opencode ENOENT') });
      await h.session.prompt('hello');
      const attachment = h.session.snapshot.attachment;
      expect(attachment.status).toBe('failed');
      if (attachment.status === 'failed') expect(attachment.kind).toBe('start');
    });

    await it('an agent that can neither load nor resume is a refusal, not a start failure', async () => {
      // Trap 2 through the real path. The fixture advertises `loadSession: false` *and* no `resume`
      // capability, so `AcpClient.reattach` rejects with `UnsupportedCapabilityError` — and plan §6
      // asks for that to be shown as a refusal rather than as an empty transcript.
      const h = harness({ capabilities: { loadSession: false, sessionCapabilities: {} } });
      await h.session.prompt('hello');
      const attachment = h.session.snapshot.attachment;
      expect(attachment.status).toBe('failed');
      if (attachment.status === 'failed') {
        expect(attachment.kind).toBe('unsupported');
        expect(failureNotice(attachment.kind)).not.toBe(null);
        expect(failureNotice(attachment.kind)?.command).toBe(null);
      }
    });

    await it('records no transcript line for a refusal — no turn ran, so nothing happened to record', async () => {
      // The transcript is a record of what happened (`AGENTS.md` § Privacy). A failure to start is not
      // an event in the conversation, and a line here would be the fabricated-history rule again.
      const h = harness({ capabilities: { loadSession: false, sessionCapabilities: {} } });
      await h.session.prompt('hello');
      expect(h.entries.map((entry) => entry.text)).not.toContain(
        'this agent can neither load nor resume a session, so an existing one cannot be reattached',
      );
    });

    await it("keeps the person's own prompt, which was recorded before the failure", async () => {
      const h = harness({ failWith: new Error('spawn ENOENT') });
      await h.session.prompt('a question worth keeping');
      expect(h.entries[0]?.text).toBe('a question worth keeping');
    });
  });

  // Issue #2. The same `-32000` as the login trap, but the agent handshook, loaded the session and
  // answered the turn — with a refusal. Nothing on the wire separates it from trap 1 except the prompt
  // that went out first, and kurier used to show the login dialog here, naming a command that does not
  // help. See `core/failure.ts`.
  await describe('agent-session — the provider refused the turn', async () => {
    await it('is the `model` kind, not the auth trap, and it earns a dialog', async () => {
      const h = harness({ promptAuth: true });
      await h.session.prompt('hello');
      const attachment = h.session.snapshot.attachment;
      expect(attachment.status).toBe('failed');
      if (attachment.status === 'failed') {
        expect(attachment.kind).toBe('model');
        // The dialog a window will put up: a sentence and a button, and **no** `kurier auth` command
        // line — the `command` field is what `FailureDialog` renders as "Run this in a terminal".
        const notice = failureNotice(attachment.kind);
        expect(notice).not.toBe(null);
        expect(notice?.command).toBe(null);
        expect(notice?.action).toBe('choose-model');
      }
    });

    await it('leaves the agent attached and the turn over, so a person can pick another model and retry', async () => {
      const h = harness({ promptAuth: true });
      await h.session.prompt('hello');
      // `idle`, not `gone`: the agent answered, it did not exit. And `attached: true`, because a
      // Send disabled behind a dialog whose only button is "Choose another model" would be the control
      // that points at nothing.
      expect(h.session.snapshot.state).toBe('idle');
      expect(h.session.agent.attached).toBe(true);
      expect(h.session.agentRunning).toBe(true);
    });

    await it('keeps the config row, because the dialog’s button opens it', async () => {
      // The `gone` path clears the row and its cache, and rightly: live dropdowns over a dead process
      // are controls pointing at nothing. Here the process is alive, so clearing them would make the
      // button open nothing — the same defect pointed the other way.
      const h = harness({ promptAuth: true });
      await h.session.prompt('hello');
      const row = h.session.configRow;
      expect(row.visible).toBe(true);
      expect(row.controls.some((control) => control.id === 'model')).toBe(true);
      // And the row the surface last drew was not emptied either — that is what the button reads.
      const drawn = h.configViews.at(-1);
      expect(drawn?.visible).toBe(true);
    });

    await it('records no transcript line claiming the agent exited, because it did not', async () => {
      // `agentExitedEntry`'s sentence is "the agent exited during this turn — the turn was never
      // answered", and here the turn *was* answered. A line saying so would be a fabricated event, and
      // the file would contradict the dialog on screen.
      const h = harness({ promptAuth: true });
      await h.session.prompt('hello');
      const texts = h.entries.map((entry) => entry.text);
      expect(texts.some((text) => text.includes('exited during this turn'))).toBe(false);
      // The person's own prompt is there, and nothing invented after it.
      expect(texts).toEqualArray(['hello']);
    });

    await it('still classifies the login trap as `auth`, with the same fixture agent and no prompt sent', async () => {
      // The other half, and the reason the split is worth having: the two paths differ only in whether
      // a prompt went out, so a client that lost the distinction would put one dialog on both.
      const h = harness({ requireAuth: true });
      await h.session.prompt('hello');
      const attachment = h.session.snapshot.attachment;
      expect(attachment.status).toBe('failed');
      if (attachment.status === 'failed') {
        expect(attachment.kind).toBe('auth');
        expect(failureNotice(attachment.kind)?.command).toBe('kurier auth');
      }
    });
  });

  await describe('agent-session — closing the window', async () => {
    await it('cancels, waits for the turn, and only then ends the process', async () => {
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

    await it('resolves rather than hanging when no turn is running', async () => {
      const h = harness();
      await h.session.prompt('hello');
      await h.session.shutdown();
      expect(h.agent.closed).toBe(true);
    });

    await it('ends a process that exists with no turn — the handshake window', async () => {
      // The orphan `onSpawn` exists to prevent: a close between spawn and the first answer must not leave
      // an agent running behind the window. `agentRunning` is what the window's close-request reads, so it
      // has to become false here or the close path would not know there was anything to end.
      const h = harness();
      await h.session.prompt('hello');
      await h.session.shutdown();
      expect(h.session.agentRunning).toBe(false);
    });

    await it('is idempotent, because the window calls it and its closer afterwards', async () => {
      const h = harness();
      await h.session.prompt('hello');
      await h.session.shutdown();
      await h.session.shutdown();
      expect(h.agent.closed).toBe(true);
    });
  });

  await describe('agent-session — the prompts themselves', async () => {
    await it('ignores an empty prompt: there is no turn to run and nothing to record', async () => {
      const h = harness();
      await h.session.prompt('   ');
      expect(h.entries.length).toBe(0);
      expect(h.agent.calls('session/prompt').length).toBe(0);
    });

    await it('ignores a prompt with no session open — nowhere to send it', async () => {
      const h = harness();
      h.session.bind(null);
      await h.session.prompt('hello');
      expect(h.agent.calls('session/prompt').length).toBe(0);
      expect(h.entries.length).toBe(0);
      // The binding is what the composer reads to decide Send is even enabled, so it has to be null here
      // — not merely unused.
      expect(h.session.snapshot.sessionId).toBe(null);
    });

    await it('trims the prompt, so a stray newline is not part of the question', async () => {
      const h = harness();
      await h.session.prompt('  hello\n');
      expect(h.entries[0]?.text).toBe('hello');
    });
  });

  // The config row over the real wire. Everything here goes through `FixtureAgent`, so "the agent's
  // answer is the truth" is a measurement of a peer rather than of a local array — the same reason the
  // gate's tests are: a mock that agreed with the client would prove nothing about either.
  await describe('agent-session — the config row', async () => {
    await it('has no row before the agent has answered, because the agent starts on the first prompt', async () => {
      const h = harness();
      // Decision 2: with no agent there is nothing to configure, and a row of controls that point at
      // no agent is the control-this-window-forbids. Selecting a session must not invent one.
      expect(h.session.configRow.visible).toBe(false);
      expect(h.session.configOptions).toBe(null);
    });

    await it('shows what session/load reported, on the first prompt', async () => {
      const h = harness();
      await h.session.prompt('hello');
      const view = h.session.configRow;
      expect(view.visible).toBe(true);
      expect(view.controls.map((control) => control.id)).toEqualArray(['model', 'effort', 'mode']);
      expect(view.controls[0]?.selected).toBe(0);
    });

    await it('an agent that reports no options draws no row, and that is not an error', async () => {
      const h = harness({ configOptions: [] });
      await h.session.prompt('hello');
      expect(h.session.configRow.visible).toBe(false);
      expect(h.snapshots[h.snapshots.length - 1]?.state).toBe('idle');
    });

    await it('sends the value id and takes the agent’s list as the truth', async () => {
      const h = harness();
      await h.session.prompt('hello');
      await h.session.setConfigOption('model', 'github-copilot/gpt-5.5-codex');
      expect(h.agent.configSets).toStrictEqual([
        { configId: 'model', value: 'github-copilot/gpt-5.5-codex' },
      ]);
      expect(h.session.configRow.controls[0]?.selected).toBe(2);
    });

    await it('re-selecting the value that is already current sends nothing', async () => {
      const h = harness();
      await h.session.prompt('hello');
      // The row is rebuilt on every answer and `notify::selected` fires on that rebuild. Without the
      // guard this call — and every rebuild the surface makes — would put the displayed value back on
      // the wire, in a loop.
      await h.session.setConfigOption('model', 'openrouter/openai/gpt-6.1-sol');
      expect(h.agent.configSets.length).toBe(0);
      expect(h.agent.calls('session/set_config_option').length).toBe(0);
    });

    await it('never sends a value the agent did not offer', async () => {
      const h = harness();
      await h.session.prompt('hello');
      await h.session.setConfigOption('model', 'openrouter/openai/gpt-9-imaginary');
      expect(h.agent.calls('session/set_config_option').length).toBe(0);
    });

    await it('never sends a config option the agent no longer reports', async () => {
      const h = harness();
      await h.session.prompt('hello');
      // The row shows `effort`; an id for a control the agent has dropped is not a request, it is a
      // guess. (The person cannot produce this from the row — that is the point.)
      await h.session.setConfigOption('web', 'true');
      expect(h.agent.calls('session/set_config_option').length).toBe(0);
    });

    await it('refuses a second set while one is in flight — no queue, and no race', async () => {
      const h = harness();
      await h.session.prompt('hello');
      // Two calls, one awaited pair. `setConfigOption` marks itself busy synchronously before its first
      // await, so the second call is refused deterministically — no sleep, no flake.
      const first = h.session.setConfigOption('model', 'github-copilot/gpt-5.5-codex');
      const second = h.session.setConfigOption('effort', 'high');
      await Promise.all([first, second]);
      // The rule is "not two in flight", and which one wins is not asserted: a person cannot get here
      // twice, because the row is insensitive while a set is in flight, so a test naming the winner
      // would only pin the order of two async calls.
      expect(h.agent.calls('session/set_config_option').length).toBe(1);
      expect(h.session.configRow.busy).toBe(false);
    });

    await it('a refused set leaves the agent’s last answered state and says so', async () => {
      const h = harness({ refuseConfigOptions: ['model'] });
      await h.session.prompt('hello');
      await h.session.setConfigOption('model', 'github-copilot/gpt-5.5-codex');
      const view = h.session.configRow;
      // The controls are the agent's, untouched: the person clicked, the agent said no, and a dropdown
      // still showing the click would be a lie about what the agent is doing.
      expect(view.controls.map((control) => control.id)).toEqualArray(['model', 'effort', 'mode']);
      expect(view.controls[0]?.selected).toBe(0);
      expect(view.error).toBe('The agent did not change this. Its previous value is still in use.');
      expect(view.busy).toBe(false);
      // …and the agent's own words go to the log, where a dev run can read them.
      expect(h.notices.some((line) => line.includes('refused'))).toBe(true);
    });

    await it('recovers on the next set: the refusal sentence is gone', async () => {
      const h = harness({ refuseConfigOptions: ['model'] });
      await h.session.prompt('hello');
      await h.session.setConfigOption('model', 'github-copilot/gpt-5.5-codex');
      await h.session.setConfigOption('effort', 'high');
      expect(h.session.configRow.error).toBe(null);
      expect(h.session.configRow.controls[1]?.selected).toBe(2);
    });

    await it('a config_option_update arriving mid-turn moves the row', async () => {
      // The other door. opencode pushes one when the *model* changes and answers with the list for the
      // rest, so a row that only read set answers would be stale on every agent-side change. The turn
      // is held open so the push lands inside it, which is where the notification listener lives.
      const h = harness({ holdTurn: true });
      const running = h.session.prompt('hello');
      // On the row being visible, not on `turnRunning`: a turn is "running" from the moment the prompt
      // is sent, which is *before* the handshake and the `session/load` that answer with the options.
      await h.waitUntil(() => h.session.configRow.visible);
      await h.session.setConfigOption('model', 'github-copilot/gpt-5.5-codex');
      expect(h.session.configRow.controls[0]?.selected).toBe(2);
      h.session.stop();
      await running;
    });

    await it('an update for another session does not move this session’s row', async () => {
      // opencode announces child sessions, and an update naming one is another conversation’s
      // configuration. Applying it would put a model picker showing somebody else’s model over this one.
      const h = harness({ holdTurn: true });
      const running = h.session.prompt('hello');
      await h.waitUntil(() => h.session.configRow.visible);
      // **Own session first, and waited for.** Proving that an update *for this session* moves the row is
      // the positive half, and it has to come first: it establishes that notifications are not being
      // dropped wholesale, which is the only other explanation for the second half.
      h.agent.pushConfigOptionUpdate(SESSION.id, 'model', 'openrouter/anthropic/claude-sonnet-5.5');
      await h.waitUntil(() => h.session.configRow.controls[0]?.selected === 1);
      // Then the one that must be ignored. **A negative needs a real wait, not `flush`**: `flush` counts
      // microtask ticks, and "the notification for another session never arrives" is not something a tick
      // count can prove — the row would look unchanged whether the update was dropped or merely late. Five
      // milliseconds is orders of magnitude more than an in-process transport needs, and it is the direction
      // that fails loudly rather than quietly.
      h.agent.pushConfigOptionUpdate('ses_other_0003', 'model', 'openrouter/anthropic/claude-sonnet-5.5');
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(h.session.configRow.controls[0]?.selected).toBe(1);
      h.session.stop();
      await running;
    });

    await it('drops the row when the window switches to another session', async () => {
      const h = harness();
      await h.session.prompt('hello');
      expect(h.session.configRow.visible).toBe(true);
      // The options in hand came from *this agent's* answer about the session it holds; the window may
      // be pointing at another row before the agent has reattached to it.
      const emitted = h.configViews.length;
      h.session.bind({ id: 'ses_fixture_0002', cwd: '/fixture' });
      expect(h.session.configRow.visible).toBe(false);
      // **And it says so.** The row redraws only when `onConfig` fires, so a switch that merely cleared
      // the controller's state would leave the model picker on screen over the other session's
      // conversation — a control pointing at nothing, which is the one thing this window forbids.
      expect(h.configViews.length).toBe(emitted + 1);
      expect(h.configViews[h.configViews.length - 1]?.visible).toBe(false);
    });

    await it('setConfigOption with no agent behind it sends nothing', async () => {
      const h = harness({ bind: false });
      h.session.bind(SESSION);
      await h.session.setConfigOption('model', 'github-copilot/gpt-5.5-codex');
      // No agent, and `#agentSession === null` — so there is no session to name, and a request without
      // one is not a request.
      expect(h.agent.calls('session/set_config_option').length).toBe(0);
    });

    await it('stageConfigOption sends the prompt that starts the agent, then sets through the real path', async () => {
      // `KU_APP_CONFIG` goes through this, because the process starts on the first prompt (plan §6) and
      // an option cannot be set on an agent that does not exist yet.
      const h = harness();
      await h.session.stageConfigOption('mode', 'plan', 'hi');
      expect(h.agent.calls('session/prompt').length).toBe(1);
      expect(h.agent.configSets).toStrictEqual([{ configId: 'mode', value: 'plan' }]);
      expect(h.session.configRow.controls[2]?.selected).toBe(1);
    });

    await it('stageConfigOption with no session open reports it instead of throwing', async () => {
      const h = harness({ bind: false });
      await h.session.stageConfigOption('mode', 'plan');
      expect(h.agent.calls('session/prompt').length).toBe(0);
      expect(h.notices.some((line) => line.includes('no session is open'))).toBe(true);
    });

    await it('a set answer that lands after the window moved on is cached, not drawn', async () => {
      // The race the plan does not mention and every round trip has: `session/set_config_option` is in
      // the air and the person clicks another session. The answer is about session A; the row is now
      // about B. Writing it would put A's model picker over B's conversation.
      const h = harness({ holdConfigAnswer: true });
      await h.session.prompt('hello');
      const setting = h.session.setConfigOption('model', 'github-copilot/gpt-5.5-codex');
      expect(h.session.configRow.busy).toBe(true);
      h.session.bind({ id: 'ses_fixture_0002', cwd: '/fixture' });
      // **And the row is usable at once.** Leaving the new session insensitive until an answer about the
      // *old* one arrives would lock the controls for as long as that agent takes — or for ever.
      expect(h.session.configRow.visible).toBe(false);
      expect(h.session.configRow.busy).toBe(false);
      h.agent.releaseConfigAnswer();
      await setting;
      // Nothing about A reached the screen for B…
      expect(h.session.configRow.visible).toBe(false);
      // …and nothing about it was thrown away either: the agent's answer about A is still true about A.
      h.session.bind(SESSION);
      expect(h.session.configRow.controls[0]?.selected).toBe(2);
      expect(h.session.configRow.busy).toBe(false);
    });

    await it('bind(A) → bind(B) → bind(A) with no prompt leaves the row as the agent last answered it', async () => {
      // Selecting a session starts nothing (plan §6), so the agent never leaves A and there is no
      // `session/load` to re-ask. Emptying the row on the way to B and having nothing to restore it on
      // the way back leaves A's model picker gone for the rest of the window's life.
      const h = harness();
      await h.session.prompt('hello');
      await h.session.setConfigOption('effort', 'high');
      h.session.bind({ id: 'ses_fixture_0002', cwd: '/fixture' });
      expect(h.session.configRow.visible).toBe(false);
      h.session.bind(SESSION);
      const view = h.session.configRow;
      expect(view.visible).toBe(true);
      expect(view.controls.map((control) => control.id)).toEqualArray(['model', 'effort', 'mode']);
      expect(view.controls[1]?.selected).toBe(2);
    });

    await it('a notification that lands during a set is superseded by the answer', async () => {
      // Both carry the options; the answer is the state *after* the change, so it is the later word.
      // Applying the notification first would move the row twice for one click — and the held answer
      // snapshots its list on arrival, so the two really do disagree here.
      const h = harness({ holdTurn: true, holdConfigAnswer: true });
      const running = h.session.prompt('hello');
      await h.waitUntil(() => h.session.configRow.visible);
      const setting = h.session.setConfigOption('model', 'github-copilot/gpt-5.5-codex');
      // The agent changes something else of its own accord while the set is in the air.
      h.agent.pushConfigOptionUpdate(SESSION.id, 'effort', 'high');
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(h.session.configRow.controls[1]?.selected).toBe(5);
      h.agent.releaseConfigAnswer();
      await setting;
      expect(h.session.configRow.controls[0]?.selected).toBe(2);
      // The answer wins outright, so the effort level it carried is what is shown — not the update's.
      expect(h.session.configRow.controls[1]?.selected).toBe(5);
      h.session.stop();
      await running;
    });

    await it('an agent that dies takes the config row with it', async () => {
      // Live dropdowns over a process that has exited are controls pointing at nothing: a person picks a
      // model, the row accepts it, and the request goes into a connection that is closed.
      const h = harness({ holdTurn: true });
      const sent = h.session.prompt('hello');
      await h.waitUntil(() => h.session.configRow.visible);
      h.agent.vanish('the agent process ended');
      await sent;
      expect(h.session.snapshot.state).toBe('gone');
      expect(h.session.configRow.visible).toBe(false);
      expect(h.session.configRow.busy).toBe(false);
      // And the cache went with it: a `bind` afterwards must not put those controls back on screen.
      h.session.bind(SESSION);
      expect(h.session.configRow.visible).toBe(false);
    });
  });
};
