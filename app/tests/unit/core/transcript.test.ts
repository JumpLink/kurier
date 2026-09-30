import { describe, expect, it } from '@gjsify/unit';

import type { SessionNotification, SessionUpdate } from '@kurier/acp/types';

import { toTranscript } from '../../../src/core/transcript.ts';

const AT = '2026-09-30T10:00:00.000Z';

function notification(update: SessionUpdate): SessionNotification {
  return { sessionId: 's1', update };
}

export default async () => {
  await describe('toTranscript — chunk kinds', async () => {
    await it('user_message_chunk keeps its text as kind "user"', async () => {
      const entries = toTranscript(
        notification({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } }),
        AT,
      );
      expect(entries.length).toBe(1);
      expect(entries[0]?.kind).toBe('user');
      expect(entries[0]?.text).toBe('hi');
    });

    await it('agent_message_chunk keeps its text as kind "agent"', async () => {
      const entries = toTranscript(
        notification({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } }),
        AT,
      );
      expect(entries[0]?.kind).toBe('agent');
      expect(entries[0]?.text).toBe('answer');
    });

    await it('agent_thought_chunk keeps its text as kind "thought"', async () => {
      const entries = toTranscript(
        notification({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking…' } }),
        AT,
      );
      expect(entries[0]?.kind).toBe('thought');
      expect(entries[0]?.text).toBe('thinking…');
    });
  });

  await describe('toTranscript — tool calls', async () => {
    await it('tool_call records title + status and the toolCallId', async () => {
      const entries = toTranscript(
        notification({
          sessionUpdate: 'tool_call',
          toolCallId: 'call_1',
          title: 'read a file',
          status: 'pending',
        }),
        AT,
      );
      expect(entries[0]?.kind).toBe('tool');
      expect(entries[0]?.toolCallId).toBe('call_1');
      expect(entries[0]?.text).toBe('read a file — pending');
    });

    await it('tool_call_update with only a status still records', async () => {
      const entries = toTranscript(
        notification({ sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'completed' }),
        AT,
      );
      expect(entries.length).toBe(1);
      expect(entries[0]?.kind).toBe('tool');
      expect(entries[0]?.toolCallId).toBe('call_1');
      // No title, so the status string's own leading space is trimmed but the "— " marker stays.
      expect(entries[0]?.text).toBe('— completed');
    });

    await it('tool_call_update with neither title nor status produces nothing', async () => {
      const entries = toTranscript(
        notification({ sessionUpdate: 'tool_call_update', toolCallId: 'call_1' }),
        AT,
      );
      expect(entries).toStrictEqual([]);
    });
  });

  await describe('toTranscript — plan', async () => {
    await it('becomes one line per entry', async () => {
      const entries = toTranscript(
        notification({
          sessionUpdate: 'plan',
          entries: [
            { content: 'read the file', status: 'completed' },
            { content: 'write the fix', status: 'in_progress' },
          ],
        }),
        AT,
      );
      expect(entries.length).toBe(2);
      expect(entries[0]?.text).toBe('plan: [completed] read the file');
      expect(entries[1]?.text).toBe('plan: [in_progress] write the fix');
      expect(entries.every((e) => e.kind === 'system')).toBe(true);
    });
  });

  await describe('toTranscript — bookkeeping updates that produce nothing', async () => {
    await it('available_commands_update produces no lines', async () => {
      const entries = toTranscript(
        notification({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'init' }] }),
        AT,
      );
      expect(entries).toStrictEqual([]);
    });

    await it('config_option_update produces no lines', async () => {
      // Carries three real options, because a `config_option_update` without them is not a thing
      // the protocol allows and a test that used one was asserting on an input no agent sends.
      const entries = toTranscript(
        notification({
          sessionUpdate: 'config_option_update',
          configOptions: [
            { id: 'model', name: 'Model', type: 'select', category: 'model', currentValue: 'a/b', options: [{ value: 'a/b', name: 'b' }] },
            { id: 'effort', name: 'Effort', type: 'select', category: 'thought_level', currentValue: 'high', options: [{ value: 'high', name: 'High' }] },
          ],
        }),
        AT,
      );
      // Configuration is surface state, not conversation: the transcript is a record of what
      // happened in the session, and picking a model is not something that happened in it.
      expect(entries).toStrictEqual([]);
    });
  });

  await describe('toTranscript — usage_update', async () => {
    await it('becomes "usage: in N, out M"', async () => {
      const entries = toTranscript(
        notification({ sessionUpdate: 'usage_update', inputTokens: 120, outputTokens: 45 }),
        AT,
      );
      expect(entries[0]?.kind).toBe('system');
      expect(entries[0]?.text).toBe('usage: in 120, out 45');
    });
  });

  await describe('toTranscript — session_info_update (title)', async () => {
    await it('records a line when there is a title', async () => {
      const entries = toTranscript(
        notification({ sessionUpdate: 'session_info_update', title: 'New title' }),
        AT,
      );
      expect(entries[0]?.text).toBe('title: New title');
    });

    await it('produces nothing when there is no title', async () => {
      const entries = toTranscript(notification({ sessionUpdate: 'session_info_update' }), AT);
      expect(entries).toStrictEqual([]);
    });
  });

  await describe('toTranscript — an update variant this client does not know', async () => {
    await it('is recorded as one opaque system line rather than dropped or thrown', async () => {
      const update = { sessionUpdate: 'diff_preview', path: '/tmp/x' } as unknown as SessionUpdate;
      const entries = toTranscript(notification(update), AT);
      expect(entries.length).toBe(1);
      expect(entries[0]?.kind).toBe('system');
      expect(entries[0]?.text).toContain('diff_preview');
    });
  });
};
