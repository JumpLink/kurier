import { describe, expect, it } from '@gjsify/unit';

import { displayCwd, resolveCwd, type CwdFacts } from '@kurier/core';

/** Synthetic paths only; `exists` answers for exactly the ones a case lists. */
function facts(existing: string[], over: Partial<CwdFacts> = {}): CwdFacts {
  return {
    sandboxed: false,
    processCwd: '/synthetic/proc',
    hostCwd: '/synthetic/host',
    home: '/synthetic/home',
    exists: (path) => existing.includes(path),
    ...over,
  };
}

export default async () => {
  await describe('cwd — where a new conversation runs', async () => {
    await it('prefers KURIER_CWD over everything', async () => {
      const all = ['/synthetic/pinned', '/synthetic/proc', '/synthetic/home'];
      expect(resolveCwd({ KURIER_CWD: '/synthetic/pinned' }, facts(all))).toBe('/synthetic/pinned');
    });

    await it('uses the process cwd outside a Flatpak, and never asks the host', async () => {
      const all = ['/synthetic/proc', '/synthetic/host', '/synthetic/home'];
      expect(resolveCwd({}, facts(all))).toBe('/synthetic/proc');
    });

    await it('uses the host cwd inside a Flatpak, where the process cwd is the sandbox’s own', async () => {
      const all = ['/synthetic/proc', '/synthetic/host', '/synthetic/home'];
      expect(resolveCwd({}, facts(all, { sandboxed: true }))).toBe('/synthetic/host');
    });

    await it('falls through a candidate that does not exist', async () => {
      expect(resolveCwd({ KURIER_CWD: '/synthetic/gone' }, facts(['/synthetic/proc']))).toBe(
        '/synthetic/proc',
      );
      expect(resolveCwd({}, facts(['/synthetic/home']))).toBe('/synthetic/home');
    });

    await it('falls through an unanswered host probe to home', async () => {
      const sandboxed = facts(['/synthetic/home', '/synthetic/proc'], { sandboxed: true, hostCwd: null });
      expect(resolveCwd({}, sandboxed)).toBe('/synthetic/home');
    });

    await it('refuses a relative path, blank or not, because a session’s cwd is part of its scope', async () => {
      const all = ['relative', '/synthetic/proc'];
      expect(resolveCwd({ KURIER_CWD: 'relative' }, facts(all))).toBe('/synthetic/proc');
      expect(resolveCwd({ KURIER_CWD: '   ' }, facts(all))).toBe('/synthetic/proc');
    });

    await it('says so with null when nothing exists, rather than inventing a directory', async () => {
      expect(resolveCwd({}, facts([], { home: null }))).toBe(null);
    });
  });

  await describe('cwd — as a person reads it', async () => {
    await it('abbreviates home', async () => {
      expect(displayCwd('/synthetic/home/project', '/synthetic/home')).toBe('~/project');
      expect(displayCwd('/synthetic/home', '/synthetic/home')).toBe('~');
    });

    await it('checks the path boundary, not the prefix', async () => {
      expect(displayCwd('/synthetic/home2/project', '/synthetic/home')).toBe('/synthetic/home2/project');
    });

    await it('leaves a path outside home, and a missing or root home, alone', async () => {
      expect(displayCwd('/tmp/project', '/synthetic/home')).toBe('/tmp/project');
      expect(displayCwd('/tmp/project', null)).toBe('/tmp/project');
      expect(displayCwd('/tmp/project', '/')).toBe('/tmp/project');
    });
  });
};
