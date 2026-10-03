/**
 * Where a bundled agent keeps its own config, login, database and cache — a pure function of kurier's
 * data directory.
 *
 * **Why the bundled copy gets its own XDG directories.** The person's own `opencode` carries their login,
 * config and model choice, and the bundled one must never read or write any of it. Inside a Flatpak the
 * XDG variables already point under `~/.var/app/eu.jumplink.Kurier/`, but `--filesystem=host` exposes the
 * real home right next to it, and relying on a runtime default is how this breaks silently the day the
 * default changes — or in a build that is not a Flatpak at all. So the four directories are named
 * explicitly, under `<kurier data dir>/agents/<id>/`.
 *
 * Measured against opencode 1.18.34 (`opencode debug paths` with a scratch HOME): data, config, state and
 * cache all follow `XDG_*_HOME`, and with all four set nothing is written under HOME — except an npm cache
 * (`~/.npm/_cacache`), which `npm_config_cache` moves. `opencode acp` also binds no port, so no seeded
 * config is needed and two instances share one directory.
 */

import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

export interface IsolationDirs {
  readonly config: string;
  readonly data: string;
  readonly state: string;
  readonly cache: string;
}

const XDG_KEYS = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'] as const;

/** `<dataDir>/agents/<id>/{config,data,state,cache}`. Pure; nothing is created here. */
export function isolationDirs(dataDir: string, id: string): IsolationDirs {
  const root = join(dataDir, 'agents', id);
  return {
    config: join(root, 'config'),
    data: join(root, 'data'),
    state: join(root, 'state'),
    cache: join(root, 'cache'),
  };
}

/** The environment that points an agent at those directories. */
export function isolationEnv(dirs: IsolationDirs): Record<string, string> {
  return {
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
  const dirs = XDG_KEYS.map((key) => env?.[key]).filter(
    (value): value is string => value !== undefined && isAbsolute(value),
  );
  const parents = new Set(dirs.map((dir) => dirname(dir)));
  for (const dir of [...parents, ...dirs]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
}
