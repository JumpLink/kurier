# Embedding a Kurier chat in your GTK4 app

A step-by-step guide for a host application written in GJS (TypeScript or JavaScript) with GTK 4 and
libadwaita that wants an agent chat inside its own window. You get a transcript, a composer, tool cards,
an approval dialog and a provider login as **one widget**, `KurierChat`. You bring the window, the
data directory, the agent choice and your own permission policy.

Both packages are LGPL-3.0-or-later, so you may link them into an application under another licence;
changes to the packages themselves stay LGPL. Reference: [`@lotse/core`](../packages/core/README.md),
[`@lotse/widget`](../packages/widget/README.md). Why the line is drawn where it is:
[ADR 0001](adr/0001-lotse-as-an-embeddable-widget.md).

The finished code of this guide is `app/tests/examples/embed.ts`; it is type-checked with the app, so
it matches the signatures.

## 1. Depend on the packages

```json
{ "dependencies": { "@lotse/widget": "*", "@lotse/core": "*", "@lotse/session": "*" } }
```

`@lotse/session` supplies `createSessionStore`, a small JSON store you may use or replace; the widget
only needs two callbacks (step 4). `@lotse/acp` (the protocol layer) comes in transitively.

## 2. Give kurier its own data directory

Kurier writes inside **one directory you choose**. It never reads `HOME`, `XDG_*` or `KURIER_*` for this:
the directory arrives as a `KurierPaths` value.

```ts
const paths = kurierPathsUnder(dataRoot); // <dataRoot>/data/…, <dataRoot>/config/…
```

| Field | Layout under `kurierPathsUnder(root)` |
|---|---|
| `dataDir` | `<root>/data` |
| `sessionsFile` | `<root>/data/sessions.json` — conversations, with their full text |
| `noticesFile` | `<root>/data/notices.json` |
| `configDir`, `settingsFile` | `<root>/config`, `<root>/config/settings.json` — only if you use them |

Pick a place inside your app's own data directory, not a shared one. A **bundled** agent also keeps
its whole private state under `<dataDir>/agents/<id>/{home,config,data,state,cache}`: its `HOME` and
`XDG_*` point there, so it never reads or writes the person's own `~/.config`, `~/.claude` or login.
Moving `dataDir` moves all of it.

`kurierPaths()` (XDG plus `KURIER_*` overrides) belongs to kurier's app, not to the packages — build your
own value.

## 3. Choose the agent

The widget needs an `AgentCommand`. Resolve it with core, which prefers the person's own install and
falls back to a bundled copy:

```ts
const found = resolveDefault(gatherResolveContext(paths, false)); // null: nothing found
const empty = emptyStateView({ agent: found });
```

- `found.command` is what you pass as `agent`; `found.source` (`'host'` or `'bundled'`) is `agentSource`.
- To honour a saved preference, pass an `AgentChoice` as the second argument. The settings file is yours.
- To **bundle** an agent, ship the program the catalog names (`packages/core/data/bundled-agents.json`,
  `bundledProgram`). Kurier's own Flatpak does this; for yours, see [Bundle the agent](#bundle-the-agent-flatpak).
- Inside a Flatpak, probing the person's own agent goes through the host; use the async
  `gatherResolveContextAsync(paths)` there so the window is not blocked.
- When nothing is found, `agent` must still be a command (`requireLauncher(DEFAULT_AGENT)`) and you pass
  `noAgent: empty` so Send is switched off with an explanation. Optionally pass `noAgentPage`, your own
  page, and call `chat.showNoAgent()`.
- For development without a model, use the stand-in agent in [dev-fixtures](dev-fixtures.md).

### Bundle the agent (Flatpak)

Generate the module from the catalog instead of copying kurier's manifest:

```bash
./scripts/flatpak-agent-module opencode --out opencode-module.json   # --arch x86_64 to restrict
```

Put the module in your manifest's `modules`, **before** your own module, and keep `--share=network` in
`finish-args` (the agent runs inside the sandbox). It is `extra-data`: url, sha256 and size come from the
catalog, nothing is downloaded when you generate, and an entry without a checksum fails loudly. In code,
`flatpakAgentModule(agent, arches?)` from `@lotse/core` returns the same object. Kurier's own manifest
carries the identical module (a test compares them byte for byte), so a refresh of the pin reaches you by
regenerating. Then point `agentSource` at `'bundled'`, as above.

## 4. Create the widget

```ts
const chat = new KurierChat({
  agent: found?.command ?? requireLauncher(DEFAULT_AGENT),
  agentSource: found?.source ?? 'host',
  newChat: { cwd: projectDir, home: homedir() },
  createSession: (record) => store.create(record),
  appendTurns: (id, entries) => store.append(id, entries),
  resolveAgent: async (id, source) => resolveRecorded(id, source, gatherResolveContext(paths, false, false)),
  …
});
window.set_content(chat);
chat.newChat();
```

