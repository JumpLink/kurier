/**
 * Which agent a command starts — the shared step of `start`, `resume`, `cancel` and `auth`.
 *
 * An explicit `--agent` is the launcher as written, as before. With none, `resolveDefault` picks the
 * person's own install, else the bundled copy. A session that recorded its agent gets that agent back
 * (`resolveRecorded`), never a fresh resolution. Each function prints its reason and sets the exit code
 * when it has nothing to return, so a handler only has to stop.
 */

import { requireLauncher } from '../../core/agents/launcher.ts';
import { gatherResolveContext } from '../../core/agents/probe.ts';
import {
  describeResolved,
  NO_AGENT_MESSAGE,
  resolveDefault,
  resolveRecorded,
  type ResolvedAgent,
  type ResolvedSource,
} from '../../core/agents/resolve.ts';

import { err } from './output.ts';

function announce(agent: ResolvedAgent): ResolvedAgent {
  const line = describeResolved(agent);
  if (line) err(`  ${line}`);
  return agent;
}

/** An agent for a new session, or for `auth`: the explicit launcher, else the default resolution. */
export function agentForNew(explicit: string | undefined): ResolvedAgent | null {
  if (explicit) {
    return { command: requireLauncher(explicit), source: 'host', version: null, isolation: null };
  }
  const found = resolveDefault(gatherResolveContext());
  if (!found) {
    err(NO_AGENT_MESSAGE);
    process.exitCode = 1;
    return null;
  }
  return announce(found);
}

/**
 * The agent a recorded session names, on the copy that started it. `requireLauncher` first, so an unknown
 * id gets its menu; a copy that is gone prints why and sets the exit code.
 */
export function agentForRecorded(id: string, source: ResolvedSource | undefined): ResolvedAgent | null {
  requireLauncher(id);
  const found = resolveRecorded(id, source, gatherResolveContext());
  if ('problem' in found) {
    err(found.problem);
    process.exitCode = 1;
    return null;
  }
  return announce(found.agent);
}
