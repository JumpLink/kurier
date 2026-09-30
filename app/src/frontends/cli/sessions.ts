/**
 * `kurier sessions` — kurier's own records, for one principal.
 *
 * Note what this lists and what it does not: these are *kurier's* records, not the agent's. The
 * agent has its own history and hands it over on request; this is the local file, which is what a
 * resume needs and what a person wants when asking "what did I open here last week".
 */

import type { CommandModule } from 'yargs';

import { sessionsFile } from '../../core/paths.ts';
import { LOCAL_PRINCIPAL, createSessionStore, forPrincipal } from '@kurier/session';
import type { SessionRecord } from '@kurier/session';

import { err, pickArgv, showSession, showSessionTable } from './output.ts';

const command: CommandModule = {
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
    const store = createSessionStore(sessionsFile());
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
    if (records.length === 0) {
      err(
        pickArgv<boolean>(raw, 'all') === true
          ? 'kurier has no sessions yet — `kurier start` opens one'
          : `no sessions for principal "${principal}"`,
      );
    }
  },
};

export const sessionsCommand = command;
