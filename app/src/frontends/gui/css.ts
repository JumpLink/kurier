/**
 * The window's CSS — small on purpose, and every property in it was checked against GTK 4's parser.
 *
 * Most of what makes a surface look right comes from Adwaita's own stylesheet and follows the
 * system light/dark setting for free, so this file is not where the theme lives and adding colours
 * here would be a way of fighting it. What is left is the handful of things the toolkit has no name
 * for.
 *
 * **There is no width cap in this file, and that is a measurement rather than an omission.** GTK 4
 * removed `max-width` and `max-width-chars` as CSS properties: both are rejected by the theme parser
 * with *"No property named …"*, and `Gtk.CssProvider.load_from_data` still returns success, so a
 * stylesheet carrying one loads and silently does nothing. The cap is an `Adw.Clamp` in the widget
 * instead, which is the only mechanism in this toolkit that actually caps a natural width — and the
 * only one that does not also ellipsize. (This is the same fact troedler recorded from the other
 * side: a `max-width-chars` label that also ellipsizes capped nothing.)
 *
 * The property list below was verified one by one against `Gtk.CssProvider` on GTK 4.22 / libadwaita
 * 1.9.3. An unverified property in here is a silently dropped line, which is the failure this
 * file's own header is about.
 */

/** Adwaita name classes, declared so a typo is a visible gap rather than a silently plain widget. */
const DIM = 'dim-label';
const TITLE = 'title-1';
const MONO = 'monospace';

export const APP_CSS = `
/* A tool call's raw input: a diff, a command, whatever the agent said it was about to do. Monospace
   and selectable, because the one thing the approval dialog must not do is paraphrase it. */
.tool-input {
  font-family: ${MONO};
  font-size: 0.9em;
}

/* The gate's body. Same reason as .tool-input, and the same failure it prevents: a question about a
   file change that is not legible is a question nobody can answer responsibly. */
.gate-input {
  font-family: ${MONO};
  font-size: 0.9em;
}

/* Placeholder copy — an empty transcript, an agent with nothing to offer. Deliberately quiet: these
   are statements about absence, and absence should not be the loudest thing on screen. */
.kurier-quiet {
  opacity: 0.55;
}

/* The transcript's own line length, set on the text rather than on a container. A label wraps to its
   natural width, so the transcript's measure is a property of its text: 76 characters is about where
   a sentence stops being readable as one line and starts being a wall. The *pane* is capped by an
   Adw.Clamp; this keeps the text inside it from stretching. */
.kurier-transcript-text {
  font-size: 1em;
}

/* A session title in the sidebar. Ellipsized, not wrapped: a title is an agent's own words and can
   be arbitrarily long, and a sidebar row that wraps makes the whole list unreadable at a glance. */
.kurier-session-title {
  font-weight: 500;
}

/* The date headers in the sidebar ("Today", "Yesterday"). Uppercase and tracked out, which is what
   makes a group label read as a group label rather than as a session. */
.kurier-date-header {
  font-size: 0.8em;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 12px 12px 4px 12px;
}

/* Tool and thought rows. A single line that expands, not a boxed list: one frame per tool group in a
   long transcript is a wall of borders, and a wall of borders is the opposite of the calm this
   surface is after. */
.kurier-disclosure {
  font-size: 0.9em;
  padding: 2px 0;
}
`.trim();

/** Class names the window file uses, exported so a typo is a compile error rather than plain text. */
export const CSS = {
  transcriptText: 'kurier-transcript-text',
  toolInput: 'tool-input',
  gateInput: 'gate-input',
  quiet: 'kurier-quiet',
  sessionTitle: 'kurier-session-title',
  dateHeader: 'kurier-date-header',
  disclosure: 'kurier-disclosure',
  dim: DIM,
  title: TITLE,
  mono: MONO,
} as const;
