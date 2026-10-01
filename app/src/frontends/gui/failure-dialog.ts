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

/** The one response, and the only string in here that is not part of a sentence. */
const CLOSE_RESPONSE = 'close';
const CLOSE_LABEL = 'Close';

/**
 * Show a failure notice once.
 *
 * **`Adw.AlertDialog` with a heading, a body and one response.** `heading` and `body` are plain
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

  show(notice: FailureNotice, window: Adw.Window): void {
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
    if (notice.command !== null) dialog.body = `${notice.body}\n\nRun \`${notice.command}\` in a terminal.`;
    dialog.add_response(CLOSE_RESPONSE, CLOSE_LABEL);
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
