/**
 * Which one-time notices a person has dismissed, kept between runs.
 *
 * The file holds notice ids and nothing else (`parseNotices` is an allowlist, like the settings), so no
 * conversation and no credential can be in it; it is `derived` — pressing "Got it" again recreates it.
 * **A bad file never stops startup**: `readNotices` returns "nothing seen" plus a `problem`, so the notice
 * is shown again rather than the window failing.
 *
 * The ids and `noticeDue` are in `@kurier/core`, next to the empty state that asks; what is here is the
 * file around them.
 */

import { readFileSync } from 'node:fs';

import { NOTICE_IDS, type NoticeId } from '@kurier/core';

import { writePrivateFile } from './private-file.ts';

export interface Notices {
  readonly version: 1;
  readonly seen: readonly NoticeId[];
}

export const NOTICES_VERSION = 1;

export const DEFAULT_NOTICES: Notices = { version: NOTICES_VERSION, seen: [] };

export type ParsedNotices = { readonly notices: Notices } | { readonly problem: string };

/** The notices in a file's text. Pure; an id this build does not know is left out, never an error. */
export function parseNotices(raw: string): ParsedNotices {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return { problem: `not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { problem: 'not a notices object' };
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'version' && key !== 'seen') return { problem: `unknown field "${key}"` };
  }
  if (record['version'] !== NOTICES_VERSION) {
    return { problem: `notices version ${JSON.stringify(record['version'])} is not known` };
  }
  const seen = record['seen'];
  if (!Array.isArray(seen) || seen.some((entry) => typeof entry !== 'string')) {
    return { problem: '"seen" must be a list of notice ids' };
  }
  return {
    notices: {
      version: NOTICES_VERSION,
      seen: NOTICE_IDS.filter((id) => (seen as string[]).includes(id)),
    },
  };
}

export function markSeen(notices: Notices, id: NoticeId): Notices {
  return notices.seen.includes(id) ? notices : { version: NOTICES_VERSION, seen: [...notices.seen, id] };
}

export interface NoticesRead {
  readonly notices: Notices;
  readonly problem: string | null;
}

/** The notices at `path`. Missing is nothing seen with no problem; a bad or unreadable file is nothing seen and a problem. */
export function readNotices(path: string): NoticesRead {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { notices: DEFAULT_NOTICES, problem: null };
    return {
      notices: DEFAULT_NOTICES,
      problem: `${path} could not be read (${error instanceof Error ? error.message : String(error)}) — showing notices again`,
    };
  }
  const parsed = parseNotices(raw);
  if ('problem' in parsed) {
    return { notices: DEFAULT_NOTICES, problem: `${path}: ${parsed.problem} — showing notices again` };
  }
  return { notices: parsed.notices, problem: null };
}

export function writeNotices(path: string, notices: Notices): void {
  writePrivateFile(path, `${JSON.stringify(notices, null, 2)}\n`, 'notices');
}
