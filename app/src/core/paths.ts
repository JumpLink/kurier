/**
 * Where kurier keeps things — this app's answer, resolved from the environment.
 *
 * The one promise: **nothing is ever written inside the repository.** A session file holds the text
 * of a person's conversations with an agent, and this repository is public — a stray session file
 * would be a permanent leak. `.gitignore` is the second line of defence; not writing there is the
 * first, and it lives here.
 *
 * Every function takes the environment as an argument, so a test says "with `XDG_DATA_HOME` set to
 * this" instead of mutating the world to find out where the code writes.
 *
 * The `KurierPaths` shape itself, and `kurierPathsUnder(root)` for a host that hands kurier a
 * directory, are in `@lotse/core`: core takes the paths and never resolves them, and XDG plus the
 * `KURIER_*` overrides are a decision only an app gets to make.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import type { KurierPaths } from '@lotse/core';

/** `$XDG_DATA_HOME`, or the XDG default. An explicit value must be absolute, per the spec. */
export function xdgDataHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['XDG_DATA_HOME']?.trim();
  return explicit && explicit.startsWith('/') ? explicit : join(homedir(), '.local', 'share');
}

/** The per-user data directory. `KURIER_DATA_DIR` overrides it — for a test, or a second install. */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['KURIER_DATA_DIR']?.trim();
  return explicit || join(xdgDataHome(env), 'kurier');
}

/**
 * The session file. Mode `0600`, in a `0700` directory — set explicitly by the store, not
 * inherited from an umask that belongs to whoever started the process.
 */
export function sessionsFile(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['KURIER_SESSIONS_FILE']?.trim();
  return explicit || join(dataDir(env), 'sessions.json');
}

/** `$XDG_CONFIG_HOME`, or the XDG default. An explicit value must be absolute, per the spec. */
export function xdgConfigHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['XDG_CONFIG_HOME']?.trim();
  return explicit && explicit.startsWith('/') ? explicit : join(homedir(), '.config');
}

/**
 * The settings file: a preference, so config rather than data. Mode `0600` in a `0700` directory, like
 * the session file, though it holds no credential and no conversation (`core/settings.ts`).
 */
export function settingsFile(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['KURIER_SETTINGS_FILE']?.trim();
  return explicit || join(xdgConfigHome(env), 'kurier', 'settings.json');
}

/**
 * The dismissed-notices file: ids only, in the data directory. `KURIER_NOTICES_FILE` overrides it.
 */
export function noticesFile(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['KURIER_NOTICES_FILE']?.trim();
  return explicit || join(dataDir(env), 'notices.json');
}

/** The app's defaults: XDG, with the `KURIER_*` overrides, exactly as the functions above resolve them. */
export function kurierPaths(env: NodeJS.ProcessEnv = process.env): KurierPaths {
  return {
    dataDir: dataDir(env),
    configDir: join(xdgConfigHome(env), 'kurier'),
    sessionsFile: sessionsFile(env),
    settingsFile: settingsFile(env),
    noticesFile: noticesFile(env),
  };
}
