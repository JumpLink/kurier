/**
 * One run of a task, one answer to a question, and the schedule that starts runs — ADR 0003.
 *
 * Everything with a side effect arrives as an argument: the agent (`open`, the same seam
 * `AgentSession` uses), the question store, the channel, the clock and the sleep. The app wires the
 * real ones; a test wires a `FixtureAgent` and an array, and the whole path — prompt, permission
 * question, yes, resume — runs on Node and GJS with no process anywhere.
 *
 * **Two processes share the question store.** `serve` holds a permission request open and polls the
 * store until the question is answered or expires; `lotse answer` is a second process that writes
 * the answer. That is why a waiting run reads the store rather than a variable, and why a permission
 * question whose run is gone is marked `cancelled` — a yes to it then has nothing to allow and is
 * dropped (ADR 0002 §8), instead of being applied to a session it was never about.
 */

import {
  ERROR_CODES,
  RpcError,
  UnsupportedCapabilityError,
  type AcpClient,
  type SessionConfigOption,
  type StopReason,
} from '@lotse/acp';

import type { AgentCommand } from '../agents/stdio.ts';
import { projectConfigOptions } from '../config.ts';
import { chunkToText } from '../policy.ts';
import { runTurn, withAuthHint, type AgentHandle, type OpenAgentOptions } from '../run.ts';
import type { ServeChannel } from './channel.ts';
import { profileOf, type ServeConfig, type ServeProfile, type ServeTask, type ServeUser } from './config.ts';
import { serveGate, type AskOutcome, type GateDecision } from './gate.ts';
import {
  createdSince,
  findQuestions,
  formatQuestionId,
  isQuestionText,
  nextQuestionId,
  normalizeQuestionId,
  openQuestions,
  parseAnswer,
  type Question,
  type QuestionAction,
  type QuestionKind,
} from './questions.ts';
import { nextRun } from './schedule.ts';

/** The question list, wherever it lives. Read fresh on every look: another process writes it too. */
export interface QuestionBook {
  read(): Question[];
  write(questions: Question[]): void;
}

/** One line of the action log. Ids and kinds only — never a prompt, a message or call arguments. */
export interface ServeLogEntry {
  readonly event: 'run' | 'skip' | 'question' | 'answer' | 'gate' | 'expired' | 'dropped' | 'error';
  readonly task: string;
  readonly detail: Readonly<Record<string, string>>;
}

export interface ServeDeps {
  readonly config: ServeConfig;
  readonly open: (options: OpenAgentOptions) => Promise<AgentHandle>;
  /** The agent a profile runs on, resolved by the app at start. */
  readonly commandFor: (profile: ServeProfile) => AgentCommand;
  /** The task's prompt, read by the app at start (and covered by the config hash). */
  readonly promptFor: (task: ServeTask) => string;
  readonly channel: ServeChannel;
  readonly questions: QuestionBook;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  /** How often a waiting permission request looks for an answer. Default 2 s. */
  readonly pollMs?: number;
  /** Take the task's run lock; `null` when another run of it holds it. Absent: no cross-process lock. */
  readonly lock?: (task: string) => (() => void) | null;
  readonly log?: (entry: ServeLogEntry) => void;
  readonly onAgentLog?: (line: string) => void;
}

export type RunOutcome = 'done' | 'asked' | 'declined' | 'skipped' | 'failed';

export interface RunResult {
  readonly task: string;
  readonly outcome: RunOutcome;
  readonly sessionId: string | null;
  readonly stopReason: StopReason | null;
  /** The reply question the run ended with, if it asked one. */
  readonly questionId: string | null;
  /** The agent's final message. Handed to the caller, never written to the run state or the log. */
  readonly reply: string | null;
  /** Why a run was skipped or failed, as a sentence. */
  readonly reason: string | null;
  readonly startedAt: string;
  readonly endedAt: string;
}

/** How `lotse answer` continued a session, or why it did not. */
export type AnswerMode =
  | 'allowed'
  | 'declined'
  | 'loaded'
  | 'resumed'
  | 'follow-up'
  | 'dropped'
  | 'expired'
  | 'unknown'
  | 'busy'
  | 'invalid';

