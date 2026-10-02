/**
 * From "which agent" to the `AgentCommand` that starts it — pure over detections.
 *
 * Three questions, kept apart: an **explicit** id (`--agent`, `KU_APP_AGENT`) wins and is the launcher as
 * written; **no choice** goes through `resolveAgent` (host install, else the bundled copy); a **recorded**
 * agent (resume, cancel) is the session's own id, never a re-resolution to some other agent.
 *
 * A bundled detection becomes a `bundledCommand`: the program under `BUNDLED_PREFIX`, run in the sandbox,
 * with its own XDG directories (`isolation.ts`) so it never touches the person's opencode config.
 */

import { dirname } from 'node:path';

import { BUNDLED_AGENTS, bundledProgram, type BundledAgent } from './catalog.ts';
import { resolveAgent, type AgentDetection } from './detect.ts';
import { isolationEnv, type IsolationDirs } from './isolation.ts';
import { LAUNCHERS } from './launcher.ts';
import type { AgentCommand } from './stdio.ts';

/** Shown when nothing can be started. Names the way out, not just the lack. */
export const NO_AGENT_MESSAGE =
  'no agent is available — install one (opencode: https://opencode.ai/docs/#install), ' +
  'or use a Flatpak build of kurier, which bundles one';

export type ResolvedSource = 'host' | 'bundled';

export interface ResolvedAgent {
  readonly command: AgentCommand;
  readonly source: ResolvedSource;
  /** The catalog pin for a bundled copy, the host's `--version` otherwise; `null` when unknown. */
  readonly version: string | null;
  /** Where a bundled copy keeps its config, login and data; `null` for a host install. */
  readonly isolation: IsolationDirs | null;
}
/**
 * The command for a bundled copy. `entry.env` is flags (`OPENCODE_DISABLE_AUTOUPDATE`, blanked config
 * variables), never credentials; the isolation variables come last so no flag can point the agent back at
 * the person's own directories.
 */
export function bundledCommand(entry: BundledAgent, dirs: IsolationDirs): AgentCommand {
  return {
    id: entry.id,
    title: `${entry.title} ${entry.version} (bundled)`,
    program: bundledProgram(entry),
    args: [...entry.command],
    env: { ...entry.env, ...isolationEnv(dirs) },
    bundled: true,
  };
}

export interface ResolveContext {
  readonly detections: readonly AgentDetection[];
  /** Where a bundled copy keeps its state: `isolationDirs(dataDir(), id)`. */
  readonly isolationFor: (id: string) => IsolationDirs;
  /**
   * Whether the bundled program for `id` exists, whether or not a host install shadows it in
   * `detections`. `resolveRecorded` needs it: a session recorded as bundled must find its copy even on
   * a machine that has since gained a host install.
   */
  readonly bundledAvailable: (id: string) => boolean;
  readonly launchers?: readonly AgentCommand[];
  readonly catalog?: readonly BundledAgent[];
}

/** What a detection stands for, or `null` when it names a launcher or catalog entry we lack. */
function resolved(detection: AgentDetection, context: ResolveContext): ResolvedAgent | null {
  if (detection.source === 'host') {
    const command = (context.launchers ?? LAUNCHERS).find((entry) => entry.id === detection.id);
    return command ? { command, source: 'host', version: detection.version, isolation: null } : null;
  }
  if (detection.source === 'bundled') {
    const entry = (context.catalog ?? BUNDLED_AGENTS).find((candidate) => candidate.id === detection.id);
    if (!entry) return null;
    const isolation = context.isolationFor(entry.id);
    return {
      command: bundledCommand(entry, isolation),
      source: 'bundled',
      version: detection.version,
      isolation,
    };
  }
  return null;
}

/**
 * The agent to start when the person said nothing. `null` means there is none: the caller prints
 * `NO_AGENT_MESSAGE`.
 */
export function resolveDefault(context: ResolveContext): ResolvedAgent | null {
  const chosen = resolveAgent({ setting: null, detections: context.detections });
  return chosen ? resolved(chosen, context) : null;
}

/** The agent a session recorded, or the reason it cannot be started. */
export type RecordedResolution = { readonly agent: ResolvedAgent } | { readonly problem: string };

/**
 * The agent a session recorded, on the copy that recorded it. A host install and a bundled copy keep
 * separate databases, so a session started on one is unknown to the other: `source` decides, and a copy
 * that is gone is a `problem` naming why — never a quiet fall to the other copy. `source` absent means
 * `host`, which is what every record written before the field existed was.
 *
 * An agent is never swapped for another one either: the history of a session belongs to the agent that
 * held it.
 */
export function resolveRecorded(
  id: string,
  source: ResolvedSource | undefined,
  context: ResolveContext,
): RecordedResolution {
  if (source === 'bundled') {
    const entry = (context.catalog ?? BUNDLED_AGENTS).find((candidate) => candidate.id === id);
    if (!entry || !context.bundledAvailable(id)) {
      return {
        problem:
          `this session was started on the bundled ${id}, which is not in this install. ` +
          `A bundled copy keeps its history apart from any ${id} you installed yourself, so no other ` +
          'copy can resume it',
      };
    }
    const isolation = context.isolationFor(id);
    return {
      agent: {
        command: bundledCommand(entry, isolation),
        source: 'bundled',
        version: entry.version,
        isolation,
      },
    };
  }
  const detection = context.detections.find((entry) => entry.id === id);
  const host = detection?.source === 'host' ? resolved(detection, context) : null;
  if (host) return { agent: host };
  return {
    problem:
      `this session was started on your own ${id} install, which is not found here. ` +
      `The bundled copy keeps a separate history and cannot resume it — install ${id} again (${NO_AGENT_MESSAGE})`,
  };
}

/** One line for stderr saying which copy runs and where its state lives; `null` for a host install. */
export function describeResolved(agent: ResolvedAgent): string | null {
  if (agent.source !== 'bundled') return null;
  // The login is `auth.json` under the data directory and the config sits beside it: both under one root.
  const where = agent.isolation
    ? ` — its login, config and history live in ${dirname(agent.isolation.config)}, apart from your own`
    : '';
  return `using the bundled ${agent.command.id}${agent.version ? ` ${agent.version}` : ''}${where}`;
}
