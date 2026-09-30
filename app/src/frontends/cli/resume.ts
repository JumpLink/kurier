/**
 * `kurier resume <id> [prompt…]` — put a stored session back in front of its agent.
 *
 * How it is put back is the agent's decision, negotiated at the handshake, not ours: `session/load`
 * when the agent offers it (the history is replayed), `session/resume` when it does not (the
 * history is not), and a clear error when it offers neither. The session record remembers which of
 * the two was used when the session was opened, and this command says so when the agent's answer
 * has changed since — "resumed, but this time without the history" is exactly the kind of thing
 * somebody needs told rather than left to discover.
 */

import type { CommandModule } from 'yargs';

import { DEFAULT_AGENT, requireLauncher } from '../../core/agents/launcher.ts';
import { sessionsFile } from '../../core/paths.ts';
import { terminalGate } from '../../core/policy.ts';
import { openAgent, runTurn, withAuthHint } from '../../core/run.ts';
import { toTranscript } from '../../core/transcript.ts';
import { createSessionStore, touch } from '@kurier/session';
import type { TranscriptEntry } from '@kurier/session';

import { err, out, pickArgv, showUpdate } from './output.ts';
import { processTerminal } from './terminal.ts';

const command: CommandModule = {
  command: 'resume <id> [prompt..]',
  describe: 'reattach a recorded session and optionally run one prompt turn',
  builder: (yargs) =>
    yargs
      .positional('id', { type: 'string', describe: 'the session id from `kurier sessions`' })
      .positional('prompt', {
        type: 'string',
        array: true,
        describe: 'the prompt; omit it to reattach and stop',
      })
      .option('agent', {
        type: 'string',
        default: DEFAULT_AGENT,
        describe: "which agent launcher to start (must match the session's agent)",
      })
      .option('deny-all', { type: 'boolean', describe: 'refuse every tool call without asking' })
      .option('quiet', { type: 'boolean', describe: "do not echo the agent's log lines" })
      .strict(),
  handler: async (argv) => {
    const raw = argv as Record<string, unknown>;
    const id = pickArgv<string>(raw, 'id') ?? '';
    const agentId = pickArgv<string>(raw, 'agent') ?? DEFAULT_AGENT;
    const prompt = pickArgv<string[]>(raw, 'prompt') ?? [];
    const denyAll = pickArgv<boolean>(raw, 'deny-all', 'denyAll') === true;
    const quiet = pickArgv<boolean>(raw, 'quiet') === true;
    const text = prompt.join(' ').trim();

    const store = createSessionStore(sessionsFile());
    const record = store.get(id);
    if (!record) {
      err(`no session with id ${id} — \`kurier sessions\` lists what kurier has`);
      process.exitCode = 1;
      return;
    }
    if (record.agent !== agentId) {
      // A session is a conversation with *an* agent. Handing an opencode session id to a different
      // launcher is a guess about somebody's history, so it is refused with the way out.
      err(
        `session ${id} belongs to agent "${record.agent}", not "${agentId}". ` +
          `Re-run with --agent ${record.agent}.`,
      );
      process.exitCode = 1;
      return;
    }
    const launcher = requireLauncher(record.agent);
    const terminal = processTerminal();
    const at = () => new Date().toISOString();

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
      // The cwd comes from the record, not from the shell: a session's scope is part of what it
      // is, and resuming it from somewhere else would change what it can reach.
      await withAuthHint(`reattach ${id}`, () =>
        handle.client.reattach(id, { cwd: record.cwd, mcpServers: [] }),
      );
      const how: 'load' | 'resume' = handle.client.supportsLoadSession ? 'load' : 'resume';
      if (record.reattach && record.reattach !== how) {
        err(
          `  note: the agent ${how === 'load' ? 'loaded' : 'resumed'} this session; when it was ` +
            `opened it was ${record.reattach === 'load' ? 'loaded' : 'resumed'}. A resume does not ` +
            'replay the history.',
        );
      }
      err(`${handle.agentInfo} — ${how === 'load' ? 'loaded' : 'resumed'} ${id} in ${record.cwd}`);

      if (!text) return;

      transcript.push({ kind: 'user', text, at: at(), sessionId: id });
      const { stopReason } = await runTurn(handle.client, {
        sessionId: id,
        text,
        onUpdate: (notification) => {
          transcript.push(...toTranscript(notification, at()));
          showUpdate(notification, (chunk) => out(chunk));
        },
        onInterrupt: () => {
          err('\n  cancelling — the agent will stop and report `cancelled`');
          handle.client.cancel({ sessionId: id });
        },
      });

      store.update(id, (current) => touch({ ...current, turns: [...current.turns, ...transcript] }, at()));
      out();
      err(`— ${stopReason} —`);
    } finally {
      handle.close();
      terminal.close();
    }
  },
};

export const resumeCommand = command;
