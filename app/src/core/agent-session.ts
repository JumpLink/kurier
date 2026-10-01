/**
 * The controller: the one agent subprocess a window owns, and the turns that run on it.
 *
 * **Spawned on the first prompt, not on selecting a session** (plan §6). Selecting a session shows its
 * stored transcript and starts nothing — that is what makes `#open` work with no agent on the machine,
 * and it is why the window can hold thirty sessions without thirty processes. The cost is that
 * everything about *having* an agent — the handshake, the auth notice, a bad command — happens while
 * a person is waiting for their first answer, which is why every one of those paths ends in a sentence
 * rather than an exception.
 *
 * **Streamed, not batched.** Every `session/update` goes through `toTranscript` and out to the surface
 * in arrival order, immediately. There is no queue, no debounce and no frame timer here: the first
 * token of an answer is the moment the person is waiting for, and a batcher would be a batcher that
 * occasionally holds it. Persistence is per batch for the same reason — a crash mid-turn must not lose
 * the work the agent already did.
 *
 * **The gate asks a person, and it fails closed.** Every `session/request_permission` is put to the
 * surface through `onPermission`, which shows the modal dialog of plan §7 step 6 and resolves with the
 * id of the button that was pressed — one of the agent's own options, never an id kurier invented. The
 * decision logic is `core/permission.ts`; this file owns the *timing*: when the turn goes into
 * `waiting-for-you`, when it comes back, and the four paths where nobody chose and the answer has to
 * be `cancelled` — dismissal, Stop, a closing window, an agent that died. There is no surface (the
 * CLI, a test) and no `onPermission` at all, which leaves the old guardrail-2 behaviour: every request
 * answered `cancelled`, which is the one answer any gate may give.
 *
 * **`stop` is `session/cancel`, never a kill.** The notification goes out, the turn is awaited to its
 * own answer, and only then does the window leave `thinking`. Killing the subprocess instead would lose
 * whatever the agent had not yet flushed — the exact thing `session/cancel` exists to avoid, and the
 * same rule the CLI's Ctrl-C obeys (`AGENTS.md`).
 */

import type { AcpClient, RequestPermissionRequest } from '@kurier/acp';
import type { ClientGate } from '@kurier/acp/gate';
import type { RequestPermissionResponse, SessionId } from '@kurier/acp/types';
import type { TranscriptEntry } from '@kurier/session';

import type { AgentCommand } from './agents/stdio.ts';
import type { TurnState } from './composer-state.ts';
import {
  answerFor,
  PermissionDesk,
  type NotAnsweredReason,
  type PermissionDecision,
  type PermissionQuestion,
} from './permission.ts';
import { openAgent, runTurn, withAuthHint, type AgentHandle, type OpenAgentOptions } from './run.ts';
import { toTranscript } from './transcript.ts';
import {
  agentExitedEntry,
  agentStatus,
  isEchoOf,
  permissionDecisionEntry,
  transition,
  type AgentAttachment,
  type AgentStatus,
  type CancelledBy,
  type TurnEvent,
} from './turn.ts';

/** What the surface is told, and when. Every one of these is a decision already made in `core/`. */
export interface AgentSessionEvents {
  /** The render inputs changed: turn state, the agent's life, and where a prompt would go. */
  onSnapshot(snapshot: AgentSnapshot): void;
  /** Transcript lines that just arrived — in order, immediately, already persisted. */
  onEntries(entries: TranscriptEntry[]): void;
  /**
   * Something the person should know that is not a transcript line: the agent's auth advertisement,
   * its stderr, a cancellation that could not be sent.
   *
   * **It goes to the log, and the log is where a person looks last.** The window collects these and
   * counts them rather than showing them — there is no notice area in this layout yet, and a notice
   * area that is a text box nobody can act on is the control-this-window-forbinds. Everything a person
   * *can* act on is therefore also a `reason` on screen or a transcript line: an agent that exited
   * says so in both places, and a permission decision says what was asked and what was chosen.
   */
  onNotice?(message: string): void;
  /**
   * The spawn-time closer, handed over the moment the process exists and **before** the handshake.
   *
   * The gap this closes is a real orphan, not a theoretical one: a cold `opencode acp` takes seconds
   * to answer `initialize`, and closing the window in that window used to leave the agent running with
   * nothing owning it. The window holds it so it can end the process even though no turn has started
   * yet — see `shutdown` for the ordering, which is cancel, await, and only then terminate.
   */
  onCloser?(close: () => void): void;
  /**
   * Ask the person. **The surface shows the dialog and resolves with the response id of the button
   * that was pressed** — an id the agent itself offered, or something else, and only
   * `core/permission.ts` decides what "something else" means.
   *
   * **It resolves; it does not reject.** A dialog that is torn down by the window closing is not an
   * error, it is "nobody chose", which is `cancelled`. An implementation that rejects instead would
   * turn a closed window into a failed turn, which is a different and wrong sentence.
   *
   * Optional, and the absence is meaningful: a surface without it (the CLI, a unit test) gets every
   * request answered `cancelled`, which is guardrail 2. Adding this hook cannot make the gate *more*
   * permissive by accident — a surface that forgets to resolve hangs, and every hang path in here
   * ends in `cancel`.
   */
  onPermission?(question: PermissionQuestion): Promise<string | null | undefined>;
}

