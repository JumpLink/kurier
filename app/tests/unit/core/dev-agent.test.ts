import { describe, expect, it } from '@gjsify/unit';

import { isAbsolute } from 'node:path';

import {
  DEFAULT_AGENT,
  LAUNCHERS,
  STAND_IN_AGENT_ID,
  chooseAgent,
  isolationDirs,
  launcherIds,
  standInCommand,
  standInScriptPath,
  type ResolvedAgent,
} from '@lotse/core';

export default async () => {
  await describe('dev-agent — the stand-in is not a launcher', async () => {
    await it('is absent from the table, and the table is unchanged', async () => {
      // The reason this file exists rather than one line in `launcher.ts`: `lotse agents` prints that
      // table as what a person has installed, and a dev fixture next to OpenCode with no marker that it
      // is a fixture is a lie in the one command that is about honesty.
      expect(launcherIds()).toStrictEqual(['opencode']);
      expect(LAUNCHERS.some((entry) => entry.id === STAND_IN_AGENT_ID)).toBe(false);
    });

    await it('resolves a script path inside this repository', async () => {
      // Derived from the module's own location, so a checkout works with no environment at all.
      const path = standInScriptPath({});
      expect(isAbsolute(path)).toBe(true);
      expect(path.endsWith('scripts/stand-in-agent.mjs')).toBe(true);
    });

    await it('takes an override, for a checkout that is not this one', async () => {
      expect(standInScriptPath({ LOTSE_STANDIN_AGENT: '/tmp/agent.mjs' })).toBe('/tmp/agent.mjs');
    });

    await it('ignores a blank override rather than spawning nothing', async () => {
      expect(standInScriptPath({ LOTSE_STANDIN_AGENT: '  ' }).endsWith('stand-in-agent.mjs')).toBe(true);
    });

    await it('builds a command that is a program and nothing else', async () => {
      const command = standInCommand('/tmp/agent.mjs');
      expect(Object.keys(command).sort()).toStrictEqual(['args', 'id', 'program', 'title']);
      expect(command.program).toBe('node');
      expect(command.args).toStrictEqual(['/tmp/agent.mjs']);
    });
  });

  await describe('dev-agent — choosing an agent from the hook', async () => {
    await it('uses the default launcher when no hook is set', async () => {
      expect(chooseAgent(undefined).command.id).toBe(DEFAULT_AGENT);
      expect(chooseAgent(null).note).toBe(null);
      expect(chooseAgent('  ').command.id).toBe(DEFAULT_AGENT);
    });

    await it('asks the resolver only when no hook is set, and uses what it found', async () => {
      const bundled: ResolvedAgent = {
        command: { id: 'opencode', title: 'bundled', program: '/app/extra/x', args: ['acp'], bundled: true },
        source: 'bundled',
        version: '1.0.0',
        isolation: isolationDirs('/synthetic/data', 'opencode'),
      };
      let asked = 0;
      const resolver = () => {
        asked += 1;
        return bundled;
      };
      const choice = chooseAgent(undefined, resolver);
      expect(choice.command).toBe(bundled.command);
      expect(choice.note).toContain('bundled opencode 1.0.0');
      expect(asked).toBe(1);
      expect(choice.source).toBe('bundled');
      expect(chooseAgent('opencode', resolver).command.bundled).toBe(undefined);
      expect(chooseAgent('opencode', resolver).source).toBe('host');
      expect(chooseAgent(STAND_IN_AGENT_ID, resolver).source).toBe('host');
      expect(chooseAgent(STAND_IN_AGENT_ID, resolver).command.id).toBe(STAND_IN_AGENT_ID);
      expect(asked).toBe(1);
    });

    await it('keeps the launcher when the resolver finds nothing', async () => {
      const choice = chooseAgent(undefined, () => null);
      expect(choice.command.id).toBe(DEFAULT_AGENT);
      expect(choice.command.bundled).toBe(undefined);
    });

    await it('resolves a real launcher by id', async () => {
      const choice = chooseAgent('opencode');
      expect(choice.command.id).toBe('opencode');
      expect(choice.note).toBe(null);
    });

    await it('resolves the stand-in and says where it came from', async () => {
      const choice = chooseAgent(STAND_IN_AGENT_ID);
      expect(choice.command.id).toBe(STAND_IN_AGENT_ID);
      // The note is what stops a screenshot of a fixture run from looking like a screenshot of lotse.
      expect(choice.note).toContain('scripts/stand-in-agent.mjs');
    });

    await it('falls back on a typo instead of refusing to start', async () => {
      // The hook is typed by hand into a command line. A typo should cost the typed fixture and nothing
      // else — a window that will not open at all is not a dev hook.
      const choice = chooseAgent('standinn');
      expect(choice.command.id).toBe(DEFAULT_AGENT);
      expect(choice.note).toContain('standinn');
      expect(choice.note).toContain('opencode');
    });
  });
};
