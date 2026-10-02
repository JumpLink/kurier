/**
 * What the window says when there is no agent, and when it owes the bundled-agent notice. Pure.
 */

import { describe, expect, it } from '@gjsify/unit';

import { DOCS_URL, INSTALL_COMMAND, emptyStateView, noticeView } from '../../../src/core/empty-state.ts';
import { NO_AGENT_MESSAGE, type ResolvedAgent } from '../../../src/core/agents/resolve.ts';

const FOUND: ResolvedAgent = {
  command: { id: 'opencode', title: 'OpenCode', program: 'opencode', args: ['acp'] },
  source: 'host',
  version: null,
  isolation: null,
};

export default async () => {
  await describe('emptyStateView', async () => {
    await it('is ready when an agent was resolved', async () => {
      expect(emptyStateView({ agent: FOUND }).kind).toBe('ready');
    });

    await it('names the lack and both remedies when nothing was found', async () => {
      const view = emptyStateView({ agent: null });
      expect(view.kind).toBe('no-agent');
      if (view.kind !== 'no-agent') return;
      expect(view.title).toBe('No agent found');
      expect(view.body.includes('Flatpak')).toBe(true);
      expect(view.commands[0]).toBe(INSTALL_COMMAND);
      expect(view.docsUrl).toBe(DOCS_URL);
      expect(view.sendReason.length > 0).toBe(true);
    });

    await it('shares its remedy with what the command line prints', async () => {
      expect(NO_AGENT_MESSAGE.includes(INSTALL_COMMAND)).toBe(true);
      expect(NO_AGENT_MESSAGE.includes(DOCS_URL)).toBe(true);
      expect(NO_AGENT_MESSAGE.includes('Flatpak')).toBe(true);
    });
  });

  await describe('noticeView', async () => {
    await it('is shown for the bundled copy when it was not dismissed', async () => {
      const view = noticeView('bundled', []);
      expect(view?.id).toBe('bundled-agent');
      expect(view?.button).toBe('Got it');
      expect(view?.text.includes('time-limited')).toBe(true);
    });

    await it('is not shown once dismissed', async () => {
      expect(noticeView('bundled', ['bundled-agent'])).toBe(null);
    });

    await it('is not shown for a host install, or when there is no agent', async () => {
      expect(noticeView('host', [])).toBe(null);
      expect(noticeView(null, [])).toBe(null);
    });
  });
};
