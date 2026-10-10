/**
 * The task configuration `lotse serve` runs from — users, profiles, tasks — and its validation.
 *
 * **Configuration, not code** (ADR 0002 §3). lotse knows no task, no person and no address; all of
 * that arrives here as JSON from a private file outside the repository. This module only says whether
 * the file is well-formed and what it means, and it says it at start: a private profile on a free
 * model, a task naming a profile nobody defined, a released area under a read-only task — each is a
 * sentence before the first run, not a surprise at 3 a.m.
 *
 * **Read once, hashed.** `configHash` covers the file and every prompt file it names. `serve` keeps
 * the hash and stops when it changes, so an edit — by the person or by a session that should not have
 * been able to make it — takes effect on a restart the person performs (ADR 0002 §3, §6).
 */

import { createHash } from 'node:crypto';

import type { McpServer } from '@lotse/acp';

import { FREE_MODEL_IDS } from '../free-models.ts';
import { parseDuration, parseSchedule, type Schedule } from './schedule.ts';

/** A person `serve` works for. `addresses` are channel addresses; the desktop channel needs none. */
export interface ServeUser {
  readonly id: string;
  readonly addresses: readonly string[];
}

/**
 * Who a task runs as and on what. `data: "private"` pins the model: it must be named, it must not be a
 * free model, and there is no fallback when it is unavailable (ADR 0002 §5).
 */
export interface ServeProfile {
  readonly id: string;
  readonly user: string;
  /** A launcher id (`opencode`). Absent: the same resolution `lotse start` uses. */
  readonly agent: string | null;
  /** A value of the agent's `model` config option. Required for a private profile. */
  readonly model: string | null;
  readonly data: 'private' | 'public';
}

/**
 * The three rights levels (ADR 0002 §6). `read` declines every permission request without asking,
 * `confirm` asks for each, `released` allows the listed areas once per call and asks for the rest.
 */
export type RightsLevel = 'read' | 'confirm' | 'released';

/**
 * An area the person released without questions: a tool, matched by the exact title the agent gives
 * the call, optionally narrowed by its kind. The person's decision, recorded here and nowhere else.
 */
export interface ReleasedArea {
  readonly tool: string;
  readonly kind: string | null;
}

export interface QuestionLimits {
  /** How long a question stays open before it is answered `cancelled`. */
  readonly expiresMs: number;
  /** More open questions than this and the task is skipped without a model call. */
  readonly maxOpen: number;
  /** More questions created in the last hour than this and the task is skipped. */
  readonly maxPerHour: number;
}

export interface ServeTask {
  readonly id: string;
  readonly profile: string;
  readonly schedule: Schedule;
  /** Exactly one of the two. A prompt file is resolved by the app, relative to the config file. */
  readonly prompt: string | null;
  readonly promptFile: string | null;
  readonly cwd: string;
  /** Passed to `session/new` as is — MCP is passed through, not known. */
  readonly mcpServers: readonly McpServer[];
  readonly rights: RightsLevel;
  readonly released: readonly ReleasedArea[];
  readonly questions: QuestionLimits;
  /** `questions`: notify only when the agent asks. `always`: also send the run's answer. */
  readonly notify: 'questions' | 'always';
}

export interface ServeConfig {
  readonly users: readonly ServeUser[];
  readonly profiles: readonly ServeProfile[];
  readonly tasks: readonly ServeTask[];
}

export const DEFAULT_QUESTION_LIMITS: QuestionLimits = {
  expiresMs: 12 * 3_600_000,
  maxOpen: 3,
  maxPerHour: 6,
};

/** Every problem in the file at once, so one edit fixes all of them. */
export class ServeConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: string[]) {
    super(`the task configuration has ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`);
    this.name = 'ServeConfigError';
    this.problems = problems;
  }
}

const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/**
 * A model id that must not see private data: the maintained free list, and anything named `-free`.
 * A merely-free model may be trained on, and that is not lotse's decision to make for a person.
 */
export function isFreeModel(model: string): boolean {
  return FREE_MODEL_IDS.includes(model) || /-free$/.test(model);
}

