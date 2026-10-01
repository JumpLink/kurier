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
 * **What it asserts, for three option sets:** the focus is never a button kurier would allow with, it
 * is the declining button when the agent offered one, and nothing is text-selected when it lands on
 * the diff body (the grey highlight that was visible in `s6-dialog-1024.png`).
 *
 * **A GTK fact this rests on, measured in `scripts/probes/alert-dialog-close.mjs` case 9:** with no
 * `default_response` set, libadwaita focuses the *last added* response — the allow button in the
 * fixture below. A focused `Gtk.Button` is activated by Enter and by Space regardless of any default
 * widget, so that is a dialog where a person typing in the composer, pressing Enter as the dialog
 * appears, allows a tool call without reading it.
 */
import Adw from '@girs/adw-1';
import GLib from '@girs/glib-2.0';
import Gtk from '@girs/gtk-4.0';

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
    rawInput: "{\n  \"path\": \"src/greeting.ts\"\n}\n",
    options,
  };
}

const CASES: readonly { readonly label: string; readonly options: PermissionOption[]; readonly expect: string }[] = [
  {
    label: 'allow first, then reject (what opencode sends)',
    options: [
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject_once', name: 'Decline', kind: 'reject_once' },
    ],
    expect: 'Decline',
  },
  {
    label: 'reject first, then allow — the order that used to matter',
    options: [
      { optionId: 'reject_once', name: 'Decline', kind: 'reject_once' },
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
    ],
    expect: 'Decline',
  },
  {
    label: 'an agent that offers only an allow button — no "always" survives the projection',
    options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
    expect: '(the diff body — nothing to decline with)',
  },
];

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
  // Several frames: `show()` moves the focus after `map` plus one idle, so a measurement taken in the
  // same turn as `present()` would see libadwaita's fallback and report a defect that is not there.
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
    const dialog = findDialog(window);
    if (dialog === null) {
      print('  FAILED: no dialog under the window');
      failures += 1;
    } else {
      const focused = describeFocus(dialog);
      const selection = selectedText(dialog);
      const isAllowButton = focused === testCase.options.find((o) => o.kind === 'allow_once')?.name;
      print(`  get_focus(): ${focused}`);
      print(`  selected text: ${selection === null ? 'none' : JSON.stringify(selection)}`);
      print(`  expected: ${testCase.expect}`);
      if (isAllowButton === true) {
        print('  FAILED: the focus is on the allow button');
        failures += 1;
      } else if (testCase.options.some((o) => o.kind.startsWith('reject')) && !focused.startsWith('Decline')) {
        print('  FAILED: a rejecting option was offered and the focus is not on it');
        failures += 1;
      } else if (selection !== null && selection.length > 0) {
        print('  FAILED: text is selected, which draws the grey highlight');
        failures += 1;
      }
    }
    permissions.close();
    window.destroy();
    next();
    return GLib.SOURCE_REMOVE;
  });
}

next();
loop.run();
print('\ndone');
