/**
 * The modal a start failure earns, and nothing else.
 *
 * **A separate file from `permission-dialog.ts` on purpose.** That one is the reason this project
 * exists and it is built out of the agent's own options with kurier's labels; this one shows two
 * sentences kurier wrote about itself, has no body, and answers with "Close". Sharing a widget would
 * have meant a dialog with two shapes and one set of teardown paths, and the permission dialog's
 * three GTK facts (`closed` before `response`, `force_close` emits neither, `default_response`
 * unset focuses the last response) are all about a dialog with buttons that decide something.
 */

import Adw from '@girs/adw-1';

import type { FailureNotice } from '../../core/failure.ts';

/** The dismissal, and the only string in here that is not part of a sentence. */
const CLOSE_RESPONSE = 'close';
const CLOSE_LABEL = 'Close';
/** The one remedy a failure can offer, and kurier's own words for it. See `core/failure.ts`. */
const MODEL_RESPONSE = 'choose-model';
const MODEL_LABEL = 'Choose another model';
const LOGIN_RESPONSE = 'login';
const LOGIN_LABEL = 'Log in…';

/**
 * The callbacks this dialog may be given, one per `FailureAction`.
 *
 * **Optional, and the absence is the honest default.** `failureAction` (`core/failure.ts`) is what
 * decides whether an action is *offered*, and it answers `null` whenever the window cannot perform it —
 * an agent that reported no model option has no dropdown to open. A dialog built without the matching
 * callback then carries only Close, which is what the sentence alone deserves.
 */
export interface FailureDialogActions {
  /** The person chose another model: open the config row's model dropdown. */
  readonly onChooseModel?: () => void;
  /** The person chose to log in: open the login dialog. */
  readonly onLogin?: () => void;
}

/**
 * Show a failure notice once.
 *
 * **`Adw.AlertDialog` with a heading, a body and one response — or two.** `heading` and `body` are plain
 * strings — this class does not set `useMarkup`, and does not need to: `Adw.AlertDialog` has no
 * markup-enabled properties, which is the difference from `Adw.PreferencesRow` in the trap the
 * permission dialog's header names. Both sentences are kurier's own (`core/failure.ts`), so there is
 * no agent text on the way in either.
 *
 * **One instance, replaced rather than stacked**, for the same reason `PermissionDialog` does it: a
 * second failure while one is up must not leave a person looking at whichever was drawn last, and
 * this surface has exactly one agent, so a second failure means the first is stale.
 *
 * **The response is a dismissal, so the window has to guard against a second one.** `Adw.Dialog`
 * emits `closed` before `response` (measured — see `scripts/probes/alert-dialog-close.mjs`); nothing
 * here answers anything, so the ordering is irrelevant. `#dialog = null` before `close()` is what
 * keeps a late `response` from resurrecting the reference.
 */
export class FailureDialog {
  #dialog: Adw.AlertDialog | null = null;

  /** Present when a dialog is on screen. A surface may read it; nothing else needs to. */
  get open(): boolean {
    return this.#dialog !== null;
  }