/** Parse and validate. Throws `ServeConfigError` listing every problem. */
export function parseServeConfig(text: string): ServeConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ServeConfigError([`not JSON: ${error instanceof Error ? error.message : String(error)}`]);
  }
  const problems: string[] = [];
  if (!isRecord(raw)) throw new ServeConfigError(['the top level must be an object']);
  if (raw['version'] !== 1) problems.push('"version" must be 1');
  for (const key of Object.keys(raw)) {
    if (!['version', 'users', 'profiles', 'tasks'].includes(key)) problems.push(`unknown key "${key}"`);
  }

  const users = list(raw['users'], 'users', problems).map((value, index) =>
    parseUser(value, `users[${index}]`, problems),
  );
  const profiles = list(raw['profiles'], 'profiles', problems).map((value, index) =>
    parseProfile(value, `profiles[${index}]`, problems),
  );
  const tasks = list(raw['tasks'], 'tasks', problems).map((value, index) =>
    parseTask(value, `tasks[${index}]`, problems),
  );

  duplicates(users, 'user', problems);
  duplicates(profiles, 'profile', problems);
  duplicates(tasks, 'task', problems);
  for (const profile of profiles) {
    if (profile.id && !users.some((user) => user.id === profile.user)) {
      problems.push(`profile "${profile.id}" names user "${profile.user}", which is not defined`);
    }
  }
  for (const task of tasks) {
    if (task.id && !profiles.some((profile) => profile.id === task.profile)) {
      problems.push(`task "${task.id}" names profile "${task.profile}", which is not defined`);
    }
  }

  if (problems.length > 0) throw new ServeConfigError(problems);
  return { users, profiles, tasks };
}

/** The hash `serve` keeps: the file and every prompt file, in order, each length-prefixed. */
export function configHash(texts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const text of texts) hash.update(`${text.length}:${text}\n`);
  return hash.digest('hex');
}

export function profileOf(config: ServeConfig, task: ServeTask): ServeProfile {
  const profile = config.profiles.find((candidate) => candidate.id === task.profile);
  if (!profile) throw new Error(`task "${task.id}" has no profile "${task.profile}"`);
  return profile;
}

function parseUser(value: unknown, where: string, problems: string[]): ServeUser {
  const record = object(value, where, problems, ['id', 'addresses']);
  const addresses = record['addresses'] === undefined ? [] : record['addresses'];
  const valid = Array.isArray(addresses) && addresses.every((address) => typeof address === 'string');
  if (!valid) problems.push(`${where}.addresses must be a list of strings`);
  return { id: id(record['id'], where, problems), addresses: valid ? (addresses as string[]) : [] };
}

function parseProfile(value: unknown, where: string, problems: string[]): ServeProfile {
  const record = object(value, where, problems, ['id', 'user', 'agent', 'model', 'data']);
  const profileId = id(record['id'], where, problems);
  const agent = optionalString(record['agent'], `${where}.agent`, problems);
  const model = optionalString(record['model'], `${where}.model`, problems);
  const data = record['data'];
  if (data !== 'private' && data !== 'public') {
    problems.push(`${where}.data must be "private" or "public" — say which, there is no default`);
  }
  if (data === 'private') {
    if (!model) problems.push(`profile "${profileId}" is private and must name its model`);
    else if (isFreeModel(model)) {
      problems.push(`profile "${profileId}" is private and names the free model "${model}"`);
    }
  }
  return {
    id: profileId,
    user: typeof record['user'] === 'string' ? record['user'] : '',
    agent,
    model,
    data: data === 'public' ? 'public' : 'private',
  };
}

const TASK_KEYS = [
  'id',
  'profile',
  'schedule',
  'prompt',
  'promptFile',
  'cwd',
  'mcpServers',
  'rights',
  'released',
  'questions',
  'notify',
];

