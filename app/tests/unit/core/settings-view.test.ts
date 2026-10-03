/**
 * `core/settings-view.ts` — the rows the preferences dialog lists, pure over facts. A synthetic machine:
 * `alpha` is on the PATH, `beta` is not, and only `beta` has a bundled copy.
 */

import { describe, expect, it } from '@gjsify/unit';

import { BUNDLED_PREFIX, parseBundledCatalog } from '../../../src/core/agents/catalog.ts';
import type { AgentDetection } from '../../../src/core/agents/detect.ts';
import { DEFAULT_SETTINGS, type Settings } from '../../../src/core/settings.ts';
import {
  AUTOMATIC_KEY,
  choiceFromKey,
  choiceKey,
  settingsChoicesView,
} from '../../../src/core/settings-view.ts';

const SHA = 'c'.repeat(64);

const CATALOG = parseBundledCatalog({
  checked: '2026-01-01',
  agents: ['alpha', 'beta'].map((id) => ({
    id,
    title: id.toUpperCase(),
    version: '9.9.9',
    license: 'MIT',
    dist: [{ arch: 'x86_64', url: 'https://example.invalid/a.tar.gz', sha256: SHA, size: 1 }],
    command: ['acp'],
    env: {},
    refreshed: '2026-01-01',
    installPath: `${BUNDLED_PREFIX}/${id}`,
    binary: id,
  })),
}).agents;

const DETECTIONS: AgentDetection[] = [
  { id: 'alpha', source: 'host', path: '/usr/bin/alpha', version: '1.2.3' },
  { id: 'beta', source: 'bundled', path: `${BUNDLED_PREFIX}/beta/beta`, version: '9.9.9' },
];

const bundledAvailable = (id: string) => id === 'beta';

function settingsFor(agent: Settings['agent']): Settings {
  return { ...DEFAULT_SETTINGS, agent };
}

function view(agent: Settings['agent'], problem: string | null = null) {
  return settingsChoicesView(DETECTIONS, CATALOG, settingsFor(agent), { bundledAvailable, problem });
}

