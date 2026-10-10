// The example in docs/embedding.md. It is type-checked with the app (`gjsify foreach -A check`) so the
// guide cannot drift from the signatures; it is not run. Keep the two in step.
import { homedir } from 'node:os';

import type Adw from '@girs/adw-1';

import {
  DEFAULT_AGENT,
  emptyStateView,
  gatherResolveContext,
  lotsePathsUnder,
  requireLauncher,
  resolveDefault,
  resolveRecorded,
  type McpServer,
} from '@lotse/core';
import { createSessionStore } from '@lotse/session';
import { LotseChat } from '@lotse/widget';

export function embedChat(window: Adw.ApplicationWindow, dataRoot: string, projectDir: string): LotseChat {
  // Everything kurier writes goes under `dataRoot`, in the host's own data directory.
  const paths = lotsePathsUnder(dataRoot);
  const store = createSessionStore(paths.sessionsFile);

  // The agent: the person's own install, else a bundled copy. `null` means none was found.
  const found = resolveDefault(gatherResolveContext(paths, false));
  const empty = emptyStateView({ agent: found });

  const mcpServers: McpServer[] = [
    { name: 'my-tools', command: '/usr/bin/my-mcp-server', args: [], env: [] },
  ];

  const chat = new LotseChat({
    // A command is required even when nothing was found; `noAgent` then switches Send off.
    agent: found?.command ?? requireLauncher(DEFAULT_AGENT),
    agentSource: found?.source ?? 'host',
    newChat: { cwd: projectDir, home: homedir() },
    createSession: (record) => store.create(record),
    appendTurns: (id, entries) => store.append(id, entries),
    resolveAgent: async (id, source) =>
      resolveRecorded(id, source, gatherResolveContext(paths, false, false)),
    mcpServers,
    ...(empty.kind === 'no-agent' ? { noAgent: empty } : {}),
    // May only narrow: 'decline' answers the agent without asking, anything else asks the person.
    gate: (question) => (question.view.kind === 'delete' ? 'decline' : 'ask'),
    onNotice: (message) => console.log(`agent: ${message}`),
  });

  window.set_content(chat);
  chat.newChat();

  // Block the close until the agent subprocess is gone, then close for real.
  window.connect('close-request', () => {
    void chat.shutdown().finally(() => window.destroy());
    return true;
  });
  return chat;
}