export interface AgentSnapshot {
  readonly state: TurnState;
  readonly attachment: AgentAttachment;
  /** The session a prompt would go to. `null` while no session is open. */
  readonly sessionId: SessionId | null;
}

/** The session a window is bound to. */
export interface BoundSession {
  readonly id: SessionId;
  readonly cwd: string;
}

/**
 * How long a close waits for a cancelled turn before ending the subprocess anyway.
 *
 * **The plan says "cancel, await the turn, then terminate. Never terminate first", and this is the
 * escape hatch that makes that rule survivable.** An agent that has been told to stop and does not stop
 * is a real thing — a stuck provider call, a wedged tool — and a window that cannot be closed because
 * kurier is politely waiting for it is a worse defect than a lost flush. So the wait is bounded: with a
 * cooperative agent the turn settles in milliseconds and the window closes with its own `cancelled`
 * answer recorded, and only a silent one is terminated — which is what makes the pending
 * `session/prompt` reject, so the turn still settles instead of hanging.
 */
const CLOSE_GRACE_MS = 5_000;

export interface AgentSessionOptions {
  readonly command: AgentCommand;
  readonly events: AgentSessionEvents;
  /** Persistence. `SessionStore.append`; a surface without a store (a test) leaves it out. */
  readonly append?: (sessionId: SessionId, entries: TranscriptEntry[]) => void;
  /** ISO clock, injected so a test can pin the transcript's timestamps. */
  readonly now?: () => string;
  /**
   * The seam for the connection. Defaults to `openAgent` (a subprocess); a test passes a function that
   * builds an `AcpClient` over `FixtureAgent.transport`, which is how this controller is covered on
   * both runtimes without a process anywhere.
   */
  readonly open?: (options: OpenAgentOptions) => Promise<AgentHandle>;
  /** How long a close waits for a cancelled turn. Default `CLOSE_GRACE_MS`. */
  readonly closeGraceMs?: number;
}

/** What the controller needs of an `AgentHandle`: the connection, and a way to end it. */
interface AgentClientHandle {
  readonly client: AcpClient;
  close(): void;
}

export class AgentSession {
  readonly #command: AgentCommand;
  readonly #events: AgentSessionEvents;
  readonly #append: (sessionId: SessionId, entries: TranscriptEntry[]) => void;
  readonly #now: () => string;
  readonly #open: (options: OpenAgentOptions) => Promise<AgentHandle>;
  readonly #closeGraceMs: number;
  /**
   * One open question, a queue behind it, no memory. Owned here rather than by the surface because the
   * fail-closed paths are *this* file's: a Stop, a closing window and a dying agent are decided here,
   * and a desk the widget owned would be one the widget could not close on those paths. See
   * `core/permission.ts`.
   */
  readonly #desk = new PermissionDesk();
  /** How many asks are in flight, so the state move brackets the wait and not each question. */
  #askDepth = 0;
  /** Whether the gate has been asked anything at all. See `permissionAsked`. */
  #askedPermissions = false;

