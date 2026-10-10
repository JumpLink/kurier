import { describe, expect, it } from '@gjsify/unit';

import { labelOf, newSession, type TranscriptEntry } from '@kurier/session';

import { toTranscriptItems, type TranscriptItem } from '@kurier/core';

const AT = '2026-09-30T10:00:00.000Z';
const LATER = '2026-09-30T10:00:01.000Z';

/**
 * One transcript line. Everything here is synthetic — a real prompt or a real reply from a machine's
 * history is exactly what this repo's privacy rule keeps out of a test.
 */
const entry = (
  kind: TranscriptEntry['kind'],
  text: string,
  at: string = AT,
  toolCallId?: string,
): TranscriptEntry => ({ kind, text, at, ...(toolCallId === undefined ? {} : { toolCallId }) });

/** `(kind, text)` per item, for one assertion. The order *is* the thing most of these assert. */
const shape = (items: readonly TranscriptItem[]): [string, string][] =>
  items.map((item) => [
    item.kind,
    item.kind === 'tool' || item.kind === 'thought' ? item.summary : item.text,
  ]);

/**
 * The item's whole text, whichever field it keeps.
 *
 * A thought carries `detail`, a tool call carries `null` there — which is the two-field shape doing
 * its job, and why a test cannot just reach for `.text` on the union.
 */
const textOf = (item: TranscriptItem | undefined): string | null | undefined =>
  item === undefined ? undefined : 'text' in item ? item.text : item.detail;