- `newChat.cwd` is where the agent works: its session scope, shown under the composer. Pass the
  directory your user means, not your app's. `null` disables new chats (`chat.hasNewChat`).
- `createSession` and `appendTurns` are your storage. Write them to your own database if you prefer;
  the widget never decides where sessions live. To show an earlier conversation, call
  `chat.open(record)`; it spawns nothing until the first prompt.
- `resolveAgent` makes a stored session resume on the agent copy that holds its history. Leave it out to
  run every session on `agent`.
- `onConversation(record, current)` tells you a new conversation exists, so you can add it to your list.
- Embed it like any widget: the host brings the header bar and the session list. The look is
  [docs/design](design/README.md).

## 5. Pass your MCP servers

`mcpServers: McpServer[]` goes **unchanged** to the agent in `session/new` and on reattach, so the agent
can call your application's tools. Kurier never reads past `type` and never edits the agent's own
config. Stdio servers have `name`, `command`, `args`, `env`; remote ones `type: 'http' | 'sse'`, `url`,
`headers`.

```ts
const mcpServers: McpServer[] = [{ name: 'my-tools', command: '/usr/bin/my-mcp-server', args: [], env: [] }];
```

Authorisation stays with your server: pass credentials as `env` or `headers` only for what the person
may do. Do not rely on the agent's permission dialog to protect your tools; enforce access in the
server (step 6 narrows what the dialog is offered, nothing more).

## 6. Add your permission gate

The agent asks before it acts; the person answers in a dialog. If your app has a policy of its own, pass
`gate`. It runs first and may answer `'ask'` (show the dialog) or `'decline'` (refuse without asking):

```ts
gate: (question) => (question.view.kind === 'delete' ? 'decline' : 'ask'),
```

A gate can **only add restrictions.** There is no answer that approves, and a throw, a rejected promise
or any other value counts as `'decline'`. If your policy code breaks, nothing is approved. Without a
gate, every question goes to the person.

## 7. Onboarding and login

A user without a provider connected would otherwise hit an auth failure on the first prompt. Turn on the
inline offer:

```ts
providerOnboarding: true,
```

The first new chat then shows **Connect a provider** (browser login, API key) and **Use free hosted
models** — when, and only when, the agent reports no connection. An unreadable state shows the ordinary
chat, and a turn that fails on a login still offers **Log in…**. Add an entry of your own with
`chat.hasLogin` and `chat.openLogin()` (for example a menu item). The mechanics, measurements and the
private login server: [login.md](login.md).

Kurier never reads or stores a credential; the agent keeps its own (for a bundled agent: under
`<dataDir>/agents/<id>/`).

## 8. Shut down with the window

The widget owns an agent **subprocess**. Close it when your window closes, and wait for it:

```ts
window.connect('close-request', () => {
  void chat.shutdown().finally(() => window.destroy());
  return true; // hold the window until the agent is gone
});
```

`shutdown()` is async: it aborts the onboarding probe, cancels a running turn, waits for the agent to
answer, then terminates it. Skipping it leaves an `opencode` process behind. If you quit without a
window event, call it from your application's shutdown path as well.

## 9. Back up and protect the data directory

`<dataRoot>` holds conversation text (and, for a bundled agent, the agent's own login). It is the
contents of people's work:

- **Mode `0700`** on `<dataRoot>`. Kurier creates its own files `0600` and its subdirectories `0700`;
  you create the root, so you set its mode.
- **Never inside a repository** or a synced public folder.
- **Declare it** in your backup or state manifest: `sessions.json` is irreplaceable user data;
  `agents/<id>/data` holds the agent's login, which belongs in your secret tier (encrypted, never in
  the clear); `agents/<id>/cache` is regenerable.
- Tell your users that the files exist, and how to delete them.

## Privacy: free hosted models never get private data

`@lotse/core` keeps a small list of hosted models that are free and documented as zero-retention
(`FREE_MODELS`, `freeModelFirst`) and sorts them to the top of the model dropdown. It is a **hint**: kurier
never selects a model, hides one or guesses. "Free" still means time-limited, and what you send goes to
the provider that hosts the model; the onboarding page says so.

For a host that handles client or personal data, the rule is yours to enforce:

- Do not let a free hosted model see data that is not already public. A conversation can contain
  everything the agent read through your MCP tools.
- Decide per deployment which models are allowed, and constrain what your MCP servers return, as step 5
  says. The dropdown's order is not a policy.
- If the data is private, point the person at a connected provider with the retention terms you accept,
  or a local model.

## Where to go next

- [`@lotse/widget`](../packages/widget/README.md): every option and member.
- [`@lotse/core`](../packages/core/README.md): agent resolution, session, login, view models.
- [login.md](login.md): how the in-app login works, and what was measured.
- [dev-fixtures.md](dev-fixtures.md): stand-in agent and the `KU_APP_*` hooks, for screenshots and tests.
- [design/README.md](design/README.md): what each state looks like.
