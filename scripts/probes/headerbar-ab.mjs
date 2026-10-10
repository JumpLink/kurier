#!/usr/bin/env -S gjs -m
/**
 * Does the sidebar's pane shape change how `Adw.NavigationSplitView`'s separator looks?
 *
 * `app/src/frontends/gui/window.ts` builds each pane as an `Adw.ToolbarView` with the header bar as
 * its top bar, and says why with numbers. This is where the numbers come from, so a reader can get
 * them again instead of believing them — the same file once carried the opposite claim ("the two
 * shapes render pixel-identical") that nothing reproducible stood behind.
 *
 * Two real windows, one per shape: A puts a bare `Adw.HeaderBar` in a `Gtk.Box`, B uses an
 * `Adw.ToolbarView` top bar. Each is rendered to a texture and the pixels in columns 255–263 (the
 * sidebar edge at 260 px) are printed at four heights: inside the header row, its last two lines,
 * and the body.
 *
 *   gjs -m scripts/probes/headerbar-ab.mjs
 *
 * The 2000 ms before the sample is not decoration. At 900 ms the second window was sampled before
 * its `Adw.ToolbarView` had been styled — three runs printed a (40,40,44) sidebar and a (26,26,30)
 * column for B, the next three the real numbers — so a comment quoting this probe would be quoting
 * a race.
 *
 * Measured on GTK 4.22.5 / libadwaita 1.9.3, dark style: the sidebar pane is (46,46,50) and the
 * content pane (34,34,38) in both shapes. A prints a (77,77,81) column at x=260 in the header row
 * and a (29,29,34) border across it at y=46, with (63,63,67) at x=260; below that both shapes print
 * one unbroken (29,29,34) column at x=259. Colours follow the system style, the shape of the
 * difference does not.
 */
import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gtk from 'gi://Gtk?version=4.0';

const W = 600;
const H = 300;
const ROWS = [20, 46, 47, 150];

function header() {
  return new Adw.HeaderBar({ showEndTitleButtons: false, showStartTitleButtons: false });
}

function rows() {
  const list = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true, vexpand: true });
  for (let i = 0; i < 6; i++) list.append(new Gtk.Label({ label: `row ${i}`, xalign: 0 }));
  return list;
}

/** A — a bare header bar as the first child of a plain box. */
function sidebarBox() {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, vexpand: true });
  box.append(header());
  box.append(rows());
  return box;
}

/** B — the header bar as the top bar of a toolbar view. */
function sidebarToolbar() {
  const view = new Adw.ToolbarView({ vexpand: true });
  view.add_top_bar(header());
  view.set_content(rows());
  return view;
}

function windowFor(application, sidebar) {
  const win = new Adw.ApplicationWindow({ application, defaultWidth: W, defaultHeight: H });
  win.content = new Adw.NavigationSplitView({
    sidebar: new Adw.NavigationPage({ title: 'sidebar', child: sidebar }),
    content: new Adw.NavigationPage({ title: 'content', child: new Gtk.Label({ label: 'content' }) }),
    minSidebarWidth: 260,
    maxSidebarWidth: 300,
  });
  return win;
}

function sample(win, name) {
  const paintable = new Gtk.WidgetPaintable({ widget: win });
  const snapshot = Gtk.Snapshot.new();
  paintable.snapshot(snapshot, W, H);
  const node = snapshot.to_node();
  if (!node) throw new Error(`${name}: nothing rendered`);
  // Through a PNG because it is the one texture → pixel path both GTK and GdkPixbuf agree on.
  const file = GLib.build_filenamev([GLib.get_tmp_dir(), `lotse-probe-${name}.png`]);
  win.get_native().get_renderer().render_texture(node, null).save_to_png(file);
  const pixbuf = GdkPixbuf.Pixbuf.new_from_file(file);
  const px = pixbuf.get_pixels();
  const stride = pixbuf.get_rowstride();
  const n = pixbuf.get_n_channels();
  for (const y of ROWS) {
    const cells = [];
    for (let x = 255; x <= 263; x++) {
      const i = y * stride + x * n;
      cells.push(`${px[i]},${px[i + 1]},${px[i + 2]}`);
    }
    print(`${name} y=${y}: ${cells.join(' | ')}`);
  }
}

const app = new Adw.Application({ applicationId: 'eu.jumplink.Lotse.Probe' });
app.connect('activate', () => {
  // Bound to the application, or it has no window, releases and exits before the timer fires.
  const a = windowFor(app, sidebarBox());
  const b = windowFor(app, sidebarToolbar());
  a.present();
  b.present();
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
    sample(a, 'A-box');
    sample(b, 'B-toolbar');
    app.quit();
    return GLib.SOURCE_REMOVE;
  });
});
app.run([]);
