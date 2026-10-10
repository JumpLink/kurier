#!/usr/bin/env -S gjs -m
/**
 * What actually sets this window's minimum width — measured, per widget.
 *
 * ## The measured numbers (GTK 4.22.5 / libadwaita 1.9.3, 2026-10-01)
 *
 * **`widthRequest` was the only constraint, and it was a decision rather than a measurement.**
 * With the window asking for 480 and the content built exactly as it is, GTK granted 480 and refused
 * 420, 360, 320 and 280 — every one of them clamped back up to 480. With that one property dropped to
 * 1, the *same, unmodified* tree granted 360, 320, 280, 240 and even 200 without complaint, and 0
 * Gtk-WARNINGs at any of them. So no widget in this window has a natural minimum anywhere near 480:
 * the composer's row, the bubbles, the transcript column, the `Adw.Clamp` and the collapsed header bar
 * all compress past a phone's width without being asked to break.
 *
 * | Asked | Granted, floor at 480 | Granted, floor removed |
 * | ----- | --------------------- | --------------------- |
 * | 480   | 480                   | 480                   |
 * | 420   | **480**               | 420                   |
 * | 360   | **480**               | 360                   |
 * | 320   | **480**               | 320                   |
 * | 280   | **480**               | 280                   |
 *
 * ## Per-widget preferred widths
 *
 * The second half of this probe asks each contributing widget for `get_preferred_width()`, which is the
 * `(minimum, natural)` pair GTK uses to decide what a toplevel may be. The minimum is the part that
 * matters for a floor: a widget whose *minimum* is large cannot be squeezed, however small the window is
 * asked to be.
 *
 * ## Why the stylesheet is read from the source rather than pasted in
 *
 * The bubbles' and the composer's padding come from `css.ts`, and a probe with its own copy of those
 * rules would measure a layout nobody ships. So the probe reads `app/src/frontends/gui/css.ts`, takes
 * the `APP_CSS` template literal out of it, substitutes the three name constants, and loads that. If
 * the stylesheet changes, this measures the change.
 *
 *   gjs -m scripts/probes/window-min-width.mjs
 *
 * Needs a display.
 */
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

Adw.init();

/** Wait real frames, not idles: measurement happens on the frame clock. */
function frames(count) {
  return new Promise((resolve) => {
    let left = count;
    const tick = () => {
      left -= 1;
      if (left <= 0) resolve();
      else GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, tick);
    };
    tick();
  });
}

/**
 * The real `APP_CSS`, taken out of the source file.
 *
 * Deliberately not pasted: the whole question is what the shipped padding and margins demand, and a
 * second copy of the stylesheet is a second thing to keep in step with the first.
 */
function loadRealStylesheet() {
  const path = GLib.build_filenamev([GLib.get_current_dir(), 'app/src/frontends/gui/css.ts']);
  const file = Gio.File.new_for_path(path);
  if (!file.query_exists(null)) {
    print(`  (no css.ts at ${path} — run this from the repository root)`);
    return null;
  }
  const [, bytes] = file.load_contents(null);
  const source = new TextDecoder().decode(bytes);
  const match = /export const APP_CSS = `([\s\S]*?)`\.trim\(\);/.exec(source);
  if (!match) return null;
  // The three interpolated Adwaita name classes. Everything else in the sheet is literal.
  const css = match[1]
    .replaceAll('${MONO}', 'monospace')
    .replaceAll('${DIM}', 'dim-label')
    .replaceAll('${TITLE}', 'title-1');
  const provider = new Gtk.CssProvider();
  provider.load_from_data(css, -1);
  Gtk.StyleContext.add_provider_for_display(Gdk_display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
  return provider;
}

const Gdk_display = Gdk.Display.get_default();
loadRealStylesheet();

// ── the widgets whose minimum width is a candidate for the floor ────────────────────────────

/**
 * One transcript row, built exactly as `transcript-view.ts` builds one.
 *
 * The two speakers are different widgets there and so they are here: a prompt is a bubble aligned to
 * the end, an answer is unboxed body text filling the measure. A probe that drew both as bubbles
 * would be measuring a surface this app does not have.
 */
function bubble(text, speaker) {
  const user = speaker === 'user';
  return new Gtk.Label({
    label: text,
    useMarkup: false,
    wrap: true,
    selectable: true,
    xalign: 0,
    halign: user ? Gtk.Align.END : Gtk.Align.FILL,
    cssClasses: user
      ? ['kurier-bubble', 'kurier-bubble-user', 'kurier-transcript-text']
      : ['kurier-agent-text', 'kurier-transcript-text'],
  });
}

/** The transcript's scrolled window around a clamped column — `TranscriptView`'s own shape. */
function transcript() {
  const column = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    spacing: 16,
    marginTop: 18,
    marginBottom: 18,
    marginStart: 12,
    marginEnd: 12,
  });
  column.append(bubble('A short answer.', 'agent'));
  column.append(
    bubble(
      "The longest thing this app ever puts in a bubble: a paragraph of an agent's own words that " +
        'has to wrap at whatever width the pane happens to be, because the transcript is not a fixed ' +
        'column and a label that ellipsizes would be a screenshot instead of a sentence.',
      'agent',
    ),
  );
  column.append(bubble('And a short one back.', 'user'));
  return new Gtk.ScrolledWindow({
    child: new Adw.Clamp({ child: column, maximumSize: 720, tighteningThreshold: 720 }),
    hexpand: true,
    vexpand: true,
    hscrollbarPolicy: Gtk.PolicyType.NEVER,
  });
}