export default async () => {
  await describe('toTranscriptItems — what a line becomes', async () => {
    await it('keeps a user line and an agent line as two items, in order', async () => {
      const items = toTranscriptItems([entry('user', 'refactor the types'), entry('agent', 'starting')]);
      expect(shape(items)).toStrictEqual([
        ['user', 'refactor the types'],
        ['agent', 'starting'],
      ]);
    });

    await it('gives a thought a closed line and a body, and a tool call only a closed line', async () => {
      const items = toTranscriptItems([
        entry('thought', 'the registry is circular, so…', AT),
        entry('tool', 'read packages/session/src/model.ts — completed', LATER, 'call_1'),
      ]);
      expect(shape(items)).toStrictEqual([
        ['thought', 'Thought'],
        ['tool', 'read packages/session/src/model.ts — completed'],
      ]);
      const thought = items[0];
      if (thought?.kind !== 'thought') throw new Error('expected a thought item');
      // A thought's body is the reasoning itself, so there always is one.
      expect(thought.detail).toBe('the registry is circular, so…');
      expect(thought.expanded).toBe(false);
      const tool = items[1];
      if (tool?.kind !== 'tool') throw new Error('expected a tool item');
      // `null`, and this is the assertion that says so: kurier holds a tool call's title and status
      // and no payload (`toTranscript` keeps neither `rawInput` nor `rawOutput`), so a body could
      // only be the summary repeated, the agent's internal id and a raw timestamp.
      expect(tool.detail).toBeNull();
      expect(tool.expanded).toBe(false);
    });

    await it('gives a tool line no body whatever id it carries', async () => {
      const items = toTranscriptItems([
        entry('tool', 'grep — failed'),
        entry('tool', 'ls — completed', LATER, 'call_9'),
      ]);
      expect(items.map((item) => (item.kind === 'tool' ? item.detail : 'x'))).toStrictEqual([null, null]);
    });

    await it('leaves a system line as text, not as a disclosure', async () => {
      // A mode change or a plan is the conversation's own bookkeeping. It is not something anybody
      // said, so it gets no bubble and no expander — the surface decides that from `kind` alone.
      const items = toTranscriptItems([entry('system', 'mode: plan')]);
      expect(items[0]?.kind).toBe('system');
      expect(textOf(items[0])).toBe('mode: plan');
    });

    await it('stamps an item with the time its run started', async () => {
      const items = toTranscriptItems([entry('agent', 'first ', AT), entry('agent', 'second', LATER)]);
      expect(items[0]?.at).toBe(AT);
    });
  });

  await describe('toTranscriptItems — merging', async () => {
    await it('joins adjacent agent chunks into one bubble, with nothing between', async () => {
      // THE stream rule. A stream boundary lands wherever the model happened to emit, so a one-word
      // answer arrives as two entries; two bubbles where the person sent one is the artefact this
      // exists to remove.
      expect(
        toTranscriptItems([entry('agent', 'The answer'), entry('agent', ' is forty-two.')]),
      ).toStrictEqual([{ kind: 'agent', text: 'The answer is forty-two.', at: AT }]);
    });

    await it('joins a chunk that split mid-word back into one word', async () => {
      // Measured against `opencode acp` 2.0.19: a one-word answer arrived as `RESUME-` and `OK`.
      // A space between the chunks would make it a different word, and this is the case the rule
      // exists for.
      expect(textOf(toTranscriptItems([entry('agent', 'RESUME-'), entry('agent', 'OK')])[0])).toBe(
        'RESUME-OK',
      );
    });

    await it('keeps the space that was inside a chunk instead of trimming each one', async () => {
      // `'first '` + `'answer'` is `'first answer'`. Trimming per chunk gives `'firstanswer'`, which
      // is the mid-word glue `labelOf` in `@kurier/session` also refuses to do.
      expect(textOf(toTranscriptItems([entry('agent', 'first '), entry('agent', 'answer')])[0])).toBe(
        'first answer',
      );
    });

    await it('trims the finished run once, at both ends', async () => {
      const items = toTranscriptItems([entry('agent', '\n  '), entry('agent', 'the body.  ')]);
      expect(textOf(items[0])).toBe('the body.');
    });

    await it('joins adjacent user chunks, and adjacent system lines', async () => {
      // Same stream argument for a prompt. A `plan` update emits several system lines at once, and
      // three centred notes with gaps between them is a plan that reads as three events.
      expect(textOf(toTranscriptItems([entry('user', 'fix '), entry('user', 'it')])[0])).toBe('fix it');
      expect(
        shape(
          toTranscriptItems([entry('system', 'plan: [pending] one'), entry('system', 'plan: [pending] two')]),
        ),
      ).toStrictEqual([['system', 'plan: [pending] oneplan: [pending] two']]);
    });

    await it('merges thoughts into one disclosure, and counts the chunks in its line', async () => {
      // The count is why the summary is not the word "Thought" every time: a person opening "Thought"
      // twice in a row cannot tell whether they are looking at two thoughts or one.
      const items = toTranscriptItems([
        entry('thought', 'the registry '),
        entry('thought', 'is circular'),
        entry('thought', ', so it has to be a function'),
      ]);
      expect(shape(items)).toStrictEqual([['thought', '3 thoughts']]);
      if (items[0]?.kind !== 'thought') throw new Error('expected a thought item');
      expect(items[0].detail).toBe('the registry is circular, so it has to be a function');
      expect(items[0].expanded).toBe(false);
    });

    await it('ends a run at anything that is not the same kind', async () => {
      // Splicing "reading the file" into a sentence that never contained it is the artefact the
      // boundary prevents. Three items, and the answer is split in two.
      const items = toTranscriptItems([
        entry('agent', 'first part '),
        entry('tool', 'read model.ts — completed'),
        entry('agent', 'second part'),
      ]);
      expect(shape(items)).toStrictEqual([
        ['agent', 'first part'],
        ['tool', 'read model.ts — completed'],
        ['agent', 'second part'],
      ]);
    });

    await it('keeps a thought between two chunks as its own item, and splits the answer', async () => {
      const items = toTranscriptItems([
        entry('agent', 'one '),
        entry('thought', 'hmm'),
        entry('agent', 'two'),
      ]);
      expect(shape(items)).toStrictEqual([
        ['agent', 'one'],
        ['thought', 'Thought'],
        ['agent', 'two'],
      ]);
    });

    await it('keeps two tool lines separate, even with the same id', async () => {
      // `toTranscript` records a `tool_call` and each of its updates as its own line, so one read can
      // be three rows. Folding them would have to pick a winner, and a `tool_call_update` may carry a
      // status and no title — so "the newer line wins" drops the title and the row reads ` — completed`.
      // The record has the lines; this projection does not second-guess the agent's stream with them.
      const items = toTranscriptItems([
        entry('tool', 'read model.ts — pending', AT, 'call_1'),
        entry('tool', 'read model.ts — completed', LATER, 'call_1'),
      ]);
      expect(items.length).toBe(2);
      expect(items.map((item) => (item.kind === 'tool' ? item.summary : ''))).toStrictEqual([
        'read model.ts — pending',
        'read model.ts — completed',
      ]);
    });

    await it('agrees with labelOf on the answer it labels a session with', async () => {
      // The two functions join the same run, and the rule is the one `labelOf` documents: raw chunks,
      // joined with nothing, trimmed once at the end. A change to one that the other does not follow
      // fails here instead of showing up in one surface and not the other.
      const turns = [entry('agent', 'Refactored '), entry('agent', 'the types.'), entry('agent', ' Done.')];
      const record = newSession({ id: 's1', agent: 'opencode', cwd: '/tmp', at: AT });
      expect(labelOf({ ...record, turns })).toBe(textOf(toTranscriptItems(turns)[0]));

      // …and on the boundary: a tool line in the middle ends the run in both.
      const interrupted = [
        entry('agent', 'Refactored '),
        entry('tool', 'read a.ts — completed'),
        entry('agent', 'the types.'),
      ];
      expect(labelOf({ ...record, turns: interrupted })).toBe(textOf(toTranscriptItems(interrupted)[0]));
    });
  });

  await describe('toTranscriptItems — the one line a closed disclosure shows', async () => {
    await it('cuts a summary at the measure and marks the cut', async () => {
      // 84 characters is the closed line's whole budget (`SUMMARY_MAX`), chosen so it fits about the
      // same physical width as a bubble's line. A tool title can be an entire shell command, and a
      // disclosure that wraps is a paragraph between two answers.
      const long = `bash -lc ${'x'.repeat(200)}`;
      const items = toTranscriptItems([entry('tool', long)]);
      const tool = items[0];
      if (tool?.kind !== 'tool') throw new Error('expected a tool item');
      expect(tool.summary.length).toBe(84);
      expect(tool.summary.endsWith('…')).toBe(true);
      // The cut is only ever in the summary. Nothing is lost by it: the body of a tool line is nothing,
      // and a thought's body is the whole reasoning, never a summary.
      expect(tool.detail).toBeNull();
    });

    await it('leaves a summary at or under the measure untouched', async () => {
      const items = toTranscriptItems([entry('tool', 'read a.ts')]);
      const tool = items[0];
      if (tool?.kind !== 'tool') throw new Error('expected a tool item');
      expect(tool.summary).toBe('read a.ts');
    });

    await it('flattens newlines in a summary, so a closed row cannot wrap', async () => {
      // An agent's `title` is free text and can hold a newline. A closed row that wraps is a row
      // that has stopped being a disclosure.
      const items = toTranscriptItems([entry('tool', 'read a.ts\n  -- and b.ts')]);
      const tool = items[0];
      if (tool?.kind !== 'tool') throw new Error('expected a tool item');
      expect(tool.summary).toBe('read a.ts -- and b.ts');
    });

    await it('keeps markup characters in a summary as the characters they are', async () => {
      // `<b>&` is not a Pango escape here, it is three characters somebody typed. The transcript is
      // not filtered (`transcript.ts` is explicit about that), so the projection carries the text
      // through untouched and the widget is what must not read it as markup.
      const items = toTranscriptItems([entry('tool', 'diff <<<<<< HEAD <b>&</b>')]);
      const tool = items[0];
      if (tool?.kind !== 'tool') throw new Error('expected a tool item');
      expect(tool.summary).toBe('diff <<<<<< HEAD <b>&</b>');
    });
  });

  await describe('toTranscriptItems — the input is not the projection', async () => {
    await it('returns [] for an empty or all-blank transcript', async () => {
      expect(toTranscriptItems([])).toStrictEqual([]);
      // `toTranscript` already skips empty chunks, so a blank one here means a hand-edited store —
      // and a bubble with nothing in it is a hole in the conversation, not a message.
      expect(
        toTranscriptItems([entry('agent', ''), entry('user', '   '), entry('agent', '\n')]),
      ).toStrictEqual([]);
    });

    await it('does not mutate the input array', async () => {
      // The store's array is shared state: a render that reordered it in place would leave every
      // other reader looking at a list in an order nobody chose. Frozen, so an in-place sort throws
      // here instead of passing quietly.
      const entries = [entry('user', 'b'), entry('agent', 'a')];
      const before = [...entries];
      Object.freeze(entries);

      toTranscriptItems(entries);

      expect(entries).toStrictEqual(before);
    });

    await it('does not reorder by timestamp', async () => {
      // The transcript is a record of what happened in the order it was appended. Sorting it would be
      // re-deriving history the agent's own `session/load` is the authority on — out of timestamps a
      // hand-edited store can carry as garbage.
      const items = toTranscriptItems([
        entry('user', 'asked second', LATER),
        entry('agent', 'answered first', AT),
      ]);
      expect(shape(items)).toStrictEqual([
        ['user', 'asked second'],
        ['agent', 'answered first'],
      ]);
    });

    await it('survives an entry with no text at all', async () => {
      // A hand-edited store, or a line written by a version that did not have the field. The type
      // says `text: string`, the file says otherwise, and a renderer that throws on it takes the
      // whole conversation down.
      const broken = { kind: 'agent', at: AT } as unknown as TranscriptEntry;
      expect(() => toTranscriptItems([broken])).not.toThrow();
      expect(toTranscriptItems([broken])).toStrictEqual([]);
    });
  });
};
