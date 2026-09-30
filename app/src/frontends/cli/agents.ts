/**
 * `kurier agents` — the launchers, and whether their binary is there.
 *
 * A small command with one job: make "not installed" and "broken" different sentences. Both look
 * identical from the outside until you know whether the binary exists, and the fix for each is
 * nothing alike.
 */

import type { CommandModule } from 'yargs';

import { DEFAULT_AGENT, LAUNCHERS } from '../../core/agents/launcher.ts';
import { which } from '../../core/agents/stdio.ts';

import { err, out } from './output.ts';

const command: CommandModule = {
  command: 'agents',
  describe: 'list the agent launchers kurier knows how to start',
  builder: (yargs) => yargs.strict(),
  handler: () => {
    out('AGENT     PROGRAM              STATE     COMMAND');
    for (const launcher of LAUNCHERS) {
      const found = which(launcher.program);
      const state = found ? (found === launcher.program ? 'on PATH' : found) : 'NOT FOUND';
      const marker = launcher.id === DEFAULT_AGENT ? '*' : ' ';
      out(
        `${marker}${launcher.id.padEnd(9)} ${launcher.program.padEnd(19)} ` +
          `${state.padEnd(9)} ${launcher.args.join(' ')}`,
      );
    }
    out();
    err('* the default for --agent');
  },
};

export const agentsCommand = command;