export interface AnswerResult {
  readonly mode: AnswerMode;
  /** One sentence for the person: what happened and why. */
  readonly message: string;
  readonly question: Question | null;
  readonly run: RunResult | null;
}

/** The agent does not offer the model a profile pins. No fallback (ADR 0002 §5). */
export class ModelUnavailableError extends Error {
  constructor(model: string) {
    super(`the agent does not offer the model "${model}" this profile names; there is no fallback`);
    this.name = 'ModelUnavailableError';
  }
}

const DEFAULT_POLL_MS = 2_000;
const HOUR_MS = 3_600_000;

export function userOf(config: ServeConfig, profile: ServeProfile): ServeUser {
  const user = config.users.find((candidate) => candidate.id === profile.user);
  if (!user) throw new Error(`profile "${profile.id}" has no user "${profile.user}"`);
  return user;
}

/** The ceiling that stops a task before any model call, or `null` (ADR 0002 §2). */
export function ceilingReached(task: ServeTask, questions: readonly Question[], now: Date): string | null {
  const open = openQuestions(questions, now).filter((question) => question.task === task.id).length;
  if (open >= task.questions.maxOpen) return `${open} open question(s), the most this task may have`;
  const lastHour = createdSince(questions, task.id, new Date(now.getTime() - HOUR_MS));
  if (lastHour >= task.questions.maxPerHour)
    return `${lastHour} question(s) in the last hour, the most this task may ask`;
  return null;
}

/**
 * Mark every open permission question `cancelled`: the run that held its request is gone. `serve`
 * calls this at start, so a yes after a restart is dropped rather than applied to anything.
 */
export function cancelOrphanedPermissions(deps: Pick<ServeDeps, 'questions' | 'now' | 'log'>): number {
  const book = deps.questions.read();
  let count = 0;
  const next = book.map((question) => {
    if (question.kind !== 'permission' || question.status !== 'open') return question;
    count += 1;
    deps.log?.({ event: 'dropped', task: question.task, detail: { question: question.id, why: 'restart' } });
    return {
      ...question,
      status: 'cancelled' as const,
      resolution: 'serve restarted; the request it would answer is gone',
    };
  });
  if (count > 0) deps.questions.write(next);
  return count;
}

/** One scheduled run of a task: a new session, the task's prompt, one turn. */
export async function runTask(task: ServeTask, deps: ServeDeps): Promise<RunResult> {
  const startedAt = deps.now();
  const reason = ceilingReached(task, deps.questions.read(), startedAt);
  if (reason) {
    deps.log?.({ event: 'skip', task: task.id, detail: { why: 'ceiling' } });
    return result(task, 'skipped', startedAt, deps.now(), { reason });
  }
  const release = deps.lock ? deps.lock(task.id) : () => {};
  if (!release) return busy(task, startedAt, deps);
  try {
    return await runSession(task, deps, startedAt, async (client) => {
      const session = await withAuthHint('session/new', () =>
        client.newSession({ cwd: task.cwd, mcpServers: [...task.mcpServers] }),
      );
      return {
        sessionId: session.sessionId,
        configOptions: session.configOptions ?? null,
        text: deps.promptFor(task),
      };
    });
  } finally {
    release();
  }
}

/**
 * `lotse answer <id> <text>`.
 *
 * A permission question records yes or no in the store, where the run holding the request reads
 * it. A reply question continues the session with the text: `session/load`, else `session/resume`,
 * else a new session that carries the question and the answer as context — and says which.
 */
