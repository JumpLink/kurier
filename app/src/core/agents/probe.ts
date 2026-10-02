/**
 * Gather the facts `detectAgents` reasons about. This is the impure half: it walks PATH, asks the host,
 * spawns `--version` and stats a file. Nothing here decides anything.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { BUNDLED_AGENTS, bundledProgram } from './catalog.ts';
import { dataDir } from '../paths.ts';
import { detectAgents, parseVersionOutput, type AgentFacts } from './detect.ts';
import { isolationDirs } from './isolation.ts';
import { LAUNCHERS } from './launcher.ts';
import type { ResolveContext } from './resolve.ts';
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

/**
 * `readVersions: false` skips the `--version` spawn (up to 5 s per launcher). Detection needs only the
 * path; the version is cosmetic, so the window asks for none and never waits on a child at startup.
 */
export function gatherAgentFacts(
  launchers: readonly AgentCommand[] = LAUNCHERS,
  readVersions = true,
): AgentFacts[] {
  return launchers.map((launcher): AgentFacts => {
    const hostPath = which(launcher.program);
    const entry = BUNDLED_AGENTS.find((candidate) => candidate.id === launcher.id);
    return {
      id: launcher.id,
      hostPath,
      hostVersion: hostPath === null || !readVersions ? null : readVersion(launcher, hostPath),
      bundledExists: entry !== undefined && existsSync(bundledProgram(entry)),
    };
  });
}

/** The impure half of resolution: probe this machine once, and say where a bundled copy keeps its state. */
export function gatherResolveContext(
  env: NodeJS.ProcessEnv = process.env,
  readVersions = true,
): ResolveContext {
  return {
    detections: detectAgents(gatherAgentFacts(LAUNCHERS, readVersions)),
    isolationFor: (id) => isolationDirs(dataDir(env), id),
    bundledAvailable: (id) => {
      const entry = BUNDLED_AGENTS.find((candidate) => candidate.id === id);
      return entry !== undefined && existsSync(bundledProgram(entry));
    },
  };
}
