#!/usr/bin/env -S gjs -m
/**
 * Which icon names this window's comments claim exist, actually exist?
 *
 * `window.ts`, `transcript-view.ts` and `composer.ts` all say their icon names were checked with
 * `Gtk.IconTheme.has_icon`, and each one records a name that turned out to be *absent* —
 * `chat-symbolic`, `lightbulb-symbolic`, `dialog-question-symbolic` — because a name the Adwaita
 * theme does not have renders as a broken-image placeholder and a screenshot looks like a bug
 * nobody can name. This prints the answer for a list, so the comments can be re-checked instead of
 * believed — and so a name that stops existing is a line here, not a mystery in a PNG.
 *
 *   gjs -m scripts/probes/icon-names.mjs [name…]
 *
 * The default list is every name the surface hard-codes. Run it with no argument after adding one;
 * a name that prints `MISSING` is the broken-image placeholder on screen.
 */
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';

/**
 * Every icon name `app/src/frontends/gui/` hard-codes, with the widget that asks for it.
 *
 * **Names in use, and only those** — so a `MISSING` here is a broken-image placeholder somewhere on
 * screen rather than an expected line. The absent names the comments record as findings
 * (`send-symbolic`, `arrow-up-symbolic`, `chat-symbolic`, `lightbulb-symbolic`,
 * `dialog-question-symbolic`) are re-checked by passing them as arguments; keeping them in this list
 * would make every run report a miss and there would be nothing left for a real one to say.
 */
const NAMES = [
  // window.blp — the unopened page, the session that replaced it, and the no-agent page.
  'mail-send-receive-symbolic',
  // window.blp — the sidebar's New chat button and the window menu.
  'list-add-symbolic',
  'open-menu-symbolic',
  // session-list.ts and window.blp — the empty and unreadable states.
  'dialog-warning-symbolic',
  // transcript-view.ts — the thought card's closed line.
  'dialog-information-symbolic',
  // composer.ts — the one button, in both of its shapes.
  'go-up-symbolic',
  'process-stop-symbolic',
  // login-dialog.ts — the method rows.
  'go-next-symbolic',
  // tool-line.ts — the icon a tool card and the approval dialog's header pick from the tool's kind,
  // and the fallback for a line that matches none of them.
  'document-open-symbolic',
  'document-edit-symbolic',
  'edit-delete-symbolic',
  'folder-symbolic',
  'edit-find-symbolic',
  'network-workgroup-symbolic',
  'system-run-symbolic',
  // window.blp — the no-agent page's copy button.
  'edit-copy-symbolic',
];

Adw.init();

// `get_for_display`, not the global `Gtk.IconTheme.get_default()`: the global default is null until
// a display has been opened, and `has_icon` on it would throw rather than answer.
const display = Gdk.Display.get_default();
if (!display) throw new Error('no display — a GUI probe needs a session bus, run it from the desktop');
const theme = Gtk.IconTheme.get_for_display(display);
const asked = ARGV.length > 0 ? ARGV : NAMES;
let missing = 0;
for (const name of asked) {
  const has = theme.has_icon(name);
  if (!has) missing += 1;
  print(`${has ? 'ok     ' : 'MISSING'} ${name}`);
}
print(`\n${asked.length - missing}/${asked.length} present`);
