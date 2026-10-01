#!/usr/bin/env -S gjs -m
/**
 * Which signals can this view actually use to learn that the adjustment has real numbers?
 *
 * `#scrollToEnd` needs to be told "the layout has been measured now". The first attempt used
 * `Gtk.ScrolledWindow::size-allocate`, and it **threw at runtime** —
 * `Error: No signal 'size-allocate' on object 'GtkScrolledWindow'` — which is a `Gjs-CRITICAL` on a
 * stderr nobody reads and a constructor that dies before the window exists. The signal is real in
 * C (`gtk_widget_signals[SIZE_ALLOCATE]`) but it is not introspectable in this binding, so
 * `connect()` cannot reach it.
 *
 * This prints what *is* reachable, so the fix picks from a measured list instead of from the API
 * documentation:
 *
 *   gjs -m scripts/probes/widget-signals.mjs
 */
import GLib from 'gi://GLib?version=2.0';
import GObject from 'gi://GObject?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

Gtk.init();

const scroller = new Gtk.ScrolledWindow();
const adjustment = scroller.get_vadjustment();

/** Signal names this view would plausibly want, and whether the binding exposes them. */
const CANDIDATES = [
  ['size-allocate', scroller],
  ['map', scroller],
  ['realize', scroller],
  ['notify', scroller],
  ['changed', adjustment],
  ['value-changed', adjustment],
  ['notify', adjustment],
];

print('Signal reachability (GObject.signal_lookup, so this is the binding, not the docs):');
for (const [name, target] of CANDIDATES) {
  const id = GObject.signal_lookup(name, target.constructor.$gtype);
  print(
    `  ${id === 0 ? 'NO ' : 'yes'}  ${target === adjustment ? 'GtkAdjustment' : 'GtkScrolledWindow'} :: ${name}`,
  );
}

/** And what connecting to a missing one actually does, so the failure mode is on the record. */
print('\nConnecting to a signal the binding does not expose:');
try {
  scroller.connect('size-allocate', () => {});
  print('  connected (no error)');
} catch (error) {
  print(`  THROWS: ${error.message}`);
}

/**
 * Does `notify::upper` fire when the column becomes taller than the pane? That is the signal the
 * scroll-to-end retry hangs on, so it has to be measured rather than assumed present: `notify` being
 * in the lookup table only says the generic mechanism exists.
 */
/**
 * Which adjustment signal reports a `page_size` change? The transcript's follow hangs on learning
 * that the layout has been re-measured, and `page_size` is half of that.
 *
 * Measured, and the answer is not the obvious one: **`notify::page_size` does not fire at all** in
 * this binding — not on present, not on resize. `notify::upper` fires on both. A follow built on
 * `notify::page_size` therefore silently never re-arms, which is exactly the defect: after the window
 * was made shorter the adjustment reported `end = 479` with `value = 299`, 180 px short, and nothing
 * in the code was even told. `changed` is the signal that covers every property.
 */
print('\nDoes each candidate signal report a page_size change? (window resized shorter)');
{
  const win = new Gtk.Window({ default_width: 480, default_height: 600 });
  const col = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  for (let i = 0; i < 12; i += 1) {
    col.append(new Gtk.Label({ label: `row ${i}\nsecond line`, wrap: true }));
  }
  const sc = new Gtk.ScrolledWindow({ child: col, hexpand: true, vexpand: true });
  win.set_child(sc);
  const adj = sc.get_vadjustment();
  const seen = { changed: 0, 'notify::upper': 0, 'notify::page_size': 0, 'notify::value': 0 };
  adj.connect('changed', () => (seen.changed += 1));
  adj.connect('notify::upper', () => (seen['notify::upper'] += 1));
  adj.connect('notify::page_size', () => (seen['notify::page_size'] += 1));
  adj.connect('notify::value', () => (seen['notify::value'] += 1));
  win.present();
  await frames(4);
  const before = JSON.stringify(seen);
  print(`  after present:               ${before} (page=${adj.get_page_size().toFixed(0)})`);
  win.set_default_size(480, 300); // Shorter: page_size must fall, upper must not.
  await frames(6);
  print(`  after shrinking the window:  ${JSON.stringify(seen)} (page=${adj.get_page_size().toFixed(0)})`);
  win.destroy();
}

print('\nnotify::upper on a real, presented window:');
// 200 px tall on purpose: a pane shorter than its content, which is the only case where `upper`
// exceeds `page_size` and the scroll-to-end has a target at all. A pane that fits its content makes
// every number below trivially equal and the probe would prove nothing.
const window = new Gtk.Window({ default_width: 480, default_height: 200 });
const column = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
const realScroller = new Gtk.ScrolledWindow({ child: column, hexpand: true, vexpand: true });
window.set_child(realScroller);
const realAdjustment = realScroller.get_vadjustment();

let notifications = 0;
realAdjustment.connect('notify::upper', () => {
  notifications += 1;
  print(`  notify::upper #${notifications}: upper=${realAdjustment.get_upper()}`);
});

window.present();
await new Promise((resolve) => GLib.idle_add(GLib.PRIORITY_LOW, resolve));
print(`  after present: upper=${realAdjustment.get_upper()} page=${realAdjustment.get_page_size()}`);

for (let i = 0; i < 6; i += 1) {
  column.append(new Gtk.Label({ label: `row ${i}\nsecond line\nthird line` }));
}
/** Wait real frames, not idles: allocation happens on the frame clock, so idles can outrun it. */
function frames(count) {
  return new Promise((resolve) => {
    let left = count;
    const tick = () => {
      left -= 1;
      if (left <= 0) resolve();
      else GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, tick);
    };
    tick();
  });
}

const afterAppends = notifications;
await frames(6);
print(`  after appending 6 rows: upper=${realAdjustment.get_upper()} page=${realAdjustment.get_page_size()}`);
print(
  `  → ${afterAppends} notification(s) on first layout, ${notifications - afterAppends} while the content grew`,
);

print('\nDoes a narrower window re-wrap into a taller column, and notify again?');
window.set_default_size(300, 200);
await frames(6);
print(
  `  after narrowing to 300 px: upper=${realAdjustment.get_upper()} page=${realAdjustment.get_page_size()}`,
);
print(`  → ${notifications} notification(s) in total`);
window.destroy();
