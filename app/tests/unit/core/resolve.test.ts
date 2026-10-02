/**
 * From detections to the command that starts an agent — pure, so every case hands in a synthetic machine.
 * Covers the bundled command, the default rule, the recorded-agent rule and the isolation it carries.
 */

import { describe, expect, it } from '@gjsify/unit';

import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BUNDLED_PREFIX, bundledProgram, parseBundledCatalog } from '../../../src/core/agents/catalog.ts';
import type { AgentDetection } from '../../../src/core/agents/detect.ts';
import { isolationDirs } from '../../../src/core/agents/isolation.ts';
import {
  bundledCommand,
  describeResolved,
  NO_AGENT_MESSAGE,
  resolveDefault,
  resolveDefaultWithNote,
  resolveRecorded,
  type ResolveContext,
} from '../../../src/core/agents/resolve.ts';
import { gatherAgentFacts } from '../../../src/core/agents/probe.ts';
import type { AgentCommand } from '../../../src/core/agents/stdio.ts';

const SHA = 'c'.repeat(64);
const DATA = '/synthetic/data/kurier';

const CATALOG = parseBundledCatalog({
  checked: '2026-01-01',
  agents: [
    {
      id: 'alpha',
      title: 'Alpha',
      version: '9.9.9',
      license: 'MIT',
      dist: [{ arch: 'x86_64', url: 'https://example.invalid/a.tar.gz', sha256: SHA, size: 1 }],
      command: ['acp', '--flag'],
      env: { ALPHA_FLAG: 'true', ALPHA_BLANK: '', XDG_CONFIG_HOME: '/synthetic/their/config' },
      refreshed: '2026-01-01',
      installPath: `${BUNDLED_PREFIX}/alpha`,
      binary: 'bin/alpha',
    },
  ],
}).agents;
const ALPHA = CATALOG[0]!;

const LAUNCHERS_SYNTHETIC: AgentCommand[] = [
  { id: 'alpha', title: 'Alpha (alpha acp)', program: 'alpha', args: ['acp'] },
];

function detection(
  id: string,
  source: AgentDetection['source'],
  version: string | null = null,
): AgentDetection {
  return { id, source, path: source === 'none' ? null : `/synthetic/${id}`, version };
}

function context(detections: AgentDetection[], bundled: string[] = []): ResolveContext {
  return {
    detections,
    bundledAvailable: (id) => bundled.includes(id),
    isolationFor: (id) => isolationDirs(DATA, id),
    launchers: LAUNCHERS_SYNTHETIC,
    catalog: CATALOG,
  };
}

