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
 *
 * **The second question in this file is "was that scroll mine or the reader's?", and it belongs here
 * for the same reason.** Position answers where the view is; the intent behind a position is what an
 * auto-scroll has to know, and the widget can only learn it by watching two signals and remembering
 * three pieces of state between them. That is not answerable by looking at a number, and it was
 * therefore not answerable by a test either.
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
 * window's constructor fills the transcript (`LOTSE_APP_SESSION`, or a session clicked before the first
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

/**
 * Which of `GtkAdjustment`'s two scroll signals woke the decision.
 *
 * `changed` fires for *any* property — `value`, `upper`, `page_size` — and says which one moved; the
 * other one fires for a move alone. `transcript-view.ts` carries the measurement behind picking
 * `changed` at all (`scripts/probes/widget-signals.mjs`: `notify::page_size` never fires, and
 * `size-allocate` throws in this binding), and this is the same fact seen from the other side: the two
 * signals are not interchangeable, so the caller says which one it is answering.
 */
export type AdjustmentSignal = 'changed' | 'value-changed';

/** One notification from the adjustment, with everything the follow state is remembered from. */
export interface FollowInput {
  /** The follow state as the widget remembers it from the previous notification. */
  readonly following: boolean;
  /**
   * True only while the widget is inside its own `set_value` call.
   *
   * **The one input no signal carries, and the reason this function takes a flag.** `set_value` *is* a
   * scroll and `value-changed` fires for it, so "did the view move?" and "did the reader move it?" are
   * the same question to GTK. Only the widget knows it is the one holding the adjustment, so it
   * answers it here.
   */
  readonly selfScroll: boolean;
  /** The `value` the widget last saw, from either signal. */
  readonly lastValue: number;
  readonly signal: AdjustmentSignal;
  /** The adjustment as it is at notification time: `value`, `upper`, `page_size`. */
  readonly value: number;
  readonly upper: number;
  readonly pageSize: number;
}

/**
 * What the widget has to remember and do, answered together.
 *
 * **`rearmFollow` and `attemptFollow` are why this is not just a boolean.** A `changed` while
 * following both *owes* a scroll to the end and is the moment to try paying it; a `changed` carrying a
 * moved value is the reader, which owes nothing and is not a moment to scroll. Returning only the state
 * would force those two back into the widget as the `if`s they were, which is the decision again.
 */
export interface FollowUpdate {
  /** What the widget's follow state becomes. */
  readonly following: boolean;
  /** What the widget records as the last value it saw. */
  readonly lastValue: number;
  /** Whether the follow is owed again — the end moved under a view that was following. */
  readonly rearmFollow: boolean;
  /** Whether the widget should try to pay an owed follow now. */
  readonly attemptFollow: boolean;
}

/**
 * The next follow state after one notification from the adjustment.
 *
 * **This is the decision, and it used to be three fields and two `if`s inside the widget.** The widget
 * remembered the follow state, a flag set around its own `set_value`, and the last value it had seen,
 * and re-derived the state in its two signal handlers. None of that is checkable from a test: a
 * `Gtk.Adjustment` only exists under GTK, and a rule that can only be watched on a display is a rule
 * nobody checks. As numbers it is checked on both runtimes.
 *
 * The four rules, each of which is a test in `app/tests/unit/core/scroll.test.ts`:
 *
 * - **Our own scroll never turns following off.** The follow computes its target from the `upper` of
 *   the moment, and a re-wrap before it lands makes that target short of the new end — so re-deriving
 *   the state from our own `set_value` would switch the follow off by the act of following. Measured at
 *   360×720 mid-stream: the newest bubble cut off at the composer's edge while the status line still read
 *   "Working — the agent is answering". We only scroll while following, so a scroll we caused can only
 *   mean *still following*.
 * - **A reader who scrolls up turns it off**, which is `isAtBottom` on the position — the plan's §6 rule
 *   restated as a state change rather than as a position, so it survives the next re-wrap.
 * - **Reaching the end turns it back on**, and the reader does not have to reach it exactly; the 24 px
 *   band belongs to a person's scroll position and is reused here unchanged.
 * - **A column that grows under a following view is not a reader.** A window narrowed mid-turn re-wraps
 *   every bubble into a taller column, and the end moves without the value moving. Treating that as a
 *   scroll up would invent a reader who never scrolled and stop the stream mid-turn.
 *
 * **`upper` and `pageSize` are read even on the `changed` path, where the answer does not use them.**
 * One shape for one call is worth more than an input that is only sometimes meaningful, and the widget
 * has the adjustment in hand either way.
 */
export function resolveFollow(input: FollowInput): FollowUpdate {
  const { following, selfScroll, lastValue, signal, value, upper, pageSize } = input;
  if (signal === 'value-changed') {
    return {
      // Ours means "still following", and the position is deliberately not read for it.
      following: selfScroll ? following : isAtBottom(value, upper, pageSize),
      // Recorded either way: the position moved, and the next `changed` is compared against it.
      lastValue: value,
      // A move owes nothing, and a scroll nobody asked for is not the moment to answer one — which is
      // also what keeps a reader who scrolled up from being yanked straight back down.
      rearmFollow: false,
      attemptFollow: false,
    };
  }
  // `changed` without a moved value is the layout re-measuring itself. With a moved value it is the same
  // move the other signal already reported, and this path only has to keep the remembered position
  // current — the follow state is not re-derived here, because the other signal derives it from a fresh
  // read of the adjustment and a `changed` can arrive between the notifications that move `upper` and
  // `page_size` separately.
  if (value !== lastValue) {
    return { following, lastValue: value, rearmFollow: false, attemptFollow: false };
  }
  // The value did not move, so the end moved. While following, that is exactly when a follow is owed;
  // while not following the reader has said where they want to be, and the layout gets no vote. The
  // attempt is asked for on both, and the widget's own "owed" flag decides whether there is anything to
  // do — a pending follow from before the reader's scroll is still pending.
  return { following, lastValue, rearmFollow: following, attemptFollow: true };
}
