/**
 * Where the keyboard focus is when kurier's permission dialog opens — measured on the real widget.
 *
 * **Why this file exists rather than a case in `scripts/probes/alert-dialog-close.mjs`.** That probe
 * measures libadwaita, and it can only build look-alikes out of `Adw.AlertDialog`. This question is
 * about *kurier's* `PermissionDialog` — whether the widget moves the focus, when, and onto what — and
 * a look-alike cannot answer it: the first version of the dialog left libadwaita's fallback in place
 * and the plain probe said the focus was on the allow button while the app's own screenshot showed a
 * selectable label highlighted instead. Probe and app disagreed because they were different widgets.
 *
 * So this is an entry point that imports the real class, and it is built like the integration test is:
 *
 * ```sh
 * ./node_modules/.bin/gjsify build app/tests/probes/permission-focus.ts --app gjs \
 *   --outfile /tmp/permission-focus.gjs.mjs
 * DISPLAY=:0 ./node_modules/.bin/gjsify run /tmp/permission-focus.gjs.mjs
 * ```
 *
 * **What it asserts, for six option sets:** the focus is never a button kurier would allow with, it is
 * the *narrow* declining button when the agent offered one, and nothing is text-selected when it lands
 * on the diff body (the grey highlight that was visible in `s6-dialog-1024.png`).
 *
 * **Four of the six carry the `*_always` kinds, in both orders** — because that pair is what the probe
 * exists for since kurier began passing them through: `allow_always` is on screen, and Enter must
 * still not reach it. The last case is the one that only exists because of that change: an agent
 * offering `allow_once` and `allow_always` and nothing rejecting leaves no safe button to focus, so the
 * focus has to reach the diff body instead.
 *
 * **The GTK facts this rests on, both measured in `scripts/probes/alert-dialog-close.mjs` case 9:** with
 * no `default_response` set, libadwaita focuses the **first** added response — *not* the last, which is
 * what `Adw-1.gir` says and what this file's own header used to repeat; and the row is laid out
 * **bottom-up from the add order**, so the last added is the topmost button. A focused `Gtk.Button` is
 * activated by Enter and by Space regardless of any default widget, so the first slot has to be safe on
 * its own: `orderOptions` puts `reject_once` there, which is why the two cases below that list an allow
 * first still come up on "Decline".
 */
import Adw from '@girs/adw-1';
import GLib from '@girs/glib-2.0';
import Gtk from '@girs/gtk-4.0';

import { optionLabel } from '../../src/core/permission.ts';
import { PermissionDialog } from '../../src/frontends/gui/permission-dialog.ts';
import type { PermissionQuestion, PermissionView } from '../../src/core/permission.ts';
import type { PermissionOption } from '@kurier/acp/types';

Adw.init();

const loop = new GLib.MainLoop(null, false);

/** The view every case shares. Only the options differ, which is the thing under test. */
function viewOf(options: PermissionOption[]): PermissionView {
  return {
    tool: 'Write src/greeting.ts',
    kind: 'edit',
    locations: ['src/greeting.ts:3'],
    rawInput: '{\n  "path": "src/greeting.ts"\n}\n',
    options,
  };
}

const CASES: readonly {
  readonly label: string;
  readonly options: PermissionOption[];
  readonly expect: string;
}[] = [
  {
    label: 'allow first, then reject (the order opencode sends)',
    options: [
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject_once', name: 'Decline', kind: 'reject_once' },
    ],
    expect: 'Decline',
  },
  {
    label: "reject first, then allow — kurier's order",
    options: [
      { optionId: 'reject_once', name: 'Decline', kind: 'reject_once' },
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
    ],
    expect: 'Decline',
  },
  {
    label: 'an agent that offers only an allow button',
    options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
    expect: '(the diff body — nothing to decline with)',
  },
  {
    label: 'all four kinds, agent order — the two "always" buttons are shown',
    options: [
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'allow_always', name: 'Always allow in this session', kind: 'allow_always' },
      { optionId: 'reject_once', name: 'Decline', kind: 'reject_once' },
      { optionId: 'reject_always', name: 'Always decline in this session', kind: 'reject_always' },
    ],
    expect: 'Decline',
  },
  {
    label: 'all four kinds, "always" first — kurier\'s order and focus win',
    options: [
      { optionId: 'allow_always', name: 'Always allow in this session', kind: 'allow_always' },
      { optionId: 'reject_always', name: 'Always decline in this session', kind: 'reject_always' },
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject_once', name: 'Decline', kind: 'reject_once' },
    ],
    expect: 'Decline',
  },
  {
    label: 'two allows and no decline — the state where focus must reach the diff body',
    options: [
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'allow_always', name: 'Always allow in this session', kind: 'allow_always' },
    ],
    expect: '(the diff body — nothing to decline with)',
  },
];

