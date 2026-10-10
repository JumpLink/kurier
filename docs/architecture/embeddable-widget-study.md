# Study: kurier as an embeddable widget (`@lotse/widget`)

Design study behind [ADR 0001](../adr/0001-lotse-as-an-embeddable-widget.md). Facts are from the repo as of 2026-10-09; items marked **UNVERIFIED** were not measured. The `mcpServers` question was measured on 2026-10-10 (section 3).

## 1. What forms the widget, what moves, what stays

**Constraint:** an LGPL package must not depend on AGPL code. Today everything under `app/src` is AGPL
(`lotse-cli`), including `core/` and `frontends/gui/`. Anything the widget needs must move to `packages/*`.

### Moves to LGPL packages

| Today (AGPL `app/`) | Goes to | Notes |
|---|---|---|
| `core/agent-session.ts`, `turn.ts`, `failure.ts`, `config-row.ts`, `config.ts`, `composer-state.ts`, `conversation.ts`, `transcript.ts`, `transcript-items.ts`, `usage.ts`, `scroll.ts`, `interrupt.ts`, `permission.ts`, `policy.ts`, `free-models.ts`, `empty-state.ts` | `@lotse/core` (new, pure, no `gi://`) | The widget's controller layer. `AgentSession` is the heart. Check each for `paths.ts`/`settings.ts` imports; those must become injected options. |
| `core/agents/*` (`catalog`, `detect`, `resolve`, `probe`, `sandbox`, `isolation`, `stdio`, `launcher`, `opencode`, `server`) | `@lotse/core` or `@lotse/agents` | `stdio.ts` spawns child processes, so it must not go into `@lotse/acp` (that package knows no subprocesses). `catalog.ts` imports `app/data/bundled-agents.json`; the data file must move with it, or be injected. |
| `core/login/*` (`api`, `controller`, `flow`, `providers`, `session`) + `app/data/login-providers.json` | `@lotse/core` | No widget code; already shared by CLI and window. |
| `frontends/gui/*` widgets: `composer`, `transcript-view`, `config-row`, `permission-dialog` (+ `.blp`), `failure-dialog`, `login-dialog`, `css`, `constants` (parts) | `@lotse/widget` (GTK/Adw) | |
| `frontends/gui/window.ts` (1356 lines) | **Split.** Extract a `LotseChat` widget (transcript + composer + config row + dialogs + `AgentSession` wiring). The window shell stays. | Biggest cost: `MainWindow` currently mixes shell (NavigationSplitView, session list, actions, preferences) with chat logic. |

### Stays app-only (AGPL)

- `frontends/cli/*`, `index.ts` (yargs CLI).
- `frontends/gui/main.ts`, `window.blp`, `session-list.ts`, `preferences.ts`, `hooks.ts`, `hook-value.ts` (dev hooks).
- `core/paths.ts`, `settings.ts`, `settings-view.ts`, `notices.ts`, `session-groups.ts`. The widget gets paths and
  settings as constructor options; the host decides. `paths.ts` stays the kurier app's resolver.
- `scripts/stand-in-agent.mjs` and the dev fixtures.

`@lotse/session` (LGPL) already fits: the store takes a path.

### What step 3 actually did (2026-10-10)

The tables above are the plan; `packages/core` followed them with four deltas worth recording.

- **The data files moved, they were not made injectable.** `packages/core/data/` holds
  `bundled-agents.json`, `login-providers.json` and `free-models.json`, and `app/data/` is gone. Injection
  is still the right answer for a host that wants its own provider policy (section 5), but it is a
  second decision and this step was a move.
- **The auth policy moved too, and it was not on the list.** It was split between `frontends/cli/auth.ts`
  and a private `describeAuth` in `run.ts`, so a window would have had to re-derive both — the exact
  shape of problem this package exists to end. `packages/core/src/auth.ts` now holds the plan, the
  sentences and the two-handshake flow, with `runLogin` and `open` injected per surface.
- **Three files on the "stays" list were split, not kept whole.** The `LotsePaths` *shape* is core and
  the XDG/`LOTSE_*` resolver is the app's (`paths.ts` both sides); `AgentChoice` and `describeChoice`
  are core and the settings file is the app's; `NOTICE_IDS` and `noticeDue` are core and the notices file
  is the app's. In each case the decision is shared and the file handling is one app's.
