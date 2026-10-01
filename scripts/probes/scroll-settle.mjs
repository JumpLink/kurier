#!/usr/bin/env -S gjs -m
/**
 * Is `upper` measurable when the scroll-to-end idle runs, given that `setEntries` is called from the
 * window's **constructor** — before the window is ever presented?
 *
 * `#scrollToEnd` (`transcript-view.ts`) arms one `GLib.idle_add(GLib.PRIORITY_LOW)` and reads
 * `upper`/`page_size` there, returning without scrolling when `end <= 0`, on the stated grounds that
 * "the first frame's allocation retries this". **Nothing retries it.** So the question this probe
 * answers is whether that early return is reachable at all, and if it is, it is a scroll that never
 * happens: the conversation opens at the top instead of at its newest entry, and nothing afterwards
 * corrects it, because with no turn running there is no second append.
 *
 * The screenshots that prompted it: at 1024 px the stored transcript opens at its newest entry, and
 * at 480 px the same transcript opens at its **top** with the last bubble cut off at the composer's
 * edge. Wider wraps less, so the content is shorter and the difference is only visible once the
 * column is taller than the pane — which is exactly what a narrow window makes it.
 *
 *   gjs -m scripts/probes/scroll-settle.mjs
 *
 * Needs a display. Prints the adjustment on consecutive idles for three timings: before `present`,
 * after `present`, and after a `setEntries`-shaped call made in the constructor.
 */
import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

Adw.init();

const PANE_HEIGHT = 420;

/** The transcript's own shape: `Gtk.ScrolledWindow` → `Adw.Clamp` → a vertical column of labels. */
function build(bubbles, linesPerBubble) {
  const column = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    spacing: 4,
    marginTop: 12,
    marginBottom: 12,
    marginStart: 12,
    marginEnd: 12,
  });
  for (let b = 0; b < bubbles; b += 1) {
    column.append(
      new Gtk.Label({
        label: Array.from({ length: linesPerBubble }, (_, i) => `bubble ${b} line ${i}`).join('\n'),
        wrap: true,
        xalign: 0,
      }),
    );
  }
  const scroller = new Gtk.ScrolledWindow({
    child: new Adw.Clamp({ child: column, maximum_size: 720, tightening_threshold: 720 }),
    hexpand: true,
    vexpand: true,
  });
  const window = new Gtk.Window({
    default_width: 480,
    default_height: PANE_HEIGHT,
    child: scroller,
  });
  return { window, scroller };
}

const idle = () => new Promise((r) => GLib.idle_add(GLib.PRIORITY_LOW, r));

/** Read the adjustment on `n` consecutive idles, setting the value on the first one (what the app does). */
function followAcrossIdles(scroller, n) {
  return new Promise((resolve) => {
    const seen = [];
    let i = 0;
    const tick = () => {
      const adj = scroller.get_vadjustment();
      if (adj) {
        const upper = adj.get_upper();
        const page = adj.get_page_size();
        seen.push({ upper, page, end: upper - page, value: adj.get_value() });
        // Exactly `#scrollToEnd`'s body: set the end, or give up when there is none.
        if (upper - page > 0) adj.set_value(upper - page);
      }
      i += 1;
      if (i < n) GLib.idle_add(GLib.PRIORITY_LOW, tick);
      else resolve(seen);
    };
    tick();
  });
}

function report(label, seen) {
  print(`\n  ${label}`);
  seen.forEach((s, i) =>
    print(
      `    idle ${i}: upper=${s.upper.toFixed(1)} page=${s.page.toFixed(1)} ` +
        `end=${s.end.toFixed(1)} value=${s.value.toFixed(1)}`,
    ),
  );
  const first = seen[0];
  const last = seen[seen.length - 1];
  if (!first || !last) return;
  print(`    end at idle 0 = ${first.end.toFixed(1)}, end at the last idle = ${last.end.toFixed(1)}`);
}

// ── Case A: the idle armed from the constructor, before the window is presented ──────────────
print('=== A: scroll-to-end armed BEFORE present() — what the window constructor does ===');
{
  const { window, scroller } = build(9, 3);
  report('armed before present', await followAcrossIdles(scroller, 3));
  window.present();
  await idle();
  report('after present()', await followAcrossIdles(scroller, 3));
  window.destroy();
}

// ── Case B: the window is presented and mapped first ───────────────────────────────────────
print('\n=== B: scroll-to-end armed AFTER present() + one idle ===');
{
  const { window, scroller } = build(9, 3);
  window.present();
  await idle();
  await idle();
  report('armed after the window is mapped', await followAcrossIdles(scroller, 3));
  window.destroy();
}

// ── Case C: does re-arming recover case A? ────────────────────────────────────────────────
print('\n=== C: re-arming — does a second idle reach where the first could not? ===');
{
  const { window, scroller } = build(9, 3);
  const first = await followAcrossIdles(scroller, 2);
  window.present();
  await idle();
  const second = await followAcrossIdles(scroller, 3);
  report('first attempt (unmapped)', first);
  report('after present, re-armed', second);
  window.destroy();
}
