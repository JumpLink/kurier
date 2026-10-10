/**
 * What the composer is allowed to do, as data.
 *
 * **This is the composer, minus the widget.** Every question the surface asks — "which button is
 * this, is it sensitive, may I type, what do I tell the person" — is a question about a *state*, and a
 * state is testable on both runtimes while a `Gtk.Button` is testable only on GJS with a display. So
 * the answers live here and `composer.ts` renders them. The window's own rule, that a control which
 * points at nothing is forbidden, becomes mechanical: there is exactly one action, so there is no
 * button that could be shown without a destination.
 *
 * **One action, not four booleans.** An earlier shape of this file answered `canSend`, `showsStop`,
 * `acceptsText` and `status` separately, which puts the "is this a stop or a send" decision on every
 * caller — and two of those four could disagree, producing two buttons. `ComposerView.action` makes
 * that unrepresentable: there is one button, and what it does is one value.
 *
 * **The three inputs are the three things that can block a send, and each of them is somebody else's
 * answer rather than ours.** `state` is the turn machine (`core/turn.ts`), `agent` is the projection
 * of the agent's life (also `core/turn.ts`, so a sentence about a dead agent is written once), and
 * `sessionId` is the session a prompt would go to. The third arrived with plan §7 step 5: the agent is
 * spawned on the *first prompt*, so before anything is started there is no session to prompt, and a
 * Send button that accepted text would be the control-that-points-at-nothing this window's own header
 * forbids. A window with no session open has nothing to send to, and now says so.
 *
 * **`status` is a second line, not a second `reason`.** `reason` explains why a *disabled* control is
 * disabled and is therefore empty exactly when the button works. A running turn is the case where the
 * button works and the person still needs to know what is happening — "Working" is the difference
 * between a window that looks stuck and a window that is busy, and it is invisible in a screenshot
 * unless it is on screen.
 *
 * The states are the plan's (§6) and no others: `idle | thinking | waiting-for-you | stopped | gone`.
 * `gone` is terminal for its chat — an agent that exited mid-turn is not coming back there, so text typed
 * then could never be sent, and an entry that still invites a prompt collects words that go nowhere. New
 * chat is the way out: it retires the dead agent and the next prompt starts a fresh one.
 */

import type { AgentStatus } from './turn.ts';

export type TurnState = 'idle' | 'thinking' | 'waiting-for-you' | 'stopped' | 'gone';

/** The single button's behaviour. Its meaning never changes shape. */
export type ComposerAction = 'send' | 'stop';

/** Everything the composer renders from. See the file header for why each one is somebody else's. */
export interface ComposerInput {
  readonly state: TurnState;
  /** From `agentStatus()` in `core/turn.ts`: whether a prompt has somewhere to go, and what to say. */
  readonly agent: AgentStatus;
  /** The open session — where a prompt would go. `null` while no session is open. */
  readonly sessionId: string | null;
  /**
   * A new conversation is waiting for its first prompt: there is no session id yet, and Send is what
   * makes one. Absent means no.
   */
  readonly startsConversation?: boolean;
  /**
   * Why no prompt can ever be sent from this window (no agent exists at all). Send and the entry are off and
   * this is the caption. Stop still outranks it, though nothing can be running without an agent.
   */
  readonly unavailable?: string;
}

export interface ComposerView {
  /** What the one button does. `stop` while a turn runs, `send` otherwise. */
  readonly action: ComposerAction;
  /** The button is sensitive. False wherever `reason` has something to say. */
  readonly buttonEnabled: boolean;
  /** The entry accepts typing. */
  readonly entryEditable: boolean;
  /** Why the button is off, or why the entry is off. Shown on screen, not only as a tooltip. */
  readonly reason: string;
  /**
   * `reason` stays in tooltips and the accessible name but is not drawn under the entry. Set where the
   * page above the composer already says the same thing, so the sentence is not shown twice.
   */
  readonly reasonOnPage?: true;
  /** What is happening, when `reason` has nothing to say. Empty where there is nothing to report. */
  readonly status: string;
}

/** Nothing to send to yet, because nothing is started yet — but nothing is open either. */
const NOTHING_TO_SEND_TO = 'No agent is attached to this window yet, so there is nothing to send to.';
/** An agent is one moment away, or a message has nowhere to go. Both block Send; both are said. */
const NO_SESSION_OPEN = 'No session is open, so there is nowhere to send this. Pick one from the list.';

/**
 * The whole render decision, in one function.
 *
 * **`stop` outranks everything.** With a turn running and no agent attached — which is a state the
 * window is in while it is starting one — the button must still be Stop. A person who can see a
 * running turn and a disabled *Send* would be told to wait for a button that will not help. The same
 * argument covers the session: the turn is running, so there is a session, so `sessionId` cannot be
 * `null` here either.
 */
export function composerView(input: ComposerInput): ComposerView {
  const { state, agent } = input;

  if (state === 'thinking' || state === 'waiting-for-you') {
    return {
      action: 'stop',
      // Stop stays live while the turn runs. It is the one control that must work with nothing else
      // finished, so nothing may take it away — including a missing agent, which is why this branch
      // does not consult `agent` or `sessionId`.
      buttonEnabled: true,
      entryEditable: true,
      // Not a reason for a sensitive button; the label says "Stop" and the status line says why.
      reason: '',
      status:
        state === 'thinking' ? 'Working — the agent is answering.' : 'The agent is waiting for your answer.',
    };
  }

  if (input.unavailable) {
    return {
      action: 'send',
      buttonEnabled: false,
      entryEditable: false,
      reason: input.unavailable,
      status: '',
    };
  }

  if (state === 'gone') {
    return {
      action: 'send',
      buttonEnabled: false,
      entryEditable: false,
      // The turn's own state is the reason here, not the agent's: the turn is what ended. The agent
      // sentence would say the same thing in words that belong to a different failure.
      reason: 'The agent exited. Press New chat to send another prompt.',
      status: '',
    };
  }

  if (!agent.attached) {
    return {
      action: 'send',
      buttonEnabled: false,
      // Typing is still allowed: the text is kept, so it is there when an agent arrives. Refusing to
      // type into a field that will be enabled a second later is the surprise, not the help.
      entryEditable: true,
      // The agent's own sentence when it has one; the fallback keeps a caller that forgot to say
      // anything from rendering an empty reason under a disabled button.
      reason: agent.note || NOTHING_TO_SEND_TO,
      status: '',
    };
  }

  if (input.sessionId === null && input.startsConversation !== true) {
    return {
      action: 'send',
      buttonEnabled: false,
      entryEditable: true,
      reason: NO_SESSION_OPEN,
      // The empty state above the composer already says to pick or start a chat.
      reasonOnPage: true,
      status: '',
    };
  }

  if (state === 'stopped') {
    return {
      action: 'send',
      buttonEnabled: true,
      entryEditable: true,
      reason: '',
      // The one place a non-empty `status` sits next to a working button, and the reason it is
      // short: nothing is running, the turn ended early, and a person needs to know that their last
      // message was cut off rather than answered.
      status: 'Stopped.',
    };
  }

  // idle, attached, with a session to send to.
  return { action: 'send', buttonEnabled: true, entryEditable: true, reason: '', status: '' };
}

/** Whether the draft survives a state change. Stop keeps it; an exited agent discards it. */
export function keepsDraft(state: TurnState): boolean {
  return state !== 'gone';
}

/** Stop is offered only where a turn is actually running. */
export function offersStop(state: TurnState): boolean {
  return (
    composerView({
      state,
      agent: { attached: true, note: '' },
      sessionId: 'session',
    }).action === 'stop'
  );
}
