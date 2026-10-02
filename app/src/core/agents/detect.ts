/**
 * Which agents are usable, and which one kurier would pick — pure over facts.
 *
 * The facts are gathered elsewhere (`probe.ts`), so everything here is "facts in, answer out" and a test
 * hands in a synthetic machine. Three sources, and the word is a promise: `host` means a program on the
 * person's own PATH, `bundled` means the copy shipped inside this build, `none` means neither was found —
 * a binary that was not found is never reported as bundled.
 *
 * **A host path under `BUNDLED_PREFIX` is not a host install.** It is the bundled copy found by way of a
 * PATH that happens to contain it, and counting it as the person's own is the shadowing the prefix exists
 * to prevent. Its `--version` is dropped with it.
 */

import { BUNDLED_AGENTS, BUNDLED_PREFIX, bundledProgram, type BundledAgent } from './catalog.ts';

/** What the machine said about one launcher id. */
export interface AgentFacts {
  readonly id: string;
  /** Where the host resolved the program, or `null`. */
  readonly hostPath: string | null;
  /** First line of the host binary's `--version`, or `null` when it failed or was not asked. */
  readonly hostVersion: string | null;
  /** Whether the bundled program file exists. */
  readonly bundledExists: boolean;
}

export type AgentSource = 'host' | 'bundled' | 'none';

export interface AgentDetection {
  readonly id: string;
  readonly source: AgentSource;
  readonly path: string | null;
  /** The host's `--version`, or the catalog pin for a bundled copy; `null` when unknown. */
  readonly version: string | null;
}

/**
 * The version string out of a `--version` run's stdout: its first non-empty line, trimmed. Anything a
 * login shell printed ahead of it is not the version, and anything after it is not either.
 */
export function parseVersionOutput(stdout: string): string | null {
  const line = stdout.split(/\r?\n/).find((entry) => entry.trim() !== '');
  return line ? line.trim() : null;
}

function underPrefix(path: string): boolean {
  return path === BUNDLED_PREFIX || path.startsWith(`${BUNDLED_PREFIX}/`);
}

export function detectAgents(
  facts: readonly AgentFacts[],
  catalog: readonly BundledAgent[] = BUNDLED_AGENTS,
): AgentDetection[] {
  return facts.map((fact): AgentDetection => {
    if (fact.hostPath !== null && !underPrefix(fact.hostPath)) {
      return { id: fact.id, source: 'host', path: fact.hostPath, version: fact.hostVersion };
    }
    const entry = catalog.find((candidate) => candidate.id === fact.id);
    if (fact.bundledExists && entry) {
      return { id: fact.id, source: 'bundled', path: bundledProgram(entry), version: entry.version };
    }
    return { id: fact.id, source: 'none', path: null, version: null };
  });
}

/**
 * The agent kurier would use now: the setting if that agent is available, else the first host install,
 * else the first bundled copy, else `null`.
 *
 * A person's own install comes before the bundled one because it is the one that carries their login and
 * config; kurier cannot tell whether either is logged in and does not try (AGENTS.md § Privacy).
 */
export function resolveAgent(input: {
  readonly setting: string | null;
  readonly detections: readonly AgentDetection[];
}): AgentDetection | null {
  const { setting, detections } = input;
  const chosen = setting === null ? undefined : detections.find((entry) => entry.id === setting);
  if (chosen && chosen.source !== 'none') return chosen;
  return (
    detections.find((entry) => entry.source === 'host') ??
    detections.find((entry) => entry.source === 'bundled') ??
    null
  );
}
