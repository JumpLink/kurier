/**
 * The config row, decided — the cases where a wrong answer is a control that lies.
 *
 * Everything here is pure and runs on GJS and Node with no display, which is the whole reason the row's
 * decisions live in `app/src/core/config-row.ts` instead of in the widget. A `Gtk.DropDown` cannot be
 * asked "would this have sent a request" without a pointer and an X server, and the two rules that
 * matter most here — *a re-selection sends nothing* and *a refusal does not move the row* — are both
 * invisible in a screenshot even with one.
 *
 * The inputs are opencode's, from `opencodeConfigOptions()` in the fixture: a model with three values, a
 * thought level with six, a mode with two. `buildManyModelOptions(400)` covers the size the search field
 * exists for, and a hand-built grouped list covers the `anyOf` the schema allows.
 */

import { describe, expect, it } from '@gjsify/unit';

import {
  REFUSED,
  applyConfigUpdate,
  configAfterSet,
  configRequest,
  configRowInput,
  configSelection,
  emptyConfigRow,
  isConfigChange,
  parseConfigOptionSpec,
  projectConfigOptions,
  type ConfigRowControl,
  type ConfigRowView,
} from '@kurier/core';
import type { SessionConfigOption } from '@kurier/acp/types';

import {
  buildManyModelOptions,
  groupedConfigOptions,
  opencodeConfigOptions,
} from '../../support/fixture-agent.ts';

const MEASURED = opencodeConfigOptions();

/** The measured row, as the window draws it. */
function row(): ConfigRowView {
  return configRowInput({ options: MEASURED });
}

