# @lotse/widget

The chat surface, as a widget another GTK4 / libadwaita app embeds. `LotseChat` is an `Adw.Bin` that
shows **one conversation**: the transcript, the composer with its model, effort and mode controls, the
tool and thought cards, the approval dialog, failure notices and the provider login. It owns one agent
subprocess and renders what `@lotse/core` reports.

Licence: **LGPL-3.0-or-later** (`LICENSE`, `COPYING` in this directory).

The widget draws; every decision (may Send be pressed, what does this failure say, which options may a
permission dialog show) is made in [`@lotse/core`](../core/README.md). The host brings the window, the
session list, the menu and the preferences. The full walkthrough, from data directory to shutdown, is
the [host guide](../../docs/embedding.md); the design of the split is
[ADR 0001](../../docs/adr/0001-lotse-as-an-embeddable-widget.md).

Requires GJS with GTK 4 and libadwaita, and an ACP agent (opencode today) on `PATH` or bundled.

## Install and import

The packages are `private` and not yet on a registry; depend on them as a workspace:

```json
{ "dependencies": { "@lotse/widget": "*", "@lotse/core": "*", "@lotse/session": "*" } }
```

```ts
import { LotseChat } from '@lotse/widget';
```

`.` is the public entry. Two further sub-paths exist for lotse's own tests (`@lotse/widget/tool-line`,
`@lotse/widget/permission-dialog`); a host does not need them.

## Minimal example

```ts
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
  const paths = lotsePathsUnder(dataRoot);
  const store = createSessionStore(paths.sessionsFile);

  const found = resolveDefault(gatherResolveContext(paths, false));
  const empty = emptyStateView({ agent: found });

  const mcpServers: McpServer[] = [
    { name: 'my-tools', command: '/usr/bin/my-mcp-server', args: [], env: [] },
  ];

  const chat = new LotseChat({
    agent: found?.command ?? requireLauncher(DEFAULT_AGENT),
    agentSource: found?.source ?? 'host',
    newChat: { cwd: projectDir, home: homedir() },
    createSession: (record) => store.create(record),
    appendTurns: (id, entries) => store.append(id, entries),
    resolveAgent: async (id, source) =>
      resolveRecorded(id, source, gatherResolveContext(paths, false, false)),
    mcpServers,
    ...(empty.kind === 'no-agent' ? { noAgent: empty } : {}),
    gate: (question) => (question.view.kind === 'delete' ? 'decline' : 'ask'),
    onNotice: (message) => console.log(`agent: ${message}`),
  });

  window.set_content(chat);
  chat.newChat();

  window.connect('close-request', () => {
    void chat.shutdown().finally(() => window.destroy());
    return true;
  });
  return chat;
}
```

This is `app/tests/examples/embed.ts`, which is type-checked with the app. Each line is explained in the
[host guide](../../docs/embedding.md).

## `LotseChatOptions`

`new LotseChat(options)`. Only `agent` and `newChat` are required.

| Option | Type | Meaning |
|---|---|---|
| `agent` | `AgentCommand` | The agent to start on the first prompt, and the one a login is for. Required even when nothing was found (see `noAgent`). |
| `agentSource` | `'host' \| 'bundled'` | Which copy `agent` is; what a new conversation's record names. Default `host`. |
| `newChat` | `{ cwd: string; home: string \| null } \| null` | Where a new chat runs, and the home it is abbreviated against (`~/…`). `null`: no directory was found; `newChat()` does nothing and `hasNewChat` is `false`. |
| `createSession` | `(record: SessionRecord) => void` | Write a new conversation's record. `SessionStore.create`. |
| `appendTurns` | `(sessionId, entries) => void` | Persist streamed transcript lines, once per arriving batch, in order. `SessionStore.append`. |
| `resolveAgent` | `(id, source) => Promise<RecordedResolution>` | The agent a stored session names, on the copy that held it: `resolveRecorded`. Leave out to run every session on `agent`. |
| `mcpServers` | `readonly McpServer[]` | Your MCP servers, sent unchanged in `session/new` and on reattach. Never read by lotse past `type`. |
| `noAgent` | `{ kind: 'no-agent', … }` | Nothing was found: Send is off, and `showNoAgent()` shows the `noAgentPage`. Take the value from `emptyStateView`. |
| `closedPage` | `Gtk.Widget` | Your "nothing is open" page. Absent: that state renders nothing. |
| `noAgentPage` | `Gtk.Widget` | Your "no agent found" page. Absent: that state renders nothing. |
| `gate` | `(question) => 'ask' \| 'decline' \| Promise<…>` | Your permission policy, asked **before** the person. See below. |
| `providerOnboarding` | `boolean` | Off by default. On: a new chat with no provider connected shows "Connect a provider" first. |
| `onConversation` | `(record, current) => void` | A new conversation has its session and record; list it. Runs before the widget updates its own view. |
| `onNotice` | `(message) => void` | A line from the agent that is not a transcript entry (it is also logged). |
| `now` | `() => string` | ISO clock for transcript timestamps. Default is the real clock; inject one for screenshots and tests. |

