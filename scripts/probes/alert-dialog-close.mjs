#!/usr/bin/env -S gjs -m
/**
 * What `Adw.AlertDialog` answers when nobody presses a button — and, more importantly, in what order
 * its two signals arrive when somebody *does*. The numbers here are the fail-closed rule's foundation.
 *
 * Plan §7 step 6 makes one property load-bearing: a dismissal must answer the protocol's `cancelled`
 * outcome, and a pressed button must answer with the option id the agent offered. Neither is
 * self-evident from `Adw.AlertDialog`'s API, and one of them was wrong in the first version of
 * `permission-dialog.ts`. Five things are measured:
 *
 * 1. **An external `close()` emits `closed` and *then* `response("close")`.** This is the order that
 *    matters most, and it is not the order the signal names suggest. A dialog that settles its answer
 *    on `closed` therefore resolves *every* button press as a dismissal — pressing "Allow once"
 *    answers `cancelled`, and the gate can never allow anything. Not a fail-closed bug: a bug in the
 *    only direction that does any good, and invisible in a screenshot because the dialog looks right.
 *    The fix is to let the main loop turn once in the `closed` handler; case 2 measures the fixed
 *    wiring and case 1 measures the broken one.
 * 2. **The close response is not a button.** `close_response` defaults to `close`, and
 *    `has_response('close')` is `false` — so "anything that is not one of the ids the agent offered is
 *    cancelled" cannot be contradicted by a dismissal arriving shaped like a press.
 * 3. **`force_close()` emits nothing at all.** So it is the wrong method for kurier's teardown: it
 *    leaves the promise unsettled and the turn waiting on a question that is no longer on screen.
 *    `close()` is the right one, and this is why.
 * 4. **`close_response` is a choice, and the other choice is worse.** Setting it to the agent's
 *    rejecting option — the plan's earlier candidate rule — works (case 6) and is weaker: it makes
 *    safety depend on the agent having offered an id with that exact string, so kurier would need to
 *    know the agent's ids to be safe. An id no agent can offer needs no such knowledge.
 * 5. **`max-content-height` is a real `Gtk.ScrolledWindow` property** (case 7), which is what caps the
 *    dialog's diff body.
 * 6. **A deferred `closed` handler must not touch the widget's fields unconditionally** (case 8, run
 *    both ways). Two requests arriving together produce two dialogs in sequence, and the first
 *    dialog's deferred handler runs a main-loop turn *after* the second has been presented. Without
 *    the "is it still my dialog" guard the second dialog becomes an orphan nothing can close — so
 *    Stop, a closing window and a dead agent all silently stop working — and its button would answer
 *    whatever question is open by then, which is an allow for a request nobody read. The guard is one
 *    comparison and it is the difference the case prints.
 * 7. **Where libadwaita puts the focus when `default_response` is unset** (case 9) — on the allow
 *    button. That is the fallback kurier has to override, because a focused `Gtk.Button` answers Enter
 *    and Space; what kurier produces instead is measured on the real widget by
 *    `app/tests/probes/permission-focus.ts`.
 *
 *   gjs -m scripts/probes/alert-dialog-close.mjs
 *
 * **`choose` takes its callback, not a promise.** The typings promise otherwise: `@girs/adw-1`
 * declares `choose(parent, cancellable, callback?)` returning `Promise<string> | void`, and the
 * runtime binding throws on the two-argument call —
 * `TypeError: method Adw.AlertDialog.choose: At least 3 arguments required, but only 2 passed`. The
 * dialog does not use `choose`; it connects `response` and presents itself, which is the same signal
 * without the callback layer. The probe uses `choose` only because `choose_finish` is a clean way to
 * print what a `response` carried.
 *
 * **The pressed-button path is measured by activating the real button**, walking the widget tree and
 * calling `activate()` on the one whose label matches. Emitting `response` by hand would prove only
 * that a signal handler runs. A `response` signal with a plain-string argument is also **not
 * callable** (`dialog.response('id')` is `undefined`) — reachable only through `emit`, which is what
 * `AdwAlertDialog` itself does internally.
 */
import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

Adw.init();

print(`libadwaita ${Adw.MAJOR_VERSION}.${Adw.MINOR_VERSION}.${Adw.MICRO_VERSION}`);

const loop = new GLib.MainLoop(null, false);

/** Every `Gtk.Button` under a widget, in tree order — the dialog's own response buttons. */
function buttonsUnder(widget, found = []) {
  if (widget instanceof Gtk.Button) found.push(widget);
  let child = widget.get_first_child();
  while (child) {
    buttonsUnder(child, found);
    child = child.get_next_sibling();
  }
  return found;
}

