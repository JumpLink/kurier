/**
 * The gate a CLI command hands to the client, and the terminal it lives on.
 *
 * Both `start` and `resume` need the same eight lines — the same gate, the same decision log — and
 * they had it twice, copied. Duplication in the decision path is worse than duplication anywhere
 * else: the two copies drift, and the one that drifts is the one nobody re-reads, because the
 * reading part of the command is the interesting part.
 *
 * The rule this file exists to keep visible: **the gate is chosen once, before the agent starts.**
 * There is no path that upgrades a gate mid-run. A client that could switch from asking to allowing
 * while a turn is in flight is a client whose policy is its lifecycle, and a lifecycle is not
 * something a flag may edit.
 */

import type { ClientGate } from '@lotse/acp/gate';
import { terminalGate, type Terminal } from '@lotse/core';

import { err } from './output.ts';

export interface GateOptions {
  terminal: Terminal;
  /** Refuse everything without asking. The only switch; it never upgrades, only ever denies more. */
  denyAll?: boolean;
}

/**
 * Fail closed by construction: the denied branch does not reach the terminal at all, so `--deny-all`
 * on a terminal is exactly as quiet as on a pipe.
 */
export function commandGate(options: GateOptions): ClientGate {
  if (options.denyAll === true) return { permission: () => null };
  return {
    permission: terminalGate({
      terminal: options.terminal,
      onDecision: (optionId) => {
        err(`  → ${optionId === null ? 'declined' : `granted (${optionId})`}`);
      },
    }),
  };
}

/** The gate for commands that ask for nothing: `cancel`, `auth`, `agents`. */
export function silentGate(): ClientGate {
  return { permission: () => null };
}
