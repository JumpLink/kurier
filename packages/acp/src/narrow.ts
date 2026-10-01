/**
 * The one place where "the agent said something this version does not know" is decided.
 *
 * `KnownSessionUpdate` in `types.ts` has no catch-all branch, on purpose — a catch-all makes every
 * field of every known variant `unknown` and pushes a cast into every consumer. The cost of that
 * decision is that something has to notice an unknown variant, and this is it.
 *
 * **An unknown `sessionUpdate` is never an error.** It goes to the wire listeners as an ordinary
 * message, tagged with its method, so a caller can log it, forward it, or render a placeholder.
 * Dropping it would make kurier's transcript disagree with the agent's; throwing on it would break
 * every agent that ships an extension before we do — which is the failure the plan's `_meta` rule
 * exists to prevent, in the one place where the extension is not behind `_meta`.
 */

import {
  KNOWN_CONFIG_OPTION_TYPES,
  SESSION_UPDATE_KINDS,
  type AnySessionUpdate,
  type KnownSessionUpdate,
  type SessionConfigOption,
  type ValidSessionConfigBoolean,
  type ValidSessionConfigSelect,
} from './types.ts';

const KNOWN = new Set<string>(SESSION_UPDATE_KINDS);

export function isKnownSessionUpdateKind(kind: unknown): kind is KnownSessionUpdate['sessionUpdate'] {
  return typeof kind === 'string' && KNOWN.has(kind);
}

/**
 * Narrow a wire value to a known update, or return `null` for a variant this client does not
 * implement. A single cast, in a single place, with the reason written down.
 */
export function narrowSessionUpdate(update: unknown): KnownSessionUpdate | null {
  if (typeof update !== 'object' || update === null) return null;
  const kind = (update as { sessionUpdate?: unknown }).sessionUpdate;
  if (!isKnownSessionUpdateKind(kind)) return null;
  return update as KnownSessionUpdate;
}

/** The name of a variant, known or not. For a log line a person will read at 23:00. */
export function describeSessionUpdate(update: AnySessionUpdate | unknown): string {
  const kind = (update as { sessionUpdate?: unknown } | null)?.sessionUpdate;
  return typeof kind === 'string' ? kind : '(not a session update)';
}

// ─── session configuration ───────────────────────────────────────────────────────────────────
//
// The config option needs narrowing in the same way a session update does, and for the same
// reason: the wire type is flat on purpose (`SessionConfigOption` explains why), so *something* has
// to decide what is drawable. It lives here, beside the update narrowing, rather than in the widget
// that would otherwise carry the casts.
//
// Two checks, and the second is the one that earns its keep:
//
// 1. the `type` is one of the two the v1 schema defines, and the payload is shaped like it;
// 2. **a `select`'s `currentValue` is one of its own values.** A dropdown whose current value is not
//    in its list is a control that displays one thing and writes another, and it is the failure a
//    surface cannot detect by looking at itself. `null` here means "not drawable", and the caller
//    skips it.

/** True when `type` is one ACP v1 defines. An unknown one is carried, then dropped at the edge. */
export function isKnownConfigOptionType(type: unknown): type is (typeof KNOWN_CONFIG_OPTION_TYPES)[number] {
  return typeof type === 'string' && (KNOWN_CONFIG_OPTION_TYPES as readonly string[]).includes(type);
}

/** A value of a `select`, reduced to the two fields that make it settable and nameable. */
export interface UsableConfigValue {
  value: string;
  name: string;
  description: string | null;
  /**
   * The group this value arrived under, or `null` for a flat list.
   *
   * **Carried, not rendered.** `SessionConfigSelectOptions` is an `anyOf` on the wire — flat or
   * grouped — and a grouped list has to become the *same* list of values, because a `select` has one
   * `currentValue` and therefore one flat answer. What a surface does with the group (in kurier's
   * case: nothing, it puts the group in front of the name) is a presentation decision and lives in
   * `app/src/core/config.ts`; what belongs here is only the fact that there was a group.
   */
  group: string | null;
}

