import { describe, expect, it } from '@gjsify/unit';

import { pickArgv, showUpdate } from '../../src/frontends/cli/output.ts';

export default async () => {
  await describe('pickArgv', async () => {
    await it('reads the camelCase spelling', async () => {
      expect(pickArgv({ denyAll: true }, 'deny-all', 'denyAll')).toBe(true);
    });

    await it('reads the kebab-case spelling', async () => {
      expect(pickArgv({ 'deny-all': true }, 'deny-all', 'denyAll')).toBe(true);
    });

    await it('returns undefined when neither spelling is present', async () => {
      expect(pickArgv({}, 'deny-all', 'denyAll')).toBe(undefined);
    });
  });

  await describe('showUpdate', async () => {
    await it('routes agent_message_chunk text to onText', async () => {
      // The thought/tool/plan/usage branches write to stderr via `err()` (`process.stderr.write`),
      // which cannot be captured portably on GJS — so only the onText path is asserted here.
      const texts: string[] = [];
      showUpdate(
        {
          sessionId: 's1',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } },
        },
        (text) => texts.push(text),
      );
      expect(texts).toStrictEqual(['hello']);
    });
  });
};
