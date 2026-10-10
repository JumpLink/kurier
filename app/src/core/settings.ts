/**
 * What a person chose, kept between runs: today only which agent to start.
 *
 * **No secret can live here, by construction.** `parseSettings` is an allowlist — `version`, `agent`,
 * and inside `agent` an `id` and a `source` — so a `token`, `apiKey` or `password` is rejected as an
 * unknown field (and named as secret-looking, so the message says why). kurier stores no credential
 * (AGENTS.md § Privacy); a setting is a preference, and the file is `derived`: choosing again
 * recreates it.
 *
 * **A bad file never stops startup.** `readSettings` returns the defaults plus a `problem` the caller
 * reports; only a write that fails throws, because that one is a person's explicit action.
 *
 * **A file kurier could not read is never destroyed by a save.** `readSettings` also says what kind of
 * problem it was, and `saveDecision` turns that into one of three answers: write, move the old file to
 * `settings.json.bak` first, or refuse (a newer kurier wrote it, or it could not be read at all — in both
 * cases kurier does not know what is in it). `saveSettings` is the one writer that applies it.
 *
 * `AgentChoice` names a launcher id *and* a source, so "the bundled opencode" and "my opencode" are two
 * different choices: they keep separate logins and histories (`core/agents/isolation.ts`). The choice
 * itself, and `describeChoice`, are in `@lotse/core` with the resolution that reads them; this file is
 * only the file it is kept in.
 */

import { chmodSync, readFileSync, renameSync } from 'node:fs';

import type { AgentChoice } from '@lotse/core';

import { writePrivateFile } from './private-file.ts';

export interface Settings {
  readonly version: 1;
  readonly agent: AgentChoice | null;
}

export const SETTINGS_VERSION = 1;

export const DEFAULT_SETTINGS: Settings = { version: SETTINGS_VERSION, agent: null };

/**
 * What was wrong with a settings file. `newer-version`: a higher `version` number, so a newer kurier wrote
 * it. `unreadable`: the file exists and could not be read. `invalid`: anything else — bad JSON, an unknown
 * or secret-looking key, a malformed choice, a version that is not a number above this one.
 */
export type SettingsProblemKind = 'newer-version' | 'invalid' | 'unreadable';

export type ParsedSettings =
  | { readonly settings: Settings }
  | { readonly problem: string; readonly kind: SettingsProblemKind };

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const SECRET_LOOKING = /token|secret|password|passwd|credential|auth|api[-_]?key|key/i;

