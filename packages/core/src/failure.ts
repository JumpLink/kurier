/**
 * What a failure to start an agent *is*, and what the window says about it.
 *
 * **Why this file exists, and why it is not a paragraph in `agent-session.ts`.** Plan §6 names two
 * failures that are not "the agent went away": an **auth trap** (the agent wants a human to log in
 * first, and the remedy is `lotse auth` in a terminal this window does not have) and a **reattach
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
 * **Four kinds, because each one has a different consequence for a person.**
 *
 * - `auth` — the only failure with a **command to run somewhere else**. It gets a dialog, and the
 *   dialog names `lotse auth` and says why a window cannot do it instead (plan §6: "A window has no
 *   terminal to inherit … inventing an in-window login would be storing a credential this project
 *   deliberately has no safe place for").
 * - `model` — **the same wire error, arrived at after a turn started.** See the section on
 *   `FailureContext` below; this is the kind that issue <https://github.com/JumpLink/lotse/issues/2>
 *   is about.
 * - `unsupported` — the agent ran and refused. Nothing a person can do to this session on this agent,
 *   and the window would otherwise show an empty transcript with no explanation, which plan §6 calls
 *   out by name ("shown as a refusal, not as an empty transcript"). It gets a dialog too, because the
 *   caption under the entry is not enough for a window whose transcript is empty.
 * - `start` — the agent never got going: a bad command, a handshake timeout, an unknown protocol
 *   version. The composer's caption already says it, it is not permanent, and a modal the person must
 *   dismiss before they can read the log is noise. **No dialog.**
 *
 * ## Why `'auth'` and `'model'` are told apart structurally, and never by wording
 *
 * Measured 2026-10-02 against `opencode acp` 2.0.19 with **no login**: the anonymous default model
 * `opencode/fledge-alpha-free` is geo-blocked from Germany (HTTP 403), and opencode reports any
 * provider 403 on `session/prompt` as JSON-RPC `-32000 "Authentication required: provider
 * authentication required"`. That is the **same error class and the same code** as the real login trap
 * at `session/new`/`session/load`. Before this kind existed, lotse showed the auth dialog on that path
 * — naming `lotse auth`, which does not help anybody: logging in is not what is wrong. Upstream
 * record: issue #2.
 *
 * So the split cannot be made from the message (a reword away) and cannot be made from the code (the
 * codes are identical). What survives is a fact lotse already tracks: **had a prompt gone out?**
 * `AgentSession.#promptSent` is that fact, and it is passed in as `FailureContext.promptSent`. It is a
 * **required** parameter rather than an optional one, so a new call site cannot silently classify a
 * mid-turn refusal as a login trap by omitting it.
 *
 * **And honestly: this is a better question than a perfect one.** A login that genuinely expires
 * *between* two turns also arrives as `-32000` after a prompt was sent, and it lands here too. That is
 * why the `'model'` notice names **both** remedies in provider-neutral words and why its button offers
 * the one lotse can actually perform — changing a model through the protocol. Saying so in the dialog
 * rather than in a comment is the point: a person who really has lost their login is told about
 * `lotse auth`, and a person whose free model is blocked from their country is told to pick another
 * one, and neither is told something false.
 *
 * **A refusal is not written to the transcript.** The transcript is a record of what happened, and no
 * turn ran: an entry here would be a fabricated event, the same rule that keeps `LOTSE_APP_PERMISSION`'s
 * staged request out of the history (`AgentSession.stagePermissionRequest`). Both refusals are
 * therefore *shown* — a dialog, and the caption under the entry — and neither is recorded.
 */

import { isAuthRequired, RpcError, UnsupportedCapabilityError } from '@lotse/acp';

import type { AgentAttachment } from './turn.ts';

/** What sort of "this did not work" this is. The names are lotse's, not the protocol's. */
export type FailureKind = 'auth' | 'model' | 'quota' | 'unsupported' | 'start';

/**
 * The one fact about the turn that decides between `auth` and `model`.
 *
 * **Required, not optional.** The whole of issue #2 was a call site that could not tell these two
 * apart; an optional `promptSent` would put that back for every future caller, since omitting it is
 * legal TypeScript and lands on `'auth'` — the advice that does not help. Making it required means the
 * compiler asks the question at each call site, and `agent-session.ts`'s `#promptSent` is the only
 * honest answer.
 */
