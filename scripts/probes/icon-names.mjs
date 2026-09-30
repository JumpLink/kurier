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

/** Every icon name `app/src/frontends/gui/` hard-codes, with the widget that asks for it. */
const NAMES = [
  // window.ts — the unopened page and the session that replaced it.
  'mail-send-receive-symbolic',
  'utilities-terminal-symbolic',
  // session-list.ts — the empty and unreadable states.
  'dialog-warning-symbolic',
  // transcript-view.ts — the two closed lines.
  'system-run-symbolic',
  'dialog-information-symbolic',
  // composer.ts — the one button, in both of its shapes.
  'send-symbolic',
  'mail-send-symbolic',
  'go-next-symbolic',
  'process-stop-symbolic',
  'media-playback-stop-symbolic',
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
