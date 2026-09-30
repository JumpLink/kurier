/**
 * The session store: one JSON file, written atomically, holding the records `packages/session`
 * models. No database, no daemon, no migration framework.
 *
 * Three things it takes seriously:
 *
 * - **Atomicity.** Write to a sibling temp file, `fsync` it, then `rename` over the target. A
 *   half-written session file is a lost conversation, and a rename on the same filesystem is the
 *   only way to get "either the old file or the new one" out of a filesystem.
 * - **Mode `0600`.** The file holds the text of a person's conversations with an agent. The
 *   directory is `0700`. Set explicitly, not inherited, because the umask of whoever started the
 *   process is not a decision kurier may leave to chance.
 * - **Location is the caller's.** The store takes a path and never decides one. The app resolves
 *   `$XDG_DATA_HOME`; a test passes a temp dir. That is what keeps the store free of any opinion
 *   about the machine it runs on.
 */

import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { assertScopeIsNotAuthority } from '@kurier/acp/gate';

import { appendTurns, byRecency, type SessionRecord, type TranscriptEntry } from './model.ts';

export interface SessionStore {
  all(): SessionRecord[];
  get(id: string): SessionRecord | undefined;
  create(record: SessionRecord): SessionRecord;
  update(id: string, change: (record: SessionRecord) => SessionRecord): SessionRecord;
  append(id: string, entries: TranscriptEntry[]): SessionRecord;
  remove(id: string): boolean;
}

interface StoreFile {
  version: 1;
  sessions: SessionRecord[];
}

const FILE_VERSION = 1;

export function createSessionStore(file: string): SessionStore {
  const read = (): StoreFile => {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: FILE_VERSION, sessions: [] };
      }
      throw error;
    }
    const parsed = JSON.parse(raw) as StoreFile;
    if (parsed?.version !== FILE_VERSION || !Array.isArray(parsed.sessions)) {
      throw new Error(
        `${file} is not a kurier session file (version ${String(parsed?.version)}, expected ${FILE_VERSION})`,
      );
    }
    for (const record of parsed.sessions) {
      // A file that grew an authority field by hand is exactly the case the canary exists for, and
      // it is caught on read rather than on the next write.
      assertScopeIsNotAuthority(record as unknown as Record<string, unknown>);
    }
    return parsed;
  };

  const write = (state: StoreFile): void => {
    const dir = dirname(file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = join(dir, `.${FILE_VERSION}-${process.pid}-${Date.now()}.tmp`);
    try {
      writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      // fsync before the rename: the rename is atomic with respect to *other readers*, but without
      // the flush a crash can still leave the renamed file empty on disk.
      const handle = openSync(temp, 'r+');
      try {
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
      renameSync(temp, file);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  };

  /**
   * Declared as named functions rather than an object literal with `append: (id, e) => this.update(…)`:
   * a `this` inside the literal silently becomes `undefined` the moment somebody writes
   * `const { append } = store`, and the failure is a `TypeError` in a code path that only runs when
   * a transcript is written. A closure over `read`/`write` has no such failure mode.
   */
  const all = (): SessionRecord[] => read().sessions.slice().sort(byRecency);

  const get = (id: string): SessionRecord | undefined => read().sessions.find((record) => record.id === id);

  const create = (record: SessionRecord): SessionRecord => {
    assertScopeIsNotAuthority(record as unknown as Record<string, unknown>);
    const state = read();
    if (state.sessions.some((existing) => existing.id === record.id)) {
      throw new Error(`a session with id ${record.id} already exists`);
    }
    write({ ...state, sessions: [record, ...state.sessions] });
    return record;
  };

  const update = (id: string, change: (record: SessionRecord) => SessionRecord): SessionRecord => {
    const state = read();
    const index = state.sessions.findIndex((record) => record.id === id);
    const current = state.sessions[index];
    if (index < 0 || !current) throw new Error(`no session with id ${id}`);
    const next = change(current);
    // The change function is caller code and may well have spread something in. Checked on the way
    // out, not only on the way in.
    assertScopeIsNotAuthority(next as unknown as Record<string, unknown>);
    const sessions = state.sessions.slice();
    sessions[index] = next;
    write({ ...state, sessions });
    return next;
  };

  const append = (id: string, entries: TranscriptEntry[]): SessionRecord =>
    update(id, (record) => appendTurns(record, entries));

  const remove = (id: string): boolean => {
    const state = read();
    const sessions = state.sessions.filter((record) => record.id !== id);
    if (sessions.length === state.sessions.length) return false;
    write({ ...state, sessions });
    return true;
  };

  return { all, get, create, update, append, remove };
}
