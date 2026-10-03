/**
 * The free-model hint — what it sorts, what it refuses to do, and where it is allowed to apply.
 *
 * The function is pure and the ids are a parameter, so almost every case here runs against a hint that
 * has nothing to do with the shipped file; that is the point of taking the list as an argument rather
 * than reading a module global. The two cases that *do* read `FREE_MODEL_IDS` are the ones about the
 * file itself, because "is this id still a real one" is not something a synthetic list can answer.
 *
 * Both runtimes, no display — the same bargain as every other `core/` test: a decision about which
 * model ids appear first is invisible in a screenshot, and cheap to get wrong.
 */

import { describe, expect, it } from '@gjsify/unit';

import { freeModelFirst, FREE_MODEL_IDS, FREE_MODELS } from '../../../src/core/free-models.ts';
import { configRowInput, modelControl } from '../../../src/core/config-row.ts';
import type { ConfigValue } from '../../../src/core/config.ts';
import type { SessionConfigOption } from '@kurier/acp/types';

/** The agent's list, in the agent's order, with two of them named by the hint. */
function values(...ids: string[]): ConfigValue[] {
  return ids.map((id) => ({ value: id, name: id, description: null, group: null }));
}

function ids(list: readonly ConfigValue[]): string[] {
  return list.map((entry) => entry.value);
}

const HINT = ['opencode/space-bunny-free', 'opencode/longcat-2.5-preview-free'];