export interface FailureContext {
  /** Whether `session/prompt` has already gone out for this turn. `AgentSession.#promptSent`. */
  readonly promptSent: boolean;
}

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
 * The provider says the account is out of credit: opencode answers `-32603` with
 * `data.errorName: "provider.quota"` ("Upstream request failed: Insufficient account funds", measured on
 * 2.0.22 with a logged-in Zen account that had no balance). The name is a field the agent set for exactly
 * this, so it is matched like a code and never like a sentence. It is the one case where the login
 * *worked*: the provider knew the account and refused it for money, so `lotse auth` would not help.
 */
export function isQuotaExhausted(error: unknown): boolean {
  if (!(error instanceof RpcError)) return false;
  const data = error.data;
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { errorName?: unknown }).errorName === 'provider.quota'
  );
}

/**
 * The one classification, and the only place an error is asked which kind of failure it is.
 *
 * **Every branch matches on the error's own type or on the turn state, never on its text.** Matching a
 * message would make the whole decision hostage to wording: an agent is free to put "auth" in an
 * unrelated error, and a future reword of lotse's own sentence would silently stop being recognised.
 * `isAuthRequired` is the protocol's own predicate (`RpcError` with `-32000`) and
 * `UnsupportedCapabilityError` is the class `AcpClient.reattach` rejects with (trap 2) — both are facts
 * about the wire, not about prose.
 *
 * **The auth branches read the turn state as well, and that is the fix for issue #2.** `isAuthRequired`
 * alone cannot separate the two: `opencode acp` 2.0.19 answers a geo-blocked provider 403 on
 * `session/prompt` with the same `-32000` it answers the real login trap with. A prompt having gone out
 * is the structural difference — before it, the agent was never asked to do anything and a refusal can
 * only be about the login; after it, the likeliest cause is the model, and the remedy lotse can
 * perform is a different model. The header says why the notice names both remedies anyway.
 *
 * `AuthRequiredError` is checked first because it is what `withAuthHint` leaves behind: it is the
 * same failure as the raw `RpcError` and must not be classified as `start`.
 */
export function failureKind(error: unknown, context: FailureContext): FailureKind {
  if (isQuotaExhausted(error)) return 'quota';
  if (error instanceof AuthRequiredError) return context.promptSent ? 'model' : 'auth';
  if (isAuthRequired(error)) return context.promptSent ? 'model' : 'auth';
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
   * **Only the auth failure has one, and that is the point of the field.** lotse stores no
   * credential (`AGENTS.md` § Privacy: there is no `secret` tier and adding one needs a reason), so
   * the only honest remedy it can name is the command a person runs themselves. An empty string is
   * never returned: a caller that has nothing to run gets `null` and shows no command line.
   *
   * `null` for `'model'` **on purpose**, and the notice's own body says why: it names `lotse auth` as
   * one of two remedies rather than as the one. `FailureDialog` renders `command` as a bolded "Run this
   * in a terminal" call to action, which is the wrong shape for a sentence whose other half is a button
   * this window *can* press.
   */
  readonly command: string | null;
  /**
   * What this dialog offers to do, if anything. `null` for the three kinds that owe nothing but a
   * sentence. `failureAction` turns it into the action a surface may actually offer — the notice says
   * *what* could help, the action says whether the window is in a state to do it.
   */
  readonly action: FailureAction | null;
}

/**
 * The one action a failure dialog can offer.
 *
 * **A closed union with one member, and that is not a placeholder.** It exists so the *widget* never
 * has to know what a failure was in order to know what a button does: `FailureDialog` is handed an
 * action name and a callback, and the decision of which name is lotse's (`failureNotice`) and whether
 * it is available is core's (`failureAction`). A second member is added when a second failure earns a
 * second remedy, and adding it will break the widget's exhaustive handling rather than silently leaving
 * a button that does nothing.
 */
export type FailureAction = 'choose-model' | 'login';

