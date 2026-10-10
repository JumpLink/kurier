/**
 * `lotse sessions` — kurier's own records, for one principal.
 *
 * Note what this lists and what it does not: these are *kurier's* records, not the agent's. The
 * agent has its own history and hands it over on request; this is the local file, which is what a
 * resume needs and what a person wants when asking "what did I open here last week".
 */

import type { CommandModule } from 'yargs';

import type { LotsePaths } from '@lotse/core';
import { LOCAL_PRINCIPAL, createSessionStore, forPrincipal } from '@lotse/session';
import type { SessionRecord } from '@lotse/session';

import { err, pickArgv, showSession, showSessionTable } from './output.ts';

const command = (paths: LotsePaths): CommandModule => ({
  command: 'sessions',
  describe: 'list the sessions kurier has recorded',
  builder: (yargs) =>
    yargs
      .option('all', { type: 'boolean', describe: 'include sessions of other principals' })
      .option('long', { type: 'boolean', describe: 'show the transcript, not one line per session' })
      .option('principal', { type: 'string', describe: 'whose sessions to list' })
      .strict(),
  handler: (argv) => {
    const raw = argv as Record<string, unknown>;
    const store = createSessionStore(paths.sessionsFile);
    const principal = pickArgv<string>(raw, 'principal') ?? LOCAL_PRINCIPAL;
    // `--all` is the only way past the principal filter, and it has to be asked for: the model is
    // "policy per principal, not per session", so a listing that silently mixed them would be a
    // listing nobody asked for.
    const records: SessionRecord[] =
      pickArgv<boolean>(raw, 'all') === true ? store.all() : forPrincipal(store.all(), principal);
    if (pickArgv<boolean>(raw, 'long') === true) {
      for (const record of records) showSession(record);
    } else {
      showSessionTable(records);
    }
    // One message, and it says which of the two empty cases this is. Printing both (a generic
    // "no sessions yet" from the renderer plus a specific one here) is how an output teaches a
    // person to stop reading it.
    if (records.length === 0) {
      err(
        pickArgv<boolean>(raw, 'all') === true
          ? 'kurier has no sessions yet — `lotse start` opens one'
          : `no sessions for principal "${principal}" (try --all)`,
      );
    }
  },
});

export const sessionsCommand = command;
