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
 * `assertScopeIsNotAuthority` in `@kurier/acp` is the runtime canary over the same idea, because a
 * TypeScript type cannot stop a later `{ ...session, grants: [...] }`. The canary is what makes
 * this type more than a comment.
 *
 * `boundTo` is optional **on purpose**: kurier has to run standalone, with no postbote anywhere
 * near it. A messenger integration binds a session to a conversation later; a person at a terminal
 * does not. Nothing else changes.
 */

import { assertScopeIsNotAuthority } from '@kurier/acp/gate';
import type { SessionId } from '@kurier/acp/types';

/** Who is in the session. `'local'` is the only value Scheibe 1 can produce. */
export type Principal = string;

/** The stand-in principal for a person at a terminal. A real name arrives with a real surface. */
export const LOCAL_PRINCIPAL: Principal = 'local';

export type EntryKind = 'user' | 'agent' | 'thought' | 'tool' | 'system';

/**
 * One line of the transcript.
 *
 * The transcript is a *record of what happened*, not a re-derivation of it: an agent's own
 * `session/load` is the authority on history, and kurier's copy exists so `kurier sessions` and
 * `kurier resume` can show something without spawning a process. A transcript that claimed more
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

export interface SessionRecord {
  /** The agent's own session id. Opaque; kurier stores it and hands it back, never parses it. */
  id: SessionId;
  /** Which adapter started the agent, e.g. `opencode`. */
  agent: string;
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

/** What `kurier start` needs to open a session. The clock is injected, so the model stays pure. */
export interface NewSession {
  id: SessionId;
  agent: string;
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

/** The label a human sees: the title, else the first line of the agent's answer, else the id. */
export function labelOf(record: SessionRecord): string {
  if (record.title) return record.title;
  const first = record.turns.find((turn) => turn.kind === 'agent')?.text.trim();
  if (first) return first.length > 72 ? `${first.slice(0, 72)}…` : first;
  return record.id;
}
