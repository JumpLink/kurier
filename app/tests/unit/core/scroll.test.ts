import { describe, expect, it } from '@gjsify/unit';

import {
  FOLLOW_MAX_ATTEMPTS,
  followLanded,
  followTarget,
  isAtBottom,
  shouldRetryFollow,
} from '../../../src/core/scroll.ts';

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
};
