/**
 * Where a bundled agent keeps its own state: a pure function of the data directory, and one launch-time
 * `mkdir` that makes the directories private. Synthetic paths only.
 */

import { describe, expect, it } from '@gjsify/unit';

import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isolationDirs, isolationEnv, prepareIsolation } from '@lotse/core';

function withTempDir(run: (dir: string) => void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lotse-isolation-'));
  try {
    run(dir);
    return Promise.resolve();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

export default async () => {
  await describe('isolationDirs', async () => {
    await it('is <dataDir>/agents/<id>/{home,config,data,state,cache}', async () => {
      expect(isolationDirs('/synthetic/data/kurier', 'opencode')).toStrictEqual({
        home: '/synthetic/data/kurier/agents/opencode/home',
        config: '/synthetic/data/kurier/agents/opencode/config',
        data: '/synthetic/data/kurier/agents/opencode/data',
        state: '/synthetic/data/kurier/agents/opencode/state',
        cache: '/synthetic/data/kurier/agents/opencode/cache',
      });
    });

    await it('differs per agent id and per data directory', async () => {
      expect(isolationDirs('/synthetic/a', 'one').config).not.toBe(
        isolationDirs('/synthetic/a', 'two').config,
      );
      expect(isolationDirs('/synthetic/a', 'one').config).not.toBe(
        isolationDirs('/synthetic/b', 'one').config,
      );
    });

    await it('never lands on an agent-owned directory, whatever the data directory', async () => {
      const dirs = Object.values(isolationDirs('/synthetic/data/kurier', 'opencode'));
      for (const dir of dirs) expect(dir.includes('/.config/opencode')).toBe(false);
    });
  });

  await describe('isolationEnv', async () => {
    await it('names HOME, all four XDG directories and the npm cache, inside the isolation root', async () => {
      const dirs = isolationDirs('/synthetic/data/kurier', 'opencode');
      expect(isolationEnv(dirs)).toStrictEqual({
        HOME: dirs.home,
        XDG_CONFIG_HOME: dirs.config,
        XDG_DATA_HOME: dirs.data,
        XDG_STATE_HOME: dirs.state,
        XDG_CACHE_HOME: dirs.cache,
        npm_config_cache: `${dirs.cache}/npm`,
      });
    });

    await it("moves HOME off the person's own: opencode v2 reads ~/.claude and has no switch to stop it", async () => {
      const env = isolationEnv(isolationDirs('/synthetic/d', 'x'));
      expect(env['HOME']).toBe('/synthetic/d/agents/x/home');
    });
  });

  await describe('prepareIsolation', async () => {
    await it('creates the root, HOME and the four directories, all 0700', async () => {
      await withTempDir((dir) => {
        const dirs = isolationDirs(join(dir, 'kurier'), 'opencode');
        prepareIsolation(isolationEnv(dirs));
        for (const path of [dirs.home, dirs.config, dirs.data, dirs.state, dirs.cache]) {
          expect(existsSync(path)).toBe(true);
          expect(mode(path)).toBe(0o700);
        }
        expect(mode(join(dir, 'kurier', 'agents', 'opencode'))).toBe(0o700);
        expect(mode(join(dir, 'kurier', 'agents'))).toBe(0o700);
      });
    });

    await it('is idempotent and tightens a directory that was looser', async () => {
      await withTempDir((dir) => {
        const dirs = isolationDirs(join(dir, 'kurier'), 'opencode');
        prepareIsolation(isolationEnv(dirs));
        prepareIsolation(isolationEnv(dirs));
        expect(mode(dirs.config)).toBe(0o700);
      });
    });

    await it('ignores an unset or relative value and an environment without HOME or XDG variables', async () => {
      await withTempDir((dir) => {
        prepareIsolation(undefined);
        prepareIsolation({ XDG_CONFIG_HOME: 'relative/config', PATH: join(dir, 'nope') });
        expect(existsSync('relative/config')).toBe(false);
        expect(existsSync(join(dir, 'nope'))).toBe(false);
      });
    });
  });
};
