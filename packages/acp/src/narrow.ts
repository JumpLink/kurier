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

import { SESSION_UPDATE_KINDS, type AnySessionUpdate, type KnownSessionUpdate } from './types.ts';

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
