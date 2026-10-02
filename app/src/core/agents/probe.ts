/**
 * Gather the facts `detectAgents` reasons about. This is the impure half: it walks PATH, asks the host,
 * spawns `--version` and stats a file. Nothing here decides anything.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { BUNDLED_AGENTS, bundledProgram } from './catalog.ts';
import { parseVersionOutput, type AgentFacts } from './detect.ts';
import { LAUNCHERS } from './launcher.ts';
import { currentSandboxFacts, toHostCommand } from './sandbox.ts';
import { which, type AgentCommand } from './stdio.ts';

const VERSION_TIMEOUT_MS = 5000;

/** First non-empty line of `<program> --version`, or `null` for any failure. */
function readVersion(launcher: AgentCommand, program: string): string | null {
  // Inside a Flatpak the found path is a host path, so the call is routed through the same rewrite the
  // agent itself goes through; outside one `toHostCommand` returns the command unchanged.
  const command = toHostCommand({ ...launcher, program, args: ['--version'] }, currentSandboxFacts());
  const result = spawnSync(command.program, command.args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: VERSION_TIMEOUT_MS,
  });
  if (result.status !== 0) return null;
  return parseVersionOutput(result.stdout ?? '');
}

export function gatherAgentFacts(launchers: readonly AgentCommand[] = LAUNCHERS): AgentFacts[] {
  return launchers.map((launcher): AgentFacts => {
    const hostPath = which(launcher.program);
    const entry = BUNDLED_AGENTS.find((candidate) => candidate.id === launcher.id);
    return {
      id: launcher.id,
      hostPath,
      hostVersion: hostPath === null ? null : readVersion(launcher, hostPath),
      bundledExists: entry !== undefined && existsSync(bundledProgram(entry)),
    };
  });
}
