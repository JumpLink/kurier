#!/usr/bin/env -S gjs -m
/**
 * What actually sets this window's minimum width — measured, per widget.
 *
 * ## The measured numbers (GTK 4.22.5 / libadwaita 1.9.3, 2026-10-10)
 *
 * **`widthRequest` was the only constraint above 360, and it was a decision rather than a
 * measurement.** With the window asking for 480 and the content built exactly as it is, GTK granted
 * 480 and refused 420, 360, 320 and 280 — every one of them clamped back up to 480. With that one
 * property dropped, the *same, unmodified* tree sized itself to 480, 420 and 360, and then stopped:
 * 320, 280, 240 and 200 all came back as 360, with 0 Gtk-WARNINGs anywhere.
 *
 * | Asked | Granted, floor at 480 | Granted, no floor |
 * | ----- | --------------------- | ----------------- |
 * | 480   | 480                   | 480               |
 * | 420   | **480**               | 420               |
 * | 360   | **480**               | 360               |
 * | 320   | **480**               | **360**           |
 * | 280   | **480**               | **360**           |
 * | 240   | **480**               | **360**           |
 * | 200   | **480**               | **360**           |
 *
 * So **360 is the toolkit's number and 480 was a typed literal sitting above it** — which is what
 * makes `WINDOW_MIN_WIDTH_PX = 360` a floor that matches the layout rather than one imposed on it.
 *
 * > **The right-hand column used to read 320 / 280 / 240 / 200, and that was never measured.** The
 * > commit that made this probe re-runnable (`docs(gui): make the width table reproducible, and the
 * > 360 honest`) found the window stops at 360 and said so in its message — but left this table
 * > alone, so the corrected story lived in `git log` and the stale one lived here, in the file whose
 * > whole job is to attest it. Re-measured above, on a composer that has since been rebuilt as a
 * > card: same 360, so the rebuild did not move the floor.
 *
 * ## Where the 360 is, and the 369 just under it
 *
 * Collapsed, the window's own minimum is 360 while its content page asks **369** — and the chain
 * under that page ends at a `Gtk.DropDown` whose minimum is **287**, the width of the longest string
 * in the model list. **`Adw.Clamp` caps a natural width, not a minimum**: the clamp around that
 * dropdown measures 287 as well, so a long model id does raise what the config row asks for (its
 * `Gtk.FlowBox`: 293). It stays well under the floor, which is why the row costs the window nothing
 * — but "the clamp makes the control shrink" is not what the clamp does, and the numbers are printed
 * so the next person reads them instead of assuming it.
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
 * the `APP_CSS` template literal out of it, substitutes the three name constants (plus the widget sheet), and loads that. If
 * the stylesheet changes, this measures the change.
 *
 * ## How to run it so the sweep means anything
 *
 * **On a desktop session the sweep is worthless, and it does not say so — it prints a column.**
 * `set_default_size` on a mapped toplevel is a *request*, and the session compositor here granted
 * none of them: every row came back 629, the window's two-pane minimum, which reads exactly like a
 * layout that refuses to be narrow. On a headless mutter the same code grants 480, 420 and 360. So
 * run it on one, the way the screenshots are taken:
 *
 * ```sh
 * dbus-run-session -- bash -c '
 *   XDG_RUNTIME_DIR=/tmp/ku-probe mutter --headless --wayland --no-x11 \
 *     --virtual-monitor 1280x860 --wayland-display ku-probe & sleep 2
 *   XDG_RUNTIME_DIR=/tmp/ku-probe WAYLAND_DISPLAY=ku-probe DISPLAY= \
 *     gjs -m scripts/probes/window-min-width.mjs'   # add a floor as the one argument
 * ```
 *
 * The per-widget half above the sweep is a `measure()` call and needs only a display, so a desktop
 * run still answers "what does each widget ask for" — just not "what is the window granted".
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

/** One `export const NAME = \`…\`.trim();` template literal out of a TypeScript source file. */
function readSheet(relative, name) {
  const path = GLib.build_filenamev([GLib.get_current_dir(), relative]);
  const file = Gio.File.new_for_path(path);
  if (!file.query_exists(null)) {
    print(`  (no ${relative} at ${path} — run this from the repository root)`);
    return null;
  }
  const [, bytes] = file.load_contents(null);
  const source = new TextDecoder().decode(bytes);
  const match = new RegExp(`export const ${name} = \`([\\s\\S]*?)\`\\.trim\\(\\);`).exec(source);
  return match ? match[1] : null;
}

/**
 * The real `APP_CSS`, taken out of the source files.
 *
 * Deliberately not pasted: the whole question is what the shipped padding and margins demand, and a
 * second copy of the stylesheet is a second thing to keep in step with the first.
 *
 * **Two files since ADR 0001 step 5**, because the sheet is: the chat's rules are
 * `@lotse/widget`'s `WIDGET_CSS` and the app's own three are `APP_CSS`; the widget installs
 * its sheet itself, so both are loaded here. Reading only the app's file would measure a window with no transcript padding at all —
 * which is exactly the kind of quietly-wrong baseline this function exists to avoid.
 */