export async function answerQuestion(idText: string, text: string, deps: ServeDeps): Promise<AnswerResult> {
  const id = normalizeQuestionId(idText);
  const none = (mode: AnswerMode, message: string, question: Question | null = null): AnswerResult => ({
    mode,
    message,
    question,
    run: null,
  });
  if (!id) return none('unknown', `"${idText}" is not a question id like #A1`);
  const found = findQuestions(deps.questions.read(), id);
  const question = found[0];
  if (!question) return none('unknown', `there is no question ${formatQuestionId(id)}`);
  if (new Set(found.map((candidate) => candidate.user)).size > 1) {
    return none('unknown', `${formatQuestionId(id)} exists for several users; this build serves one`);
  }
  const label = formatQuestionId(question.id);
  if (question.status !== 'open') {
    deps.log?.({
      event: 'dropped',
      task: question.task,
      detail: { question: question.id, why: question.status },
    });
    return none(
      'dropped',
      `${label} is ${question.status}${question.resolution ? ` (${question.resolution})` : ''}; nothing waits for this answer`,
      question,
    );
  }
  const now = deps.now();
  if (Date.parse(question.expiresAt) <= now.getTime()) {
    const expired = update(deps, question, { status: 'expired', resolution: 'expired before an answer' });
    deps.log?.({ event: 'expired', task: question.task, detail: { question: question.id } });
    return none('expired', `${label} expired at ${question.expiresAt}; the answer was dropped`, expired);
  }

  const parsed = parseAnswer(text);
  if (question.kind === 'permission') {
    if (parsed.kind === 'text')
      return none('invalid', `${label} asks to allow one action; answer yes or no`, question);
    const answered = update(deps, question, {
      status: 'answered',
      answer: parsed.kind,
      answeredAt: now.toISOString(),
      resolution: parsed.kind === 'yes' ? 'allowed once' : 'declined',
    });
    deps.log?.({
      event: 'answer',
      task: question.task,
      detail: { question: question.id, answer: parsed.kind },
    });
    return {
      mode: parsed.kind === 'yes' ? 'allowed' : 'declined',
      message: `${label} ${parsed.kind === 'yes' ? 'allowed once' : 'declined'}; the waiting run picks it up`,
      question: answered,
      run: null,
    };
  }

  const task = deps.config.tasks.find((candidate) => candidate.id === question.task);
  if (!task) {
    update(deps, question, { status: 'cancelled', resolution: 'its task is no longer configured' });
    return none(
      'dropped',
      `${label} belongs to task "${question.task}", which is no longer configured`,
      question,
    );
  }
  const release = deps.lock ? deps.lock(task.id) : () => {};
  if (!release)
    return none(
      'busy',
      `task "${task.id}" is running right now; answer ${label} again when it is done`,
      question,
    );
  try {
    // Answered before the turn, so a second `lotse answer` cannot continue the same session twice.
    update(deps, question, {
      status: 'answered',
      answer: parsed.kind,
      answeredAt: now.toISOString(),
      resolution: 'continuing the session',
    });
    deps.log?.({ event: 'answer', task: task.id, detail: { question: question.id, answer: parsed.kind } });
    let how: 'loaded' | 'resumed' | 'follow-up' = 'loaded';
    const answerText = parsed.kind === 'text' ? parsed.text : text.trim();
    const run = await runSession(task, deps, now, async (client) => {
      const continued = await continueSession(client, task, question.sessionId);
      if (continued) {
        how = continued.how;
        return { sessionId: question.sessionId, configOptions: continued.configOptions, text: answerText };
      }
      how = 'follow-up';
      const session = await withAuthHint('session/new', () =>
        client.newSession({ cwd: task.cwd, mcpServers: [...task.mcpServers] }),
      );
      return {
        sessionId: session.sessionId,
        configOptions: session.configOptions ?? null,
        text: followUpPrompt(task, question, answerText),
      };
    });
    const said = {
      loaded: 'resumed the session with session/load',
      resumed: 'resumed the session with session/resume',
      'follow-up':
        'the agent can neither load nor resume it, so a follow-up run started with the question as context',
    }[how];
    const message =
      run.outcome === 'failed' ? `${label}: ${said}, but the run failed: ${run.reason}` : `${label}: ${said}`;
    update(deps, question, { resolution: message });
    return {
      mode: how,
      message,
      question: findQuestions(deps.questions.read(), question.id)[0] ?? question,
      run,
    };
  } finally {
    release();
  }
}