  #session: BoundSession | null = null;
  #state: TurnState = 'idle';
  #attachment: AgentAttachment = { status: 'none' };
  #handle: AgentClientHandle | null = null;
  /** The closer `onSpawn` handed over. Covers a close during the handshake — see `shutdown`. */
  #spawnedClose: (() => void) | null = null;
  /** True once a process exists — from spawn, before the handshake. What `agentRunning` reports. */
  #processAlive = false;
  /** In flight while `openAgent` runs, so a second prompt cannot start a second process. */
  #connecting: Promise<AgentClientHandle> | null = null;
  /**
   * True once `session/prompt` has gone out.
   *
   * **The line between "could not start" and "died mid-turn", and it is not the process's existence.**
   * A spawn happens before the handshake, so "a process exists" is true for a binary that is not on PATH
   * as well as for an agent that answered and then died — and the two need opposite answers. What
   * separates them is whether a turn ever left: no prompt sent means no turn ran, so the state goes back
   * to `idle` and the reason is about starting; a prompt sent and then no answer means the agent went
   * away during the turn, which is `gone` plus a transcript line.
   */
  #promptSent = false;
  /** The session the *agent* holds, which is not necessarily the one on screen. */
  #agentSession: SessionId | null = null;
  /** The turn promise, so Stop and a closing window can await the same settlement. */
  #turn: Promise<void> | null = null;
  /**
   * The session the **running turn** belongs to.
   *
   * Not `this.#session`, which is the row on screen. A person may switch rows while a turn runs, and
   * both the stop notification and the arriving updates belong to the turn's session, not the new one —
   * cancelling session B because the person is now looking at B, or filing A's answer into B's
   * transcript, are the two ways this goes wrong. The field is cleared when the turn settles.
   */
  #turnSession: SessionId | null = null;
  /**
   * Set by *this* controller's Stop, cleared when a turn starts.
   *
   * **The only evidence there ever was that a Stop was ours.** `session/cancel` is a notification and
   * nothing answers it; the `cancelled` stop reason that comes back afterwards cannot be attributed to
   * a request. So `stop()` records the intention here and `cancelledBy` is derived from it rather than
   * guessed from the agent's answer — see `CancelledBy`.
   */
  #cancelRequested = false;

  constructor(options: AgentSessionOptions) {
    this.#command = options.command;
    this.#events = options.events;
    this.#append = options.append ?? (() => {});
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#open = options.open ?? ((openOptions) => openAgent(openOptions));
    this.#closeGraceMs = options.closeGraceMs ?? CLOSE_GRACE_MS;
    // **Bound in the constructor, not at the first ask.** The desk owns "this question is on screen",
    // and the surface is what is on screen — wiring it lazily would mean the first request of the very
    // first turn took a different path from every one after it.
    this.#desk.bind({ show: (question) => this.#present(question) });
    // **No snapshot is emitted here, and that is deliberate.** A caller that has just constructed this
    // object holds the only state there is — `snapshot` — and can read it without being called back into.
    // The alternative cost a real crash: the window constructs the controller before the composer (the
    // composer's first render needs `agent.snapshot`), so an emit from the constructor reached a
    // `#composer` field that did not exist yet and threw inside a constructor, before there was a window
    // to report it on.
  }

