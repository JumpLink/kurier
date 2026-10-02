/**
 * The approval dialog: what the agent wants, and the agent's own buttons.
 *
 * **This file renders and nothing else.** Which options appear, what a dismissal means, what happens
 * to a second request — all of that is `core/permission.ts`, decided before this widget exists. What is
 * left here is GTK: build the body, wire the buttons, resolve the promise with the id that was pressed.
 *
 * **`add_response` per option, plus `extra_child` — not `alert` and not `choose`.** `alert` gives every
 * response the same role and takes no body, so it cannot carry the agent's raw input. `choose` is the
 * one that also takes ids, but its runtime binding takes a callback and not a promise
 * (`@girs/adw-1` types it as returning `Promise<string>`, and two arguments throw at runtime —
 * `scripts/probes/alert-dialog-close.mjs` prints that measurement), so wrapping it would be a promise
 * around a callback around a `present()` this file already does. Connecting `response` directly is
 * the same signal with one less layer, and it is also what makes the two teardown paths — Escape and
 * `close()` — reachable, because both go through this widget's own handlers.
 *
 * **The id `response` carries is the whole contract with the core.** Whatever it is — a button the
 * agent offered, or the close response — it goes back as a string and `core/permission.ts` decides
 * what it means. That is what lets the fail-closed rule live in tested pure code instead of in an
 * `if` over GTK response ids: this file has no idea which ids are safe to allow.
 *
 * **`useMarkup: false` on every label, without exception.** Everything in this dialog is text an agent
 * wrote: a tool title, a file path, a diff. Agent text is data, and Pango markup would let
 * `<b>allowed</b>` or a `<span>` smuggle formatting — or a whole extra row — into a control whose
 * button labels are the decision. The one label in this file that is kurier's own copy has no markup
 * either, so there is no exception to remember. The copy is fixed English strings, not `Intl`.
 *
 * **The button labels are kurier's, not the agent's** — see `optionLabel` in `core/permission.ts`
 * and the note where the responses are added. `kind` decides both the words and the appearance, so an
 * agent cannot ship a button that reads "Decline" and allows.
 *
 * **Every option the agent sent is a button, including the two `*_always` kinds**, in the order
 * `orderOptions` gives rather than the order the agent listed them. The rest of what this dialog does
 * — the fail-closed answer for a dismissal, the empty option set answered `cancelled` — is
 * `core/permission.ts`, and so is the decision that `allow_once` is the only SUGGESTED response.
 *
 * **The `rawInput` body is a `Gtk.TextView` in a `Gtk.ScrolledWindow`, not a label.** A label ellipsizes
 * or grows without bound, and a tool's raw input is unbounded — a diff can be thousands of lines. The
 * scroller's `max-content-height` is the cap (verified as a real property by
 * `scripts/probes/alert-dialog-close.mjs`, which sets and reads it back), the view is non-editable and
 * cursorless because this is something to read and copy, not something to change before answering, and
 * it is selectable because the natural reaction to a surprising diff is to select a line of it.
 */

import Adw from '@girs/adw-1';
import GLib from '@girs/glib-2.0';
import Gtk from '@girs/gtk-4.0';

import {
  agentNames,
  initialFocusResponseId,
  optionLabel,
  type PermissionQuestion,
  type PermissionView,
} from '../../core/permission.ts';
import { CSS } from './css.ts';

/** The cap on the raw-input body. A dialog taller than its content pushes its own buttons off screen. */
const BODY_MAX_HEIGHT_PX = 240;

/** What kurier says when the agent reported no raw input at all. */
const NO_RAW_INPUT = 'The agent did not say what it wanted to do with this.';

/** What kurier says when the agent named no locations. */
const NO_LOCATIONS = 'The agent did not say where.';

