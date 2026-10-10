/**
 * The app's CSS: the chat widget's sheet plus the three rules that are this window's own.
 *
 * **One provider, one sheet, and that is the reason this file concatenates rather than loads.**
 * `@kurier/widget` hands over its rules as a string (`WIDGET_CSS`) instead of installing a
 * `Gtk.CssProvider` of its own, because two providers on one display is a second opinion about
 * priority and an embedded widget cannot decide that for the app around it. So the app owns the
 * provider (`main.ts`) and this file owns what goes into it.
 *
 * What is left here is what the *window* has and a chat has not: the sidebar. Everything about the
 * transcript, the composer, the tool cards and the approval dialog travelled with the widget, along
 * with the header that records how each property in it was verified against GTK 4's parser — read
 * `packages/widget/src/css.ts` before adding one.
 *
 * `.kurier-calm` is the one class that crosses the line: the rule is the widget's (its own empty
 * states carry it) and `window.blp`'s idle and no-agent pages carry it too, which is what makes
 * them look like the pages the widget would have drawn there.
 */

import { CSS as WIDGET_CSS_CLASSES, WIDGET_CSS } from '@kurier/widget';

/** Adwaita name classes, declared so a typo is a visible gap rather than a silently plain widget. */
const DIM = 'dim-label';

export const APP_CSS = `
${WIDGET_CSS}

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

/* The open session's row in the sidebar. One line, not a theme rule, because a \`Gtk.ListBox\` in
   \`SelectionMode.NONE\` never puts \`:selected\` on a row — so the theme's own selected-row rule can
   never fire here and the mark has to be one this file applies. The alpha is the theme's:
   \`libadwaita.css\` gives \`.navigation-sidebar row:selected\` \`currentColor\` at 10%, and the same
   value keeps the mark from reading as a second kind of emphasis. */
.navigation-sidebar > row.kurier-open-row {
  background-color: alpha(currentColor, 0.10);
}
`.trim();

/**
 * Class names the app's own files use, exported so a typo is a compile error rather than plain text.
 *
 * The sidebar's three, plus `calm` for the window's idle pages — the widget's map
 * (`CSS` from `@kurier/widget`) has the chat's.
 */
export const CSS = {
  sessionTitle: 'kurier-session-title',
  dateHeader: 'kurier-date-header',
  openRow: 'kurier-open-row',
  calm: WIDGET_CSS_CLASSES.calm,
  dim: DIM,
} as const;
