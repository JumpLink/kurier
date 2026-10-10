import { describe, expect, it } from '@gjsify/unit';

import {
  FOLLOW_MAX_ATTEMPTS,
  followLanded,
  followTarget,
  isAtBottom,
  resolveFollow,
  shouldRetryFollow,
  type AdjustmentSignal,
} from '@lotse/core';

export default async () => {
  await describe('scroll — was the view at the newest end', async () => {
    await it('follows when the scroll position is exactly the end', async () => {
      // upper 3000, page 600 → the end is at value 2400.
      expect(isAtBottom(2400, 3000, 600)).toBe(true);
    });

    await it('follows within a line of the end — a fractional position is still the end', async () => {
      // A scroll position is a double and the content height is measured in another frame, so the
      // person who IS at the bottom is usually a fraction of a pixel short of it. An exact test stops
      // following the stream one line early, which is invisible until somebody notices.
      expect(isAtBottom(2390, 3000, 600)).toBe(true);
      expect(isAtBottom(2380, 3000, 600)).toBe(true);
    });

    await it('does not follow once the reader has scrolled up', async () => {
      expect(isAtBottom(2000, 3000, 600)).toBe(false);
      expect(isAtBottom(0, 3000, 600)).toBe(false);
    });

    await it('follows a conversation shorter than the pane, which cannot scroll at all', async () => {
      // The case a screenshot of a fresh window is: three bubbles, no scrollbar. Treating "no room to
      // scroll" as "not at the bottom" would freeze auto-scroll for the whole of a short transcript.
      expect(isAtBottom(0, 200, 600)).toBe(true);
      expect(isAtBottom(0, 600, 600)).toBe(true);
    });

    await it('takes the tolerance as an argument, so the band is testable', async () => {
      expect(isAtBottom(2350, 3000, 600, 0)).toBe(false);
      expect(isAtBottom(2350, 3000, 600, 60)).toBe(true);
    });

    await it('is not fooled by a zero-sized adjustment', async () => {
      // Before the first allocation `upper` and `page_size` are both 0. Following there is a no-op
      // anyway (`#scrollToEnd` retries on an idle), but the predicate must not say "not at the bottom"
      // for a window that has not been measured — that is how a first fill silently fails to scroll.
      expect(isAtBottom(0, 0, 0)).toBe(true);
    });
  });

  await describe('scroll — where the end is, and whether it is knowable yet', async () => {
    await it('gives the end when the adjustment has been measured', async () => {
      // upper 542, page 384 → the measured case from `scripts/probes/scroll-settle.mjs`.
      expect(followTarget(542, 384)).toBe(158);
    });

    await it('gives null before the window is allocated, which is not the same as "the top"', async () => {
      // **The defect, as a value.** `setEntries` runs from the window's constructor, so this is what
      // the scroll actually reads: `upper` and `page_size` are both 0, and the old code read that as
      // "there is no end" and gave up — leaving the newest bubble below the fold with no retry. `null`
      // says *not measurable yet*, which is the one that keeps the follow owed.
      expect(followTarget(0, 0)).toBe(null);
    });

    await it('gives null when the content is shorter than the pane', async () => {
      // Nothing to scroll to. Distinct from the case above for the same reason: retrying a scroll
      // that has no target is pointless, and confusing the two is what produced the dropped scroll.
      expect(followTarget(200, 600)).toBe(null);
      expect(followTarget(600, 600)).toBe(null);
    });

    await it('agrees with isAtBottom about the same numbers', async () => {
      // The two functions read the same adjustment for the same purpose, so a position that one calls
      // the end the other must place the view on. Checked as values because the pixel counts differ.
      for (const [upper, page] of [
        [542, 384],
        [3000, 600],
        [900, 400],
      ] as const) {
        const end = followTarget(upper, page);
        if (end === null) continue;
        expect(isAtBottom(end, upper, page)).toBe(true);
        // …and one row's height above it is not the end, which is the 480 px case that was broken.
        expect(isAtBottom(end - 160, upper, page)).toBe(false);
      }
    });

    await it('reports a follow that landed', async () => {
      expect(followLanded(158, 158, 542, 384)).toBe(true);
    });

    await it('reports a follow that was silently clamped short — the remaining 480 px defect', async () => {
      // Asked for 158, the adjustment gave 70: `set_value` clamps, returns nothing, and the newest
      // entry is off screen. Reading the value back is the only way to notice.
      expect(followLanded(158, 70, 542, 384)).toBe(false);
    });

    await it('reports a follow that landed a fraction short, which is not the same as not landing', async () => {
      // Sub-pixel only. Re-arming for this would be noise; the tolerance is 1 px, not `isAtBottom`'s
      // band, because the question here is "is the entry on screen" and not "is a person at the end".
      expect(followLanded(158, 157.4, 542, 384)).toBe(true);
    });

    await it('reports a follow that overshot, which is the same defect pointing the other way', async () => {
      expect(followLanded(158, 300, 542, 384)).toBe(false);
    });

    await it('never calls it landed while there is no end at all', async () => {
      // An unmeasured adjustment cannot confirm anything, so a follow must stay owed rather than be
      // marked done against numbers that do not mean anything yet.
      expect(followLanded(0, 0, 0, 0)).toBe(false);
      expect(followLanded(0, 0, 200, 600)).toBe(false);
    });

    await it('retries a bounded number of times, then gives up', async () => {
      // Bounded, because the retry rides a frame callback: one that can fail for ever is a busy loop.
      expect(shouldRetryFollow(0)).toBe(true);
      expect(shouldRetryFollow(FOLLOW_MAX_ATTEMPTS - 1)).toBe(true);
      expect(shouldRetryFollow(FOLLOW_MAX_ATTEMPTS)).toBe(false);
      expect(shouldRetryFollow(FOLLOW_MAX_ATTEMPTS + 1)).toBe(false);
    });

    await it('takes the cap as an argument, so the bound is testable without the default', async () => {
      expect(shouldRetryFollow(1, 1)).toBe(false);
      expect(shouldRetryFollow(0, 1)).toBe(true);
    });
  });

  await describe('scroll — was this scroll ours or the reader’s', async () => {
    await it('keeps following through its own scroll, even where the end has moved away', async () => {
      // **The 360 px defect, as a value.** Our own `set_value` asked for 800 against a `page_size` of
      // 400; the column then re-wrapped into a taller one, so the end is now 1100 and the position we
      // are sitting at is 300 px short of it — far outside `isAtBottom`'s band. Re-deriving the state
      // from our own scroll is what switched the follow off by the act of following, and nothing would
      // re-arm it afterwards.
      const update = resolveFollow({
        following: true,
        selfScroll: true,
        lastValue: 700,
        signal: 'value-changed',
        value: 700,
        upper: 1500,
        pageSize: 400,
      });
      expect(isAtBottom(700, 1500, 400)).toBe(false); // The answer this path must NOT take.
      expect(update.following).toBe(true);
      expect(update.lastValue).toBe(700);
      // A scroll nobody asked for owes nothing, so there is nothing to re-arm and nothing to attempt.
      expect(update.rearmFollow).toBe(false);
      expect(update.attemptFollow).toBe(false);
    });

    await it('leaves the state exactly as it was on its own scroll, in either direction', async () => {
      // "Unchanged" and "true" are different answers, and the widget only ever sets this field to one
      // of them — so a scroll of ours can neither start nor stop a follow.
      const stopped = resolveFollow({
        following: false,
        selfScroll: true,
        lastValue: 1200,
        signal: 'value-changed',
        value: 2400,
        upper: 3000,
        pageSize: 600,
      });
      expect(stopped.following).toBe(false);
      // The position is still recorded, or the next `changed` would compare against a stale one and
      // read the reader's own scroll as a layout change.
      expect(stopped.lastValue).toBe(2400);
    });

    await it('turns following off when the reader scrolls up', async () => {
      const update = resolveFollow({
        following: true,
        selfScroll: false,
        lastValue: 2400,
        signal: 'value-changed',
        value: 2000,
        upper: 3000,
        pageSize: 600,
      });
      expect(update.following).toBe(false);
      expect(update.lastValue).toBe(2000);
      // Plan §6: a jump while somebody is reading is hostile, so a reader's scroll is not the moment
      // to answer an owed scroll either.
      expect(update.rearmFollow).toBe(false);
      expect(update.attemptFollow).toBe(false);
    });

    await it('turns following back on when the reader reaches the end again', async () => {
      const back = resolveFollow({
        following: false,
        selfScroll: false,
        lastValue: 2000,
        signal: 'value-changed',
        value: 2400,
        upper: 3000,
        pageSize: 600,
      });
      expect(back.following).toBe(true);
      // The same 24 px band a person's position gets, reused unchanged: a reader who drags to the end
      // and lands a fraction short of it is still at the end.
      const withinBand = resolveFollow({
        following: false,
        selfScroll: false,
        lastValue: 2000,
        signal: 'value-changed',
        value: 2380,
        upper: 3000,
        pageSize: 600,
      });
      expect(withinBand.following).toBe(true);
    });

    await it('counts a position exactly on the band edge, and not a tenth of a pixel past it', async () => {
      // The edge of `isAtBottom`'s tolerance is the difference between a reader who reached the end and
      // one who stopped a hair short of it, so the comparison itself has to be pinned down.
      const onEdge = resolveFollow({
        following: false,
        selfScroll: false,
        lastValue: 0,
        signal: 'value-changed',
        value: 2400 - 24,
        upper: 3000,
        pageSize: 600,
      });
      expect(onEdge.following).toBe(true);
      const pastEdge = resolveFollow({
        following: false,
        selfScroll: false,
        lastValue: 0,
        signal: 'value-changed',
        value: 2400 - 24.1,
        upper: 3000,
        pageSize: 600,
      });
      expect(pastEdge.following).toBe(false);
    });

    await it('reads a column that grew under a following view as the layout, not as a reader', async () => {
      // A window narrowed mid-turn re-wraps every bubble, so `upper` moves while the value stays
      // exactly where it was — and `changed` does not say which property moved, so the remembered value
      // is the whole discriminator.
      const update = resolveFollow({
        following: true,
        selfScroll: false,
        lastValue: 2400,
        signal: 'changed',
        value: 2400,
        upper: 4000,
        pageSize: 600,
      });
      expect(isAtBottom(2400, 4000, 600)).toBe(false); // The answer this path must NOT take either.
      expect(update.following).toBe(true);
      // The end moved and the view has to go with it, so the follow is owed again and paid now.
      expect(update.rearmFollow).toBe(true);
      expect(update.attemptFollow).toBe(true);
      expect(update.lastValue).toBe(2400);
    });

    await it('leaves a `changed` that carries the reader’s own move to the other signal', async () => {
      // Same notification as the re-wrap, but the value is not the remembered one — so this is a
      // reader's scroll, which `value-changed` reports from a fresh read. This path only keeps the
      // remembered position current, and answers nothing.
      const update = resolveFollow({
        following: true,
        selfScroll: false,
        lastValue: 2400,
        signal: 'changed',
        value: 1800,
        upper: 3000,
        pageSize: 600,
      });
      expect(update.following).toBe(true);
      expect(update.lastValue).toBe(1800);
      expect(update.rearmFollow).toBe(false);
      expect(update.attemptFollow).toBe(false);
    });

    await it('re-arms nothing for a layout change while the reader is scrolled up', async () => {
      // The reader has said where they want to be and the layout gets no vote — this is the case that
      // would otherwise be read as "they came back". The attempt is still asked for, and the widget's
      // own owed-follow flag decides whether there is anything to do about it.
      const update = resolveFollow({
        following: false,
        selfScroll: false,
        lastValue: 1200,
        signal: 'changed',
        value: 1200,
        upper: 4400,
        pageSize: 600,
      });
      expect(update.following).toBe(false);
      expect(update.rearmFollow).toBe(false);
      expect(update.attemptFollow).toBe(true);
    });

    await it('counts a conversation shorter than the pane as the end, whichever way it arrived', async () => {
      // Nothing to scroll to, so there is nothing to have scrolled away from. A fresh window with
      // three bubbles is "following", and `upper <= pageSize` is where `isAtBottom` already draws that
      // line for a position; a move has to be answered with the same rule.
      const shorter = resolveFollow({
        following: false,
        selfScroll: false,
        lastValue: 0,
        signal: 'value-changed',
        value: 0,
        upper: 200,
        pageSize: 600,
      });
      expect(shorter.following).toBe(true);
      const exactly = resolveFollow({
        following: false,
        selfScroll: false,
        lastValue: 0,
        signal: 'value-changed',
        value: 0,
        upper: 600,
        pageSize: 600,
      });
      expect(exactly.following).toBe(true);
    });

    await it('counts an unmeasured adjustment as following, as a widget with no adjustment does', async () => {
      // Before the first allocation `upper` and `page_size` are both 0 (measured,
      // `scripts/probes/scroll-settle.mjs`), and `isAtBottom(0, 0, 0)` says "at the end". A widget with
      // no adjustment at all has to answer the same thing or the two paths would disagree about a
      // window that does not exist yet. The *scroll* is a separate question and is still owed:
      // `followTarget(0, 0)` is null.
      const update = resolveFollow({
        following: false,
        selfScroll: false,
        lastValue: 0,
        signal: 'value-changed',
        value: 0,
        upper: 0,
        pageSize: 0,
      });
      expect(update.following).toBe(true);
      expect(followTarget(0, 0)).toBe(null);
    });

    await it('plays a whole turn through, and only the reader’s moves change the state', async () => {
      // The widget’s side of the contract, as a state machine: hold the two fields, ask, write back
      // what came out. A turn that streams, re-wraps, is scrolled up by a reader and then scrolled down
      // again — the answer after the reader returns to the end has to be "following", or the next chunk
      // after that never follows.
      let following = true;
      let lastValue = 0;
      const feed = (input: {
        signal: AdjustmentSignal;
        value: number;
        selfScroll?: boolean;
        upper?: number;
        pageSize?: number;
      }): void => {
        const update = resolveFollow({
          following,
          selfScroll: input.selfScroll ?? false,
          lastValue,
          signal: input.signal,
          value: input.value,
          upper: input.upper ?? 3000,
          pageSize: input.pageSize ?? 600,
        });
        following = update.following;
        lastValue = update.lastValue;
      };

      feed({ signal: 'value-changed', value: 2400, selfScroll: true }); // Our own follow to the end.
      expect(following).toBe(true);
      feed({ signal: 'changed', value: 2400, upper: 4200 }); // A bubble re-wraps the column taller.
      expect(following).toBe(true);
      feed({ signal: 'value-changed', value: 1200 }); // A reader scrolls up to read.
      expect(following).toBe(false);
      feed({ signal: 'changed', value: 1200, upper: 4400 }); // …and the column grows again.
      expect(following).toBe(false);
      feed({ signal: 'value-changed', value: 3800 }); // They scroll down to the new end themselves.
      expect(following).toBe(true);
      expect(lastValue).toBe(3800);
    });
  });
};
