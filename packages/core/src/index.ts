/**
 * `@kurier/core` — kurier without a surface.
 *
 * Layer 2, between the protocol (`@kurier/acp`) and whatever is rendering: which agent to start
 * and how to start it, the session a prompt turn runs in, the view models a chat is drawn from,
 * and the provider login. The CLI, the Adwaita window and an embedded widget are three consumers
 * of the same code, which is the whole reason this package exists — see
 * [ADR 0001](../../../docs/adr/0001-kurier-as-an-embeddable-widget.md).
 *
 * **Nothing here knows a toolkit.** No `gi://`, no yargs, no widget: the pieces that need a
 * decision take it as an argument. Paths arrive as a `KurierPaths`, the agent choice as an
 * `AgentChoice`, the permission answer as a `ClientGate`. That is what lets a host put kurier's
 * conversation in its own data directory, and what keeps every file in here testable on Node as
 * well as on GJS.
 *
 * **One door, and it is this file.** The package exports `.` only, so what a consumer may reach is
 * a decision made here rather than a side effect of the directory layout. An export added below is
 * a promise to the widget and to any host; an internal helper stays internal.
 *
 * Empty for one commit: the scaffold lands first so the licence files and the manifest are not
 * read as part of the move diff. The next commit moves the modules in and fills the list.
 */

export {};