/** The tasks due now that are not already running. */
export function dueTasks(
  config: ServeConfig,
  lastRun: (task: string) => Date | null,
  running: ReadonlySet<string>,
  now: Date,
): ServeTask[] {
  return config.tasks.filter(
    (task) =>
      !running.has(task.id) && nextRun(task.schedule, lastRun(task.id), now).getTime() <= now.getTime(),
  );
}

/** How long to sleep before the next look: until the earliest next run, between 1 s and `maxMs`. */
export function nextWakeMs(
  config: ServeConfig,
  lastRun: (task: string) => Date | null,
  now: Date,
  maxMs = 60_000,
): number {
  let earliest = maxMs;
  for (const task of config.tasks) {
    earliest = Math.min(earliest, nextRun(task.schedule, lastRun(task.id), now).getTime() - now.getTime());
  }
  return Math.max(1_000, earliest);
}

// ─── the shared part of a run and an answer ──────────────────────────────────────────────────

interface Started {
  readonly sessionId: string;
  readonly configOptions: SessionConfigOption[] | null;
  readonly text: string;
}

async function runSession(
  task: ServeTask,
  deps: ServeDeps,
  startedAt: Date,
  start: (client: AcpClient) => Promise<Started>,
): Promise<RunResult> {
  const profile = profileOf(deps.config, task);
  const user = userOf(deps.config, profile);
  let handle: AgentHandle | null = null;
  let sessionId: string | null = null;
  let declined = false;
  const gate = serveGate({
    rights: task.rights,
    released: task.released,
    now: () => deps.now().getTime(),
    ask: (request, action, text) => ask(task, user, request.sessionId, action, text, deps),
    onDecision: (decision: GateDecision) => {
      if (decision.answer === 'decline') declined = true;
      deps.log?.({
        event: 'gate',
        task: task.id,
        detail: {
          session: decision.sessionId,
          tool: decision.tool,
          digest: decision.digest.slice(0, 16),
          answer: decision.answer,
          why: decision.why,
        },
      });
    },
  });
  deps.log?.({ event: 'run', task: task.id, detail: { phase: 'start' } });
  try {
    handle = await deps.open({
      command: deps.commandFor(profile),
      gate: { permission: gate },
      ...(deps.onAgentLog ? { onLog: deps.onAgentLog } : {}),
    });
    const agent = handle;
    const started = await start(agent.client);
    sessionId = started.sessionId;
    await pinModel(agent.client, started.sessionId, started.configOptions, profile);

    let message = '';
    const { stopReason } = await runTurn(agent.client, {
      sessionId: started.sessionId,
      text: started.text,
      onUpdate: (notification) => {
        if (notification.update.sessionUpdate === 'agent_message_chunk')
          message += chunkToText(notification.update.content);
      },
    });

    let questionId: string | null = null;
    if (stopReason === 'end_turn' && isQuestionText(message)) {
      questionId = createReplyQuestion(task, user, started.sessionId, message.trim(), deps);
    } else if (stopReason === 'end_turn' && task.notify === 'always' && message.trim()) {
      await deps.channel.send(user, { title: `lotse · ${task.id}`, body: message.trim(), questionId: null });
    }
    // An agent that hears "no" often still ends its turn normally; the run was declined all the same.
    const outcome: RunOutcome = questionId
      ? 'asked'
      : stopReason === 'end_turn' && !declined
        ? 'done'
        : 'declined';
    deps.log?.({
      event: 'run',
      task: task.id,
      detail: { phase: 'end', session: started.sessionId, stopReason, outcome },
    });
    return result(task, outcome, startedAt, deps.now(), {
      sessionId,
      stopReason,
      questionId,
      reply: message.trim() || null,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    deps.log?.({
      event: 'error',
      task: task.id,
      detail: { kind: error instanceof Error ? error.name : 'Error' },
    });
    if (error instanceof ModelUnavailableError) {
      await deps.channel.send(user, { title: `lotse · ${task.id} stopped`, body: reason, questionId: null });
    }
    return result(task, 'failed', startedAt, deps.now(), { sessionId, reason });
  } finally {
    if (sessionId) cancelHeldQuestions(deps, sessionId);
    await handle?.close();
  }
}

/** `session/load`, else `session/resume`; `null` when the agent offers neither. */
async function continueSession(
  client: AcpClient,
  task: ServeTask,
  sessionId: string,
): Promise<{ how: 'loaded' | 'resumed'; configOptions: SessionConfigOption[] | null } | null> {
  const params = { cwd: task.cwd, mcpServers: [...task.mcpServers] };
  if (client.supportsLoadSession) {
    try {
      const loaded = await withAuthHint('session/load', () => client.loadSession({ sessionId, ...params }));
      return { how: 'loaded', configOptions: loaded.configOptions ?? null };
    } catch (error) {
      if (!isUnsupported(error)) throw error;
    }
  }
  if (client.supportsResumeSession) {
    try {
      const resumed = await withAuthHint('session/resume', () =>
        client.resumeSession({ sessionId, ...params }),
      );
      return { how: 'resumed', configOptions: resumed.configOptions ?? null };
    } catch (error) {
      if (!isUnsupported(error)) throw error;
    }
  }
  return null;
}

function isUnsupported(error: unknown): boolean {
  return (
    error instanceof UnsupportedCapabilityError ||
    (error instanceof RpcError && error.code === ERROR_CODES.METHOD_NOT_FOUND)
  );
}

/** The context a fresh session needs to make sense of an answer it never saw the question for. */
export function followUpPrompt(task: ServeTask, question: Question, answer: string): string {
  return [
    `This continues an earlier run of the task "${task.id}". That session cannot be reopened.`,
    '',
    'You asked:',
    question.text,
    '',
    'The person answered:',
    answer,
  ].join('\n');
}

async function pinModel(
  client: AcpClient,
  sessionId: string,
  options: SessionConfigOption[] | null,
  profile: ServeProfile,
): Promise<void> {
  if (!profile.model) return;
  const control = projectConfigOptions(options).find((candidate) => candidate.category === 'model');
  if (
    !control ||
    control.kind !== 'select' ||
    !control.values.some((value) => value.value === profile.model)
  ) {
    throw new ModelUnavailableError(profile.model);
  }
  if (control.currentValue !== profile.model) {
    await client.setConfigOption({ sessionId, configId: control.id, value: profile.model });
  }
}

// ─── questions ───────────────────────────────────────────────────────────────────────────────

function newQuestion(
  book: readonly Question[],
  task: ServeTask,
  user: ServeUser,
  kind: QuestionKind,
  sessionId: string,
  action: QuestionAction | null,
  text: string,
  now: Date,
): Question {
  return {
    id: nextQuestionId(book, user.id),
    user: user.id,
    task: task.id,
    kind,
    sessionId,
    action,
    text,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + task.questions.expiresMs).toISOString(),
    status: 'open',
    answer: null,
    answeredAt: null,
    resolution: null,
  };
}

function howToAnswer(question: Question): string {
  const id = question.id;
  return question.kind === 'permission'
    ? `Answer: lotse answer ${id} yes|no — expires ${question.expiresAt}`
    : `Answer: lotse answer ${id} <text> — expires ${question.expiresAt}`;
}

async function notify(question: Question, user: ServeUser, deps: ServeDeps): Promise<void> {
  try {
    await deps.channel.send(user, {
      title: `lotse · ${question.task} · ${formatQuestionId(question.id)}`,
      body: `${question.text}\n\n${howToAnswer(question)}`,
      questionId: question.id,
    });
  } catch (error) {
    // The question is in the store and `lotse questions` lists it; a channel that failed is logged.
    deps.log?.({
      event: 'error',
      task: question.task,
      detail: { channel: deps.channel.name, kind: error instanceof Error ? error.name : 'Error' },
    });
  }
}

function createReplyQuestion(
  task: ServeTask,
  user: ServeUser,
  sessionId: string,
  text: string,
  deps: ServeDeps,
): string | null {
  const now = deps.now();
  const book = deps.questions.read();
  if (ceilingReached(task, book, now)) {
    deps.log?.({ event: 'skip', task: task.id, detail: { why: 'ceiling', session: sessionId } });
    return null;
  }
  const question = newQuestion(book, task, user, 'reply', sessionId, null, text, now);
  deps.questions.write([...book, question]);
  deps.log?.({
    event: 'question',
    task: task.id,
    detail: { question: question.id, kind: 'reply', session: sessionId },
  });
  void notify(question, user, deps);
  return question.id;
}

async function ask(
  task: ServeTask,
  user: ServeUser,
  sessionId: string,
  action: QuestionAction,
  text: string,
  deps: ServeDeps,
): Promise<AskOutcome> {
  const book = deps.questions.read();
  if (ceilingReached(task, book, deps.now())) {
    deps.log?.({ event: 'skip', task: task.id, detail: { why: 'ceiling', session: sessionId } });
    return 'refused';
  }
  const question = newQuestion(book, task, user, 'permission', sessionId, action, text, deps.now());
  deps.questions.write([...book, question]);
  deps.log?.({
    event: 'question',
    task: task.id,
    detail: { question: question.id, kind: 'permission', session: sessionId },
  });
  await notify(question, user, deps);

  for (;;) {
    const current = findQuestions(deps.questions.read(), question.id, user.id)[0];
    if (!current || current.status === 'cancelled' || current.status === 'expired') return 'expired';
    if (current.status === 'answered') return current.answer === 'yes' ? 'yes' : 'no';
    if (Date.parse(current.expiresAt) <= deps.now().getTime()) {
      update(deps, current, {
        status: 'expired',
        resolution: 'expired before an answer; the request was cancelled',
      });
      deps.log?.({ event: 'expired', task: task.id, detail: { question: current.id } });
      await deps.channel.send(user, {
        title: `lotse · ${task.id} · ${formatQuestionId(current.id)} expired`,
        body: 'Nobody answered in time, so the request was cancelled.',
        questionId: current.id,
      });
      return 'expired';
    }
    await deps.sleep(deps.pollMs ?? DEFAULT_POLL_MS);
  }
}

/** The run is over: a permission question still open for its session has nothing left to answer. */
function cancelHeldQuestions(deps: ServeDeps, sessionId: string): void {
  const book = deps.questions.read();
  let changed = false;
  const next = book.map((question) => {
    if (question.kind !== 'permission' || question.status !== 'open' || question.sessionId !== sessionId)
      return question;
    changed = true;
    return { ...question, status: 'cancelled' as const, resolution: 'the run ended before an answer' };
  });
  if (changed) deps.questions.write(next);
}

function update(deps: Pick<ServeDeps, 'questions'>, question: Question, patch: Partial<Question>): Question {
  let updated = question;
  deps.questions.write(
    deps.questions.read().map((candidate) => {
      if (candidate.id !== question.id || candidate.user !== question.user) return candidate;
      updated = { ...candidate, ...patch };
      return updated;
    }),
  );
  return updated;
}

function busy(task: ServeTask, startedAt: Date, deps: ServeDeps): RunResult {
  deps.log?.({ event: 'skip', task: task.id, detail: { why: 'running' } });
  return result(task, 'skipped', startedAt, deps.now(), {
    reason: 'another run of this task is still in progress',
  });
}

function result(
  task: ServeTask,
  outcome: RunOutcome,
  startedAt: Date,
  endedAt: Date,
  rest: {
    sessionId?: string | null;
    stopReason?: StopReason | null;
    questionId?: string | null;
    reply?: string | null;
    reason?: string | null;
  },
): RunResult {
  return {
    task: task.id,
    outcome,
    sessionId: rest.sessionId ?? null,
    stopReason: rest.stopReason ?? null,
    questionId: rest.questionId ?? null,
    reply: rest.reply ?? null,
    reason: rest.reason ?? null,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
  };
}
