/**
 * The turn state machine, and what the window may say about the agent's own life.
 *
 * **Everything here is a pure function of its arguments, and that is the whole point.** Plan §6 lists
 * four failure paths, and every one of them is a *decision*: which state a dying agent leaves behind,
 * whether `cancelled` was our Stop or the agent giving up on its own, whether a permission request is
 * waiting on a person. A decision made inside a widget is a decision that can only be checked by
 * looking at a window, and this repo has exactly that problem already — the devtools plane cannot
 * type into an entry (`hooks.ts`), so a state that only a click can produce is a state nobody has
 * looked at. The GUI therefore *renders* what this file decides and decides nothing itself.
 *
 * **Two separate questions, kept apart on purpose.** `TurnState` is about the *turn* (is the agent
 * working?), `AgentAttachment` is about the *process* (is there an agent at all?). They change
 * independently — an agent can be attached and `idle`, or `gone` while a `cancelled` answer is still
 * in flight — and collapsing them into one enum is how a surface ends up saying "the agent exited"
 * about a window where nothing was ever started. `agentStatus` is the join: it says what the composer
 * needs (`attached`) and what may be said (`note`), and it is the *smallest* shape that carries
 * `openAgent` failing, because a boolean cannot carry a sentence a person has to act on.
 *
 * **`waiting-for-you` is reachable, and what reaches it is a person.** The event pair is here, the
 * composer renders the state, and plan §7 step 6 wired them to the permission dialog: an
 * `onPermission` surface puts the question up and moves the state, so the window shows Stop next to a
 * dialog rather than a Send that cannot work. It is written as a transition rather than as a
 * special case because the alternative is a state invented by the dialog's author, who would then have
 * to decide what puts the window *into* it — and the answer has to be the one the composer already
 * renders as "the turn is not finished".
 */

import type { RequestPermissionRequest, SessionId, StopReason } from '@kurier/acp/types';
import type { TranscriptEntry } from '@kurier/session';

import type { TurnState } from './composer-state.ts';
import type { FailureKind } from './failure.ts';
import type { PermissionDecision } from './permission.ts';

export type { FailureKind, TurnState };

/**
 * Who cancelled, as far as **this** controller can tell.
 *
 * The distinction is not academic, it is what `stopped` means. `session/cancel` is a *notification*:
 * nothing comes back saying "I received it", and the turn that is running settles on its own. So the
 * only evidence that a Stop was ours is that this controller sent the notification — there is no wire
 * answer that could tell us afterwards.
 *
 * - `window`: this controller sent `session/cancel`. The person pressed Stop.
 * - `agent`: the agent answered `cancelled` and nobody asked it to. An agent that abandons a turn on
 *   its own — the model gave up, a provider dropped the stream — is *not* something a person stopped,
 *   and rendering "Stopped" for it would put a word into their mouth.
 * - `none`: no `stopReason` exists at all. Only reachable when kurier never sent the prompt (Stop
 *   during the handshake), because an agent that dies mid-turn takes the `agent-gone` path instead and
 *   must never be dressed up as a finished turn.
 * - `left`: the person moved to another chat and the controller stopped the turn for them (New chat, a
 *   sidebar row). It is a cancel like `window`, but the chat it belonged to is no longer on screen, so
 *   "Stopped." must not be written over the chat they went to: the state ends `idle`.
 */
export type CancelledBy = 'window' | 'agent' | 'left' | 'none';

export type TurnEvent =
  /** A prompt is going out. Nothing has been sent yet, so nothing can have gone wrong. */
  | { readonly kind: 'prompt' }
  /** The agent asked something and a person has to answer it. Step 6 emits this. */
  | { readonly kind: 'permission-asked' }
  /** …and the question is answered. Back to working — unless the turn ended instead. */
  | { readonly kind: 'permission-answered' }
  /**
   * The turn settled.
   *
   * `stopReason` is `null` only for "kurier never sent the prompt". A turn the agent abandoned
   * *after* receiving it always has a stop reason, and a turn the agent never answered at all is the
   * `agent-gone` event, not this one: a dying agent must not produce a completion.
   */
  | {
      readonly kind: 'turn-ended';
      readonly stopReason: StopReason | null;
      readonly cancelledBy: CancelledBy;
    }
  /** The transport ended (process exit, EOF) while a turn was running. Terminal until New chat. */
  | { readonly kind: 'agent-gone'; readonly reason: string }
  /** New chat: a fresh conversation starts, so what the last one ended in is not its state. */
  | { readonly kind: 'chat-reset' };

