import { describe, expect, it } from '@gjsify/unit';

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { which } from '../../../src/core/agents/stdio.ts';
import {
  DEFAULT_AGENT,
  LAUNCHERS,
  findLauncher,
  launcherIds,
  requireLauncher,
} from '../../../src/core/agents/launcher.ts';
import type { SandboxFacts } from '../../../src/core/agents/sandbox.ts';

const SANDBOXED: SandboxFacts = { flatpakInfoExists: true };
const NOT_SANDBOXED: SandboxFacts = { flatpakInfoExists: false };

async function withTempDir(run: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'kurier-agents-'));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export default async () => {
  await describe('which — PATH walking', async () => {
    await it('finds an executable file on PATH', async () => {
      if (process.platform === 'win32') return;
      await withTempDir(async (dir) => {
        const exe = join(dir, 'prog');
        writeFileSync(exe, '#!/bin/sh\n');
        chmodSync(exe, 0o755);
        expect(which('prog', { PATH: dir })).toBe(exe);
      });
    });

    await it('does not return a non-executable file with the same name', async () => {
      if (process.platform === 'win32') return;
      await withTempDir(async (dir) => {
        const notExe = join(dir, 'prog');
        writeFileSync(notExe, '');
        chmodSync(notExe, 0o644);
        expect(which('prog', { PATH: dir })).toBe(null);
      });
    });

    await it('honors a Windows-style ; separated PATH', async () => {
      // KURIER_TEST_ASSUME_EXECUTABLE decouples PATH-splitting from the executable-bit check, so
      // this test exercises the ";" split on every platform, including GJS, without depending on
      // chmod semantics.
      await withTempDir(async (dir) => {
        writeFileSync(join(dir, 'prog'), '');
        const env = { PATH: `/nonexistent-dir;${dir}`, KURIER_TEST_ASSUME_EXECUTABLE: '1' };
        expect(which('prog', env)).toBe(join(dir, 'prog'));
      });
    });

    await it('returns null for a program that is not on PATH', async () => {
      await withTempDir(async (dir) => {
        expect(which('no-such-program-anywhere', { PATH: dir }, NOT_SANDBOXED)).toBe(null);
      });
    });

    // ─── the three answers, in order (see `sandbox.ts` and sandbox.test.ts) ───

    await it('answers from the local PATH even when sandboxed, without asking the host', async () => {
      // A flatpak-spawn probe on a machine without flatpak-spawn would answer null, so a local hit
      // that still returns the path is the observable proof the host was never consulted.
      if (process.platform === 'win32') return;
      await withTempDir(async (dir) => {
        const exe = join(dir, 'prog');
        writeFileSync(exe, '#!/bin/sh\n');
        chmodSync(exe, 0o755);
        expect(which('prog', { PATH: dir }, SANDBOXED)).toBe(exe);
      });
    });

    await it('never asks the host about a program named by path', async () => {
      // A path is the person's own answer, so the sandbox PATH is the only thing consulted — a
      // host probe would silently answer about a different machine.
      if (process.platform === 'win32') return;
      await withTempDir(async (dir) => {
        const exe = join(dir, 'prog');
        writeFileSync(exe, '#!/bin/sh\n');
        chmodSync(exe, 0o755);
        expect(which(exe, { PATH: '/nonexistent' }, SANDBOXED)).toBe(exe);
      });
    });

    await it('falls through to the host only when sandboxed, and a failed probe is null', async () => {
      // The host branch needs a real flatpak-spawn, so what is asserted here is the contract that
      // matters and is portable: a probe that cannot answer yields null rather than a throw or a
      // half-truth. The working case is proven end to end against the real host in the Flatpak.
      await withTempDir(async (dir) => {
        expect(which('no-such-program-anywhere', { PATH: dir }, SANDBOXED)).toBe(null);
      });
    });
  });

  await describe('launcher table', async () => {
    await it('findLauncher finds the opencode launcher and nothing for an unknown id', async () => {
      expect(findLauncher('opencode')?.program).toBe('opencode');
      expect(findLauncher('does-not-exist')).toBe(undefined);
    });

    await it('requireLauncher throws with the list of valid ids', async () => {
      expect(() => requireLauncher('does-not-exist')).toThrow(/opencode/);
    });

    await it('requireLauncher returns the launcher for a known id', async () => {
      expect(requireLauncher('opencode').id).toBe('opencode');
    });

    await it('launcherIds lists every launcher', async () => {
      expect(launcherIds()).toStrictEqual(['opencode']);
    });

    await it('DEFAULT_AGENT is a real launcher id', async () => {
      expect(findLauncher(DEFAULT_AGENT)).toBeTruthy();
    });

    await it('every LAUNCHERS entry is exactly {id, title, program, args} — a table of programs, not capabilities', async () => {
      for (const entry of LAUNCHERS) {
        expect(Object.keys(entry).sort()).toStrictEqual(['args', 'id', 'program', 'title']);
      }
    });
  });
};
