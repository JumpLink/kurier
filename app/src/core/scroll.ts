/**
 * Whether the transcript was at the newest end of the conversation a moment ago.
 *
 * **This is the only question an auto-scroll has to ask, and it is asked *before* anything is
 * appended.** Plan §6 puts it in one line — "auto-scroll only when already at the bottom. A jump
 * while someone is reading is hostile" — and the reason it is a pure function in `core/` rather than
 * three lines inside `transcript-view.ts` is the same reason every other decision in this app lives
 * there: `Gtk.Adjustment`'s numbers are readable under GTK and unreadable in a Node test, and a rule
 * that can only be checked on a display is a rule nobody checks. This one is checked on both runtimes.
 *
 * The inputs are the three numbers `Gtk.Adjustment` exposes (`value`, `upper`, `page_size`) rather
 * than the widget, so nothing here imports `gi://`.
 */

/**
 * How close to the end still counts as "at the end", in pixels.
 *
 * **Not zero, and the reason is a measurement rather than a preference.** A scroll position is a
 * double, the content height is whatever the last bubble plus the column's bottom margin came to, and
 * the two are computed in different frames — so the person who *is* at the bottom is typically a
 * fraction of a pixel, and the tail of a part-laid-out bubble can be a whole line, short of it. With
 * an exact test the view stops following the stream one line before the end, and the defect is
 * invisible until somebody notices the last line never appears on its own. About one line of text is
 * the smallest band that fixes that without swallowing the case that matters: a person who has
 * deliberately scrolled up to read is tens of pixels above the end, not one.
 */
const BOTTOM_TOLERANCE_PX = 24;

/**
 * How many times a scroll-to-end may be retried while the adjustment refuses to be measured.
 *
 * **A cap, because the retry is driven by a notification and a notification that can fail forever is
 * a busy loop.** Three is not arbitrary, and the reason is the *other* signal: a fill issued from the
 * window constructor happens before the window exists, so `upper` and `page_size` are both 0 and the
 * attempt has nothing to work with (`scripts/probes/scroll-settle.mjs` measures exactly that, all
 * three idles reading 0). The retry exists for that case, and it needs one attempt to be told the
 * window has been laid out plus one to actually move — three covers it with a spare. The rest is
 * belt and braces for a layout that settles later than the window does.
 *
 * **This comment once justified the cap with `GtkScrolledWindow::size-allocate` firing between the
 * first two attempts, and that signal does not exist in this binding** — `GObject.signal_lookup` finds
 * no such signal on `GtkScrolledWindow` and `connect()` throws, though it is there in C and is not
 * introspectable. The cap's reasoning rested on a path that could not have run. `transcript-view.ts`
 * records the measurement, and the follow is driven by `GtkAdjustment::changed` instead.
 */
export const FOLLOW_MAX_ATTEMPTS = 3;

/**
 * Where to put the view to follow the newest entry, or `null` when the adjustment cannot say yet.
 *
 * **This is the decision that was wrong, and it is a function of three numbers rather than of the
 * widget, which is why it lives here.** `#scrollToEnd` used to read `upper`/`page_size` once on an
 * idle and give up when `end <= 0`, on the comment's promise that "the first frame's allocation
 * retries this". Nothing retried it, and the promise is false in the one case that matters: the
 * window's constructor fills the transcript (`KU_APP_SESSION`, or a session clicked before the first
 * frame), and at that moment the scrolled window has never been allocated, so `upper` and `page_size`
 * are both `0` on **every** idle until the window is presented.
 *
 * Measured, `scripts/probes/scroll-settle.mjs` (GTK 4.22.5): armed before `present()`, `upper=0
 * page=0` across three consecutive `PRIORITY_LOW` idles; the same call after `present()` reads the
 * real `upper=542 page=384` on its **first** idle and lands exactly on the end. So the shortfall was
 * never "one idle is one frame behind the layout" — it is a scroll that was dropped on the floor and
 * never retried.
 *
 * **And that drop is what made the stream look broken at 480 px while 1024 px was fine.** With the
 * fill's scroll lost, the view sits at `value = 0` while the column is taller than the pane, so
 * `isAtBottom` correctly reports "the reader has scrolled up" — a statement about a reader who does
 * not exist. Every arriving chunk then declines to follow, and the newest bubble streams in below the
 * fold. At 1024 px the stored transcript is barely taller than the pane, `value = 0` *is* the end,
 * and `isAtBottom` says `true` by the `upper <= pageSize` rule — so the same lost scroll is invisible
 * there. The width was never the cause; it only decided whether the lost scroll could be seen.
 *
 * `null` rather than `0` is deliberate: `end <= 0` means *not measurable yet* (nothing allocated), not
 * "the end is the top", and the two need opposite answers — one retries, the other stops.
 */
export function followTarget(upper: number, pageSize: number): number | null {
  const end = upper - pageSize;
  return end > 0 ? end : null;
}

/**
 * Whether a scroll that was requested actually landed on the end.
 *
 * **Why asking is necessary: `Gtk.Adjustment` clamps, silently.** `set_value` is a request, and when
 * the requested value is past the maximum the adjustment takes the maximum instead — no error, no
 * return value. The follow computes its target from `upper` and `page_size` as they are at the moment
 * `notify::upper` fires, and those two are **not** updated together: a re-wrap that makes the column
 * taller moves `upper` and `page_size` in separate notifications, so a follow that acts on the first
 * one computes an end against a stale `page_size`, asks for a value past the real maximum, and is
 * quietly given the maximum — which is short by exactly the `page_size` delta. Measured at 480 px as
 * a partially visible final line with "Working — the agent is answering" still on screen.
 *
 * **`tolerance` is zero here, unlike `isAtBottom`'s band, and the difference is the point.** The band
 * exists to forgive a *fraction* of a pixel in a person's scroll position; here the question is
 * whether a *large* shortfall survived, and a value inside the band would be reported as landed and
 * never retried. Passing `0` makes this "did we get there", not "are we nearly there".
 */
export function followLanded(requested: number, actual: number, upper: number, pageSize: number): boolean {
  const end = followTarget(upper, pageSize);
  if (end === null) return false; // Nothing to land on; the follow is still owed.
  // Both directions. Asking for too small a value is the same defect as being clamped short of a too
  // large one — the newest entry would be off screen either way.
  return Math.abs(actual - end) < 1 && requested <= end + 1;
}

/**
 * Whether a scroll-to-end may be retried. Counted, not timed.
 *
 * A count is the honest shape for this: the thing being waited on is a layout, and a layout is
 * measured in frames rather than in milliseconds, so a time-based cap would be guessing at a
 * different unit than the one GTK uses.
 */
export function shouldRetryFollow(attempts: number, max: number = FOLLOW_MAX_ATTEMPTS): boolean {
  return attempts < max;
}

/**
 * True when the view is at the newest end — or when it could not scroll in the first place.
 *
 * `upper <= pageSize` is a conversation shorter than the pane, where there is nowhere to scroll *to*.
 * Treating that as "not at the bottom" would freeze auto-scroll for the whole of a short transcript,
 * which is the case a screenshot of a fresh window is most likely to be.
 */
export function isAtBottom(
  value: number,
  upper: number,
  pageSize: number,
  tolerance: number = BOTTOM_TOLERANCE_PX,
): boolean {
  if (upper <= pageSize) return true;
  return upper - pageSize - value <= tolerance;
}