/**
 * The one transition function.
 *
 * Total, and total on purpose: an event that cannot apply still has to produce a state, because a
 * surface that is handed `undefined` renders nothing and a person staring at an empty line learns
 * nothing. Each of those cases is a real question and the answers are the plan's, not guesses:
 *
 * - **`prompt` from `gone` does not resurrect the agent.** `composer-state.ts` calls `gone` terminal —
 *   an agent that exited is not coming back for *that* chat, and a window that quietly grew a second
 *   agent would be holding two subprocesses behind one Stop button. The one way out is `chat-reset`
 *   (New chat), which also retires the dead handle, so the next prompt starts a fresh agent on purpose.
 * - **`turn-ended` outranks `permission-answered`.** A turn that ended while a dialog was open (Stop
 *   answers the dialog `cancelled`, per the schema) must not be dragged back to `thinking`.
 * - **`agent-gone` wins over everything.** Nothing that arrives after the transport ended describes a
 *   live turn, so the state cannot move out of `gone` again.
 */
export function transition(state: TurnState, event: TurnEvent): TurnState {
  switch (event.kind) {
    case 'prompt':
      // `gone` is terminal, so it is the one state a prompt does not leave. `waiting-for-you` is
      // unreachable here (a prompt is sent while idle), and answering `thinking` for it is the
      // honest default: a turn that starts is a turn that works.
      return state === 'gone' ? 'gone' : 'thinking';

    case 'permission-asked':
      // Only from `thinking`. From `idle` there is no turn to be interrupted by a question, and
      // claiming otherwise would put the window in a state Stop cannot leave.
      return state === 'thinking' ? 'waiting-for-you' : state;

    case 'permission-answered':
      // Only out of `waiting-for-you` — the event that got there is the only one that leaves.
      return state === 'waiting-for-you' ? 'thinking' : state;

    case 'turn-ended': {
      // `gone` stays gone: a late answer to a turn whose agent has exited describes nothing on screen.
      if (state === 'gone') return 'gone';
      if (event.cancelledBy !== 'window') return 'idle';
      // Stop was pressed and the cancel was ours. Two answers count as a stop, and the second is the
      // only one that is not the agent's own: `null`, which means kurier never got as far as sending the
      // prompt — the Stop landed during the handshake, so there was nothing to stop and the turn ends
      // where it began. Reporting `idle` there would put "the turn finished" on a turn that never ran.
      if (event.stopReason === null || event.stopReason === 'cancelled') return 'stopped';
      // An `end_turn` that arrives just after our cancel went out means the agent finished on its own
      // while the cancel was in flight. The answer wins: it is what happened.
      return 'idle';
    }

    case 'agent-gone':
      return 'gone';

    case 'chat-reset':
      // Only the two states that describe how the *last* chat ended. A running turn is left alone: it
      // settles on its own answer, and `left` is what makes that answer land on `idle`.
      return state === 'gone' || state === 'stopped' ? 'idle' : state;
  }
}

/**
 * Whether moving the window to `target` abandons the turn that is running.
 *
 * **`target` is the session the window is about to show, `null` for a new chat.** The turn belongs to
 * `turnSession` — `null` while a new conversation is still in its handshake, when no id exists yet — so
 * any other target, and every new chat, leaves it behind. Nothing running leaves nothing behind.
 */
export function leavesRunningTurn(
  running: boolean,
  turnSession: SessionId | null,
  target: SessionId | null,
): boolean {
  return running && (target === null || target !== turnSession);
}

/**
 * Whether lines for `sessionId` may reach the transcript on screen.
 *
 * **The turn's session, not the window's, is what the lines are about — and only the window's is on
 * screen.** A turn that outlives the chat it started in (it is being stopped, or the agent has not
 * answered the cancel yet) keeps streaming into its own record, and none of it may reach the pane of the
 * chat the person went to. `shown` is `null` for an empty new chat, which shows no session at all.
 */
