/**
 * What the agent offers, turned into something a surface can draw.
 *
 * One rule, and it is the whole design: **a control exists only if the agent reported one.** No
 * model dropdown because models are a thing agents have, no disabled placeholder for an agent that
 * has none. An empty array yields no controls, which is not the same as an empty row.
 *
 * The comparison is Zed's, and it is worth being explicit about the difference. Zed's
 * *Configuration Boundaries* says model configuration is "usually owned by the External Agent", and
 * for one agent specifically: "Authentication and model selection are configured through Poolside,
 * not Zed." Zed shows nothing and passes the values through. That works there because the agent has
 * somewhere else to live — beside the editor, in its own TUI. In kurier the agent *is* the window,
 * so "elsewhere" is a terminal the person has to leave to open. Showing what the agent reported, and
 * setting it through the protocol, is the same boundary from the other side: kurier holds no
 * configuration authority over the agent (see `LOTSE_CLIENT_CAPABILITIES` and `setConfigOption`).
 *
 * Measured against `opencode acp` 2.0.19, one `session/new` with an empty `mcpServers`:
 *
 * | `id`       | `category`      | `type`    | values | `currentValue`               |
 * |------------|-----------------|-----------|--------|------------------------------|
 * | `model`    | `model`         | `select`  | ~400   | `openrouter/openai/gpt-6.1-sol` |
 * | `effort`   | `thought_level` | `select`  | 6      | `default`                    |
 * | `mode`     | `mode`          | `select`  | 2      | `build`                      |
 *
 * **Where the validation lives, and why it is here and not in `types.ts`.** `SessionConfigOption`
 * is a flat wire type (`packages/acp/src/types.ts` explains why), so `type` and its payload need
 * checking exactly once. This module is that once. The result is a closed union, so the GTK code
 * builds widgets from a value that has already been checked and never casts — and the checks are
 * testable on Node and GJS alike, which a widget is not.
 *
 * The same bargain `narrow.ts` makes for `sessionUpdate`, one level up.
 */

import {
  narrowConfigBoolean,
  narrowConfigSelect,
  usableConfigValues,
  type UsableConfigValue,
} from '@lotse/acp/narrow';
import type {
  KnownConfigCategory,
  SessionConfigOption,
  SetSessionConfigOptionRequest,
} from '@lotse/acp/types';

import { freeModelFirst } from './free-models.ts';

/**
 * One value in a `select`, as the surface shows it.
 *
 * Named here as well as in `@lotse/acp/narrow` because the surface's vocabulary is the control's,
 * not the protocol's: it draws a `ConfigValue`, and it should not have to know that the wire calls it
 * a `SessionConfigSelectOption` with a filter applied. Same shape, one name per layer.
 */
export type ConfigValue = UsableConfigValue;

/** A `type: "select"` option: one value out of a list. A model, a thought level, a mode. */
export interface ConfigSelectControl {
  kind: 'select';
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  currentValue: string;
  values: ConfigValue[];
  /**
   * Whether the list needs a search field to be usable.
   *
   * Derived here rather than in the widget because it is a fact about the **data** — 400 model ids
   * cannot be scanned, 6 effort levels can — and because a rule that lives in the widget is a rule
   * that gets re-decided per surface.
   */
  searchable: boolean;
}

/** A `type: "boolean"` option: on or off. */
export interface ConfigSwitchControl {
  kind: 'switch';
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  currentValue: boolean;
}

/** A control that passed validation. Nothing else reaches a surface. */
export type ConfigControl = ConfigSelectControl | ConfigSwitchControl;

