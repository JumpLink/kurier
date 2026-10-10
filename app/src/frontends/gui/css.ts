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
   file change that is not legible is a question nobody can answer responsibly.

   The radius is the one thing here that is not about legibility. A \`Gtk.TextView\` paints its own
   \`@view_bg_color\` with square corners, which left the raw input as the only hard-cornered surface
   in the window — in the middle of a rounded dialog. 12 px is \`card\`'s own, the same as a tool card:
   this block is the dialog's version of one. */
.gate-input {
  font-family: ${MONO};
  font-size: 0.9em;
  border-radius: 12px;
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

/* The open session's row in the sidebar. One line, not a theme rule, because a \`Gtk.ListBox\` in
   \`SelectionMode.NONE\` never puts \`:selected\` on a row — so the theme's own selected-row rule can
   never fire here and the mark has to be one this file applies. The alpha is the theme's:
   \`libadwaita.css\` gives \`.navigation-sidebar row:selected\` \`currentColor\` at 10%, and the same
   value keeps the mark from reading as a second kind of emphasis. */
.navigation-sidebar > row.kurier-open-row {
  background-color: alpha(currentColor, 0.10);
}

/* A message bubble — **the person's own messages only**, which is what makes it a bubble rather than
   a row type. Adwaita has no name for one: \`Adw.StatusPage\`'s icons and \`.card\` are the toolkit's
   idea of an inset surface, and a card per message is a wall of borders in a long conversation. So
   the two things a bubble needs are written out; \`border-radius\` and \`padding\` were verified against
   the GTK 4.22 parser along with the properties above.

   NO \`margin-bottom\`, and that is the rhythm fix rather than a deletion. The column already carries
   \`ITEM_SPACING\` between its children (\`transcript-view.ts\`), so a margin here was a second gap —
   and two gaps that only one file knows about is how the spacing between a bubble and the caption
   above it came out different from the spacing between two bubbles. */
.kurier-bubble {
  border-radius: 18px;
  padding: 10px 14px;
}

/* The person's own messages, in the accent colour. \`@accent_bg_color\` is a libadwaita named colour,
   so this follows the system light/dark setting for free — the reason this file is not a palette.
   Alpha, not solid: a solid accent block is a header, and a transcript of ten of them is a wall. */
.kurier-bubble-user {
  background-color: alpha(@accent_bg_color, 0.15);
}

/* The agent's answer, which is **not** in a bubble at all — and that asymmetry is the decision this
   class carries. A bubble is right for a short line somebody typed and wrong for the thing the
   person came to read: an answer is the page's body text, and boxing it costs the reading column its
   two side paddings while adding an edge the eye has to cross on every paragraph. Every chat surface
   this window is drawn from does the same, and HIG says it about documents generally.

   So what is left is line spacing. \`line-height\` parses on GTK 4.22 **and applies** — measured, a
   four-line label grows 71 px → 103 px with this value, which is the check \`css.ts\` demands of every
   property in it: the parser accepting one proves nothing about it doing anything. */
.kurier-agent-text {
  line-height: 1.45;
}

/* A centred system note — a plan, a mode change, an update this client does not know. Quieter than
   a bubble because it is neither speaker: the conversation's own bookkeeping should not be the most
   prominent thing on screen. \`opacity\` rather than a lighter colour, so it composites over whatever
   the surface behind it is. */
.kurier-note {
  font-size: 0.9em;
  opacity: 0.66;
}

/* The body under a disclosure's summary line, and nothing about its type. \`margin-left\` is
   \`Gtk.Expander\`'s own title indent, measured rather than guessed — the expander spans the full
   696 px measure and GTK4 does NOT indent its child, so the 38 px here is what puts the body under
   the summary text instead of 38 px to its left (the arrow plus its spacing). That is the one
   number in this file coupled to a theme's arrow width: a theme that draws a different arrow moves
   the summary and leaves this behind.
   NO \`font-size\` here, and that is a measurement: \`font-size\` is not inherited as a computed value,
   it multiplies down the tree, so a second \`0.9em\` on a descendant of \`.kurier-disclosure\` rendered
   it at 0.81em — measured, 20 'i's came out 197 px wide at the intended size and 181 px inside the
   expander. It inherits the expander's \`0.9em\`, which is the size that was wanted.
   No \`font-family\` either, so the two bodies below can differ: a command is monospace and a
   thought is prose. */
.kurier-disclosure-body {
  margin-left: 38px;
  margin-top: 4px;
  margin-bottom: 8px;
}

/* A thought's body. Proportional and dimmed, where a tool's output is monospace at full weight: a
   model's reasoning is commentary on the answer, and at the answer's own weight it competes with it.
   \`opacity\` rather than a lighter colour, so it composites over whatever surface is behind it. */
.kurier-thought {
  opacity: 0.72;
}

/* The composer's card, and this rule is deliberately only the two things Adwaita's \`card\` does not
   decide. The background, the shadow and both colour schemes come from \`card\` itself (the widget
   carries both classes, see \`composer.ts\`), where the first version of this rule wrote out an
   \`alpha(@window_fg_color, …)\` of its own — a second opinion about a surface the theme already
   names, and one that went flat against the raised bottom bar it sat on.

   The radius is wider than \`card\`'s 12 px because this card is the composer's whole footprint, and a
   tall surface at a small radius reads as a dialog. It matches \`.kurier-bubble\`, which is the other
   thing in this window shaped like a message.

   The margin is what makes it *float*: the bottom bar is \`flat\` now (\`window.blp\`), so nothing is
   drawn behind this and the gap is the window's own background. Bottom larger than top, because
   below it there is only the window edge while above it there is the transcript's own margin. */
.kurier-composer-frame {
  border-radius: 18px;
  margin: 6px 12px 12px 12px;
}

/* The entry itself. Nothing visual: the frame is the surface and the text needs no class of its own,
   which is why this rule is a marker rather than a style. It exists so the two are independently
   targetable — the frame's background belongs to the window, the entry's text does not — and so a
   future monospace mode has one place to land. */
.kurier-composer-entry {
  background-color: transparent;
}

/* The composer's status line: why the button is disabled, or what is happening right now. Caption-sized
   because it is the quietest thing in the bottom bar — \`margin-top\` is 0 because the vertical box
   already has \`spacing: 2\`; a second gap is two gaps.

   NO \`opacity\` here, and that is deliberate rather than an oversight. \`.kurier-composer-reason\` was
   dimmed as a rule (\`composerReason\`), which was right when the line only ever said "here is what is
   wrong". A *running* turn is not that: "Working — the agent is answering" at 55% opacity reads as a
   disabled caption rather than as the window telling them to wait, and the whole job of the line is to
   distinguish the two. The dimming now happens per-render instead, where the surface knows which of the
   two it is drawing — see \`Composer.#render\`. */
.kurier-composer-status {
  margin-top: 0;
  margin-bottom: 6px;
  /* \`margin-left\`/\`margin-right\`, not the GTK 3 names \`margin-start\`/\`margin-end\`: GTK 4 has no
     logical margins in CSS, and the parser rejects them with "No property named …" **while still
     loading the rest of the stylesheet** — so the sheet works and the warning is easy to miss. Both
     logical names were measured as a warning on GTK 4.22.5. */
  /* 14px lines the caption up with the entry's first character: the composer's row is inset 6 px
     inside the card and the \`Gtk.TextView\` adds 8 px of its own text margin. A number that does not
     add up to those two is a caption that hangs under nothing. */
  margin-left: 14px;
  margin-right: 14px;
}
/* The config row's control. Nothing visual either — this is a marker like \`.kurier-composer-entry\`,
   so the row's dropdowns can be found by class rather than by walking the tree. It exists because a
   probe (and a screenshot script) has to be able to name "the dropdowns of the config row" without
   knowing how the box below them was assembled. */
.kurier-config-control {
  background-color: transparent;
}

/* A short status or kind word in a capsule (tool status on a transcript card, tool kind in the approval
   dialog). Adwaita's \`pill\` is a button shape and does nothing on a label, so the shape lives here;
   the colour comes from Adwaita's own \`accent\`/\`success\`/\`error\` text classes, tinted behind.

   600 rather than \`bold\`, and 2px rather than 1px: the capsule sits beside \`.kurier-tool-title\` at
   500, and a full bold next to it made the *status* of a call louder than the call. The weight is
   numeric for the same reason \`.kurier-session-title\` is — the two are one scale, and \`bold\` is a
   step off it. */
.kurier-pill {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 0.8em;
  font-weight: 600;
  background-color: alpha(@window_fg_color, 0.08);
}
.kurier-pill.accent {
  background-color: alpha(@accent_bg_color, 0.18);
}
.kurier-pill.success {
  background-color: alpha(@success_bg_color, 0.18);
}
.kurier-pill.error {
  background-color: alpha(@error_bg_color, 0.18);
}

/* A tool call in the transcript, and the weight is what this rule is about. \`card\` supplies the
   surface — Adwaita sets no padding on it, and a row of icon, title and pill touching the edge reads
   as a table cell — but \`card\`'s *raised* surface was the loudest thing in a column whose answer is
   unboxed (\`.kurier-agent-text\`), so the machinery outranked the thing the person came to read. What
   is kept of the card is its shape: the shadow goes and the fill becomes a tint of the foreground,
   which is the trick \`.kurier-thought-card\` already used — the two now differ by one step on one
   scale instead of by kind.

   NO \`border-radius\`, deliberately. \`card\`'s own 12 px is right for a one-line row, and the 18 px of
   \`.kurier-bubble\` and \`.kurier-composer-frame\` belongs to the two surfaces that are a whole message
   tall. Writing the theme's number out here would be a second opinion that drifts from it.

   The padding is one step under the bubble's 10/14, which puts this window's insets on one scale. */
.kurier-tool-card {
  padding: 8px 12px;
  box-shadow: none;
  background-color: alpha(@window_fg_color, 0.05);
}

/* A thought in the same frame as a tool card, one step quieter again, so the answer stays the loudest
   thing in the column. Only the fill: the widget carries both classes and the rule above has already
   taken the shadow off. The body's own dimming is \`.kurier-thought\`. */
.kurier-thought-card {
  background-color: alpha(@window_fg_color, 0.03);
}

/* The title on a tool card. 0.9em is the size \`.kurier-disclosure\` gives a tool line that *expands*,
   and the same call rendered as a card and as a row should not be two type sizes. It was \`heading\` —
   bold at full size — which made a tool's name louder than the agent's sentence under it; the weight
   that is left is the sidebar title's 500, enough to scan a column of them by. The icon is what marks
   the row as machinery. */
.kurier-tool-title {
  font-size: 0.9em;
  font-weight: 500;
}

/* A tool line that carries only a status. It gets no card — there is nothing on it to name — so the
   inset lives here instead: the same 12 px the cards around it pad with, which is what puts its icon
   in their icon column. Without it the row hangs to the left of everything it belongs to, which is
   what made the lone "Done" read as orphaned rather than as the end of the call above it. */
.kurier-tool-status {
  padding: 2px 12px;
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
  bubble: 'kurier-bubble',
  bubbleUser: 'kurier-bubble-user',
  agentText: 'kurier-agent-text',
  note: 'kurier-note',
  disclosureBody: 'kurier-disclosure-body',
  thought: 'kurier-thought',
  composerFrame: 'kurier-composer-frame',
  composerEntry: 'kurier-composer-entry',
  composerStatus: 'kurier-composer-status',
  configControl: 'kurier-config-control',
  openRow: 'kurier-open-row',
  pill: 'kurier-pill',
  toolCard: 'kurier-tool-card',
  toolTitle: 'kurier-tool-title',
  toolStatus: 'kurier-tool-status',
  thoughtCard: 'kurier-thought-card',
  dim: DIM,
  title: TITLE,
  mono: MONO,
} as const;