/** The composer: clamp → frame → column → (entry row, status line). `composer.ts`'s own shape. */
function composer() {
  const entry = new Gtk.TextView({
    wrapMode: Gtk.WrapMode.WORD_CHAR,
    leftMargin: 8,
    rightMargin: 8,
    topMargin: 8,
    bottomMargin: 8,
    cssClasses: ['kurier-composer-entry'],
  });
  const scroller = new Gtk.ScrolledWindow({
    child: entry,
    hexpand: true,
    hscrollbarPolicy: Gtk.PolicyType.NEVER,
    minContentHeight: 56,
    maxContentHeight: 180,
    propagateNaturalHeight: true,
  });
  const button = new Gtk.Button({
    child: new Adw.ButtonContent({ iconName: 'mail-send-symbolic', label: 'Send' }),
    valign: Gtk.Align.END,
  });
  button.add_css_class('suggested-action');

  const row = new Gtk.Box({
    orientation: Gtk.Orientation.HORIZONTAL,
    spacing: 8,
    marginTop: 8,
    marginBottom: 8,
    marginStart: 12,
    marginEnd: 12,
  });
  row.append(scroller);
  row.append(button);

  const status = new Gtk.Label({
    useMarkup: false,
    xalign: 0,
    wrap: true,
    label: 'Working — the agent is answering.',
    cssClasses: ['kurier-composer-status', 'caption'],
  });

  const column = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });
  column.append(row);
  column.append(status);

  const frame = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    cssClasses: ['kurier-composer-frame'],
  });
  frame.append(column);

  return new Adw.Clamp({
    child: frame,
    maximumSize: 720,
    tighteningThreshold: 720,
  });
}

/** The content pane's header, inside the `Adw.ToolbarView` the window actually builds. */
function header() {
  return new Adw.HeaderBar({
    showTitle: true,
    titleWidget: new Adw.WindowTitle({ title: 'It does not drop it, it defers it: the scanner' }),
  });
}

// ── report ───────────────────────────────────────────────────────────────────────────────────

/**
 * The floor this run sweeps with, from `ARGV[0]`. `null` means "no floor at all".
 *
 * **`widthRequest` is construct-only, so a sweep cannot change it afterwards** — it is written at
 * construction and GTK reads it when the toplevel first asks for its size. That is why this script
 * takes the floor as an argument instead of re-sweeping one window: the first version set only
 * `defaultWidth` and could therefore print a single column, while the table in `constants.ts`
 * (`WINDOW_MIN_WIDTH_PX`) quotes two and attributes both to this file. A measurement that cannot be
 * re-run is not a measurement, it is a story — so run it twice:
 *
 * ```sh
 * gjs -m scripts/probes/window-min-width.mjs 480   # the old floor: every sweep clamps back to 480
 * gjs -m scripts/probes/window-min-width.mjs       # the floor removed: every sweep is granted
 * ```
 */
const FLOOR = ARGV[0] ? Number.parseInt(ARGV[0], 10) : null;

const window = new Adw.ApplicationWindow({
  application: null,
  defaultWidth: 480,
  defaultHeight: 600,
  title: `kurier width probe (floor ${FLOOR === null ? 'none' : String(FLOOR)})`,
  ...(FLOOR === null ? {} : { widthRequest: FLOOR }),
});