/**
 * Category order, and the reason for each position.
 *
 * This is a *presentation* order, not a correctness one — the schema says a category "MUST NOT be
 * required for correctness", which is also why an unknown one is rendered rather than dropped. But
 * the sequence is not arbitrary either:
 *
 * 1. `model` — what the answer comes from. The most consequential choice on the row.
 * 2. `model_config` — a parameter *of* that model, so it is meaningless before it.
 * 3. `thought_level` — how hard the model thinks about it.
 * 4. `mode` — what the session is for (build/plan). Settled before the turn, not during it.
 *
 * Options **within** a category keep the order the agent sent them in, always. An agent that puts
 * its recommended model first knows something about its user; re-sorting by name throws that away.
 * The one exception is the free-model hint on a `model` control, which moves *named* ids up and leaves
 * every other value exactly where the agent put it — see `modelFirst` below and `free-models.ts`.
 */
const CATEGORY_ORDER: readonly KnownConfigCategory[] = ['model', 'model_config', 'thought_level', 'mode'];

/**
 * Above this many values a person stops scanning and starts reading, and a dropdown that needs
 * scrolling to find "the same as now" is a control they will avoid using.
 *
 * `opencode acp` reports ~400, which is the case this exists for; six thought levels are not.
 */
const SEARCH_THRESHOLD = 12;

/**
 * Project the agent's options onto controls, dropping anything that cannot be drawn honestly.
 *
 * Skipped, never guessed at:
 *
 * - **an unknown `type`** — the schema has two arms today and a later ACP may add a third. Rendering
 *   a plausible control for a payload whose shape is unknown is how a surface ends up sending a
 *   value the agent did not ask for.
 * - **a `select` with no usable values** — an empty dropdown is a control that points at nothing.
 * - **a `select` whose `currentValue` is not one of its own values** — a control that displays one
 *   thing and writes another is worse than no control.
 * - **a second option with an id already seen** — setting is by `configId`, so the duplicate is
 *   unreachable, and two controls for one value is one too many.
 */
export function projectConfigOptions(options: SessionConfigOption[] | null | undefined): ConfigControl[] {
  // The signature says `SessionConfigOption[] | null | undefined`, and that is the contract every
  // caller holds. But this is the boundary where untrusted wire data arrives, and `for..of` on a
  // number throws — a crash in the middle of rendering a session, caused by an agent. The runtime
  // check is one line and was written because the adversarial test hit exactly this: the test typed
  // `7 as never`, which is a lie the type system could not catch and the wire can still tell.
  if (!Array.isArray(options)) return [];
  const controls: ConfigControl[] = [];
  const seen = new Set<string>();
  for (const option of options) {
    if (!option || typeof option.id !== 'string' || option.id === '' || seen.has(option.id)) continue;
    const control = projectOne(option);
    if (!control) continue;
    seen.add(control.id);
    controls.push(control);
  }
  return sortByCategory(controls);
}

function projectOne(option: SessionConfigOption): ConfigControl | null {
  const common = {
    id: option.id,
    name: typeof option.name === 'string' && option.name !== '' ? option.name : option.id,
    description: typeof option.description === 'string' ? option.description : null,
    category: typeof option.category === 'string' && option.category !== '' ? option.category : null,
  };
  if (option.type === 'boolean') {
    // `narrowConfigBoolean` for symmetry with `narrowConfigSelect`, and because the boolean check
    // is the *same* kind of statement about the protocol: a `boolean` whose `currentValue` is not a
    // boolean is not a switch, it is a payload this version does not understand. Kept here rather
    // than inlined so both arms of the `oneOf` are decided in the same file, by the same reasoning.
    const toggle = narrowConfigBoolean(option);
    return toggle ? { kind: 'switch', ...common, currentValue: toggle.currentValue } : null;
  }
  if (option.type !== 'select') return null;
  // The protocol-level half of the decision is `narrowConfigSelect` — including the check that the
  // current value is one of the option's own values. Only the presentation is decided here, and it
  // reads the same filtered list rather than re-filtering: two filters over one array is how a
  // dropdown ends up offering an entry the narrowing rejected.
  const select = narrowConfigSelect(option);
  if (!select) return null;
  const values = usableConfigValues(select.options);
  if (values.length === 0) return null;
  return {
    kind: 'select',
    ...common,
    currentValue: select.currentValue,
    values: modelFirst(common.category, values.map(labelWithGroup)),
    searchable: values.length > SEARCH_THRESHOLD,
  };
}

