/**
 * The session record — what a kurier session *is*.
 *
 * The design rule that shaped this file, taken from beifahrer's ADR 0006 ("recipes are data and
 * hold no gate") and restated for sessions: **a session is a scope, not a permission.** The record
 * below says what is *reachable* — which agent, which directory, which conversation it belongs to.
 * It cannot say what is *allowed*, because there is no field for it. There is no allow-list to
 * store, therefore none to hand on, therefore a session passed around in a group chat is a
 * corridor and not a key.
 *
 * `assertScopeIsNotAuthority` in `@lotse/acp` is the runtime canary over the same idea, because a
 * TypeScript type cannot stop a later `{ ...session, grants: [...] }`. The canary is what makes
 * this type more than a comment.
 *
 * `boundTo` is optional **on purpose**: kurier has to run standalone, with no postbote anywhere
 * near it. A messenger integration binds a session to a conversation later; a person at a terminal
 * does not. Nothing else changes.
 */

import { assertScopeIsNotAuthority } from '@lotse/acp/gate';
import type { SessionId } from '@lotse/acp/types';

/** Who is in the session. `'local'` is the only value Scheibe 1 can produce. */
export type Principal = string;

/** The stand-in principal for a person at a terminal. A real name arrives with a real surface. */
export const LOCAL_PRINCIPAL: Principal = 'local';

export type EntryKind = 'user' | 'agent' | 'thought' | 'tool' | 'system';

/**
 * One line of the transcript.
 *
 * The transcript is a *record of what happened*, not a re-derivation of it: an agent's own
 * `session/load` is the authority on history, and kurier's copy exists so `lotse sessions` and
 * `lotse resume` can show something without spawning a process. A transcript that claimed more
 * than that would be a second source of truth about someone else's conversation.
 */
export interface TranscriptEntry {
  kind: EntryKind;
  text: string;
  /** ISO 8601. Supplied by the caller, so the model stays pure and a test can pin the clock. */
  at: string;
  /** The agent's `sessionId`, when the entry came from a session that has one. */
  sessionId?: SessionId;
  /** A tool call's `toolCallId`, for `kind: 'tool'`. */
  toolCallId?: string;
}

/**
 * Which copy of the agent holds a session's history: the person's own install (`host`) or the copy
 * shipped inside the build (`bundled`). The two keep separate databases, so `resume` has to go back
 * to the one that has the session. A label, never a permission.
 */
export type AgentSource = 'host' | 'bundled';

export interface SessionRecord {
  /** The agent's own session id. Opaque; kurier stores it and hands it back, never parses it. */
  id: SessionId;
  /** Which adapter started the agent, e.g. `opencode`. */
  agent: string;
  /**
   * Which copy of `agent` started the session. **Absent means `host`**: records written before this
   * field existed were all started on the person's own install.
   */
  agentSource?: AgentSource;
  /** The working directory the session runs in. Part of its *scope*, so part of the record. */
  cwd: string;
  principal: Principal;
  /**
   * What this session is bound to in the wider suite — a postbote conversation, later. `null`
   * means standalone, and standalone is a first-class case, not a missing feature.
   */
  boundTo: string | null;
  createdAt: string;
  updatedAt: string;
  title: string | null;
  /** How this session is put back in front of an agent. Recorded, then honoured on resume. */
  reattach: 'load' | 'resume' | null;
  turns: TranscriptEntry[];
}

/** What `lotse start` needs to open a session. The clock is injected, so the model stays pure. */
export interface NewSession {
  id: SessionId;
  agent: string;
  agentSource?: AgentSource;
  cwd: string;
  principal?: Principal;
  boundTo?: string | null;
  title?: string | null;
  reattach?: 'load' | 'resume' | null;
  at: string;
}

export function newSession(input: NewSession): SessionRecord {
  const record: SessionRecord = {
    id: input.id,
    agent: input.agent,
    cwd: input.cwd,
    principal: input.principal ?? LOCAL_PRINCIPAL,
    boundTo: input.boundTo ?? null,
    createdAt: input.at,
    updatedAt: input.at,
    title: input.title ?? null,
    reattach: input.reattach ?? null,
    turns: [],
  };
  // Left off the record when not given, so a record stays byte-identical to what older kurier wrote.
  if (input.agentSource) record.agentSource = input.agentSource;
  assertScopeIsNotAuthority(record as unknown as Record<string, unknown>);
  return record;
}

/**
 * Append transcript lines. Mutates nothing: the store persists, so an update that cannot be written
 * must not be visible in memory either. Returns a new record.
 */
export function appendTurns(record: SessionRecord, entries: TranscriptEntry[]): SessionRecord {
  if (entries.length === 0) return record;
  const at = entries[entries.length - 1]?.at ?? record.updatedAt;
  return { ...record, turns: [...record.turns, ...entries], updatedAt: at };
}

/**
 * Stamp `updatedAt` without adding anything.
 *
 * Exists for the case a record is edited without a new transcript line — a rename, a re-bind.
 * A turn write goes through `appendTurns`, which sets the timestamp from the entry itself, so
 * that the recorded time is when the thing happened rather than when it was saved.
 */
export function touch(record: SessionRecord, at: string): SessionRecord {
  return { ...record, updatedAt: at };
}

/** Bound sessions first for the same principal, then newest — the order a list wants. */
export function byRecency(a: SessionRecord, b: SessionRecord): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}

export function forPrincipal(records: SessionRecord[], principal: Principal): SessionRecord[] {
  return records.filter((record) => record.principal === principal);
}

/**
 * The label a human sees: the title, else the agent's opening answer, else the id.
 *
 * "Opening answer" means the **whole run of leading agent turns**, not the first one. An agent's
 * reply arrives as `session/update` chunks and a stream boundary lands wherever the model happened
 * to emit — measured: a one-word answer split into `RESUME-` and `OK`, two turns, and a `kurier
 * sessions` row labelled `RESUME-`. Joining until the first user turn is what makes the label a
 * sentence rather than a fragment of one.
 */
export function labelOf(record: SessionRecord): string {
  if (record.title) return record.title;
  const parts: string[] = [];
  for (const turn of record.turns) {
    if (turn.kind === 'agent') {
      parts.push(turn.text);
      continue;
    }
    // A `thought` or `tool` line before the answer is not part of it and is skipped; one *between*
    // the answer's chunks ends the run. Concatening across it would splice "reading the file" into
    // a sentence that never contained it.
    if (parts.length > 0) break;
  }
  // Trim once, at the end. Trimming each chunk before joining glues words together at the seam —
  // `'first '` + `'answer'` becomes `'firstanswer'` — which is the same mid-word artefact this
  // function exists to remove. Caught by the test that asserts the joined form.
  const joined = parts.join('').trim();
  if (!joined) return record.id;
  return joined.length > 72 ? `${joined.slice(0, 72)}…` : joined;
}
