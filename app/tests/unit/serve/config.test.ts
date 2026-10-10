import { describe, expect, it } from '@gjsify/unit';

import {
  DEFAULT_QUESTION_LIMITS,
  ServeConfigError,
  configHash,
  isFreeModel,
  parseServeConfig,
} from '@lotse/core';

import example from '../../../../examples/tasks.example.json' with { type: 'json' };

const VALID = {
  version: 1,
  users: [{ id: 'me' }],
  profiles: [{ id: 'work', user: 'me', data: 'private', model: 'provider/paid-model' }],
  tasks: [
    { id: 'inbox', profile: 'work', schedule: { every: '1h' }, prompt: 'Look at the inbox.', cwd: '/tmp' },
  ],
};

function problems(value: unknown): readonly string[] {
  try {
    parseServeConfig(JSON.stringify(value));
  } catch (error) {
    if (error instanceof ServeConfigError) return error.problems;
    throw error;
  }
  return [];
}

export default async () => {
  await describe('parseServeConfig', async () => {
    await it('reads a minimal file and fills the defaults', async () => {
      const config = parseServeConfig(JSON.stringify(VALID));
      const task = config.tasks[0]!;
      expect(task.rights).toBe('confirm');
      expect(task.notify).toBe('questions');
      expect(task.questions).toStrictEqual(DEFAULT_QUESTION_LIMITS);
      expect(task.mcpServers.length).toBe(0);
      expect(config.users[0]!.addresses.length).toBe(0);
    });

    await it('reads the shipped example', async () => {
      const config = parseServeConfig(JSON.stringify(example));
      expect(config.tasks.map((task) => task.id)).toStrictEqual([
        'morning-summary',
        'watch-something-public',
      ]);
      expect(config.tasks[0]!.mcpServers.length).toBe(1);
    });

    await it('reads question limits', async () => {
      const config = parseServeConfig(
        JSON.stringify({
          ...VALID,
          tasks: [{ ...VALID.tasks[0], questions: { expiresIn: '30m', maxOpen: 1, maxPerHour: 2 } }],
        }),
      );
      expect(config.tasks[0]!.questions).toStrictEqual({ expiresMs: 1_800_000, maxOpen: 1, maxPerHour: 2 });
    });

    await it('lists every problem at once', async () => {
      const found = problems({
        version: 2,
        extra: true,
        users: [{ id: 'me' }],
        profiles: [{ id: 'p', user: 'nobody', data: 'public' }],
        tasks: [{ id: 't', profile: 'missing', schedule: { every: '10s' }, cwd: 'relative' }],
      });
      expect(found.some((line) => line.includes('"version"'))).toBe(true);
      expect(found.some((line) => line.includes('unknown key "extra"'))).toBe(true);
      expect(found.some((line) => line.includes('user "nobody"'))).toBe(true);
      expect(found.some((line) => line.includes('profile "missing"'))).toBe(true);
      expect(found.some((line) => line.includes('schedule'))).toBe(true);
      expect(found.some((line) => line.includes('"prompt" and "promptFile"'))).toBe(true);
      expect(found.some((line) => line.includes('cwd'))).toBe(true);
    });

    await it('a private profile must name a model that is not free', async () => {
      const unnamed = { ...VALID, profiles: [{ id: 'work', user: 'me', data: 'private' }] };
      expect(problems(unnamed).some((line) => line.includes('must name its model'))).toBe(true);
      const free = {
        ...VALID,
        profiles: [{ id: 'work', user: 'me', data: 'private', model: 'zen/some-free' }],
      };
      expect(problems(free).some((line) => line.includes('free model'))).toBe(true);
    });

    await it('a profile must say whether its data is private', async () => {
      const silent = { ...VALID, profiles: [{ id: 'work', user: 'me', model: 'provider/paid-model' }] };
      expect(problems(silent).some((line) => line.includes('there is no default'))).toBe(true);
    });

    await it('released areas need the released rights, and the other way round', async () => {
      const without = { ...VALID, tasks: [{ ...VALID.tasks[0], rights: 'released' }] };
      expect(problems(without).some((line) => line.includes('releases nothing'))).toBe(true);
      const stray = { ...VALID, tasks: [{ ...VALID.tasks[0], released: [{ tool: 'read' }] }] };
      expect(problems(stray).some((line) => line.includes('its rights are "confirm"'))).toBe(true);
    });

    await it('refuses text that is not JSON', async () => {
      expect(() => parseServeConfig('{')).toThrow();
    });
  });

  await describe('isFreeModel', async () => {
    await it('catches the -free suffix', async () => {
      expect(isFreeModel('anything/model-free')).toBe(true);
      expect(isFreeModel('provider/paid-model')).toBe(false);
    });
  });

  await describe('configHash', async () => {
    await it('changes with any text and with where the texts split', async () => {
      expect(configHash(['a', 'b'])).toBe(configHash(['a', 'b']));
      expect(configHash(['a', 'b'])).not.toBe(configHash(['a', 'c']));
      expect(configHash(['ab', ''])).not.toBe(configHash(['a', 'b']));
    });
  });
};