/**
 * The free-model hint's one place to apply, and the exception it is to the rule above.
 *
 * **Only a control the agent itself called a `model`.** Not its id — `MODE_CONTROL_ID`'s note about
 * guessing at ids applies in reverse here too: `category: 'model'` is what `opencode acp` 2.0.19 sends
 * and what the schema's `KnownConfigCategory` names, and an agent that does not categorise its options
 * gets no hint rather than a hint that might have been applied to the thought level. A wrong hint is
 * worse than none: it would put a rate-limited model above a person's own.
 *
 * **Order, not selection, and nothing here can be mistaken for a preference.** `currentValue` on the
 * line above is still the agent's, so `projectSelects`' `findIndex` still finds it and the dropdown still
 * shows what is in use — the free ids are simply nearer the top. `core/free-models.ts` has the rest of
 * the reasoning and the three things this deliberately does not do.
 */
function modelFirst(category: string | null, values: ConfigValue[]): ConfigValue[] {
  return category === 'model' ? freeModelFirst(values) : values;
}

/**
 * A grouped value reads as `group: name`, and that is the whole of the grouping decision.
 *
 * **One dropdown, not one per group and not a second level of menu.** `SessionConfigSelectOptions`
 * is an `anyOf` on the wire — a flat list or a list of groups — and both arms describe the *same*
 * single-value selector: one `currentValue` for the whole option. So the groups are information
 * about where a value lives, not separate controls, and the one place a person can see a value has to
 * hold all of them. `Gtk.DropDown` has no section headers, so the group goes in front of the name:
 * a value keeps its own identity, a duplicate name in two groups stops being ambiguous, and a surface
 * that wanted real sections would have to build a second widget for one option.
 */
function labelWithGroup(value: ConfigValue): ConfigValue {
  if (value.group === null) return value;
  return { ...value, name: `${value.group}: ${value.name}` };
}

/** Known categories in `CATEGORY_ORDER`; everything else keeps its arrival order, after them. */
function sortByCategory(controls: ConfigControl[]): ConfigControl[] {
  return [...controls].sort((a, b) => rank(a.category) - rank(b.category));
}

function rank(category: string | null): number {
  const index = category === null ? -1 : CATEGORY_ORDER.indexOf(category as KnownConfigCategory);
  // An unknown or missing category sorts after every known one, and `Array.prototype.sort` is
  // stable — so within that group the agent's own order survives.
  return index === -1 ? CATEGORY_ORDER.length : index;
}

/** The label of what is selected now, for a button that shows the current value. */
export function currentLabel(control: ConfigControl): string {
  if (control.kind === 'switch') return control.currentValue ? 'on' : 'off';
  return control.values.find((value) => value.value === control.currentValue)?.name ?? control.currentValue;
}

/**
 * The value to put in a `session/set_config_option` request.
 *
 * The boolean form carries its own `type` tag and the value form does not — that asymmetry is the
 * schema's (`SetSessionConfigOptionRequest` is an `anyOf` on the request, not on the value), and it
 * is exactly the kind of detail that gets re-derived wrongly in a widget, so it lives here once.
 */
export function configValue(
  control: ConfigControl,
  value: string | boolean,
): SetSessionConfigOptionRequest['value'] {
  if (control.kind === 'switch') {
    return { type: 'boolean', value: typeof value === 'boolean' ? value : value === 'true' };
  }
  return typeof value === 'string' ? value : String(value);
}

/** The control for an id, or `undefined` — for a dev hook that sets a specific option. */
export function findControl(controls: ConfigControl[], id: string): ConfigControl | undefined {
  return controls.find((control) => control.id === id);
}
