/**
 * Where a bundled agent keeps its own config, login, database and cache — a pure function of kurier's
 * data directory.
 *
 * **Why the bundled copy gets its own XDG directories — and its own HOME.** The person's own `opencode`
 * carries their login, config and model choice, and the bundled one must never read or write any of it.
 * Inside a Flatpak the XDG variables already point under `~/.var/app/eu.jumplink.Kurier/`, but
 * `--filesystem=host` exposes the real home right next to it, and relying on a runtime default is how this
 * breaks silently the day the default changes — or in a build that is not a Flatpak at all. So the four
 * directories are named explicitly, under `<kurier data dir>/agents/<id>/`.
 *
 * **HOME moves too, since opencode v2.** v1 had `OPENCODE_DISABLE_CLAUDE_CODE` and
 * `OPENCODE_DISABLE_EXTERNAL_SKILLS` to keep it out of the person's `~/.claude`; v2 has neither (they are
 * not in the 2.0.22 binary) and documents `~/.claude/skills` and `~/.agents/skills` as discovery sources.
 * Measured in a Flatpak sandbox with `--filesystem=host`: `HOME` stays the real home and `~/.claude` is
 * visible, so the sandbox does not help. The one switch that works without a flag is HOME itself. The cost
 * is small: the sandbox runtime has no `git`, and the person's `ssh` keys are not something a bundled copy
 * should have either way. (Whether v2 also loads `~/.claude/CLAUDE.md` was not measurable without a model
 * login; HOME covers it regardless.)
 *
 * Measured against opencode 2.0.22 (`opencode debug paths` with a scratch HOME): data, config, state and
 * cache follow `XDG_*_HOME`, and `opencode acp` spawns its own `serve --stdio` child that exits with it
 * (nothing is left after a SIGTERM to `acp`). An npm cache (`~/.npm/_cacache`) is moved by
 * `npm_config_cache`.
 */

import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

export interface IsolationDirs {
  readonly home: string;
  readonly config: string;
  readonly data: string;
  readonly state: string;
  readonly cache: string;
}

const DIR_KEYS = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'] as const;

/** `<dataDir>/agents/<id>/{home,config,data,state,cache}`. Pure; nothing is created here. */
export function isolationDirs(dataDir: string, id: string): IsolationDirs {
  const root = join(dataDir, 'agents', id);
  return {
    home: join(root, 'home'),
    config: join(root, 'config'),
    data: join(root, 'data'),
    state: join(root, 'state'),
    cache: join(root, 'cache'),
  };
}

/** The environment that points an agent at those directories. */
export function isolationEnv(dirs: IsolationDirs): Record<string, string> {
  return {
    HOME: dirs.home,
    XDG_CONFIG_HOME: dirs.config,
    XDG_DATA_HOME: dirs.data,
    XDG_STATE_HOME: dirs.state,
    XDG_CACHE_HOME: dirs.cache,
    npm_config_cache: join(dirs.cache, 'npm'),
  };
}

/**
 * Create the directories an isolation environment names, mode `0700` — set with `chmod` as well, so the
 * result does not depend on the process's umask. Called when the agent is launched, not when the command
 * is built, so building a command stays free of side effects.
 */
export function prepareIsolation(env: Readonly<Record<string, string>> | undefined): void {
  const dirs = DIR_KEYS.map((key) => env?.[key]).filter(
    (value): value is string => value !== undefined && isAbsolute(value),
  );
  const parents = new Set(dirs.map((dir) => dirname(dir)));
  for (const dir of [...parents, ...dirs]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
}
