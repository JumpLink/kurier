import { describe, expect, it } from '@gjsify/unit';

import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { createSessionStore, newSession } from '@lotse/session';

import {
  gatherResolveContext,
  isolationDirs,
  isolationEnv,
  lotsePathsUnder,
  prepareIsolation,
} from '@lotse/core';
import { DEFAULT_NOTICES, writeNotices } from '../../../src/core/notices.ts';
import { saveSettings } from '../../../src/core/settings.ts';
import {
  dataDir,
  lotsePaths,
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
    await it('honors LOTSE_DATA_DIR', async () => {
      expect(dataDir({ LOTSE_DATA_DIR: '/opt/lotse-data' })).toBe('/opt/lotse-data');
    });

    await it('defaults to <xdgDataHome>/lotse', async () => {
      expect(dataDir({})).toBe(join(XDG_DEFAULT, 'lotse'));
    });
  });

  await describe('sessionsFile', async () => {
    await it('honors LOTSE_SESSIONS_FILE', async () => {
      expect(sessionsFile({ LOTSE_SESSIONS_FILE: '/tmp/my-sessions.json' })).toBe('/tmp/my-sessions.json');
    });

    await it('the default path ends in lotse/sessions.json', async () => {
      expect(sessionsFile({})).toBe(join(XDG_DEFAULT, 'lotse', 'sessions.json'));
      expect(sessionsFile({}).endsWith(join('lotse', 'sessions.json'))).toBe(true);
    });
  });

  await describe('settingsFile', async () => {
    await it('honors LOTSE_SETTINGS_FILE', async () => {
      expect(settingsFile({ LOTSE_SETTINGS_FILE: '/tmp/my-settings.json' })).toBe('/tmp/my-settings.json');
    });

    await it('lives under the config home, not the data home', async () => {
      expect(settingsFile({ XDG_CONFIG_HOME: '/custom/config', XDG_DATA_HOME: '/custom/data' })).toBe(
        '/custom/config/lotse/settings.json',
      );
    });

    await it('defaults to ~/.config/lotse/settings.json', async () => {
      expect(settingsFile({})).toBe(join(homedir(), '.config', 'lotse', 'settings.json'));
    });

    await it('ignores a relative XDG_CONFIG_HOME', async () => {
      expect(xdgConfigHome({ XDG_CONFIG_HOME: 'relative' })).toBe(join(homedir(), '.config'));
    });
  });

  await describe('noticesFile', async () => {
    await it('honors LOTSE_NOTICES_FILE', async () => {
      expect(noticesFile({ LOTSE_NOTICES_FILE: '/tmp/x/n.json' })).toBe('/tmp/x/n.json');
    });

    await it('defaults to notices.json in the data directory', async () => {
      expect(noticesFile({ LOTSE_DATA_DIR: '/opt/kd' })).toBe('/opt/kd/notices.json');
    });
  });

  await describe('lotsePaths — the defaults', async () => {
    await it("reproduces today's paths", async () => {
      expect(lotsePaths({})).toStrictEqual({
        dataDir: join(XDG_DEFAULT, 'lotse'),
        configDir: join(homedir(), '.config', 'lotse'),
        sessionsFile: join(XDG_DEFAULT, 'lotse', 'sessions.json'),
        settingsFile: join(homedir(), '.config', 'lotse', 'settings.json'),
        noticesFile: join(XDG_DEFAULT, 'lotse', 'notices.json'),
      });
    });

    await it('keeps the legacy environment knobs working', async () => {
      const env = {
        XDG_DATA_HOME: '/x/data',
        XDG_CONFIG_HOME: '/x/config',
        LOTSE_SESSIONS_FILE: '/y/s.json',
        LOTSE_NOTICES_FILE: '/y/n.json',
      };
      const paths = lotsePaths(env);
      expect(paths.dataDir).toBe('/x/data/lotse');
      expect(paths.configDir).toBe('/x/config/lotse');
      expect(paths.settingsFile).toBe('/x/config/lotse/settings.json');
      expect(paths.sessionsFile).toBe('/y/s.json');
      expect(paths.noticesFile).toBe('/y/n.json');
      expect(lotsePaths({ LOTSE_DATA_DIR: '/d' }).noticesFile).toBe('/d/notices.json');
    });
  });

  // The app was called kurier through 0.1.1, so a machine set up then has the old names set
  // somewhere nobody is going to revisit. Every knob reads both, and the new name wins.
  await describe('the KURIER_* names from before the rename', async () => {
    await it('still resolves every knob', async () => {
      expect(dataDir({ KURIER_DATA_DIR: '/old/data' })).toBe('/old/data');
      expect(sessionsFile({ KURIER_SESSIONS_FILE: '/old/s.json' })).toBe('/old/s.json');
      expect(settingsFile({ KURIER_SETTINGS_FILE: '/old/t.json' })).toBe('/old/t.json');
      expect(noticesFile({ KURIER_NOTICES_FILE: '/old/n.json' })).toBe('/old/n.json');
    });

    await it('loses to the LOTSE_* name when both are set', async () => {
      expect(dataDir({ KURIER_DATA_DIR: '/old/data', LOTSE_DATA_DIR: '/new/data' })).toBe('/new/data');
      expect(sessionsFile({ KURIER_SESSIONS_FILE: '/old/s.json', LOTSE_SESSIONS_FILE: '/new/s.json' })).toBe(
        '/new/s.json',
      );
      expect(settingsFile({ KURIER_SETTINGS_FILE: '/old/t.json', LOTSE_SETTINGS_FILE: '/new/t.json' })).toBe(
        '/new/t.json',
      );
      expect(noticesFile({ KURIER_NOTICES_FILE: '/old/n.json', LOTSE_NOTICES_FILE: '/new/n.json' })).toBe(
        '/new/n.json',
      );
    });

    // An empty or whitespace value is how a launcher unsets a knob it does not want; it must not
    // beat the old name, and it must not win over the XDG default either.
    await it('treats a blank LOTSE_* value as unset', async () => {
      expect(dataDir({ KURIER_DATA_DIR: '/old/data', LOTSE_DATA_DIR: '  ' })).toBe('/old/data');
      expect(dataDir({ KURIER_DATA_DIR: ' ', XDG_DATA_HOME: '/x' })).toBe('/x/lotse');
    });
  });

  await describe('lotsePathsUnder — an injected root', async () => {
    await it('puts every file under the root', async () => {
      const paths = lotsePathsUnder('/host/app/lotse');
      for (const path of Object.values(paths)) expect(path.startsWith('/host/app/lotse/')).toBe(true);
    });

    await it('redirects what core writes: sessions, settings, notices, agent HOME and XDG', async () => {
      const root = mkdtempSync(join(tmpdir(), 'lotse-paths-'));
      try {
        const paths = lotsePathsUnder(root);
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