/**
 * Whether the dialog's action is available at all.
 *
 * **`modelChoice` is a fact about the agent, not about the failure.** The button opens the config row's
 * model dropdown, and an agent that reports no model option has no such dropdown — so the button would
 * be the "control that points at nothing" this window exists to avoid. The sentence is still worth
 * showing without it: it explains why the turn failed, and its second remedy needs no button.
 */
export interface FailureActionContext {
  readonly modelChoice: boolean;
  /**
   * The window can log in itself: the agent is one whose own login API lotse drives (opencode), and its
   * login server can be reached from here (`whyNoLoginServer`). Without it the `auth` dialog stays a
   * sentence that names `lotse auth`, as before.
   */
  readonly login: boolean;
}

/**
 * The action this dialog may offer, or `null` for a Close-only dialog.
 *
 * **Separate from `failureNotice` on purpose, because the two answers come from different places.**
 * What *could* help is a property of the failure and belongs with its sentence; whether this window can
 * do it is a property of what the agent reported and belongs to the surface. Folding them together
 * would mean `failureNotice` had to know about config rows, and the "which failure is this" question
 * would stop being answerable without a surface.
 */
export function failureAction(notice: FailureNotice, context: FailureActionContext): FailureAction | null {
  if (notice.action === 'choose-model') return context.modelChoice ? 'choose-model' : null;
  if (notice.action === 'login') return context.login ? 'login' : null;
  return null;
}

/** The command `AGENTS.md` § "Trap 1" already tells a person to run. Named here so it is named once. */
export const AUTH_COMMAND = 'lotse auth';

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
 * command run in a terminal, and the other leaves a window with nothing in it and no explanation. The
 * third is `'model'`, which needs a person to pick something different and says so.
 *
 * **Every string is fixed English and every one is lotse's own.** The failure may have arrived with
 * agent text in it, and none of it goes in here — the same reason every label in the permission dialog
 * passes `useMarkup: false`. `AGENTS.md` fixes the house rule: fixed English, no `Intl`. Note that the
 * `'model'` body names the provider but never a model id and never an agent's own words: lotse does not
 * own the model and cannot know which of its limits bit.
 */
export function failureNotice(kind: FailureKind): FailureNotice | null {
  switch (kind) {
    case 'auth':
      return {
        heading: 'The agent wants you to log in first',
        body:
          'It cannot answer a prompt until somebody has logged in. Everything else keeps working; ' +
          'the prompt on screen was not sent.',
        // Stays: the dialog names it as the way in when the window cannot log in itself (an agent that
        // has no login API lotse drives, or one outside the sandbox), and as the alternative otherwise.
        command: AUTH_COMMAND,
        action: 'login',
      };
    case 'model':
      return {
        heading: 'The model refused the request',
        // **Both remedies, in provider-neutral words, and neither of them asserted.** Three causes are
        // indistinguishable on this path — a region block, a rate limit and a login that expired
        // mid-turn all arrive as the same `-32000` — so the sentence names all three and does not pick
        // one. The `lotse auth` advice that used to stand alone here was *wrong* for the case it was
        // written for (issue #2), and dropping it entirely would be wrong for the case that remains; so
        // it stays, as one half of a sentence, and the button is the half lotse can actually perform.
        body:
          'The provider turned this request down. It may be limited by region or rate, or it may need ' +
          'a login. Choose another model, or run lotse auth in a terminal.',
        // `null`, not `AUTH_COMMAND`: see `FailureNotice.command`. This dialog's remedy is a button.
        command: null,
        action: 'choose-model',
      };
    case 'quota':
      return {
        heading: 'The provider account has no credit',
        // Fixed words, no agent text. The login worked, so no command is named: the remedies are a free
        // model (the button) or topping up the account at the provider, which lotse cannot do.
        body:
          'You are logged in, but the provider refused this request because the account has no credit. ' +
          'Choose a model that is free, or add credit at the provider.',
        command: null,
        action: 'choose-model',
      };
    case 'unsupported':
      return {
        heading: 'This agent cannot reopen this session',
        body:
          'It advertises neither session/load nor session/resume, so there is no way for lotse to ' +
          'attach it to a conversation that already exists. An agent lotse cannot reattach to is ' +
          'refused, not shown as an empty transcript.',
        command: null,
        action: null,
      };
    case 'start':
      return null;
  }
}
