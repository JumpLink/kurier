# 1. kurier as an embeddable widget

- Status: **Proposed**
- Date: 2026-10-10
- Deciders: Pascal Garber
- Related: [design study](../architecture/embeddable-widget-study.md)

kurier had no ADRs before this one, so it takes number 0001.

## Context

kurier is an AGPL app with the session, agent and login logic inside `app/src/core` and the chat
UI inside a 1356-line `window.ts`. Other GTK apps would like an agent chat without writing their
own ACP client. An LGPL package may not depend on AGPL code ([werkstatt ADR 0003](../../../../docs/adr/0003-apps-are-agpl-packages-are-lgpl.md)),
so the reusable parts have to leave `app/`.

## Decision

1. **Two new LGPL packages.** `@kurier/core` holds the session, agent and login logic moved out
   of the AGPL app. `@kurier/widget` holds a `KurierChat` widget split out of `window.ts`; the
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
the server and listed its tools. Not yet measured: whether a server that fails to start is
reported or dropped silently.

## Order of work

Planned, not implemented, except step 1.

1. Probe `mcpServers` (done, above); probe whether `/api/integration` reports connected providers.
2. Make paths and settings injectable.
3. Create `@kurier/core`.
4. Plumb `mcpServers` through `AgentSession` (new and reattach).
5. Create `@kurier/widget`; split `KurierChat` out of `window.ts`.
6. Inline provider onboarding.
7. API docs.
8. Flatpak module generator from `bundled-agents.json`.
9. Host integration in Steuererklärung.

## Consequences

- The relicensing is possible only where the rights are ours; check for outside contributions
  before moving files.
- The host's data directory holds conversation text, here tax data: mode 0700, declared in the
  host's state manifest.
- Splitting `window.ts` is the main cost and regression risk.
