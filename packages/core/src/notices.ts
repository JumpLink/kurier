/**
 * Which one-time notices exist, and whether one is still owed.
 *
 * The ids and the one predicate over them, because `empty-state.ts` decides what a surface says and has
 * to ask. Where the dismissals are *kept* is the app's decision — the file, its allowlist parser and its
 * writer stay in `app/src/core/notices.ts`, and a host that embeds kurier may remember them its own way.
 */

export type NoticeId = 'bundled-agent';

export const NOTICE_IDS: readonly NoticeId[] = ['bundled-agent'];

/** Whether a notice has not been dismissed yet. */
export function noticeDue(id: NoticeId, seen: readonly string[]): boolean {
  return !seen.includes(id);
}
