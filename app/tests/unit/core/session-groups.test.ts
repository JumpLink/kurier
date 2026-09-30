import { describe, expect, it } from '@gjsify/unit';

import { newSession, type SessionRecord } from '@kurier/session';

import {
  GROUP_ORDER,
  GROUP_TITLES,
  groupByDate,
  groupOf,
  timeLabelOf,
} from '../../../src/core/session-groups.ts';

/** Wednesday 30 September 2026, noon, local. */
const NOW = new Date(2026, 8, 30, 12, 0);
const AT = NOW.toISOString();

/**
 * The ISO string for `days` before NOW at a local wall-clock time.
 *
 * Every fixture is built through the local `Date` constructor and `.toISOString()`, never written as
 * a literal `...Z`. A hardcoded UTC string denotes a different *local* day per runner, so a
 * midnight-boundary assertion built from one passes in Berlin and fails in Auckland — and the failure
 * is in the test, not in the code under it. `setDate` moves the local date field, so month rollover
 * and DST are the engine's problem; `days` is counted in calendar days either way.
 */
const dayOffset = (days: number, hour = 12, minute = 0): string => {
  const when = new Date(NOW);
  when.setDate(when.getDate() - days);
  when.setHours(hour, minute, 0, 0);
  return when.toISOString();
};

const rec = (id: string, updatedAt: string): SessionRecord => ({
  ...newSession({ id, agent: 'opencode', cwd: '/tmp', at: AT }),
  updatedAt,
});

/** Group labels and the ids under each, flattened for one assertion. */
const shape = (groups: readonly { label: string; records: readonly SessionRecord[] }[]) =>
  groups.map((g) => [g.label, g.records.map((r) => r.id)] as const);

const MALFORMED = 'not-a-timestamp';