function parseTask(value: unknown, where: string, problems: string[]): ServeTask {
  const record = object(value, where, problems, TASK_KEYS);
  const taskId = id(record['id'], where, problems);
  const label = taskId ? `task "${taskId}"` : where;

  let schedule: Schedule = { kind: 'every', ms: 3_600_000, spec: 'every 1h' };
  try {
    schedule = parseSchedule(record['schedule']);
  } catch (error) {
    problems.push(`${label}.schedule ${error instanceof Error ? error.message : String(error)}`);
  }

  const prompt = optionalString(record['prompt'], `${label}.prompt`, problems);
  const promptFile = optionalString(record['promptFile'], `${label}.promptFile`, problems);
  if ((prompt === null) === (promptFile === null)) {
    problems.push(`${label} needs exactly one of "prompt" and "promptFile"`);
  }

  const cwd = record['cwd'];
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) problems.push(`${label}.cwd must be an absolute path`);

  const mcpServers = record['mcpServers'] === undefined ? [] : record['mcpServers'];
  const serversValid =
    Array.isArray(mcpServers) &&
    mcpServers.every((server) => isRecord(server) && typeof server['name'] === 'string');
  if (!serversValid) problems.push(`${label}.mcpServers must be a list of MCP servers, each with a "name"`);

  const rights = record['rights'] ?? 'confirm';
  if (rights !== 'read' && rights !== 'confirm' && rights !== 'released') {
    problems.push(`${label}.rights must be "read", "confirm" or "released"`);
  }
  const released = parseReleased(record['released'], label, problems);
  if (rights === 'released' && released.length === 0) {
    problems.push(`${label} has rights "released" but releases nothing`);
  }
  if (rights !== 'released' && released.length > 0) {
    problems.push(`${label} lists "released" areas but its rights are "${String(rights)}"`);
  }

  const notify = record['notify'] ?? 'questions';
  if (notify !== 'questions' && notify !== 'always') {
    problems.push(`${label}.notify must be "questions" or "always"`);
  }

  return {
    id: taskId,
    profile: typeof record['profile'] === 'string' ? record['profile'] : '',
    schedule,
    prompt,
    promptFile,
    cwd: typeof cwd === 'string' ? cwd : '',
    mcpServers: serversValid ? (mcpServers as McpServer[]) : [],
    rights: rights === 'read' || rights === 'released' ? rights : 'confirm',
    released,
    questions: parseLimits(record['questions'], label, problems),
    notify: notify === 'always' ? 'always' : 'questions',
  };
}

function parseReleased(value: unknown, label: string, problems: string[]): ReleasedArea[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push(`${label}.released must be a list`);
    return [];
  }
  return value.flatMap((entry, index) => {
    const where = `${label}.released[${index}]`;
    const record = object(entry, where, problems, ['tool', 'kind']);
    if (typeof record['tool'] !== 'string' || record['tool'].trim() === '') {
      problems.push(`${where}.tool must name the tool`);
      return [];
    }
    return [{ tool: record['tool'], kind: optionalString(record['kind'], `${where}.kind`, problems) }];
  });
}

function parseLimits(value: unknown, label: string, problems: string[]): QuestionLimits {
  if (value === undefined) return DEFAULT_QUESTION_LIMITS;
  const where = `${label}.questions`;
  const record = object(value, where, problems, ['expiresIn', 'maxOpen', 'maxPerHour']);
  let expiresMs = DEFAULT_QUESTION_LIMITS.expiresMs;
  if (record['expiresIn'] !== undefined) {
    const parsed = typeof record['expiresIn'] === 'string' ? parseDuration(record['expiresIn']) : null;
    if (parsed === null) problems.push(`${where}.expiresIn must be a duration like 30m, 12h or 2d`);
    else expiresMs = parsed;
  }
  return {
    expiresMs,
    maxOpen: count(record['maxOpen'], `${where}.maxOpen`, DEFAULT_QUESTION_LIMITS.maxOpen, problems),
    maxPerHour: count(
      record['maxPerHour'],
      `${where}.maxPerHour`,
      DEFAULT_QUESTION_LIMITS.maxPerHour,
      problems,
    ),
  };
}

function count(value: unknown, where: string, fallback: number, problems: string[]): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    problems.push(`${where} must be a whole number of at least 1`);
    return fallback;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function object(value: unknown, where: string, problems: string[], keys: string[]): Record<string, unknown> {
  if (!isRecord(value)) {
    problems.push(`${where} must be an object`);
    return {};
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) problems.push(`${where} has unknown key "${key}"`);
  }
  return value;
}

function list(value: unknown, where: string, problems: string[]): unknown[] {
  if (!Array.isArray(value)) {
    problems.push(`"${where}" must be a list`);
    return [];
  }
  return value;
}

function id(value: unknown, where: string, problems: string[]): string {
  if (typeof value !== 'string' || !ID.test(value)) {
    problems.push(`${where}.id must be lowercase letters, digits, "-" or "_" (at most 40)`);
    return '';
  }
  return value;
}

function optionalString(value: unknown, where: string, problems: string[]): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    problems.push(`${where} must be a non-empty string`);
    return null;
  }
  return value;
}

function duplicates(items: readonly { id: string }[], what: string, problems: string[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.id) continue;
    if (seen.has(item.id)) problems.push(`${what} "${item.id}" is defined twice`);
    seen.add(item.id);
  }
}
