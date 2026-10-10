/**
 * `lotse answer <id> <text…>` — answer a question an agent asked (ADR 0003 §5).
 *
 * A permission question takes yes or no, which the run that holds the request picks up. A reply
 * question continues the session: `session/load`, else `session/resume`, else a follow-up run that
 * carries the question as context. The command prints which of these happened, on stderr, and the
 * agent's reply on stdout.
 */

import type { CommandModule } from 'yargs';

import { answerQuestion, type LotsePaths } from '@lotse/core';

import type { ServePaths } from '../../core/paths.ts';
import { stderrChannel } from '../../core/stderr-channel.ts';
import { err, out, pickArgv } from './output.ts';
import { readTasks, serveDeps, trackedAgents } from './serve-deps.ts';

const FAILED = new Set(['unknown', 'dropped', 'expired', 'busy', 'invalid']);

const command = (paths: LotsePaths, serve: ServePaths): CommandModule => ({
  command: 'answer <id> <text..>',
  describe: 'answer a question from `lotse questions`; yes/no for a permission, text for a reply',
  builder: (yargs) =>
    yargs
      .positional('id', { type: 'string', describe: 'the question id, like #A1 or A1' })
      .positional('text', { type: 'string', array: true, describe: 'yes, no, or the reply' })
      .option('quiet', { type: 'boolean', describe: "do not echo the agent's log lines" })
      .strict(),
  handler: async (argv) => {
    const raw = argv as Record<string, unknown>;
    const id = String(pickArgv<string | number>(raw, 'id') ?? '');
    const text = (pickArgv<string[]>(raw, 'text') ?? []).join(' ').trim();
    const quiet = pickArgv<boolean>(raw, 'quiet') === true;
    if (!text) {
      err('an answer needs text: yes, no, or the reply');
      process.exitCode = 1;
      return;
    }

    const loaded = readTasks(serve);
    if (!loaded) return;
    const agents = trackedAgents();
    // The agent's reply is printed here; a question it asks back reaches the person through `serve`'s
    // channel on its next question, and through `lotse questions` right away.
    const deps = serveDeps({ paths, serve, loaded, channel: stderrChannel(), open: agents.open, quiet });
    if (!deps) return;
    try {
      const result = await answerQuestion(id, text, deps);
      err(result.message);
      if (result.run?.reply) out(result.run.reply);
      if (FAILED.has(result.mode) || result.run?.outcome === 'failed') process.exitCode = 1;
    } finally {
      await agents.closeAll();
    }
  },
});

export const answerCommand = command;
