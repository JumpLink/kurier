/**
 * When a task runs: an interval, or a time of day on chosen weekdays.
 *
 * Two shapes and nothing in between, on purpose. `{ "every": "30m" }` is a poll; `{ "at": "07:30",
 * "days": ["mon", "fri"] }` is a calendar entry in local time. A cron string would be a third
 * language in the task file for a person to get wrong at 2 a.m., and every task ADR 0002 names fits
 * one of the two.
 *
 * Pure over its arguments: the clock is a parameter, so "is this due" is a test, not a wait.
 */

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export type Schedule =
  | { readonly kind: 'every'; readonly ms: number; readonly spec: string }
  | {
      readonly kind: 'at';
      readonly hour: number;
      readonly minute: number;
      readonly days: readonly Weekday[];
      readonly spec: string;
    };

/** `Date.getDay()` order, so an index from the clock is an index into this list. */
const WEEKDAYS: readonly Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * The shortest interval a task may ask for. Every run starts an agent and may cost a model call; a
 * typo of `1s` for `1h` must be a configuration error, not a bill.
 */
export const MIN_INTERVAL_MS = 60_000;

/** `30m`, `2h`, `1d` → milliseconds. Anything else, including zero, is `null`. */
export function parseDuration(text: string): number | null {
  const match = /^(\d+)\s*([mhd])$/.exec(text.trim());
  if (!match) return null;
  const count = Number(match[1]);
  if (!Number.isSafeInteger(count) || count <= 0) return null;
  return count * UNITS[match[2]!]!;
}

/** Validate a task's `schedule`. Throws with a sentence a person can act on. */
export function parseSchedule(value: unknown): Schedule {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('must be an object: { "every": "30m" } or { "at": "07:30", "days": [...] }');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (typeof record['every'] === 'string') {
    if (keys.length !== 1) throw new Error('"every" takes no other key');
    const ms = parseDuration(record['every']);
    if (ms === null) throw new Error(`"every": "${record['every']}" is not a duration like 30m, 2h or 1d`);
    if (ms < MIN_INTERVAL_MS) throw new Error('"every" must be at least 1m');
    return { kind: 'every', ms, spec: `every ${record['every'].trim()}` };
  }
  if (typeof record['at'] === 'string') {
    for (const key of keys) {
      if (key !== 'at' && key !== 'days') throw new Error(`unknown key "${key}"`);
    }
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(record['at'].trim());
    if (!match) throw new Error(`"at": "${record['at']}" is not a time like 07:30`);
    const days = parseDays(record['days']);
    const spec = `at ${match[1]}:${match[2]}${days.length === 7 ? '' : ` on ${days.join(',')}`}`;
    return { kind: 'at', hour: Number(match[1]), minute: Number(match[2]), days, spec };
  }
  throw new Error('needs "every" or "at"');
}

function parseDays(value: unknown): Weekday[] {
  if (value === undefined) return [...WEEKDAYS.slice(1), 'sun'];
  if (!Array.isArray(value) || value.length === 0) throw new Error('"days" must be a non-empty list');
  const days: Weekday[] = [];
  for (const day of value) {
    if (typeof day !== 'string' || !WEEKDAYS.includes(day as Weekday)) {
      throw new Error(`"days": ${JSON.stringify(day)} is not one of ${WEEKDAYS.join(', ')}`);
    }
    if (!days.includes(day as Weekday)) days.push(day as Weekday);
  }
  return days;
}

/**
 * When the task runs next.
 *
 * An interval with no last run is due now. A time of day is due at its next occurrence after the
 * last run, which is in the past when `serve` was down at that moment: the missed run happens once,
 * on start, and is not repeated per missed day. With no last run it waits for the next occurrence
 * after `now` — a fresh install does not fire a 07:30 task at 15:00.
 */
export function nextRun(schedule: Schedule, lastRun: Date | null, now: Date): Date {
  if (schedule.kind === 'every') {
    return lastRun ? new Date(lastRun.getTime() + schedule.ms) : now;
  }
  const after = lastRun ?? now;
  const candidate = new Date(after);
  candidate.setHours(schedule.hour, schedule.minute, 0, 0);
  for (let day = 0; day <= 7; day++) {
    if (candidate.getTime() > after.getTime() && schedule.days.includes(WEEKDAYS[candidate.getDay()]!)) {
      return candidate;
    }
    candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(schedule.hour, schedule.minute, 0, 0);
  }
  // Unreachable with a non-empty `days`; a week out keeps a broken value from spinning the loop.
  return new Date(after.getTime() + 7 * UNITS['d']!);
}

export function isDue(schedule: Schedule, lastRun: Date | null, now: Date): boolean {
  return nextRun(schedule, lastRun, now).getTime() <= now.getTime();
}
