/**
 * The gate `lotse serve` answers `session/request_permission` with — ADR 0002 §7.
 *
 * It answers from the person's decisions only: an area the task configuration released, or a
 * question the person answered yes. Everything else is a new question, or a decline. Three rules
 * hold on every path:
 *
 * - **Every `*_always` option is stripped** before anything is decided, and never selected. Nobody
 *   reads the option over a notification, so one yes must not leave a standing permission behind.
 * - **A yes mints one single-use token**, bound to the session id, the tool and a digest of the exact
 *   call. The first call that matches all three consumes it; a second call of the same shape asks
 *   again.
 * - **A question that nobody answers expires to a decline.** Waiting forever would hold the session
 *   forever.
 *
 * The decline is the agent's own `reject_once` when it offered one, else `null` (`cancelled`), so the
 * turn ends the way the protocol expects — the same `rejectOnce` the CLI's `--deny-all` uses.
 */

import { createHash } from 'node:crypto';

import { rejectOnce, type PermissionGate } from '@lotse/acp';
import type { PermissionOption, RequestPermissionRequest } from '@lotse/acp';

import type { ReleasedArea, RightsLevel } from './config.ts';
import type { QuestionAction } from './questions.ts';

/** A yes the person gave, waiting for the one call it allows. */
export interface ServeToken {
  readonly sessionId: string;
  readonly tool: string;
  readonly digest: string;
  readonly expiresAt: number;
}

/** What the gate asks the runner when neither a token nor a released area answers. */
export type AskOutcome = 'yes' | 'no' | 'expired' | 'refused';

export interface ServeGateOptions {
  readonly rights: RightsLevel;
  readonly released: readonly ReleasedArea[];
  /**
   * Put the call to the person and wait for the answer. `refused` means no question was created —
   * a ceiling was reached — and is a decline like the others.
   */
  readonly ask: (
    request: RequestPermissionRequest,
    action: QuestionAction,
    text: string,
  ) => Promise<AskOutcome>;
  readonly now: () => number;
  /** Every decision, one line, for the action log. No arguments, only the tool and the digest. */
  readonly onDecision?: (decision: GateDecision) => void;
}

export interface GateDecision {
  readonly sessionId: string;
  readonly tool: string;
  readonly digest: string;
  readonly answer: 'allow_once' | 'decline';
  readonly why: 'released' | 'token' | 'yes' | 'no' | 'expired' | 'refused' | 'read-only' | 'no-allow-once';
}

/** The options `serve` may choose from: the agent's list without any `*_always`. */
export function stripAlways(options: readonly PermissionOption[]): PermissionOption[] {
  return options.filter((option) => option.kind === 'allow_once' || option.kind === 'reject_once');
}

/** The tool name the gate matches on: the title the agent gave the call, else its id. */
export function toolOf(request: RequestPermissionRequest): string {
  return request.toolCall.title?.trim() || request.toolCall.toolCallId;
}

/**
 * A digest of what the call would do: tool, kind, raw input, content and locations — the fields a
 * question shows. Keys are sorted, so the same call digests the same however the agent ordered them.
 * The tool call id is left out on purpose: it names the attempt, not the action.
 */
export function callDigest(request: RequestPermissionRequest): string {
  const call = request.toolCall;
  const shape = {
    tool: toolOf(request),
    kind: call.kind ?? null,
    rawInput: call.rawInput ?? null,
    content: call.content ?? null,
    locations: call.locations ?? null,
  };
  return createHash('sha256').update(stableJson(shape)).digest('hex');
}

/**
 * The question text: the fields the gate enforces, verbatim and unsummarised (ADR 0002 §8). The raw
 * input is printed as JSON, not paraphrased — a model's précis of a call is not what a yes allows.
 */
export function describeCall(request: RequestPermissionRequest): string {
  const call = request.toolCall;
  const lines = [`Allow once: ${toolOf(request)}`];
  if (call.kind) lines.push(`kind: ${call.kind}`);
  for (const location of call.locations ?? []) {
    lines.push(`at: ${location.path}${location.line ? `:${location.line}` : ''}`);
  }
  if (call.rawInput !== undefined && call.rawInput !== null)
    lines.push(`input: ${stableJson(call.rawInput)}`);
  return lines.join('\n');
}

export function actionOf(request: RequestPermissionRequest): QuestionAction {
  return { tool: toolOf(request), kind: request.toolCall.kind ?? null, digest: callDigest(request) };
}

/** Released when the tool matches exactly, and the kind too when the area names one. */
export function isReleased(released: readonly ReleasedArea[], request: RequestPermissionRequest): boolean {
  const tool = toolOf(request);
  const kind = request.toolCall.kind ?? null;
  return released.some((area) => area.tool === tool && (area.kind === null || area.kind === kind));
}

/**
 * Build the gate for one run. The tokens live in this closure and nowhere else: they die with the
 * run, which is the strongest form of "never in a session record" there is.
 */
export function serveGate(options: ServeGateOptions): PermissionGate & { readonly tokens: ServeToken[] } {
  const tokens: ServeToken[] = [];

  const decide = (
    request: RequestPermissionRequest,
    action: QuestionAction,
    allow: PermissionOption | undefined,
    answer: GateDecision['answer'],
    why: GateDecision['why'],
  ): string | null => {
    options.onDecision?.({
      sessionId: request.sessionId,
      tool: action.tool,
      digest: action.digest,
      answer,
      why,
    });
    if (answer === 'allow_once' && allow) return allow.optionId;
    // An expired question was never answered, so it is `cancelled`, not the person's "no".
    if (why === 'expired') return null;
    return rejectOnce({ ...request, options: stripAlways(request.options) });
  };

  const consume = (request: RequestPermissionRequest, action: QuestionAction): boolean => {
    const at = options.now();
    const index = tokens.findIndex(
      (token) =>
        token.sessionId === request.sessionId &&
        token.tool === action.tool &&
        token.digest === action.digest &&
        token.expiresAt > at,
    );
    if (index < 0) return false;
    tokens.splice(index, 1);
    return true;
  };

  const gate = async (request: RequestPermissionRequest): Promise<string | null> => {
    const action = actionOf(request);
    const allow = stripAlways(request.options).find((option) => option.kind === 'allow_once');
    if (!allow) return decide(request, action, allow, 'decline', 'no-allow-once');
    if (options.rights === 'read') return decide(request, action, allow, 'decline', 'read-only');
    if (options.rights === 'released' && isReleased(options.released, request)) {
      return decide(request, action, allow, 'allow_once', 'released');
    }
    if (consume(request, action)) return decide(request, action, allow, 'allow_once', 'token');

    const outcome = await options.ask(request, action, describeCall(request));
    if (outcome !== 'yes') return decide(request, action, allow, 'decline', outcome);
    // Minted and consumed by the call it answers: the yes allows exactly this one.
    tokens.push({
      sessionId: request.sessionId,
      tool: action.tool,
      digest: action.digest,
      expiresAt: options.now() + 60_000,
    });
    consume(request, action);
    return decide(request, action, allow, 'allow_once', 'yes');
  };

  return Object.assign(gate, { tokens });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