  /** The render inputs, as one value. The surface never reaches into the controller's fields. */
  get snapshot(): AgentSnapshot {
    return { state: this.#state, attachment: this.#attachment, sessionId: this.#session?.id ?? null };
  }

  /** The composer's two agent facts. The join between `turn.ts`'s model and `composer-state.ts`. */
  get agent(): AgentStatus {
    return agentStatus(this.#attachment);
  }

  /** True while a turn is in flight. Stop and the closing window both ask this first. */
  get turnRunning(): boolean {
    return this.#turn !== null;
  }

  /**
   * True once the gate has been asked anything this window — a real request, or `KU_APP_PERMISSION`'s
   * staged one.
   *
   * **A surface needs this and nothing else can give it to the surface.** Whether a question is on
   * screen right now is the dialog's own business, and whether one has *ever* been is the gate's: a
   * staging hook that only checked "is one up now" would fire its fixture in the gap between the
   * dialog closing and the next request arriving, which is exactly the double dialog the desk's queue
   * exists to prevent. Never reset — a question asked in the first turn still counts.
   */
  get permissionAsked(): boolean {
    return this.#askedPermissions;
  }

  /** True once a process exists — during the handshake too, which is exactly when it matters. */
  get agentRunning(): boolean {
    return this.#processAlive;
  }

  /**
   * Point the window at a stored session. **Starts nothing.**
   *
   * Called by `#open` for every row the person clicks, which is the reason it must stay free of a
   * spawn: opening thirty sessions to look at them is how a window ends up holding thirty processes.
   * The agent binds to a session later, when a prompt asks it to (`#bindAgent`), which is the plan's
   * "selecting a session shows its stored transcript; prompting binds it".
   */
  bind(session: BoundSession | null): void {
    this.#session = session;
    this.#emit();
  }

  /**
   * Re-announce the current state without changing anything.
   *
   * **A caller needs this exactly once: after its own widgets exist.** The constructor deliberately does
   * not emit (see there), so a surface that builds its widgets from `snapshot` has to ask for the first
   * render explicitly — and asking is safer than being called into, because the widgets are already built
   * by then. Every later change emits on its own, because every later change is an event.
   */
  refresh(): void {
    this.#emit();
  }

  /**
   * Send a prompt and run one turn.
   *
   * **The person's own words are recorded before anything is sent.** The prompt is appended to the
   * store and handed to the surface first, so the message is on screen while the handshake is still
   * running; a prompt that appeared only after `session/prompt` was accepted would look lost for the
   * seconds a cold agent takes to answer `initialize`.
   *
   * Resolves when the turn has settled. The window's `onSend` is a callback and ignores the promise;
   * `stop()` and `shutdown()` are what wait on it.
   */
  async prompt(text: string): Promise<void> {
    const session = this.#session;
    const body = text.trim();
    // Also the answer to "why did nothing happen when I pressed Send": there is no session to prompt, and
    // `composerView` has already disabled the button and said so on screen. Not throwing here is what
    // keeps that a dead button rather than a dead button *and* a stack trace nobody can see.
    if (!session || body === '') return;
    // The composer shows Stop while a turn runs, so this should be unreachable — and a second turn on
    // one session id would have the agent interleaving two answers into one transcript.
    if (this.#turn) return;

    this.#cancelRequested = false;
    this.#turnSession = session.id;
    this.#record(session.id, [{ kind: 'user', text: body, at: this.#now(), sessionId: session.id }]);
    this.#move({ kind: 'prompt' });

    const turn = this.#runTurn(body, session).finally(() => {
      this.#turn = null;
      this.#turnSession = null;
    });
    this.#turn = turn;
    await turn;
    // Cleared after the turn, not before the next one: `#reportFailure` reads it while the turn is still
    // settling, and a failure in *this* turn must not be attributed to a later one.
    this.#promptSent = false;
  }

  /**
   * Stop the running turn.
   *
   * **Does not settle the turn, and does not kill anything.** It sends `session/cancel` and returns;
   * the surface leaves `thinking` when the turn answers, which is the only moment it has actually
   * stopped. A window that left `thinking` on the click would claim a stop that has not happened yet,
   * and would hide the tail of an answer that is still arriving.
   *
   * A Stop that arrives during the handshake — seconds after the click, against a cold agent — is
   * recorded in `#cancelRequested` and acted on in `#runTurn`: no prompt is in flight yet, so nothing
   * is sent and the turn ends where it began. That is also the only path on which the turn settles with
   * **no** `stopReason`, and it is reported as a stop because that is what the person asked for.
   */
  stop(): void {
    if (!this.#turn) return;
    this.#cancelRequested = true;
    // **Stop with a dialog open closes the dialog, and the answer is `cancelled`.** The person pressed
    // the button that says the turn is over; a question left up after that would be asking them to
    // decide about work they just stopped, and the agent is not going to act on the answer anyway.
    this.#failClosed('turn-cancelled');
    const handle = this.#handle;
    const sessionId = this.#turnSession;
    // Nothing to cancel against while the handshake is still running — there is no prompt in flight
    // and, for an agent that has not answered `session/new` yet, nothing certain to name. The flag
    // above is what stops the turn once there is.
    if (!handle || !sessionId) return;
    try {
      handle.client.cancel({ sessionId });
    } catch (error) {
      // The connection is already gone, which means the turn is about to settle with no answer anyway:
      // there is nothing left to cancel, and the person is already looking at an agent that exited.
      this.#events.onNotice?.(`session/cancel could not be sent: ${describe(error)}`);
    }
  }

  /**
   * Cancel, wait for the turn, then end the agent. Plan §6, in that order.
   *
   * **The window calls this from `close-request` and closes itself when it returns.** Terminating
   * first would SIGTERM the agent out of the turn it is in the middle of — the ordering the plan rules
   * out and the one the CLI's Ctrl-C path exists to avoid. The wait is bounded by `closeGraceMs`; that
   * constant says why.
   *
   * The spawn-time closer is what ends a process that exists while no turn does — the handshake. A
   * close there has nothing to await, and without that closer the window would go away leaving a
   * running agent behind it, which is the orphan `onSpawn` exists to prevent.
   */
  async shutdown(graceMs = this.#closeGraceMs): Promise<void> {
    // A close with a dialog up: same rule as Stop, and it comes first so the dialog is gone before the
    // window's `close-request` handler returns. `window-closed` rather than `turn-cancelled` because
    // the turn is still running when the person closes the window — it is the window that ended, not
    // the turn — and the transcript should say which.
    this.#failClosed('window-closed');
    if (this.#turn) {
      this.stop();
      await Promise.race([this.#turn, this.#after(graceMs)]);
    }
    const close = this.#handle?.close ?? this.#spawnedClose;
    this.#handle = null;
    this.#spawnedClose = null;
    this.#connecting = null;
    this.#processAlive = false;
    close?.();
  }

  // ─── the turn ──────────────────────────────────────────────────────────────────────────────

  async #runTurn(body: string, session: BoundSession): Promise<void> {
    try {
      const handle = await this.#connect();
      // Stop pressed during the handshake: no prompt was sent, so there is nothing to cancel and
      // nothing to wait for.
      if (this.#cancelRequested) {
        this.#move({ kind: 'turn-ended', stopReason: null, cancelledBy: 'window' });
        return;
      }
      await this.#bindAgent(handle, session);
      // **The same check again, and it is not a duplicate.** The one above guards the handshake, which
      // is quick; `bindAgent` then awaits `session/load`, and on a cold agent that is the *replay of
      // the whole history* — seconds, not milliseconds. A Stop pressed in that window sets
      // `#cancelRequested` and sends `session/cancel`, which arrives with no turn to cancel, and then
      // the code below would set `#promptSent` and send the prompt anyway: the agent gets
      // cancel-then-prompt, answers in full, and the window sits in `thinking` after the person
      // pressed Stop. Since prompting a session is what *causes* the load, this is the first prompt of
      // every session rather than an edge case.
      if (this.#cancelRequested) {
        this.#move({ kind: 'turn-ended', stopReason: null, cancelledBy: 'window' });
        return;
      }
      // From here a turn exists: if the promise below rejects, the agent went away *during* it, and the
      // transcript line the plan asks for is the honest record. See `#reportFailure`.
      this.#promptSent = true;
      const { stopReason } = await runTurn(handle.client, {
        sessionId: session.id,
        text: body,
        onUpdate: (notification) => this.#onUpdate(notification, body, session.id),
      });
      this.#move({ kind: 'turn-ended', stopReason, cancelledBy: this.#cancelledBy(stopReason) });
    } catch (error) {
      this.#reportFailure(error);
    }
  }

  /**
   * Where the agent's `cancelled` answer came from — ours, or its own.
   *
   * A Stop we sent is only a Stop if the agent agreed: `#cancelRequested` is set by `stop()` and
   * cleared when a turn starts, so an agent that abandons a turn nobody cancelled reports `agent` and
   * lands on `idle` rather than claiming a person pressed Stop.
   */
  #cancelledBy(stopReason: string): CancelledBy {
    if (stopReason !== 'cancelled') return 'none';
    return this.#cancelRequested ? 'window' : 'agent';
  }

  #onUpdate(notification: Parameters<typeof toTranscript>[0], body: string, sessionId: SessionId): void {
    const entries = toTranscript(notification, this.#now()).filter((entry) => {
      // Not ours: an update for another session is another conversation (opencode announces child
      // sessions), and filing it in this record would make the file disagree with the agent.
      if (notification.sessionId !== sessionId) return false;
      // Our own prompt, echoed back — see `isEchoOf` for why this filter exists and why it is an
      // equality test rather than "drop the first user chunk".
      return !(entry.kind === 'user' && isEchoOf(entry.text, body));
    });
    this.#record(sessionId, entries);
  }

