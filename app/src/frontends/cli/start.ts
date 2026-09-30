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

import { DEFAULT_AGENT, requireLauncher } from '../../core/agents/launcher.ts';
import { sessionsFile } from '../../core/paths.ts';
import { terminalGate } from '../../core/policy.ts';
import { openAgent, runTurn, withAuthHint } from '../../core/run.ts';
import { toTranscript } from '../../core/transcript.ts';
import { LOCAL_PRINCIPAL, createSessionStore, newSession } from '@kurier/session';
import type { TranscriptEntry } from '@kurier/session';

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
        default: DEFAULT_AGENT,
        describe: 'which agent launcher to start',
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
    const agentId = pickArgv<string>(raw, 'agent') ?? DEFAULT_AGENT;
    const cwd = pickArgv<string>(raw, 'cwd') ?? process.cwd();
    const prompt = pickArgv<string[]>(raw, 'prompt') ?? [];
    const denyAll = pickArgv<boolean>(raw, 'deny-all', 'denyAll') === true;
    const quiet = pickArgv<boolean>(raw, 'quiet') === true;
    const text = prompt.join(' ').trim();

    const launcher = requireLauncher(agentId);
    const terminal = processTerminal();
    const store = createSessionStore(sessionsFile());
    const at = () => new Date().toISOString();

    // The gate is chosen before the agent starts, never after: a client that could switch from
    // "ask" to "allow" mid-session is a client whose policy is the lifecycle.
    const gate = {
      permission: denyAll
        ? () => null
        : terminalGate({
            terminal,
            onDecision: (optionId) => {
              err(`  → ${optionId === null ? 'declined' : `granted (${optionId})`}`);
            },
          }),
    };

    const handle = await openAgent({
      command: launcher,
      gate,
      onLog: (line) => {
        if (!quiet) err(`  [agent] ${line}`);
      },
      onNotice: (message) => err(message),
    });

    const transcript: TranscriptEntry[] = [];
    try {
      const session = await withAuthHint('session/new', () =>
        handle.client.newSession({ cwd, mcpServers: [] }),
      );
      err(`${handle.agentInfo} — session ${session.sessionId} in ${cwd}`);

      const created = store.create(
        newSession({
          id: session.sessionId,
          agent: launcher.id,
          cwd,
          principal: LOCAL_PRINCIPAL,
          boundTo: null,
          at: at(),
          // Recorded now, from the agent's own capabilities, so `resume` knows what this session
          // was reattached with — not what it *should* have been.
          reattach: handle.client.supportsLoadSession
            ? 'load'
            : handle.client.supportsResumeSession
              ? 'resume'
              : null,
        }),
      );

      if (!text) {
        out(created.id);
        return;
      }

      transcript.push({ kind: 'user', text, at: at(), sessionId: created.id });
      const { stopReason } = await runTurn(handle.client, {
        sessionId: created.id,
        text,
        onUpdate: (notification) => {
          transcript.push(...toTranscript(notification, at()));
          showUpdate(notification, (chunk) => out(chunk));
        },
        // Ctrl-C is the protocol's own cancellation, not a kill: the agent stops cleanly and
        // answers the turn with `cancelled`, so the transcript ends where the work ended.
        onInterrupt: () => {
          err('\n  cancelling — the agent will stop and report `cancelled`');
          handle.client.cancel({ sessionId: created.id });
        },
      });

      store.append(created.id, transcript);
      out();
      err(`— ${stopReason} —`);
    } finally {
      handle.close();
      terminal.close();
    }
  },
};

export const startCommand = command;
