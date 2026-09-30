import { describe, expect, it } from '@gjsify/unit';

import { homedir } from 'node:os';
import { join } from 'node:path';

import { dataDir, sessionsFile, xdgDataHome } from '../../../src/core/paths.ts';

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
};
