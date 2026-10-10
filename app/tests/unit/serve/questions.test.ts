import { describe, expect, it } from '@gjsify/unit';

import {
  formatQuestionId,
  isQuestionText,
  nextQuestionId,
  normalizeQuestionId,
  openQuestions,
  parseAnswer,
  parseQuestions,
  pruneQuestions,
  type Question,
} from '@lotse/core';

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
    createdAt: '2026-10-10T11:00:00.000Z',
    expiresAt: '2026-10-10T23:00:00.000Z',
    status: 'open',
    answer: null,
    answeredAt: null,
    resolution: null,
    ...patch,
  };
}

export default async () => {
  await describe('question ids', async () => {
    await it('formats and normalises', async () => {
      expect(formatQuestionId('A7')).toBe('#A7');
      expect(normalizeQuestionId(' #a07 ')).toBe('A7');
      expect(normalizeQuestionId('A')).toBeNull();
      expect(normalizeQuestionId('rm -rf')).toBeNull();
    });

    await it('counts per user and never reuses an id still in the list', async () => {
      const book = [question({ id: 'A1' }), question({ id: 'A4' }), question({ id: 'A9', user: 'other' })];
      expect(nextQuestionId(book, 'me')).toBe('A5');
      expect(nextQuestionId(book, 'new')).toBe('A1');
    });
  });

  await describe('parseAnswer', async () => {
    await it('knows yes and no in two languages, without a model', async () => {
      for (const word of ['yes', 'Y', 'ja', 'OK.', 'okay!'])
        expect(parseAnswer(word)).toStrictEqual({ kind: 'yes' });
      for (const word of ['no', 'N', 'Nein.']) expect(parseAnswer(word)).toStrictEqual({ kind: 'no' });
    });

    await it('anything longer is text for the session', async () => {
      expect(parseAnswer(' yes, but only the first one ')).toStrictEqual({
        kind: 'text',
        text: 'yes, but only the first one',
      });
    });
  });

  await describe('isQuestionText', async () => {
    await it('looks at the last non-empty line only', async () => {
      expect(isQuestionText('Done.\n\nShall I archive it?\n')).toBe(true);
      expect(isQuestionText('Why? Because.\nDone.')).toBe(false);
      expect(isQuestionText('')).toBe(false);
    });
  });

  await describe('the store', async () => {
    await it('an expired question is not open, even if nobody marked it', async () => {
      const book = [question({ id: 'A1' }), question({ id: 'A2', expiresAt: '2026-10-10T11:30:00.000Z' })];
      expect(openQuestions(book, NOW).map((entry) => entry.id)).toStrictEqual(['A1']);
    });

    await it('prunes old closed questions and keeps every open one', async () => {
      const old = '2026-09-01T00:00:00.000Z';
      const book = [
        question({ id: 'A1', createdAt: old }),
        question({ id: 'A2', createdAt: old, status: 'answered' }),
        question({ id: 'A3', status: 'answered' }),
      ];
      expect(pruneQuestions(book, NOW, 7 * 86_400_000).map((entry) => entry.id)).toStrictEqual(['A1', 'A3']);
    });

    await it('a corrupt store is an empty list and a sentence', async () => {
      expect(parseQuestions('{').questions.length).toBe(0);
      expect(parseQuestions('{').problem).not.toBeNull();
      const mixed = parseQuestions(JSON.stringify([question({}), { id: 3 }]));
      expect(mixed.questions.length).toBe(1);
      expect(mixed.problem).not.toBeNull();
    });
  });
};