/** A dialog carrying the responses a real permission request carries, on a real parent window. */
function build() {
  const window = new Gtk.Window({ title: 'probe', default_width: 640, default_height: 480 });
  // `height_request`, because a bare `Gtk.Label` reports a 13 px minimum and GTK warns about it on
  // every allocation — and this probe's whole job is that its output is clean.
  window.set_child(new Gtk.Label({ label: 'the window underneath', height_request: 40 }));
  const dialog = new Adw.AlertDialog({
    heading: 'The agent wants to act',
    body: 'body',
    extra_child: new Gtk.Label({ label: 'extra', height_request: 40 }),
  });
  dialog.add_response('allow_once', 'Allow once');
  dialog.set_response_appearance('allow_once', Adw.ResponseAppearance.SUGGESTED);
  dialog.add_response('reject_once', 'Reject');
  return { window, dialog };
}

/**
 * Record both signals in arrival order, and settle the way a dialog can settle.
 *
 * `settleNow` is the synchronous form — what the first version of the dialog did on `closed` — and
 * `settleDeferred` is the idle-deferred form. Which one is used per case is the thing being measured.
 */
function watch(dialog, { deferOnClosed }) {
  const signals = [];
  let settled = 'NOT SETTLED';
  let done = false;
  const settle = (value) => {
    if (done) return;
    done = true;
    settled = value;
  };
  dialog.connect('response', (_self, response) => {
    signals.push(`response(${JSON.stringify(response)})`);
    settle(typeof response === 'string' ? response : 'close');
  });
  dialog.connect('closed', () => {
    signals.push('closed');
    if (deferOnClosed) {
      GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        signals.push('idle');
        settle(null);
        return GLib.SOURCE_REMOVE;
      });
      return;
    }
    settle(null);
  });
  return { signals, settled: () => settled };
}

const CASES = [
  ['1. a pressed button, settled on `closed` — the wiring that could never allow', { deferOnClosed: false }, (d) => pressButton(d, 'Allow once')],
  ['2. the same press, settled on `response` with `closed` deferred — what kurier does', { deferOnClosed: true }, (d) => pressButton(d, 'Allow once')],
  ['3. a pressed rejecting button, deferred — the answer a decline must reach', { deferOnClosed: true }, (d) => pressButton(d, 'Reject')],
  ['4. `close()` — what Escape, Stop and a closing window do', { deferOnClosed: true }, (d) => d.close()],
  ['5. `force_close()` — the teardown that emits nothing and would hang the turn', { deferOnClosed: true }, (d) => d.force_close()],
  [
    "6. `close_response` set to the agent's rejecting option (the plan's earlier rule)",
    { deferOnClosed: true },
    (d) => {
      d.set_close_response('reject_once');
      d.close();
    },
  ],
  [
    '7. `close_response` set to an id the agent never offered',
    { deferOnClosed: true },
    (d) => {
      d.set_close_response('allow_always');
      d.close();
    },
  ],
];

/**
 * The two cases that need more than one dialog, run as their own sequences.
 *
 * Case 8 is the one that has to exist: two requests arriving together produce two dialogs, and the
 * first one's deferred `closed` handler runs a main-loop turn *after* the second has been presented. An
 * unguarded handler clears the widget's fields at that point and the second dialog becomes an orphan
 * that nothing can close — and whose button answers whatever question is open by then.
 */
const SPECIAL = ['queued', 'focus'];

let specialIndex = 0;

/** Activate the real button whose label matches, so this is libadwaita's path and not an `emit`. */
function pressButton(dialog, label) {
  const button = buttonsUnder(dialog).find((candidate) => candidate.get_label() === label);
  if (button === undefined) throw new Error(`no button labelled ${JSON.stringify(label)}`);
  button.activate();
}

let index = 0;

/**
 * One case: present the dialog, act 150 ms later, print the signal order and what settled.
 *
 * A real main loop rather than top-level `await`: GTK needs its loop turning for a present window to
 * allocate, and a probe that awaited at the top level would sit in a promise nothing can complete.
 */
function next() {
  if (index >= CASES.length) {
    const which = SPECIAL[specialIndex];
    specialIndex += 1;
    if (which === 'queued') queuedCase();
    else if (which === 'focus') focusCase();
    else summary();
    return;
  }
  const [label, wiring, act] = CASES[index];
  index += 1;
  const { window, dialog } = build();
  const watched = watch(dialog, wiring);
  print(`\n${label}`);
  window.present();
  dialog.present(window);
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
    try {
      act(dialog);
    } catch (error) {
      print(`  act() threw: ${error.message}`);
    }
    return GLib.SOURCE_REMOVE;
  });
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 450, () => {
    print(`  signals: ${watched.signals.join(' then ') || 'NONE'}`);
    print(`  show() would resolve with ${JSON.stringify(watched.settled())}`);
    window.destroy();
    next();
    return GLib.SOURCE_REMOVE;
  });
}

/**
 * Case 8 — the widget's own bookkeeping, with two dialogs in sequence.
 *
 * This is `PermissionDialog` reduced to the three lines the review found: a `#dialog` field, a
 * `response` handler that clears it, and a `closed` handler deferred to an idle that clears it too.
 * `guard` is the one-line fix, and the same code runs both ways so the numbers can be compared.
 */
