/**
 * What a permission gate decides, as data — and the pure logic that decides it.
 *
 * **Why this file exists at all.** Plan §7 step 6 replaced the GUI's `DENY_EVERYTHING` with a dialog
 * that asks a person. The temptation is to write that as widget code: click handler, button labels,
 * an `if` on dismissal. But every property the gate has to keep is invisible in a window:
 *
 * - a **second** request arriving while one is open must not stack, and must not be auto-answered;
 * - a **dismissal** (Escape, closed window, Stop, agent gone) must answer `cancelled`, never allow;
 * - **no** control may ever be rendered that is not one of the agent's own options, and `allow_always`
 *   must never appear.
 *
 * A widget cannot be tested for any of that without a display and a human pressing things, and this
 * repo already has that problem: the devtools plane cannot type into an entry. So the decisions live
 * here, as pure functions over plain data, and the widget only renders what comes out. Tests run on
 * both GJS and Node with no display at all.
 *
 * **What is here, in one line:** `permissionView` (what may be shown), `decideFromView` (what an id
 * means), `answerFor` (what goes back over the wire) and `PermissionDesk` (one at a time, queued, no
 * memory). Nothing else in the app may turn a response id into a decision.
 *
 * **Why there is no "always allow".** `allow_always`/`reject_always` are agent options, and the
 * schema knows how to answer them. What kurier does *not* do is remember them: there is no policy
 * store behind `PermissionDesk`, and nothing in this window keeps state between requests. Allowing
 * once and allowing forever are different promises, and a client that cannot keep the second one must
 * not offer it — the same reason `core/policy.ts` keeps the terminal path separate, and the same
 * reason a session stays a scope rather than becoming a permission (guardrail 1).
 */
import type { PermissionOption, RequestPermissionRequest, RequestPermissionResponse, ToolCallUpdate } from '@kurier/acp/types';

/** Where a request points, flattened into renderable lines. */
export type PermissionView = {
  /** The tool name as the agent reported it, capped. */
  tool: string;
  /** Tool kind: `read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `other`… */
  kind: string;
  /**
   * One line per location, agent text verbatim but capped. Empty when the agent named none — the
   * widget then says so rather than rendering an empty section.
   */
  locations: string[];
  /** The raw input as a *string*, or null when the agent did not report any. */
  rawInput: string | null;
  /** The agent's own options, in the order it reported them. Never augmented. */
  options: PermissionOption[];
};

/**
 * What kurier calls the decision a button carries, in kurier's own words.
 *
 * **This is kurier's sentence and it is built from `kind`, never from the agent's `name`.** An
 * option's `name` is the agent's to choose, and ACP lets an agent call its `allow_once` option
 * "Decline" — a dialog that printed the name verbatim would then show a suggested-looking button
 * reading "Decline" that allows, and the person would have no way to tell. So the leading word is
 * kurier's, derived from the kind, and the agent's name follows only when it adds something.
 */
const ALLOWING_WORDS = 'Allow once';
const DECLINING_WORDS = 'Decline';

/**
 * How long each field may be before it is cut, and what "cut" looks like.
 *
 * **Caps, because a tool call's fields are unbounded and this is a modal.** An agent can report a
 * megabyte-long title or ten thousand locations; a dialog is sized by its content, so without a cap
 * the buttons end up below the fold and the question cannot be answered at all. `rawInput` is capped
 * the same way for the same reason, and it is the only field with no cap besides these three — a
 * diff is supposed to be long, and it is in a scroller.
 *
 * The ellipsis is deliberate over a hard cut: a title that ends `…` says there is more, and one that
 * ends mid-word does not.
 */
const LIMITS = { tool: 120, kind: 40, location: 240, label: 120 } as const;

