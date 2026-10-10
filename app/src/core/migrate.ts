/**
 * The one-time move from the directories kurier wrote to the ones lotse writes.
 *
 * Through 0.1.1 the app was called kurier and kept its session file in `$XDG_DATA_HOME/kurier` and
 * its settings in `$XDG_CONFIG_HOME/kurier`. The session file holds the text of a person's
 * conversations with an agent, so the rename must not make it look like the app forgot them.
 *
 * **One rename per directory, and never an overwrite.** `lotse` already existing means a newer run
 * (or a fresh install) owns it, so the old one is left where it is and said so rather than merged:
 * merging two session files is a decision nobody asked for. `rename(2)` within one `$XDG_*_HOME` is
 * atomic and carries the mode across, so the `0700` a private directory had stays `0700` and a
 * crash leaves either the old path or the new one, never half of each.
 *
 * **A move that fails keeps the old directory in use.** That is why this returns the paths rather
 * than just a boolean: a read-only home or an `EXDEV` across a mount leaves the app pointed at the
 * data it already has, with a line saying what happened, instead of silently starting empty.
 *
 * An explicit `LOTSE_DATA_DIR`/`LOTSE_SESSIONS_FILE` (or the `KURIER_*` spelling) turns the whole
 * thing off: a person who named a directory does not want it moved. A host that builds its paths
 * with `lotsePathsUnder(root)` never comes through here at all.
 */

import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { envKnob, type LotsePaths } from '@lotse/core';

import { lotsePaths, xdgConfigHome, xdgDataHome } from './paths.ts';

/** The directory kurier used, under the same XDG home as the lotse one. */
const LEGACY_DIR_NAME = 'kurier';

/** What happened to one directory. `dir` is the one to use now, whether or not the move worked. */
export interface DirMove {
  readonly dir: string;
  readonly moved: boolean;
  /** One line for a log or a notice, or `null` when there was nothing to do. */
  readonly note: string | null;
}

/**
 * Move `legacy` to `current` if — and only if — `current` is not there and `legacy` is. Pure about
 * its answer: whatever it returns in `dir` is the directory that holds the data.
 */
export function adoptLegacyDir(current: string, legacy: string): DirMove {
  if (current === legacy || existsSync(current) || !existsSync(legacy)) {
    return { dir: current, moved: false, note: null };
  }
  try {
    const parent = dirname(current);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
    renameSync(legacy, current);
    return { dir: current, moved: true, note: `moved ${legacy} to ${current} (kurier is now lotse)` };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      dir: legacy,
      moved: false,
      note: `could not move ${legacy} to ${current} (${reason}) — still reading ${legacy}`,
    };
  }
}

/** The paths to use, after the one-time move, plus a line per directory that was not already in place. */
export interface MigratedPaths {
  readonly paths: LotsePaths;
  readonly notes: readonly string[];
}

/**
 * Resolve the paths and perform the move. The only entry point a surface needs: `app/src/index.ts`
 * and the window call this instead of `lotsePaths()` so that a first run after the rename finds the
 * conversations that are already on the disk.
 */
export function migratedPaths(env: NodeJS.ProcessEnv = process.env): MigratedPaths {
  const paths = lotsePaths(env);
  const pinned = Boolean(
    envKnob(env, 'DATA_DIR') ||
    envKnob(env, 'SESSIONS_FILE') ||
    envKnob(env, 'SETTINGS_FILE') ||
    envKnob(env, 'NOTICES_FILE'),
  );
  if (pinned) return { paths, notes: [] };

  const data = adoptLegacyDir(paths.dataDir, join(xdgDataHome(env), LEGACY_DIR_NAME));
  const config = adoptLegacyDir(paths.configDir, join(xdgConfigHome(env), LEGACY_DIR_NAME));

  return {
    paths: {
      dataDir: data.dir,
      configDir: config.dir,
      sessionsFile: join(data.dir, 'sessions.json'),
      settingsFile: join(config.dir, 'settings.json'),
      noticesFile: join(data.dir, 'notices.json'),
    },
    notes: [data.note, config.note].filter((note): note is string => note !== null),
  };
}
