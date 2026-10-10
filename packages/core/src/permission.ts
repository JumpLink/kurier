/**
 * What a permission gate decides, as data — and the pure logic that decides it.
 *
 * **Why this file exists at all.** Plan §7 step 6 replaced the GUI's `DENY_EVERYTHING` with a dialog
 * that asks a person. The temptation is to write that as widget code: click handler, button labels,
 * an `if` on dismissal. But every property the gate has to keep is invisible in a window:
 *
 * - a **second** request arriving while one is open must not stack, and must not be auto-answered;
 * - a **dismissal** (Escape, closed window, Stop, agent gone) must answer `cancelled`, never allow;
 * - **no** control may ever be rendered that is not one of the agent's own options, and **no allow
 *   option may hold the initial focus** — including `allow_always`.
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
 * **Why `allow_always` and `reject_always` are shown, not filtered.** They used to be dropped here, on
 * the reasoning that a client which keeps no promise must not offer one. That reasoning was backwards:
 * **the agent remembers an "always", not lotse.** ACP has no `allowed_always` outcome and no policy
 * handshake — the answer is `selected` plus *the agent's own option id*, and the agent is the party
 * that decides whether to ask again. lotse stores no policy, so it has nothing to store, and passing
 * an id back changes nothing about the wire: the agent already treats that id as permission it granted
 * itself. Hiding the button therefore removed a choice a person had *without* adding a single check —
 * the fail-closed rules below are about who chose, not about how wide a promise they chose.
 *
 * What does not follow from that is leniency. Every rule here that is about *how* the choice was made
 * still holds: nothing is focused that could allow, `allow_always` is never what a bare Enter or a bare
 * newline lands on, it is never the first allowing button **when a narrower allow exists**, and every
 * path where nobody chose is still `cancelled`. The one case the ordering rule cannot cover is an agent
 * whose only allowing option is `allow_always`; there is nothing narrower to prefer, so `optionLabel`
 * and the no-timeout rule are what keep that button honest — the word "Always" is on it, and nobody
 * answered anything, so it was never chosen.
 */
import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ToolCallUpdate,
} from '@lotse/acp/types';

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
  /**
   * Every option the agent sent, never augmented and never filtered — in **lotse's** order
   * (`orderOptions`), not the order the agent reported them, because that order is chosen by the agent
   * and the button row is not.
   */
  options: PermissionOption[];
};

/**
 * What lotse calls the decision a button carries, in lotse's own words — **one sentence per kind.**
 *
 * **This is lotse's sentence and it is built from `kind`, never from the agent's `name`.** An
 * option's `name` is the agent's to choose, and ACP lets an agent call its `allow_once` option
 * "Decline" — a dialog that printed the name verbatim would then show a suggested-looking button
 * reading "Decline" that allows, and the person would have no way to tell. So the leading word is
 * lotse's, derived from the kind, and the agent's name follows only when it adds something.
 *
 * **Four sentences, not two with a suffix.** "Allow once" / "Allow always" as a pair would make the
 * difference a trailing word in a 360 px dialog, and the two buttons sit next to each other — the
 * whole point of showing `allow_always` is that a person can tell which promise they are making, so
 * the difference is the first thing they read: *once* against *always*.
 */
const KIND_WORDS: Record<PermissionOption['kind'], string> = {
  allow_once: 'Allow once',
  allow_always: 'Always allow',
  reject_once: 'Decline',
  reject_always: 'Always decline',
};

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
const LIMITS = { tool: 120, kind: 40, location: 240, agentName: 80 } as const;

