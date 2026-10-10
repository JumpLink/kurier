/**
 * Group session records for a sidebar list, under date headers.
 *
 * Pure on purpose: no clock is read here — `now` is a parameter — so a test can pin the calendar
 * and the module stays usable from a surface that already knows the time. It takes a flat list and
 * returns labelled sections; the rest of `app/src/core` owns state, this only buckets.
 *
 * Three decisions in here are deliberate and are the ones a reader is most likely to "fix" wrongly:
 *
 * **1. Local calendar days, not 24-hour windows.** A person reads "Yesterday" as the day before,
 * not as "up to 24 hours ago". At 23:59 the difference between the two readings is a whole day: the
 * rolling-window version calls last night's late session "Today" and this morning's early one
 * "Yesterday", which is the opposite of what happened. So the comparison is on
 * `getFullYear`/`getMonth`/`getDate` — the day the person is living in, per their own clock.
 * The difference is measured between two local midnights, which is why it is rounded and not
 * floored: a DST day is 23 or 25 hours, so a raw division lands on 0.958 or 1.042 and only rounding
 * tells 1 day from 2.
 *
 * **2. Fixed English strings, not `Intl`.** `toLocaleDateString` and `Intl.DateTimeFormat` would be
 * the idiomatic choice, and they would break the test suite in exactly the way that wastes an
 * afternoon: this file's tests run on GJS *and* Node, and the two do not carry the same locale data,
 * so a weekday name or a `HH:MM` differs per runtime and the failure looks like a logic bug. The
 * strings below are the contract, not a fallback.
 *
 * **3. Group, then flatten — never sort and then split.** `byRecency` compares the `updatedAt`
 * strings as text, and a record whose timestamp cannot be parsed (a hand-edited store, a truncated
 * write) is ordered by its garbage characters rather than by a time: the runtime's collation decides
 * whether it collides above the ISO strings or between them, and the two runtimes this suite runs
 * on do not have to agree. A sort-then-split implementation would then emit an `earlier` section,
 * then `today`, then a *second* `earlier`. Grouping first makes each bucket contiguous whatever the
 * sort does, so one section cannot reappear in the middle of the list.
 */

import { byRecency, type SessionRecord } from '@lotse/session';

export type SessionGroupLabel = 'today' | 'yesterday' | 'this-week' | 'earlier';

/** The order the sections are rendered in, oldest last. The sidebar's reading order, top to bottom. */
export const GROUP_ORDER: readonly SessionGroupLabel[] = ['today', 'yesterday', 'this-week', 'earlier'];

/** Header text per section. Fixed English strings — see the note on `Intl` in the file header. */
export const GROUP_TITLES: Readonly<Record<SessionGroupLabel, string>> = {
  today: 'Today',
  yesterday: 'Yesterday',
  'this-week': 'This week',
  earlier: 'Earlier',
};

export interface SessionGroup {
  readonly label: SessionGroupLabel;
  readonly records: readonly SessionRecord[];
}

const MS_PER_DAY = 86_400_000;

/** Short weekday names, indexed by `getDay()` — 0 is Sunday, so the order is not the ISO order. */
const WEEKDAYS: readonly string[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Midnight at the start of the day the given instant falls in, in the local zone.
 *
 * A local constructor call (`new Date(y, m, d)`) rather than a UTC one: the day is the one the
 * person is in. `Date.UTC` with the local components would be shorter and immune to DST, but it
 * would also be a second, quieter definition of "the day", one place to keep right.
 */
function localMidnight(at: Date): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate());
}

/** Calendar days from `then` to `now`: positive when `then` is older, negative when it is ahead. */
function dayDiff(now: Date, then: Date): number {
  // Rounded, not floored: a 23-hour day is 0.958 of 24 and a 25-hour day 1.042, and only the
  // rounding keeps a two-day gap from being reported as one across a spring-forward switch.
  return Math.round((localMidnight(now).getTime() - localMidnight(then).getTime()) / MS_PER_DAY);
}

/**
 * Which section a timestamp belongs to.
 *
 * An unparseable timestamp is `earlier` rather than a throw: a sidebar renders a list, and one
 * corrupt record must not take the whole list down with it. `earlier` is the section nobody is
 * looking at, which is where a record whose age is genuinely unknown belongs.
 */
export function groupOf(updatedAt: string, now: Date): SessionGroupLabel {
  const at = new Date(updatedAt);
  if (Number.isNaN(at.getTime())) return 'earlier';
  const diff = dayDiff(now, at);
  // A negative diff is clock skew, or a session store written by a machine whose time was wrong.
  // The record is not in the future as far as the person is concerned, it is *now* — and it must
  // not vanish into a section, so it stays in `today`, pinned to the top where they will see it.
  if (diff <= 0) return 'today';
  if (diff === 1) return 'yesterday';
  if (diff <= 6) return 'this-week';
  return 'earlier';
}

/**
 * Split a list into its date sections, newest first within each.
 *
 * Buckets first, sort second (see the file header): each section is built by pushing into its own
 * array, so the sections come out contiguous by construction and the input is never sorted in place
 * — the store's array is shared state, and a sidebar render must not reorder it.
 */
export function groupByDate(records: readonly SessionRecord[], now: Date): SessionGroup[] {
  const buckets = new Map<SessionGroupLabel, SessionRecord[]>();
  for (const record of records) {
    const label = groupOf(record.updatedAt, now);
    const bucket = buckets.get(label);
    if (bucket) bucket.push(record);
    else buckets.set(label, [record]);
  }

  const groups: SessionGroup[] = [];
  for (const label of GROUP_ORDER) {
    const bucket = buckets.get(label);
    // An empty section is not rendered at all: a "Yesterday" header above a single entry is a
    // promise the list does not keep, and it moves the entries the person came for.
    if (bucket === undefined || bucket.length === 0) continue;
    groups.push({ label, records: [...bucket].sort(byRecency) });
  }
  return groups;
}

/**
 * The secondary line on a sidebar row: the time of day for today, a weekday for this week, a date
 * for anything older. Follows the section, because a row under "Today" needs no date and a row under
 * "Earlier" cannot use a weekday that is now three weeks old.
 *
 * Empty for an unparseable timestamp — an empty string is the one thing a row can carry that reads
 * as "no time to show" rather than as a wrong one.
 */
export function timeLabelOf(updatedAt: string, now: Date): string {
  const at = new Date(updatedAt);
  if (Number.isNaN(at.getTime())) return '';
  switch (groupOf(updatedAt, now)) {
    case 'today':
      return `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
    case 'yesterday':
      return GROUP_TITLES.yesterday;
    case 'this-week':
      return WEEKDAYS[at.getDay()];
    case 'earlier':
      // ISO order, so the column of dates down the sidebar sorts the way it reads. Local parts, not
      // `toISOString()`: that would be UTC, and a session from late last night would show tomorrow.
      return `${pad4(at.getFullYear())}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`;
  }
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

function pad4(value: number): string {
  return `${value}`.padStart(4, '0');
}
