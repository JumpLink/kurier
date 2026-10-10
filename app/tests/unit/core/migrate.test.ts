import { describe, expect, it } from '@gjsify/unit';

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { adoptLegacyDir, migratedPaths } from '../../../src/core/migrate.ts';

/** A temp root with `data/` and `config/` under it, used as `XDG_DATA_HOME`/`XDG_CONFIG_HOME`. */
function withRoot(body: (root: string, env: NodeJS.ProcessEnv) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'lotse-migrate-'));
  try {
    const env = { XDG_DATA_HOME: join(root, 'data'), XDG_CONFIG_HOME: join(root, 'config') };
    mkdirSync(env.XDG_DATA_HOME, { recursive: true });
    mkdirSync(env.XDG_CONFIG_HOME, { recursive: true });
    body(root, env);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A directory that looks like one kurier left behind: `0700`, with one `0600` file in it. */
function seedLegacy(dir: string, text: string, file = 'sessions.json'): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, file), text, { mode: 0o600 });
}

export default async () => {
  await describe('adoptLegacyDir', async () => {
    await it('does nothing when there is no legacy directory', async () => {
      withRoot((root) => {
        const move = adoptLegacyDir(join(root, 'data', 'lotse'), join(root, 'data', 'kurier'));
        expect(move).toStrictEqual({ dir: join(root, 'data', 'lotse'), moved: false, note: null });
        expect(existsSync(move.dir)).toBe(false);
      });
    });

    await it('moves the legacy directory and keeps its contents and its 0700', async () => {
      withRoot((root) => {
        const legacy = join(root, 'data', 'kurier');
        const current = join(root, 'data', 'lotse');
        seedLegacy(legacy, '{"sessions":["one"]}');

        const move = adoptLegacyDir(current, legacy);

        expect(move.moved).toBe(true);
        expect(move.dir).toBe(current);
        expect(move.note).toContain(current);
        expect(existsSync(legacy)).toBe(false);
        expect(readFileSync(join(current, 'sessions.json'), 'utf8')).toBe('{"sessions":["one"]}');
        expect(statSync(current).mode & 0o777).toBe(0o700);
      });
    });

    // Both present means something already owns the new directory. Merging two session files is a
    // decision nobody asked for, so the old one is left untouched where a person can find it.
    await it('never overwrites an existing directory, and leaves the old one alone', async () => {
      withRoot((root) => {
        const legacy = join(root, 'data', 'kurier');
        const current = join(root, 'data', 'lotse');
        seedLegacy(legacy, '{"sessions":["old"]}');
        seedLegacy(current, '{"sessions":["new"]}');

        const move = adoptLegacyDir(current, legacy);

        expect(move).toStrictEqual({ dir: current, moved: false, note: null });
        expect(readFileSync(join(current, 'sessions.json'), 'utf8')).toBe('{"sessions":["new"]}');
        expect(readFileSync(join(legacy, 'sessions.json'), 'utf8')).toBe('{"sessions":["old"]}');
      });
    });

    // A read-only home, or an EXDEV across a mount. The app has to come up on the data it has.
    await it('falls back to the legacy directory when the move fails, and says so', async () => {
      withRoot((root) => {
        const parent = join(root, 'locked');
        const legacy = join(root, 'data', 'kurier');
        seedLegacy(legacy, '{"sessions":["one"]}');
        mkdirSync(parent, { recursive: true });
        chmodSync(parent, 0o500);
        try {
          const move = adoptLegacyDir(join(parent, 'lotse'), legacy);

          expect(move.moved).toBe(false);
          expect(move.dir).toBe(legacy);
          expect(move.note).toContain(legacy);
          expect(readFileSync(join(legacy, 'sessions.json'), 'utf8')).toBe('{"sessions":["one"]}');
        } finally {
          chmodSync(parent, 0o700);
        }
      });
    });
  });

  await describe('migratedPaths', async () => {
    await it('leaves a fresh install at the lotse paths, with nothing to report', async () => {
      withRoot((root, env) => {
        const { paths, notes } = migratedPaths(env);
        expect(notes).toStrictEqual([]);
        expect(paths.dataDir).toBe(join(root, 'data', 'lotse'));
        expect(paths.configDir).toBe(join(root, 'config', 'lotse'));
        expect(paths.sessionsFile).toBe(join(root, 'data', 'lotse', 'sessions.json'));
      });
    });

    await it('adopts both directories and reports one note each', async () => {
      withRoot((root, env) => {
        seedLegacy(join(root, 'data', 'kurier'), '{"sessions":["one"]}');
        seedLegacy(join(root, 'config', 'kurier'), '{"version":1}', 'settings.json');

        const { paths, notes } = migratedPaths(env);

        expect(notes.length).toBe(2);
        expect(paths.dataDir).toBe(join(root, 'data', 'lotse'));
        expect(paths.configDir).toBe(join(root, 'config', 'lotse'));
        expect(readFileSync(paths.sessionsFile, 'utf8')).toBe('{"sessions":["one"]}');
        expect(readFileSync(paths.settingsFile, 'utf8')).toBe('{"version":1}');
        expect(paths.noticesFile).toBe(join(root, 'data', 'lotse', 'notices.json'));
      });
    });

    // The data directory can move while the config one has nothing to move, and the files follow
    // whichever directory each one actually ended up in.
    await it('migrates one directory without inventing the other', async () => {
      withRoot((root, env) => {
        seedLegacy(join(root, 'data', 'kurier'), '{"sessions":["one"]}');

        const { paths, notes } = migratedPaths(env);

        expect(notes.length).toBe(1);
        expect(existsSync(paths.dataDir)).toBe(true);
        expect(existsSync(paths.configDir)).toBe(false);
        expect(paths.settingsFile).toBe(join(root, 'config', 'lotse', 'settings.json'));
      });
    });

    // A person who named a directory does not want it moved — including under the old spelling,
    // which is exactly the machine most likely to have a legacy directory sitting there.
    await it('skips the move when a path knob is pinned, old spelling included', async () => {
      withRoot((root, env) => {
        const legacy = join(root, 'data', 'kurier');
        seedLegacy(legacy, '{"sessions":["one"]}');

        const pinned = migratedPaths({ ...env, LOTSE_SESSIONS_FILE: join(root, 's.json') });
        expect(pinned.notes).toStrictEqual([]);
        expect(existsSync(legacy)).toBe(true);

        const pinnedOldName = migratedPaths({ ...env, KURIER_DATA_DIR: legacy });
        expect(pinnedOldName.notes).toStrictEqual([]);
        expect(pinnedOldName.paths.dataDir).toBe(legacy);
        expect(existsSync(legacy)).toBe(true);
      });
    });
  });
};