  show(notice: FailureNotice, window: Adw.Window, actions: FailureDialogActions = {}): void {
    this.close();
    const dialog = new Adw.AlertDialog({
      heading: notice.heading,
      body: notice.body,
      cssClasses: ['kurier-failure-dialog'],
    });
    // The command goes in the body rather than as a button, because it is not an action this window
    // can take: `kurier auth` runs an interactive login in a terminal, and a button here that only
    // copied a string to the clipboard would be a control that points at nothing (`AGENTS.md`'s rule
    // for this window). The sentence already names it.
    if (notice.command !== null) {
      const alternative = notice.action === 'login' && typeof actions.onLogin === 'function';
      dialog.body = `${notice.body}\n\n${alternative ? 'Or run' : 'Run'} \`${notice.command}\` in a terminal.`;
    }
    // **Both halves of the availability test, and neither is the other's job.** `notice.action` is what
    // the failure offers (`core/failure.ts`'s `failureNotice`); the callback is whether *this* window
    // can do it. A notice whose action has no callback gets a Close-only dialog, because a button that
    // would do nothing is the defect this project is about.
    const chooseModel = notice.action === 'choose-model' && typeof actions.onChooseModel === 'function';
    // **Close first, then the remedy — and that is the button *order*, not an accident.** Measured in
    // `scripts/probes/alert-dialog-close.mjs` (case 9) and recorded in `AGENTS.md`: libadwaita fills the
    // response row **bottom-up from the add order**, so the first added is the bottom button and the last
    // added is the topmost — the one a hand reaches for. Close goes to the bottom and the remedy to the
    // top, which is the opposite of `permission-dialog.ts`'s "a decline in both end slots" and for the
    // opposite reason: there, no button answered anything, so the safest one had to be the easiest to hit;
    // here one button is the whole point of the dialog and the other is Escape, which libadwaita binds to
    // `close` on its own.
    dialog.add_response(CLOSE_RESPONSE, CLOSE_LABEL);
    if (chooseModel) {
      dialog.add_response(MODEL_RESPONSE, MODEL_LABEL);
      dialog.set_response_appearance(MODEL_RESPONSE, Adw.ResponseAppearance.SUGGESTED);
      // **Named, not left to the add order** — the same choice `buildDialog` makes in
      // `permission-dialog.ts`. Measured there: with no `default_response` libadwaita focuses the
      // *first added* response, which on this dialog would be Close, because Close is added first (see
      // below). The remedy is what this dialog exists to offer, so it is where the focus belongs and
      // Escape still closes everything.
      dialog.set_default_response(MODEL_RESPONSE);
      dialog.connect('response', (_dialog: Adw.AlertDialog, response: string) => {
        if (response !== MODEL_RESPONSE) return;
        actions.onChooseModel?.();
      });
    }
    // The login button follows the same two-halves rule as the model button above: the notice offers it,
    // the callback says this window can do it. It is the remedy, so it is suggested and focused.
    if (notice.action === 'login' && typeof actions.onLogin === 'function') {
      dialog.add_response(LOGIN_RESPONSE, LOGIN_LABEL);
      dialog.set_response_appearance(LOGIN_RESPONSE, Adw.ResponseAppearance.SUGGESTED);
      dialog.set_default_response(LOGIN_RESPONSE);
      dialog.connect('response', (_dialog: Adw.AlertDialog, response: string) => {
        if (response !== LOGIN_RESPONSE) return;
        actions.onLogin?.();
      });
    }
    dialog.connect('response', () => {
      if (this.#dialog === dialog) this.#dialog = null;
    });
    dialog.connect('closed', () => {
      if (this.#dialog === dialog) this.#dialog = null;
    });
    this.#dialog = dialog;
    dialog.present(window);
  }

  /**
   * Press **Choose another model**, the way libadwaita does when the response is chosen.
   *
   * **An `emit`, and it is the closest thing to a press that exists from outside the process.**
   * `Adw.AlertDialog` has **no callable `response()`** — `scripts/probes/alert-dialog-close.mjs` records
   * `dialog.response('close')` as `undefined` — and `ActivateWidget` on a response button reports `true`
   * and emits nothing, both measured and both libadwaita's rather than this dialog's. `AdwAlertDialog`
   * keeps its own `response` handler, so emitting the signal runs the same handlers in the same order a
   * press does: libadwaita's first (which closes the dialog, and therefore releases its input grab), then
   * this class's, which is where `onChooseModel` goes. That ordering is the whole reason the model's
   * dropdown opens and the modal is already on its way down.
   *
   * **`false` when there is no dialog, or no such response on it** — the two cases where a press could
   * not have happened either, so the answer means the same thing to a caller.
   */
  chooseModel(): boolean {
    const dialog = this.#dialog;
    if (dialog === null) return false;
    dialog.emit('response', MODEL_RESPONSE);
    return true;
  }

  /**
   * Take the dialog down — which on *this* dialog is also the dismissal.
   *
   * **One response, so pressing Close and being closed are the same call.** `scripts/probes/
   * alert-dialog-close.mjs` (case 1) measures that an external `close()` emits `closed` and then
   * `response("close")` — the same pair, with the same argument, that the response button produces.
   * There is nothing else this dialog can be dismissed *with*, so `KU_APP_DISMISS_FAILURE` calls this
   * and the screenshot is of a dismissed dialog rather than of a dialog that vanished.
   *
   * **The reverse is not true, and it is worth knowing why.** `Adw.AlertDialog` has no callable
   * `response()` — the same probe records `dialog.response('close')` as `undefined`; the signal is
   * reachable only through `emit`, which is what `AdwAlertDialog` does internally. So there is no
   * "press the button" call to make even from inside the process, and a hook that reached for one
   * would be a hook that pretends.
   */
  close(): void {
    const dialog = this.#dialog;
    if (dialog === null) return;
    this.#dialog = null;
    dialog.close();
  }
}