### `gate` can only add restrictions

The agent asks permission through `session/request_permission`. Without `gate`, every question is put
to the person in a dialog. With it, your function sees the question first (`question.view` has the tool,
its kind, locations and raw input) and answers one of two words:

- `'ask'` — show the dialog; the person decides.
- `'decline'` — answer the agent without asking: the question resolves as not answered (`null`), which the
  agent sees as a cancelled request.

There is **no answer that approves.** A host may narrow what the agent gets ("never in this directory",
"not while unattended"); it cannot hand out an approval nobody gave. The gate is fail-closed: a throw, a
rejected promise or any value other than the literal `'ask'` counts as a decline. `HostGateAnswer` is the
type of the two words.

### `providerOnboarding`

When on, the widget starts a private login server once (bounded to 10 s) to read which providers the agent
has connected. It shows **Connect a provider** only if the agent reports none; browser login and API key
are offered with provider counts, plus **Use free hosted models**, labelled as time-limited and sent to
the hosting provider. An unreadable state shows the ordinary chat: the page is an offer, never a wall.
After a successful login the agent restarts. Nothing here reads or keeps a credential. Core's
`probeConnections` and `onboardingView` are the pieces, if you want the signal elsewhere.

## `LotseChat` members

| Member | Use |
|---|---|
| `open(record)` | Show a stored session. Spawns nothing; the agent starts on the first prompt. Takes `record.turns` as given. |
| `newChat()` | The empty composer; the first prompt creates the session. Keeps a draft. No-op when `hasNewChat` is `false`. |
| `hasNewChat` | Whether a new chat has a directory to run in. Disable your own control when `false`. |
| `showNoAgent()` | Show your `noAgentPage`. |
| `hasLogin`, `openLogin()` | Whether a login can run at all, and open the login dialog. After a login the agent restarts. |
| `prompt(text)`, `clearDraft()`, `stop()` | Drive the composer from code. |
| `snapshot`, `turnRunning`, `agentRunning`, `hasChat`, `openSessionId`, `sendReason` | Read-only state, for enabling your own controls. |
| `dismissPermission(reason)`, `closePermission()`, `closeFailure()`, `closeLogin()` | Take a dialog down, e.g. when your window closes. Call `dismissPermission` first so the reason is recorded. |
| `shutdown()` | **Async.** Aborts the onboarding probe, cancels the running turn, waits, then terminates the agent. Call it from your window's close path and wait for it. |

`stageOnboarding`, `stagePermissionRequest`, `stageConfigOption`, `openModelDropdown`,
`chooseModelInDialog`, `hasModelControl`, `permissionAsked`, `streamed` and `failureShown` exist for
lotse's own dev fixtures and screenshots ([dev-fixtures](../../docs/dev-fixtures.md)); a host does not
need them.

`shutdown()` order matters: it cancels first so the agent can answer `cancelled` and flush, and
terminates only afterwards. Terminating first would lose the work of the turn in flight.

## Other exports

| Export | What it is |
|---|---|
| `HostGateAnswer` | `'ask' \| 'decline'`. |
| `LotseChatOptions` | The options above. |
| `CSS` | The widget's class-name map, for a host that styles its own widgets next to the chat. The stylesheet itself is installed by `LotseChat`; a host needs no CSS of its own. |

## Related

[`@lotse/core`](../core/README.md) · [host guide](../../docs/embedding.md) · [design](../../docs/design/README.md)
(what the widget looks like, with screenshots) · [login](../../docs/login.md)
