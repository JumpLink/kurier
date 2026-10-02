import { describe, expect, it } from '@gjsify/unit';

import {
  LOCAL_PRINCIPAL,
  appendTurns,
  byRecency,
  forPrincipal,
  labelOf,
  newSession,
  type SessionRecord,
  type TranscriptEntry,
} from '@kurier/session';

const AT = '2026-09-30T10:00:00.000Z';

export default async () => {
  await describe('newSession — defaults', async () => {
    await it('fills principal, boundTo, reattach, turns and matching timestamps', async () => {
      const record = newSession({ id: 'ses_1', agent: 'opencode', cwd: '/tmp', at: AT });
      expect(record.principal).toBe(LOCAL_PRINCIPAL);
      expect(record.boundTo).toBe(null);
      expect(record.reattach).toBe(null);
      expect(record.turns).toStrictEqual([]);
      expect(record.createdAt).toBe(AT);
      expect(record.updatedAt).toBe(AT);
      expect(record.createdAt).toBe(record.updatedAt);
      expect(record.title).toBe(null);
    });

    await it('takes an explicit principal, boundTo, title and reattach', async () => {
      const record = newSession({
        id: 'ses_1',
        agent: 'opencode',
        cwd: '/tmp',
        at: AT,
        principal: 'pascal',
        boundTo: 'postbote:chat-1',
        title: 'Fix the parser',
        reattach: 'resume',
      });
      expect(record.principal).toBe('pascal');
      expect(record.boundTo).toBe('postbote:chat-1');
      expect(record.title).toBe('Fix the parser');
      expect(record.reattach).toBe('resume');
    });
  });

  await describe('newSession — agentSource', async () => {
    await it('records the source when given', async () => {
      const record = newSession({
        id: 'ses_1',
        agent: 'opencode',
        agentSource: 'bundled',
        cwd: '/tmp',
        at: AT,
      });
      expect(record.agentSource).toBe('bundled');
    });

    await it('leaves the key off when not given, as older records had it', async () => {
      const record = newSession({ id: 'ses_1', agent: 'opencode', cwd: '/tmp', at: AT });
      expect('agentSource' in record).toBe(false);
    });
  });

  await describe('appendTurns — immutable', async () => {
    await it('returns a new record and does not mutate the original', async () => {
      const record = newSession({ id: 'ses_1', agent: 'opencode', cwd: '/tmp', at: AT });
      const entries: TranscriptEntry[] = [{ kind: 'agent', text: 'hi', at: '2026-09-30T10:05:00.000Z' }];
      const next = appendTurns(record, entries);
      expect(next).not.toBe(record);
      expect(record.turns).toStrictEqual([]);
      expect(next.turns).toStrictEqual(entries);
    });

    await it('updatedAt comes from the last entry, not the clock', async () => {
      const record = newSession({ id: 'ses_1', agent: 'opencode', cwd: '/tmp', at: AT });
      const entries: TranscriptEntry[] = [
        { kind: 'user', text: 'go', at: '2026-09-30T10:01:00.000Z' },
        { kind: 'agent', text: 'done', at: '2026-09-30T10:02:00.000Z' },
      ];
      const next = appendTurns(record, entries);
      expect(next.updatedAt).toBe('2026-09-30T10:02:00.000Z');
    });

    await it('an empty array returns the SAME object, not a copy', async () => {
      const record = newSession({ id: 'ses_1', agent: 'opencode', cwd: '/tmp', at: AT });
      expect(appendTurns(record, [])).toBe(record);
    });
  });

  await describe('byRecency — newest first on ISO strings', async () => {
    await it('sorts descending by updatedAt', async () => {
      const older: SessionRecord = {
        ...newSession({ id: 'a', agent: 'x', cwd: '/tmp', at: AT }),
        updatedAt: '2026-09-01T00:00:00.000Z',
      };
      const newer: SessionRecord = {
        ...newSession({ id: 'b', agent: 'x', cwd: '/tmp', at: AT }),
        updatedAt: '2026-09-29T00:00:00.000Z',
      };
      expect([older, newer].sort(byRecency).map((r) => r.id)).toStrictEqual(['b', 'a']);
    });
  });

  await describe('forPrincipal — filters', async () => {
    await it('keeps only the records for the given principal', async () => {
      const mine = newSession({ id: 'a', agent: 'x', cwd: '/tmp', at: AT, principal: 'pascal' });
      const other = newSession({ id: 'b', agent: 'x', cwd: '/tmp', at: AT, principal: 'someone-else' });
      expect(forPrincipal([mine, other], 'pascal').map((r) => r.id)).toStrictEqual(['a']);
    });
  });

  await describe('labelOf', async () => {
    await it('prefers the title', async () => {
      const record = newSession({ id: 'ses_1', agent: 'x', cwd: '/tmp', at: AT, title: 'My title' });
      expect(labelOf(record)).toBe('My title');
    });

    await it('falls back to the first agent turn, truncated to 72 chars with an ellipsis', async () => {
      const long = 'x'.repeat(100);
      const record = appendTurns(newSession({ id: 'ses_1', agent: 'x', cwd: '/tmp', at: AT }), [
        { kind: 'user', text: 'ignored — not an agent turn', at: AT },
        { kind: 'agent', text: long, at: AT },
      ]);
      const label = labelOf(record);
      expect(label.length).toBe(73); // 72 chars + the ellipsis character
      expect(label.endsWith('…')).toBe(true);
    });

    await it('keeps a short agent turn as-is, with no ellipsis', async () => {
      const record = appendTurns(newSession({ id: 'ses_1', agent: 'x', cwd: '/tmp', at: AT }), [
        { kind: 'agent', text: 'short reply', at: AT },
      ]);
      expect(labelOf(record)).toBe('short reply');
    });

    await it('joins a streamed answer instead of stopping at the first chunk', async () => {
      // Measured against `opencode acp`: a one-word reply arrives as two `session/update` chunks,
      // and taking the first alone labelled the session `RESUME-`. A label that stops mid-word is
      // worse than none, because it looks like the answer.
      const record = appendTurns(newSession({ id: 'ses_1', agent: 'x', cwd: '/tmp', at: AT }), [
        { kind: 'user', text: 'say ok', at: AT },
        { kind: 'agent', text: 'RESUME-', at: AT },
        { kind: 'agent', text: 'OK', at: AT },
      ]);
      expect(labelOf(record)).toBe('RESUME-OK');
    });

    await it('stops at the next user turn', async () => {
      // The label is the OPENING answer, not the whole conversation — joining every agent turn would
      // make a long session's label its entire transcript.
      const record = appendTurns(newSession({ id: 'ses_1', agent: 'x', cwd: '/tmp', at: AT }), [
        { kind: 'agent', text: 'first ', at: AT },
        { kind: 'agent', text: 'answer', at: AT },
        { kind: 'user', text: 'and now?', at: AT },
        { kind: 'agent', text: 'a much later answer', at: AT },
      ]);
      expect(labelOf(record)).toBe('first answer');
    });

    await it('skips a thought line before the answer', async () => {
      // A model thinks out loud first, and that thinking is not the label. Recorded from the real
      // agent: `thought` chunks routinely arrive before the first `agent_message_chunk`.
      const record = appendTurns(newSession({ id: 'ses_1', agent: 'x', cwd: '/tmp', at: AT }), [
        { kind: 'thought', text: 'the user wants a short reply', at: AT },
        { kind: 'agent', text: 'OK', at: AT },
      ]);
      expect(labelOf(record)).toBe('OK');
    });

    await it("stops at a tool line between the answer's chunks", async () => {
      // A tool call is not part of the answer, so it ends the run rather than being concatenated
      // into it — otherwise a mid-tool stream boundary would splice `reading the file` into a reply.
      const record = appendTurns(newSession({ id: 'ses_1', agent: 'x', cwd: '/tmp', at: AT }), [
        { kind: 'agent', text: 'I will check', at: AT },
        { kind: 'tool', text: 'read — completed', at: AT },
        { kind: 'agent', text: 'the file first.', at: AT },
      ]);
      expect(labelOf(record)).toBe('I will check');
    });

    await it('falls back to the id when there is no title and no agent turn', async () => {
      const record = newSession({ id: 'ses_1', agent: 'x', cwd: '/tmp', at: AT });
      expect(labelOf(record)).toBe('ses_1');
    });
  });
};
