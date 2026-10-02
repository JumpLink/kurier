/**
 * `kurier start` — open a session, run one prompt turn, write it down.
 *
 * The command is one turn, not a REPL, and that is a decision rather than a missing feature. A
 * REPL needs somewhere to put the approval surface, and the plan puts the surface in a later slice
 * (§7); a REPL now would either prompt on a stdin that is also carrying the questions, or pretend
 * the gate is not there. One turn keeps the gate honest and the output pipeable.
 *
 * Every option is read with `pickArgv`, not off `argv` directly: yargs spells a kebab-case option
 * `deny-all` or `denyAll` depending on version, and a gate that silently stopped firing is the
 * worst possible failure for a flag whose whole job is to stop things.
 */

import type { CommandModule } from 'yargs';

import { installInterruptHandler } from '../../core/interrupt.ts';
import { sessionsFile } from '../../core/paths.ts';
import { openAgent, runTurn, withAuthHint } from '../../core/run.ts';
import { toTranscript } from '../../core/transcript.ts';
import { LOCAL_PRINCIPAL, createSessionStore, newSession } from '@kurier/session';
import type { TranscriptEntry } from '@kurier/session';

import { agentForNew } from './choose.ts';
import { commandGate } from './gate.ts';
import { err, out, pickArgv, showUpdate } from './output.ts';
import { processTerminal } from './terminal.ts';

const command: CommandModule = {
  command: 'start [prompt..]',
  describe: 'open a session with an agent and run one prompt turn',
  builder: (yargs) =>
    yargs
      .positional('prompt', {
        type: 'string',
        array: true,
        describe: 'the prompt; omit it to open a session and stop',
      })
      .option('agent', {
        type: 'string',
        describe: 'which agent launcher to start (default: your own install, else the bundled copy)',
      })
      .option('cwd', {
        type: 'string',
        describe: 'the directory the session runs in (default: the current one)',
      })
      .option('deny-all', {
        type: 'boolean',
        describe: 'refuse every tool call without asking, even on a terminal',
      })
      .option('quiet', { type: 'boolean', describe: "do not echo the agent's log lines" })
      .strict(),
  handler: async (argv) => {
    const raw = argv as Record<string, unknown>;
    const cwd = pickArgv<string>(raw, 'cwd') ?? process.cwd();
    const prompt = pickArgv<string[]>(raw, 'prompt') ?? [];
    const denyAll = pickArgv<boolean>(raw, 'deny-all', 'denyAll') === true;
    const quiet = pickArgv<boolean>(raw, 'quiet') === true;
    const text = prompt.join(' ').trim();

    const resolved = agentForNew(pickArgv<string>(raw, 'agent'));
    if (!resolved) return;
    const launcher = resolved.command;
    const terminal = processTerminal();
    const store = createSessionStore(sessionsFile());
    const at = () => new Date().toISOString();

    // Installed before the agent exists, so there is no window in which a process is running that
    // Ctrl-C cannot reach. `onCancel` closes over `handle`, which is why it is declared first and
    // filled in by `onSpawn`.
    let handle: Awaited<ReturnType<typeof openAgent>> | null = null;
    const interrupt = installInterruptHandler({
      onCancel: (sessionId) => {
        err('\n  cancelling — the agent will stop and report `cancelled`');
        handle?.client.cancel({ sessionId });
      },
    });

    const transcript: TranscriptEntry[] = [];
    try {
      const agent = await openAgent({
        command: launcher,
        gate: commandGate({ terminal, denyAll }),
        onLog: (line) => {
          if (!quiet) err(`  [agent] ${line}`);
        },
        onNotice: (message) => err(message),
        onSpawn: (close) => {
          // Only the closer and the flag — the handle is assigned below, when `openAgent` returns.
          // `onSpawn` fires before the handshake, which is the entire reason it exists.
          interrupt.setClose(close);
          interrupt.update({ agentRunning: true, turnRunning: false, sessionId: null });
        },
      });
      handle = agent;
      const session = await withAuthHint('session/new', () =>
        agent.client.newSession({ cwd, mcpServers: [] }),
      );
      err(`${agent.agentInfo} — session ${session.sessionId} in ${cwd}`);

      const created = store.create(
        newSession({
          id: session.sessionId,
          agent: launcher.id,
          agentSource: resolved.source,
          cwd,
          principal: LOCAL_PRINCIPAL,
          boundTo: null,
          at: at(),
          // Recorded now, from the agent's own capabilities, so `resume` knows what this session
          // was reattached with — not what it *should* have been.
          reattach: agent.client.supportsLoadSession
            ? 'load'
            : agent.client.supportsResumeSession
              ? 'resume'
              : null,
        }),
      );

      if (!text) {
        out(created.id);
        return;
      }

      transcript.push({ kind: 'user', text, at: at(), sessionId: created.id });
      // Ctrl-C from here on means "stop the turn", not "kill the process": the agent stops cleanly
      // and answers with `cancelled`, so the transcript ends where the work ended.
      interrupt.update({ agentRunning: true, turnRunning: true, sessionId: created.id });
      const { stopReason } = await runTurn(agent.client, {
        sessionId: created.id,
        text,
        onUpdate: (notification) => {
          transcript.push(...toTranscript(notification, at()));
          showUpdate(notification, (chunk) => out(chunk));
        },
      });

      store.append(created.id, transcript);
      out();
      err(`— ${stopReason} —`);
    } finally {
      interrupt.dispose();
      handle?.close();
      terminal.close();
    }
  },
};

export const startCommand = command;
