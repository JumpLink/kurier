/**
 * The names this surface is known by, in one file.
 *
 * `APP_ID` is a GApplication id and therefore a **filesystem-visible** thing: it decides the
 * session bus name, the window's WM_CLASS, and where a desktop file has to point. It is also a
 * reverse-DNS name that has to match the repository, so it is written out rather than derived —
 * a derived one would change silently with a rename, and the bus name is the kind of thing that
 * breaks in a way nobody can reproduce.
 */

/**
 * The GApplication id. Matches the repository, and the desktop entry that ships with it.
 *
 * **`eu.jumplink.*`, like everything else in the workspace.** First written under `de.jumplink.*`
 * and corrected — one string in one file, but an app id is a reverse-DNS name that has to agree with
 * the session bus, the WM_CLASS, the desktop entry and the AppStream metainfo, and a second
 * convention is a second thing to keep in step. `learn6502` (`easy6502/packages/app-gnome`) is the
 * model: `eu.jumplink.Learn6502`, with the value overridable at build time rather than hardcoded.
 */
export const APP_ID = 'eu.jumplink.Lotse';

/** What the window and the about dialog call the app. */
export const APP_NAME = 'kurier';

/** Read from the package so the about dialog cannot drift from the installed version. */
export const APP_VERSION = '0.1.1';

/**
 * The env prefix for the dev hooks, without a trailing underscore.
 *
 * `KU_` rather than `KURIER_` on purpose: these are read by hand while developing, and the short
 * form is what fits in a `gjsify run … KU_APP_SESSION=…` line without wrapping.
 */
export const DEV_HOOK_PREFIX = 'KU_APP';

/**
 * The window's *default* size, in logical pixels — a default, not a floor.
 *
 * **1024×600, and the number is a decision with a reason.** GNOME's HIG asks every app for a
 * sensible default as well as a minimum. 1024 is a desktop conversation at a readable measure; the
 * floor that actually decides whether kurier fits a phone is `WINDOW_MIN_WIDTH_PX` below, and the two
 * are deliberately not the same number.
 */
export const WINDOW_WIDTH = 1024;
export const WINDOW_HEIGHT = 600;

/**
 * The narrowest width the window claims it can be used at.
 *
 * **360 px, and the number is not a preference — it is the width the toolkit itself arrives at.**
 * `scripts/probes/window-min-width.mjs` sweeps the real window on GTK 4.22.5 / libadwaita 1.9.3, and
 * the first version of this comment quoted the sweep wrongly; both columns are reproducible with the
 * two commands in the probe's header:
 *
 * ```sh
 * gjs -m scripts/probes/window-min-width.mjs 480   # the old floor
 * gjs -m scripts/probes/window-min-width.mjs       # no floor of its own
 * ```
 *
 * | asked | granted, `widthRequest: 480` | granted, no floor |
 * | ----- | --------------------------- | ----------------- |
 * | 420   | 480 (clamped)               | 420               |
 * | 360   | 480 (clamped)               | 360               |
 * | 320   | 480 (clamped)               | 360 (clamped)     |
 * | 280   | 480 (clamped)               | 360 (clamped)     |
 *
 * **The right-hand column is the finding, and it corrects the left one.** With no floor of its own the
 * window grants 420 and 360 and then refuses to go narrower, on a tree where the content could not
 * have been the reason: asked for its minimum, the transcript column wants 126, the composer 153, the
 * content header bar 98 and the sidebar list 138. Nothing in kurier's own layout asks for 360. The
 * limit is `Adw.NavigationSplitView` plus the toplevel chrome, and 360 is where they stop.
 *
 * So the old `widthRequest: 480` was **not** a measurement of this layout, and neither is this one:
 * 480 was a typed literal that clamped a window which would otherwise have stopped at 360 on its own.
 * The number below is the toolkit's, which is why it is also the number to trust when a phone form
 * factor arrives — it needs no argument, only the `widthRequest` to stop lying above it.
 */
export const WINDOW_MIN_WIDTH_PX = 360;

/**
 * Below this width the sidebar collapses and the conversation takes the whole window.
 *
 * The same 720 px `createNavShell` uses, and the same measurement behind it: it is the point where a
 * 300 px sidebar plus a readable conversation stops being possible. Copied rather than imported
 * because kurier builds its own `Adw.NavigationSplitView` — the packaged shell takes a readonly
 * `NavItem[]`, has no list handle for date headers, and no bottom bar for the composer.
 */
export const COLLAPSE_WIDTH_PX = 720;

/**
 * The conversation's measure is `CONTENT_MAX_WIDTH_PX` in `@kurier/widget`, not a constant of this
 * file: it caps the transcript and the composer, which are the widget's, while the 720 above
 * collapses this window's sidebar. The two were always separate decisions that happened to be equal
 * — now they are also in separate packages, which is what keeps a host from changing one and getting
 * the other.
 */