export default async () => {
  await describe('groupOf — calendar-day buckets', async () => {
    await it('puts anything from earlier today in today', async () => {
      expect(groupOf(dayOffset(0, 0, 1), NOW)).toBe('today');
      expect(groupOf(dayOffset(0, 9, 5), NOW)).toBe('today');
      expect(groupOf(dayOffset(0, 23, 59), NOW)).toBe('today');
    });

    await it('puts the previous calendar day in yesterday', async () => {
      expect(groupOf(dayOffset(1, 0, 0), NOW)).toBe('yesterday');
      expect(groupOf(dayOffset(1, 23, 59), NOW)).toBe('yesterday');
    });

    await it('puts 2 to 6 days back in this-week', async () => {
      expect(groupOf(dayOffset(2), NOW)).toBe('this-week');
      expect(groupOf(dayOffset(3), NOW)).toBe('this-week');
      expect(groupOf(dayOffset(6), NOW)).toBe('this-week');
    });

    await it('puts 7 days back and older in earlier', async () => {
      expect(groupOf(dayOffset(7), NOW)).toBe('earlier');
      expect(groupOf(dayOffset(30), NOW)).toBe('earlier');
    });

    await it('splits 23:59 yesterday from 00:01 today — two minutes apart, two sections', async () => {
      // THE calendar-day rule, stated as a test. Both instants fall inside a rolling 24-hour window
      // before NOW, so that reading would file both as `today` and list last night's late session
      // above this morning's. A person reads "Yesterday" as the day before.
      expect(groupOf(dayOffset(1, 23, 59), NOW)).toBe('yesterday');
      expect(groupOf(dayOffset(0, 0, 1), NOW)).toBe('today');
    });

    await it('puts 6 days back in this-week and 7 in earlier', async () => {
      // The inclusive edge of `this-week`. 24 September (Thu) is still the week, 23 September (Wed)
      // is the week before; a range written `<= 7` would merge them and read as "this week" for a
      // fortnight.
      expect(groupOf(dayOffset(6), NOW)).toBe('this-week');
      expect(groupOf(dayOffset(7), NOW)).toBe('earlier');
    });

    await it('keeps a future timestamp in today instead of dropping it', async () => {
      // Clock skew, or a store written by a machine whose time was wrong: tomorrow morning's
      // timestamp is not in the future as far as the reader is concerned, it is now. It must stay
      // visible at the top of the list rather than land in a section nobody reads.
      expect(groupOf(dayOffset(-1, 8, 15), NOW)).toBe('today');
      expect(groupOf(dayOffset(-1), NOW)).toBe('today');
      // A few hours ahead on the same day, which no day-based comparison even notices.
      expect(groupOf(dayOffset(0, 20, 0), NOW)).toBe('today');
    });

    await it('keeps two calendar days apart across a spring-forward, where the hours do not', async () => {
      // THE reason `dayDiff` rounds instead of floors, as a test that fails if it stops.
      //
      // 29 → 31 March 2026 straddles the end of daylight saving in Europe/Berlin: local midnight
      // advances on 29 March, so the two local midnights are 47 hours apart and the raw division is
      // 1.958 — a floor reports ONE day and files last Saturday under "Yesterday". Rounding is the
      // whole of the difference, and the direction matters: the autumn transition (a 49-hour gap,
      // 2.04 days) is the one where floor and round agree, so a test built on it would pass against
      // the mutation it is meant to catch.
      //
      // In a zone without DST the two midnights are exactly 48 hours apart, floor and round agree
      // and the case is a no-op — so the zone is detected first, at the two local midnights
      // `dayDiff` actually compares, and the discriminating assertions run only where they can.
      const now = new Date(2026, 2, 31, 12);
      const then = new Date(2026, 2, 29, 12);
      const midnight = (at: Date): Date => new Date(at.getFullYear(), at.getMonth(), at.getDate());
      const hasDst = midnight(now).getTimezoneOffset() !== midnight(then).getTimezoneOffset();

      // The contract, in any zone: two calendar days back is `this-week`, not `yesterday`.
      expect(groupOf(then.toISOString(), now)).toBe('this-week');

      // Where the zone does shift, the gap is not 48 hours, so the assertion above is not something
      // a `floor` can pass by accident — and rounding that very gap is what yields the two days.
      if (hasDst) {
        const span = midnight(now).getTime() - midnight(then).getTime();
        expect(span).not.toBe(2 * 86_400_000);
        expect(Math.floor(span / 86_400_000)).toBe(1);
        expect(Math.round(span / 86_400_000)).toBe(2);
      }
    });

    await it('routes an unparseable timestamp to earlier rather than throwing', async () => {
      // A hand-edited store or a truncated write. `earlier` is where a record of genuinely unknown
      // age belongs — the alternative, throwing, takes the whole sidebar down over one line.
      expect(() => groupOf(MALFORMED, NOW)).not.toThrow();
      expect(groupOf(MALFORMED, NOW)).toBe('earlier');
      expect(groupOf('', NOW)).toBe('earlier');
    });
  });

  await describe('timeLabelOf — the secondary line', async () => {
    await it('renders today as a zero-padded 24-hour time', async () => {
      expect(timeLabelOf(dayOffset(0, 9, 5), NOW)).toBe('09:05');
      // 23:59 also pins 24-hour clock: an AM/PM rendering would say 11:59 and pad it differently.
      expect(timeLabelOf(dayOffset(0, 23, 59), NOW)).toBe('23:59');
      expect(timeLabelOf(dayOffset(0, 0, 1), NOW)).toBe('00:01');
    });

    await it('renders yesterday as the word, not a clock time', async () => {
      // Fixed English string rather than an `Intl` format: this suite runs on GJS and on Node, and
      // the two do not carry the same locale data, so a localised rendering is a test that fails on
      // one runtime for no reason in the code.
      expect(timeLabelOf(dayOffset(1, 23, 59), NOW)).toBe('Yesterday');
    });

    await it('renders this-week as a short English weekday', async () => {
      // 27 September is the Sunday three days back, 24 September the Thursday six days back.
      expect(timeLabelOf(dayOffset(3), NOW)).toBe('Sun');
      expect(timeLabelOf(dayOffset(6), NOW)).toBe('Thu');
    });

    await it('renders earlier as a local date in ISO order', async () => {
      // 20 September, ten days back. Built from the local parts, not `toISOString()`: that would
      // print the UTC date, and a session from late last night would show tomorrow.
      expect(timeLabelOf(dayOffset(10), NOW)).toBe('2026-09-20');
    });

    await it('renders a future timestamp as a time, like any other today', async () => {
      expect(timeLabelOf(dayOffset(-1, 8, 15), NOW)).toBe('08:15');
    });

    await it('renders an unparseable timestamp as an empty string', async () => {
      // Empty is the one value a row can carry that reads as "no time to show" rather than as a
      // wrong one — `Invalid Date` or a `NaN` would both be worse.
      expect(() => timeLabelOf(MALFORMED, NOW)).not.toThrow();
      expect(timeLabelOf(MALFORMED, NOW)).toBe('');
      expect(timeLabelOf('', NOW)).toBe('');
    });
  });

  await describe('groupByDate — sections', async () => {
    await it('returns [] for empty input', async () => {
      expect(groupByDate([], NOW)).toStrictEqual([]);
    });

    await it('buckets in a fixed order, no matter how the input was ordered', async () => {
      const t1 = rec('today-new', dayOffset(0, 11, 0));
      const t2 = rec('today-old', dayOffset(0, 8, 0));
      const y1 = rec('yesterday', dayOffset(1));
      const w1 = rec('week-recent', dayOffset(2));
      const w2 = rec('week-old', dayOffset(5));
      const e1 = rec('earlier-recent', dayOffset(7));
      const e2 = rec('earlier-old', dayOffset(20));

      // Same seven records, opposite orders. The output must be identical, because the caller
      // hands over whatever the store happened to contain and the sidebar's order is not the
      // store's business.
      const forward = groupByDate([t1, t2, y1, w1, w2, e1, e2], NOW);
      const reversed = groupByDate([e2, e1, w2, w1, y1, t2, t1], NOW);

      const expected = [
        ['today', ['today-new', 'today-old']],
        ['yesterday', ['yesterday']],
        ['this-week', ['week-recent', 'week-old']],
        ['earlier', ['earlier-recent', 'earlier-old']],
      ] as const;
      expect(shape(forward)).toStrictEqual(expected);
      expect(shape(reversed)).toStrictEqual(expected);
    });

    await it('splits the 6-vs-7 day boundary across two sections', async () => {
      const groups = groupByDate([rec('day7', dayOffset(7)), rec('day6', dayOffset(6))], NOW);
      expect(shape(groups)).toStrictEqual([
        ['this-week', ['day6']],
        ['earlier', ['day7']],
      ]);
    });

    await it('splits 23:59 yesterday from 00:01 today into two sections', async () => {
      const groups = groupByDate(
        [rec('after-midnight', dayOffset(0, 0, 1)), rec('before-midnight', dayOffset(1, 23, 59))],
        NOW,
      );
      expect(shape(groups)).toStrictEqual([
        ['today', ['after-midnight']],
        ['yesterday', ['before-midnight']],
      ]);
    });

    await it('omits a section with no records instead of rendering a dead header', async () => {
      const groups = groupByDate([rec('today', dayOffset(0, 9, 0))], NOW);
      expect(groups.map((g) => g.label)).toStrictEqual(['today']);
    });

    await it('keeps a future record in today, pinned with the rest', async () => {
      const groups = groupByDate([rec('future', dayOffset(-1, 8, 0)), rec('today', dayOffset(0, 9, 0))], NOW);
      expect(shape(groups)).toStrictEqual([['today', ['future', 'today']]]);
    });

    await it('keeps an unparseable record visible, in earlier', async () => {
      const malformed = rec('bad', MALFORMED);
      expect(() => groupByDate([malformed], NOW)).not.toThrow();
      expect(shape(groupByDate([malformed], NOW))).toStrictEqual([['earlier', ['bad']]]);
    });

    await it('keeps sections contiguous when a malformed timestamp sorts above the valid ones', async () => {
      // `byRecency` compares `updatedAt` as TEXT, and a malformed timestamp collides with an ISO one
      // by its characters — it does not sort into the past, it sorts wherever the runtime's
      // collation puts it, which is the top. A sort-then-split implementation therefore emits an
      // `earlier` section, then `today`, then a SECOND `earlier`, and a header-per-run renderer
      // drops or repeats records. Grouping first keeps every section contiguous by construction.
      const records = [
        rec('bad', MALFORMED),
        rec('earlier-10d', dayOffset(10)),
        rec('today-old', dayOffset(0, 8, 0)),
        rec('earlier-30d', dayOffset(30)),
        rec('today-new', dayOffset(0, 11, 0)),
      ];
      const groups = groupByDate(records, NOW);

      // Two sections, not three, and no label twice.
      expect(groups.map((g) => g.label)).toStrictEqual(['today', 'earlier']);
      // Today's own order is recency, which the timestamps decide.
      expect(groups[0]?.records.map((r) => r.id)).toStrictEqual(['today-new', 'today-old']);
      // Membership of the earlier section is asserted, not its internal order: whether a garbage
      // string collides above or below an ISO one is the runtime's collation, not this module's
      // contract, and the two runtimes need not agree on it.
      expect([...groups[1]!.records.map((r) => r.id)].sort()).toStrictEqual([
        'bad',
        'earlier-10d',
        'earlier-30d',
      ]);
    });

    await it('does not mutate the input array', async () => {
      // The store's array is shared state: a sidebar render that reorders it in place would leave
      // every other reader of the store looking at a list in an order nobody chose. Frozen, so an
      // in-place `sort` throws here instead of passing quietly.
      const records = [
        rec('earlier', dayOffset(10)),
        rec('today', dayOffset(0, 9, 0)),
        rec('yesterday', dayOffset(1)),
      ];
      const before = [...records];
      Object.freeze(records);

      groupByDate(records, NOW);

      expect(records).toStrictEqual(before);
    });
  });

  await describe('GROUP_ORDER and GROUP_TITLES', async () => {
    await it('lists the sections newest first', async () => {
      expect(GROUP_ORDER).toStrictEqual(['today', 'yesterday', 'this-week', 'earlier']);
    });

    await it('has a title for every section in GROUP_ORDER', async () => {
      expect(GROUP_ORDER.map((label) => GROUP_TITLES[label])).toStrictEqual([
        'Today',
        'Yesterday',
        'This week',
        'Earlier',
      ]);
    });
  });
};