export default async function freeModels(): Promise<void> {
  await describe('free-model hint — the file it reads', async () => {
    await it('carries ids, the date they were checked, and the link they were read from', async () => {
      // A hint nobody can audit is a hint nobody can correct. `checked` is what tells a stale entry from
      // a current one, and `link` is the only authority kurier has on the question at all.
      expect(FREE_MODELS.checked).toBe('2026-10-02');
      expect(FREE_MODELS.link).toContain('opencode.ai');
      expect(FREE_MODELS.ids.length).toBeGreaterThan(0);
      expect(FREE_MODEL_IDS).toEqualArray(FREE_MODELS.ids);
    });

    await it('lists no duplicates and no blanks — a Set is the only place a duplicate could hide', async () => {
      const seen = new Set<string>();
      for (const id of FREE_MODEL_IDS) {
        expect(id.trim()).toBe(id);
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
    });

    await it('names real provider-scoped ids, because a bare model name matches nothing', async () => {
      // A hint is exact string matching, so `space-bunny-free` would never match the value the agent
      // sends (`opencode/space-bunny-free`) and would look like a working hint while doing nothing.
      for (const id of FREE_MODEL_IDS) expect(id).toContain('/');
    });
  });

  await describe('free-model hint — what the sort does', async () => {
    await it('moves a named id to the front', async () => {
      const sorted = freeModelFirst(values('openrouter/a/model', 'opencode/space-bunny-free'), HINT);
      expect(ids(sorted)).toEqualArray(['opencode/space-bunny-free', 'openrouter/a/model']);
    });

    await it('keeps the hint’s own priority order, because that is what the file’s order means', async () => {
      // The maintainer wrote the ids down in the order they should be reached; re-sorting by name — or
      // treating the list as a `Set` and keeping the agent's order — would throw that away and make the
      // file an unordered set. The agent's own order here is the *opposite* of the hint's, so the two
      // readings cannot both pass.
      const list = values('opencode/longcat-2.5-preview-free', 'opencode/space-bunny-free');
      expect(ids(freeModelFirst(list, HINT))).toEqualArray([
        'opencode/space-bunny-free',
        'opencode/longcat-2.5-preview-free',
      ]);
      expect(ids(freeModelFirst(list, [...HINT].reverse()))).toEqualArray([
        'opencode/longcat-2.5-preview-free',
        'opencode/space-bunny-free',
      ]);
    });

    await it('places a duplicated hint id once, because a dropdown offering one model twice is a defect', async () => {
      // `free-models.json` is maintained by hand; the function defends against a typo in it rather than
      // trusting the file to be well-formed.
      const list = values('a/1', 'opencode/space-bunny-free');
      const sorted = freeModelFirst(list, ['opencode/space-bunny-free', 'opencode/space-bunny-free']);
      expect(ids(sorted)).toEqualArray(['opencode/space-bunny-free', 'a/1']);
      expect(sorted.length).toBe(list.length);
    });

    await it('keeps the agent’s order within both groups', async () => {
      // The rest of a 400-entry list is a statement the agent made — its own recommended models first —
      // and the hint has no business re-ordering any of it.
      const sorted = freeModelFirst(
        values('a/1', 'opencode/space-bunny-free', 'a/2', 'opencode/longcat-2.5-preview-free', 'a/3'),
        HINT,
      );
      expect(ids(sorted)).toEqualArray([
        'opencode/space-bunny-free',
        'opencode/longcat-2.5-preview-free',
        'a/1',
        'a/2',
        'a/3',
      ]);
    });

    await it('hides nothing — every id the agent offered is still in the list', async () => {
      const list = values('a/1', 'b/2', 'c/3', 'opencode/space-bunny-free');
      const sorted = freeModelFirst(list, HINT);
      expect(sorted.length).toBe(list.length);
      expect([...ids(sorted)].sort()).toEqualArray([...ids(list)].sort());
    });

    await it('matches only exact ids, and never a substring', async () => {
      // A `startsWith` would drag a paid model up beside the free one it is named after.
      const sorted = freeModelFirst(
        values(
          'opencode/space-bunny-free-pro',
          'opencode/space-bunny-free-x',
          'vendor/opencode/space-bunny-free',
        ),
        HINT,
      );
      expect(ids(sorted)).toEqualArray([
        'opencode/space-bunny-free-pro',
        'opencode/space-bunny-free-x',
        'vendor/opencode/space-bunny-free',
      ]);
    });

    await it('is a no-op for an empty hint, an unknown id, or an empty list', async () => {
      // Which is also the shape a rotted `free-models.json` degrades into: ids that match nothing.
      const list = values('a/1', 'b/2');
      expect(ids(freeModelFirst(list, []))).toEqualArray(['a/1', 'b/2']);
      expect(ids(freeModelFirst(list, ['opencode/something-removed']))).toEqualArray(['a/1', 'b/2']);
      expect(freeModelFirst([], HINT)).toEqualArray([]);
    });

    await it('returns a new array and leaves the caller’s list untouched', async () => {
      const list = values('a/1', 'opencode/space-bunny-free');
      const sorted = freeModelFirst(list, HINT);
      expect(sorted).not.toBe(list);
      expect(ids(list)).toEqualArray(['a/1', 'opencode/space-bunny-free']);
    });
  });

  await describe('free-model hint — where it applies', async () => {
    /** An agent's model option whose list contains both hinted ids and three others. */
    function modelOptions(): SessionConfigOption[] {
      return [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'openrouter/vendor/model-000',
          options: [
            { value: 'openrouter/vendor/model-000', name: 'first' },
            { value: 'openrouter/vendor/model-001', name: 'second' },
            ...HINT.map((value) => ({ value, name: value })),
          ],
        },
        {
          id: 'effort',
          name: 'Effort',
          category: 'thought_level',
          type: 'select',
          currentValue: 'default',
          options: [
            { value: 'low', name: 'Low' },
            { value: 'default', name: 'Default' },
          ],
        },
      ];
    }

    await it('sorts the model control and leaves every other option exactly as the agent sent it', async () => {
      const view = configRowInput({ options: modelOptions() });
      const model = modelControl(view);
      expect(model).not.toBe(null);
      expect(model?.values.map((value) => value.value)).toEqualArray([
        'opencode/space-bunny-free',
        'opencode/longcat-2.5-preview-free',
        'openrouter/vendor/model-000',
        'openrouter/vendor/model-001',
      ]);
      // The thought level is untouched — the hint is about models, and a rate-limited value above a
      // person's own effort level would be worse than no hint at all.
      const effort = view.controls.find((control) => control.id === 'effort');
      expect(effort?.values.map((value) => value.value)).toEqualArray(['low', 'default']);
    });

    await it('still shows what the agent says is in use, at its own index', async () => {
      // **Never a selection.** The hint moved the values, so the selected index has to be computed
      // against the *sorted* list or the dropdown would put some other model on screen. `currentValue`
      // is still the agent's, and this is the case that proves it.
      const view = configRowInput({ options: modelOptions() });
      const model = modelControl(view);
      expect(model?.values[model?.selected ?? -1]?.value).toBe('openrouter/vendor/model-000');
    });

    await it('leaves an uncategorised option alone, rather than guessing that it is the model', async () => {
      // `id: 'model'` with no `category` is a different agent's naming. Applying the hint on the id
      // would mean a second rule about what an agent calls things; not applying it means no hint, which
      // is honest.
      const uncategorised = modelOptions().map((option) => ({ ...option, category: undefined }));
      const view = configRowInput({ options: uncategorised });
      const model = view.controls.find((control) => control.id === 'model');
      expect(model?.values.map((value) => value.value)).toEqualArray([
        'openrouter/vendor/model-000',
        'openrouter/vendor/model-001',
        'opencode/space-bunny-free',
        'opencode/longcat-2.5-preview-free',
      ]);
      // …and `modelControl` agrees with the sort, so the failure dialog's button and the sort are
      // looking at the same thing.
      expect(modelControl(view)).toBe(null);
    });

    await it('finds no model control in a row that has none, which is what hides the dialog’s button', async () => {
      const noModels = modelOptions().filter((option) => option.category !== 'model');
      expect(modelControl(configRowInput({ options: noModels }))).toBe(null);
      expect(modelControl(configRowInput({ options: [] }))).toBe(null);
    });
  });
}
