/**
 * The conversation: a transcript of records drawn as a conversation.
 *
 * **Every piece of text in here reaches a `Gtk.Label` with `useMarkup: false`, and that is the whole
 * reason this file has a rule instead of a habit.** GTK parses a label's text as Pango markup the
 * moment the property is assigned, and refuses a string it cannot parse *silently* — the row renders
 * empty, with a Gtk-WARNING on a stderr nobody reads. The text here is the agent's own words and its
 * tool titles, which in practice contain `Array<T>`, `a < b`, `<<<<<<< HEAD` and bare `&`. The flag
 * goes in the **constructor**: the parse happens on assignment, so a later `set_use_markup(false)` is
 * too late (measured, and `css.ts` carries the same warning about a different property). Every label
 * in this file is built by the one function that does it, which is why there is no second place to
 * forget.
 *
 * **The disclosure is a `Gtk.Expander`, and it is that because of a measurement, not a preference.**
 * The first version built the same line by hand — a flat `Gtk.Button` plus a `Gtk.Revealer` — which
 * looked equivalent and was not: `Gtk.Button`'s `'clicked'` fires for a *mouse* click, while the
 * keyboard reaches a focused button through `gtk_widget_activate()`, and that emits `'activate'`
 * only. Measured here: after `button.activate()`, `clicked=0, activate=1`, so Enter and Space on a
 * focused tool row did nothing at all. Hand-rolling the interaction means re-deriving GTK's own,
 * and getting it subtly wrong; `Gtk.Expander` is that interaction, already keyboard- and
 * screen-reader-correct, and it maintains the `EXPANDED` accessible state by itself. A line with
 * nothing behind it is not a disclosure at all and gets no expander — see `buildDisclosure`.
 *
 * **`Gtk.Expander`'s own title label is not used** — `labelWidget` is, and the widget is the same
 * `buildLabel` every other piece of agent text goes through. That is what keeps the markup rule
 * above enforced in this file rather than delegated to a widget whose internals it cannot check;
 * `useMarkup` stays `false` in the one place that constructs a label.
 *
 * **The width cap is an `Adw.Clamp` because nothing in CSS can do it.** GTK 4 removed `max-width` —
 * the parser rejects it with *"No property named …"* and the stylesheet still loads — and
 * `max-width-chars` on a label that also ellipsizes caps nothing (measured, in troedler). The clamp
 * is the only mechanism here that caps a natural width without also ellipsizing, and HIG's explicit
 * advice for a text-heavy surface. 720 px is the plan's number; it happens to equal the sidebar
 * breakpoint, which is a coincidence — one caps the pane, the other is a measure.
 *
 * An agent bubble carries a caption above it — the agent's name and the time the message was recorded —
 * and a tool call is a card (icon, title, status capsule). Both are read from what the record holds; the
 * tool's kind and input are not recorded, so see `tool-line.ts` for what the icon is a guess from.
 * No copy button, no per-item controls. Everything on screen is
 * something the transcript actually holds; a control that points at nothing is the one thing this
 * window's own header forbids.
 */

import Adw from '@girs/adw-1';
import GLib from '@girs/glib-2.0';
import Gtk from '@girs/gtk-4.0';
import Pango from '@girs/pango-1.0';

import type { TranscriptEntry } from '@kurier/session';

import {
  followLanded,
  followTarget,
  isAtBottom,
  resolveFollow,
  shouldRetryFollow,
  type AdjustmentSignal,
} from '../../core/scroll.ts';
import { toTranscriptItems, type DisclosureItem, type TranscriptItem } from '../../core/transcript-items.ts';
import { CONTENT_MAX_WIDTH_PX } from './constants.ts';
import { CSS } from './css.ts';
import { parseToolLine, toolIcon, TOOL_FALLBACK_ICON, type ToolLine } from './tool-line.ts';

/**
 * The conversation's measure is `CONTENT_MAX_WIDTH_PX`, not a constant of this file.
 *
 * **The composer shares it, and sharing is the point.** The entry you type into and the answer above
 * it are one column; a transcript capped at 720 under an entry capped at 700 puts the cursor nowhere
 * near what it is answering. `constants.ts` carries the number and the reasoning. This file's clamp is
 * the mechanism — `Adw.Clamp`, because it is the only thing here that caps a natural width without
 * also ellipsizing.
 */

/** Gap between two bubbles, in logical pixels. Smaller than the bubble's own internal padding. */
const ITEM_SPACING = 4;