function loadRealStylesheet() {
  const app = readSheet('app/src/frontends/gui/css.ts', 'APP_CSS');
  const widget = readSheet('packages/widget/src/css.ts', 'WIDGET_CSS');
  if (app === null || widget === null) return null;
  // The three interpolated Adwaita name classes. Everything else in the sheet is literal.
  const css = (widget + '\n' + app)
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

/**
 * The config row: a `Gtk.FlowBox` of clamped flat dropdowns — `config-row.ts`'s own shape.
 *
 * It is part of the composer now rather than a strip above it, and at the phone floor it is the
 * widest thing on the card's bottom line: three 160 px controls that wrap to one per line. A probe
 * that left it out would measure a composer with nothing to configure and call that the minimum.
 */
function configRow() {
  const flow = new Gtk.FlowBox({
    maxChildrenPerLine: 3,
    selectionMode: Gtk.SelectionMode.NONE,
    rowSpacing: 6,
    columnSpacing: 6,
    halign: Gtk.Align.START,
  });
  for (const [name, values] of [
    ['Model', ['a-very-long-model-identifier-000', 'another-one-001']],
    ['Thought level', ['Default', 'High']],
    ['Mode', ['Build', 'Plan']],
  ]) {
    const list = new Gtk.StringList();
    for (const value of values) list.append(value);
    const dropdown = new Gtk.DropDown({
      model: list,
      selected: 0,
      tooltipText: name,
      valign: Gtk.Align.CENTER,
      cssClasses: ['flat', 'kurier-config-control'],
    });
    flow.append(
      new Adw.Clamp({ child: dropdown, maximumSize: 160, tighteningThreshold: 160, halign: Gtk.Align.START }),
    );
  }
  const caption = new Gtk.Label({
    useMarkup: false,
    xalign: 0,
    wrap: true,
    label: '',
    cssClasses: ['caption'],
  });
  const box = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    spacing: 6,
    valign: Gtk.Align.CENTER,
    hexpand: true,
  });
  box.append(flow);
  box.append(caption);
  return box;
}

/**
 * The composer: clamp → card → column → (inner: entry overlay, controls) + status line.
 * `composer.ts`'s own shape, card and all.
 */
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
  // The placeholder is an overlay, not a property — `composer.ts`'s file header has the measurement.
  // It contributes a minimum width of its own, which is the reason it is here and not skipped.
  const entryArea = new Gtk.Overlay({ child: scroller });
  entryArea.add_overlay(
    new Gtk.Label({
      useMarkup: false,
      label: 'Ask the agent…',
      xalign: 0,
      halign: Gtk.Align.START,
      valign: Gtk.Align.START,
      marginStart: 8,
      marginTop: 8,
      canTarget: false,
      cssClasses: ['dim-label'],
    }),
  );

  // Icon-only and circular: the word came off the button when it moved onto the card's bottom line,
  // and those ~60 px are what let three dropdowns share that line at the floor.
  const button = new Gtk.Button({
    iconName: 'go-up-symbolic',
    valign: Gtk.Align.END,
    cssClasses: ['circular', 'suggested-action'],
  });

  const settings = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, hexpand: true });
  settings.append(configRow());
  const controls = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
  controls.append(settings);
  controls.append(button);

  const inner = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    spacing: 6,
    marginTop: 6,
    marginBottom: 6,
    marginStart: 6,
    marginEnd: 6,
  });
  inner.append(entryArea);
  inner.append(controls);

  const status = new Gtk.Label({
    useMarkup: false,
    xalign: 0,
    wrap: true,
    label: 'Working — the agent is answering.',
    cssClasses: ['kurier-composer-status', 'caption'],
  });

  const column = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });
  column.append(inner);
  column.append(status);

  // Both classes, as the widget carries them: `card` is where the surface and its 12 px radius come
  // from, and the margins that lift it off the window's edges are in `.kurier-composer-frame`.
  const frame = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    cssClasses: ['card', 'kurier-composer-frame'],
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
 * gjs -m scripts/probes/window-min-width.mjs       # no floor: granted down to 360, then clamped
 * ```
 *
 * Both on a headless compositor — see the header, or the second run prints one number seven times.
 */
const FLOOR = ARGV[0] ? Number.parseInt(ARGV[0], 10) : null;

const window = new Adw.ApplicationWindow({
  application: null,
  defaultWidth: 480,
  defaultHeight: 600,
  title: `lotse width probe (floor ${FLOOR === null ? 'none' : String(FLOOR)})`,
  ...(FLOOR === null ? {} : { widthRequest: FLOOR }),
});

const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
const contentToolbar = new Adw.ToolbarView({ vexpand: true });
contentToolbar.add_top_bar(header());
contentToolbar.set_content(transcript());
// FLAT, as `window.blp` sets it: the composer is a card of its own now, and a raised bottom bar
// would draw a second surface behind it. It costs the bar its border, which is a width-neutral
// change — kept in step anyway, because a probe that styles the shell differently is measuring a
// window nobody runs.
contentToolbar.set_bottom_bar_style(Adw.ToolbarStyle.FLAT);
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

// **Which widget is the floor?** The window's minimum is the maximum over its children, so the
// number belongs to one widget and it is worth naming rather than leaving as a coincidence of "it
// stopped at 360". Every child of the live tree is measured, deepest first.
//
// **After the collapse, not before it** — the walk used to run while the sidebar was still shown,
// which printed the chain carrying the two-pane 629 under a heading that said "collapsed tree". The
// phone floor is the only one worth attributing, so the tree walked is the phone one.
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
  '\nRead: nothing here has a minimum near 480, so that floor was a decision rather than a limit —' +
    "\n      but the sweep does stop at 360 with no floor at all, and that one is the toolkit's." +
    '\n      A run where every row prints the same number is a compositor that refused to resize.',
);
window.destroy();