export default async () => {
  await describe('bundledCommand', async () => {
    const command = bundledCommand(ALPHA, isolationDirs(DATA, 'alpha'));

    await it('runs the catalog program with the catalog arguments, marked bundled', async () => {
      expect(command.id).toBe('alpha');
      expect(command.program).toBe(bundledProgram(ALPHA));
      expect(command.program).toBe('/app/extra/agents/alpha/bin/alpha');
      expect(command.args).toStrictEqual(['acp', '--flag']);
      expect(command.bundled).toBe(true);
    });

    await it('carries the entry flags, blanks included', async () => {
      expect(command.env!['ALPHA_FLAG']).toBe('true');
      expect(command.env!['ALPHA_BLANK']).toBe('');
    });

    await it('points all four XDG directories under the data directory', async () => {
      const dirs = isolationDirs(DATA, 'alpha');
      expect(command.env!['XDG_CONFIG_HOME']).toBe(dirs.config);
      expect(command.env!['XDG_DATA_HOME']).toBe(dirs.data);
      expect(command.env!['XDG_STATE_HOME']).toBe(dirs.state);
      expect(command.env!['XDG_CACHE_HOME']).toBe(dirs.cache);
    });

    await it('lets no entry flag override the isolation', async () => {
      expect(command.env!['XDG_CONFIG_HOME']).toBe(`${DATA}/agents/alpha/config`);
    });

    await it('copies the argument list rather than sharing the catalog array', async () => {
      expect(command.args).not.toBe(ALPHA.command);
    });
  });

  await describe('resolveDefault', async () => {
    await it('takes the host install, as the launcher, with no isolation', async () => {
      const found = resolveDefault(context([detection('alpha', 'host', '1.0.0')]))!;
      expect(found.source).toBe('host');
      expect(found.command).toBe(LAUNCHERS_SYNTHETIC[0]);
      expect(found.command.bundled).toBe(undefined);
      expect(found.isolation).toBe(null);
      expect(found.version).toBe('1.0.0');
    });

    await it('takes the bundled copy when there is no host install', async () => {
      const found = resolveDefault(context([detection('alpha', 'bundled', '9.9.9')]))!;
      expect(found.source).toBe('bundled');
      expect(found.command.bundled).toBe(true);
      expect(found.command.program).toBe(bundledProgram(ALPHA));
      expect(found.isolation).toStrictEqual(isolationDirs(DATA, 'alpha'));
    });

    await it('is null when nothing is available', async () => {
      expect(resolveDefault(context([detection('alpha', 'none')]))).toBe(null);
      expect(resolveDefault(context([]))).toBe(null);
    });

    await it('is null for a detection whose launcher or catalog entry is missing', async () => {
      expect(resolveDefault(context([detection('ghost', 'host')]))).toBe(null);
      expect(resolveDefault(context([detection('ghost', 'bundled')]))).toBe(null);
    });
  });

  await describe('resolveDefaultWithNote (the setting)', async () => {
    await it('a host setting runs the host install, no note', async () => {
      const result = resolveDefaultWithNote(context([detection('alpha', 'host', '1.0.0')], ['alpha']), {
        id: 'alpha',
        source: 'host',
      });
      expect(result.agent!.source).toBe('host');
      expect(result.agent!.command.bundled).toBe(undefined);
      expect(result.note).toBe(null);
    });

    await it('a bundled setting runs the bundled copy even when a host install shadows it', async () => {
      const result = resolveDefaultWithNote(context([detection('alpha', 'host', '1.0.0')], ['alpha']), {
        id: 'alpha',
        source: 'bundled',
      });
      expect(result.agent!.source).toBe('bundled');
      expect(result.agent!.command.bundled).toBe(true);
      expect(result.agent!.version).toBe('9.9.9');
      expect(result.agent!.isolation).toStrictEqual(isolationDirs(DATA, 'alpha'));
      expect(result.note).toBe(null);
    });

    await it('an unavailable bundled setting falls to the host install and says so', async () => {
      const result = resolveDefaultWithNote(context([detection('alpha', 'host')]), {
        id: 'alpha',
        source: 'bundled',
      });
      expect(result.agent!.source).toBe('host');
      expect(result.note).toContain('the bundled alpha');
      expect(result.note).toContain('using alpha (host) instead');
    });

    await it('an unavailable host setting falls to the bundled copy and says so', async () => {
      const result = resolveDefaultWithNote(context([detection('alpha', 'bundled')], ['alpha']), {
        id: 'alpha',
        source: 'host',
      });
      expect(result.agent!.source).toBe('bundled');
      expect(result.note).toContain('your own alpha');
    });

    await it('with nothing available the agent is null and the note remains', async () => {
      const result = resolveDefaultWithNote(context([detection('alpha', 'none')]), {
        id: 'alpha',
        source: 'host',
      });
      expect(result.agent).toBe(null);
      expect(result.note).not.toBe(null);
    });

    await it('resolveDefault takes the setting as a second argument', async () => {
      const found = resolveDefault(context([detection('alpha', 'host')], ['alpha']), {
        id: 'alpha',
        source: 'bundled',
      });
      expect(found!.source).toBe('bundled');
    });
  });

  await describe('resolveRecorded', async () => {
    function agentOf(result: ReturnType<typeof resolveRecorded>) {
      if (!('agent' in result)) throw new Error(`expected an agent, got: ${result.problem}`);
      return result.agent;
    }
    function problemOf(result: ReturnType<typeof resolveRecorded>): string {
      if (!('problem' in result)) throw new Error('expected a problem');
      return result.problem;
    }

    await it('a bundled session gets the bundled command, isolated, not another agent', async () => {
      const found = agentOf(
        resolveRecorded(
          'alpha',
          'bundled',
          context([detection('beta', 'host'), detection('alpha', 'bundled')], ['alpha']),
        ),
      );
      expect(found.command.id).toBe('alpha');
      expect(found.source).toBe('bundled');
      expect(found.command.bundled).toBe(true);
      expect(found.isolation).toStrictEqual(isolationDirs(DATA, 'alpha'));
    });

    await it('a bundled session does not fall to a host install that appeared later', async () => {
      const found = agentOf(
        resolveRecorded('alpha', 'bundled', context([detection('alpha', 'host', '1.0.0')], ['alpha'])),
      );
      expect(found.source).toBe('bundled');
    });

    await it('a bundled session whose copy is gone is an error naming why, even with a host install', async () => {
      const problem = problemOf(
        resolveRecorded('alpha', 'bundled', context([detection('alpha', 'host')], [])),
      );
      expect(problem).toContain('bundled alpha');
      expect(problem).toContain('not in this install');
    });

    await it('a host session gets the host launcher', async () => {
      const found = agentOf(
        resolveRecorded('alpha', 'host', context([detection('alpha', 'host')], ['alpha'])),
      );
      expect(found.source).toBe('host');
      expect(found.command).toBe(LAUNCHERS_SYNTHETIC[0]);
    });

    await it('an old record without a source is a host session', async () => {
      const found = agentOf(resolveRecorded('alpha', undefined, context([detection('alpha', 'host')])));
      expect(found.source).toBe('host');
    });

    await it('an old record never falls to the bundled copy when the host install is gone', async () => {
      const problem = problemOf(
        resolveRecorded('alpha', undefined, context([detection('alpha', 'bundled')], ['alpha'])),
      );
      expect(problem).toContain('your own alpha install');
      expect(problem).toContain('separate history');
    });

    await it('is a problem for an agent this machine does not have, even if another is there', async () => {
      problemOf(
        resolveRecorded('alpha', 'host', context([detection('alpha', 'none'), detection('beta', 'host')])),
      );
      problemOf(resolveRecorded('unknown', 'bundled', context([detection('beta', 'host')], ['unknown'])));
    });
  });

  await describe('resolveDefault without a version (the window does not run --version)', async () => {
    await it('still resolves a host install and says nothing extra', async () => {
      const found = resolveDefault(context([detection('alpha', 'host', null)]))!;
      expect(found.source).toBe('host');
      expect(found.version).toBe(null);
      expect(describeResolved(found)).toBe(null);
    });

    await it('describes a bundled copy by its catalog pin', async () => {
      const found = resolveDefault(context([detection('alpha', 'bundled', '9.9.9')], ['alpha']))!;
      expect(describeResolved(found)).toContain('9.9.9');
    });
  });

  await describe('gatherAgentFacts — the version spawn is optional', async () => {
    await it('reads --version by default and never spawns it with readVersions false', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'kurier-probe-'));
      try {
        const program = join(dir, 'synthetic-agent');
        // Leaves a marker file when run, so "never spawned" is observable rather than inferred.
        writeFileSync(program, `#!/bin/sh\ntouch "${dir}/ran"\necho "synthetic 1.2.3"\n`);
        chmodSync(program, 0o755);
        const launcher: AgentCommand = { id: 'synthetic', title: 'S', program, args: [] };

        const without = gatherAgentFacts([launcher], false)[0]!;
        expect(without.hostPath).toBe(program);
        expect(without.hostVersion).toBe(null);
        expect(existsSync(join(dir, 'ran'))).toBe(false);

        const withVersion = gatherAgentFacts([launcher])[0]!;
        expect(withVersion.hostVersion).toBe('synthetic 1.2.3');
        expect(existsSync(join(dir, 'ran'))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  await describe('describeResolved', async () => {
    await it('names the bundled copy, its version and the root of its state', async () => {
      const found = resolveDefault(context([detection('alpha', 'bundled', '9.9.9')]))!;
      const line = describeResolved(found)!;
      expect(line).toContain('bundled alpha 9.9.9');
      expect(line).toContain(` ${DATA}/agents/alpha,`);
    });

    await it('says nothing for a host install', async () => {
      expect(describeResolved(resolveDefault(context([detection('alpha', 'host')]))!)).toBe(null);
    });
  });

  await describe('NO_AGENT_MESSAGE', async () => {
    await it('names how to get an agent', async () => {
      expect(NO_AGENT_MESSAGE).toContain('install');
      expect(NO_AGENT_MESSAGE).toContain('Flatpak');
    });
  });
};