/**
 * Sample the focus on every idle iteration until the dialog settles, and keep every distinct value.
 *
 * **The turn-by-turn sequence is the second half of the measurement** — it catches a focus that *passes
 * through* an allow button and lands somewhere safe afterwards, which a single settled reading cannot.
 * It cannot catch the first turn (see `readMapWindow`), because a timer is dispatched after kurier's own
 * idle; the two measurements together cover both ends.
 */
const MAX_SAMPLES = 60;

function sampleUntilSettled(window: Adw.Window, onDone: (samples: readonly string[]) => void): void {
  const samples: string[] = [];
  let turns = 0;
  const tick = (): boolean => {
    turns += 1;
    const dialog = findDialog(window);
    if (dialog !== null) {
      const focused = dialog.get_focus();
      const what =
        focused === null
          ? 'null'
          : focused instanceof Gtk.Button
            ? String(focused.get_label())
            : focused.constructor.name;
      // **Distinct values, deduplicated** — the transition is the interesting thing, so a focus that
      // sits on the same widget for fifty turns contributes one entry. `turns`, not `samples.length`,
      // is what the stopping rule counts: a focus that never changes is still a focus that settled.
      if (samples[samples.length - 1] !== what) samples.push(what);
    }
    const settled = samples.some((value) => value !== 'null');
    const more = !(settled && turns >= 8) && turns < MAX_SAMPLES;
    // **One exit, and it always reports.** A source whose callback returns `false` is removed and
    // nothing else would ever call `onDone`, so it is called from inside the tick — otherwise a probe
    // that stops sampling without reporting is a probe that hangs, unattended.
    if (!more) onDone(samples);
    return more;
  };
  // The first tick runs on the idle queue too, not synchronously: called directly it would read the
  // dialog before `present()` has mapped anything and see nothing at all.
  GLib.idle_add(GLib.PRIORITY_DEFAULT, tick);
}

/** Find the `Adw.AlertDialog` under a widget, so the measurement is on what is actually on screen. */
function findDialog(widget: Gtk.Widget): Adw.AlertDialog | null {
  if (widget instanceof Adw.AlertDialog) return widget;
  let child: Gtk.Widget | null = widget.get_first_child();
  while (child !== null) {
    const found = findDialog(child);
    if (found !== null) return found;
    child = child.get_next_sibling();
  }
  return null;
}

/** What a human would see: the label, or a note that it is not a button at all. */
function describeFocus(dialog: Adw.AlertDialog): string {
  const focused: Gtk.Widget | null = dialog.get_focus();
  if (focused === null) return 'null';
  if (focused instanceof Gtk.Button) {
    const label: string | null = focused.get_label();
    return label === null ? '<a button with no label>' : label;
  }
  return `${focused.constructor.name} (not activatable)`;
}

/**
 * Whether anything is text-selected — the grey highlight over the diff.
 *
 * **An empty selection counts as none.** A `Gtk.TextView` reports `has_selection()` true with an empty
 * range in some states, and `get_text` on it returns `""`; reporting that as "something is selected"
 * would make the probe fail on a widget that is showing nothing highlighted. Both selection APIs return
 * `[hasSelection, startIter, endIter]`, so the comparison is between two `Gtk.TextIter`s — not between
 * offsets, and not against the boolean.
 */