export function isOnScreen(sessionId: SessionId, shown: SessionId | null): boolean {
  return shown !== null && sessionId === shown;
}

// ─── what the window may say about the agent ─────────────────────────────────────────────────

/**
 * The agent process, as far as the surface may describe it.
 *
 * Five shapes because five things can be true, and a boolean cannot tell them apart: a person cannot
 * act on "there is no agent". `none` and `attaching` are the window's own business (nothing has been
 * started yet, and the handshake is in flight — a cold `opencode acp` takes *seconds*, and silence
 * during that is what makes a window look broken); `gone` and `failed` are two different failures that
 * need two different sentences: the agent ran and ended, versus the agent never got going at all
 * (bad command, handshake failure, `auth_required` — trap 1, whose remedy is `kurier auth`).
 */
export type AgentAttachment =
  /** Nothing has been started. The first prompt starts it — see `agent-session.ts`. */
  | { readonly status: 'none' }
  /** Spawned, handshaking. Stop is already live, because the turn already started. */
  | { readonly status: 'attaching' }
  | { readonly status: 'attached'; readonly name: string }
  | { readonly status: 'gone'; readonly reason: string }
  /**
   * The agent never came up — **or refused the turn.**
   *
   * **`kind` is the whole reason this is not just a `message`.** Four failures land here and three of
   * them need something a person must do somewhere else — an auth trap (`kurier auth`, trap 1), a
   * provider refusal after a prompt was sent (issue #2), and a reattach refusal (trap 2, which leaves
   * the window empty) — so the surface has to be able to tell them from "the binary is not on PATH".
   * Classified by `failureKind` in `core/failure.ts`, which is where the four ways of reading it are
   * argued; nothing here decides what a dialog says.
   *
   * **The one `failed` that keeps a process, and that is why `agentStatus` reads the kind.** The other
   * three mean there is no agent to prompt; `'model'` means the agent is attached, healthy and refusing
   * to answer *this* model — so it has to leave Send enabled, or the dialog's own button would lead to a
   * dead control.
   */
  | { readonly status: 'failed'; readonly kind: FailureKind; readonly message: string };

/** What the composer needs: whether a prompt has somewhere to go, and what may be said about it. */
export interface AgentStatus {
  /** A prompt would reach an agent. `false` while attaching, after it exited, and if it never came up. */
  readonly attached: boolean;
  /** The sentence on screen, or `''` when there is nothing to say (an attached, idle agent). */
  readonly note: string;
}

/**
 * The join between the agent's life and what the composer may say.
 *
 * **`attached` is `true` for `none` (the prompt starts the agent) and for `attached`; it is `false`
 * while `attaching`, after `gone`, and for a failed start.** While the handshake is in flight there
 * is a process but no session to prompt, so a Send enabled then would accept a message that cannot be
 * delivered; and the composer's `stop` branch outranks `attached` anyway, so a person who pressed Send
 * a moment ago still gets a working Stop instead of a disabled button that claims nothing is
 * happening.
 *
 * The `note` for a dead agent is the *reason*, not a summary: "the agent exited (code 1)" is
 * something a person can act on and "the agent is gone" is not. The one way back it names is the one
 * that exists: New chat retires the dead handle and the next prompt starts a fresh agent.
 *
 * **The exception is `'model'`, and it is not a dead agent.** `failureKind` reaches that answer from an
 * auth-required error *after a prompt was sent*, which means the agent is up: it handshook, it loaded
 * the session, and it answered the turn — with a refusal. Reporting `attached: false` would disable
 * Send in a window whose agent is alive, and the `'model'` dialog's one button is "Choose another
 * model", which would then lead to a disabled entry. That is the "control that points at nothing" this
 * window exists to avoid, so the two are decided together: a refused turn keeps its agent, and the note
 * says why the last prompt did not land.
 */
