# 1. kurier as an embeddable widget

- Status: **Proposed**
- Date: 2026-10-10
- Deciders: Pascal Garber
- Related: [design study](../architecture/embeddable-widget-study.md)

lotse had no ADRs before this one, so it takes number 0001.

## Context

lotse is an AGPL app with the session, agent and login logic inside `app/src/core` and the chat
UI inside a 1356-line `window.ts`. Other GTK apps would like an agent chat without writing their
own ACP client. An LGPL package may not depend on AGPL code ([werkstatt ADR 0003](../../../../docs/adr/0003-apps-are-agpl-packages-are-lgpl.md)),
so the reusable parts have to leave `app/`.

## Decision

1. **Two new LGPL packages.** `@lotse/core` holds the session, agent and login logic moved out
   of the AGPL app. `@lotse/widget` holds a `LotseChat` widget split out of `window.ts`; the
   kurier window becomes one consumer of it.
2. **The host bundles its own agent.** It can ship opencode as Flatpak extra-data, as kurier does.
3. **The host passes its own MCP servers** in ACP `session/new` `mcpServers`. No global opencode
   config is touched.
4. **Each host gets its own data directory.** The bundled agent runs with its own `HOME` and
   `XDG_*` under it, so logins are not shared with the user's opencode.
5. **Permissions stay fail-closed.** A host may wrap the `PermissionGate` with rules of its own;
   a session never grants anything.

### Owner decisions

- The conversation history lives in the **host app's data directory** and is included in the
  host's backups.
- The first consumer is the app **Steuererklärung**.

### Open question

Non-chat one-shot AI jobs (receipt analysis, document classification) are not covered by a chat
widget. Whether kurier gets a headless API for them or they stay on the host's in-process
provider is under study. **Decision pending.**

## Probe result (step 1, done)