- **The tests stayed in `app/tests/unit/core/`** with their imports repointed at the barrel, as the
  `@lotse/acp` and `@lotse/session` tests already do: one runner in `app/tests/test.mts` is what makes
  the dual GJS + Node run possible at all.

### What step 5 actually did (2026-10-10)

`packages/widget` followed the table's `frontends/gui` row exactly — `composer.ts`, `config-row.ts`,
`transcript-view.ts`, `tool-line.ts`, `permission-dialog.ts` (+ `permission-body.blp`),
`failure-dialog.ts` and `login-dialog.ts` moved with no edits at all, in their own commit — and the
split of `window.ts` came out with five deltas worth recording.

- **`css.ts` and `constants.ts` were split rather than moved**, which is what made the move commit
  edit-free. The widget owns `WIDGET_CSS` and `CONTENT_MAX_WIDTH_PX`; `LotseChat`
  installs it itself (`installWidgetCss`, once per display) and the app's `APP_CSS` keeps only its
  three sidebar rules, so a host that embeds the widget alone is styled and no rule is in both sheets. The app's `constants.ts` kept what
  only an app has: the app id, name and version, the window geometry, `COLLAPSE_WIDTH_PX` and the
  dev-hook prefix.
- **The two idle pages are the host's widgets, not the widget's copy.** `closed` and `no-agent` are
  `Adw.Bin` slots in `chat.blp`; kurier's `window.blp` builds two top-level `Adw.StatusPage` objects
  and passes them as `closedPage` / `noAgentPage`. The widget decides *when* they show (it owns
  `noAgent.sendReason` and the `'no-agent'`-vs-`'new'` choice), the host decides what they say.
- **The dev hooks stayed in the app and the widget grew the methods they drive.** `hooks.ts`,
  `hook-value.ts` and every GLib timer are app-only, and they reach the chat through
  `stagePermissionRequest()`, `stageConfigOption()`, `openModelDropdown()`, `dismissPermission()`,
  `closeFailure()` and friends — the same calls a pointer makes, which is the rule
  `AGENTS.md#the-states-only-a-hook-can-reach` already set. `LOTSE_APP_PERMISSION`'s polling loop and
  its `LOTSE_APP_*` log lines did not move.
- **`win.login` stayed an app action.** It is a menu entry, and a menu is the host's; the widget
  exposes `hasLogin` and `openLogin()` and holds the dialog.
- **Two deliberate reach-ins beside the barrel, both for measurements**: `@lotse/widget/tool-line`
  (no imports at all, so the unit test keeps its Node half) and `@lotse/widget/permission-dialog`
  (the focus probe has to measure *this* widget). A host uses neither.

## 2. Embedding API sketch

```ts
class LotseChat extends Gtk.Widget {            // or Adw.Bin
  constructor(opts: LotseChatOptions)
  start(): void; stop(): void; newChat(): void; send(text: string): void
}
interface LotseChatOptions {
  agent: { source: 'bundled' | 'host' | 'auto'; id?: 'opencode' }   // default: bundled, id opencode
  cwd: string                                    // absolute; host decides the workspace
  mcpServers?: McpServer[]                       // opaque ACP objects, forwarded to session/new
  permissions: PermissionPolicy                  // see below
  storage: { dataDir: string; sessionsFile?: string }   // per host app, e.g. $XDG_DATA_HOME/<app-id>/kurier
  isolation?: 'private' | 'none'                 // default 'private' (own HOME/XDG, see isolation.ts)
  catalog?: BundledCatalog                       // host injects its own bundled-agents data
  features?: { sessionList?: boolean; modelPicker?: boolean; loginInline?: boolean }
}
```

**Permission policy:** default is the existing fail-closed Adwaita dialog (`permission-dialog.ts`). The host may pass
a `PermissionGate` wrapper that answers *before* asking a person, e.g. "read-only tools of `steuer` auto-allow,
everything else asks". It must never grant by session (guardrail 1: scope is not authority) and must keep
`cancelled` on every path where nobody chose. Auto-allow rules belong to the host, not to kurier.

**Signals:** `state-changed` (AgentSnapshot: attaching/attached/failed/exited), `turn-started`, `turn-finished(stopReason)`,
`session-created(id)`, `permission-requested` (informational; the gate still decides), `failure(kind)`,
`login-requested` / `login-finished`, `title-changed`. Properties: `busy`, `session-id`, `agent-status`.