/**
 * The response id a dismissal reports.
 *
 * **Left at libadwaita's default, and that is deliberate.** `Adw.AlertDialog`'s `close_response`
 * defaults to `"close"`, Escape reports it, and it is not one of the dialog's responses
 * (`has_response("close") = false`) — all three measured in `scripts/probes/alert-dialog-close.mjs`,
 * cases 4 and the summary. So a dismissal arrives as an id that is *not one of the agent's options*,
 * and `core/permission.ts` fails that closed on the general rule rather than on a special case.
 *
 * Setting it to the agent's rejecting option instead would also work, and it is weaker: it makes
 * safety depend on the agent having offered an id with that exact string, so kurier would have to know
 * the agent's ids to fail closed. The same probe measures that spelling (case 6). An id no agent can
 * offer is the safer half of the same idea — and it is also the only one that cannot be an
 * `allow_*`, which is the whole point.
 */
const DISMISSAL_ID = 'close';

/**
 * One question, shown modally over the window.
 *
 * Resolves with the id of the button that was pressed, with `DISMISSAL_ID` for anything that was not
 * a press, or with `null` if the dialog was destroyed without either. It never rejects: a window that
 * is closing is not a failure, and a rejected promise here would become a failed turn.
 *
 * **`question` exists so a caller can tell "this dialog is up" from "the gate has asked about
 * something"** — the desk owns the second question and this widget only the first, and the two are
 * different: a question can be queued behind an open one and there is no widget for it yet.
 */
export class PermissionDialog {
  readonly #window: Adw.Window;
  #dialog: Adw.AlertDialog | null = null;
  /** The question this dialog is showing, so a second `show` cannot race the first. */
  #current: string | null = null;

  constructor(window: Adw.Window) {
    this.#window = window;
  }

  /** The question on screen, or null when nothing is. */
  get question(): string | null {
    return this.#current;
  }

