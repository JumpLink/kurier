/**
 * The launcher table.
 *
 * **This is a table of programs, not of capabilities.** It says which binary to start for which
 * name — and nothing else. The plan's guardrail is explicit that kurier builds no central
 * capability registry ("not even in gjsify: it would be exactly the gate beifahrer forbids, only
 * one level up and therefore worse, because it looks neutral"), and a table that grew a
 * `canReadFiles: true` column would be that registry with a different name. If you find yourself
 * wanting to add a column here, the thing you are adding belongs in the gate, next to a human or a
 * policy that answers.
 *
 * Adding an agent is three lines: an `AgentCommand`, an entry here, and a test.
 */

import { OPENCODE_COMMAND } from './opencode.ts';
import type { AgentCommand } from './stdio.ts';

/** The agent commands kurier knows how to start from the person's PATH. Only opencode today. */
export const LAUNCHERS: readonly AgentCommand[] = [OPENCODE_COMMAND];

/** The adapter id used when nothing else chose one. */
export const DEFAULT_AGENT = OPENCODE_COMMAND.id;

/** The ids of `LAUNCHERS`, for an error message or a menu. */
export function launcherIds(): string[] {
  return LAUNCHERS.map((entry) => entry.id);
}

/** The launcher with this id, or `undefined`. */
export function findLauncher(id: string): AgentCommand | undefined {
  return LAUNCHERS.find((entry) => entry.id === id);
}

/** Throws with the list of what does exist — an unknown name is a typo, and a menu fixes it. */
export function requireLauncher(id: string): AgentCommand {
  const found = findLauncher(id);
  if (found) return found;
  throw new Error(`no agent launcher called "${id}" — try one of: ${launcherIds().join(', ')}`);
}
