/**
 * The numbers the chat surface is laid out by, in one file.
 *
 * Only measurements live here — nothing about an app's identity. A `LotseChat` is embedded in
 * somebody else's application, so its id, its name and its version are the host's to decide and
 * are not this package's business (kurier's own are in `app/src/frontends/gui/constants.ts`).
 */

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
 * The plan's number (720) coincides with the app's `COLLAPSE_WIDTH_PX` and **that is a coincidence**:
 * one caps a measure, the other collapses a sidebar. They are separate constants for that reason —
 * and now in separate packages, because collapsing a sidebar is a decision only the app around this
 * widget can make.
 *
 * Delivered by `Adw.Clamp`, which troedler measured as the only thing in this toolkit that caps a
 * natural width *without* also ellipsizing (`Adw.Clamp`'s own docs put it in the middle of the
 * family: a plain `max-width` is not a GTK4 CSS property at all and the stylesheet still loads).
 */
export const CONTENT_MAX_WIDTH_PX = 720;