export class TranscriptView {
  /** Pack this where the conversation goes. A `Gtk.ScrolledWindow` around a clamped column. */
  readonly widget: Gtk.Widget;

  readonly #scroller: Gtk.ScrolledWindow;
  readonly #column: Gtk.Box;
  /** Rows currently in the column, in order, so the last one can be replaced in place. */
  #rows: Gtk.Widget[] = [];
  /**
   * The entries behind those rows, and the items they projected to.
   *
   * **Why this file keeps the transcript instead of only the rows.** An arriving chunk is *not* a new
   * bubble: `toTranscriptItems` merges a run of adjacent chunks of one kind into one message (its file
   * header, decision 1), so the second chunk of an answer changes the last item instead of adding one.
   * A view that only held widgets could not tell those two cases apart and would draw every chunk as its
   * own bubble. Keeping the entries makes the two paths computable — and it is the same array
   * `setEntries` was given, so there is one source of truth rather than a widget list that has to be
   * diffed against a record it no longer holds.
   */
  #entries: readonly TranscriptEntry[] = [];
  #items: readonly TranscriptItem[] = [];
  /** Who the agent bubbles are captioned with; set from the open record, before its entries. */
  #agentName = '';
  /**
   * The queued follow-the-end idle, or `null`. One at a time — and that is a rule about *ownership*,
   * not about how many idles are scheduled; see `#scrollToEnd`.
   *
   * `GLib.Source` ids are positive integers and `0` is `GLib.SOURCE_REMOVE`, so `0` is deliberately
   * not the "nothing pending" marker: it is a return value, never a handle.
   *
   * **It is cleared as well as cancelled, because the field is the ownership of the idle.** A handle
   * this class no longer owns is a handle it will hand to `GLib.source_remove` again: `set_value` fires
   * `changed` synchronously, so a follow that lands short can install its own retry idle from inside the
   * previous one, and a removal that leaves the number behind is the next `source_remove`'s target. GLib
   * is loud about that — `Source ID 21 was not found when attempting to remove it`, measured on a
   * stand-in turn at `KU_STANDIN_DELAY_MS=50`, before `#scrollToEnd` started clearing the field.
   */
  #scrollSource: number | null = null;
  /**
   * True while a scroll-to-end is still owed because the adjustment could not be read yet.
   *
   * **This is the flag that fixes the defect, and it exists because the previous version's comment
   * promised a retry that nothing performed.** `setEntries` runs from the window's constructor —
   * `#applyDevHooks` opens `KU_APP_SESSION`, and a click can land before the first frame — so the
   * scrolled window is not allocated yet, `upper` and `page_size` are both `0`, and the one idle that
   * used to do the scrolling read them, found no end, and gave up silently.
   *
   * Measured on GTK 4.22.5 (`scripts/probes/scroll-settle.mjs`): armed before `present()`, `upper`
   * stays `0` across three consecutive `PRIORITY_LOW` idles; the identical call after `present()`
   * reads the real numbers on its **first** idle and lands exactly on the end, with `upper` not moving
   * afterwards. So the layout is never "one frame behind" — the reading was simply taken before the
   * window existed and then thrown away, and what is needed is a retry keyed to the window's own
   * first layout. `scripts/probes/widget-signals.mjs` is what found the signal that carries it.
   */
  #followPending = false;
  /** Retries spent on the current follow, bounded by `shouldRetryFollow`. */
  #followAttempts = 0;
  /**
   * Whether the reader is currently following the newest end.
   *
   * **The one place the plan's §6 rule is remembered across events**, and it exists because
   * position alone cannot answer "is this person reading?". A window narrowed mid-turn re-wraps every
   * bubble into a taller column; a view that was at the end is now short of it, and re-deriving
   * "were they at the bottom?" from the new numbers would read as *no* — so the stream would stop
   * following, having invented a reader who never scrolled. Tracking the intent from the reader's own
   * scroll events keeps the two cases apart: a deliberate scroll up clears it, a resize does not.
   *
   * **The remembered answer, not the rule.** `resolveFollow` in `core/scroll.ts` is what decides what
   * becomes, from the adjustment's numbers and the two flags below; this file only holds it between
   * notifications, and sets it directly in the two places that are not notifications at all:
   * `setEntries` (opening a session *is* a request to see its newest entry) and `appendEntries`
   * (which samples the position before anything is appended — see its own comment).
   */
  #following = true;
  /**
   * True only while this class is calling `set_value` itself.
   *
   * **`set_value` is a scroll, and `value-changed` cannot tell whose it is.** Our own scroll is issued
   * against the `upper` of the moment, and if the layout re-wraps before it lands — which it does at a
   * narrow width, because a bubble becomes several lines taller — the position we asked for is no longer
   * the end, so "where are we?" says *not at the bottom* and the follow is switched off **by the very act
   * of trying to follow**. After that nothing re-arms it, because every later `changed` finds the follow
   * state false.
   *
   * The symptom is the one this file was written to kill and it is width-dependent, which is what made it
   * survive: `isAtBottom` has a 24 px tolerance (`core/scroll.ts`), so at 1024 px the shortfall of a short
   * bubble stays inside the band and the stream keeps following, while at 360 px the same shortfall is a
   * full line and the view stops one bubble short and stays there. Measured at 360×720 mid-stream, with
   * zero warnings: the newest bubble cut off at the composer's edge while the status line read "Working —
   * the agent is answering".
   *
   * So the flag is set around our own write (`#tryFollow`) and handed to `resolveFollow` as
   * `selfScroll`, because the widget is the only party that knows it is the one holding the adjustment.
   * It is wiring, not a rule: nothing in this file reads it.
   */
  #selfScrolling = false;
  /**
   * The last scroll position this class saw, so a `changed` can be read as *what* changed.
   *
   * `GtkAdjustment::changed` does not say which property moved, and the two cases must be answered
   * oppositely: the layout re-measuring means a follow is owed, a person scrolling means it is not.
   * Comparing against this is the whole discriminator — see `resolveFollow`, and the `changed` connection
   * in the constructor.
   */
  #lastValue = 0;

