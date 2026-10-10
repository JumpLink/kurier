import { describe, expect, it } from '@gjsify/unit';

import { isDue, nextRun, parseDuration, parseSchedule } from '@lotse/core';

// Local time on purpose: an `at` schedule is a time on the person's clock. 2026-10-10 is a Saturday.
const SAT_15 = new Date(2026, 9, 10, 15, 0);

export default async () => {
  await describe('parseDuration', async () => {
    await it('reads minutes, hours and days', async () => {
      expect(parseDuration('30m')).toBe(30 * 60_000);
      expect(parseDuration('2h')).toBe(2 * 3_600_000);
      expect(parseDuration('1d')).toBe(86_400_000);
    });

    await it('refuses zero, seconds and words', async () => {
      expect(parseDuration('0m')).toBeNull();
      expect(parseDuration('30s')).toBeNull();
      expect(parseDuration('soon')).toBeNull();
    });
  });

  await describe('parseSchedule', async () => {
    await it('accepts an interval of at least a minute', async () => {
      expect(parseSchedule({ every: '30m' })).toStrictEqual({
        kind: 'every',
        ms: 1_800_000,
        spec: 'every 30m',
      });
      expect(() => parseSchedule({ every: '0m' })).toThrow();
    });

    await it('accepts a time of day with optional days', async () => {
      const schedule = parseSchedule({ at: '07:30', days: ['mon', 'fri'] });
      expect(schedule.kind).toBe('at');
      expect(schedule.spec).toBe('at 07:30 on mon,fri');
    });

    await it('refuses a bad time, an unknown day and an extra key', async () => {
      expect(() => parseSchedule({ at: '24:00' })).toThrow();
      expect(() => parseSchedule({ at: '07:30', days: ['someday'] })).toThrow();
      expect(() => parseSchedule({ every: '1h', at: '07:30' })).toThrow();
      expect(() => parseSchedule('hourly')).toThrow();
    });
  });

  await describe('nextRun', async () => {
    await it('an interval with no last run is due now, then every interval', async () => {
      const every = parseSchedule({ every: '30m' });
      expect(isDue(every, null, SAT_15)).toBe(true);
      const last = new Date(SAT_15.getTime() - 10 * 60_000);
      expect(nextRun(every, last, SAT_15).getTime()).toBe(last.getTime() + 1_800_000);
      expect(isDue(every, last, SAT_15)).toBe(false);
    });

    await it('a fresh install does not fire a morning task in the afternoon', async () => {
      const at = parseSchedule({ at: '07:30' });
      expect(nextRun(at, null, SAT_15)).toStrictEqual(new Date(2026, 9, 11, 7, 30));
      expect(isDue(at, null, SAT_15)).toBe(false);
    });

    await it('a missed run fires once on start, not once per missed day', async () => {
      const at = parseSchedule({ at: '07:30' });
      const lastRun = new Date(2026, 9, 7, 7, 30);
      expect(nextRun(at, lastRun, SAT_15)).toStrictEqual(new Date(2026, 9, 8, 7, 30));
      expect(isDue(at, lastRun, SAT_15)).toBe(true);
      // After that one run, the next is tomorrow morning.
      expect(isDue(at, SAT_15, SAT_15)).toBe(false);
    });

    await it('skips the days that are not listed', async () => {
      const mondays = parseSchedule({ at: '07:30', days: ['mon'] });
      expect(nextRun(mondays, null, SAT_15)).toStrictEqual(new Date(2026, 9, 12, 7, 30));
    });
  });
};