export function agentStatus(attachment: AgentAttachment): AgentStatus {
  switch (attachment.status) {
    case 'none':
      // **A prompt has somewhere to go: it starts the agent.** This used to be `attached: false` with a
      // sentence promising that the first prompt starts it, on a Send button that stayed disabled — so
      // the composer could not send the one message that would have started anything.
      return { attached: true, note: '' };
    case 'attaching':
      return { attached: false, note: 'Starting the agent…' };
    case 'attached':
      return { attached: true, note: '' };
    case 'gone':
      return {
        attached: false,
        note: `The agent exited${attachment.reason ? ` (${attachment.reason})` : ''}. Press New chat to send another prompt.`,
      };
    case 'failed':
      return { attached: attachment.kind === 'model', note: attachment.message };
  }
}

/** The agent's own name, or `null` when there is no agent to name. For a header, a tooltip, nothing else. */
export function agentName(attachment: AgentAttachment): string | null {
  return attachment.status === 'attached' ? attachment.name : null;
}

// ─── the stream ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether a `user_message_chunk` is the agent echoing the prompt *we* just sent.
 *
 * **This is the one filter on the stream path, and it exists because the surface cannot wait.** Send
 * has to draw the person's own message immediately — a prompt that appears only once the agent has
 * answered is a prompt that looks lost — while every ACP agent also echoes it back as
 * `user_message_chunk` (`opencode acp` does, and so does `FixtureAgent`). Without this the same words
 * appear twice, and because `toTranscriptItems` merges adjacent runs of one kind, twice inside one
 * bubble: `why is this slow?why is this slow?`.
 *
 * It is deliberately an equality test and not a similarity one. The alternative — "drop the first
 * `user_message_chunk` of a turn" — drops whatever the agent genuinely said in its own voice, and the
 * transcript is a record of what happened (`AGENTS.md` § Privacy). Ours or not ours, this decides.
 */
export function isEchoOf(chunkText: string, promptSent: string): boolean {
  return chunkText.trim() === promptSent.trim();
}

/**
 * The system line for an agent that exited during a turn.
 *
 * **The plan's words, because the line's whole job is not to invent an ending.** §6: the turn has no
 * `stopReason` because nothing answered it, and the transcript "records the truth ('the agent exited
 * during this turn'), not a fabricated completion". So there is no `stopReason` in this function's
 * output and no way to pass one in — a completion cannot even be spelled here.
 */
export function agentExitedEntry(sessionId: SessionId, at: string, reason: string): TranscriptEntry {
  const why = reason ? ` (${reason})` : '';
  return {
    kind: 'system',
    at,
    sessionId,
    text: `the agent exited during this turn${why} — the turn was never answered`,
  };
}

/**
 * The system line for a permission decision that was made, or not made.
 *
 * **A decision nobody can see is a decision in the wrong place.** This window used to answer every
 * request with `null` (`DENY_EVERYTHING`, guardrail 2 — never "allow because the agent asked"), which
 * is correct and completely silent: against a real agent a turn would just stop with a `refusal` and
 * nothing on screen would say a person was asked. One line turns that into a record.
 *
 * Three outcomes, and the wording keeps them apart, because they are not the same thing to the person
 * who reads the transcript afterwards:
 *
 * - **allowed once** — a person pressed one of the agent's own allow buttons. The id is recorded,
 *   because "allow" without the option that was chosen does not say *what* was allowed.
 * - **declined** — a person pressed the agent's own rejecting option. A decision.
 * - **not answered** — nobody chose: Escape, the window closed, Stop, the agent died, the turn was
 *   cancelled. Failing closed is correct, and calling it a refusal would put a decision in a person's
 *   mouth that they never made — hence the third wording, which names the *reason* instead.
 *
 * The tool title is named because it is the only thing here a person can recognise.
 */
export function permissionDecisionEntry(
  request: RequestPermissionRequest,
  sessionId: SessionId,
  at: string,
  outcome: PermissionDecision,
): TranscriptEntry {
  const call = request.toolCall;
  const what = call.title || (call.kind ? `a ${call.kind} tool call` : 'a tool call');
  let text: string;
  if (outcome.type === 'allowed') {
    text = `allowed once: ${what} (${outcome.optionId})`;
  } else if (outcome.type === 'declined') {
    text = `declined: ${what} (${outcome.optionId})`;
  } else {
    text = `not answered: ${what} — ${outcome.reason}`;
  }
  return {
    kind: 'system',
    at,
    sessionId,
    text,
  };
}