  constructor() {
    this.#column = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: ITEM_SPACING,
      // The clamp caps the *content*; these margins are what stops the first and last bubble from
      // touching the pane's own edges once it has.
      marginTop: 12,
      marginBottom: 12,
      marginStart: 12,
      marginEnd: 12,
    });

    this.#scroller = new Gtk.ScrolledWindow({
      child: new Adw.Clamp({
        child: this.#column,
        maximumSize: CONTENT_MAX_WIDTH_PX,
        tighteningThreshold: CONTENT_MAX_WIDTH_PX,
      }),
      hexpand: true,
      vexpand: true,
      // `hscrollbarPolicy: NEVER`, not `AUTOMATIC`. The column can never be wider than the clamp,
      // so a horizontal bar can only mean a layout bug — and a bug is better seen as clipped text,
      // which is obvious, than as a scrollbar a person tries to use.
      hscrollbarPolicy: Gtk.PolicyType.NEVER,
    });

    this.widget = this.#scroller;

    // **Follow the layout instead of guessing when it settles.** This is the whole fix for the
    // "newest bubble cut off at the composer's edge" defect, and `GtkAdjustment::changed` is the
    // signal that carries the news.
    //
    // Two other signals were tried and measured first, and both are wrong —
    // `scripts/probes/widget-signals.mjs` is the record:
    //
    // - `GtkScrolledWindow::size-allocate` **throws in this binding**: `GObject.signal_lookup` finds no
    //   such signal, and `connect()` raises
    //   `No signal 'size-allocate' on object 'GtkScrolledWindow'`. It exists in C
    //   (`gtk_widget_signals[SIZE_ALLOCATE]`) but is not introspectable, so a constructor that connects
    //   to it dies before there is a window to report it on.
    // - `notify::page_size` **never fires.** The probe counts 0 on present and 0 on a resize, where
    //   `page_size` demonstrably falls from 561 to 261. A follow built on it silently never re-arms,
    //   which is this defect in its purest form: with the window made shorter, the adjustment reported
    //   `end = 479` against `value = 299` — 180 px short — and nothing in this file was even told.
    //   `notify::upper` does fire, but only for `upper`, and a window made *shorter* does not move it.
    //
    // `changed` is the documented "any property changed" signal, and the probe counts it firing on
    // both events (1 -> 2 across that resize).
    //
    // **A `changed` handler that re-armed unconditionally would yank a reader who scrolled up**, since
    // scrolling moves the value and that is a `changed` too. Which case this is — and whether the move
    // was ours or the reader's — is `resolveFollow`'s to answer from the adjustment's numbers; this file
    // only connects the two signals and applies what comes back. That is what keeps the plan's section 6
    // rule intact: the follow only ever fires for the follow state, and that state is only cleared by a
    // position that is not the end.
    this.#scroller.get_vadjustment()?.connect('changed', () => {
      this.#onAdjustment('changed');
    });

    // The reader's own scrolling, recorded as it happens. `appendEntries` samples `#atBottom` before
    // every append — this is not the only place the answer comes from, it is the place that knows about a
    // scroll with **no** append behind it, which is exactly what a person reading does. Without it a
    // reader who scrolled up and then a resize that made the content taller would look like one
    // continuous "following" state, and the next chunk would yank them back down.
    this.#scroller.get_vadjustment()?.connect('value-changed', () => {
      this.#onAdjustment('value-changed');
    });
  }

  /**
   * Hand one notification from the adjustment to the decision, then apply what it says.
   *
   * **This method is the whole of the wiring, and it is deliberately that short.** The adjustment's three
   * numbers plus the state this class carries between notifications are the entire input; whether that
   * means "the reader scrolled up" or "the layout grew" or "we scrolled ourselves" is decided in
   * `core/scroll.ts`, where a test can reach it — under Node there is no adjustment at all, and the rules
   * that keep a following view following through a re-wrap would otherwise only ever be checked on a
   * display.
   *
   * The order of the assignments is the contract: the decision is computed from the state *before* this
   * notification, so `lastValue` is written from the result rather than from the adjustment directly.
   *
   * **A missing adjustment reads as `0`/`0`/`0`.** A scrolled window with no vertical adjustment cannot
   * have been scrolled anywhere, and `isAtBottom(0, 0, 0)` is the same "following" answer `#atBottom`
   * gives for one — so the two paths cannot disagree about a window that does not exist yet.
   */
  #onAdjustment(signal: AdjustmentSignal): void {
    const adjustment = this.#scroller.get_vadjustment();
    const update = resolveFollow({
      following: this.#following,
      selfScroll: this.#selfScrolling,
      lastValue: this.#lastValue,
      signal,
      value: adjustment?.get_value() ?? 0,
      upper: adjustment?.get_upper() ?? 0,
      pageSize: adjustment?.get_page_size() ?? 0,
    });
    this.#following = update.following;
    this.#lastValue = update.lastValue;
    // Re-arm before the attempt, and reset the retry count with it: a layout that has just moved the end
    // is a fresh reason to pay an owed scroll, not a continuation of whatever ran out before it.
    if (update.rearmFollow) {
      this.#followPending = true;
      this.#followAttempts = 0;
    }
    if (update.attemptFollow) this.#tryFollow();
  }

  /** The name above each agent bubble. Takes effect for rows built after it, so set it before `setEntries`. */
  setAgentName(name: string): void {
    this.#agentName = name;
  }

  /**
   * Replace the transcript with these entries.
   *
   * Rebuilt, not diffed, for the reason `SessionList.setSessions` is: the row count is somebody's own
   * history, not a feed, and a hand-patched list cannot leave a stale index behind — which is the
   * bug it gets.
   *
   * An empty transcript draws nothing, and that is a decision to correct once. The first version
   * justified it with "the window already has an empty state" — true for a window with **no session
   * open**, which is `Adw.StatusPage` in `window.ts`, and false for a session that *is* open and holds
   * no turns (`kurier start` with no prompt does exactly that, so it is not hypothetical). There the
   * pane is blank, which reads as a load failure rather than as a conversation that has not started.
   * `window.ts` now puts a sentence in that case; this file stays out of it, because the empty state
   * and the empty *transcript* are two different questions and only the window knows which pane is
   * showing.
   *
   * **This one scrolls to the end; `appendEntries` does not.** Opening a session is a request to see it,
   * and the newest entry is what the person asked for. A chunk arriving into a conversation already
   * open is not a request at all — see `appendEntries`.
   */
  setEntries(entries: readonly TranscriptEntry[]): void {
    this.#entries = entries;
    for (const row of this.#rows) this.#column.remove(row);
    this.#rows = [];
    this.#items = toTranscriptItems(entries);
    for (const item of this.#items) this.#appendRow(item);
    // Opening a session *is* a request to see its newest entry, so it re-arms the follow the resize
    // path reads. Without this, opening a session at a narrow width while `#following` was false from
    // a previous session's scroll would leave the newest bubble below the fold on purpose.
    this.#following = true;
    this.#scrollToEnd();
  }

  /**
   * Add entries that just arrived, and do not steal the view.
   *
   * **Two cases, and the difference is not cosmetic.** An arriving chunk usually *extends* the last
   * bubble (that is what `toTranscriptItems`' merging means), so this rebuilds the last row in place;
   * a `plan` update or a tool call adds rows, and those are appended. Either way the row for a
   * *finished* message is never touched, so an open disclosure does not collapse under the reader.
   *
   * **Whether to follow is decided before anything is appended**, because the question is "where was
   * the view a moment ago" and after the append it is unanswerable — the newest row has already moved
   * the end. `isAtBottom` is in `core/scroll.ts` precisely because that rule (plan §6: auto-scroll only
   * when already at the bottom) has to be testable without a display.
   */
  appendEntries(entries: readonly TranscriptEntry[]): void {
    if (entries.length === 0) return;
    const follow = this.#atBottom();
    // Sampled into the field the resize path reads, so a reader who was following keeps following
    // across a re-wrap and a reader who scrolled up stays where they are. See `#following`.
    this.#following = follow;
    this.#entries = [...this.#entries, ...entries];
    const items = toTranscriptItems(this.#entries);
    const previous = this.#items.length;
    this.#items = items;
    if (items.length === previous) {
      // The chunk merged into the run that was already there — one message, one bubble, more text.
      this.#replaceLastRow();
      if (follow) this.#scrollToEnd();
      return;
    }
    // More items than before, which is the only other thing that can happen to an append-only list: the
    // projection merges runs, it never splits them or reorders them.
    for (const item of items.slice(previous)) this.#appendRow(item);
    if (follow) this.#scrollToEnd();
  }

  /** Add one item as a new row at the end of the column. */
  #appendRow(item: TranscriptItem): void {
    const row = buildItem(item, this.#agentName);
    this.#rows.push(row);
    this.#column.append(row);
  }

  /**
   * Rebuild the last row from the current items.
   *
   * **`insert_child_after` rather than remove-and-append**, because the row has to land back at the
   * *same index*: appending would move that line to the bottom of the conversation every time a chunk
   * arrived, so a turn whose last thing was a tool call would shuffle it downwards with each chunk of the
   * answer above it. `insert_child_after(row, sibling)` with the row before it puts the replacement
   * exactly where the old one was, and `null` puts it first — which is what an only-row column needs.
   *
   * GTK 4 removed `gtk_box_reorder_child`, so there is no "move" call to reach for here; the insertion
   * point is the whole mechanism.
   */
  #replaceLastRow(): void {
    const index = this.#rows.length - 1;
    const previous = this.#rows[index];
    const item = this.#items[index];
    if (!previous || !item) return;
    const row = buildItem(item, this.#agentName);
    const sibling = this.#rows[index - 1] ?? null;
    this.#column.insert_child_after(row, sibling);
    this.#column.remove(previous);
    this.#rows[index] = row;
  }

  /**
   * Where the view is now, in the three numbers `isAtBottom` reads.
   *
   * `true` for a missing adjustment: an unallocated scrolled window cannot have been scrolled away
   * from anything, so "following" is the honest answer and the same one `isAtBottom(0, 0, 0)` gives.
   */
  #atBottom(): boolean {
    const adjustment = this.#scroller.get_vadjustment();
    if (!adjustment) return true;
    return isAtBottom(adjustment.get_value(), adjustment.get_upper(), adjustment.get_page_size());
  }

  /**
   * Follow the newest entry.
   *
   * On an idle, not inline: the adjustment's `upper` and `page_size` are both 0 until the scrolled
   * window has been allocated, and setting `value` against those is a silent no-op. A `setEntries`
   * that scrolled inline would therefore work for a window that is already open and do nothing in
   * the one case that matters — the first fill. `PRIORITY_LOW` runs after the frame that does the
   * measuring, so the numbers are real by the time this reads them.
   *
   * **This was measured, not assumed, and the inline version was the bug.** The first cut of this
   * method set the value inline, against a comment that already described the idle — and a
   * mid-stream screenshot showed the newest bubble sitting *below* the fold, half the prompt bubble
   * cut off at the composer's edge while the status line read "Working — the agent is answering".
   * The reason is that a row appended during a turn is not in `upper` yet: the column's natural
   * height grows at the next allocation, so inline arithmetic targets the *previous* end and lands
   * one bubble short. The idle is what makes `upper` include the bubble that just arrived.
   *
   * **One pending idle, not one per call.** A fast stream calls this once per chunk, and a burst of
   * ten would queue ten idle callbacks each re-reading the same adjustment; the second one already
   * has nothing to do. A single pending source is cancelled and replaced, so the callback always
   * reads the numbers as of the *latest* append rather than of a queued one.
   *
   * **And when the adjustment still cannot be read, the follow stays *owed* rather than being
   * dropped.** That is `#followPending`, and it is the part the old comment got wrong: the layout
   * does not settle on its own schedule that one idle happened to catch, and nothing was retrying.
   * The scroll is therefore attempted immediately, on the next idle, and on every later allocation
   * until it lands — bounded by `shouldRetryFollow` so a layout that never measures cannot spin.
   *
   * Scrolling on every fill is right for a *fill* and wrong for a stream, and the difference is
   * where this method sits: `setEntries` replaces the whole transcript, so the newest entry is what
   * the person asked to see. A chunk arriving into an open conversation must not yank the view while
   * somebody is reading (the plan's §6) — that is the method that appends, and it has to check
   * whether the view is already at the bottom first.
   */
  #scrollToEnd(): void {
    this.#followPending = true;
    this.#followAttempts = 0;
    // Cancelled *and* forgotten. A fast stream calls this once per chunk, so the pending idle of the
    // previous chunk is still queued here — and the number has to go with it, or `#tryFollow`'s own
    // `source_remove` (reached whenever a follow lands short) removes the same id a second time, which
    // GLib answers on stderr: six `Source ID … was not found when attempting to remove it` messages on
    // one stand-in turn, before this line cleared the field.
    if (this.#scrollSource !== null) {
      GLib.source_remove(this.#scrollSource);
      this.#scrollSource = null;
    }
    // Inline first: for a turn's chunk the window has been allocated for seconds, so this lands on the
    // first try and the idle below has nothing left to do. The constructor-time fill takes the idle
    // and the `changed` path instead, because at that moment neither can succeed — `upper` and
    // `page_size` are 0 until the window exists (`scripts/probes/scroll-settle.mjs` measures it).
    this.#tryFollow();
    // **`#scrollSource === null`, not just "still owed":** the call above may have queued its own
    // retry from inside `set_value`'s synchronous `changed`, and queuing a second idle would leave the
    // first one running with nobody holding its handle.
    if (this.#followPending && this.#scrollSource === null) {
      this.#scrollSource = GLib.idle_add(GLib.PRIORITY_LOW, () => {
        this.#scrollSource = null;
        this.#tryFollow();
        return GLib.SOURCE_REMOVE;
      });
    }
  }

  /**
   * Put the view on the end, if the adjustment will say where it is.
   *
   * **`null` from `followTarget` is not a failure, it is "not measurable yet"** — and it is the only
   * thing that keeps `#followPending` set. Retrying on the next allocation rather than giving up is
   * what makes a fill issued from the constructor reach the end once the window exists; see the
   * field's own comment for the measurement.
   */
  #tryFollow(): void {
    if (!this.#followPending) return;
    const adjustment = this.#scroller.get_vadjustment();
    const end = adjustment ? followTarget(adjustment.get_upper(), adjustment.get_page_size()) : null;
    if (adjustment === null || end === null) {
      this.#followAttempts += 1;
      if (shouldRetryFollow(this.#followAttempts)) return; // Still owed; a later notification retries.
      // Bounded out on a layout that never measures. Giving up loudly is better than scrolling to a
      // guessed position, and the next append re-arms the whole attempt.
      this.#followPending = false;
      return;
    }
    this.#selfScrolling = true;
    try {
      adjustment.set_value(end);
    } finally {
      this.#selfScrolling = false;
    }
    // **Verify, then re-arm — do not trust the request.** `set_value` clamps silently, and a re-wrap
    // moves `upper` and `page_size` in separate notifications, so this call may have asked past the
    // real maximum and been given it instead. Reading the value back is the only way to know whether
    // the newest entry is actually on screen; measured as a partially visible last line at 480 px.
    if (followLanded(end, adjustment.get_value(), adjustment.get_upper(), adjustment.get_page_size())) {
      this.#followPending = false;
      return;
    }
    this.#followAttempts += 1;
    if (!shouldRetryFollow(this.#followAttempts)) {
      this.#followPending = false;
      return;
    }
    // Landed short, so ask again. On an idle rather than inline: the remaining `page_size` change is
    // still to come, and re-reading it in the same frame would read the same stale numbers.
    if (this.#scrollSource !== null) GLib.source_remove(this.#scrollSource);
    this.#scrollSource = GLib.idle_add(GLib.PRIORITY_LOW, () => {
      this.#scrollSource = null;
      this.#tryFollow();
      return GLib.SOURCE_REMOVE;
    });
  }
}

/** The kind icon in front of a tool or thought row; the status-only caption's is a step smaller. */
const ROW_ICON_PX = 16;
const CAPTION_ICON_PX = 14;

function buildItem(item: TranscriptItem, agentName: string): Gtk.Widget {
  switch (item.kind) {
    case 'user':
      return buildBubble(item.text, Gtk.Align.END, CSS.bubbleUser);
    case 'agent':
      return buildAgentMessage(item.text, item.at, agentName);
    // `dialog-information-symbolic`, and not because a thought is information. Adwaita has no icon
    // for reasoning: `chat-symbolic` and `lightbulb-symbolic` are not in the theme at all, and
    // `dialog-question-symbolic` — the name the first version used — is a "?" in a diamond that
    // reads as the missing-icon placeholder, which is what the screenshot showed. Checked with
    // `Gtk.IconTheme.has_icon`, like every icon name in this repo.
    case 'thought':
      // Proportional and dim: the body of a thought is commentary on the answer, and a command is
      // not prose. See `.kurier-thought` and the `monospace` name class.
      return buildDisclosure('dialog-information-symbolic', item, CSS.thought);
    case 'tool': {
      // A payload is what the disclosure opens onto, so a line without one is not a disclosure.
      if (item.detail !== null) return buildDisclosure(TOOL_FALLBACK_ICON, item, CSS.mono);
      const line = parseToolLine(item.summary);
      return line.title === '' ? buildToolStatus(line.status) : buildToolCard(line);
    }
    case 'system':
      return buildNote(item.text);
  }
}

/**
 * One message, in the speaker's own colour and on the speaker's own side.
 *
 * `halign` is set on the **bubble**, not on the label inside it, and that is the part that is easy to
 * get backwards: a child of a vertical `Gtk.Box` is given its natural width unless it expands, so
 * the alignment has to be on the widget the box places. A wrapping label's natural width is the
 * *unwrapped* text, so a short answer is a short bubble and a long one is capped by the clamp and
 * wraps there — which is what makes the column read as a conversation rather than as full-width
 * paragraphs.
 */
function buildBubble(text: string, align: Gtk.Align, speaker: string): Gtk.Widget {
  return buildLabel({
    text,
    xalign: 0,
    align,
    cssClasses: [CSS.bubble, speaker, CSS.transcriptText],
  });
}

/**
 * An agent bubble under a dim caption: who said it, and when.
 *
 * The time is the entry's own `at`, formatted in the reader's timezone; an `at` the store carries as
 * garbage drops the time rather than printing it. A merged run of chunks shows the time of its first.
 */
function buildAgentMessage(text: string, at: string, agentName: string): Gtk.Widget {
  const time = GLib.DateTime.new_from_iso8601(at, null)?.to_local()?.format('%R') ?? null;
  const caption = [agentName, time].filter((part): part is string => !!part).join(' · ');
  const bubble = buildBubble(text, Gtk.Align.START, CSS.bubbleAgent);
  if (caption === '') return bubble;
  const column = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });
  column.append(
    buildLabel({ text: caption, xalign: 0, align: Gtk.Align.START, cssClasses: [CSS.dim, 'caption'] }),
  );
  column.append(bubble);
  return column;
}

