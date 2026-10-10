/**
 * What the agent offers, turned into something drawable — and what is *dropped* on the way.
 *
 * The projection is the one place the surface's honesty is decided, so it is tested without GTK on
 * purpose: every case here is a case where a wrong answer is a control that lies. A dropdown
 * showing one model and writing another, an empty dropdown nobody can use, a duplicate of an option
 * that cannot be set — all of them compile, all of them run, and all of them are the failure.
 *
 * The measured input is `opencode acp` 2.0.19, whose `session/new` carries ~400 models, 6 thought
 * levels and 2 modes. The sizes are in the tests rather than implied, because "searchable" is a
 * claim about 400 and a rule that silently stops applying at 400 is a rule nobody notices breaking.
 */

import { describe, expect, it } from '@gjsify/unit';

import {
  configValue,
  currentLabel,
  findControl,
  projectConfigOptions,
  type ConfigControl,
} from '@lotse/core';
import type { SessionConfigOption } from '@lotse/acp/types';

import { buildManyModelOptions, opencodeConfigOptions } from '../../support/fixture-agent.ts';

function ids(controls: ConfigControl[]): string[] {
  return controls.map((control) => control.id);
}

export default async () => {
  await describe('projectConfigOptions — what opencode acp 2.0.19 actually reports', async () => {
    await it('turns the three measured options into three controls', async () => {
      const controls = projectConfigOptions(opencodeConfigOptions());
      expect(ids(controls)).toEqualArray(['model', 'effort', 'mode']);
      expect(controls.every((control) => control.kind === 'select')).toBe(true);
    });

    await it('orders by category, not by arrival: model, thought_level, mode', async () => {
      // The measured answer arrives in that order too, so this test would pass by accident. Shuffle
      // it — the order is a rule, and a rule that only holds for one input is not a rule.
      const shuffled = [...opencodeConfigOptions()].reverse();
      expect(ids(projectConfigOptions(shuffled))).toEqualArray(['model', 'effort', 'mode']);
    });

    await it('keeps the agent’s own order inside one category', async () => {
      // An agent that puts its recommended model first knows something about its user.
      const options = opencodeConfigOptions();
      const model = options[0] as SessionConfigOption;
      const reordered = [
        { ...model, options: [model.options![2], model.options![0], model.options![1]] },
        ...options.slice(1),
      ];
      const control = findControl(projectConfigOptions(reordered), 'model');
      expect(control?.kind).toBe('select');
      const values = control?.kind === 'select' ? control.values.map((value) => value.value) : [];
      expect(values[0]).toBe('github-copilot/gpt-5.5-codex');
    });

    await it('marks a 400-entry model list searchable and a 6-entry effort list not', async () => {
      const many = projectConfigOptions(buildManyModelOptions(400));
      const model = findControl(many, 'model');
      expect(model?.kind === 'select' ? model.searchable : false).toBe(true);
      expect(model?.kind === 'select' ? model.values.length : 0).toBe(400);

      const few = projectConfigOptions(opencodeConfigOptions());
      const effort = findControl(few, 'effort');
      expect(effort?.kind === 'select' ? effort.searchable : true).toBe(false);
    });

    await it('keeps the mode value’s description — it is the only per-value text ACP has', async () => {
      const control = findControl(projectConfigOptions(opencodeConfigOptions()), 'mode');
      const plan =
        control?.kind === 'select' ? control.values.find((value) => value.value === 'plan') : undefined;
      expect(plan?.description).toBe('Propose before changing');
    });
  });

  await describe('projectConfigOptions — nothing reported means nothing drawn', async () => {
    await it('an empty array yields no controls at all', async () => {
      // Not an empty row, and not a disabled one. `opencode` with no providers configured is a real
      // state, and the surface has to look like there is nothing to choose rather than like the
      // choice is broken.
      expect(projectConfigOptions([])).toStrictEqual([]);
    });

    await it('null and undefined yield no controls', async () => {
      expect(projectConfigOptions(null)).toStrictEqual([]);
      expect(projectConfigOptions(undefined)).toStrictEqual([]);
    });
  });

  await describe('projectConfigOptions — an unknown category is drawn, not dropped', async () => {
    await it('sorts an unrecognised category last and keeps its own name', async () => {
      // The schema says a category "MUST NOT be required for correctness" and that clients "MUST
      // handle missing or unknown categories gracefully". Dropping it would make an agent's own
      // setting unreachable; guessing a widget for it would be inventing capability.
      const controls = projectConfigOptions([
        {
          id: 'temperature',
          name: 'Temperature',
          type: 'select',
          category: 'sampling',
          currentValue: '0.7',
          options: [{ value: '0.7', name: '0.7' }],
        },
        {
          id: 'mode',
          name: 'Session Mode',
          type: 'select',
          category: 'mode',
          currentValue: 'build',
          options: [{ value: 'build', name: 'Build' }],
        },
      ]);
      expect(ids(controls)).toEqualArray(['mode', 'temperature']);
      expect(controls[1]?.name).toBe('Temperature');
    });

    await it('a missing category is treated as unknown, not as an error', async () => {
      const controls = projectConfigOptions([
        {
          id: 'thing',
          name: 'Thing',
          type: 'select',
          currentValue: 'a',
          options: [{ value: 'a', name: 'A' }],
        },
      ]);
      expect(ids(controls)).toEqualArray(['thing']);
      expect(controls[0]?.category).toBe(null);
    });
  });

  await describe('projectConfigOptions — a boolean option becomes a switch', async () => {
    await it('reads currentValue as a boolean', async () => {
      const controls = projectConfigOptions([
        { id: 'web', name: 'Web search', type: 'boolean', category: 'model_config', currentValue: true },
      ]);
      expect(controls.length).toBe(1);
      expect(controls[0]?.kind).toBe('switch');
      expect(controls[0]?.kind === 'switch' ? controls[0].currentValue : false).toBe(true);
    });

    await it('a boolean with a non-boolean currentValue is skipped', async () => {
      // The schema requires a boolean here. An agent that sends a string has a different `type` in
      // mind, and a switch showing "on" for the text "yes" is a control that lies.
      expect(
        projectConfigOptions([{ id: 'web', name: 'Web', type: 'boolean', currentValue: 'yes' }]),
      ).toStrictEqual([]);
    });
  });

  await describe('projectConfigOptions — what gets skipped, and never guessed', async () => {
    await it('a type that is neither select nor boolean', async () => {
      // ACP v1 has exactly two arms today. A later version may add a third, and rendering a
      // plausible control for a payload whose shape is unknown is how a surface ends up sending a
      // value the agent never asked for.
      expect(
        projectConfigOptions([{ id: 'x', name: 'X', type: 'slider', currentValue: 3, min: 0, max: 5 }]),
      ).toStrictEqual([]);
    });

    await it('a slider that happens to carry a select-shaped payload is still refused', async () => {
      // The dangerous version of the case above, and the one that proved the suite was not testing
      // the guard: an unknown `type` whose payload looks *exactly* like a `select`, so nothing but
      // the `type` distinguishes it. The `type` is checked in **two** places — `projectOne` and
      // `narrowConfigSelect` — which is why removing either one alone leaves this green; removing
      // both is the mutation that fails it, and all three were tried. Two guards for one property is
      // deliberate: they are in different layers, and one of the two is about presentation and one
      // about the protocol.
      expect(
        projectConfigOptions([
          {
            id: 'temp',
            name: 'Temperature',
            type: 'slider',
            category: 'model_config',
            currentValue: '0.7',
            options: [{ value: '0.7', name: '0.7' }],
          },
        ]),
      ).toStrictEqual([]);
    });

    await it('a select with no options', async () => {
      expect(
        projectConfigOptions([{ id: 'model', name: 'Model', type: 'select', currentValue: 'a' }]),
      ).toStrictEqual([]);
    });

    await it('a select whose values are all unusable', async () => {
      expect(
        projectConfigOptions([
          {
            id: 'model',
            name: 'Model',
            type: 'select',
            currentValue: 'a',
            options: [{ name: 'no value' } as never],
          },
        ]),
      ).toStrictEqual([]);
    });

    await it('a select that offers only a value it did not select — nothing usable to draw', async () => {
      // The two guards interact, and this is the case where only the second one catches it: there
      // IS a value, so "no values at all" passes, and the `currentValue` is not it, so a dropdown
      // here would open on a model the agent is not using. Both mutations were verified against
      // this suite: removing either guard alone leaves it green.
      expect(
        projectConfigOptions([
          {
            id: 'model',
            name: 'Model',
            type: 'select',
            currentValue: 'not/offered',
            options: [{ value: 'a/b', name: 'b' }],
          },
        ]),
      ).toStrictEqual([]);
    });

    await it('a select with an empty options array', async () => {
      expect(
        projectConfigOptions([
          { id: 'model', name: 'Model', type: 'select', currentValue: 'a', options: [] },
        ]),
      ).toStrictEqual([]);
    });

    await it('a select whose currentValue is not one of its own values', async () => {
      // The worst case, because it compiles, runs, and displays a model that is not in use.
      expect(
        projectConfigOptions([
          {
            id: 'model',
            name: 'Model',
            type: 'select',
            currentValue: 'some/other-model',
            options: [{ value: 'a/b', name: 'b' }],
          },
        ]),
      ).toStrictEqual([]);
    });

    await it('a second option with an id already seen — the duplicate is unreachable', async () => {
      const controls = projectConfigOptions([
        {
          id: 'model',
          name: 'First',
          type: 'select',
          currentValue: 'a',
          options: [{ value: 'a', name: 'A' }],
        },
        {
          id: 'model',
          name: 'Second',
          type: 'select',
          currentValue: 'b',
          options: [{ value: 'b', name: 'B' }],
        },
      ]);
      expect(controls.length).toBe(1);
      expect(controls[0]?.name).toBe('First');
    });

    await it('a duplicate value inside one option keeps the first', async () => {
      const control = findControl(
        projectConfigOptions([
          {
            id: 'mode',
            name: 'Mode',
            type: 'select',
            currentValue: 'build',
            options: [
              { value: 'build', name: 'Build' },
              { value: 'build', name: 'Build again' },
            ],
          },
        ]),
        'mode',
      );
      expect(control?.kind === 'select' ? control.values.length : 0).toBe(1);
    });

    await it('a value of "" is not a value — it cannot be sent back', async () => {
      // `session/set_config_option` sends `value` as the id, so an empty string is a request the
      // agent cannot match to anything. The one non-obvious half of this: with the `""` filter
      // removed, the *whole option* survives rather than being dropped, because the surviving value
      // is the selected one. Verified as a mutation.
      expect(
        projectConfigOptions([
          {
            id: 'mode',
            name: 'Mode',
            type: 'select',
            currentValue: '',
            options: [
              { value: '', name: 'Empty' },
              { value: 'build', name: 'Build' },
            ],
          },
        ]),
      ).toStrictEqual([]);
    });

    await it('a non-object entry among the values is skipped, the rest survive', async () => {
      const control = findControl(
        projectConfigOptions([
          {
            id: 'mode',
            name: 'Mode',
            type: 'select',
            currentValue: 'build',
            options: [null, 'build', 7, { value: 'build', name: 'Build' }] as never,
          },
        ]),
        'mode',
      );
      expect(control?.kind === 'select' ? control.values.length : 0).toBe(1);
    });

    await it('an option with an empty id, and one that is not an object', async () => {
      expect(projectConfigOptions([{ id: '', name: 'Nameless', type: 'select' } as never])).toStrictEqual([]);
      expect(projectConfigOptions([null as never, undefined as never])).toStrictEqual([]);
    });
  });

  await describe('adversarial input — nothing may throw, everything is refused or drawn', async () => {
    const HOSTILE: unknown[] = [
      undefined,
      null,
      0,
      1,
      '',
      'select',
      true,
      false,
      Symbol('x'),
      10n,
      () => 1,
      [],
      [null],
      [[]],
      [{}],
      [{ value: {} }],
      [{ value: [] }],
      [{ name: 'x' }],
      { options: 'not-an-array' },
      { options: { length: 2 } },
      { options: 7 },
      { currentValue: {} },
      { currentValue: [] },
      { currentValue: null },
      { type: 'select', currentValue: 'a', options: { 0: { value: 'a' } } },
      { type: 'select', currentValue: 'a', options: [Object.create(null)] },
      { type: 'select', currentValue: 'a', options: [{ value: 'a', name: { toString: null } }] },
      { type: { toString: () => 'select' }, currentValue: 'a', options: [{ value: 'a' }] },
      { id: 'a', type: 'select', currentValue: 'a', options: [{ value: 'a' }], category: {} },
      { id: 'a', type: 'boolean', currentValue: 0 },
      { id: 'a', type: 'boolean', currentValue: new Boolean(true) },
      { id: 'a', type: 'select', currentValue: 'a', options: [{ value: 'a', name: '' }] },
    ];

    await it('never throws on any of them', async () => {
      for (const input of HOSTILE) {
        let thrown: string | null = null;
        let result: unknown = null;
        try {
          result = projectConfigOptions([input as never]);
        } catch (error) {
          thrown = error instanceof Error ? error.message : String(error);
        }
        if (thrown !== null) throw new Error(`threw on ${String(input)}: ${thrown}`);
        // Whatever came back must be drawable: a control whose name or id is not a string, or whose
        // current value is not among its own values, is the failure this whole module exists to stop.
        for (const control of (result ?? []) as ConfigControl[]) {
          if (typeof control.id !== 'string' || control.id === '') throw new Error('id is not a string');
          if (typeof control.name !== 'string' || control.name === '')
            throw new Error('name is not a string');
          if (control.kind === 'switch' && typeof control.currentValue !== 'boolean') {
            throw new Error('switch without a boolean');
          }
          if (control.kind === 'select') {
            for (const value of control.values) {
              if (typeof value.value !== 'string' || value.value === '')
                throw new Error('unusable value survived');
            }
            if (!control.values.some((value) => value.value === control.currentValue)) {
              throw new Error('select whose currentValue is not among its values survived');
            }
          }
        }
      }
    });

    await it('treats a top-level non-array as no options at all', async () => {
      for (const input of ['nope', 7, {}, null, undefined, true]) {
        expect(projectConfigOptions(input as never)).toStrictEqual([]);
      }
    });
  });

  await describe('the values a control sends back', async () => {
    await it('a select sends the bare value id — no type tag', async () => {
      const control = findControl(projectConfigOptions(opencodeConfigOptions()), 'model');
      expect(configValue(control!, 'openrouter/anthropic/claude-sonnet-5.5')).toBe(
        'openrouter/anthropic/claude-sonnet-5.5',
      );
    });

    await it('a switch sends the tagged boolean form, because the schema puts the tag on the request', async () => {
      const control = findControl(
        projectConfigOptions([{ id: 'web', name: 'Web', type: 'boolean', currentValue: false }]),
        'web',
      );
      // The asymmetry is the schema's: `SetSessionConfigOptionRequest` is an `anyOf` on the
      // *request*, so a boolean travels with `type: "boolean"` beside it while a value id does not.
      expect(configValue(control!, true)).toStrictEqual({ type: 'boolean', value: true });
    });

    await it('a string given to a switch is read as a boolean rather than sent as a value id', async () => {
      const control = findControl(
        projectConfigOptions([{ id: 'web', name: 'Web', type: 'boolean', currentValue: false }]),
        'web',
      );
      expect(configValue(control!, 'true')).toStrictEqual({ type: 'boolean', value: true });
      expect(configValue(control!, 'no')).toStrictEqual({ type: 'boolean', value: false });
    });
  });

  await describe('currentLabel', async () => {
    await it('shows the name of the selected value, not its id', async () => {
      const control = findControl(projectConfigOptions(opencodeConfigOptions()), 'model');
      // The ids are `provider/model` strings; the name is what a person recognises.
      expect(currentLabel(control!)).toBe('gpt-6.1-sol');
    });

    await it('falls back to the id when no value matches', async () => {
      const control = findControl(
        projectConfigOptions([
          {
            id: 'x',
            name: 'X',
            type: 'select',
            category: 'other',
            currentValue: 'a',
            options: [{ value: 'a', name: 'A' }],
          },
        ]),
        'x',
      );
      expect(currentLabel(control!)).toBe('A');
    });

    await it('a switch reads as on or off', async () => {
      const on = findControl(
        projectConfigOptions([{ id: 'web', name: 'Web', type: 'boolean', currentValue: true }]),
        'web',
      );
      const off = findControl(
        projectConfigOptions([{ id: 'web', name: 'Web', type: 'boolean', currentValue: false }]),
        'web',
      );
      expect(currentLabel(on!)).toBe('on');
      expect(currentLabel(off!)).toBe('off');
    });
  });
};
