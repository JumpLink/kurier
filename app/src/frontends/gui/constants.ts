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
 * The window's floor size, in logical pixels.
 *
 * **1024×600, and that number is a decision with a reason.** GNOME's HIG asks every app for a
 * minimum *and* a sensible default, and reserves the phone form factor (360×294) for apps that are
 * actually meant to be used on a phone. kurier is not yet: the composer, the config row and the
 * header do not fit together below about 900 px, and a window that is too small to hold its own
 * controls is worse than one that says it needs more room. The 720 px collapse below still makes it
 * usable in a narrow pane; it does not make it a phone app, and nothing in the UI should imply
 * otherwise.
 */
export const WINDOW_WIDTH = 1024;
export const WINDOW_HEIGHT = 600;

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
