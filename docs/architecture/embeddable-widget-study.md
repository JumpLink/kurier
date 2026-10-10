# Study: kurier as an embeddable widget (`@kurier/widget`)

Design study behind [ADR 0001](../adr/0001-kurier-as-an-embeddable-widget.md). Facts are from the repo as of 2026-10-09; items marked **UNVERIFIED** were not measured. The `mcpServers` question was measured on 2026-10-10 (section 3).

## 1. What forms the widget, what moves, what stays

**Constraint:** an LGPL package must not depend on AGPL code. Today everything under `app/src` is AGPL
(`kurier-cli`), including `core/` and `frontends/gui/`. Anything the widget needs must move to `packages/*`.

### Moves to LGPL packages

| Today (AGPL `app/`) | Goes to | Notes |
|---|---|---|
| `core/agent-session.ts`, `turn.ts`, `failure.ts`, `config-row.ts`, `config.ts`, `composer-state.ts`, `conversation.ts`, `transcript.ts`, `transcript-items.ts`, `usage.ts`, `scroll.ts`, `interrupt.ts`, `permission.ts`, `policy.ts`, `free-models.ts`, `empty-state.ts` | `@kurier/core` (new, pure, no `gi://`) | The widget's controller layer. `AgentSession` is the heart. Check each for `paths.ts`/`settings.ts` imports; those must become injected options. |
| `core/agents/*` (`catalog`, `detect`, `resolve`, `probe`, `sandbox`, `isolation`, `stdio`, `launcher`, `opencode`, `server`) | `@kurier/core` or `@kurier/agents` | `stdio.ts` spawns child processes, so it must not go into `@kurier/acp` (that package knows no subprocesses). `catalog.ts` imports `app/data/bundled-agents.json`; the data file must move with it, or be injected. |
| `core/login/*` (`api`, `controller`, `flow`, `providers`, `session`) + `app/data/login-providers.json` | `@kurier/core` | No widget code; already shared by CLI and window. |
| `frontends/gui/*` widgets: `composer`, `transcript-view`, `config-row`, `permission-dialog` (+ `.blp`), `failure-dialog`, `login-dialog`, `css`, `constants` (parts) | `@kurier/widget` (GTK/Adw) | |
| `frontends/gui/window.ts` (1356 lines) | **Split.** Extract a `KurierChat` widget (transcript + composer + config row + dialogs + `AgentSession` wiring). The window shell stays. | Biggest cost: `MainWindow` currently mixes shell (NavigationSplitView, session list, actions, preferences) with chat logic. |

### Stays app-only (AGPL)

- `frontends/cli/*`, `index.ts` (yargs CLI).
- `frontends/gui/main.ts`, `window.blp`, `session-list.ts`, `preferences.ts`, `hooks.ts`, `hook-value.ts` (dev hooks).
- `core/paths.ts`, `settings.ts`, `settings-view.ts`, `notices.ts`, `session-groups.ts`. The widget gets paths and
  settings as constructor options; the host decides. `paths.ts` stays the kurier app's resolver.
- `scripts/stand-in-agent.mjs` and the dev fixtures.

`@kurier/session` (LGPL) already fits: the store takes a path.

## 2. Embedding API sketch