**Storage per host app:** the options above replace `paths.ts` lookups. The bundled agent's HOME/XDG already go to
`<dataDir>/agents/<id>/` (`isolation.ts`, 0700), so a host passing its own `dataDir` gets its own login; nothing is
shared with the user's `~/.config/opencode` or with the kurier app.

### What the options became (step 5, 2026-10-10)

The sketch above is what was asked for; `LotseChatOptions` in `packages/widget/src/chat.ts` is what
shipped, and the differences are all in the same direction — fewer things the widget decides.

| Sketch | Shipped | Why |
|---|---|---|
| `agent: {source, id?}` | `agent: AgentCommand` + `agentSource?` | Resolution is the host's: it already ran `resolveAgent`/`gatherResolveContext` for its own preferences and status, and a second resolver inside the widget would be a second answer. |
| `storage: {dataDir, sessionsFile?}` | `createSession?`, `appendTurns?`, `resolveAgent?` callbacks | A host that lists sessions keeps its own handle on the file; the widget's two writes (one record, one line per chunk) have nothing to do with each other, and a `SessionStore` would drag `all`/`update`/`remove` in beside them. |
| `isolation?`, `catalog?` | — (gone) | Both are decided before an `AgentCommand` exists. The command the host passes already carries its own `HOME`/`XDG_*`. |
| `permissions: PermissionPolicy` | `gate?: (q) => HostGateAnswer \| Promise<HostGateAnswer>`, `HostGateAnswer = 'ask' \| 'decline'` | A policy object invites an allow rule. Two words cannot express one: anything that is not literally `'ask'` — including a throw, a rejection or an unexpected value — resolves the question `cancelled`. |
| `features?: {sessionList, modelPicker, loginInline}` | — (gone) | No session list to switch off (it never entered the widget), and the other two are facts rather than preferences: `hasModelControl` is whether the agent offered one, `hasLogin` whether this agent can log in. |
| `start()`, `send(text)` | `open(record)`, `newChat()`, `prompt(text)`, `stop()`, `shutdown()` | There is no "start" without a conversation; a host either opens a stored record or starts a new chat. |
| Signals (`state-changed`, `turn-started`, …) + properties | `onConversation`, `onNotice` callbacks; getters (`turnRunning`, `agentRunning`, `openSessionId`, `snapshot`, …) | GObject signals were not needed by the first consumer, so they were not invented for it. The getters are what kurier's window actually reads; a signal can be added when a second host wants one. |
| — | `closedPage?`, `noAgentPage?`, `noAgent?`, `mcpServers?`, `now?` | The two host slots (above), the pass-through MCP list, and an injected clock so a screenshot run is the only place a real one is used. |

## 3. Host MCP server via `session/new`