/**
 * A tool call as a card: icon, bold title, status capsule.
 *
 * A line with no recognisable status gets no capsule rather than an invented one.
 */
function buildToolCard(line: ToolLine): Gtk.Widget {
  const card = new Gtk.Box({
    orientation: Gtk.Orientation.HORIZONTAL,
    spacing: 8,
    cssClasses: ['card', CSS.toolCard],
  });
  card.append(new Gtk.Image({ iconName: toolIcon(line.title), pixelSize: ROW_ICON_PX }));
  const title = buildLabel({ text: line.title, xalign: 0, cssClasses: ['heading'] });
  title.set_hexpand(true);
  card.append(title);
  if (line.status !== null) card.append(buildTonePill(line.status));
  return card;
}

/**
 * A tool line that carries a status and no title — the second half of one call.
 *
 * It is a caption rather than a card because there is nothing to name: a card here would need a
 * heading the agent never sent, and the line belongs to the call above it anyway.
 */
function buildToolStatus(status: ToolLine['status']): Gtk.Widget {
  const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
  row.append(new Gtk.Image({ iconName: TOOL_FALLBACK_ICON, pixelSize: CAPTION_ICON_PX, cssClasses: [CSS.dim] }));
  row.append(
    status === null
      ? buildLabel({ text: 'Tool call', xalign: 0, cssClasses: [CSS.dim, 'caption'] })
      : buildTonePill(status),
  );
  return row;
}