function queuedCase() {
  // **Sequentially, not in parallel.** Two runs sharing one main loop interleave their timers, and an
  // interleaved pair of runs measures the harness rather than the sequence.
  runQueued(false, () => runQueued(true, () => next()));
}

function runQueued(guard, done) {
  print(`\n8. two queued questions, answered in sequence — ${guard ? 'WITH' : 'WITHOUT'} the "is it still my dialog" guard`);
  const window = new Gtk.Window({ title: 'probe', default_width: 640, default_height: 480 });
  window.set_child(new Gtk.Label({ label: 'underneath', height_request: 40 }));
  /** The widget's two fields, and nothing else. */
  let current = null;
  const settleLog = [];

  const show = (id, label) =>
    new Promise((resolve) => {
      let settled = false;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        settleLog.push(`${id} -> ${JSON.stringify(value)}`);
        resolve(value);
      };
      const dialog = new Adw.AlertDialog({ heading: `question ${id}` });
      dialog.add_response('allow_once', label);
      dialog.add_response('reject_once', 'Decline');
      dialog.set_response_appearance('allow_once', Adw.ResponseAppearance.SUGGESTED);
      current = dialog;
      dialog.connect('response', (_self, response) => {
        if (current === dialog) current = null;
        settle(response);
      });
      dialog.connect('closed', () => {
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
          if (guard && current !== dialog) return GLib.SOURCE_REMOVE;
          current = null;
          settle(null);
          return GLib.SOURCE_REMOVE;
        });
      });
      dialog.present(window);
    });

  // The desk's sequence, driven by the answers rather than by timers: show q1, press a button, and
  // present q2 in the microtask that follows the answer. Fixed timeouts do not work here because
  // libadwaita emits `response` at the *end* of the close animation, which is later than the press.
  window.present();
  const first = show('q1', 'Allow once');
  const later = (ms, fn) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    fn();
    return GLib.SOURCE_REMOVE;
  });

  later(200, () => {
    pressButton(current, 'Allow once');
    print('  pressed "Allow once" on q1');
  });
  void first.then((id) => {
    print(`  q1 answered ${JSON.stringify(id)}; the desk now presents q2`);
    const second = show('q2', 'Allow once');
    // Long enough for q1's deferred `closed` handler to have run — it is scheduled from the `closed`
    // signal, which precedes the `response` this `then` is running from.
    later(400, () => {
      print(`  after q1's deferred handler: the second dialog is ${current === null ? 'ORPHANED — close() would be a no-op for it' : 'still tracked'}`);
      print('  calling close() — what Stop, a closing window and a dead agent all do:');
      current?.close();
      later(300, () => {
        print(`  settled: ${settleLog.join(', ')}`);
        window.destroy();
        done();
      });
    });
    void second;
  });
}

/**
 * Case 9 — the *fallback* kurier has to override: where libadwaita puts the focus when
 * `default_response` is unset.
 *
 * This is the baseline, not the answer. `Adw-1.gir` says the default widget "will not be set" without
 * it and that "the last added response will be focused by default", and this prints what that is: the
 * allow button. A focused `Gtk.Button` is activated by Enter and by Space whether or not anything is
 * the default widget, so left alone this dialog allows on the first keypress of an Enter meant for the
 * composer. `PermissionDialog` therefore sets the focus itself — see `app/tests/probes/permission-focus.ts`,
 * which measures the result in the real widget rather than in a look-alike.
 */
function focusCase() {
  print('\n9. the fallback: focus with no `default_response` set, and no focus of our own');
  const { window, dialog } = build();
  print(`  get_default_response(): ${JSON.stringify(dialog.get_default_response())}`);
  window.present();
  dialog.present(window);
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
    const focused = dialog.get_focus();
    const label = focused === null ? 'null' : (focused.get_label?.() ?? focused.constructor.name);
    print(`  get_focus(): ${label}`);
    print('  a focused Gtk.Button answers Enter and Space, so this is why kurier moves the focus itself.');
    window.destroy();
    next();
    return GLib.SOURCE_REMOVE;
  });
}

function summary() {
  print('\nWhat the close response is, and what it is not:');
  const { dialog } = build();
  print(`  get_close_response(): ${JSON.stringify(dialog.get_close_response())}`);
  for (const id of ['close', 'allow_once', 'reject_once', 'allow_always']) {
    print(`  has_response(${JSON.stringify(id)}) = ${dialog.has_response(id)}`);
  }
  print('\nScrolledWindow bound the dialog body uses (typed in @girs/gtk-4.0 4.6.0):');
  const scroller = new Gtk.ScrolledWindow();
  scroller.max_content_height = 240;
  print(`  max-content-height: ${scroller.max_content_height}`);
  print('\nAnd a signal with a plain-string argument is not callable:');
  print(`  typeof dialog.response: ${typeof build().dialog.response}`);
  loop.quit();
}

next();
loop.run();
print('\ndone');