- **Schema:** yes. `refs/acp/schema.v1.json` `NewSessionRequest` has required `mcpServers: McpServer[]`
  (also on `LoadSessionRequest`, line ~3324, and the third request at ~4562). `McpServer` is `anyOf` Http / Sse / Stdio.
  `McpServerStdio` = `{name, command (absolute path), args[], env[{name,value}]}`. Http/Sse are gated by the agent's
  `mcpCapabilities`; opencode 2.0.19 advertises `{"http":true,"sse":false}` ([the measured handshake](../../refs/acp/SOURCE.md#what-one-real-agent-answers)), stdio is the baseline.
- **kurier today:** `AcpClient.newSession` / `reattach` already accept `mcpServers` (`packages/acp/src/client.ts:227-242`)
  and forward them opaquely. Every call site passes `[]`: `packages/core/src/agent-session.ts:682`, `app/src/frontends/cli/start.ts:97`,
  `resume.ts:104`, `cancel.ts:67`. The plumbing is `AgentSessionOptions.mcpServers` (step 4, done).
  Note `reattach` must receive the same list, otherwise a resumed session loses the tools.
- **Does opencode honour it? Yes, measured** with opencode 2.0.25 by `scripts/probes/acp-mcp-servers.mjs` (scratch HOME and XDG dirs, no model call, no login): after `session/new` the stdio server was spawned and received `initialize`, `notifications/initialized` and `tools/list`. Measured too: an entry whose command does not exist gets no error in the `session/new` response, which still succeeds (whether it is logged elsewhere was not measured).
- **Steuererklärung:** `steuer mcp` is a yargs command (`app/src/frontends/cli/mcp.ts`), default `--transport stdio`.
  The host passes `{type:'stdio', name:'steuer', command:<abs path of the steuer binary>, args:['mcp'], env:[…]}`. The
  `command` must be absolute and executable *inside the sandbox*. If steuer runs in the same Flatpak, that is its own
  `/app/bin/steuer`. `cwd` matters: steuererklaerung finds `.env` via `DOTENV_CONFIG_PATH` and its JSON via cwd, so pass
  those through `env` / `cwd` rather than assuming. No global opencode config is touched.
- The MCP server's gate (read-only fail-closed) still applies; the permission policy in section 2 is a second, separate layer.

## 4. Bundling

- **Data:** `packages/core/data/bundled-agents.json` lists agents with per-arch `dist` (url, sha256, size), `command` (`["acp"]`),
  flag-only `env` (e.g. `OPENCODE_DISABLE_AUTOUPDATE`), `installPath` and `binary`. `scripts/refresh-bundled-agent` updates it.
- **Prefix:** `BUNDLED_PREFIX = '/app/extra/agents'` in `packages/core/src/agents/catalog.ts` (the only place it is written;
  `installPath` must equal `${BUNDLED_PREFIX}/${id}`, validated by `parseBundledCatalog`). Not `/app/bin`, so it doesn't
  shadow a host opencode. `/app/extra` because the archive is Flatpak `extra-data` and `apply_extra` can only write there.
- **Detection:** `detect.ts` (pure) ignores any host hit under the prefix; `resolve.ts` picks setting > first host > first
  bundled; `probe.ts` gathers the facts. A bundled copy runs inside the sandbox (`AgentCommand.bundled`, no `toHostCommand`).
- **Manifest recipe** (from `eu.jumplink.Lotse.json`), what a host app must copy:
  1. An `opencode` module: `extra-data` sources per arch (url, sha256, size) + a script source `apply_extra` that does
     `mkdir -p /app/extra/agents/opencode`, untars, `chmod 0755 …/package/bin/opencode`, removes the tarball.
  2. Same `installPath` so `BUNDLED_PREFIX` matches. A host that wants another prefix needs the prefix injectable.
  3. finish-args: `--share=network` (provider calls, OAuth), `--filesystem=host` is what kurier uses; a host should prefer
     narrower access (the workspace dir only) and avoid the `--talk-name=org.freedesktop.Flatpak` unless it launches host agents.
- Both the version pin and the checksum live in two places (manifest and JSON). A host should generate the module from the
  JSON, e.g. a `lotse-flatpak-module` script in the widget package, or drift will occur.
- Extra-data downloads at install time, so there is no offline first run. A host needs an empty state for "agent not yet unpacked".

## 5. Provider onboarding

Exists today:
- `core/login/*`: `LoginController` (no widget), `flow.ts` (one attempt, no clock), `api.ts` (transport-agnostic),
  `providers.ts` reads opencode's catalog (229 providers; 10 OAuth, 228 key) with `login-providers.json` (featured order,
  European providers, excluded ones). `server.ts` starts a private `opencode serve --port 0` on 127.0.0.1 with an in-memory
  Basic-auth password and the same isolation env.
- `frontends/gui/login-dialog.ts` (352 lines) renders it; `failure-dialog.ts` offers **Log in…** on an `auth` failure.
- CLI: `lotse login`, `lotse auth`. No credential is stored by kurier: opencode keeps it, an API key lives in memory for one call.
- Model choice: `config-row.ts` with `free-models.json` ordering.

Widget needs:
- **Inline provider page** instead of only a dialog opened after a failure. First run with no connected provider shows:
  provider list (featured + European first) -> method (browser / key) -> progress -> "ready". A widget property or signal
  tells the host whether a provider is connected. **Measured (opencode 2.0.25, `scripts/probes/provider-connections.mjs`):**
  `GET /api/integration` carries `connections` per provider (empty in a fresh home, one credential-id entry after a
  connect), so no attempt-and-fail probe is needed. ACP reports nothing of the kind. **Built as step 6:** an offer
  (`providerOnboarding`), not a wall, because the free hosted models work with no connection; an unreadable state shows
  the ordinary chat and the auth failure dialog stays the fallback. No signal yet: a host that wants one can read
  the same `probeConnections`.
- The login dialog should become a reusable `Adw.NavigationPage` / `Gtk.Widget` content, the dialog being a thin wrapper.
- Login must run under the host's isolation dir so credentials land in the host app's agent store (already how `server.ts` works).
- Provider data policy: the `xai` exclusion and featured lists are kurier decisions; make `login-providers.json` injectable.
- Browser OAuth in a Flatpak needs `xdg-open` via portal (`Gtk.UriLauncher`) rather than spawning a browser.

## 6. Steps, sizes, risks

| # | Step | Size |
|---|---|---|
| 1 | Probe: does opencode honour `mcpServers` (scratch HOME, trivial stdio MCP)? Does `/api/integration` report connected providers? (yes, measured) | S |
| 2 | **Done** (`LotsePaths`, see the ADR). Make paths/settings injectable: remove `paths.ts` / `settings.ts` imports from the files that will move; define `LotseChatOptions` | M |
| 3 | **Done** (`packages/core`, see the ADR for what stayed behind). Create `@lotse/core` (LGPL): move `core/agents/*`, `agent-session`, `turn`, `failure`, `login/*`, view-model files; move `bundled-agents.json` + `login-providers.json` + `free-models.json` or make them injectable; keep the tests green on GJS and Node | L |
| 4 | **Done** (`AgentSessionOptions.mcpServers`). Plumb `mcpServers` through `AgentSession` (new + reattach) and the permission-policy hook; unit tests with the fixture agent | S |
| 5 | **Done** (`packages/widget`, see above for the deltas). Create `@lotse/widget`: move leaf widgets (`composer`, `transcript-view`, `config-row`, dialogs, css); then extract `LotseChat` from `window.ts`, with `MainWindow` consuming it. Blueprint (`.blp`) compile must work from a package | L |
| 6 | **Done** (`onboarding.ts` in core, `onboarding-page.ts` in the widget; see the ADR). Inline provider onboarding page; the connected-state signal was left out | M |
| 7 | Public API: signals/properties, docs, an example host app, license files (`LICENSE` + `COPYING`), `gjsify foreach` checks | M |
| 8 | Flatpak module generator from `bundled-agents.json`; make `BUNDLED_PREFIX` configurable | M |
| 9 | Steuererklärung integration: replace the assistant's `getLLMProvider` chat (`core/actions/assistant/chat.ts`, `engine-status.ts`) with `LotseChat` and the injected `steuer mcp` server. The other three users of `getLLMProvider` (`classify-documents.ts`, `extract-invoice.ts`, `review-metadata.ts`) are headless one-shot document analysis; they stay on the in-process provider unless a headless kurier API is added. | M |

**Risks**
- ~~`window.ts` is a 1356-line god-class; splitting it is the real cost and the likeliest source of regressions
  (GTK construction-order comments in the file warn about exactly this).~~ **Done in step 5**: 1366 → 1048 lines
  plus a 748-line `chat.ts`. The construction order was the real hazard and it is now written down twice — the
  widget's `#config` before its `AgentSession` before its `Composer`, and the window's `#applyBreakpoint()` only
  after its content is set. Blueprint from a package needed no new tooling, but **no file in this repo may use
  named imports from a `.blp`**: `tsc` has no `allowArbitraryExtensions` here, so `declare module '*.blp'` answers
  first with a default-only module (TS2614). `window.ts` and `chat.ts` both use a literal `InternalChildren` array
  with hand-declared fields and import only the default.
- The AGPL -> LGPL move relicenses nothing as long as it is Pascal's own code (single copyright holder; check for outside
  contributions before moving). Third-party deps (`@gjsify/adwaita-app` is used in `main.ts`/`hooks.ts`) must be LGPL-compatible.
- A server that fails to start may be dropped silently; the host needs a way to notice a missing tool.
- Two copies of the agent version pin (manifest vs JSON); drift.
- `--filesystem=host` weakens the isolation story: the bundled agent can read the real home. HOME is redirected, but the files are reachable.
- The AGPL host (Steuererklärung) embedding LGPL code is fine; the reverse direction must never appear.
- Privacy: the widget's session store holds conversation text, and for Steuererklärung that is tax data. The host's `dataDir` must be
  0700 and declared in the host's `.werkstatt-state.json`; free/hosted models must not see Mandant data (werkstatt privacy rule), so
  the featured provider list should not steer users to Zen for that app.
- Headless callers (3 of the 5 `getLLMProvider` files) are not covered by a chat widget at all.
- Still UNVERIFIED: whether `/api/integration` reports connected providers (section 5).