  /**
   * Ask. Resolves with the pressed id, or with `null` for anything that was not a press.
   *
   * **Only one at a time, and the second `show` replaces the first.** `core/permission.ts` queues, so
   * a `show` while one is open is either a stale question or a bug — and stacking a second modal
   * dialog over the first would leave the person looking at whichever was drawn last, which is not
   * something kurier knows the order of. Replacing keeps one dialog, one question, one answer.
   */
  show(question: PermissionQuestion): Promise<string | null> {
    this.close();
    this.#current = question.id;
    return new Promise<string | null>((resolve) => {
      let settled = false;
      const settle = (id: string | null) => {
        if (settled) return;
        settled = true;
        resolve(id);
      };
      const { dialog, rawInput } = buildDialog(question.view);
      dialog.connect('response', (_self, response) => {
        this.#forget(dialog);
        settle(typeof response === 'string' ? response : DISMISSAL_ID);
      });
      // **`closed` is deferred to an idle, and that deferral is the whole point of this handler.**
      // `Adw.Dialog` emits `closed` *before* `response` — measured, and not what the signal docs
      // suggest: pressing "Allow once" produces `closed` then `response("allow_once")`. A handler that
      // settled on `closed` would therefore resolve every press as a dismissal, and the gate could
      // never allow anything: not a bug in the fail-closed direction, a bug in the *only* direction
      // that matters, and one that a screenshot cannot see because the dialog still looks right.
      // Letting the main loop turn once puts `response` in front of the fallback.
      //
      // The fallback is still needed: `closed` is the only signal a dialog torn down without an answer
      // emits, and the dialog IS destroyed rather than answered when its window goes away. It settles
      // `null`, which `core/permission.ts` reads as a dismissal.
      //
      // **The deferred callback touches this widget's fields only if it is still the same dialog**, and
      // that guard is not a tidiness check — it is the difference between a dialog and an orphan. The
      // idle runs a main-loop turn after `response` resolved the promise, which is a microtask *before*
      // it; so the desk has already promoted the next queued question and `show()` has already built
      // and presented dialog 2. An unguarded idle would then clear `#dialog` and `#current` and leave
      // dialog 2 on screen with nothing pointing at it: `close()` would be a no-op for Stop, for a
      // closing window and for a dead agent, and a later question would stack a third dialog over it.
      // Pressing the orphan's button would resolve into `desk.answer(id)`, which applies to whatever
      // is open *now* — an allow for a request nobody read. `scripts/probes/alert-dialog-close.mjs`
      // case 8 walks the sequence.
      dialog.connect('closed', () => {
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
          if (this.#dialog !== dialog) return GLib.SOURCE_REMOVE;
          this.#forget(dialog);
          settle(null);
          return GLib.SOURCE_REMOVE;
        });
      });
      // **The focus is kurier's decision and it is never an allow button.** Two separate things decide
      // the focus, and this handler owns both: the *fallback* libadwaita picks when `default_response`
      // is unset, and the *actual* focus kurier assigns afterwards. See the `default_response` note in
      // `buildDialog` for the measured numbers; the short version is that the fallback is the **first**
      // added response, so `orderOptions` makes that slot a decline, and this handler then makes the
      // real focus the narrowest decline or — with nothing to decline with — the diff body.
      //
      // **Synchronously inside `map`, and an idle afterwards, because that is what the measurement said.**
      // **Inside `map`, then once more in an idle — and the measurement says a grab is what matters, not
      // which kind.** Case 10 of `scripts/probes/alert-dialog-close.mjs` builds the same look-alike three
      // ways with two allows and no `default_response`: grabbing synchronously inside `map`, deferring
      // the grab to an idle, and not grabbing at all. The first sample of the first two is the body in
      // both cases; the third is `Allow once`, and it stays there. So a grab is required and either form
      // delivers it — an earlier version of this comment claimed the synchronous one *beats* the idle,
      // and the numbers do not say that.
      //
      // **The synchronous form is kept anyway, for a structural reason rather than a measured one:** an
      // idle is dispatched in priority order, so one libadwaita queues *after* ours would run after it.
      // Grabbing inside `map` cannot be beaten that way. The second grab, in the idle, covers `map`
      // firing before the dialog's final allocation and costs nothing.
      //
      // **What each measurement covers, because they do not overlap.** All of the above is a look-alike —
      // `scripts/probes/`, the half of the split that cannot speak for this widget — and case 10 cannot
      // be reproduced against `PermissionDialog` itself: `present()` maps synchronously, so by the time
      // `app/tests/probes/permission-focus.ts` has a timer running, this grab has already happened and
      // the pre-idle frame is not observable from outside. That probe covers the settled focus and the
      // turn-by-turn sequence; neither result is stretched to answer the other.
      const focusId = initialFocusResponseId(question.view.options);
      const focusNow = (): void => {
        // The dialog may already be gone — a Stop in the same frame — and then there is nothing to
        // focus and nothing to do.
        if (this.#dialog !== dialog) return;
        const target = focusId === null ? rawInput : responseButton(dialog, focusId);
        target?.grab_focus();
        // A focused selectable widget selects its text, and a selection over the diff reads as a
        // grey block — it was visible in the first screenshot of this dialog. On a `Gtk.TextView` the
        // selection belongs to the *buffer*, not to the widget: `GtkTextView.select_region` does not
        // exist (it is a `Gtk.Label`/`Gtk.Entry` method, and calling it throws), so the empty range
        // goes through `Gtk.TextBuffer.select_range` with two iters at offset 0.
        if (target instanceof Gtk.TextView) deselect(target);
      };
      dialog.connect('map', () => {
        focusNow();
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
          focusNow();
          return GLib.SOURCE_REMOVE;
        });
      });
      this.#dialog = dialog;
      dialog.present(this.#window);
    });
  }

  /** Drop this widget's references to a dialog that is no longer on screen. */
  #forget(dialog: Adw.AlertDialog): void {
    // The callers are the `response` handler, the guarded `closed` idle above and the focus idle, and
    // all three check that this is still the live dialog first. Keeping the parameter is what makes
    // that one place rather than three.
    if (this.#dialog !== dialog) return;
    this.#dialog = null;
    this.#current = null;
  }

  /**
   * Take the dialog down.
   *
   * **Used by Stop, by a closing window and by an agent that died** — the three paths where the turn
   * has already settled and the question is answered `cancelled`.
   *
   * **`close()`, not `force_close()`.** `Adw.Dialog.close()` emits `closed` and then `response` with
   * the close response (measured: `scripts/probes/alert-dialog-close.mjs`, case 1), so the promise
   * above settles and the gate gets its answer. `force_close()` is the one that emits *nothing* —
   * also measured, same probe, case 5 — which would leave the promise unsettled and the turn waiting
   * on a question that is no longer on screen. It exists for a dialog whose `can-close` is false,
   * which this one never sets.
   */
  close(): void {
    const dialog = this.#dialog;
    if (dialog === null) return;
    this.#dialog = null;
    this.#current = null;
    dialog.close();
  }
}