function selectedText(dialog: Adw.AlertDialog): string | null {
  const walk = (widget: Gtk.Widget): string | null => {
    if (widget instanceof Gtk.TextView) {
      const buffer = widget.get_buffer();
      const [hasSelection, start, end] = buffer?.get_selection_bounds() ?? [false, null, null];
      if (hasSelection === true && buffer !== null && start !== null && end !== null) {
        const text = buffer.get_text(start, end, false);
        if (text.length > 0) return text;
      }
    }
    if (widget instanceof Gtk.Label && widget.get_selectable() === true) {
      // `Gtk.Label`'s bounds are **character offsets** (`[boolean, number, number]`), not iters —
      // `Gtk.TextBuffer`'s are iters. The two are not interchangeable, and the typings are what says so.
      const [hasSelection, start, end] = widget.get_selection_bounds();
      if (hasSelection === true && start !== end) return widget.get_label()?.slice(start, end) ?? '';
    }
    let child: Gtk.Widget | null = widget.get_first_child();
    while (child !== null) {
      const found = walk(child);
      if (found !== null) return found;
      child = child.get_next_sibling();
    }
    return null;
  };
  return walk(dialog);
}

let index = 0;
let failures = 0;

function next(): void {
  if (index >= CASES.length) {
    print(`\n${failures === 0 ? 'focus is never an allow button — ok' : `${failures} case(s) FAILED`}`);
    loop.quit();
    return;
  }
  const testCase = CASES[index];
  index += 1;
  const window = new Adw.Window({ title: 'probe', default_width: 640, default_height: 480 });
  // `set_content`, not `set_child`: `AdwWindow` is the same class of refusal as
  // `Adw.ApplicationWindow`'s, and it aborts the process rather than warning.
  window.set_content(new Gtk.Label({ label: 'underneath', height_request: 40 }));
  const permissions = new PermissionDialog(window);
  window.present();
  const question: PermissionQuestion = { id: `probe-${index}`, view: viewOf(testCase.options) };
  print(`\n${testCase.label}`);
  print(`  options: ${testCase.options.map((o) => `${o.optionId}(${o.kind})`).join(', ')}`);
  // Never answered: this probe is about the focus, and the dialog waits, which is the correct
  // behaviour and the reason the measurement has to be taken from the outside.
  void permissions.show(question);
  sampleUntilSettled(window, (samples) => {
    const dialog = findDialog(window);
    print(`  focus per turn: ${samples.join(' -> ')}`);
    if (dialog === null) {
      print('  FAILED: no dialog under the window');
      failures += 1;
    } else {
      const focused = describeFocus(dialog);
      const selection = selectedText(dialog);
      print(`  settled get_focus(): ${focused}`);
      print(`  selected text: ${selection === null ? 'none' : JSON.stringify(selection)}`);
      print(`  expected: ${testCase.expect}`);
      // Two claims, both strict. **Every** sampled turn must not name an allowing button, not just the
      // settled one: the transition between libadwaita's own assignment and kurier's grab is a real
      // turn, and that is where a stray Enter would land. And the settled focus must be the *narrow*
      // decline when one was offered — an accidental Enter must not set a session-wide refusal for a
      // question about one file.
      const allowLabels = new Set(
        testCase.options.filter((o) => o.kind.startsWith('allow')).map((o) => optionLabel(o)),
      );
      const badSample = samples.filter((sample) => allowLabels.has(sample));
      if (badSample.length > 0) {
        print(`    FAILED: an allow button held the focus in a turn (${badSample.join(', ')})`);
        failures += 1;
      }
      if (allowLabels.has(focused)) {
        print('    FAILED: the settled focus is on the allow button');
        failures += 1;
      } else if (
        // The `reject_once` **this case actually offered**, not a label built from whichever option
        // happened to be first: `optionLabel` is kurier's sentence for the kind, so a synthetic
        // label from another option would not be the string on the button.
        testCase.options.some((o) => o.kind === 'reject_once') &&
        focused !== optionLabel(testCase.options.find((o) => o.kind === 'reject_once')!)
      ) {
        print('    FAILED: a reject_once was offered and the settled focus is not on it');
        failures += 1;
      } else if (selection !== null && selection.length > 0) {
        print('    FAILED: text is selected, which draws the grey highlight');
        failures += 1;
      }
    }
    permissions.close();
    window.destroy();
    next();
  });
}

next();
loop.run();
print('\ndone');
