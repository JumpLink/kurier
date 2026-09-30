/**
 * `kurier cancel <id>` — ask the agent to stop a turn.
 *
 * A cancellation needs a *live* session: `session/cancel` is a notification to an agent process
 * that is mid-turn, and there is no queue to put it in. So this command starts the agent, finds
 * out whether it can even reattach the session, and says so plainly if it cannot — instead of
 * writing a cheerful "cancelled" for a turn that is still running somewhere.
 *
 * Ctrl-C inside `kurier start` and `kurier resume` does the same thing without a second process.
 * This command exists for the case where the first terminal is gone.
 */

import type { CommandModule } from 'yargs';

import { requireLauncher } from '../../core/agents/launcher.ts';
import { sessionsFile } from '../../core/paths.ts';
import { openAgent } from '../../core/run.ts';
import { createSessionStore } from '@kurier/session';

import { silentGate } from './gate.ts';
import { err, out, pickArgv } from './output.ts';

const command: CommandModule = {
  command: 'cancel <id>',
  describe: 'send session/cancel for a session (Ctrl-C does the same inside a running turn)',
  builder: (yargs) =>
    yargs
      .positional('id', { type: 'string', describe: 'the session id to cancel' })
      .option('agent', { type: 'string', describe: 'the agent that owns the session' })
      .option('quiet', { type: 'boolean', describe: "do not echo the agent's log lines" })
      .strict(),
  handler: async (argv) => {
    const raw = argv as Record<string, unknown>;
    const id = pickArgv<string>(raw, 'id') ?? '';
    const quiet = pickArgv<boolean>(raw, 'quiet') === true;

    const store = createSessionStore(sessionsFile());
    const record = store.get(id);
    const agentId = pickArgv<string>(raw, 'agent') ?? record?.agent;
    if (!agentId) {
      err(`no session with id ${id} and no --agent — \`kurier sessions\` lists what kurier has`);
      process.exitCode = 1;
      return;
    }
    if (record && pickArgv<string>(raw, 'agent') && record.agent !== pickArgv<string>(raw, 'agent')) {
      err(`session ${id} belongs to agent "${record.agent}", not "${agentId}"`);
      process.exitCode = 1;
      return;
    }

    const launcher = requireLauncher(agentId);
    const handle = await openAgent({
      command: launcher,
      gate: silentGate(),
      onLog: (line) => {
        if (!quiet) err(`  [agent] ${line}`);
      },
      onNotice: (message) => err(message),
    });
    try {
      // Reattaching first is what proves the agent knows the session. An agent that cannot
      // reattach it cannot have a turn running in it, and pretending otherwise would be a lie the
      // user acts on.
      if (record) {
        await handle.client.reattach(id, { cwd: record.cwd, mcpServers: [] });
      }
      handle.client.cancel({ sessionId: id });
      out(`session/cancel sent for ${id}`);
      err(
        'A cancel is a request: the agent stops, flushes what it has, and answers the turn with ' +
          '`cancelled`. Nothing is written to the record here — the transcript is written by ' +
          'whichever command was running the turn.',
      );
    } finally {
      handle.close();
    }
  },
};

export const cancelCommand = command;
