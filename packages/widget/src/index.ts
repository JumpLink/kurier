/**
 * `@kurier/widget` — the chat surface, as a widget a host embeds.
 *
 * Layer 3, above `@kurier/core` and below any application: `KurierChat` is one conversation — the
 * transcript, the composer with its model and mode controls, the tool and thought cards, the
 * approval dialog, the failure notices, the login — and nothing around one. The host brings the
 * window, the session list, the menu and the preferences; see
 * [ADR 0001](../../../docs/adr/0001-kurier-as-an-embeddable-widget.md) for where that line runs and
 * `app/src/frontends/gui/window.ts` for the first consumer on the other side of it.
 *
 * **This package knows a toolkit and no decisions.** GTK 4 and libadwaita are imported here, which
 * is exactly what `@kurier/core` may not do; in return every question a widget in here answers is
 * answered one layer down. A rule added to this package that is not about drawing belongs in core.
 *
 * **One door, and it is this file** — the same rule as `@kurier/core`'s barrel: `package.json`
 * exports `.` plus two deliberate reach-ins, so what a host may construct is a decision made here
 * rather than whatever a consumer could resolve. The two exceptions exist for measurements, not for
 * hosts, and each is one file with no widget in its import graph:
 *
 * - `@kurier/widget/tool-line` — `tool-line.ts` has no imports at all, so kurier's unit test for it
 *   runs on **Node** as well as GJS. Reaching it through this barrel would pull `Adw` in and the
 *   Node half of the dual run would be gone, which is the split `AGENTS.md` calls the entire point.
 * - `@kurier/widget/permission-dialog` — `app/tests/probes/permission-focus.ts` measures where GTK
 *   puts the keyboard focus **on this very widget**, which a look-alike built from `Adw.AlertDialog`
 *   cannot answer (the probe's own header records the time the two disagreed). A host has no use for
 *   the dialog on its own: `KurierChat` raises it, and a host's say over it is `gate`.
 */

export { KurierChat, type HostGateAnswer, type KurierChatOptions } from './chat.ts';

// The stylesheet is installed by `KurierChat` itself; only the class-name map is public, for a host
// that styles its own widgets next to the chat (kurier's app reuses `calm`).
export { CSS } from './css.ts';
