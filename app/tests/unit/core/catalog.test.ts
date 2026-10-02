/**
 * The bundled-agent catalog: what the validator refuses, and that the file kurier ships passes it.
 *
 * Every rejection case starts from one valid object and breaks exactly one thing, so a failure names the
 * rule rather than a fixture. Synthetic values only — the shipped file is the one real input, and it is
 * checked for shape, not for content.
 */

import { describe, expect, it } from '@gjsify/unit';

import {
  BUNDLED_AGENTS,
  BUNDLED_PREFIX,
  bundledProgram,
  parseBundledCatalog,
} from '../../../src/core/agents/catalog.ts';

const SHA = 'a'.repeat(64);

/** A fresh valid catalog each call, so a case can mutate it freely. */
function valid(): Record<string, any> {
  return {
    checked: '2026-01-01',
    agents: [
      {
        id: 'demo',
        title: 'Demo',
        version: '1.0.0',
        license: 'MIT',
        dist: [{ arch: 'x86_64', url: 'https://example.invalid/demo.tar.gz', sha256: SHA, size: 10 }],
        command: ['acp'],
        env: { DEMO_FLAG: 'true' },
        refreshed: '2026-01-01',
        installPath: `${BUNDLED_PREFIX}/demo`,
      },
    ],
  };
}

function rejects(mutate: (catalog: Record<string, any>) => void, pattern: RegExp): void {
  const catalog = valid();
  mutate(catalog);
  expect(() => parseBundledCatalog(catalog)).toThrow(pattern);
}

export default async () => {
  await describe('parseBundledCatalog', async () => {
    await it('accepts a valid catalog and returns typed entries', async () => {
      const parsed = parseBundledCatalog(valid());
      expect(parsed.agents.length).toBe(1);
      expect(parsed.agents[0]!.id).toBe('demo');
      expect(parsed.agents[0]!.dist[0]!.arch).toBe('x86_64');
      expect(parsed.agents[0]!.env['DEMO_FLAG']).toBe('true');
    });

    await it('accepts an empty env and an aarch64 dist', async () => {
      const catalog = valid();
      catalog['agents'][0].env = {};
      catalog['agents'][0].dist[0].arch = 'aarch64';
      expect(parseBundledCatalog(catalog).agents[0]!.dist[0]!.arch).toBe('aarch64');
    });

    await it('rejects a non-object root', async () => {
      expect(() => parseBundledCatalog(null)).toThrow(/object/);
      expect(() => parseBundledCatalog([])).toThrow(/object/);
    });

    await it('rejects an unknown top-level field', async () => {
      rejects((c) => (c['extra'] = 1), /unknown field "extra"/);
    });

    await it('rejects an unknown entry field', async () => {
      rejects((c) => (c['agents'][0].extra = 1), /unknown field "extra"/);
    });

    await it('rejects a missing entry field', async () => {
      rejects((c) => delete c['agents'][0].license, /license/);
    });

    await it('rejects an uppercase sha256', async () => {
      rejects((c) => (c['agents'][0].dist[0].sha256 = 'A'.repeat(64)), /sha256/);
    });

    await it('rejects a sha256 of the wrong length', async () => {
      rejects((c) => (c['agents'][0].dist[0].sha256 = 'a'.repeat(63)), /sha256/);
    });

    await it('rejects an unsupported arch', async () => {
      rejects((c) => (c['agents'][0].dist[0].arch = 'riscv64'), /arch/);
    });

    await it('rejects a zero, negative, fractional or non-number size', async () => {
      for (const size of [0, -1, 1.5, '10']) {
        rejects((c) => (c['agents'][0].dist[0].size = size), /size/);
      }
    });

    await it('rejects a url that is not https', async () => {
      rejects((c) => (c['agents'][0].dist[0].url = 'http://example.invalid/a.tar.gz'), /https/);
      rejects((c) => (c['agents'][0].dist[0].url = 'not a url'), /https/);
    });

    await it('rejects an empty command and an empty command word', async () => {
      rejects((c) => (c['agents'][0].command = []), /command/);
      rejects((c) => (c['agents'][0].command = ['']), /command/);
    });

    await it('rejects a non-string env value', async () => {
      rejects((c) => (c['agents'][0].env['DEMO_FLAG'] = true), /DEMO_FLAG/);
    });

    await it('rejects an empty dist and a repeated arch', async () => {
      rejects((c) => (c['agents'][0].dist = []), /dist/);
      rejects((c) => c['agents'][0].dist.push({ ...c['agents'][0].dist[0] }), /twice/);
    });

    await it('rejects a repeated agent id', async () => {
      rejects((c) => c['agents'].push({ ...c['agents'][0] }), /twice/);
    });

    await it('rejects an installPath outside the prefix or not named by the id', async () => {
      rejects((c) => (c['agents'][0].installPath = '/usr/bin/demo'), /installPath/);
      rejects((c) => (c['agents'][0].installPath = `${BUNDLED_PREFIX}/other`), /installPath/);
    });
  });

  await describe('the shipped catalog', async () => {
    await it('passed the validator at load and names at least one agent', async () => {
      expect(BUNDLED_AGENTS.length > 0).toBe(true);
    });

    await it('keeps opencode with both architectures', async () => {
      const entry = BUNDLED_AGENTS.find((agent) => agent.id === 'opencode');
      expect(entry !== undefined).toBe(true);
      expect(entry!.dist.map((dist) => dist.arch).join(',')).toBe('x86_64,aarch64');
      expect(entry!.env['OPENCODE_DISABLE_AUTOUPDATE']).toBe('true');
    });
  });

  await describe('bundledProgram', async () => {
    await it("is the binary named by the id, inside the entry's directory under the prefix", async () => {
      const entry = parseBundledCatalog(valid()).agents[0]!;
      expect(bundledProgram(entry)).toBe(`${BUNDLED_PREFIX}/demo/demo`);
    });

    await it('is never on a PATH directory', async () => {
      const entry = parseBundledCatalog(valid()).agents[0]!;
      expect(bundledProgram(entry).startsWith('/app/bin/')).toBe(false);
    });
  });
};
