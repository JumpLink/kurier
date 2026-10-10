/**
 * Which agent a command starts — the shared step of `start`, `resume`, `cancel` and `auth`.
 *
 * An explicit `--agent` is the launcher as written, as before. With none, `resolveDefaultWithNote` picks the
 * available setting, else the person's own install, else the bundled copy. A session that recorded its agent gets that agent back
 * (`resolveRecorded`), never a fresh resolution. Each function prints its reason and sets the exit code
 * when it has nothing to return, so a handler only has to stop.
 */

import {
  NO_AGENT_MESSAGE,
  describeResolved,
  gatherResolveContext,
  requireLauncher,
  resolveDefaultWithNote,
  resolveRecorded,
  type LotsePaths,
  type ResolvedAgent,
  type ResolvedSource,
} from '@lotse/core';
import { readSettings } from '../../core/settings.ts';

import { err } from './output.ts';

function announce(agent: ResolvedAgent): ResolvedAgent {
  const line = describeResolved(agent);
  if (line) err(`  ${line}`);
  return agent;
}

/** An agent for a new session, or for `auth`: the explicit launcher, else the default resolution. */
export function agentForNew(paths: LotsePaths, explicit: string | undefined): ResolvedAgent | null {
  if (explicit) {
    return { command: requireLauncher(explicit), source: 'host', version: null, isolation: null };
  }
  const { settings, problem } = readSettings(paths.settingsFile);
  if (problem) err(`  ${problem}`);
  const { agent: found, note } = resolveDefaultWithNote(gatherResolveContext(paths), settings.agent);
  if (note) err(`  ${note}`);
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
export function agentForRecorded(
  paths: LotsePaths,
  id: string,
  source: ResolvedSource | undefined,
): ResolvedAgent | null {
  requireLauncher(id);
  const found = resolveRecorded(id, source, gatherResolveContext(paths));
  if ('problem' in found) {
    err(found.problem);
    process.exitCode = 1;
    return null;
  }
  return announce(found.agent);
}