/**
 * The dialog: the agent's question as the body, the agent's own options as the buttons.
 *
 * **The body is a list of rows, in a fixed order, because that is what a question needs.** What the
 * tool is, what kind of thing it wants to do, where, and then the raw input in full. `Adw.PreferencesGroup`
 * would put every one of those in a list row with its own heading, which is a settings screen around a
 * question; a plain box reads as a question. The heading text is kurier's own and therefore constant.
 *
 * **The raw-input view comes back too**, because it is the focus target when the agent offered no
 * rejecting option — see `show`. A `Gtk.Box` is not focusable, so the body as a whole cannot take the
 * focus; the view inside it can. Returning it rather than searching for it afterwards is what keeps
 * "what the focus lands on" and "what the dialog shows" the same object.
 */
function buildDialog(view: PermissionView): { dialog: Adw.AlertDialog; rawInput: Gtk.TextView } {
  // The inset is a *widget* margin, set through the property setter rather than in the constructor
  // literal, and the names are `margin-start`/`margin-end` — the hyphenated widget properties, not the
  // camelCase CSS spelling and not `margin-left`. `Gtk.Box`'s constructor props are typed against the
  // hyphenated names, so the literal would have to spell it `'margin-start': 6`, and the setter is
  // the same property without the quoting.
  //
  // **`margin-start`/`margin-end` exist as widget properties in GTK 4 but not in its CSS**, and the
  // two are not interchangeable: `css.ts` records that the CSS parser rejects the logical names with
  // "No property named …" *while still loading the rest of the stylesheet*, so a stylesheet using them
  // looks like it worked. The property setters below go through GObject, not through the parser, so
  // this is the one place the logical names are safe.
  const body = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 10 });
  body.margin_start = 6;
  body.margin_end = 6;

  const title = new Gtk.Label({
    label: view.tool,
    // Agent text. No markup, ever.
    useMarkup: false,
    wrap: true,
    selectable: true,
    xalign: 0,
    // `title-4`, not `CSS.title`: that constant is `title-1`, which is the size of a *window* title
    // (see `window.ts` on why the sidebar bar does not use it). The tool title is the strongest line
    // in a dialog, not the loudest one in the app.
    cssClasses: ['title-4'],
  });
  body.append(title);

  // The kind, as a small dimmed line rather than as a heading: it is metadata about the tool, and a
  // `read`/`edit`/`execute` word in a heading font would give it the weight of the question itself.
  body.append(
    new Gtk.Label({
      label: view.kind,
      useMarkup: false,
      wrap: true,
      selectable: true,
      xalign: 0,
      cssClasses: [CSS.dim],
    }),
  );

  if (view.locations.length > 0) {
    // One label for all of them, newline-separated, so several paths read as one list instead of N
    // blocks — and so the path does not become the most prominent thing in the dialog.
    body.append(
      new Gtk.Label({
        label: view.locations.join('\n'),
        useMarkup: false,
        wrap: true,
        selectable: true,
        xalign: 0,
        cssClasses: [CSS.mono, CSS.dim],
      }),
    );
  } else {
    // "The agent did not say where" rather than an empty row. An empty box reads as *there is
    // nothing here*, which is a different claim from *the agent did not say*, and the difference is
    // the whole reason a person can tell a vague request from a complete one.
    body.append(
      new Gtk.Label({
        label: NO_LOCATIONS,
        useMarkup: false,
        wrap: true,
        selectable: true,
        xalign: 0,
        cssClasses: [CSS.dim],
      }),
    );
  }

  // The agent's own names for its options, as one caption line — and only when at least one of them says
  // something the kurier labels do not. Agent text, so `useMarkup: false` like everything else here; and
  // dimmed, because it is metadata about the buttons rather than part of the question. This is where the
  // wording went when it came off the buttons, so nothing the agent told the person is lost.
  const names = agentNames(view.options);
  if (names !== null) {
    body.append(
      new Gtk.Label({
        label: names,
        useMarkup: false,
        wrap: true,
        selectable: true,
        xalign: 0,
        cssClasses: [CSS.dim],
      }),
    );
  }

  // The raw input, verbatim, scrollable and capped. `readOnly` + `cursorVisible: false` because this
  // is a thing to read; editable text in an approval dialog invites an edit before an approval, and
  // the answer would be about a request kurier never received.
  const rawView = new Gtk.TextView({
    editable: false,
    cursorVisible: false,
    monospace: true,
    wrapMode: Gtk.WrapMode.WORD_CHAR,
    leftMargin: 8,
    rightMargin: 8,
    topMargin: 6,
    bottomMargin: 6,
    cssClasses: [CSS.gateInput],
  });
  // `len: -1` is the binding's way of saying "to the end of the string" — `Gtk.TextBuffer.set_text`
  // takes a length in bytes and a one-argument call is a type error, not a default.
  rawView.get_buffer()?.set_text(view.rawInput ?? NO_RAW_INPUT, -1);
  const scroller = new Gtk.ScrolledWindow({
    child: rawView,
    // The measured cap. Without it a thousand-line diff makes a dialog whose buttons are below the fold.
    maxContentHeight: BODY_MAX_HEIGHT_PX,
    propagateNaturalHeight: true,
    hscrollbarPolicy: Gtk.PolicyType.NEVER,
    vscrollbarPolicy: Gtk.PolicyType.AUTOMATIC,
  });
  body.append(scroller);

  const dialog = new Adw.AlertDialog({ heading: 'The agent wants permission' });
  // `extra_child` rather than a longer heading: the heading is one kurier sentence and stays that way,
  // whatever the agent's tool is called. A heading built from the agent's title would let agent text
  // into the part of the dialog that reads as the app's own voice — and into the one string that is
  // the app's own voice, which is exactly the line not to cross.
  dialog.set_extra_child(body);
  // **`add_response` per option, in kurier's order, with no extra one.** There is no
  // `set_choices` on `Adw.AlertDialog` — `add_responses` is the batch form and takes no appearances,
  // so the loop is where the appearance belongs anyway. The order is `view.options`'s, which
  // `orderOptions` in `core/` already decided; see its comment for the measured reason.
  //
  // **The label is `optionLabel(option)` — kurier's own sentence for the kind, and *only* that.** Both
  // the words and the appearance come from the same place on purpose: an option's `name` is the
  // agent's to choose, and ACP lets an agent call its `allow_once` option "Decline". Printing that
  // verbatim gives a suggested-looking button reading "Decline" that allows, and the person has no way
  // to tell. *Appending* it — the earlier "Allow once: Allow once" shape — fixed that and cost the
  // button row its legibility: a screenshot read "Always decline: Always decline in thi…", the words
  // twice with the ellipsis inside the repeat, and at kurier's own 360 px floor it was unreadable. So
  // the buttons carry four short sentences and the agent's wording moves into the body as one caption
  // line (`agentNames`), where it can wrap. `optionLabel` still doubles underscores, because
  // `add_response` parses mnemonics and an agent must not choose kurier's Alt accelerator. The
  // decision and the label cannot disagree: they are the same `kind`.
  //
  // **`default_response` IS set, to the decline, and that is the fix for the first frame.**
  //
  // With it unset, libadwaita focuses the **first** added response — measured, and it is *not* the
  // "last added" `Adw-1.gir` claims (`scripts/probes/alert-dialog-close.mjs` case 9 prints both
  // directions). `orderOptions` puts `reject_once` first so that fallback is a decline, and setting
  // `default_response` to the decline makes the two agree explicitly rather than by coincidence.
  //
  // **The interesting case is an agent that offers no decline at all.** Then there is no safe response
  // to name, libadwaita's fallback lands on `allow_once` — the first allow — and only kurier's own
  // `grab_focus` stands between that and a stray Enter. Measured (case 10): a look-alike with two allows
  // and no `default_response` that does *not* grab reads `Allow once` at its first sample and stays
  // there, while one that grabs — inside `map` or in an idle — reads the body. So the mitigation for
  // that case is not a different default but the grab in `show()`, which is why that grab is there.
  // **`allow_once` is SUGGESTED and `allow_always` is not, which is the one styling decision this loop
  // makes.** SUGGESTED is emphasis, and libadwaita reads "emphasised" as "this is what you want to
  // press" — so marking the permanent grant as the suggested one would be kurier *recommending* it,
  // on a question kurier does not own. Two SUGGESTED buttons would be worse than none: the pattern is
  // for exactly one response, and two of them make it unclear which. So the ordinary allow carries the
  // emphasis and "Always allow" keeps the default appearance — visible, pressable, unendorsed. Equally
  // it is **not** `DESTRUCTIVE`: that appearance means "this undoes something", which is a claim about
  // the tool call rather than about the button, and a permanent *allow* is not a destructive action.
  // `reject_always` is left plain for the same reason `allow_always` is — the kind is not the damage.
  //
  // `view.options` arrives in `orderOptions`' order, so the *first* response added — the one libadwaita
  // would focus if kurier lost the focus race — is a decline when a decline was offered at all.
  for (const option of view.options) {
    dialog.add_response(option.optionId, optionLabel(option));
    if (option.kind === 'allow_once') {
      dialog.set_response_appearance(option.optionId, Adw.ResponseAppearance.SUGGESTED);
    }
  }
  // The default is named here rather than left to the add order, so the two agree on purpose.
  const declineId = initialFocusResponseId(view.options);
  if (declineId !== null) dialog.set_default_response(declineId);
  return { dialog, rawInput: rawView };
}

