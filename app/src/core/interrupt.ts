/**
 * What Ctrl-C means, which depends on what kurier is doing at the time.
 *
 * This exists because of a hole measured on the real bundle, not because a module was needed.
 * `runTurn` used to install the `SIGINT` handler itself — and `runTurn` runs *after* the handshake.
 * So a Ctrl-C during `initialize`, which for a cold `opencode acp` is seconds of real waiting,
 * killed the process with no handler installed and left the agent subprocess running: nothing owned
 * it, nobody terminated it, and the next `kurier start` found a stray process it knew nothing
 * about. An agent holds a model session and a lock in its own data directory, so "it will probably
 * die on its own" is not a cleanup strategy.
 *
 * The fix has two halves. The command owns **one** handler for its whole run and keeps the state
 * current; and the decision itself is a pure function, because a decision this load-bearing should
 * be provable by reading a test result rather than by sending real signals at a subprocess — which
 * is exactly how the earlier attempts at measuring signal behaviour produced confident wrong
 * answers.
 */

export interface InterruptState {
  /** An agent process exists. True from the moment it is spawned, before the handshake finishes. */
  agentRunning: boolean;
  /** A prompt turn is in flight. */
  turnRunning: boolean;
  /** The session that turn belongs to. Needed to name `session/cancel`. */
  sessionId: string | null;
}

export type InterruptAction =
  /** Ask the agent to stop the running turn; it answers with `cancelled` and the work is flushed. */
  | { kind: 'cancel'; sessionId: string }
  /** No turn to cancel, but a process to end: close the connection, which terminates the child. */
  | { kind: 'close' }
  /** Nothing of ours is running. Leave the signal to the default behaviour. */
  | { kind: 'ignore' };

/**
 * The decision. Pure, total, and the single place the answer lives.
 *
 * Note the ordering, which is the whole content of this function: a running turn is cancelled
 * *before* anything is closed. Closing first would SIGTERM the agent out from under the turn it is
 * in the middle of, which loses whatever it had not yet flushed — the exact thing `session/cancel`
 * exists to avoid.
 */
export function decideInterrupt(state: InterruptState): InterruptAction {
  if (!state.agentRunning) return { kind: 'ignore' };
  if (state.turnRunning && state.sessionId !== null) return { kind: 'cancel', sessionId: state.sessionId };
  return { kind: 'close' };
}

export interface InterruptHandle {
  /** Say what is going on now. Called at every transition. */
  update(state: InterruptState): void;
  /** Register the closer for the spawned agent. The effect, not the decision — see `onClose`. */
  setClose(close: () => void): void;
  /** Remove the handler. Called from a `finally`, so the CLI does not outlive it. */
  dispose(): void;
}

export interface InterruptHooks {
  /** The turn is cancelled over ACP: `session/cancel` to a session id. */
  onCancel: (sessionId: string) => void;
  /**
   * The agent process is ended. Defaults to the closer `setClose` was given; a command that has
   * nothing to close can leave it out.
   */
  onClose?: () => void;
}

/**
 * Install the one process-level handler a command needs, and keep the state it reads.
 *
 * One handler, not one per phase. Two `SIGINT` handlers on the same process both run, in
 * registration order — so a "cancel the turn" registered by `runTurn` and a "close the agent"
 * registered by `openAgent` would both fire on one keypress, and the close would cut the cancel
 * short. Which of the two is right depends on state, and only one place may hold state.
 *
 * Effects live here too, on purpose. A caller that received the `InterruptAction` and dispatched it
 * itself would have the decision tested and the wiring untested, which is the split that let the
 * orphan happen in the first place.
 */
export function installInterruptHandler(hooks: InterruptHooks): InterruptHandle {
  let state: InterruptState = { agentRunning: false, turnRunning: false, sessionId: null };
  let close: (() => void) | undefined;

  const handler = (): void => {
    const action = decideInterrupt(state);
    if (action.kind === 'cancel') hooks.onCancel(action.sessionId);
    else if (action.kind === 'close') (hooks.onClose ?? close)?.();
    // 'ignore' deliberately does nothing: there is no process of ours to end, and swallowing the
    // signal here would make a Ctrl-C in an innocent context look like it did something.
  };

  process.on('SIGINT', handler);
  return {
    update: (next) => {
      state = next;
    },
    setClose: (fn) => {
      close = fn;
    },
    dispose: () => {
      process.off('SIGINT', handler);
    },
  };
}
