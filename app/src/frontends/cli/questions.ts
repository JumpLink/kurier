/**
 * `lotse questions` — what the agents are waiting on (ADR 0003 §4).
 *
 * Reads the question store and nothing else: no task configuration, no agent, no GI. It works while
 * `serve` runs and while it does not, because the store is the only place a question lives.
 */

import type { CommandModule } from 'yargs';

import { formatQuestionId, isOpen, type LotsePaths } from '@lotse/core';

import type { ServePaths } from '../../core/paths.ts';
import { questionBook } from '../../core/serve-state.ts';
import { err, out, pickArgv } from './output.ts';

const command = (_paths: LotsePaths, serve: ServePaths): CommandModule => ({
  command: 'questions',
  describe: 'list the questions agents are waiting on',
  builder: (yargs) =>
    yargs
      .option('all', { type: 'boolean', describe: 'also list answered, expired and cancelled questions' })
      .option('json', { type: 'boolean', describe: 'print the questions as JSON' })
      .strict(),
  handler: (argv) => {
    const raw = argv as Record<string, unknown>;
    const all = pickArgv<boolean>(raw, 'all') === true;
    const json = pickArgv<boolean>(raw, 'json') === true;
    const now = new Date();
    const book = questionBook(
      serve.stateDir,
      () => now,
      (problem) => err(`  ${problem}`),
    ).read();
    const shown = book
      .filter((question) => all || isOpen(question, now))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    if (json) {
      out(JSON.stringify(shown, null, 2));
      return;
    }
    if (shown.length === 0) {
      err(all ? 'no questions' : 'no open questions');
      return;
    }
    for (const question of shown) {
      const status = isOpen(question, now) ? `open until ${question.expiresAt}` : question.status;
      out(`${formatQuestionId(question.id)}  ${question.task}  ${question.kind}  ${status}`);
      for (const line of question.text.split('\n')) out(`    ${line}`);
      if (!isOpen(question, now) && question.resolution) out(`    → ${question.resolution}`);
    }
  },
});

export const questionsCommand = command;