export default async function run(): Promise<void> {
  await describe('the preferences choices view', async () => {
    await it('lists Automatic first, then each host install, then each bundled copy', async () => {
      const keys = view(null).rows.map((row) => row.key);
      expect(keys.join(',')).toBe('auto,alpha:host,beta:host,alpha:bundled,beta:bundled');
    });

    await it('selects Automatic when nothing is saved, and says what it would start', async () => {
      const { rows, note } = view(null);
      expect(
        rows
          .filter((row) => row.selected)
          .map((row) => row.key)
          .join(','),
      ).toBe('auto');
      expect(rows[0]?.subtitle.includes('Installed (ALPHA 1.2.3)')).toBe(true);
      expect(note).toBe(null);
    });

    await it('titles the bundled copy with its pinned version and the host one with its own', async () => {
      const byKey = new Map(view(null).rows.map((row) => [row.key, row]));
      expect(byKey.get('beta:bundled')?.title).toBe('Bundled (BETA 9.9.9)');
      expect(byKey.get('alpha:host')?.title).toBe('Installed (ALPHA 1.2.3)');
      expect(byKey.get('alpha:host')?.subtitle).toBe('/usr/bin/alpha');
    });

    await it('marks what is unavailable and keeps the row', async () => {
      const byKey = new Map(view(null).rows.map((row) => [row.key, row]));
      expect(byKey.get('beta:host')?.available).toBe(false);
      expect(byKey.get('beta:host')?.subtitle).toBe('Not found on this machine');
      expect(byKey.get('alpha:bundled')?.available).toBe(false);
      expect(byKey.get('alpha:bundled')?.subtitle).toBe('Not included in this install');
      expect(byKey.get('beta:bundled')?.available).toBe(true);
    });

    await it('selects the saved choice', async () => {
      const { rows, note } = view({ id: 'beta', source: 'bundled' });
      expect(
        rows
          .filter((row) => row.selected)
          .map((row) => row.key)
          .join(','),
      ).toBe('beta:bundled');
      expect(note).toBe(null);
    });

    await it('explains a saved choice that is not available, and what runs instead', async () => {
      const { rows, note } = view({ id: 'beta', source: 'host' });
      expect(rows.find((row) => row.selected)?.key).toBe('beta:host');
      expect(note?.includes('not available here')).toBe(true);
      expect(note?.includes('Installed (ALPHA 1.2.3)')).toBe(true);
    });

    await it('gives a saved id this build does not know a row of its own', async () => {
      const { rows, note } = view({ id: 'gamma', source: 'bundled' });
      const row = rows.find((entry) => entry.key === 'gamma:bundled');
      expect(row?.selected).toBe(true);
      expect(row?.available).toBe(false);
      expect(row?.subtitle).toBe('Not known to this version of kurier');
      expect(note === null).toBe(false);
    });

    await it('puts a settings-file problem in the note, ahead of anything else', async () => {
      const { note } = view(null, 'settings.json: not valid JSON — using defaults');
      expect(note).toBe('settings.json: not valid JSON — using defaults');
    });

    await it('says so when no agent exists at all', async () => {
      const result = settingsChoicesView([], [], DEFAULT_SETTINGS);
      expect(result.rows.length).toBe(1);
      expect(result.rows[0]?.subtitle.includes('no agent is available')).toBe(true);
    });

    await it('round-trips a choice through its key', async () => {
      expect(choiceKey(null)).toBe(AUTOMATIC_KEY);
      expect(choiceFromKey(AUTOMATIC_KEY)).toBe(null);
      const choice = choiceFromKey('beta:bundled');
      expect(choice === null || choice === undefined ? '' : `${choice.id}/${choice.source}`).toBe(
        'beta/bundled',
      );
      expect(choiceFromKey('beta')).toBe(undefined);
      expect(choiceFromKey('beta:elsewhere')).toBe(undefined);
    });
  });

  await describe('the preferences view while the host is checked, and when the file is locked', async () => {
    const PENDING: AgentDetection[] = [
      { id: 'alpha', source: 'none', path: null, version: null },
      { id: 'beta', source: 'bundled', path: `${BUNDLED_PREFIX}/beta/beta`, version: '9.9.9' },
    ];

    await it('pending host rows say Checking and are not available yet', async () => {
      const pending = settingsChoicesView(PENDING, CATALOG, settingsFor(null), {
        bundledAvailable,
        hostPending: true,
      });
      const row = pending.rows.find((entry) => entry.key === 'alpha:host');
      expect(row?.pending).toBe(true);
      expect(row?.available).toBe(false);
      expect(row?.subtitle).toBe('Checking…');
    });

    await it('the detected view lists the same keys in the same order as the pending one', async () => {
      const pending = settingsChoicesView(PENDING, CATALOG, settingsFor(null), {
        bundledAvailable,
        hostPending: true,
      });
      const detected = view(null);
      expect(pending.rows.map((row) => row.key).join(',')).toBe(
        detected.rows.map((row) => row.key).join(','),
      );
      const merged = detected.rows.find((row) => row.key === 'alpha:host');
      expect(merged?.pending).toBe(false);
      expect(merged?.available).toBe(true);
      expect(merged?.subtitle).toBe('/usr/bin/alpha');
    });

    await it('a saved host choice is not called unavailable while it is still being checked', async () => {
      const pending = settingsChoicesView(PENDING, CATALOG, settingsFor({ id: 'alpha', source: 'host' }), {
        bundledAvailable,
        hostPending: true,
      });
      expect(pending.note).toBe(null);
    });

    await it('a newer-version file locks the rows and the note says why', async () => {
      const locked = settingsChoicesView(DETECTIONS, CATALOG, settingsFor(null), {
        bundledAvailable,
        problem: 'settings.json: version 9 is not known — using defaults',
        problemKind: 'newer-version',
        backupPath: '/x/settings.json.bak',
      });
      expect(locked.readOnly).toBe(true);
      expect(locked.note?.includes('will not overwrite')).toBe(true);
    });

    await it('an invalid file stays editable and the note names the backup', async () => {
      const invalid = settingsChoicesView(DETECTIONS, CATALOG, settingsFor(null), {
        bundledAvailable,
        problem: 'settings.json: not valid JSON — using defaults',
        problemKind: 'invalid',
        backupPath: '/x/settings.json.bak',
      });
      expect(invalid.readOnly).toBe(false);
      expect(invalid.note?.includes('/x/settings.json.bak')).toBe(true);
      expect(view(null).readOnly).toBe(false);
    });
  });
}
