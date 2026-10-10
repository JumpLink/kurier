/**
 * Where a new conversation runs — pure over facts, like `agents/detect.ts`.
 *
 * `LOTSE_CWD` wins, then the directory the person started lotse from, then `$HOME`. "The directory
 * lotse was started from" is two different questions: outside a Flatpak it is `process.cwd()`; inside
 * one the sandbox's own cwd is the app's, not the person's, so the host is asked (`hostCwd`, gathered by
 * `probe.ts`). A candidate that is not an absolute path to something that exists falls through to the
 * next one: a session whose `cwd` is gone would fail at `session/new` with a message about a path the
 * person never typed.
 */

import { envKnob } from './env.ts';

export interface CwdFacts {
  /** Whether lotse runs inside a Flatpak, i.e. whether `hostCwd` is the one to believe. */
  readonly sandboxed: boolean;
  /** `process.cwd()`. */
  readonly processCwd: string;
  /** The host shell's cwd, or `null` when it could not be asked. Only read when `sandboxed`. */
  readonly hostCwd: string | null;
  readonly home: string | null;
  /** Whether a directory exists. Injected so the rule is testable without a filesystem. */
  readonly exists: (path: string) => boolean;
}

/** The directory a new conversation starts in, or `null` when no candidate exists (no `$HOME` either). */
export function resolveCwd(env: Record<string, string | undefined>, facts: CwdFacts): string | null {
  const candidates = [envKnob(env, 'CWD'), facts.sandboxed ? facts.hostCwd : facts.processCwd, facts.home];
  for (const candidate of candidates) {
    if (candidate && candidate.startsWith('/') && facts.exists(candidate)) return candidate;
  }
  return null;
}

/**
 * The path as a person reads it: home abbreviated to `~`. A path that merely starts with the same
 * letters (`/home/pascal2`) is not under `/home/pascal`, so the boundary is checked.
 */
export function displayCwd(cwd: string, home: string | null): string {
  if (!home || home === '/') return cwd;
  if (cwd === home) return '~';
  return cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
}