function cap(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

/**
 * Which response the dialog should put the keyboard focus on when it opens, or `null` for none.
 *
 * **Never an allowing option, and that is the whole rule.** A focused `Gtk.Button` is activated by
 * Enter and by Space, with or without a `default_response`, and libadwaita's own fallback is the
 * *last added* response (`Adw-1.gir` on `default-response`) — which is whichever option the agent
 * happened to send last. So an agent that orders its options `allow_once` last gets a dialog whose
 * first Enter allows, without anybody reading anything.
 *
 * The accident this prevents is not exotic: a person typing in the composer presses Enter, the dialog
 * is presented in that same instant, and the key lands on the allow button. There is no window between
 * "the question appeared" and "the button that allows has the keyboard".
 *
 * **A rejecting option's button when the agent sent one.** Enter then declines, which is the answer
 * that fails closed — the same reasoning as `rejectOnce` in `packages/acp/src/gate.ts`, which is the
 * terminal gate's version of this decision.
 *
 * **`null` when there is nothing to reject with**, and the widget then puts the focus on something that
 * does nothing on Enter rather than on an allow button. `null` is the safe answer and it is also the
 * answer that needs a second thought in the widget: there is no button to land on that is not the wrong
 * one, so the focus goes to the readable body instead.
 */
export function initialFocusResponseId(options: readonly PermissionOption[]): string | null {
  for (const option of options) {
    if (option.kind.startsWith('reject')) return option.optionId;
  }
  return null;
}

/**
 * A decision, named. There is deliberately no `allowed-always`.
 */
export type PermissionDecision =
  | { readonly type: 'allowed'; readonly optionId: string }
  | { readonly type: 'declined'; readonly optionId: string }
  | { readonly type: 'not-answered'; readonly reason: NotAnsweredReason };

/** Why nobody chose. Each of these must fail closed. */
export type NotAnsweredReason =
  /** Escape, or the dialog closed itself. */
  | 'dismissed'
  /** The window was closed while the dialog was up. */
  | 'window-closed'
  /** The person pressed Stop, or the turn was cancelled. */
  | 'turn-cancelled'
  /** The agent exited, or the transport ended, before answering. */
  | 'agent-gone';

/** The only option kinds ACP v1 defines. Anything else is a message kurier does not understand. */
const OPTION_KINDS = new Set<PermissionOption['kind']>([
  'allow_once',
  'allow_always',
  'reject_once',
  'reject_always',
]);

/**
 * Project a request into exactly what may be shown.
 *
 * Four things are load-bearing. **The options are the agent's, untouched** — no injected "always
 * allow", no synthesised default, no reordering that would put a destructive button where a careless
 * hand lands. **`rawInput` is normalised to `string | null`**, because the widget cannot do that: an
 * agent that omits `rawInput` entirely and an agent that sends `null` mean the same thing here, and
 * both must render as "the agent did not say" rather than as an empty box that looks like an
 * intentionally empty input. **Nothing on the wire is trusted to be the shape the schema declares** —
 * the same reason `AcpClient` passes `_meta` through without reading it, and the same reason guardrail 4
 * exists. A missing or wrong-typed `toolCall` projects to the fallback copy ("unnamed tool", "unknown")
 * and the options still stand, because the question is still a question somebody may answer; an option
 * whose `kind` is missing, wrong-typed, or a word the schema does not define is **dropped**, because
 * `decideFromView` decides by `startsWith('allow')` and an unknown word must not be allowed to mean
 * "allow" by prefix. Nothing here throws: a gate that throws takes the turn down, and one malformed
 * message from one agent would then look like a crash in kurier.
 */
export function permissionView(request: RequestPermissionRequest): PermissionView {
  const call = toolCallOf(request);
  const locations: string[] = [];
  const rawLocations = arrayOf(call?.locations);
  for (const location of rawLocations) {
    // `path` is what a person recognises; the line number is context, appended when the agent
    // gave one. Absent, malformed and empty locations all vanish rather than rendering "path: ".
    if (typeof location !== 'object' || location === null) continue;
    const { path, line } = location as { path?: unknown; line?: unknown };
    if (typeof path !== 'string' || path.length === 0) continue;
    const numbered = typeof line === 'number' && Number.isFinite(line) ? `:${line}` : '';
    locations.push(cap(`${path}${numbered}`, LIMITS.location));
  }
  const options: PermissionOption[] = [];
  for (const option of arrayOf((request as { options?: unknown } | undefined)?.options)) {
    if (typeof option !== 'object' || option === null) continue;
    const { optionId, name, kind } = option as { optionId?: unknown; name?: unknown; kind?: unknown };
    if (typeof optionId !== 'string' || typeof name !== 'string' || typeof kind !== 'string') continue;
    if (!OPTION_KINDS.has(kind as PermissionOption['kind'])) continue;
    // The `*_always` kinds are dropped **here**, in the projection, not in the widget. This is
    // kurier's one and only promise about memory: it keeps none, so it cannot honour "always".
    // Dropping them at the projection means a surface written later gets them for free — a
    // button cannot exist if the data it renders is not in the view.
    if (kind.endsWith('_always')) continue;
    options.push({ optionId, name, kind: kind as PermissionOption['kind'] });
  }
  return {
    tool: cap(textOf(call?.title, 'unnamed tool'), LIMITS.tool),
    kind: cap(textOf(call?.kind, 'unknown'), LIMITS.kind),
    locations,
    rawInput: rawInputOf(call?.rawInput),
    options,
  };
}

/** `request.toolCall` if the wire delivered an object there, and `undefined` if it delivered anything else. */
function toolCallOf(request: RequestPermissionRequest | undefined): ToolCallUpdate | undefined {
  const call = (request as { toolCall?: unknown } | null | undefined)?.toolCall;
  return typeof call === 'object' && call !== null ? (call as ToolCallUpdate) : undefined;
}

/** `value` if it is a string worth showing, and `fallback` for absent, wrong-typed and empty alike. */
function textOf(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * The text on a button, in kurier's voice, with the agent's name kept only when it adds something.
 *
 * **The leading word comes from `kind` and the styling comes from `kind` too**, which is what makes
 * the pair impossible to disagree: an agent that names its `allow_once` option "Decline" gets a
 * button that reads "Allow once: Decline" and looks like an approval. The agent's name is dropped when
 * it already says what the kind says, because "Allow once: Allow once" is noise in a 360 px dialog.
 *
 * **`_` is doubled, because `add_response` parses mnemonics.** GTK reads an underscore in a response
 * label as "the next character is the Alt accelerator", so an agent that named its option
 * `Delete_everything` would be choosing kurier's keyboard shortcut. Doubling the underscore escapes
 * it and prints a literal one. That is a widget fact, so the escaping happens here where the label is
 * built and is tested here — the widget passes the result through untouched.
 */
export function optionLabel(option: PermissionOption): string {
  const ours = option.kind.startsWith('allow') ? ALLOWING_WORDS : DECLINING_WORDS;
  const theirs = cap(option.name.trim(), LIMITS.label);
  const label = saysTheSame(ours, theirs) ? ours : `${ours}: ${theirs}`;
  return escapeMnemonic(label);
}

/** Whether the agent's name already states what the kind states, so repeating it adds nothing. */
function saysTheSame(ours: string, theirs: string): boolean {
  if (theirs.length === 0) return true;
  const normalise = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return normalise(ours) === normalise(theirs);
}

/** Double every underscore, which is how a `GtkLabel`-style mnemonic is escaped. */
export function escapeMnemonic(text: string): string {
  return text.replace(/_/g, '__');
}

/**
 * The raw input as a string, or null if there is none.
 *
 * `readOnly: true` and other structured payloads are rendered as JSON: the person is being asked about
 * a real request, and `[object Object]` would be no answer at all. Null and absent collapse to null so
 * the widget has exactly one "not reported" case.
 */
function rawInputOf(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object') {
    try {
      return JSON.stringify(raw, null, 2);
    } catch {
      // A circular or otherwise unserialisable payload is still information: say it is there.
      return '(the agent sent a value that could not be displayed)';
    }
  }
  return String(raw);
}

/**
 * Map a response id to a decision.
 *
 * **The fail-closed rule is the whole point of this function.** `Adw.AlertDialog` reports its own
 * `close_response` when it is dismissed, and that id is not necessarily one of the agent's — the
 * default is `"close"`, which no agent ever sends (measured:
 * `scripts/probes/alert-dialog-close.mjs` prints `has_response("close") = false`). So "not one of the
 * rendered option ids" is exactly the dismissal case, and the only safe reading of it is
 * `not-answered`. Anything that maps an unknown id to `allowed` is a bug a person finds out about by
 * watching their files change.
 *
 * **The view, not the request**, because the view is the filtered list — an `allow_always` id is gone
 * from it, and so a response carrying one is not "an id kurier forgot" but "an id kurier never
 * offered". Reading the raw request here would put the filtering back in the decision.
 */
export function decideFromResponse(
  request: RequestPermissionRequest,
  responseId: string | null | undefined,
): PermissionDecision {
  const view = permissionView(request);
  return decideFromView(view, responseId);
}

/**
 * The view, not the request — see the note above: the `*_always` ids are already gone from `view`, and
 * that is what makes an `allow_always` response a dismissal rather than a decision kurier forgot to
 * filter.
 */
export function decideFromView(view: PermissionView, responseId: string | null | undefined): PermissionDecision {
  if (typeof responseId !== 'string' || responseId.length === 0) {
    return { type: 'not-answered', reason: 'dismissed' };
  }
  const option = view.options.find((candidate) => candidate.optionId === responseId);
  // An id that was never rendered cannot have been chosen by a person. Fail closed.
  if (option === undefined) {
    return { type: 'not-answered', reason: 'dismissed' };
  }
  return { type: option.kind.startsWith('allow') ? 'allowed' : 'declined', optionId: option.optionId };
}

/**
 * The protocol answer for a decision.
 *
 * There is no `allowed_once` in ACP v1: the outcome is `selected` plus **the option id the agent
 * itself offered**, and what that id means — once or always — is the agent's business. Because
 * `permissionView` never lets an `*_always` option into the view, every `selected` kurier sends here
 * is an allow-once or a reject-once by construction, and no kurier state has to remember it.
 */
export function answerFor(decision: PermissionDecision): RequestPermissionResponse {
  if (decision.type === 'not-answered') return { outcome: { outcome: 'cancelled' } };
  return { outcome: { outcome: 'selected', optionId: decision.optionId } };
}

/**
 * A question the desk is asking, as the widget needs it.
 */
export type PermissionQuestion = {
  /** Stable id, so a surface can tell one question from the next. */
  readonly id: string;
  readonly view: PermissionView;
};

/** One question and the promise waiting on it. */
type QuestionSlot = {
  readonly question: PermissionQuestion;
  readonly settle: (decision: PermissionDecision) => void;
};

/**
 * One open question, an arrival-ordered queue behind it, and no memory.
 *
 * **Why a queue and not a second dialog.** Two modal dialogs at once means two people-shaped things to
 * answer and no obvious order; the second request usually belongs to the *first* one's answer, and a
 * dialog that appears while you are reading the first hides which question it belongs to. So requests
 * wait their turn and are shown one at a time — in arrival order, which is the only order that means
 * anything to the agent that produced them.
 *
 * **Why cancelling resolves the queue too.** If the turn is stopped while three requests wait, the
 * right answer for all three is `cancelled`: the agent is not going to act on them, and leaving three
 * dialogs alive after the window went idle would be three questions nobody can answer any more. So
 * `cancel()` clears open *and* waiting, and the caller is expected to take the widget down itself.
 *
 * **There is no timeout, and the absence is the decision.** An earlier version answered a question
 * `not-answered` after two seconds, on the theory that a gate with no deadline is a hang. It is not a
 * hang: every path where nobody chose is `cancel()`, and `AgentSession` calls it from all of them —
 * Stop, a closing window, an agent that died, a surface whose promise rejected. What a timeout adds is
 * an answer to somebody who is *reading*: the raw input of a real edit is a diff, and no one decides
 * whether to apply a diff in two seconds. The result would be worse than a hang in the one direction
 * that matters — the dialog stays on screen, the answer is already `cancelled`, and pressing "Allow
 * once" afterwards does nothing, which is a gate that looks broken rather than one that looks cautious.
 */
export class PermissionDesk {
  #open: QuestionSlot | null = null;
  #waiting: QuestionSlot[] = [];
  #onShow: (question: PermissionQuestion) => void = () => {};
  #nextId = 1;

  /**
   * The one seam: *this question is now the one on screen*. Nothing else, because the desk does not
   * render and does not own a widget — who shows it, and who tears it down on a cancel, is decided
   * by the caller. A default no-op makes `ask` usable with no surface at all, which is what the
   * fail-closed tests want.
   */
  bind(handlers: { show: (question: PermissionQuestion) => void }): void {
    this.#onShow = handlers.show;
  }

  /** The question the surface should be showing, if any. */
  get open(): PermissionQuestion | null {
    return this.#open?.question ?? null;
  }

  /** How many requests are waiting behind the open one. */
  get waiting(): number {
    return this.#waiting.length;
  }

  /**
   * Ask. Resolves with the decision — always, and only when somebody decided or somebody gave up.
   *
   * Resolving is not the same as *eventually* resolving: an unanswered question stays open, which is
   * the point. `cancel()` is what settles it, and every fail-closed path in `AgentSession` is a
   * `cancel()`.
   */
  ask(request: RequestPermissionRequest): Promise<PermissionDecision> {
    const question: PermissionQuestion = { id: `q${this.#nextId++}`, view: permissionView(request) };
    return new Promise<PermissionDecision>((resolve) => {
      // **A request with nothing to press is answered here, not shown.** `options` is the agent's
      // array and may be empty, and the filtering above may empty it — an agent that offered only
      // `allow_always` has, as far as kurier is concerned, offered nothing, because there is no
      // promise kurier could keep behind an "always". A dialog with no buttons is a dialog whose only
      // control is Escape, which is this project's "control that points at nothing" rule committed in
      // a different shape. So the answer is the one the schema names for it: `cancelled`, decided
      // here rather than by asking a person to press nothing.
      if (question.view.options.length === 0) {
        resolve({ type: 'not-answered', reason: 'dismissed' });
        return;
      }
      if (this.#open !== null) {
        // Never stack, never answer: queue it. The agent asked twice because it is waiting, and
        // answering the second on the person's behalf would be kurier deciding.
        this.#waiting.push({ question, settle: resolve });
        return;
      }
      this.#open = { question, settle: resolve };
      this.#onShow(question);
    });
  }

  /**
   * Answer the open question, **naming the question being answered.**
   *
   * **The id check is a second fail-closed rule, and it is not redundant with the option check.** A
   * surface resolves its promise with an id, and that promise can outlive the question it was asked
   * about: two requests arriving together produce two dialogs in sequence, and a surface that
   * answers the first late — after the desk has already promoted the second — would otherwise land
   * its id on the second question. A person reading question two has not read question one, so an
   * allow carried over from it is an allow for work nobody looked at. An id that is not the open
   * question's is therefore dropped: nothing is answered, nothing is allowed, and the question stays
   * open for a person.
   *
   * Anything that is not a rendered option id fails closed the same way — see `decideFromView`, which
   * is the only place that decision is made.
   */
  answer(questionId: string, responseId: string | null | undefined): void {
    const open = this.#open;
    if (open === null) return;
    if (open.question.id !== questionId) return;
    this.#advance(decideFromView(open.question.view, responseId));
  }

  /**
   * Whether anything is waiting for an answer, open or queued. What `AgentSession` asks before it
   * records a fail-closed decision, so a Stop with nothing up records nothing.
   */
  get busy(): boolean {
    return this.#open !== null || this.#waiting.length > 0;
  }

  /**
   * Fail closed for the open question and everything waiting behind it.
   *
   * Called from every path where "nobody chose" is the truth: dismissal, Stop, window close, agent
   * exit. There is no variant that cancels only the open one, on purpose — leaving queued requests
   * alive would mean the next question appears attached to a turn that no longer exists.
   */
  cancel(reason: NotAnsweredReason): void {
    const open = this.#open;
    const waiting = this.#waiting;
    this.#open = null;
    this.#waiting = [];
    if (open !== null) open.settle({ type: 'not-answered', reason });
    for (const slot of waiting) slot.settle({ type: 'not-answered', reason });
  }

  /** Answer the open question and promote the next one, in arrival order. */
  #advance(decision: PermissionDecision): void {
    const open = this.#open;
    if (open === null) return;
    this.#open = null;
    open.settle(decision);
    const next = this.#waiting.shift();
    if (next === undefined) return;
    this.#open = next;
    this.#onShow(next.question);
  }
}