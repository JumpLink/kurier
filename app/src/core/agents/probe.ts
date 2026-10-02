/**
 * Gather the facts `detectAgents` reasons about. This is the impure half: it walks PATH, asks the host,
 * spawns `--version` and stats a file. Nothing here decides anything.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';

import { BUNDLED_AGENTS, bundledProgram } from './catalog.ts';
import { dataDir } from '../paths.ts';
import { detectAgents, parseVersionOutput, type AgentFacts } from './detect.ts';
import { isolationDirs } from './isolation.ts';
import { LAUNCHERS } from './launcher.ts';
import type { CwdFacts } from '../cwd.ts';
import type { ResolveContext } from './resolve.ts';
import {
  FLATPAK_SPAWN,
  currentSandboxFacts,
  hostCwdArgv,
  isSandboxed,
  toHostCommand,
  type SandboxFacts,
} from './sandbox.ts';
import { parseHostProbeOutput, which, whichAsync, type AgentCommand } from './stdio.ts';

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

const NO_HOST: SandboxFacts = { flatpakInfoExists: false };

/**
 * `readVersions: false` skips the `--version` spawn (up to 5 s per launcher). Detection needs only the
 * path; the version is cosmetic, so the preferences dialog asks for none.
 *
 * `probeHost: false` also skips the one other child: inside a Flatpak, `which` asks the host's shell
 * (`flatpak-spawn`, up to 5 s per launcher) when the sandbox's own PATH has nothing. Outside a Flatpak
 * there is no such question, so the flag changes nothing there.
 */
export function gatherAgentFacts(
  launchers: readonly AgentCommand[] = LAUNCHERS,
  readVersions = true,
  probeHost = true,
): AgentFacts[] {
  return launchers.map((launcher): AgentFacts => {
    const hostPath = which(launcher.program, process.env, probeHost ? currentSandboxFacts() : NO_HOST);
    const entry = BUNDLED_AGENTS.find((candidate) => candidate.id === launcher.id);
    return {
      id: launcher.id,
      hostPath,
      hostVersion: hostPath === null || !readVersions ? null : readVersion(launcher, hostPath),
      bundledExists: entry !== undefined && existsSync(bundledProgram(entry)),
    };
  });
}

/**
 * The facts without a blocking child: every host question is awaited, and no `--version` is read. The
 * answer a surface shows after the cheap `gatherResolveContext(env, false, false)` has been drawn.
 */
export async function gatherAgentFactsAsync(
  launchers: readonly AgentCommand[] = LAUNCHERS,
): Promise<AgentFacts[]> {
  return Promise.all(
    launchers.map(async (launcher): Promise<AgentFacts> => {
      const entry = BUNDLED_AGENTS.find((candidate) => candidate.id === launcher.id);
      return {
        id: launcher.id,
        hostPath: await whichAsync(launcher.program),
        hostVersion: null,
        bundledExists: entry !== undefined && existsSync(bundledProgram(entry)),
      };
    }),
  );
}

export async function gatherResolveContextAsync(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolveContext> {
  return resolveContextFrom(env, await gatherAgentFactsAsync());
}

/** The impure half of resolution: probe this machine once, and say where a bundled copy keeps its state. */
export function gatherResolveContext(
  env: NodeJS.ProcessEnv = process.env,
  readVersions = true,
  probeHost = true,
): ResolveContext {
  return resolveContextFrom(env, gatherAgentFacts(LAUNCHERS, readVersions, probeHost));
}

function resolveContextFrom(env: NodeJS.ProcessEnv, facts: readonly AgentFacts[]): ResolveContext {
  return {
    detections: detectAgents(facts),
    isolationFor: (id) => isolationDirs(dataDir(env), id),
    bundledAvailable: (id) => {
      const entry = BUNDLED_AGENTS.find((candidate) => candidate.id === id);
      return entry !== undefined && existsSync(bundledProgram(entry));
    },
  };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The facts `resolveCwd` reasons about. Inside a Flatpak the host is asked once, synchronously and
 * bounded, like the agent probe — it runs before the window exists, so nothing is drawn yet to freeze.
 * An unanswered host is `null`, and `resolveCwd` falls through to `$HOME`.
 */
export function gatherCwdFacts(env: NodeJS.ProcessEnv = process.env): CwdFacts {
  const sandbox = currentSandboxFacts();
  const argv = hostCwdArgv(sandbox);
  let hostCwd: string | null = null;
  if (argv) {
    const result = spawnSync(FLATPAK_SPAWN, argv, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: VERSION_TIMEOUT_MS,
    });
    if (result.status === 0) hostCwd = parseHostProbeOutput(result.stdout ?? '');
  }
  return {
    sandboxed: isSandboxed(sandbox),
    processCwd: process.cwd(),
    hostCwd,
    home: env['HOME']?.trim() || homedir() || null,
    exists: isDirectory,
  };
}
