/**
 * The settings file: the pure parse, the read that never throws on a bad file, and the write that is
 * atomic and private. Synthetic temp paths only.
 */

import { describe, expect, it } from '@gjsify/unit';

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_SETTINGS,
  parseChoiceSpec,
  parseSettings,
  readSettings,
  writeSettings,
  type Settings,
} from '../../../src/core/settings.ts';

async function withTempDir(run: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'kurier-settings-'));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const BUNDLED: Settings = { version: 1, agent: { id: 'opencode', source: 'bundled' } };

function problemOf(raw: string): string {
  const parsed = parseSettings(raw);
  if (!('problem' in parsed)) throw new Error(`expected a problem, got ${JSON.stringify(parsed)}`);
  return parsed.problem;
}

export default async () => {
  await describe('parseSettings', async () => {
    await it('reads a valid choice, host and bundled apart', async () => {
      expect(parseSettings('{"version":1,"agent":{"id":"opencode","source":"bundled"}}')).toStrictEqual({
        settings: BUNDLED,
      });
      expect(parseSettings('{"version":1,"agent":{"id":"opencode","source":"host"}}')).toStrictEqual({
        settings: { version: 1, agent: { id: 'opencode', source: 'host' } },
      });
    });

    await it('a missing or null agent is the defaults', async () => {
      expect(parseSettings('{"version":1}')).toStrictEqual({ settings: DEFAULT_SETTINGS });
      expect(parseSettings('{"version":1,"agent":null}')).toStrictEqual({ settings: DEFAULT_SETTINGS });
    });

    await it('corrupt text is a problem, not a throw', async () => {
      expect(problemOf('{"version":1,')).toContain('not valid JSON');
      expect(problemOf('[]')).toContain('not a settings object');
      expect(problemOf('null')).toContain('not a settings object');
    });

    await it('an unknown version is a problem naming it', async () => {
      expect(problemOf('{"version":2,"agent":null}')).toContain('version 2');
      expect(problemOf('{"agent":null}')).toContain('version undefined');
    });

    await it('an extra key is a problem naming it, at both levels', async () => {
      expect(problemOf('{"version":1,"theme":"dark"}')).toContain('"theme"');
      expect(problemOf('{"version":1,"agent":{"id":"a","source":"host","path":"/x"}}')).toContain(
        '"agent.path"',
      );
    });

    await it('a malformed choice is a problem', async () => {
      expect(problemOf('{"version":1,"agent":"opencode"}')).toContain('"agent"');
      expect(problemOf('{"version":1,"agent":{"id":"","source":"host"}}')).toContain('agent.id');
      expect(problemOf('{"version":1,"agent":{"id":"../x","source":"host"}}')).toContain('agent.id');
      expect(problemOf('{"version":1,"agent":{"id":"a","source":"flatpak"}}')).toContain('agent.source');
    });

    await it('a secret-looking key is reported even when the version is wrong', async () => {
      expect(problemOf('{"version":2,"token":"x"}')).toContain('secret-looking');
      expect(problemOf('{"token":"x"}')).toContain('"token"');
    });

    await it('no key could hold a secret: every secret-looking key is refused, at both levels', async () => {
      const keys = [
        'token',
        'accessToken',
        'apiKey',
        'api_key',
        'key',
        'password',
        'secret',
        'auth',
        'credentials',
      ];
      for (const key of keys) {
        const top = problemOf(JSON.stringify({ version: 1, [key]: 'x' }));
        expect(top).toContain(`"${key}"`);
        expect(top).toContain('secret-looking');
        const nested = problemOf(
          JSON.stringify({ version: 1, agent: { id: 'a', source: 'host', [key]: 'x' } }),
        );
        expect(nested).toContain(`"agent.${key}"`);
        expect(nested).toContain('secret-looking');
      }
    });

    await it('a parsed value carries only version and the choice', async () => {
      const parsed = parseSettings('{"version":1,"agent":{"id":"opencode","source":"host"}}');
      if (!('settings' in parsed)) throw new Error('expected settings');
      expect(Object.keys(parsed.settings).sort()).toStrictEqual(['agent', 'version']);
      expect(Object.keys(parsed.settings.agent!).sort()).toStrictEqual(['id', 'source']);
    });
  });

  await describe('parseChoiceSpec', async () => {
    const known = ['opencode'];

    await it('a bare id is the host install', async () => {
      expect(parseChoiceSpec('opencode', known)).toStrictEqual({
        choice: { id: 'opencode', source: 'host' },
      });
    });

    await it('reads both source suffixes and "none"', async () => {
      expect(parseChoiceSpec('opencode:bundled', known)).toStrictEqual({
        choice: { id: 'opencode', source: 'bundled' },
      });
      expect(parseChoiceSpec('opencode:host', known)).toStrictEqual({
        choice: { id: 'opencode', source: 'host' },
      });
      expect(parseChoiceSpec('none', known)).toStrictEqual({ choice: null });
    });

    await it('refuses an unknown id, an unknown source and extra parts', async () => {
      expect('problem' in parseChoiceSpec('ghost', known)).toBe(true);
      expect('problem' in parseChoiceSpec('opencode:flatpak', known)).toBe(true);
      expect('problem' in parseChoiceSpec('opencode:host:x', known)).toBe(true);
    });
  });

  await describe('readSettings', async () => {
    await it('a missing file is the defaults and no problem', async () => {
      await withTempDir(async (dir) => {
        expect(readSettings(join(dir, 'nope.json'))).toStrictEqual({
          settings: DEFAULT_SETTINGS,
          problem: null,
        });
      });
    });

    await it('a corrupt file is the defaults plus a problem naming the file — not a throw', async () => {
      await withTempDir(async (dir) => {
        const file = join(dir, 'settings.json');
        writeFileSync(file, '{ not json');
        const read = readSettings(file);
        expect(read.settings).toStrictEqual(DEFAULT_SETTINGS);
        expect(read.problem).toContain(file);
        expect(read.problem).toContain('using defaults');
      });
    });

    await it('an unreadable path (a directory) is reported, not thrown', async () => {
      await withTempDir(async (dir) => {
        const read = readSettings(dir);
        expect(read.settings).toStrictEqual(DEFAULT_SETTINGS);
        expect(read.problem).toContain('could not be read');
      });
    });

    await it('an unknown version and a secret-looking key fall back and are reported', async () => {
      await withTempDir(async (dir) => {
        const file = join(dir, 'settings.json');
        writeFileSync(file, '{"version":9}');
        expect(readSettings(file).problem).toContain('version 9');
        writeFileSync(file, '{"version":1,"token":"x"}');
        const read = readSettings(file);
        expect(read.settings).toStrictEqual(DEFAULT_SETTINGS);
        expect(read.problem).toContain('secret-looking');
      });
    });
  });

  await describe('writeSettings', async () => {
    await it('round-trips through readSettings', async () => {
      await withTempDir(async (dir) => {
        const file = join(dir, 'settings.json');
        writeSettings(file, BUNDLED);
        expect(readSettings(file)).toStrictEqual({ settings: BUNDLED, problem: null });
        writeSettings(file, DEFAULT_SETTINGS);
        expect(readSettings(file).settings).toStrictEqual(DEFAULT_SETTINGS);
      });
    });

    await it('the file is 0600 and a directory it creates is 0700', async () => {
      await withTempDir(async (dir) => {
        const sub = join(dir, 'fresh', 'kurier');
        const file = join(sub, 'settings.json');
        writeSettings(file, BUNDLED);
        expect(statSync(file).mode & 0o777).toBe(0o600);
        expect(statSync(sub).mode & 0o777).toBe(0o700);
      });
    });

    await it('is 0600 even when the process umask is open, and rewriting keeps it', async () => {
      await withTempDir(async (dir) => {
        const file = join(dir, 'settings.json');
        const before = process.umask(0);
        try {
          writeSettings(file, BUNDLED);
          writeSettings(file, DEFAULT_SETTINGS);
        } finally {
          process.umask(before);
        }
        expect(statSync(file).mode & 0o777).toBe(0o600);
      });
    });

    await it("leaves an existing directory's mode alone", async () => {
      await withTempDir(async (dir) => {
        const shared = join(dir, 'shared');
        mkdirSync(shared, { mode: 0o755 });
        writeSettings(join(shared, 'settings.json'), BUNDLED);
        expect(statSync(shared).mode & 0o777).toBe(0o755);
      });
    });

    await it('writes through a temp file: only the target remains, and it is complete JSON', async () => {
      await withTempDir(async (dir) => {
        const file = join(dir, 'settings.json');
        writeSettings(file, BUNDLED);
        expect(readdirSync(dir)).toStrictEqual(['settings.json']);
        expect(JSON.parse(readFileSync(file, 'utf8'))).toStrictEqual(BUNDLED);
      });
    });

    await it('a failed write throws and leaves no temp file behind', async () => {
      await withTempDir(async (dir) => {
        const target = join(dir, 'settings.json');
        mkdirSync(join(target, 'occupied'), { recursive: true });
        let threw = false;
        try {
          writeSettings(target, BUNDLED);
        } catch {
          threw = true;
        }
        expect(threw).toBe(true);
        expect(readdirSync(dir)).toStrictEqual(['settings.json']);
      });
    });
  });
};
