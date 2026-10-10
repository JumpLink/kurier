import { describe, expect, it } from '@gjsify/unit';

import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSessionStore, newSession } from '@lotse/session';

const AT = '2026-09-30T10:00:00.000Z';

async function withTempDir(run: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'kurier-store-'));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export default async () => {
  await describe('createSessionStore — round trip', async () => {
    await it('creates, reads back, and lists newest first', async () => {
      await withTempDir(async (dir) => {
        const file = join(dir, 'sessions.json');
        const store = createSessionStore(file);
        const older = newSession({ id: 'a', agent: 'opencode', cwd: '/tmp', at: '2026-09-29T00:00:00.000Z' });
        const newer = newSession({ id: 'b', agent: 'opencode', cwd: '/tmp', at: '2026-09-30T00:00:00.000Z' });
        store.create(older);
        store.create(newer);
        expect(store.all().map((r) => r.id)).toStrictEqual(['b', 'a']);
        expect(store.get('a')?.agent).toBe('opencode');
      });
    });

    await it('keeps agentSource through a write, and reads an old record without it', async () => {
      await withTempDir(async (dir) => {
        const file = join(dir, 'sessions.json');
        const store = createSessionStore(file);
        store.create(newSession({ id: 'a', agent: 'opencode', agentSource: 'bundled', cwd: '/tmp', at: AT }));
        store.create(newSession({ id: 'b', agent: 'opencode', cwd: '/tmp', at: AT }));
        const reread = createSessionStore(file);
        expect(reread.get('a')?.agentSource).toBe('bundled');
        expect(reread.get('b')?.agentSource).toBe(undefined);
      });
    });

    await it('a missing file reads as empty, not an error', async () => {
      await withTempDir(async (dir) => {
        const store = createSessionStore(join(dir, 'does-not-exist.json'));
        expect(store.all()).toStrictEqual([]);
      });
    });
  });

  await describe('createSessionStore — create / update / append / remove', async () => {
    await it('create refuses a duplicate id', async () => {
      await withTempDir(async (dir) => {
        const store = createSessionStore(join(dir, 'sessions.json'));
        const record = newSession({ id: 'a', agent: 'opencode', cwd: '/tmp', at: AT });
        store.create(record);
        expect(() => store.create(record)).toThrow(/already exists/);
      });
    });

    await it('update on a missing id throws', async () => {
      await withTempDir(async (dir) => {
        const store = createSessionStore(join(dir, 'sessions.json'));
        expect(() => store.update('no-such-id', (r) => r)).toThrow(/no session with id/);
      });
    });

    await it('append adds turns', async () => {
      await withTempDir(async (dir) => {
        const store = createSessionStore(join(dir, 'sessions.json'));
        store.create(newSession({ id: 'a', agent: 'opencode', cwd: '/tmp', at: AT }));
        store.append('a', [{ kind: 'agent', text: 'hello', at: AT }]);
        expect(store.get('a')?.turns).toStrictEqual([{ kind: 'agent', text: 'hello', at: AT }]);
      });
    });

    await it('remove returns false for an unknown id, true when it removed one', async () => {
      await withTempDir(async (dir) => {
        const store = createSessionStore(join(dir, 'sessions.json'));
        store.create(newSession({ id: 'a', agent: 'opencode', cwd: '/tmp', at: AT }));
        expect(store.remove('no-such-id')).toBe(false);
        expect(store.remove('a')).toBe(true);
        expect(store.get('a')).toBe(undefined);
      });
    });
  });

  await describe('createSessionStore — file permissions and atomicity', async () => {
    await it('writes the file 0600 in a 0700 directory', async () => {
      if (process.platform === 'win32') return;
      await withTempDir(async (dir) => {
        const file = join(dir, 'nested', 'sessions.json');
        const store = createSessionStore(file);
        store.create(newSession({ id: 'a', agent: 'opencode', cwd: '/tmp', at: AT }));
        expect(statSync(file).mode & 0o777).toBe(0o600);
        expect(statSync(join(dir, 'nested')).mode & 0o777).toBe(0o700);
      });
    });

    await it('leaves no temp file behind after a write', async () => {
      await withTempDir(async (dir) => {
        const store = createSessionStore(join(dir, 'sessions.json'));
        store.create(newSession({ id: 'a', agent: 'opencode', cwd: '/tmp', at: AT }));
        const entries = readdirSync(dir);
        expect(entries).toStrictEqual(['sessions.json']);
      });
    });
  });

  await describe('createSessionStore — the version and authority canaries', async () => {
    await it('a truncated file throws a message naming the file', async () => {
      await withTempDir(async (dir) => {
        const file = join(dir, 'sessions.json');
        writeFileSync(file, '{ "version": 1, "sessions": [ ');
        const store = createSessionStore(file);
        expect(() => store.all()).toThrow(/sessions\.json is not valid JSON/);
      });
    });

    await it('a file whose version is wrong throws a message naming the version', async () => {
      await withTempDir(async (dir) => {
        const file = join(dir, 'sessions.json');
        writeFileSync(file, JSON.stringify({ version: 2, sessions: [] }));
        const store = createSessionStore(file);
        expect(() => store.all()).toThrow(/version 2/);
      });
    });

    await it('a file that grew an "allow" key by hand is rejected on read — the canary', async () => {
      await withTempDir(async (dir) => {
        const file = join(dir, 'sessions.json');
        const record = { ...newSession({ id: 'a', agent: 'opencode', cwd: '/tmp', at: AT }), allow: ['*'] };
        writeFileSync(file, JSON.stringify({ version: 1, sessions: [record] }));
        const store = createSessionStore(file);
        expect(() => store.all()).toThrow(/may not carry "allow"/);
      });
    });
  });
};