opencode **2.0.25** honours `mcpServers` in `session/new`. `scripts/probes/acp-mcp-servers.mjs`
starts `opencode acp` with a scratch `HOME` and `XDG_*` tree and one stdio MCP server exposing
`probe_echo`. No model call, no login. The server log shows
`started | recv initialize | recv notifications/initialized | recv tools/list`: opencode spawned
the server and listed its tools. A server whose command does not exist is **not reported**: `session/new`
returns a normal result (`sessionId`, `configOptions`), no error. A host that needs to know its server is up must
check for itself (the probe's second `session/new` shows this).

## Probe result (step 1, second half, done)

opencode **2.0.25** reports connection state. `scripts/probes/provider-connections.mjs` starts `opencode serve
--port 0` with a scratch `HOME` and `XDG_*` tree and reads `GET /api/integration`: every provider has a
`connections` array, empty in a fresh home. After `POST /api/integration/scaleway/connect/key` with a made-up key
(204) the array holds one entry (`{type: credential, id, label, method}`, no secret) for that provider and the
rest stay empty. No model call, no real credential. ACP carries no equivalent: `authMethods` is the single terminal
method and `session/new` succeeds with no login. Free Zen models need no connection, so "nothing connected" is a
reason to offer a login, not to block the chat.

## Order of work

Planned; steps 1 to 8 are done.

1. Probe `mcpServers` (done, above); probe whether `/api/integration` reports connected providers (done, below).
2. Make paths and settings injectable. **Done:** `LotsePaths` (`packages/core/src/paths.ts` since step 3: data and config dir plus the
   sessions, settings and notices files; a bundled agent's `HOME`/`XDG_*` follow `dataDir`) is built once at the
   app and CLI entry (`lotsePaths()`, defaults and `LOTSE_*` knobs unchanged) and passed down; a host builds
   its own with `lotsePathsUnder(root)`.
3. Create `@lotse/core`. **Done:** `packages/core` (LGPL) holds the agents, the session, the turn, the
   login, the failure classification and the view-model files, with `data/bundled-agents.json`,
   `login-providers.json` and `free-models.json` moved in beside them. The app imports one barrel
   (`packages/core/src/index.ts`); nothing imports a core file by path. The auth policy came along in the
   same step rather than later: it was split between the CLI and a private function in `run.ts`, so a
   window had to re-derive it (`auth.ts`, with `runLogin` and `open` as the surface's hooks).
4. Plumb `mcpServers`. **Done:** `AgentSessionOptions.mcpServers` (ACP `McpServer[]`, type exported from `@lotse/core`)
   goes unchanged into `session/new` and the reattach of a stored session. Absent means `[]` in `session/new`
   and nothing added to a reattach, as before; there is no CLI flag and no GUI setting.

   **What stayed in `app/src/core`**, and why: `paths.ts` (the XDG and `LOTSE_*` resolver — an app's own
   environment, while the `LotsePaths` *shape* moved), `settings.ts` and `settings-view.ts` (one app's
   settings file; a host has its own), `notices.ts` (same, with `NOTICE_IDS` and `noticeDue` moved),
   `session-groups.ts` and `private-file.ts`. `frontends/*` is surface code and was never a candidate.
   The unit tests stayed under `app/tests/unit/core/` with their imports repointed, because one runner
   there is what keeps the dual GJS + Node run working.
5. Create `@lotse/widget`; split `LotseChat` out of `window.ts`. **Done:** `packages/widget` (LGPL) holds
   `LotseChat`, an `Adw.Bin` a host parents anywhere. It owns the whole chat surface — the transcript,
   the composer with its model/effort/mode rows, the tool and thought cards, the permission dialog, the
   failure and login dialogs, and the stack that switches between them. A host passes a resolved
   `AgentCommand`, the cwd a new chat runs in, optional `mcpServers`, three storage callbacks
   (`createSession`, `appendTurns`, `resolveAgent`) and an optional `gate` wrapper — no `LotsePaths`
   and no store, because both are already behind those. The gate is fail-closed by
   construction: it may answer `'ask'` or `'decline'`, and anything that is not literally `'ask'`
   resolves the question as `cancelled` — a host can only narrow what kurier would have asked, never
   widen it.

   **What stayed in the app**, and why: `window.ts` (the shell — the header bar, the notice banner and
   the `Adw.Bin` the widget sits in), `window.blp`, `session-list.ts` (one app's sidebar and its date
   grouping; a host embeds one chat, or brings its own list), `preferences.ts` (this app's settings
   file), `hooks.ts` and `hook-value.ts` (the `LOTSE_APP_*` dev fixtures, an app's own test surface — the
   widget exposes the methods they drive, such as `stagePermissionRequest()` and `openModelDropdown()`,
   and the GLib timers that call them stay here). Two idle pages are app copy, so they are built in
   `window.blp` as top-level `Adw.StatusPage` objects and handed to the widget as `closedPage` and
   `noAgentPage`; the widget decides *when* to show them, the app decides what they say. `win.login`
   stays an app menu action over the widget's `hasLogin`/`openLogin()`.

   The CSS is split the same way: the widget installs its own sheet (`installWidgetCss`, once per display),
   and the app's `APP_CSS` holds its three sidebar rules, so one owner per rule and a host needs no CSS.
6. Inline provider onboarding. **Done:** `LotseChatOptions.providerOnboarding` (off by default). With it, a new chat
   shows an `Adw.StatusPage` — "Connect a provider", the two ways in the login already offers (browser login, API
   key, with the provider counts of the catalog), **Connect a provider…** (the existing login dialog, unchanged) and
   **Use free hosted models**, labelled as time-limited and sent to the hosting provider. The decision is
   `onboardingView` in core (pure, tested on both runtimes): it shows only with the option on, an agent found, a login
   that can run, the catalog reporting **no** connection, and no earlier "free models" choice. Anything unreadable is
   `unknown` and shows the ordinary chat, so the page fails closed into the behaviour that existed before; a turn that
   then fails on a login still gets the auth dialog with **Log in…**. After a successful login the agent restarts and
   the page gives way to the chat. Nothing reads or keeps a credential; the page only counts providers. The kurier
   app itself does not opt in. Dev hook: `LOTSE_APP_ONBOARDING=1` (`docs/dev-fixtures.md`). No connected-state signal was
   added; `probeConnections` is exported for a host that wants one.
7. API docs. **Done:** a README for each package ([core](../../packages/core/README.md),
   [widget](../../packages/widget/README.md)) and the host guide [docs/embedding.md](../embedding.md). The examples are
   type-checked files under `app/tests/examples/`, so the docs follow the signatures.
8. Flatpak module generator from `bundled-agents.json`. **Done:** `flatpakAgentModule` in `@lotse/core` and
   `scripts/flatpak-agent-module`; a test pins the output byte for byte to the module in kurier's own manifest.
9. Host integration in Steuererklärung.

## Consequences

- The relicensing is possible only where the rights are ours; check for outside contributions
  before moving files.
- The host's data directory holds conversation text, here tax data: mode 0700, declared in the
  host's state manifest.
- Splitting `window.ts` is the main cost and regression risk. Measured after step 5: `window.ts`
  1366 → 1048 lines plus a 748-line `chat.ts`, so the seam itself costs around 430 lines of options,
  getters and forwarding. That is the price of a surface a stranger can embed, and the same
  screenshots prove the app did not change (`docs/design/screenshots/`).
- The GUI up to v0.1.1 was a proof of concept. Its look was redone before the split
  ([docs/design/](../design/README.md)), so the widget starts from the new design rather than
  carrying the old one along. The redesign changed visuals only, no behaviour.
