/**
 * The app's CSS: the three rules that are this window's own, and nothing of the chat's.
 *
 * **Two providers on the display, and no rule is in both.** `LotseChat` installs `@lotse/widget`'s
 * sheet itself (`installWidgetCss`), so a host that embeds it alone is styled; the app's provider
 * (`main.ts`) carries only the sidebar.
 *
 * What is left here is what the *window* has and a chat has not: the sidebar. Everything about the
 * transcript, the composer, the tool cards and the approval dialog travelled with the widget, along
 * with the header that records how each property in it was verified against GTK 4's parser — read
 * `packages/widget/src/css.ts` before adding one.
 *
 * `.lotse-calm` is the one class that crosses the line: the rule is the widget's (its own empty
 * states carry it) and `window.blp`'s idle and no-agent pages carry it too, which is what makes
 * them look like the pages the widget would have drawn there.
 */

import { CSS as WIDGET_CSS_CLASSES } from '@lotse/widget';

/** Adwaita name classes, declared so a typo is a visible gap rather than a silently plain widget. */
const DIM = 'dim-label';

export const APP_CSS = `
/* A session title in the sidebar. Ellipsized, not wrapped: a title is an agent's own words and can
   be arbitrarily long, and a sidebar row that wraps makes the whole list unreadable at a glance. */
.lotse-session-title {
  font-weight: 500;
}

/* The date headers in the sidebar ("Today", "Yesterday"). Uppercase and tracked out, which is what
   makes a group label read as a group label rather than as a session. */
.lotse-date-header {
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
.navigation-sidebar > row.lotse-open-row {
  background-color: alpha(currentColor, 0.10);
}
`.trim();

/**
 * Class names the app's own files use, exported so a typo is a compile error rather than plain text.
 *
 * The sidebar's three, plus `calm` for the window's idle pages — the widget's map
 * (`CSS` from `@lotse/widget`) has the chat's.
 */
export const CSS = {
  sessionTitle: 'lotse-session-title',
  dateHeader: 'lotse-date-header',
  openRow: 'lotse-open-row',
  calm: WIDGET_CSS_CLASSES.calm,
  dim: DIM,
} as const;
