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
 * **`eu.jumplink.*`, like everything else in the workspace.** First written as `de.jumplink.Kurier`
 * and corrected — one string in one file, but an app id is a reverse-DNS name that has to agree with
 * the session bus, the WM_CLASS, the desktop entry and the AppStream metainfo, and a second
 * convention is a second thing to keep in step. `learn6502` (`easy6502/packages/app-gnome`) is the
 * model: `eu.jumplink.Learn6502`, with the value overridable at build time rather than hardcoded.
 */
export const APP_ID = 'eu.jumplink.Kurier';

/** What the window and the about dialog call the app. */
export const APP_NAME = 'kurier';

/** Read from the package so the about dialog cannot drift from the installed version. */
export const APP_VERSION = '0.1.0';

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
 * **360 px, the phone form factor, and the history of the 480 it replaced is worth keeping.** The
 * first version asked for `widthRequest: 480` on the reasoning that the collapsed conversation plus
 * its composer stop being usable below that, and 480 sat "deliberably above the 360×294 a phone app
 * would have to claim". That reasoning was never measured — it was asserted, and it was wrong.
 * `scripts/probes/window-min-width.mjs` is the measurement that replaced it, on GTK 4.22.5 /
 * libadwaita 1.9.3:
 *
 * | asked | granted, floor 480 | granted, floor removed |
 * | ----- | ----------------- | ---------------------- |
 * | 420   | 480 (clamped)     | 420                    |
 * | 360   | 480 (clamped)     | 360                    |
 * | 320   | 480 (clamped)     | 320                    |
 * | 280   | 480 (clamped)     | 280                    |
 *
 * `widthRequest` was the *only* constraint. Asked for its preferred width, no contributing widget —
 * the composer's row, the bubbles, the transcript column, the `Adw.Clamp`, the collapsed header bar —
 * claims a minimum anywhere near 480; the same unmodified tree grants 280 and even 200 with zero
 * Gtk-WARNINGs at each. So 480 was never a property of the layout, only of a number somebody typed.
 *
 * **Why 360 and not the 200 the content allows.** The layout survives narrower than any phone, and
 * a floor below the form factor would let a window shrink to a shape nobody asked for and nobody can
 * read. 360 is the narrowest width in common use on a phone, so it is the narrowest width kurier
 * claims; below it the answer is the user's window manager, not this constant. If a real phone form
 * factor later turns out to need less, this is the number to move, and `window-min-width.mjs` is
 * what says whether the content can follow.
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
 * The content's maximum line width, in logical pixels — the conversation's measure.
 *
 * **One number, shared by the transcript and the composer, and that is the whole reason it lives
 * here.** Plan §3 asks for "maximum line width" as a property of the content pane, and the composer is
 * the same column seen from the other end: the entry you type in and the answer above it are one
 * measure, and a cursor at 720 px under a paragraph that wraps at 700 px reads as two different
 * surfaces. Two constants that happen to be equal is a coincidence that survives exactly until
 * somebody changes one of them, so there is one.
 *
 * The plan's number (720) coincides with `COLLAPSE_WIDTH_PX` and **that is a coincidence**: one caps
 * a measure, the other collapses a sidebar. They are separate constants for that reason.
 *
 * Delivered by `Adw.Clamp`, which troedler measured as the only thing in this toolkit that caps a
 * natural width *without* also ellipsizing (`Adw.Clamp`'s own docs put it in the middle of the
 * family: a plain `max-width` is not a GTK4 CSS property at all and the stylesheet still loads).
 */
export const CONTENT_MAX_WIDTH_PX = 720;