/** A status word in its tone's capsule, on a label (Adwaita's `pill` is a button shape). */
function buildTonePill(status: NonNullable<ToolLine['status']>): Gtk.Label {
  const tone = { running: 'accent', done: 'success', failed: 'error' }[status.tone];
  return new Gtk.Label({
    label: status.label,
    useMarkup: false,
    valign: Gtk.Align.CENTER,
    cssClasses: [CSS.pill, tone],
  });
}

/**
 * A centred system note. Quiet, because it is not a speaker: a mode change is the conversation's own
 * bookkeeping and must not outrank the messages around it.
 */
function buildNote(text: string): Gtk.Widget {
  return buildLabel({ text, xalign: 0.5, align: Gtk.Align.CENTER, cssClasses: [CSS.note] });
}

/**
 * One closed line that opens: a tool call, or a thought.
 *
 * Both are the same widget, which is the point of `DisclosureItem` carrying `summary`/`detail`/
 * `expanded` together. A tool call and a thought differ in their icon and in the type of their body;
 * the interaction is one. `detail === null` is the third shape: a tool line carries no payload, so
 * the same head is returned as a plain row and no chevron is drawn at all — a disclosure that opens
 * onto nothing is a control that points at nothing, and this file's own header forbids those.
 */
function buildDisclosure(iconName: string, item: DisclosureItem, bodyClass: string): Gtk.Widget {
  // The expander draws its own chevron, so the icon here is the *kind* — a tool call, a thought —
  // not the open/closed state. Verified to exist with `Gtk.IconTheme.has_icon`; a name the theme
  // does not have renders as a broken-image placeholder, which is what `window.ts` records for
  // `chat-symbolic`.
  const head = new Gtk.Box({
    orientation: Gtk.Orientation.HORIZONTAL,
    spacing: 6,
    // The summary is agent text, so it wraps like everything else. It can only wrap if the box
    // takes the expander's width — a horizontal box hands out natural widths otherwise, and a
    // wrapped label's natural width is the whole unwrapped line.
    hexpand: true,
  });
  head.append(new Gtk.Image({ iconName, pixelSize: ROW_ICON_PX }));
  head.append(buildLabel({ text: item.summary, xalign: 0, cssClasses: [] }));

  // The class goes on the row here and on the expander below, never on both: `font-size` multiplies
  // down the tree rather than being inherited as a computed value, so a head inside an expander that
  // already carries `.kurier-disclosure` would render the summary at 0.81em. See `css.ts`.
  if (item.detail === null) {
    head.add_css_class(CSS.disclosure);
    return head;
  }

  // The body is a label and not a `Gtk.TextView`: the transcript records a tool call's title and
  // status, not its payload, so the body is one or two short lines (see `toTranscript`'s file
  // header). A text view would be the right call for a diff and would be inventing a surface for
  // text that is not here.
  return new Gtk.Expander({
    labelWidget: head,
    child: buildLabel({ text: item.detail, xalign: 0, cssClasses: [CSS.disclosureBody, bodyClass] }),
    expanded: item.expanded,
    // Neither resizes the toplevel: this column is refilled on every stream chunk, and a window
    // that grows a line under the pointer moves what the pointer was aiming at.
    resizeToplevel: false,
    cssClasses: [CSS.disclosure],
  });
}

interface LabelSpec {
  readonly text: string;
  /** Text alignment inside the label's own width. 0 hugs the start, 0.5 centres. */
  readonly xalign: number;
  readonly cssClasses: readonly string[];
  /** Where the label sits in the column. Defaults to filling it — a bubble overrides it. */
  readonly align?: Gtk.Align;
}

/**
 * The one place a `Gtk.Label` is built in this file.
 *
 * **`useMarkup: false` is the point of this function.** See the file header: the text is the agent's
 * own words, GTK parses markup on assignment, and a string it refuses renders as an empty label.
 *
 * `wrap` and `selectable` together, because this is text somebody came to read and may well have
 * come to copy — a label that cannot be selected is a screenshot. `xalign: 0` because a wrapped
 * paragraph is ragged on the right anyway and centring it would just make both edges ragged.
 */
function buildLabel(spec: LabelSpec): Gtk.Label {
  return new Gtk.Label({
    label: spec.text,
    useMarkup: false,
    wrap: true,
    selectable: true,
    xalign: spec.xalign,
    ellipsize: Pango.EllipsizeMode.NONE,
    halign: spec.align ?? Gtk.Align.FILL,
    cssClasses: [...spec.cssClasses],
  });
}
