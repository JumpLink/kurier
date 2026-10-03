import { describe, expect, it } from '@gjsify/unit';

import { conversationRecord, titleFromPrompt, unsavedMessage } from '../../../src/core/conversation.ts';

const AT = '2026-10-02T09:00:00.000Z';

const base = {
  id: 'ses_synthetic_0001',
  agent: 'opencode',
  agentSource: 'bundled' as const,
  cwd: '/synthetic/project',
  prompt: 'Summarise this repository.',
  at: AT,
  supportsLoadSession: true,
  supportsResumeSession: true,
};

export default async () => {
  await describe('conversation — the title', async () => {
    await it('is the first non-blank line, trimmed', async () => {
      expect(titleFromPrompt('  \n  first line  \nsecond')).toBe('first line');
    });

    await it('is cut at 72 characters with an ellipsis, and not before', async () => {
      expect(titleFromPrompt('x'.repeat(72))).toBe('x'.repeat(72));
      expect(titleFromPrompt('x'.repeat(73))).toBe(`${'x'.repeat(72)}…`);
    });

    await it('is null for an empty prompt, so the label falls back to the answer', async () => {
      expect(titleFromPrompt('')).toBe(null);
      expect(titleFromPrompt('  \n ')).toBe(null);
    });
  });

  await describe('conversation — the record both surfaces write', async () => {
    await it('names the agent, which copy of it, the directory, the title and the clock', async () => {
      const record = conversationRecord(base);
      expect(record.id).toBe('ses_synthetic_0001');
      expect(record.agent).toBe('opencode');
      expect(record.agentSource).toBe('bundled');
      expect(record.cwd).toBe('/synthetic/project');
      expect(record.title).toBe('Summarise this repository.');
      expect(record.createdAt).toBe(AT);
      expect(record.updatedAt).toBe(AT);
      expect(record.turns).toStrictEqual([]);
      expect(record.principal).toBe('local');
      expect(record.boundTo).toBe(null);
    });

    await it('records how the agent can reattach it: load, else resume, else nothing', async () => {
      expect(conversationRecord(base).reattach).toBe('load');
      expect(conversationRecord({ ...base, supportsLoadSession: false }).reattach).toBe('resume');
      expect(
        conversationRecord({ ...base, supportsLoadSession: false, supportsResumeSession: false }).reattach,
      ).toBe(null);
    });

    await it('the unsaved message says it was not saved, why, and what to press', async () => {
      const text = unsavedMessage('disk full');
      expect(text).toContain('not saved');
      expect(text).toContain('disk full');
      expect(text).toContain('New chat');
    });

    await it('keeps a host session’s source explicit, so an absent field is only ever an old record', async () => {
      expect(conversationRecord({ ...base, agentSource: 'host' }).agentSource).toBe('host');
    });
  });
};