function cap(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

/**
 * Which response the dialog should put the keyboard focus on when it opens, or `null` for none.
 *
 * **Never an allowing option, and that is the whole rule — `allow_always` most of all.** A focused
 * `Gtk.Button` is activated by Enter and by Space, with or without a `default_response`, and libadwaita
 * puts the focus on the **first** added response when `default_response` is unset — *not* the last,
 * which is what `Adw-1.gir` says (measured both directions, `scripts/probes/alert-dialog-close.mjs`
 * case 9). So an agent that orders its options `allow_once` first gets a dialog whose first Enter
 * allows, without anybody reading anything. Two hazards get one answer here: the option itself may
 * allow, and an "always" allow would widen the answer past the request on screen.
 *
 * The accident this prevents is not exotic: a person typing in the composer presses Enter, the dialog
 * is presented in that same instant, and the key lands on the allow button. There is no window between
 * "the question appeared" and "the button that allows has the keyboard".
 *
 * **This function is what the *dialog* focuses, not what libadwaita falls back to.** Those are two
 * different things and they are the same button only when a decline exists: `orderOptions` puts
 * `reject_once` first so the fallback is safe on its own, and the widget calls this function to focus
 * it after `map`. The widget also sets `default_response` explicitly, because leaving it unset is
 * choosing a default by accident.
 *
 * **The narrowest rejecting option's button when the agent sent one** — `reject_once` ahead of
 * `reject_always`, so Enter declines *this* request rather than the rest of the session. That is the
 * answer that fails closed, and it is the same reasoning as `rejectOnce` in `packages/acp/src/gate.ts`,
 * which is the terminal gate's version of this decision.
 *
 * **`null` when there is nothing to reject with**, and the widget then puts the focus on something that
 * does nothing on Enter rather than on an allow button. `null` is the safe answer and it is also the
 * answer that needs a second thought in the widget: there is no button to land on that is not the wrong
 * one, so the focus goes to the readable body instead. It is reached more often than it used to be — an
 * agent offering `allow_once` and `allow_always` and nothing rejecting offers nothing to decline with.
 */
export function initialFocusResponseId(options: readonly PermissionOption[]): string | null {
  // `reject_once` first, then any other rejecting kind. Reading the *kind* rather than the order is the
  // rule; within the rejecting kinds the narrow one wins, so a stray Enter cannot set a session-wide
  // refusal for a request about one file.
  const narrow = options.find((option) => option.kind === 'reject_once');
  if (narrow !== undefined) return narrow.optionId;
  for (const option of options) {
    if (option.kind.startsWith('reject')) return option.optionId;
  }
  return null;
}

/**
 * A decision, named. **There is no `allowed-always` variant and none is needed**: lotse did not
 * decide *how long* the permission lasts — it decided which of the agent's own options a person
 * pressed, and that id carries the duration. Splitting the type per duration would be a second place
 * to keep a distinction the protocol does not make.
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

/** The only option kinds ACP v1 defines. Anything else is a message lotse does not understand. */
const OPTION_KINDS = new Set<PermissionOption['kind']>([
  'allow_once',
  'allow_always',
  'reject_once',
  'reject_always',
]);

/**
 * An option is genuine only if ACP v1 names its kind. **Exported because both surfaces need the same
 * answer**: the dialog renders a projection built here, and the terminal gate reads the raw wire
 * options — and there is exactly one way lotse may decide that a thing an agent asked for is one of
 * the four. A second implementation would be a second door into the same decision, which is the shape
 * of bug this file exists to refuse.
 */
export function isKnownOptionKind(kind: unknown): kind is PermissionOption['kind'] {
  return typeof kind === 'string' && OPTION_KINDS.has(kind as PermissionOption['kind']);
}

/**
 * The narrowing for a surface that reads the raw request rather than a projection — the terminal gate.
 *
 * **Returns the options in lotse's order with the unknown kinds dropped**, so the gate decides over
 * the same set the dialog renders. `permissionView` does this plus the cap and the location filtering,
 * which a terminal line does not need; the shared part is the kind check and the order, and a gate that
 * filtered differently from the window would be two gates.
 */
export function usableOptions(request: RequestPermissionRequest | undefined): PermissionOption[] {
  const usable: PermissionOption[] = [];
  for (const option of arrayOf((request as { options?: unknown } | undefined)?.options)) {
    if (typeof option !== 'object' || option === null) continue;
    const { optionId, name, kind } = option as { optionId?: unknown; name?: unknown; kind?: unknown };
    if (typeof optionId !== 'string' || typeof name !== 'string') continue;
    if (!isKnownOptionKind(kind)) continue;
    usable.push({ optionId, name, kind });
  }
  return orderOptions(usable);
}

/**
 * Project a request into exactly what may be shown.
 *
 * Five things are load-bearing. **Every option the agent sent is shown, and lotse adds none** — no
 * injected "always allow", no synthesised default; a button lotse invented would be a decision
 * nobody offered. **`rawInput` is normalised to `string | null`**, because the widget cannot do that:
 * an agent that omits `rawInput` entirely and an agent that sends `null` mean the same thing here, and
 * both must render as "the agent did not say" rather than as an empty box that looks like an
 * intentionally empty input. **The order is lotse's, and it is the safest reading of the agent's**
 * (`orderOptions`). **Nothing on the wire is trusted to be the shape the schema declares** — the same
 * reason `AcpClient` passes `_meta` through without reading it, and the same reason guardrail 4 exists.
 * A missing or wrong-typed `toolCall` projects to the fallback copy ("unnamed tool", "unknown") and the
 * options still stand, because the question is still a question somebody may answer; an option whose
 * `kind` is missing, wrong-typed, or a word the schema does not define is **dropped**, because
 * `decideFromView` decides by `startsWith('allow')` and an unknown word must not be allowed to mean
 * "allow" by prefix. Nothing here throws: a gate that throws takes the turn down, and one malformed
 * message from one agent would then look like a crash in lotse.
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
    if (typeof optionId !== 'string' || typeof name !== 'string') continue;
    // Exact match against the four kinds ACP v1 defines — **not** `endsWith('_always')`, which was the
    // old filter and is the bug that made `allow_always_forever` disappear, and not a prefix test,
    // which would let `allow_whenever` through to a gate that decides by `startsWith('allow')`. A kind
    // the schema does not name is dropped here, before any surface can render it. The terminal gate
    // makes the same call through `usableOptions`; this is the projection's own copy of it.
    if (!isKnownOptionKind(kind)) continue;
    options.push({ optionId, name, kind });
  }
  return {
    tool: cap(textOf(call?.title, 'unnamed tool'), LIMITS.tool),
    kind: cap(textOf(call?.kind, 'unknown'), LIMITS.kind),
    locations,
    rawInput: rawInputOf(call?.rawInput),
    // Every option the agent sent, in lotse's order. The order is *not* the agent's because the
    // agent's order is not chosen with a person's hand in mind — see `orderOptions`.
    options: orderOptions(options),
  };
}

/**
 * The order the buttons are added in, and it is lotse's rather than the agent's.
 *
 * **Same kind → same rank, so a stable sort keeps the agent's order within a kind.** The agent may
 * repeat a kind (two `allow_once` options for two tools), and neither of them outranks the other.
 *
 * The rank is `reject_once`, `allow_once`, `allow_always`, `reject_always`, and each of the four
 * positions is load-bearing. Three measured facts about libadwaita 1.9.3 decide it
 * (`scripts/probes/alert-dialog-close.mjs`, case 9, with the reversed-order case that makes the
 * direction observable):
 *
 * - **With no `default_response`, the FOCUS goes to the *first* added response** — not the last, which
 *   is what `Adw-1.gir` says and what this repo's comments used to repeat. Added `A B C D`, focus is
 *   on `A`; added `D C B A`, focus is on `D`. So the *first* added response is the one a stray Enter
 *   can reach in the frame before `show()`'s own `grab_focus` runs, and it is a **decline**. That is
 *   why lotse's fallback and lotse's own choice are the same button: the race is harmless in *both*
 *   directions, which is not true of any other order of these four.
 * - **The buttons render bottom-up from the add order**: added `A B C D`, they are laid out
 *   `D C B A` from the top, so the *last* added is the topmost — the one a hand reaches for first. That
 *   is `reject_always`, and a topmost "Always decline" is a fail-closed first press.
 * - **`allow_always` is neither the first allow nor the topmost.** It sits third, behind both the
 *   `*_once` pair, so it is not what a hand or a keypress reaches first in either direction.
 *
 * **The cost is the conventional button slot.** libadwaita's row puts the *last* added response where
 * a primary action usually goes, and here that slot holds a decline. Accepting that is the decision:
 * the alternative — `allow_once` last — needs `allow_always` to be the first allow, which is exactly
 * the thing not to do.
 *
 * **A kind the schema does not name sorts last**, though `permissionView` has already dropped those by
 * the time this runs. The rank is read off the kind with a `?? 4`, and sorting it after the four
 * known kinds keeps a future fifth kind from ever landing in the first position by accident.
 */
const OPTION_ORDER: Record<PermissionOption['kind'], number> = {
  reject_once: 0,
  allow_once: 1,
  allow_always: 2,
  reject_always: 3,
};

/** The agent's options in the order the buttons should be added. See `OPTION_ORDER`. */
export function orderOptions(options: readonly PermissionOption[]): PermissionOption[] {
  return [...options].sort((left, right) => (OPTION_ORDER[left.kind] ?? 4) - (OPTION_ORDER[right.kind] ?? 4));
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
 * The text on a button: **lotse's sentence for the kind, and nothing else.**
 *
 * **The words come from `kind` and the styling comes from `kind` too**, which is what makes the pair
 * impossible to disagree: an agent that names its `allow_once` option "Decline" gets a button that
 * reads "Allow once" and looks like an approval, and the person can see from the shape of the row which
 * one it is.
 *
 * **The agent's name is not on the button, and that is a measurement.** It used to be appended — "Always
 * allow: Always allow in this session" — and a screenshot at 1024 px showed the ellipsis landing in the
 * middle of the agent's half of the sentence, with the same first words twice. At 360 px, which is
 * lotse's own floor (`WINDOW_MIN_WIDTH_PX`), the button was unreadable. A button is the decision; its
 * label has to survive a narrow window in one line. The agent's name still reaches the person — in the
 * body's `agentNames` line, where it can wrap and where repeating "Always allow" costs nothing.
 *
 * **`_` is doubled, because `add_response` parses mnemonics.** GTK reads an underscore in a response
 * label as "the next character is the Alt accelerator", so an agent that named its option
 * `Delete_everything` would be choosing lotse's keyboard shortcut. Doubling the underscore escapes it
 * and prints a literal one. Lotse's own sentences carry no underscore, so this is belt-and-braces
 * against a future wording change — but it stays, and stays tested here, because the widget passes the
 * result through untouched and nothing downstream would catch it.
 */
export function optionLabel(option: PermissionOption): string {
  // A record the kind is not in would fall through to `undefined` and print "undefined". ACP v1 names
  // exactly four kinds and both surfaces filter to them, but this function is exported and a direct
  // caller can hold anything the type allows — so the fallback is lotse's own word, never the
  // agent's name on its own, which is the one thing this function exists to prevent.
  const ours = KIND_WORDS[option.kind] ?? (option.kind.startsWith('allow') ? 'Allow' : 'Decline');
  return escapeMnemonic(ours);
}

/**
 * The agent's own names for its options, as one line for the dialog body — or `null` when there is
 * nothing worth saying.
 *
 * **Why it exists at all:** the button labels are lotse's short sentences (see `optionLabel`), so the
 * agent's wording has to land somewhere or lotse has thrown away information the person was given.
 * **And why it is `null` more often than not:** an agent whose names repeat the kinds — "Allow once",
 * "Decline", which is what most send — adds a line of noise to every question. Only the names that say
 * something the kind does not are listed.
 *
 * **It is a caption and not a heading**, because it is metadata about the buttons, and it renders in
 * the body with `useMarkup: false` like every other piece of agent text in this dialog.
 */
export function agentNames(options: readonly PermissionOption[]): string | null {
  const extra: string[] = [];
  for (const option of options) {
    const theirs = option.name.trim();
    if (theirs.length === 0 || saysTheSame(KIND_WORDS[option.kind] ?? '', theirs)) continue;
    extra.push(`"${cap(theirs, LIMITS.agentName)}"`);
  }
  if (extra.length === 0) return null;
  return `The agent calls these: ${extra.join(', ')}`;
}

/** Whether the agent's name already states what the kind states, so repeating it adds nothing. */
function saysTheSame(ours: string, theirs: string): boolean {
  if (theirs.length === 0) return true;
  const normalise = (text: string): string =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
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
 * The view, not the request — so the only ids that can be answered are the ones the projection carried.
 * An `allow_always` id the agent sent but the view does not carry (a malformed kind, a duplicate
 * dropped as invalid) is a dismissal here, exactly like `close`.
 *
 * **The fail-closed rule is the whole point of this function.** `Adw.AlertDialog` reports its own
 * `close_response` when it is dismissed, and that id is not necessarily one of the agent's — the
 * default is `"close"`, which no agent ever sends (measured:
 * `scripts/probes/alert-dialog-close.mjs` prints `has_response("close") = false`). So "not one of the
 * rendered option ids" is exactly the dismissal case, and the only safe reading of it is
 * `not-answered`. Anything that maps an unknown id to `allowed` is a bug a person finds out about by
 * watching their files change.
 *
 * **It takes a `PermissionView` and not a `RequestPermissionRequest`, and that is the whole reason
 * there is no second entry point here.** There used to be a `decideFromResponse(request, id)` that
 * projected first and called this — and it was exercised by its own test and by nothing else, because
 * every caller in the app already holds a view: `PermissionDesk.ask` projects once and puts the view
 * in the `PermissionQuestion`, and `AgentSession` answers through `desk.answer(id, responseId)`, which
 * reads that same view. A wrapper over the raw request is a second door into the one decision this
 * file says nothing else may make, and a second door is a second opinion: the day its projection and
 * `permissionView`'s drifted, the fail-closed rule would hold on one path and not the other. One
 * function, one input shape, no way to reach it with an unfiltered list.
 */
export function decideFromView(
  view: PermissionView,
  responseId: string | null | undefined,
): PermissionDecision {
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
 * There is no `allowed_once` in ACP v1, and no `allowed_always`: the outcome is `selected` plus **the
 * option id the agent itself offered**, and what that id means — once or always — is the agent's
 * business. That is why lotse can pass an "always" through without promising anything: the response
 * is a *pointer* to the agent's own option, and the agent is the party that remembers it.
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
      // array and may be empty, and the projection may empty it — every option the agent sent can be
      // unusable, if each one names a kind the schema does not define. A dialog with no buttons is a
      // dialog whose only control is Escape, which is this project's "control that points at nothing"
      // rule committed in a different shape. So the answer is the one the schema names for it:
      // `cancelled`, decided here rather than by asking a person to press nothing. (An agent offering
      // *only* `allow_always` is not this case any more — it has offered something pressable, and
      // hiding it was the rule this file no longer has.)
      if (question.view.options.length === 0) {
        resolve({ type: 'not-answered', reason: 'dismissed' });
        return;
      }
      if (this.#open !== null) {
        // Never stack, never answer: queue it. The agent asked twice because it is waiting, and
        // answering the second on the person's behalf would be lotse deciding.
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
