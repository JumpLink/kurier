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
 * **`attached` is a parameter, not a global.** Plan §7 step 4 builds the composer *without* an agent
 * and step 5 adds `openAgent`/`runTurn`, so "nothing to send to" is a real state of this slice rather
 * than a temporary gap. Injecting it means a test can ask what the composer looks like with nothing
 * attached, instead of reading whatever the machine happens to be running.
 *
 * The states are the plan's (§6) and no others: `idle | thinking | waiting-for-you | stopped | gone`.
 * `gone` is terminal — an agent that exited mid-turn is not coming back in this window, so text typed
 * then could never be sent, and an entry that still invites a prompt collects words that go nowhere.
 */

export type TurnState = 'idle' | 'thinking' | 'waiting-for-you' | 'stopped' | 'gone';

/** The single button's behaviour. Its meaning never changes shape. */
export type ComposerAction = 'send' | 'stop';

export interface ComposerView {
  /** What the one button does. `stop` while a turn runs, `send` otherwise. */
  readonly action: ComposerAction;
  /** The button is sensitive. False wherever `reason` has something to say. */
  readonly buttonEnabled: boolean;
  /** The entry accepts typing. */
  readonly entryEditable: boolean;
  /** Why the button is off, or why the entry is off. Shown on screen, not only as a tooltip. */
  readonly reason: string;
}

const NOTHING_TO_SEND_TO = 'No agent is attached to this window yet, so there is nothing to send to.';

/**
 * The whole render decision, in one function.
 *
 * **`stop` outranks `attached`.** With a turn running and no agent attached — which is a state the
 * window passes through while it is starting one — the button must still be Stop. A person who can
 * see a running turn and a disabled *Send* would be told to wait for a button that will not help.
 */
export function composerView(state: TurnState, attached: boolean): ComposerView {
  if (state === 'thinking' || state === 'waiting-for-you') {
    return {
      action: 'stop',
      // Stop stays live while the turn runs. It is the one control that must work with nothing else
      // finished, so nothing may take it away — including a missing agent, which is why this branch
      // does not consult `attached`.
      buttonEnabled: true,
      entryEditable: true,
      // Not a reason for a sensitive button; the label says "Stop" and the state line says why.
      reason: '',
    };
  }

  if (state === 'gone') {
    return {
      action: 'send',
      buttonEnabled: false,
      entryEditable: false,
      reason: 'The agent exited. Start a new session to send another prompt.',
    };
  }

  if (!attached) {
    return {
      action: 'send',
      buttonEnabled: false,
      // Typing is still allowed: the text is kept, so it is there when an agent arrives. Refusing to
      // type into a field that will be enabled a second later is the surprise, not the help.
      entryEditable: true,
      reason: NOTHING_TO_SEND_TO,
    };
  }

  if (state === 'stopped') {
    return {
      action: 'send',
      buttonEnabled: true,
      entryEditable: true,
      reason: '',
    };
  }

  // idle, attached.
  return { action: 'send', buttonEnabled: true, entryEditable: true, reason: '' };
}

/** Whether the draft survives a state change. Stop keeps it; an exited agent discards it. */
export function keepsDraft(state: TurnState): boolean {
  return state !== 'gone';
}

/** Stop is offered only where a turn is actually running. */
export function offersStop(state: TurnState): boolean {
  return composerView(state, true).action === 'stop';
}
