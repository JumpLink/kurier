/**
 * What a failure to start an agent *is*, and what the window says about it.
 *
 * **Why this file exists, and why it is not a paragraph in `agent-session.ts`.** Plan §6 names two
 * failures that are not "the agent went away": an **auth trap** (the agent wants a human to log in
 * first, and the remedy is `kurier auth` in a terminal this window does not have) and a **reattach
 * refusal** (the agent offers neither `session/load` nor `session/resume`, so an existing
 * conversation cannot be reopened — trap 2). Both arrive at the **window** as one exception and one
 * sentence, and without a kind the surface cannot tell "this person must run a command in a terminal"
 * from "this program is not on PATH", so both collapse into the composer's caption and neither gets
 * the attention the plan asks for. Deciding which is which is a decision, and every other decision in
 * this app lives in `core/` where it can be read by a test that needs no display.
 *
 * **The classification is read on the GUI's path, not on every one.** The controller calls it where it
 * turns a caught error into an `AgentAttachment` (`agent-session.ts`'s `#reportFailure`), which is the
 * one place every failure passes through in this surface. The CLI does not classify: it prints the
 * sentence `withAuthHint` built and has no attachment to hang a kind on, which is the right amount of
 * machinery for a line of stderr. So "both arrive as one exception" is a statement about the GUI.
 *
 * **Three kinds and no more, because each one has a different consequence for a person.**
 *
 * - `auth` — the only failure with a **command to run somewhere else**. It gets a dialog, and the
 *   dialog names `kurier auth` and says why a window cannot do it instead (plan §6: "A window has no
 *   terminal to inherit … inventing an in-window login would be storing a credential this project
 *   deliberately has no safe place for").
 * - `unsupported` — the agent ran and refused. Nothing a person can do to this session on this agent,
 *   and the window would otherwise show an empty transcript with no explanation, which plan §6 calls
 *   out by name ("shown as a refusal, not as an empty transcript"). It gets a dialog too, because the
 *   caption under the entry is not enough for a window whose transcript is empty.
 * - `start` — the agent never got going: a bad command, a handshake timeout, an unknown protocol
 *   version. The composer's caption already says it, it is not permanent, and a modal the person must
 *   dismiss before they can read the log is noise. **No dialog.**
 *
 * **A refusal is not written to the transcript.** The transcript is a record of what happened, and no
 * turn ran: an entry here would be a fabricated event, the same rule that keeps `KU_APP_PERMISSION`'s
 * staged request out of the history (`AgentSession.stagePermissionRequest`). Both refusals are
 * therefore *shown* — a dialog, and the caption under the entry — and neither is recorded.
 */

import { isAuthRequired, UnsupportedCapabilityError } from '@kurier/acp';

import type { AgentAttachment } from './turn.ts';

/** What sort of "this did not work" this is. The names are kurier's, not the protocol's. */
export type FailureKind = 'auth' | 'unsupported' | 'start';

/**
 * The error `withAuthHint` throws, so the kind survives the hint.
 *
 * **A class rather than a marker in the message, because the kind is load-bearing.** `withAuthHint`
 * has to replace ACP's `-32000 auth_required` with a sentence a person can act on, and a sentence is
 * not a classification: two failures can both read "attaching to the session failed" and need
 * opposite answers. The wrapper keeps the cause (so the original error is still inspectable) and this
 * type is what `failureKind` matches on.
 *
 * It extends `Error` rather than being a plain object so `describe(error)` and every existing
 * `catch` behave exactly as they do for any other throw.
 */
export class AuthRequiredError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AuthRequiredError';
  }
}

/**
 * The one classification, and the only place an error is asked which kind of failure it is.
 *
 * **Both branches match on the error's own type, never on its text.** Matching a message would make
 * the whole decision hostage to wording: an agent is free to put "auth" in an unrelated error, and a
 * future reword of kurier's own sentence would silently stop being recognised. `isAuthRequired` is
 * the protocol's own predicate (`RpcError` with `-32000`) and `UnsupportedCapabilityError` is the
 * class `AcpClient.reattach` rejects with (trap 2) — both are facts about the wire, not about prose.
 *
 * `AuthRequiredError` is checked first because it is what `withAuthHint` leaves behind: it is the
 * same failure as the raw `RpcError` and must not be classified as `start`.
 */
