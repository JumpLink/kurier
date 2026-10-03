/**
 * The `kurier` binary.
 *
 * The yargs chrome is copied from postbote's entrypoint, including the three comments that explain
 * the non-obvious options — they are not decoration, each one fixes a failure that a plain yargs
 * setup produces *on GJS specifically*:
 *
 * - `strictCommands()`, because an unmatched command on GJS leaves the main loop running forever
 *   (a hang), where on Node it would exit 0. Two different bugs for one typo.
 * - `locale('en')`, because yargs otherwise translates its own chrome from `$LANG` while every
 *   `describe` string stays English, so a German shell got a half-German help screen.
 * - `fail(false)` plus the `try`/`catch` around `parse()`, because yargs can throw
 *   synchronously for a nested `demandCommand` failure; on GJS that surfaces as an opaque "Module
 *   threw an exception" and the hint would be printed twice.
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import {
  agentsCommand,
  authCommand,
  cancelCommand,
  resumeCommand,
  sessionsCommand,
  startCommand,
} from './frontends/cli/index.ts';

function reportError(err: unknown): void {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}

const parseArgs = () =>
  yargs(hideBin(process.argv))
    .command(startCommand)
    .command(sessionsCommand)
    .command(resumeCommand)
    .command(cancelCommand)
    .command(authCommand)
    .command(agentsCommand)
    .demandCommand(1, 'Please provide a command — `kurier --help` lists them all.')
    .strictCommands()
    .scriptName('kurier')
    .locale('en')
    .help()
    .fail(false)
    .exitProcess(false)
    .parseAsync();

let parsed: ReturnType<typeof parseArgs>;
try {
  parsed = parseArgs();
} catch (err) {
  // yargs threw instead of rejecting — see the note in the file header.
  reportError(err);
  process.exit(1);
}

try {
  await parsed;
  // fixed upstream in gjsify: natural end of main ignores process.exitCode (PR pending)
  // gjsify#2007 fixes it on main and awaits a release; remove this line when the pin carries it.
  if (process.exitCode) process.exit();
} catch (err) {
  reportError(err);
  // On GJS the top-level await above leaves a pending main loop if the promise never settles, so
  // this is the line that guarantees the process ends. `exit`, not `exitCode`: a gate that decided
  // nothing and left a child process behind is worse than a non-zero exit.
  process.exit(process.exitCode ?? 1);
}
