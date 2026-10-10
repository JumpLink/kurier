/**
 * Questions `serve` puts to its person: ids, expiry, and reading an answer without a model.
 *
 * Two kinds, because an agent can be stuck in two ways:
 *
 * - **`permission`** — a `session/request_permission` that neither a token nor a released area
 *   answers. The request is *held* by the `serve` process that received it; the question is how the
 *   person answers it. When that process ends, the request is gone, and a yes to it is dropped
 *   rather than applied to anything else (ADR 0002 §8).
 * - **`reply`** — the turn ended with the agent asking something. Nothing is held; an answer
 *   resumes the session with the person's text (`session/load`, else `session/resume`, else a
 *   follow-up run that carries the context — ADR 0003).
 *
 * Pure over its arguments: the list is a value, the clock a parameter.
 */

export type QuestionKind = 'permission' | 'reply';
export type QuestionStatus = 'open' | 'answered' | 'expired' | 'cancelled';

/** What a yes to a permission question allows: these fields, enforced by the gate, verbatim. */
export interface QuestionAction {
  readonly tool: string;
  readonly kind: string | null;
  /** The digest of the call's arguments the single-use token is bound to. */
  readonly digest: string;
}

export interface Question {
  /** `A1`, `A2`, … per user. Shown as `#A1`. */
  readonly id: string;
  readonly user: string;
  readonly task: string;
  readonly kind: QuestionKind;
  readonly sessionId: string;
  readonly action: QuestionAction | null;
  /** What the person is shown: the call's fields unsummarised, or the agent's own question. */
  readonly text: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly status: QuestionStatus;
  /** `yes`, `no`, or `text` — never the text itself, which went to the session. */
  readonly answer: AnswerKind | null;
  readonly answeredAt: string | null;
  /** What `serve` did, as one sentence. `lotse answer` prints it. */
  readonly resolution: string | null;
}

export type AnswerKind = 'yes' | 'no' | 'text';
export type ParsedAnswer = { kind: 'yes' } | { kind: 'no' } | { kind: 'text'; text: string };

const ID_PREFIX = 'A';

/** `A7` → `#A7`. */
export function formatQuestionId(id: string): string {
  return `#${id}`;
}

/** `#a7`, `A7`, ` a7 ` → `A7`; anything else `null`. */
export function normalizeQuestionId(text: string): string | null {
  const match = /^#?([a-z])(\d{1,6})$/i.exec(text.trim());
  return match ? `${match[1]!.toUpperCase()}${Number(match[2])}` : null;
}

/** The next free id for a user. Ids are never reused while the list still holds the old question. */
export function nextQuestionId(questions: readonly Question[], user: string): string {
  let highest = 0;
  for (const question of questions) {
    if (question.user !== user || !question.id.startsWith(ID_PREFIX)) continue;
    const number = Number(question.id.slice(ID_PREFIX.length));
    if (Number.isInteger(number) && number > highest) highest = number;
  }
  return `${ID_PREFIX}${highest + 1}`;
}

const YES = new Set(['yes', 'y', 'ja', 'j', 'ok', 'okay']);
const NO = new Set(['no', 'n', 'nein']);

/**
 * "Yes" and "no" without a model (ADR 0002 §8). Case and one trailing punctuation mark do not
 * matter; anything longer is text for the session — "yes, but only the first one" is not a yes.
 */
export function parseAnswer(text: string): ParsedAnswer {
  const word = text.trim().toLowerCase().replace(/[.!]$/, '');
  if (YES.has(word)) return { kind: 'yes' };
  if (NO.has(word)) return { kind: 'no' };
  return { kind: 'text', text: text.trim() };
}

/**
 * Whether a turn's final message is a question to the person: its last non-empty line ends with
 * `?`. Deterministic on purpose — deciding with a model would cost a call per run, and a prompt can
 * tell the agent to end with a question when it needs one.
 */
export function isQuestionText(message: string): boolean {
  const lines = message
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines.at(-1)?.endsWith('?') ?? false;
}

export function isOpen(question: Question, now: Date): boolean {
  return question.status === 'open' && Date.parse(question.expiresAt) > now.getTime();
}

export function openQuestions(questions: readonly Question[], now: Date): Question[] {
  return questions.filter((question) => isOpen(question, now));
}

/** How many questions a task created since `since` — the per-hour ceiling's count. */
export function createdSince(questions: readonly Question[], task: string, since: Date): number {
  return questions.filter(
    (question) => question.task === task && Date.parse(question.createdAt) >= since.getTime(),
  ).length;
}

/** The questions with this id, newest first. More than one only when several users share an id. */
export function findQuestions(questions: readonly Question[], id: string, user?: string): Question[] {
  return questions
    .filter((question) => question.id === id && (user === undefined || question.user === user))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Closed questions older than `keepMs` leave the list; open ones always stay. */
export function pruneQuestions(questions: readonly Question[], now: Date, keepMs: number): Question[] {
  return questions.filter(
    (question) => question.status === 'open' || Date.parse(question.createdAt) > now.getTime() - keepMs,
  );
}

/** Read the store's text. A corrupt file is an empty list plus a sentence, never a crash. */
export function parseQuestions(text: string): { questions: Question[]; problem: string | null } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { questions: [], problem: 'the question store is not JSON; starting with no questions' };
  }
  if (!Array.isArray(raw)) return { questions: [], problem: 'the question store is not a list' };
  const questions = raw.filter(isQuestion);
  const dropped = raw.length - questions.length;
  return {
    questions,
    problem: dropped > 0 ? `${dropped} malformed question(s) in the store were ignored` : null,
  };
}

function isQuestion(value: unknown): value is Question {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['id'] === 'string' &&
    typeof record['user'] === 'string' &&
    typeof record['task'] === 'string' &&
    (record['kind'] === 'permission' || record['kind'] === 'reply') &&
    typeof record['sessionId'] === 'string' &&
    typeof record['text'] === 'string' &&
    typeof record['createdAt'] === 'string' &&
    typeof record['expiresAt'] === 'string' &&
    ['open', 'answered', 'expired', 'cancelled'].includes(String(record['status']))
  );
}