  /** Persist, then hand the same lines to the surface. Persistence first: a crash keeps the work. */
  #record(sessionId: SessionId, entries: TranscriptEntry[]): void {
    if (entries.length === 0) return;
    this.#append(sessionId, entries);
    this.#events.onEntries(entries);
  }

  // ─── the connection ────────────────────────────────────────────────────────────────────────

  /**
   * One process per window, started on the first prompt, reused for every turn after it.
   *
   * **A failure here is a sentence, not an exception.** `openAgent` rejects for a binary that is not
   * on PATH, a handshake that times out, a protocol version kurier does not implement, and — through
   * `withAuthHint` — for `auth_required`, whose remedy is `kurier auth` in a terminal this window does
   * not have (plan §6, trap 1). All four become `AgentAttachment: 'failed'` with the message, which is
   * what the composer puts under the entry, so the person reads what to do instead of watching a
   * spinner that will never resolve.
   */
  async #connect(): Promise<AgentClientHandle> {
    if (this.#handle) return this.#handle;
    if (this.#connecting) return this.#connecting;
    const connecting = (async () => {
      this.#setAttachment({ status: 'attaching' });
      const handle = await this.#open({
        command: this.#command,
        gate: this.#gate(),
        // The agent's stderr is not a transcript line — it is the agent talking to itself, and
        // `AGENTS.md` keeps it off stdout for the same reason. The notice channel is where it goes.
        onLog: (line) => this.#events.onNotice?.(`[agent] ${line}`),
        onNotice: (message) => this.#events.onNotice?.(message),
        onSpawn: (close) => {
          // Before the handshake — which is the entire reason `onSpawn` exists: there must be no interval
          // in which a process exists that nobody can end.
          this.#processAlive = true;
          this.#spawnedClose = close;
          this.#events.onCloser?.(close);
        },
      });
      this.#handle = { client: handle.client, close: handle.close };
      this.#setAttachment({ status: 'attached', name: handle.agentInfo });
      return this.#handle;
    })();
    this.#connecting = connecting;
    try {
      return await connecting;
    } catch (error) {
      this.#connecting = null;
      throw error;
    }
  }

  /**
   * The gate: the agent's `session/request_permission`, put to a person.
   *
   * **Three shapes of this function, one rule.** With an `onPermission` surface the question goes to
   * the desk, which shows one dialog at a time and queues the rest. Without one — the CLI, a test —
   * the answer is `null`, the protocol's `cancelled`, which is the one answer any gate may give: there
   * was no decision to make, so no option of the agent's was picked. And if the question is *waiting*
   * when the turn dies, `#failClosed` settles it. All three end at the same place: nothing is ever
   * allowed because the agent asked, and nothing is ever left hanging.
   *
   * The turn state moves to `waiting-for-you` around the ask and back when it is answered, which is
   * what puts a Stop button next to a dialog — a dialog with a running turn is not the same thing as a
   * dialog on a window that can no longer act.
   */
  #gate(): ClientGate {
    return {
      permission: async (request: RequestPermissionRequest) => {
        const sessionId = this.#turnSession;
        // **The gate's return value is an option id or `null`, not a decision.** `PermissionGate` is
        // typed that way and the typing is the guardrail: a gate cannot answer "yes", only "this id
        // the agent offered" or "nothing", and `answerFor` is where that becomes the protocol object.
        const answer = (decision: PermissionDecision): string | null => {
          if (sessionId) {
            this.#record(sessionId, [permissionDecisionEntry(request, sessionId, this.#now(), decision)]);
          }
          // `answerFor` is the one place the decision becomes a protocol object. The gate needs the id
          // and not the object, so it is read back out of the `selected` outcome — and a
          // `cancelled` outcome has no id, which is the same fact as `null`.
          const outcome = answerFor(decision).outcome;
          return outcome.outcome === 'selected' ? outcome.optionId : null;
        };
        // No surface can ask: guardrail 2, unchanged. Recorded, because a refusal nobody can see is a
        // policy in the wrong place. `dismissed` rather than a reason of its own, because there was
        // never a dialog for anyone to dismiss — this is the same "nobody chose" as an Escape.
        if (!this.#events.onPermission) {
          this.#askedPermissions = true;
          return answer({ type: 'not-answered', reason: 'dismissed' });
        }
        return answer(await this.#ask(request));
      },
    };
  }

  /**
   * One question, from the desk to the surface and back.
   *
   * **The state move happens once, not per queued question.** `permission-asked`/`permission-answered`
   * bracket the whole *ask*, which may cover three queued requests — the window is waiting for the
   * person either way, and going `thinking → waiting → thinking` between them would make the composer
   * flicker for no reason. It also means the bracketing cannot nest: a second request arriving while a
   * dialog is up finds `#ask` already running and only joins the queue.
   */
  async #ask(request: RequestPermissionRequest): Promise<PermissionDecision> {
    this.#askedPermissions = true;
    if (this.#askDepth === 0) this.#move({ kind: 'permission-asked' });
    this.#askDepth += 1;
    try {
      return await this.#desk.ask(request);
    } finally {
      this.#askDepth -= 1;
      if (this.#askDepth === 0) this.#move({ kind: 'permission-answered' });
    }
  }

  /**
   * The desk's one seam, and the only place this controller talks to the surface about a question.
   *
   * **The surface is called when the question reaches the front, not when it arrived.** That is the
   * whole reason the desk exists: three requests arriving at once produce three `show` calls in
   * arrival order, one dialog, and no question shown before the one in front of it has been answered.
   *
   * **The id goes back through `answer(questionId, responseId)`, never straight into the wire.** The
   * surface resolves with whatever the dialog reported, and the desk decides what that means *and
   * which question the answer belongs to* — so a dismissal arriving as `"close"`, an id the agent
   * never sent, and an answer for a question that is no longer the open one all fail closed on their
   * way past here.
   */
  #present(question: PermissionQuestion): void {
    const ask = this.#events.onPermission;
    if (ask === undefined) {
      // No surface: answered here rather than left hanging. The gate already short-circuits this
      // case, so reaching it would be a bug in the wiring — failing closed is still the right answer.
      this.#desk.answer(question.id, null);
      return;
    }
    void (async () => {
      let responseId: string | null = null;
      try {
        responseId = (await ask(question)) ?? null;
      } catch {
        // A surface that throws has not answered. A null id is the dismissal reading, so the question
        // fails closed instead of taking the turn down with it.
        responseId = null;
      }
      this.#desk.answer(question.id, responseId);
    })();
  }

  /**
   * Nobody chose, for a reason only the caller knows, and the question is on screen.
   *
   * **This is how the window names its own ending.** `stop()` and `shutdown()` call the fail-closed
   * path themselves, but the *widget* is the window's, and the window is what knows whether the
   * person pressed Stop or closed the window — two answers that are both `cancelled` over the wire and
   * are not the same sentence in a transcript. Calling this before taking the dialog down is what
   * makes the reason `window-closed` rather than the vaguer `dismissed` the dialog's own close would
   * produce, and it makes that independent of which microtask runs first.
   *
   * A no-op when nothing is open, so a caller does not have to ask.
   */
  dismissPermission(reason: NotAnsweredReason): void {
    this.#failClosed(reason);
  }

  /**
   * Ask the gate a fixture question and answer it, for `KU_APP_PERMISSION`.
   *
   * **It goes through `#ask` and `answerFor`, not around them** — same desk, same projection, same
   * decision logic — so a screenshot of the staged dialog is a screenshot of the gate's behaviour. It
   * deliberately does *not* go through `#gate`'s recording half: no transcript line is written for a
   * request no agent made, because the transcript is a record of what happened and this did not.
   *
   * **The option ids are the schema's own kinds with fixture ids**, because the *kinds* are what the
   * gate filters on and a fixture with invented kinds would exercise nothing. Both spellings of
   * "always" are on the wire here, which is the point: the dialog must not show them, because kurier
   * keeps nothing and so cannot honour them.
   *
   * Resolves with the answer that was reached, so a caller can log it; nothing in the window waits on
   * it, and no protocol object is sent anywhere — there is no agent on the wire for this one.
   */
  async stagePermissionRequest(): Promise<RequestPermissionResponse> {
    const request: RequestPermissionRequest = {
      sessionId: this.#turnSession ?? this.#session?.id ?? 'staged',
      toolCall: {
        toolCallId: 'staged-1',
        status: 'pending',
        title: 'Write src/hello.ts',
        kind: 'edit',
        locations: [{ path: 'src/hello.ts', line: 12 }],
        rawInput: {
          path: 'src/hello.ts',
          content: "export const hello = () => 'world';\n",
        },
      },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow-always', name: 'Always allow in this session', kind: 'allow_always' },
        { optionId: 'reject-once', name: 'Decline', kind: 'reject_once' },
        { optionId: 'reject-always', name: 'Always decline in this session', kind: 'reject_always' },
      ],
    };
    return answerFor(await this.#ask(request));
  }

  /**
   * Nobody chose, for a reason this controller knows. **Every fail-closed path is here**, so a new one
   * has nowhere else to go and cannot forget the answer.
   */
  #failClosed(reason: NotAnsweredReason): void {
    if (!this.#desk.busy) return;
    this.#desk.cancel(reason);
  }

  /**
   * Put the agent in front of the session the window is showing.
   *
   * **`session/load`, `session/resume`, or a refusal — never an assumption.** `AcpClient.reattach` asks
   * for `load` when the agent advertised it, falls back to `resume`, and rejects with
   * `UnsupportedCapabilityError` when the agent offers neither (trap 2). That refusal is a *sentence*
   * here, because the alternative — quietly prompting a session the agent has never heard of — ends the
   * turn with an error nobody can act on.
   *
   * **The history an agent replays on load is not recorded, and that is deliberate.** Replaying is what
   * `session/load` is for and it arrives as ordinary `session/update` notifications, but this runs
   * *before* `runTurn` subscribes — and a conversation kurier already has on disk must not be written to
   * disk a second time. `tests/unit/core/agent-session.test.ts` pins that with the fixture agent,
   * which replays.
   *
   * The attached session is remembered rather than assumed, because one process holds several sessions
   * and a prompt may only go to one of them: a person who switches rows between two turns gets a second
   * `reattach`, not a prompt aimed at the wrong conversation.
   */
  async #bindAgent(handle: AgentClientHandle, session: BoundSession): Promise<void> {
    if (this.#agentSession === session.id) return;
    await withAuthHint('attaching to the session', () =>
      handle.client.reattach(session.id, { cwd: session.cwd }),
    );
    this.#agentSession = session.id;
  }

  /**
   * A turn that could not run.
   *
   * **Two failures, two sentences, and which one it is decided by whether a prompt ever left.** One
   * that went away mid-turn has no answer and no future: the state is `gone` and the transcript gets the
   * plan's line, because inventing an `end_turn` for a dead agent is the fabrication §6 forbids. One
   * that never got going — a bad command, a handshake that timed out, `auth_required`, an agent that can
   * neither load nor resume (trap 2) — has no turn to report, so the state goes back to `idle` and the
   * reason lives on the attachment, where the composer shows it beside the button that will not work.
   *
   * An agent that died *during* the handshake counts as the second case, for the same reason: no prompt
   * was ever sent, so a transcript line claiming "the agent exited during this turn" would be about a
   * turn that did not run.
   */
  #reportFailure(error: unknown): void {
    const message = describe(error);
    // An agent that died mid-turn cannot answer a question it sent. Settle the desk before the state
    // moves, so no dialog outlives the window that shows it, and with `agent-gone` as the reason —
    // that is what actually happened, and it is the one reason a person cannot act on.
    this.#failClosed('agent-gone');
    if (!this.#promptSent) {
      // Nothing ever left for the agent, so there is no turn to report as gone. `idle` rather than
      // `thinking`, because a turn that never started must not leave the window looking busy — and
      // `thinking` would show a Stop button with nothing to stop.
      this.#setAttachment({ status: 'failed', message });
      this.#move({ kind: 'turn-ended', stopReason: null, cancelledBy: 'none' });
      return;
    }
    const sessionId = this.#turnSession;
    if (sessionId) this.#record(sessionId, [agentExitedEntry(sessionId, this.#now(), message)]);
    this.#setAttachment({ status: 'gone', reason: message });
    this.#move({ kind: 'agent-gone', reason: message });
  }

  #setAttachment(attachment: AgentAttachment): void {
    this.#attachment = attachment;
    this.#emit();
  }

  #move(event: TurnEvent): void {
    this.#state = transition(this.#state, event);
    this.#emit();
  }

  #emit(): void {
    this.#events.onSnapshot(this.snapshot);
  }

  #after(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      // Unref'd so a pending grace timer can never be the reason a process refuses to exit — the same
      // reason `StdioChannel.terminate` unrefs its SIGKILL timer.
      (timer as { unref?: () => void }).unref?.();
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
