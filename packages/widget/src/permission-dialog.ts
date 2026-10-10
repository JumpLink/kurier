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
 * button labels are the decision. The one label in this file that is lotse's own copy has no markup
 * either, so there is no exception to remember. The copy is fixed English strings, not `Intl`.
 *
 * **The button labels are lotse's, not the agent's** — see `optionLabel` in `core/permission.ts`
 * and the note where the responses are added. `kind` decides both the words and the appearance, so an
 * agent cannot ship a button that reads "Decline" and allows.
 *
 * **The `rawInput` body is a `Gtk.TextView` in a `Gtk.ScrolledWindow`, not a label.** A label ellipsizes
 * or grows without bound, and a tool's raw input is unbounded — a diff can be thousands of lines. The
 * scroller's `max-content-height` is the cap (verified as a real property by
 * `scripts/probes/alert-dialog-close.mjs`, which sets and reads it back), the view is non-editable and
 * cursorless because this is something to read and copy, not something to change before answering, and
 * it is selectable because the natural reaction to a surprising diff is to select a line of it.
 *
 * **The body's tree is in `permission-body.blp`; this file fills it.** The rows, their order, the wrap,
 * the margins and the scroller's cap are markup. What stays here is what a question changes — every
 * string, the `CSS.*` class names `css.ts` owns, the hidden-or-shown locations row, and the buffer.
 * The widget the template produces is a `Gtk.Box` subclass of its own, because a template needs a
 * `GType` to hang on: this dialog is not one (`PermissionDialog` below is a plain class that owns an
 * `Adw.AlertDialog` and a promise), and pretending otherwise would put a GObject on a thing that has
 * no signal, no property and no lifetime of its own.
 */

import Adw from '@girs/adw-1';
import GLib from '@girs/glib-2.0';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';

import {
  agentNames,
  initialFocusResponseId,
  optionLabel,
  type PermissionQuestion,
  type PermissionView,
} from '@lotse/core';
import { CSS } from './css.ts';
import { toolIcon } from './tool-line.ts';
import BodyTemplate from './permission-body.blp';

/** What lotse says when the agent reported no raw input at all. */
const NO_RAW_INPUT = 'The agent did not say what it wanted to do with this.';

/** What lotse says when the agent named no locations. */
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
 * safety depend on the agent having offered an id with that exact string, so lotse would have to know
 * the agent's ids to fail closed. The same probe measures that spelling (case 6). An id no agent can
 * offer is the safer half of the same idea — and it is also the only one that cannot be an
 * `allow_*`, which is the whole point.
 */
const DISMISSAL_ID = 'close';

/**
 * The body, as a `Gtk.Box` of its own type so `permission-body.blp` has a `GType` to hang on.
 *
 * **A subclass rather than an inline child, and that is the shape a template forces.** `Template` is a
 * property of a registered class, so "the tree in the template" means "a class whose tree is the
 * template" — and the body was already a `Gtk.Box` with four labelled rows, so promoting it to a type
 * adds a name rather than a layer.
 *
 * **`InternalChildren`, not public fields.** The rows are the template's, and the names mirror its ids
 * the way `window.ts`'s do: the constructor fills them and `buildDialog` reads them. There is no
 * accessor surface because nothing outside this file has a reason to reach the body.
 *
 * **The `CSS.*` classes are applied here, not declared in the template.** `css.ts` owns those names as
 * constants; a `.blp` cannot import a TypeScript constant, so spelling them as literals in the markup
 * would be a second source of truth for the stylesheet's class names, kept in step by hand. The
 * template owns the tree and the geometry; this owns the words and the classes.
 */
