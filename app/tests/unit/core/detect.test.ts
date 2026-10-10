/**
 * Agent detection and the default rule — pure over facts, so every case hands in facts and reads an
 * answer. No file, no process; the part that gathers facts is not tested here because it is the part
 * that touches the machine.
 */

import { describe, expect, it } from '@gjsify/unit';

import {
  BUNDLED_PREFIX,
  detectAgents,
  parseBundledCatalog,
  parseVersionOutput,
  resolveAgent,
  type AgentDetection,
  type AgentFacts,
} from '@lotse/core';

const SHA = 'b'.repeat(64);

const CATALOG = parseBundledCatalog({
  checked: '2026-01-01',
  agents: ['alpha', 'beta'].map((id) => ({
    id,
    title: id,
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

function facts(over: Partial<AgentFacts> & { id: string }): AgentFacts {
  return { hostPath: null, hostVersion: null, bundledExists: false, ...over };
}

function detection(id: string, source: AgentDetection['source']): AgentDetection {
  return { id, source, path: source === 'none' ? null : `/synthetic/${id}`, version: null };
}

export default async () => {
  await describe('parseVersionOutput', async () => {
    await it('takes the first non-empty line, trimmed', async () => {
      expect(parseVersionOutput('opencode v1.2.3\n')).toBe('opencode v1.2.3');
      expect(parseVersionOutput('\n  \r\n  1.2.3  \r\nsecond line\n')).toBe('1.2.3');
    });

    await it('is null for empty or blank output', async () => {
      expect(parseVersionOutput('')).toBe(null);
      expect(parseVersionOutput(' \n\t\n')).toBe(null);
    });
  });

  await describe('detectAgents', async () => {
    await it('reports a host binary with its version', async () => {
      const [found] = detectAgents(
        [facts({ id: 'alpha', hostPath: '/usr/bin/alpha', hostVersion: '1.2.3' })],
        CATALOG,
      );
      expect(found).toStrictEqual({ id: 'alpha', source: 'host', path: '/usr/bin/alpha', version: '1.2.3' });
    });

    await it('keeps a host agent whose --version failed, with version null', async () => {
      const [found] = detectAgents([facts({ id: 'alpha', hostPath: '/usr/bin/alpha' })], CATALOG);
      expect(found!.source).toBe('host');
      expect(found!.version).toBe(null);
    });

    await it('reports the bundled copy, at its prefix path, with the catalog version', async () => {
      const [found] = detectAgents([facts({ id: 'alpha', bundledExists: true })], CATALOG);
      expect(found).toStrictEqual({
        id: 'alpha',
        source: 'bundled',
        path: `${BUNDLED_PREFIX}/alpha/alpha`,
        version: '9.9.9',
      });
    });

    await it('prefers the host over the bundled copy', async () => {
      const [found] = detectAgents(
        [facts({ id: 'alpha', hostPath: '/usr/bin/alpha', bundledExists: true })],
        CATALOG,
      );
      expect(found!.source).toBe('host');
      expect(found!.path).toBe('/usr/bin/alpha');
    });

    await it('is none when nothing was found, even if the catalog names the id', async () => {
      const [found] = detectAgents([facts({ id: 'alpha' })], CATALOG);
      expect(found).toStrictEqual({ id: 'alpha', source: 'none', path: null, version: null });
    });

    await it('is none when the bundled file is there but the catalog does not know the id', async () => {
      const [found] = detectAgents([facts({ id: 'gamma', bundledExists: true })], CATALOG);
      expect(found!.source).toBe('none');
    });

    await it('ignores a host path under the bundled prefix and falls back to the bundled copy', async () => {
      const shadow = `${BUNDLED_PREFIX}/alpha/alpha`;
      const [found] = detectAgents(
        [facts({ id: 'alpha', hostPath: shadow, hostVersion: '0.0.1', bundledExists: true })],
        CATALOG,
      );
      expect(found!.source).toBe('bundled');
      expect(found!.version).toBe('9.9.9');
    });

    await it('is none for a host path under the prefix when no bundled copy exists', async () => {
      const [found] = detectAgents(
        [facts({ id: 'alpha', hostPath: `${BUNDLED_PREFIX}/alpha/alpha`, hostVersion: '1' })],
        CATALOG,
      );
      expect(found).toStrictEqual({ id: 'alpha', source: 'none', path: null, version: null });
    });

    await it('does not treat a sibling directory with the prefix as a prefix', async () => {
      const [found] = detectAgents([facts({ id: 'alpha', hostPath: `${BUNDLED_PREFIX}-x/alpha` })], CATALOG);
      expect(found!.source).toBe('host');
    });

    await it('answers per fact, in the order given', async () => {
      const found = detectAgents(
        [facts({ id: 'beta' }), facts({ id: 'alpha', hostPath: '/usr/bin/alpha' })],
        CATALOG,
      );
      expect(found.map((entry) => `${entry.id}:${entry.source}`).join(',')).toBe('beta:none,alpha:host');
    });
  });

  await describe('resolveAgent', async () => {
    const host = (id: string) => ({ id, source: 'host' as const });
    const bundled = (id: string) => ({ id, source: 'bundled' as const });
    const pick = (input: Parameters<typeof resolveAgent>[0]) => resolveAgent({ catalog: CATALOG, ...input });

    await it('takes a host setting when that agent is on the host', async () => {
      const detections = [detection('alpha', 'bundled'), detection('beta', 'host')];
      const found = pick({ setting: host('beta'), detections });
      expect(found.detection!.id).toBe('beta');
      expect(found.detection!.source).toBe('host');
      expect(found.note).toBe(null);
    });

    await it('takes a bundled setting when the bundled copy exists', async () => {
      const detections = [detection('alpha', 'bundled'), detection('beta', 'host')];
      const found = pick({ setting: bundled('alpha'), detections });
      expect(found.detection!.id).toBe('alpha');
      expect(found.detection!.source).toBe('bundled');
      expect(found.note).toBe(null);
    });

    await it('keeps "my beta" and "bundled beta" distinct when both exist', async () => {
      const detections = [detection('beta', 'host')];
      const bundledAvailable = (id: string) => id === 'beta';
      expect(pick({ setting: host('beta'), detections, bundledAvailable }).detection!.source).toBe('host');
      const found = pick({ setting: bundled('beta'), detections, bundledAvailable });
      expect(found.detection!.source).toBe('bundled');
      expect(found.detection!.version).toBe('9.9.9');
      expect(found.note).toBe(null);
    });

    await it('reports a host setting that is not on the host, and falls to the first host', async () => {
      const detections = [detection('alpha', 'bundled'), detection('beta', 'host')];
      const found = pick({ setting: host('alpha'), detections });
      expect(found.detection!.id).toBe('beta');
      expect(found.note).toContain('your own alpha');
      expect(found.note).toContain('using beta (host) instead');
    });

    await it('a host setting is not satisfied by a bundled copy of the same id', async () => {
      const found = pick({ setting: host('alpha'), detections: [detection('alpha', 'bundled')] });
      expect(found.detection!.source).toBe('bundled');
      expect(found.note).toContain('your own alpha');
    });

    await it('reports a bundled setting that is not shipped, and falls to the first host', async () => {
      const detections = [detection('alpha', 'host'), detection('beta', 'none')];
      const found = pick({ setting: bundled('beta'), detections });
      expect(found.detection!.id).toBe('alpha');
      expect(found.note).toContain('the bundled beta');
    });

    await it('reports a setting that names an id nobody knows', async () => {
      const found = pick({ setting: host('gamma'), detections: [detection('beta', 'host')] });
      expect(found.detection!.id).toBe('beta');
      expect(found.note).toContain('your own gamma');
    });

    await it('takes the first host when there is no setting, with no note', async () => {
      const detections = [detection('alpha', 'bundled'), detection('beta', 'host')];
      const found = pick({ setting: null, detections });
      expect(found.detection!.id).toBe('beta');
      expect(found.note).toBe(null);
    });

    await it('takes the first bundled when there is no host', async () => {
      const detections = [detection('alpha', 'none'), detection('beta', 'bundled')];
      expect(pick({ setting: null, detections }).detection!.id).toBe('beta');
    });

    await it('is null when nothing is available, and says so about an unavailable setting', async () => {
      const found = pick({ setting: host('alpha'), detections: [detection('alpha', 'none')] });
      expect(found.detection).toBe(null);
      expect(found.note).toContain('no other agent is available');
      expect(pick({ setting: null, detections: [] })).toStrictEqual({ detection: null, note: null });
    });
  });
};