/** An empty selection on a text view, so focusing it does not grey anything out. */
function deselect(view: Gtk.TextView): void {
  const buffer = view.get_buffer();
  if (buffer === null) return;
  // Two iters at offset 0 is an empty range, which is what `Gtk.TextBuffer` understands as "nothing
  // selected". There is no `select_region(0, 0)` on a `Gtk.TextView` to reach for — that is a
  // `Gtk.Label`/`Gtk.Entry` method, and its arguments there are characters, not offsets.
  buffer.select_range(buffer.get_iter_at_offset(0), buffer.get_iter_at_offset(0));
}

/**
 * The `Gtk.Button` behind a response id, or null.
 *
 * **Matched by the label `optionLabel` produced, not by the agent's `optionId`.** `Adw.AlertDialog`
 * builds one button per response and gives no accessor for it by id, so the label is the only handle
 * there is — and it has to be the *rendered* label, mnemonic escaping and all, or the match is on a
 * string the button does not carry.
 */
function responseButton(dialog: Adw.AlertDialog, optionId: string): Gtk.Button | null {
  const label = dialog.get_response_label(optionId);
  if (label === null) return null;
  let found: Gtk.Button | null = null;
  const walk = (widget: Gtk.Widget): void => {
    if (found !== null) return;
    if (widget instanceof Gtk.Button && widget.get_label() === label) {
      found = widget;
      return;
    }
    let child: Gtk.Widget | null = widget.get_first_child();
    while (child !== null) {
      walk(child);
      child = child.get_next_sibling();
    }
  };
  walk(dialog);
  return found;
}
