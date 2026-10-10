/**
 * The notices file: which one-time notices a person has dismissed. Pure parse, a read that never throws on
 * a bad file, an atomic private write. Synthetic temp paths only.
 */

import { describe, expect, it } from '@gjsify/unit';

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { noticeDue } from '@lotse/core';
import {
  DEFAULT_NOTICES,
  markSeen,
  parseNotices,
  readNotices,
  writeNotices,
} from '../../../src/core/notices.ts';

async function withTempDir(run: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lotse-notices-'));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export default async () => {
  await describe('noticeDue', async () => {
    await it('is due until the id is in the seen list', async () => {
      expect(noticeDue('bundled-agent', [])).toBe(true);
      expect(noticeDue('bundled-agent', ['bundled-agent'])).toBe(false);
    });
  });

  await describe('parseNotices', async () => {
    await it('reads the seen ids', async () => {
      const parsed = parseNotices('{"version":1,"seen":["bundled-agent"]}');
      expect('notices' in parsed && parsed.notices.seen[0]).toBe('bundled-agent');
    });

    await it('leaves out an id this build does not know, so a newer kurier’s notice never breaks this one', async () => {
      const parsed = parseNotices('{"version":1,"seen":["bundled-agent","from-the-future"]}');
      expect('notices' in parsed && parsed.notices.seen.length).toBe(1);
    });

    await it('reports bad JSON, an unknown key and a wrong version as problems, never a throw', async () => {
      expect('problem' in parseNotices('{nope')).toBe(true);
      expect('problem' in parseNotices('[]')).toBe(true);
      expect('problem' in parseNotices('{"version":1,"seen":[],"token":"x"}')).toBe(true);
      expect('problem' in parseNotices('{"version":2,"seen":[]}')).toBe(true);
      expect('problem' in parseNotices('{"version":1,"seen":"bundled-agent"}')).toBe(true);
    });
  });

  await describe('markSeen', async () => {
    await it('adds an id once', async () => {
      const once = markSeen(DEFAULT_NOTICES, 'bundled-agent');
      expect(once.seen.length).toBe(1);
      expect(markSeen(once, 'bundled-agent').seen.length).toBe(1);
    });
  });

  await describe('readNotices', async () => {
    await it('treats a missing file as nothing seen and no problem', async () => {
      await withTempDir((dir) => {
        const read = readNotices(join(dir, 'notices.json'));
        expect(read.notices.seen.length).toBe(0);
        expect(read.problem).toBe(null);
      });
    });

    await it('shows the notice again for a corrupt file instead of crashing', async () => {
      await withTempDir((dir) => {
        const file = join(dir, 'notices.json');
        writeFileSync(file, '{ not json');
        const read = readNotices(file);
        expect(noticeDue('bundled-agent', read.notices.seen)).toBe(true);
        expect(read.problem === null).toBe(false);
      });
    });

    await it('shows the notice again for a file that cannot be read', async () => {
      await withTempDir((dir) => {
        const file = join(dir, 'notices.json');
        mkdirSync(file);
        const read = readNotices(file);
        expect(noticeDue('bundled-agent', read.notices.seen)).toBe(true);
        expect(read.problem === null).toBe(false);
      });
    });
  });

  await describe('writeNotices', async () => {
    await it('round-trips, 0600 in a 0700 directory it created, and leaves no temp file', async () => {
      await withTempDir((dir) => {
        const file = join(dir, 'kurier', 'notices.json');
        writeNotices(file, markSeen(DEFAULT_NOTICES, 'bundled-agent'));
        expect(readNotices(file).notices.seen[0]).toBe('bundled-agent');
        expect(statSync(file).mode & 0o777).toBe(0o600);
        expect(statSync(join(dir, 'kurier')).mode & 0o777).toBe(0o700);
        expect(readdirSync(join(dir, 'kurier')).join(',')).toBe('notices.json');
        expect(readFileSync(file, 'utf8').includes('bundled-agent')).toBe(true);
      });
    });
  });
};