const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
const contentToolbar = new Adw.ToolbarView({ vexpand: true });
contentToolbar.add_top_bar(header());
contentToolbar.set_content(transcript());
contentToolbar.set_bottom_bar_style(Adw.ToolbarStyle.RAISED_BORDER);
contentToolbar.add_bottom_bar(composer());
content.append(contentToolbar);

const sidebar = new Gtk.ListBox();
for (const name of ['Refactor the parser', 'Release notes draft', 'Old experiment']) {
  sidebar.append(new Gtk.Label({ label: name, xalign: 0 }));
}
const sidebarPage = new Adw.NavigationPage({ title: 'kurier', child: sidebar });

const split = new Adw.NavigationSplitView({
  sidebar: sidebarPage,
  content: new Adw.NavigationPage({ title: 'kurier', child: content }),
  minSidebarWidth: 260,
  maxSidebarWidth: 340,
});

window.content = split;
window.present();
await frames(6);

print('Per-widget preferred width, as (minimum, natural) in logical pixels:');
print('  A large MINIMUM is what a floor is made of; a large natural width only means "wide by default".\n');
// **GTK 4 renamed this.** `gtk_widget_get_preferred_width()` is gone; `gtk_widget_measure()` replaced it
// and returns a five-element tuple. Calling the GTK 3 name on GTK 4 raises
// `TypeError: widget.get_preferred_width is not a function` — measured, and the reason this probe
// exists in the shape it does.
const rows = [
  ['transcript (clamp+column)', transcript()],
  ['composer (clamp+frame+row)', composer()],
  ['content header bar', header()],
  ['sidebar Gtk.ListBox', sidebar],
];
for (const [name, widget] of rows) {
  if (!widget) continue;
  const [minimum, natural] = widget.measure(Gtk.Orientation.HORIZONTAL, -1);
  print(`  ${name.padEnd(28)} min=${String(minimum).padStart(4)}  natural=${String(natural).padStart(4)}`);
}

print('\nThe window itself, with no width request at all:');
const [winMin, winNat] = window.measure(Gtk.Orientation.HORIZONTAL, -1);
print(
  `  sidebar shown                min=${String(winMin).padStart(4)}  natural=${String(winNat).padStart(4)}`,
);
// **Which widget is the 360?** The window's minimum is the maximum over its children, so the number
// that decides the floor belongs to one widget and it is worth naming rather than leaving as a
// coincidence of "it stopped at 360". Every child of the live tree is measured, deepest first.
print('\n  Every widget in the collapsed tree, minimum width:');
const measured = [];
(function walk(widget, depth) {
  if (!widget || measured.length > 400) return;
  const [minimum] = widget.measure(Gtk.Orientation.HORIZONTAL, -1);
  const type = widget.constructor.$gtype?.name ?? widget.constructor.name;
  if (minimum >= 300) measured.push([depth, type, minimum, widget]);
  let child = widget.get_first_child?.();
  while (child) {
    walk(child, depth + 1);
    child = child.get_next_sibling();
  }
})(window, 0);
for (const [depth, type, minimum] of measured.sort((a, b) => b[2] - a[2]).slice(0, 12)) {
  print(`    ${'  '.repeat(Math.min(depth, 8))}${type.padEnd(26)} min=${minimum}`);
}

// **The collapsed case is the one a phone window is actually in.** `Adw.Breakpoint` applies on a
// condition *change*, so a window that is already narrow at startup never sees it fire — measured
// behaviour that `window.ts` records — and the sidebar keeps contributing to the minimum. Setting
// `collapsed` here is what the breakpoint does at 720, and it is the state every phone screenshot is in.
split.collapsed = true;
await frames(4);
const [collapsedMin, collapsedNat] = window.measure(Gtk.Orientation.HORIZONTAL, -1);
print(
  `  sidebar collapsed (phone)    min=${String(collapsedMin).padStart(4)}  natural=${String(collapsedNat).padStart(4)}`,
);

print(
  '\nGrants, sweeping narrower (the collapse breakpoint is 720 and stays put),' +
    ` floor ${FLOOR === null ? 'none' : String(FLOOR)}:`,
);
for (const width of [480, 420, 360, 320, 280, 240, 200]) {
  window.set_default_size(width, 600);
  await frames(3);
  print(`  asked ${String(width).padStart(4)} -> granted ${String(window.get_width()).padStart(4)}`);
}

print(
  '\nRead: nothing here has a minimum near 480, so a phone floor is a decision about what the window' +
    '\n      should refuse to become — not a limit the layout imposes.',
);
window.destroy();