const PermissionBody = GObject.registerClass(
  {
    GTypeName: 'LotsePermissionBody',
    Template: BodyTemplate,
    InternalChildren: ['titleLabel', 'kindIcon', 'kindLabel', 'locationsLabel', 'namesLabel', 'rawInput'],
  },
  class extends Gtk.Box {
    // Not `private`: `buildDialog` is a module function, not a method, so a private member would not
    // be reachable from the only place that fills it.
    declare readonly _titleLabel: Gtk.Label;
    declare readonly _kindIcon: Gtk.Image;
    declare readonly _kindLabel: Gtk.Label;
    declare readonly _locationsLabel: Gtk.Label;
    declare readonly _namesLabel: Gtk.Label;
    declare readonly _rawInput: Gtk.TextView;

    constructor() {
      super();
      // The stylesheet's names, applied through the widget rather than written into the markup.
      this._kindLabel.add_css_class(CSS.pill);
      this._locationsLabel.add_css_class(CSS.mono);
      this._locationsLabel.add_css_class(CSS.dim);
      this._namesLabel.add_css_class(CSS.dim);
      this._rawInput.add_css_class(CSS.gateInput);
    }
  },
);

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
  /**
   * What the dialog is presented over.
   *
   * **A `Gtk.Widget`, not the window** — `Adw.Dialog.present` takes any widget and walks up to the
   * root itself, and a widget a host embeds does not know what window it will end up in. `LotseChat`
   * passes `this`, which is also correct before the chat has been added to anything: the lookup
   * happens at `present()` time, not here.
   */
  readonly #parent: Gtk.Widget;
  #dialog: Adw.AlertDialog | null = null;
  /** The question this dialog is showing, so a second `show` cannot race the first. */
  #current: string | null = null;

  constructor(parent: Gtk.Widget) {
    this.#parent = parent;
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
   * something lotse knows the order of. Replacing keeps one dialog, one question, one answer.
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
      // **The focus is lotse's decision, made after the dialog is on screen, and it is never an allow
      // button.** libadwaita's own fallback is the *last added* response, which is whichever option
      // the agent happened to send last — measured in `scripts/probes/alert-dialog-close.mjs`, case 9:
      // a bare `Adw.AlertDialog` with `allow_once` added first comes up with the focus on the allow
      // button. A focused `Gtk.Button` is activated by Enter and by Space, `default_response` or not,
      // so that is a dialog where a person typing in the composer, pressing Enter as the dialog appears
      // in that same instant, allows a tool call without reading it.
      //
      // So: the rejecting option's button when the agent sent one (Enter then declines — the answer
      // that fails closed), and otherwise the diff view, which is focusable, is not activatable and
      // therefore does nothing on Enter. `initialFocusResponseId` is the pure half of that decision, in
      // `core/`.
      //
      // **After `map`, then one idle.** Grabbing focus in the same turn as `present()` is a race with
      // libadwaita's own focus assignment, and losing it silently puts the allow button back. The
      // probe measures the result in the real widget, after several frames:
      // `app/tests/probes/permission-focus.ts`.
      const focusId = initialFocusResponseId(question.view.options);
      dialog.connect('map', () => {
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
          // The dialog may already be gone — a Stop in the same frame — and then there is nothing to
          // focus and nothing to do.
          if (this.#dialog !== dialog) return GLib.SOURCE_REMOVE;
          const target = focusId === null ? rawInput : responseButton(dialog, focusId);
          target?.grab_focus();
          // A focused selectable widget selects its text, and a selection over the diff reads as a
          // grey block — it was visible in the first screenshot of this dialog. On a `Gtk.TextView` the
          // selection belongs to the *buffer*, not to the widget: `GtkTextView.select_region` does not
          // exist (it is a `Gtk.Label`/`Gtk.Entry` method, and calling it throws), so the empty range
          // goes through `Gtk.TextBuffer.select_range` with two iters at offset 0.
          if (target instanceof Gtk.TextView) deselect(target);
          return GLib.SOURCE_REMOVE;
        });
      });
      this.#dialog = dialog;
      dialog.present(this.#parent);
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
 * question; a plain box reads as a question. The heading text is lotse's own and therefore constant.
 *
 * **The raw-input view comes back too**, because it is the focus target when the agent offered no
 * rejecting option — see `show`. A `Gtk.Box` is not focusable, so the body as a whole cannot take the
 * focus; the view inside it can. Returning it rather than searching for it afterwards is what keeps
 * "what the focus lands on" and "what the dialog shows" the same object.
 */
function buildDialog(view: PermissionView): { dialog: Adw.AlertDialog; rawInput: Gtk.TextView } {
  const body = new PermissionBody();

  // Every string below is text an agent wrote, and every label is `use-markup: false` in the template
  // — `GtkLabel`'s default is the opposite, which is why the template says so on all four.
  body._titleLabel.label = view.tool;
  body._kindLabel.label = view.kind;
  body._kindIcon.iconName = toolIcon(view.kind);
  body._locationsLabel.label = view.locations.length > 0 ? view.locations.join('\n') : NO_LOCATIONS;
  // "The agent did not say where" rather than an empty row. An empty box reads as *there is nothing
  // here*, which is a different claim from *the agent did not say*, and the difference is the whole
  // reason a person can tell a vague request from a complete one.
  body._locationsLabel.set_visible(true);

  // The agent's own names for its options, as one caption line — and only when at least one of them
  // says something the lotse labels do not. This is where the wording went when it came off the
  // buttons, so nothing the agent told the person is lost.
  const names = agentNames(view.options);
  if (names !== null) {
    body._namesLabel.label = names;
    body._namesLabel.set_visible(true);
  }
  // `len: -1` is the binding's way of saying "to the end of the string" — `Gtk.TextBuffer.set_text`
  // takes a length in bytes and a one-argument call is a type error, not a default.
  body._rawInput.get_buffer()?.set_text(view.rawInput ?? NO_RAW_INPUT, -1);

  const dialog = new Adw.AlertDialog({ heading: 'The agent wants permission' });
  // `extra_child` rather than a longer heading: the heading is one lotse sentence and stays that way,
  // whatever the agent's tool is called. A heading built from the agent's title would let agent text
  // into the part of the dialog that reads as the app's own voice — and into the one string that is
  // the app's own voice, which is exactly the line not to cross.
  dialog.set_extra_child(body);
  // **`add_response` per option, in the agent's own order, with no extra one.** There is no
  // `set_choices` on `Adw.AlertDialog` — `add_responses` is the batch form and takes no appearances,
  // so the loop is where the appearance belongs anyway. An allowing option is `SUGGESTED`: that is
  // emphasis, and it is the only emphasis lotse ever applies to a button, because inventing it on a
  // question lotse does not own is editorialising. A rejecting option keeps the default appearance,
  // which is what the plan asks for and what libadwaita's own guidance says for a negative response.
  //
  // **The label is `optionLabel(option)`, not `option.name`, and the appearance is keyed on `kind`.**
  // Both come from the same place on purpose: an option's `name` is the agent's to choose, and ACP
  // lets an agent call its `allow_once` option "Decline". Printing that verbatim gives a
  // suggested-looking button reading "Decline" that allows, and the person has no way to tell.
  // `optionLabel` puts lotse's own word — "Allow once" or "Decline" — in front, derived from `kind`,
  // and keeps the agent's name only when it adds something; it also doubles underscores, because
  // `add_response` parses mnemonics and an agent must not choose lotse's Alt accelerator. The
  // decision and the label therefore cannot disagree: they are the same `kind`.
  //
  // **`default_response` is deliberately not set, and that is not the same as leaving focus alone.**
  // It would decide what the dialog's *default widget* is, and libadwaita's fallback when it is unset
  // is the last added response — which is whichever option the agent sent last, so an agent that
  // orders `allow_once` last gets a dialog whose first Enter allows. So lotse sets neither the default
  // nor the focus implicitly: `show()` puts the focus itself, on the rejecting option's button, from
  // `initialFocusResponseId` in `core/permission.ts`. The fallback this replaces is measured in
  // `scripts/probes/alert-dialog-close.mjs` case 9 and the result lotse produces is measured on this
  // widget by `app/tests/probes/permission-focus.ts`.
  for (const option of view.options) {
    dialog.add_response(option.optionId, optionLabel(option));
    // Only `allow_once` is emphasised: with two allowing buttons both suggested, neither is.
    if (option.kind === 'allow_once') {
      dialog.set_response_appearance(option.optionId, Adw.ResponseAppearance.SUGGESTED);
    }
  }
  return { dialog, rawInput: body._rawInput };
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
