import { describe, expect, it } from '@gjsify/unit';

import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { createSessionStore, newSession } from '@kurier/session';

import {
  gatherResolveContext,
  isolationDirs,
  isolationEnv,
  kurierPathsUnder,
  prepareIsolation,
} from '@kurier/core';
import { DEFAULT_NOTICES, writeNotices } from '../../../src/core/notices.ts';
import { saveSettings } from '../../../src/core/settings.ts';
import {
  dataDir,
  kurierPaths,
  noticesFile,
  sessionsFile,
  settingsFile,
  xdgConfigHome,
  xdgDataHome,
} from '../../../src/core/paths.ts';

const XDG_DEFAULT = join(homedir(), '.local', 'share');

export default async () => {
  await describe('xdgDataHome', async () => {
    await it('honors an absolute XDG_DATA_HOME', async () => {
      expect(xdgDataHome({ XDG_DATA_HOME: '/custom/data' })).toBe('/custom/data');
    });

    await it('ignores a relative XDG_DATA_HOME, per the XDG spec', async () => {
      expect(xdgDataHome({ XDG_DATA_HOME: 'relative/data' })).toBe(XDG_DEFAULT);
    });

    await it('falls back to the XDG default when unset', async () => {
      expect(xdgDataHome({})).toBe(XDG_DEFAULT);
    });
  });

  await describe('dataDir', async () => {
    await it('honors KURIER_DATA_DIR', async () => {
      expect(dataDir({ KURIER_DATA_DIR: '/opt/kurier-data' })).toBe('/opt/kurier-data');
    });

    await it('defaults to <xdgDataHome>/kurier', async () => {
      expect(dataDir({})).toBe(join(XDG_DEFAULT, 'kurier'));
    });
  });

  await describe('sessionsFile', async () => {
    await it('honors KURIER_SESSIONS_FILE', async () => {
      expect(sessionsFile({ KURIER_SESSIONS_FILE: '/tmp/my-sessions.json' })).toBe('/tmp/my-sessions.json');
    });

    await it('the default path ends in kurier/sessions.json', async () => {
      expect(sessionsFile({})).toBe(join(XDG_DEFAULT, 'kurier', 'sessions.json'));
      expect(sessionsFile({}).endsWith(join('kurier', 'sessions.json'))).toBe(true);
    });
  });

  await describe('settingsFile', async () => {
    await it('honors KURIER_SETTINGS_FILE', async () => {
      expect(settingsFile({ KURIER_SETTINGS_FILE: '/tmp/my-settings.json' })).toBe('/tmp/my-settings.json');
    });

    await it('lives under the config home, not the data home', async () => {
      expect(settingsFile({ XDG_CONFIG_HOME: '/custom/config', XDG_DATA_HOME: '/custom/data' })).toBe(
        '/custom/config/kurier/settings.json',
      );
    });

    await it('defaults to ~/.config/kurier/settings.json', async () => {
      expect(settingsFile({})).toBe(join(homedir(), '.config', 'kurier', 'settings.json'));
    });

    await it('ignores a relative XDG_CONFIG_HOME', async () => {
      expect(xdgConfigHome({ XDG_CONFIG_HOME: 'relative' })).toBe(join(homedir(), '.config'));
    });
  });

  await describe('noticesFile', async () => {
    await it('honors KURIER_NOTICES_FILE', async () => {
      expect(noticesFile({ KURIER_NOTICES_FILE: '/tmp/x/n.json' })).toBe('/tmp/x/n.json');
    });

    await it('defaults to notices.json in the data directory', async () => {
      expect(noticesFile({ KURIER_DATA_DIR: '/opt/kd' })).toBe('/opt/kd/notices.json');
    });
  });

  await describe('kurierPaths — the defaults', async () => {
    await it("reproduces today's paths", async () => {
      expect(kurierPaths({})).toStrictEqual({
        dataDir: join(XDG_DEFAULT, 'kurier'),
        configDir: join(homedir(), '.config', 'kurier'),
        sessionsFile: join(XDG_DEFAULT, 'kurier', 'sessions.json'),
        settingsFile: join(homedir(), '.config', 'kurier', 'settings.json'),
        noticesFile: join(XDG_DEFAULT, 'kurier', 'notices.json'),
      });
    });

    await it('keeps the legacy environment knobs working', async () => {
      const env = {
        XDG_DATA_HOME: '/x/data',
        XDG_CONFIG_HOME: '/x/config',
        KURIER_SESSIONS_FILE: '/y/s.json',
        KURIER_NOTICES_FILE: '/y/n.json',
      };
      const paths = kurierPaths(env);
      expect(paths.dataDir).toBe('/x/data/kurier');
      expect(paths.configDir).toBe('/x/config/kurier');
      expect(paths.settingsFile).toBe('/x/config/kurier/settings.json');
      expect(paths.sessionsFile).toBe('/y/s.json');
      expect(paths.noticesFile).toBe('/y/n.json');
      expect(kurierPaths({ KURIER_DATA_DIR: '/d' }).noticesFile).toBe('/d/notices.json');
    });
  });

  await describe('kurierPathsUnder — an injected root', async () => {
    await it('puts every file under the root', async () => {
      const paths = kurierPathsUnder('/host/app/kurier');
      for (const path of Object.values(paths)) expect(path.startsWith('/host/app/kurier/')).toBe(true);
    });

    await it('redirects what core writes: sessions, settings, notices, agent HOME and XDG', async () => {
      const root = mkdtempSync(join(tmpdir(), 'kurier-paths-'));
      try {
        const paths = kurierPathsUnder(root);
        createSessionStore(paths.sessionsFile).create(
          newSession({ id: 'a', agent: 'opencode', cwd: '/tmp', at: '2026-09-30T10:00:00.000Z' }),
        );
        saveSettings(paths.settingsFile, { version: 1, agent: null });
        writeNotices(paths.noticesFile, DEFAULT_NOTICES);

        const dirs = gatherResolveContext(paths, false, false).isolationFor('opencode');
        expect(dirs).toStrictEqual(isolationDirs(paths.dataDir, 'opencode'));
        const env = isolationEnv(dirs);
        prepareIsolation(env);
        for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) {
          expect(env[key]!.startsWith(`${root}/`)).toBe(true);
          expect(statSync(env[key]!).isDirectory()).toBe(true);
        }

        const written = readdirSync(root, { recursive: true, withFileTypes: false }).map(String);
        expect(written.includes(relative(root, paths.sessionsFile))).toBe(true);
        expect(written.includes(relative(root, paths.settingsFile))).toBe(true);
        expect(written.includes(relative(root, paths.noticesFile))).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
};
