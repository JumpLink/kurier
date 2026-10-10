import { describe, expect, it } from '@gjsify/unit';

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Question, RunResult } from '@lotse/core';

import { actionLog, questionBook, runState, taskLock } from '../../../src/core/serve-state.ts';

const NOW = new Date('2026-10-10T12:00:00.000Z');

function question(patch: Partial<Question>): Question {
  return {
    id: 'A1',
    user: 'me',
    task: 't',
    kind: 'reply',
    sessionId: 'ses_1',
    action: null,
    text: 'Shall I?',
    createdAt: NOW.toISOString(),
    expiresAt: '2026-10-11T00:00:00.000Z',
    status: 'open',
    answer: null,
    answeredAt: null,
    resolution: null,
    ...patch,
  };
}

function result(patch: Partial<RunResult>): RunResult {
  return {
    task: 't',
    outcome: 'done',
    sessionId: 'ses_1',
    stopReason: 'end_turn',
    questionId: null,
    reply: 'the whole private answer',
    reason: null,
    startedAt: NOW.toISOString(),
    endedAt: NOW.toISOString(),
    ...patch,
  };
}

export default async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lotse-serve-state-'));
  const stateDir = join(dir, 'state');

  try {
    await describe('questionBook', async () => {
      await it('writes privately and reads back what it wrote', async () => {
        const book = questionBook(stateDir, () => NOW);
        expect(book.read().length).toBe(0);
        book.write([question({})]);
        expect(book.read()[0]!.id).toBe('A1');
        expect(statSync(join(stateDir, 'questions.json')).mode & 0o777).toBe(0o600);
        expect(statSync(stateDir).mode & 0o777).toBe(0o700);
      });

      await it('drops old closed questions on write', async () => {
        const book = questionBook(stateDir, () => NOW);
        book.write([
          question({}),
          question({ id: 'A2', status: 'answered', createdAt: '2026-09-01T00:00:00.000Z' }),
        ]);
        expect(book.read().map((entry) => entry.id)).toStrictEqual(['A1']);
      });

      await it('reports a corrupt file and reads it as empty', async () => {
        writeFileSync(join(stateDir, 'questions.json'), '{');
        const problems: string[] = [];
        expect(
          questionBook(
            stateDir,
            () => NOW,
            (problem) => problems.push(problem),
          ).read().length,
        ).toBe(0);
        expect(problems.length).toBe(1);
      });
    });

    await describe('runState', async () => {
      await it('keeps when and how, never the reply', async () => {
        const runs = runState(stateDir);
        expect(runs.lastRun('t')).toBeNull();
        runs.record(result({}));
        expect(runs.lastRun('t')).toStrictEqual(NOW);
        const text = readFileSync(join(stateDir, 'runs.json'), 'utf8');
        expect(text).not.toContain('private answer');
        expect(runs.all()['t']!.outcome).toBe('done');
      });
    });

    await describe('actionLog', async () => {
      await it('appends one JSON line per entry, mode 0600', async () => {
        const log = actionLog(stateDir, () => NOW);
        log({ event: 'run', task: 't', detail: { phase: 'start' } });
        log({ event: 'run', task: 't', detail: { phase: 'end' } });
        const file = join(stateDir, 'serve.log');
        const lines = readFileSync(file, 'utf8').trim().split('\n');
        expect(lines.length).toBe(2);
        expect(JSON.parse(lines[0]!).at).toBe(NOW.toISOString());
        expect(statSync(file).mode & 0o777).toBe(0o600);
      });
    });

    await describe('taskLock', async () => {
      await it('one holder at a time, released on demand', async () => {
        const lock = taskLock(stateDir);
        const release = lock('t');
        expect(release).not.toBeNull();
        expect(lock('t')).toBeNull();
        release?.();
        expect(existsSync(join(stateDir, 'locks', 't.lock'))).toBe(false);
        expect(lock('t')).not.toBeNull();
      });

      await it('takes over a lock whose process is gone', async () => {
        mkdirSync(join(stateDir, 'locks'), { recursive: true });
        writeFileSync(join(stateDir, 'locks', 'stale.lock'), '2147483646\n');
        expect(taskLock(stateDir)('stale')).not.toBeNull();
      });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