export function failureKind(error: unknown): FailureKind {
  if (error instanceof AuthRequiredError) return 'auth';
  if (isAuthRequired(error)) return 'auth';
  if (error instanceof UnsupportedCapabilityError) return 'unsupported';
  return 'start';
}

/** What a dialog would say. Two fixed English sentences and a heading — no `Intl`, no agent text. */
export interface FailureNotice {
  readonly heading: string;
  readonly body: string;
  /**
   * The command to run, when there is one.
   *
   * **Only the auth failure has one, and that is the point of the field.** kurier stores no
   * credential (`AGENTS.md` § Privacy: there is no `secret` tier and adding one needs a reason), so
   * the only honest remedy it can name is the command a person runs themselves. An empty string is
   * never returned: a caller that has nothing to run gets `null` and shows no command line.
   */
  readonly command: string | null;
}

/** The command `AGENTS.md` § "Trap 1" already tells a person to run. Named here so it is named once. */
export const AUTH_COMMAND = 'kurier auth';

/**
 * The dialog this failure still owes, or `null` if it owes none.
 *
 * **`shown` is the failure the surface has already put up, compared by identity** — and that is the
 * whole fix for the dialog that comes back. A surface receives a *new* snapshot on every state move
 * and an attachment that stays `failed` until the next attach, so the only guard that works is "have
 * I shown *this* failure", not "is a dialog up right now": a dismissed dialog closes itself, and the
 * next emit would open it again. Identity is the right key because `AgentSession` builds a **new**
 * attachment object per failure (`#setAttachment`), so a genuinely new failure is a new object and is
 * still shown — which "have I ever shown a failure" would get wrong in the other direction.
 *
 * **Why it is a function and not three lines in `window.ts`.** The rule has a shape that only shows
 * up under test: a dismissal, a session switch and a second failure all ask the same question, and the
 * two plausible guards disagree about the third. A widget cannot be asked any of it without a display.
 */
export function failureToShow(
  attachment: AgentAttachment,
  shown: AgentAttachment | null,
): FailureNotice | null {
  if (attachment === shown) return null;
  if (attachment.status !== 'failed') return null;
  return failureNotice(attachment.kind);
}

/**
 * Whether a still-open dialog is now stale and must be taken down.
 *
 * **The other half of `failureToShow`, and it is the half that was missing.** A dialog is modal, so a
 * window whose agent has since attached, or which has switched to another session, would otherwise
 * keep a sentence about a failure that is no longer the state of anything on screen — and, worse,
 * would still be swallowing the close button and the sidebar. `stale = shown !== attachment` is the
 * whole rule: the shown failure *is* the current state, or it is not.
 *
 * `true` for `shown === null` too, so a caller may write
 * `if (staleDialog(shown, attachment)) this.#failures.close();` without first asking whether anything
 * is up — `close()` is already a no-op when nothing is.
 */
export function staleDialog(shown: AgentAttachment | null, attachment: AgentAttachment): boolean {
  return shown !== attachment;
}

/**
 * The dialog a failure deserves, or `null` for none.
 *
 * **`null` for `start` is the interesting half.** A bad command or a handshake timeout is worth a
 * caption and worth a line in the log, and it is over in a moment; a modal over the transcript says
 * "something is wrong" without saying anything the caption does not, and it has to be dismissed
 * before the person can get on with the window. The two permanent failures are different: one needs a
 * command run in a terminal, and the other leaves a window with nothing in it and no explanation.
 *
 * **Every string is fixed English and every one is kurier's own.** The failure may have arrived with
 * agent text in it, and none of it goes in here — the same reason every label in the permission dialog
 * passes `useMarkup: false`. `AGENTS.md` fixes the house rule: fixed English, no `Intl`.
 */
export function failureNotice(kind: FailureKind): FailureNotice | null {
  switch (kind) {
    case 'auth':
      return {
        heading: 'The agent wants you to log in first',
        body:
          'It cannot answer a prompt until somebody has logged in, and this window has no terminal ' +
          'to hand that login to — so kurier cannot do it for you. Everything else keeps working; ' +
          'the prompt on screen was not sent.',
        command: AUTH_COMMAND,
      };
    case 'unsupported':
      return {
        heading: 'This agent cannot reopen this session',
        body:
          'It advertises neither session/load nor session/resume, so there is no way for kurier to ' +
          'attach it to a conversation that already exists. An agent kurier cannot reattach to is ' +
          'refused, not shown as an empty transcript.',
        command: null,
      };
    case 'start':
      return null;
  }
}