function control(view: ConfigRowView, id: string): ConfigRowControl {
  const found = view.controls.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no control "${id}" on the row`);
  return found;
}

/** The value id the control is showing, through the index the widget holds. */
function showing(view: ConfigRowView, id: string): string | null {
  const found = control(view, id);
  return configSelection(view, id, found.selected)?.value ?? null;
}

/** The row after a set of `model` to `value`, the way the agent answers. */
function withModel(value: string): ConfigRowView {
  return configAfterSet(row(), moved(MEASURED, 'model', value));
}

/**
 * An agent's answer for one option, with everything else carried forward.
 *
 * **The carry-forward is the protocol, not tidiness.** The answer to `session/set_config_option` is the
 * *full* list as it now stands, so an agent that changed the mode repeats the model it already has —
 * which is why a test that rebuilt the answer from the original options would be testing a lie.
 */
function moved(options: SessionConfigOption[], configId: string, value: string): SessionConfigOption[] {
  return options.map((option) =>
    option.id === configId ? ({ ...option, currentValue: value } as SessionConfigOption) : option,
  );
}

export default async () => {
  await describe('configRowInput — what the measured agent produces', async () => {
    await it('shows the three options in the projected order', async () => {
      const view = row();
      expect(view.visible).toBe(true);
      expect(view.controls.map((entry) => entry.id)).toEqualArray(['model', 'effort', 'mode']);
    });

    await it('puts the agent’s current value at the index the dropdown shows', async () => {
      const view = row();
      expect(control(view, 'model').selected).toBe(0);
      expect(showing(view, 'model')).toBe('openrouter/openai/gpt-6.1-sol');
      // `default` is the sixth effort level, i.e. index 5 — not the first, which is what "current"
      // would look like if it were read as "recommended".
      expect(control(view, 'effort').selected).toBe(5);
      expect(control(view, 'mode').selected).toBe(0);
    });

    await it('labels a grouped value "group: name", because there is one dropdown', async () => {
      // The schema's `anyOf`: flat *or* grouped. An agent is free to send the grouped arm, and before
      // `narrow.ts` learned both arms a grouped list narrowed to no values at all — so the model
      // selector an agent had grouped simply did not exist.
      const sources = groupedConfigOptions();
      const view = configRowInput({ options: sources });
      expect(view.controls.map((entry) => entry.id)).toEqualArray(['model', 'effort']);
      expect(control(view, 'model').values.map((value) => value.name)).toEqualArray([
        'Local: llama',
        'Local: qwen',
        'Hosted: gpt-5.5',
        'Hosted: claude-sonnet-5.5',
      ]);
      expect(showing(view, 'model')).toBe('local/llama');
      // The value ids are untouched: the group is a label, never part of what goes on the wire.
      expect(configRequest(projectConfigOptions(sources)[0]!, 'hosted/gpt-5.5')).toBe('hosted/gpt-5.5');
    });

    await it('marks a 400-entry model list searchable and a six-entry effort list not', async () => {
      const many = configRowInput({ options: buildManyModelOptions(400) });
      expect(control(many, 'model').searchable).toBe(true);
      expect(control(many, 'model').values.length).toBe(400);
      expect(control(row(), 'effort').searchable).toBe(false);
    });

    await it('falls back to the name for a tooltip when the agent sent no description', async () => {
      // The mode option has no `description`; the effort one has. A tooltip of `''` is no tooltip, and
      // the label above the control already says what it is — so the name is the honest fallback.
      expect(control(row(), 'mode').description).toBe('Session Mode');
      expect(control(row(), 'effort').description).toBe('Available effort levels for this model');
    });
  });

  await describe('configRowInput — nothing reported means no row', async () => {
    await it('an empty array yields no row at all', async () => {
      const view = configRowInput({ options: [] });
      expect(view.visible).toBe(false);
      expect(view.controls).toStrictEqual([]);
    });

    await it('null and undefined yield no row — an agent that has not answered is not an empty agent', async () => {
      expect(configRowInput({ options: null }).visible).toBe(false);
      expect(configRowInput({ options: undefined as never }).visible).toBe(false);
      // A `7 as never` is the shape the wire can still send and the type system cannot stop.
      expect(configRowInput({ options: 7 as never }).visible).toBe(false);
    });

    await it('emptyConfigRow is the same answer, with one name for it', async () => {
      expect(emptyConfigRow()).toStrictEqual(configRowInput({ options: null }));
      expect(emptyConfigRow().visible).toBe(false);
    });

    await it('skips a boolean option — kurier announces no booleans', async () => {
      // `KURIER_CLIENT_CAPABILITIES` sends `session.configOptions: {}` with no `boolean`, so an agent is
      // not entitled to send one and opencode refuses a tagged value outright. The projection still
      // carries booleans (`core/config.ts` checks the protocol boundary); the ROW does not draw them.
      const onlyBoolean = configRowInput({
        options: [{ id: 'web', name: 'Web search', type: 'boolean', currentValue: true }],
      });
      expect(onlyBoolean.visible).toBe(false);

      // And with a select beside it, the select is drawn and the boolean is gone — not "drawn as empty".
      const mixed = configRowInput({
        options: [...MEASURED, { id: 'web', name: 'Web search', type: 'boolean', currentValue: true }],
      });
      expect(mixed.controls.map((entry) => entry.id)).toEqualArray(['model', 'effort', 'mode']);
    });

    await it('goes insensitive while a set is in flight, and says nothing about the previous one', async () => {
      const busy = configRowInput({ options: MEASURED, busy: true, error: REFUSED });
      expect(busy.busy).toBe(true);
      expect(busy.controls.some((entry) => entry.selectable)).toBe(false);
      // A refusal still on screen while the next set is in flight is a sentence about a request that is
      // now being answered; the answer will replace it either way.
      expect(busy.error).toBe(null);
    });
  });

  await describe('configSelection — the index↔value mapping the widget must not own', async () => {
    await it('round-trips every value of every measured control', async () => {
      const view = row();
      for (const entry of view.controls) {
        for (const [index, value] of entry.values.entries()) {
          expect(configSelection(view, entry.id, index)).toStrictEqual({
            controlId: entry.id,
            value: value.value,
          });
        }
      }
    });

    await it('round-trips all 400 models', async () => {
      // The size the search field exists for, and the size at which an off-by-one would send the
      // neighbouring model rather than an error.
      const view = configRowInput({ options: buildManyModelOptions(400) });
      const last = control(view, 'model').values.length - 1;
      expect(configSelection(view, 'model', last)?.value).toBe('openrouter/vendor/model-399');
    });

    await it('an index past the end is null, never a value from another control', async () => {
      const view = row();
      expect(configSelection(view, 'model', 3)).toBe(null);
      expect(configSelection(view, 'effort', 6)).toBe(null);
      expect(configSelection(view, 'mode', 99)).toBe(null);
    });

    await it('a negative, fractional or NaN index is null', async () => {
      expect(configSelection(row(), 'model', -1)).toBe(null);
      expect(configSelection(row(), 'model', 1.5)).toBe(null);
      expect(configSelection(row(), 'model', Number.NaN)).toBe(null);
    });

    await it('an unknown control is null, not the first control’s values', async () => {
      // The failure this exists to prevent: a lookup that misses returning "some" control, which then
      // sets a model because the person meant an effort level.
      expect(configSelection(row(), 'web', 0)).toBe(null);
    });
  });

  await describe('configRequest — only what the agent offered', async () => {
    await it('sends the value id, as a bare string', async () => {
      const controls = projectConfigOptions(MEASURED);
      expect(configRequest(controls[0]!, 'github-copilot/gpt-5.5-codex')).toBe(
        'github-copilot/gpt-5.5-codex',
      );
    });

    await it('a value the agent did not offer is not sent', async () => {
      const controls = projectConfigOptions(MEASURED);
      expect(configRequest(controls[0]!, 'openrouter/openai/gpt-9-imaginary')).toBe(null);
      expect(configRequest(controls[1]!, '')).toBe(null);
    });

    await it('never sends a tagged boolean, because kurier announces no boolean capability', async () => {
      const toggle = projectConfigOptions([{ id: 'web', name: 'Web', type: 'boolean', currentValue: true }]);
      expect(toggle[0]?.kind).toBe('switch');
      expect(configRequest(toggle[0]!, 'true')).toBe(null);
    });
  });

  await describe('isConfigChange — the guard that makes a rebuild silent', async () => {
    await it('re-selecting the current value is not a change', async () => {
      const view = row();
      expect(isConfigChange(view, 'model', 'openrouter/openai/gpt-6.1-sol')).toBe(false);
      expect(isConfigChange(view, 'effort', 'default')).toBe(false);
    });

    await it('any other offered value is a change', async () => {
      expect(isConfigChange(row(), 'model', 'github-copilot/gpt-5.5-codex')).toBe(true);
    });

    await it('an unknown control is not a change — there is nothing to change', async () => {
      expect(isConfigChange(row(), 'web', 'true')).toBe(false);
      expect(isConfigChange(emptyConfigRow(), 'model', 'openrouter/openai/gpt-6.1-sol')).toBe(false);
    });

    await it('an unoffered value is a change but still is never sent, because configRequest refuses it', async () => {
      // The two guards answer different questions, and a caller that wanted one rule in one place
      // would have to re-derive both. `isConfigChange` asks "did the person choose something other than
      // what is current?"; `configRequest` asks "has the agent offered it at all?". A value from a stale
      // list, a dev hook or a bug is a change — and not a request.
      const unoffered = 'openrouter/openai/gpt-9-imaginary';
      expect(isConfigChange(row(), 'model', unoffered)).toBe(true);
      expect(configRequest(projectConfigOptions(MEASURED)[0]!, unoffered)).toBe(null);
    });

    await it('is still a change after the agent has moved the value', async () => {
      // The interesting case: the row is redrawn with the agent's new answer, and picking what was
      // current a moment ago is now a real change back. A guard that remembered the *previous* view's
      // value would swallow this and make the control feel stuck.
      const view = withModel('github-copilot/gpt-5.5-codex');
      expect(showing(view, 'model')).toBe('github-copilot/gpt-5.5-codex');
      expect(isConfigChange(view, 'model', 'github-copilot/gpt-5.5-codex')).toBe(false);
      expect(isConfigChange(view, 'model', 'openrouter/openai/gpt-6.1-sol')).toBe(true);
    });
  });

  await describe('configAfterSet — the agent’s answer, or nothing moved', async () => {
    await it('success takes the agent’s list over the local guess', async () => {
      const view = withModel('github-copilot/gpt-5.5-codex');
      expect(showing(view, 'model')).toBe('github-copilot/gpt-5.5-codex');
      expect(view.error).toBe(null);
      expect(view.busy).toBe(false);
    });

    await it('a refused set leaves the last answered state exactly as it was', async () => {
      const before = withModel('github-copilot/gpt-5.5-codex');
      const after = configAfterSet(before, new Error('no such config option'));
      // The controls are the agent's, unchanged: a refusal is not an answer.
      expect(after.controls).toStrictEqual(before.controls);
      expect(showing(after, 'model')).toBe('github-copilot/gpt-5.5-codex');
      expect(after.error).toBe(REFUSED);
      expect(after.busy).toBe(false);
    });

    await it('the refusal sentence is fixed English and does not quote the agent', async () => {
      // An agent's error text names ids and codes; putting it in a caption under a model dropdown says
      // nothing about what a person can do. The detail goes to the log.
      const after = configAfterSet(row(), new Error('that value is not one of the offered ones'));
      expect(after.error).toBe('The agent did not change this. Its previous value is still in use.');
      expect(after.error).not.toContain('offered ones');
    });

    await it('an answer that is not a list is a refusal, and does not blank the row', async () => {
      const before = withModel('github-copilot/gpt-5.5-codex');
      const after = configAfterSet(before, undefined as never);
      expect(after.controls.length).toBe(3);
      expect(after.error).toBe(REFUSED);
    });

    await it('an agent that answers with no options empties the row rather than leaving a stale one', async () => {
      const after = configAfterSet(row(), []);
      expect(after.visible).toBe(false);
      expect(after.controls).toStrictEqual([]);
    });

    await it('clears a previous refusal on the next success', async () => {
      const refused = configAfterSet(row(), new Error('nope'));
      const recovered = configAfterSet(refused, MEASURED);
      expect(recovered.error).toBe(null);
    });
  });

  await describe('applyConfigUpdate — the agent’s own updates', async () => {
    await it('config_option_update replaces the list wholesale', async () => {
      const changed = MEASURED.map((option) =>
        option.id === 'model' ? { ...option, currentValue: 'github-copilot/gpt-5.5-codex' } : option,
      );
      const next = applyConfigUpdate(MEASURED, {
        sessionUpdate: 'config_option_update',
        configOptions: changed,
      });
      expect(showing(configRowInput({ options: next ?? null }), 'model')).toBe(
        'github-copilot/gpt-5.5-codex',
      );
    });

    await it('an update that dropped an option drops it from the row', async () => {
      // The agent's list is the truth in both directions: a control kurier is still drawing for an
      // option the agent no longer offers is a control that points at nothing.
      const next = applyConfigUpdate(MEASURED, {
        sessionUpdate: 'config_option_update',
        configOptions: MEASURED.slice(0, 1),
      });
      expect(configRowInput({ options: next ?? null }).controls.map((entry) => entry.id)).toEqualArray([
        'model',
      ]);
    });

    await it('current_mode_update moves the mode control and nothing else', async () => {
      const next = applyConfigUpdate(MEASURED, {
        sessionUpdate: 'current_mode_update',
        currentModeId: 'plan',
      });
      const view = configRowInput({ options: next ?? null });
      expect(showing(view, 'mode')).toBe('plan');
      // The model is untouched: a mode update is a statement about the mode, and rewriting the model
      // from it would be inventing a value the agent never sent.
      expect(showing(view, 'model')).toBe('openrouter/openai/gpt-6.1-sol');
      expect(showing(view, 'effort')).toBe('default');
    });

    await it('current_mode_update on an agent that reports no options is undefined, not a row', async () => {
      expect(applyConfigUpdate(null, { sessionUpdate: 'current_mode_update', currentModeId: 'plan' })).toBe(
        undefined,
      );
    });

    await it('every other update is undefined, so a caller can pass them all without filtering', async () => {
      const chunk = applyConfigUpdate(MEASURED, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hi' },
      });
      expect(chunk).toBe(undefined);
      // A `current_mode_update` is a change, not an absence — the distinction is what makes the
      // `undefined` return usable as "nothing to redraw".
      const mode = applyConfigUpdate(MEASURED, {
        sessionUpdate: 'current_mode_update',
        currentModeId: 'plan',
      });
      expect(mode?.length).toBe(3);
    });

    await it('a config_option_update without a list is undefined — nothing to redraw from', async () => {
      expect(
        applyConfigUpdate(MEASURED, { sessionUpdate: 'config_option_update', configOptions: 7 as never }),
      ).toBe(undefined);
    });
  });

  await describe('parseConfigOptionSpec — KU_APP_CONFIG’s one format', async () => {
    await it('reads configId=valueId', async () => {
      expect(parseConfigOptionSpec('mode=plan')).toStrictEqual({ controlId: 'mode', value: 'plan' });
      expect(parseConfigOptionSpec('model=openrouter/openai/gpt-6.1-sol')).toStrictEqual({
        controlId: 'model',
        value: 'openrouter/openai/gpt-6.1-sol',
      });
    });

    await it('splits on the first = only, because a value id is an opaque agent string', async () => {
      expect(parseConfigOptionSpec('weird=a=b')).toStrictEqual({ controlId: 'weird', value: 'a=b' });
    });

    await it('a half-spec is null, so a typo cannot silently set something', async () => {
      expect(parseConfigOptionSpec('mode')).toBe(null);
      expect(parseConfigOptionSpec('=plan')).toBe(null);
      expect(parseConfigOptionSpec('mode=')).toBe(null);
      expect(parseConfigOptionSpec('')).toBe(null);
      expect(parseConfigOptionSpec('=')).toBe(null);
    });

    await it('what it parses is a selection the row can act on', async () => {
      // The two halves exist because a hook needs both; this is the end-to-end claim that a parsed spec
      // is a real selection against a real row rather than two loose strings.
      const spec = parseConfigOptionSpec('effort=high');
      expect(spec).not.toBe(null);
      expect(isConfigChange(row(), spec!.controlId, spec!.value)).toBe(true);
      expect(
        configSelection(
          row(),
          'effort',
          control(row(), 'effort').values.findIndex((value) => value.value === 'high')!,
        ),
      ).toStrictEqual(spec);
    });
  });

  await describe('a whole set in sequence, which is what a person actually does', async () => {
    await it('pick a model → the answer wins → pick the mode → the answer wins', async () => {
      let view = row();
      let answer = MEASURED;
      const picked = configSelection(view, 'model', 2)!;
      expect(isConfigChange(view, picked.controlId, picked.value)).toBe(true);
      answer = moved(answer, 'model', picked.value);
      view = configAfterSet(view, answer);
      expect(showing(view, 'model')).toBe('github-copilot/gpt-5.5-codex');
      expect(view.error).toBe(null);

      // …and the same thing through a `config_option_update`, which is what opencode sends for a model
      // while it answers with the list for a mode. Both doors, one row. The second answer carries the
      // first one forward, because the agent's list is the truth *whole* — an answer that dropped the
      // model change would put the row back, which is correct and is what the next test pins.
      answer = moved(answer, 'mode', 'plan');
      view = configAfterSet(view, answer);
      expect(showing(view, 'mode')).toBe('plan');
      expect(showing(view, 'model')).toBe('github-copilot/gpt-5.5-codex');

      // A refusal in the middle changes nothing that came before it.
      const refused = configAfterSet(view, new Error('this agent takes a value id, not a tagged value'));
      expect(showing(refused, 'mode')).toBe('plan');
      expect(refused.error).toBe(REFUSED);
    });

    await it('a row that was never there stays invisible through a whole refused set', async () => {
      // The other end of the rule: a refusal sentence on a row with no controls is a caption in an empty
      // gap, so an invisible row stays invisible.
      const after = configAfterSet(emptyConfigRow(), new Error('nope'));
      expect(after.visible).toBe(false);
      expect(after.controls).toStrictEqual([]);
    });
  });
};