function unknownField(path: string, key: string): string {
  return SECRET_LOOKING.test(key)
    ? `unknown field "${path}${key}" — settings hold no credential, so a secret-looking field is never accepted`
    : `unknown field "${path}${key}"`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The settings in a file's text. Pure: a clear `problem` for anything this version does not know —
 * invalid JSON, an unknown version, an unknown field — never a throw.
 */
export function parseSettings(raw: string): ParsedSettings {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return {
      problem: `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      kind: 'invalid',
    };
  }
  if (!isRecord(value)) return { problem: 'not a settings object', kind: 'invalid' };
  // A newer kurier may also have added keys, so the kind is decided by the version alone; the message
  // still names whichever problem comes first.
  const version = value['version'];
  const kind: SettingsProblemKind =
    typeof version === 'number' && version > SETTINGS_VERSION ? 'newer-version' : 'invalid';
  for (const key of Object.keys(value)) {
    if (key !== 'version' && key !== 'agent') return { problem: unknownField('', key), kind };
  }
  if (version !== SETTINGS_VERSION) {
    return {
      problem: `settings version ${JSON.stringify(version)} is not known (this kurier reads version ${SETTINGS_VERSION})`,
      kind,
    };
  }
  const agent = value['agent'];
  if (agent === undefined || agent === null) return { settings: DEFAULT_SETTINGS };
  if (!isRecord(agent)) {
    return { problem: '"agent" must be an object with an id and a source, or null', kind };
  }
  for (const key of Object.keys(agent)) {
    if (key !== 'id' && key !== 'source') return { problem: unknownField('agent.', key), kind };
  }
  const { id, source } = agent;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    return { problem: '"agent.id" must be a launcher id such as "opencode"', kind };
  }
  if (source !== 'host' && source !== 'bundled') {
    return { problem: '"agent.source" must be "host" or "bundled"', kind };
  }
  return { settings: { version: SETTINGS_VERSION, agent: { id, source } } };
}

/**
 * `<id>`, `<id>:host`, `<id>:bundled` — the spelling `lotse agents --use` takes. A bare id means the
 * person's own install. `none` clears the choice (the GUI calls that Automatic). `known` limits the ids a person may *write*; the
 * file itself may still name an id this build lacks, and that is reported at resolution, not here.
 */
export function parseChoiceSpec(
  spec: string,
  known: readonly string[],
): { readonly choice: AgentChoice | null } | { readonly problem: string } {
  const text = spec.trim();
  if (text === 'none') return { choice: null };
  const [id = '', source = 'host', ...rest] = text.split(':');
  if (rest.length > 0 || (source !== 'host' && source !== 'bundled')) {
    return { problem: `"${spec}" is not <id>, <id>:host or <id>:bundled` };
  }
  if (!known.includes(id)) {
    return { problem: `"${id}" is not an agent launcher — try one of: ${known.join(', ')}` };
  }
  return { choice: { id, source } };
}

export interface SettingsRead {
  readonly settings: Settings;
  /** Why the file was not used, or `null`. Defaults stand in whenever this is set. */
  readonly problem: string | null;
  /** What kind of problem, or `null` exactly when `problem` is. */
  readonly problemKind: SettingsProblemKind | null;
}

/** The settings at `path`. A missing file is the defaults with no problem; a bad one is the defaults and a problem. */
export function readSettings(path: string): SettingsRead {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { settings: DEFAULT_SETTINGS, problem: null, problemKind: null };
    return {
      settings: DEFAULT_SETTINGS,
      problem: `${path} could not be read (${error instanceof Error ? error.message : String(error)}) — using defaults`,
      problemKind: 'unreadable',
    };
  }
  const parsed = parseSettings(raw);
  if ('problem' in parsed) {
    return {
      settings: DEFAULT_SETTINGS,
      problem: `${path}: ${parsed.problem} — using defaults`,
      problemKind: parsed.kind,
    };
  }
  return { settings: parsed.settings, problem: null, problemKind: null };
}

export type SaveDecision = 'write' | 'backup-then-write' | 'refuse';

/**
 * What a save may do to the file it finds, from what `readSettings` said about it. Pure, and the whole of
 * the rule: no problem → write; a file kurier read but did not accept → keep a copy, then write; a file it
 * does not understand (written by a newer kurier) or could not read → leave it alone.
 */
export function saveDecision(kind: SettingsProblemKind | null): SaveDecision {
  if (kind === null) return 'write';
  return kind === 'invalid' ? 'backup-then-write' : 'refuse';
}

/** Where the old file goes: next to it, `.bak` appended. */
export function backupPath(path: string): string {
  return `${path}.bak`;
}

/**
 * Save a choice the way `saveDecision` says. Returns where the old file was moved, or `null` when there was
 * nothing to move; throws when the decision is to refuse, naming why. The `.bak` is `0600` and replaces an
 * older one — one generation, so a repeated mistake cannot grow a pile of copies.
 */
export function saveSettings(path: string, settings: Settings): { readonly backup: string | null } {
  const read = readSettings(path);
  const decision = saveDecision(read.problemKind);
  if (decision === 'refuse') {
    throw new Error(`${read.problem ?? path} — not overwriting it`);
  }
  let backup: string | null = null;
  if (decision === 'backup-then-write') {
    backup = backupPath(path);
    renameSync(path, backup);
    chmodSync(backup, 0o600);
  }
  writeSettings(path, settings);
  return { backup };
}

/**
 * Write the settings: a sibling temp file, fsync, rename — the session store's recipe, so a crash leaves
 * the old file or the new one. File `0600`, a directory kurier creates `0700`. An existing directory is
 * left alone: `LOTSE_SETTINGS_FILE` may point into a shared one, and narrowing its mode is not ours to do.
 */
export function writeSettings(path: string, settings: Settings): void {
  writePrivateFile(path, `${JSON.stringify(settings, null, 2)}\n`, 'settings');
}
