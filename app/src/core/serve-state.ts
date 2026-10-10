/**
 * The files `lotse serve` keeps under its state directory (ADR 0003 §7): the question store, the run
 * state, the action log and one lock per task.
 *
 * **Two processes write here.** `serve` and `lotse answer` both read the question store fresh and
 * write it whole; `writePrivateFile` renames atomically, so a reader sees the old list or the new one,
 * never half of one. The per-task lock keeps a run and an answer from driving the same task at once.
 *
 * Nothing here holds a prompt, an agent's message or call arguments: the questions hold what the
 * person was shown, the run state holds ids and outcomes, the log holds ids and kinds.
 */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  parseQuestions,
  pruneQuestions,
  type Question,
  type QuestionBook,
  type RunResult,
  type ServeLogEntry,
} from '@lotse/core';

import { writePrivateFile } from './private-file.ts';

/** Closed questions stay this long, so `lotse questions --all` can still say what happened. */
export const KEEP_CLOSED_MS = 7 * 86_400_000;

function ensureDir(dir: string): void {
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** The question store, `questions.json`. A corrupt file is reported once and read as empty. */
export function questionBook(
  stateDir: string,
  now: () => Date,
  onProblem?: (problem: string) => void,
): QuestionBook {
  const file = join(stateDir, 'questions.json');
  return {
    read: () => {
      if (!existsSync(file)) return [];
      const { questions, problem } = parseQuestions(readFileSync(file, 'utf8'));
      if (problem) onProblem?.(problem);
      return questions;
    },
    write: (questions: Question[]) => {
      const kept = pruneQuestions(questions, now(), KEEP_CLOSED_MS);
      writePrivateFile(file, `${JSON.stringify(kept, null, 2)}\n`, 'questions');
    },
  };
}

/** What `runs.json` keeps per task: when, how it ended, which session. No message text. */
export interface RunRecord {
  readonly startedAt: string;
  readonly endedAt: string;
  readonly outcome: RunResult['outcome'];
  readonly sessionId: string | null;
  readonly stopReason: string | null;
  readonly questionId: string | null;
  readonly reason: string | null;
}

export interface RunState {
  lastRun(task: string): Date | null;
  record(result: RunResult): void;
  all(): Readonly<Record<string, RunRecord>>;
}

export function runState(stateDir: string): RunState {
  const file = join(stateDir, 'runs.json');
  const read = (): Record<string, RunRecord> => {
    if (!existsSync(file)) return {};
    try {
      const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
      return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, RunRecord>)
        : {};
    } catch {
      return {};
    }
  };
  return {
    lastRun: (task) => {
      const at = read()[task]?.startedAt;
      const ms = at ? Date.parse(at) : Number.NaN;
      return Number.isNaN(ms) ? null : new Date(ms);
    },
    record: (result) => {
      const runs = read();
      runs[result.task] = {
        startedAt: result.startedAt,
        endedAt: result.endedAt,
        outcome: result.outcome,
        sessionId: result.sessionId,
        stopReason: result.stopReason,
        questionId: result.questionId,
        reason: result.reason,
      };
      writePrivateFile(file, `${JSON.stringify(runs, null, 2)}\n`, 'runs');
    },
    all: read,
  };
}

/** The action log, `serve.log`: one JSON line per entry, with a timestamp. */
export function actionLog(stateDir: string, now: () => Date): (entry: ServeLogEntry) => void {
  const file = join(stateDir, 'serve.log');
  return (entry) => {
    ensureDir(stateDir);
    const fresh = !existsSync(file);
    appendFileSync(file, `${JSON.stringify({ at: now().toISOString(), ...entry })}\n`, { mode: 0o600 });
    if (fresh) chmodSync(file, 0o600);
  };
}

function alive(pid: number): boolean {
  if (existsSync('/proc/self')) return existsSync(`/proc/${pid}`);
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * `locks/<task>.lock`, created exclusively with the holder's pid. A lock whose process is gone is
 * stale and taken over; a live one means `null` — the task is running elsewhere.
 */
export function taskLock(stateDir: string): (task: string) => (() => void) | null {
  const dir = join(stateDir, 'locks');
  return (task) => {
    ensureDir(stateDir);
    ensureDir(dir);
    const file = join(dir, `${task}.lock`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(file, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
        return () => rmSync(file, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const pid = Number.parseInt(readFileSync(file, 'utf8'), 10);
        if (Number.isInteger(pid) && pid > 0 && alive(pid)) return null;
        rmSync(file, { force: true });
      }
    }
    return null;
  };
}
