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
 * No copy button, no timestamps under the bubbles, no per-item controls. Everything on screen is
 * something the transcript actually holds; a control that points at nothing is the one thing this
 * window's own header forbids.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';
import Pango from '@girs/pango-1.0';

import type { TranscriptEntry } from '@kurier/session';

import { toTranscriptItems, type DisclosureItem, type TranscriptItem } from '../../core/transcript-items.ts';
import { CONTENT_MAX_WIDTH_PX } from './constants.ts';
import { CSS } from './css.ts';

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
  /** Rows currently in the column, so a refill can tell a rebuild from a change. */
  #rows: Gtk.Widget[] = [];

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
   */
  setEntries(entries: readonly TranscriptEntry[]): void {
    for (const row of this.#rows) this.#column.remove(row);
    this.#rows = [];
    for (const item of toTranscriptItems(entries)) {
      const row = buildItem(item);
      this.#rows.push(row);
      this.#column.append(row);
    }
    this.#scrollToEnd();
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
   * Scrolling on every fill is right for a *fill* and wrong for a stream, and the difference is
   * where this method sits: `setEntries` replaces the whole transcript, so the newest entry is what
   * the person asked to see. A chunk arriving into an open conversation must not yank the view while
   * somebody is reading (the plan's §6) — that is the method that appends, and it has to check
   * whether the view is already at the bottom first.
   */
  #scrollToEnd(): void {
    const adjustment = this.#scroller.get_vadjustment();
    if (!adjustment) return;
    const end = adjustment.get_upper() - adjustment.get_page_size();
    if (end <= 0) return; // Not measured yet; the first frame's allocation retries this.
    adjustment.set_value(end);
  }
}

function buildItem(item: TranscriptItem): Gtk.Widget {
  switch (item.kind) {
    case 'user':
      return buildBubble(item.text, Gtk.Align.END, CSS.bubbleUser);
    case 'agent':
      return buildBubble(item.text, Gtk.Align.START, CSS.bubbleAgent);
    // `dialog-information-symbolic`, and not because a thought is information. Adwaita has no icon
    // for reasoning: `chat-symbolic` and `lightbulb-symbolic` are not in the theme at all, and
    // `dialog-question-symbolic` — the name the first version used — is a "?" in a diamond that
    // reads as the missing-icon placeholder, which is what the screenshot showed. Checked with
    // `Gtk.IconTheme.has_icon`, like every icon name in this repo.
    case 'thought':
      // Proportional and dim: the body of a thought is commentary on the answer, and a command is
      // not prose. See `.kurier-thought` and the `monospace` name class.
      return buildDisclosure('dialog-information-symbolic', item, CSS.thought);
    case 'tool':
      return buildDisclosure('system-run-symbolic', item, CSS.mono);
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
  head.append(new Gtk.Image({ iconName, pixelSize: 16 }));
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