/**
 * The values of a `select` that can actually be set, in the order the agent sent them.
 *
 * **The single filter for this, used by both the narrowing and the drawing.** Two filters over the
 * same array is how the two drift: one of them then accepts a value the other drops, and a dropdown
 * opens on an entry that cannot be chosen. An entry is usable when it has a non-empty string `value`
 * — that is the field `session/set_config_option` sends — and it keeps its position, because an
 * agent that puts its recommended model first knows something about its user.
 *
 * **Both arms of the `anyOf`, which is the point.** `SessionConfigSelectOptions` is either a list of
 * options or a list of groups of options, and an agent is free to send either. Reading only the flat
 * arm meant a grouped list narrowed to *no* values — so `narrowConfigSelect` refused the option and a
 * model selector an agent had grouped simply did not exist. The group is flattened into its values,
 * each tagged with the group it came from, and the dedup stays on `value` so a value listed twice
 * (once in a group, once flat) is still one value.
 */
export function usableConfigValues(options: unknown): UsableConfigValue[] {
  if (!Array.isArray(options)) return [];
  const values: UsableConfigValue[] = [];
  const seen = new Set<string>();
  // Grouped first, so the flat arm below can be written without knowing about groups: a group is
  // `options`-shaped itself, and a flat entry has no `options` property, so one loop covers both.
  for (const entry of options.flatMap((entry) => flattenGroup(entry))) {
    const value = entry.value;
    if (typeof value !== 'string' || value === '' || seen.has(value)) continue;
    seen.add(value);
    const { name, description, group } = entry;
    values.push({
      value,
      name: typeof name === 'string' && name !== '' ? name : value,
      description: typeof description === 'string' ? description : null,
      group,
    });
  }
  return values;
}

/** One wire entry, widened to `unknown` once so this function needs no casts to read it. */
interface RawConfigValue {
  value?: unknown;
  name?: unknown;
  description?: unknown;
  group: string | null;
}

/**
 * One wire entry as the values it contributes: itself if it is an option, its options if it is a group.
 *
 * A group is recognised by its own `options` array rather than by anything a schema says is
 * required, because a group whose `options` is missing has no values to contribute either way — so
 * there is nothing to get wrong here. The group's `name` is the label; a group that has none
 * contributes its values ungrouped rather than dropping them.
 */
function flattenGroup(entry: unknown): RawConfigValue[] {
  if (!entry || typeof entry !== 'object') return [];
  const wire = entry as { value?: unknown; name?: unknown; description?: unknown; options?: unknown };
  if (!Array.isArray(wire.options)) {
    return [{ value: wire.value, name: wire.name, description: wire.description, group: null }];
  }
  const group = typeof wire.name === 'string' && wire.name !== '' ? wire.name : null;
  return (wire.options as unknown[]).map((option) => {
    const value = option && typeof option === 'object' ? (option as RawConfigValue) : ({} as RawConfigValue);
    return { value: value.value, name: value.name, description: value.description, group };
  });
}

/**
 * Narrow a wire config option to a `select` that can be drawn, or `null`.
 *
 * A `boolean` is deliberately **not** handled here — it has no list to be inconsistent with, so the
 * check is one equality. Both live in the projection, which is the one place that decides what a
 * surface gets; this is the part of that decision which is a statement about the protocol rather
 * than about presentation.
 *
 * `null` covers four refusals, and each is a case where a control would be a lie: the type is not
 * `select`, the `currentValue` is not a string, there is no settable value at all, or the selected
 * value is not among the offered ones. The last is the one that cannot be seen by looking at the
 * widget afterwards.
 */
export function narrowConfigSelect(
  option: SessionConfigOption | null | undefined,
): ValidSessionConfigSelect | null {
  if (!option || !isKnownConfigOptionType(option.type) || option.type !== 'select') return null;
  const currentValue = option.currentValue;
  if (typeof currentValue !== 'string') return null;
  const values = usableConfigValues(option.options);
  // One check, not two: an empty list cannot contain the current value, so this covers "nothing to
  // offer" and "the selection is not on offer" together. Written as a single condition on purpose —
  // a separate emptiness guard here was verified to be dead code.
  if (!values.some((entry) => entry.value === currentValue)) return null;
  return option as ValidSessionConfigSelect;
}

/**
 * Narrow a wire config option to a `boolean` that can be drawn, or `null`.
 *
 * One check, and it is the same shape as the `select` case: the payload must be the type the schema
 * says. A `boolean` with a string `currentValue` is not a switch with an odd label — it is an agent
 * that means something this version does not, and rendering it as on/off would be a guess.
 */
export function narrowConfigBoolean(
  option: SessionConfigOption | null | undefined,
): ValidSessionConfigBoolean | null {
  if (!option || !isKnownConfigOptionType(option.type) || option.type !== 'boolean') return null;
  if (typeof option.currentValue !== 'boolean') return null;
  return option as ValidSessionConfigBoolean;
}