```ts
class KurierChat extends Gtk.Widget {            // or Adw.Bin
  constructor(opts: KurierChatOptions)
  start(): void; stop(): void; newChat(): void; send(text: string): void
}
interface KurierChatOptions {
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

## 3. Host MCP server via `session/new`

- **Schema:** yes. `refs/acp/schema.v1.json` `NewSessionRequest` has required `mcpServers: McpServer[]`
  (also on `LoadSessionRequest`, line ~3324, and the third request at ~4562). `McpServer` is `anyOf` Http / Sse / Stdio.
  `McpServerStdio` = `{name, command (absolute path), args[], env[{name,value}]}`. Http/Sse are gated by the agent's
  `mcpCapabilities`; opencode 2.0.19 advertises `{"http":true,"sse":false}` (AGENTS.md handshake), stdio is the baseline.
- **kurier today:** `AcpClient.newSession` / `reattach` already accept `mcpServers` (`packages/acp/src/client.ts:227-242`)
  and forward them opaquely. Every call site passes `[]`: `app/src/core/agent-session.ts:682`, `frontends/cli/start.ts:97`,
  `resume.ts:104`, `cancel.ts:67`. So the widget work is plumbing an option through `AgentSession`, nothing in the protocol layer.
  Note `reattach` must receive the same list, otherwise a resumed session loses the tools.
- **Does opencode honour it? Yes, measured** with opencode 2.0.25 by `scripts/probes/acp-mcp-servers.mjs` (scratch HOME and XDG dirs, no model call, no login): after `session/new` the stdio server was spawned and received `initialize`, `notifications/initialized` and `tools/list`. Remaining risk: if opencode drops an entry it cannot start, the session may still open without an error.
- **Steuererklärung:** `steuer mcp` is a yargs command (`app/src/frontends/cli/mcp.ts`), default `--transport stdio`.
  The host passes `{type:'stdio', name:'steuer', command:<abs path of the steuer binary>, args:['mcp'], env:[…]}`. The
  `command` must be absolute and executable *inside the sandbox*. If steuer runs in the same Flatpak, that is its own
  `/app/bin/steuer`. `cwd` matters: steuererklaerung finds `.env` via `DOTENV_CONFIG_PATH` and its JSON via cwd, so pass
  those through `env` / `cwd` rather than assuming. No global opencode config is touched.
- The MCP server's gate (read-only fail-closed) still applies; the permission policy in section 2 is a second, separate layer.

## 4. Bundling

- **Data:** `app/data/bundled-agents.json` lists agents with per-arch `dist` (url, sha256, size), `command` (`["acp"]`),
  flag-only `env` (e.g. `OPENCODE_DISABLE_AUTOUPDATE`), `installPath` and `binary`. `scripts/refresh-bundled-agent` updates it.
- **Prefix:** `BUNDLED_PREFIX = '/app/extra/agents'` in `core/agents/catalog.ts` (the only place it is written;
  `installPath` must equal `${BUNDLED_PREFIX}/${id}`, validated by `parseBundledCatalog`). Not `/app/bin`, so it doesn't
  shadow a host opencode. `/app/extra` because the archive is Flatpak `extra-data` and `apply_extra` can only write there.
- **Detection:** `detect.ts` (pure) ignores any host hit under the prefix; `resolve.ts` picks setting > first host > first
  bundled; `probe.ts` gathers the facts. A bundled copy runs inside the sandbox (`AgentCommand.bundled`, no `toHostCommand`).
- **Manifest recipe** (from `eu.jumplink.Kurier.json`), what a host app must copy:
  1. An `opencode` module: `extra-data` sources per arch (url, sha256, size) + a script source `apply_extra` that does
     `mkdir -p /app/extra/agents/opencode`, untars, `chmod 0755 …/package/bin/opencode`, removes the tarball.
  2. Same `installPath` so `BUNDLED_PREFIX` matches. A host that wants another prefix needs the prefix injectable.
  3. finish-args: `--share=network` (provider calls, OAuth), `--filesystem=host` is what kurier uses; a host should prefer
     narrower access (the workspace dir only) and avoid the `--talk-name=org.freedesktop.Flatpak` unless it launches host agents.
- Both the version pin and the checksum live in two places (manifest and JSON). A host should generate the module from the
  JSON, e.g. a `kurier-flatpak-module` script in the widget package, or drift will occur.
- Extra-data downloads at install time, so there is no offline first run. A host needs an empty state for "agent not yet unpacked".

## 5. Provider onboarding

Exists today:
- `core/login/*`: `LoginController` (no widget), `flow.ts` (one attempt, no clock), `api.ts` (transport-agnostic),
  `providers.ts` reads opencode's catalog (229 providers; 10 OAuth, 228 key) with `login-providers.json` (featured order,
  European providers, excluded ones). `server.ts` starts a private `opencode serve --port 0` on 127.0.0.1 with an in-memory
  Basic-auth password and the same isolation env.
- `frontends/gui/login-dialog.ts` (352 lines) renders it; `failure-dialog.ts` offers **Log in…** on an `auth` failure.
- CLI: `kurier login`, `kurier auth`. No credential is stored by kurier: opencode keeps it, an API key lives in memory for one call.
- Model choice: `config-row.ts` with `free-models.json` ordering.

Widget needs:
- **Inline provider page** instead of only a dialog opened after a failure. First run with no connected provider shows:
  provider list (featured + European first) -> method (browser / key) -> progress -> "ready". A widget property or signal
  tells the host whether a provider is connected. Needs a "list connected providers" call (**UNVERIFIED** whether
  opencode's `/api/integration` reports connected state; if not, probe by attempting `session/new` and watching for the
  `auth` failure, which is what happens now).
- The login dialog should become a reusable `Adw.NavigationPage` / `Gtk.Widget` content, the dialog being a thin wrapper.
- Login must run under the host's isolation dir so credentials land in the host app's agent store (already how `server.ts` works).
- Provider data policy: the `xai` exclusion and featured lists are kurier decisions; make `login-providers.json` injectable.
- Browser OAuth in a Flatpak needs `xdg-open` via portal (`Gtk.UriLauncher`) rather than spawning a browser.

## 6. Steps, sizes, risks

| # | Step | Size |
|---|---|---|
| 1 | Probe: does opencode honour `mcpServers` (scratch HOME, trivial stdio MCP)? Does `/api/integration` report connected providers? | S |
| 2 | Make paths/settings injectable: remove `paths.ts` / `settings.ts` imports from the files that will move; define `KurierChatOptions` | M |
| 3 | Create `@kurier/core` (LGPL): move `core/agents/*`, `agent-session`, `turn`, `failure`, `login/*`, view-model files; move `bundled-agents.json` + `login-providers.json` + `free-models.json` or make them injectable; keep the tests green on GJS and Node | L |
| 4 | Plumb `mcpServers` through `AgentSession` (new + reattach) and the permission-policy hook; unit tests with the fixture agent | S |
| 5 | Create `@kurier/widget`: move leaf widgets (`composer`, `transcript-view`, `config-row`, dialogs, css); then extract `KurierChat` from `window.ts`, with `MainWindow` consuming it. Blueprint (`.blp`) compile must work from a package | L |
| 6 | Inline provider onboarding page + connected-state signal | M |
| 7 | Public API: signals/properties, docs, an example host app, license files (`LICENSE` + `COPYING`), `gjsify foreach` checks | M |
| 8 | Flatpak module generator from `bundled-agents.json`; make `BUNDLED_PREFIX` configurable | M |
| 9 | Steuererklärung integration: replace the assistant's `getLLMProvider` chat (`core/actions/assistant/chat.ts`, `engine-status.ts`) with `KurierChat` and the injected `steuer mcp` server. The other three users of `getLLMProvider` (`classify-documents.ts`, `extract-invoice.ts`, `review-metadata.ts`) are headless one-shot document analysis; they stay on the in-process provider unless a headless kurier API is added. | M |

**Risks**
- `window.ts` is a 1356-line god-class; splitting it is the real cost and the likeliest source of regressions
  (GTK construction-order comments in the file warn about exactly this).
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
