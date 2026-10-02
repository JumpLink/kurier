/**
 * The dev hooks — the states that can only be reached by a pointer, and so need an env var to be
 * verifiable at all.
 *
 * This is not a debug leftover and the reason is measured. gjsify's devtools plane over `gdbus`
 * cannot type into an entry (`SendKey` takes accelerators, not text), **cannot operate a combo
 * row** (`ActivateWidget` on an `Adw.ComboRow`'s internal list row reports `true` and changes no
 * selection), and **cannot dismiss an `Adw.AlertDialog`** (its response buttons report `true` and
 * emit no `response` — measured on the permission dialog too). A pointer is no substitute: under
 * Wayland `XTestFakeMotionEvent` does not move the pointer, and under `GDK_BACKEND=x11` a dialog is
 * mapped but never painted. So a config dropdown, a permission answer, a stopped turn, a dismissed
 * failure dialog and a session row are five things a screenshot of the running app cannot reach from
 * the outside. Without a hook they are the parts of this surface that are written and never checked.
 *
 * Read from the environment at startup and passed down, rather than read at the point of use: a hook
 * that is read late can be flipped between two states inside one run, and a test that says
 * "with the hook set, this state is reachable" has to mean one thing.
 */

import { readAppDevHooks, type AppDevHooks } from '@gjsify/adwaita-app';

import { DEV_HOOK_PREFIX } from './constants.ts';
import { hookFlag, hookList, hookValue } from './hook-value.ts';

/** What the hooks framework gives us: `view`, `file`, `debug`. */
export type FrameworkHooks = AppDevHooks;

/** What this surface adds on top, and why each one exists. */
export interface KurierHooks extends FrameworkHooks {
  /**
   * `KU_APP_SESSION` — open this session id at startup.
   *
   * Without it the only reachable state is an empty window, because selecting a session needs a
   * click. A surface whose interesting half cannot be opened without a mouse is a surface whose
   * interesting half is untested.
   */
  session?: string;

  /**
   * `KU_APP_AGENT` — which agent this window talks to. Unset means what the CLI resolves: the saved setting if available, else the person's own install, else the bundled copy.
   *
   * Not an `AgentCommand` and not a path: an *agent id*, resolved in `core/agents/dev-agent.ts`. The
   * two accepted values are a real launcher (`opencode`) and `stand-in`, the dev fixture — and the
   * fixture is the reason the hook exists at all, because a real turn costs a model call and is not
   * reproducible, so every running/streaming/stopped state in this window is looked at against it.
   * An unknown id falls back to the default with a line in the log rather than refusing to start.
   */
  agent?: string;

  /**
   * `KU_APP_PERMISSION` — put a `session/request_permission` in front of the real gate at startup.
   *
   * The dialog is the **reason this project exists**: a modal that must appear, must show what the
   * agent wants to do, and must fail closed on Escape. None of that is observable from outside
   * without a request to answer, and none of it works in a build-only CI run.
   *
   * **It goes through the real path, not around it.** The staged request is handed to the same gate
   * that answers the agent, so what a screenshot shows is the dialog the gate produces — including
   * the fail-closed behaviour, which a dialog built only for the screenshot would not have. It waits
   * briefly for a *real* request first (see `window.ts`), so `KU_APP_PERMISSION=1` next to a stand-in
   * that asks permission itself shows the agent's question rather than this fixture.
   */
  permission?: boolean;

  /**
   * `KU_APP_CONFIG` — set a session config option at startup, **as `configId=valueId`**.
   *
   * For the same reason: a `Gtk.DropDown` is exactly the widget the devtools plane cannot operate —
   * `ActivateWidget` on a combo row reports `true` and changes no selection — and the config row is the
   * surface's most-used control.
   *
   * **Both halves are required, and neither is guessed** (`parseConfigOptionSpec` decides it): a
   * control id says which option and not to what, and a value id cannot be resolved on its own. So
   * `KU_APP_CONFIG=effort=high` sets the effort level to high, and `KU_APP_CONFIG=effort` is refused
   * with a line in the log rather than quietly picking a value.
   *
   * **It goes through the real path and sends a prompt if none has run**, because an option can only be
   * set on a live agent and kurier starts the agent on the first prompt (plan §6). So the hook sends
   * `KU_APP_PROMPT` (or a fixture sentence), waits for `session/load` to answer with the options, and
   * then calls `session/set_config_option` — which is also why it is applied before `KU_APP_THINKING`:
   * one prompt, one turn, one set. What a screenshot then shows is the row in the state a person's
   * click produces, not a picture of one.
   */
  config?: string;

  /**
   * `KU_APP_STOP` — press Stop once the turn is running, at the point `KU_APP_THINKING` runs.
   *
   * **Stop is otherwise photographable only by driving the button through `ActivateWidget`, and that is
   * not the same thing.** A stopped turn is one of the five states plan §6 names and the one no env var
   * reaches; every screenshot of it so far was taken by activating a widget at its
   * `toplevel:0/child:7/…` path, which rots the moment the composer is rebuilt — and it is rebuilt on
   * every state change. A named hook is a path that does not rot.
   *
   * **It goes through the composer's `onStop`, not straight to `agent.stop()`.** The button's handler
   * dismisses the permission dialog with `turn-cancelled` *before* cancelling, and that ordering is the
   * behaviour a screenshot of Stop-with-a-dialog-open has to show: the dialog gone, the turn cancelled,
   * in that order. Calling the controller directly would photograph the controller instead of the
   * surface, which is the rule every other hook in this file follows.
   */
  stop?: boolean;

  /**
   * `KU_APP_STOP_ESCAPE` — dismiss the open permission dialog **the way Escape does**, and stop
   * nothing else.
   *
   * **Escape's answer is `cancelled` on the wire and `not-answered: dismissed` in the transcript**, and
   * the two are not the same string, so the hook uses the reason and not the outcome: the dialog
   * reports a dismissal as the id `'close'`, `decideFromView` reads it as `dismissed`, and `answerFor`
   * is what turns *that* into `cancelled` on the wire. A hook that passed `cancelled` would be claiming
   * an outcome `dismissPermission` does not take, and one that skipped the transcript would lose the
   * line guardrail 2 is about.
   *
   * **The half that needs this most.** `SendKey` takes accelerators and answers `false` for Escape
   * (measured), so the fail-closed-on-dismissal path cannot be reached from outside the process at all,
   * and its only screenshot in this project's history was taken by hand.
   */
  stopEscape?: boolean;

  /**
   * `KU_APP_THINKING` — send a prompt at startup, so a running turn can be reached without a pointer.
   *
   * The turn that follows is a **real** turn against whatever `KU_APP_AGENT` selected: this hook starts
   * it, it does not stage a fake one. Against the stand-in agent that is free and repeatable, and
   * against `opencode` it is a model call — which is exactly why the fixture is the default way to look
   * at this state and why the prompt it sends is a fixture prompt rather than anything of the person's.
   */
  thinking?: boolean;

  /**
   * `KU_APP_PROMPT` — the text `KU_APP_THINKING` sends. Fixed English, synthetic: a screenshot must
   * not carry a real conversation out of a real session file.
   */
  prompt?: string;

  /**
   * `KU_APP_DISMISS_FAILURE` — press the failure dialog's own Close, once it is up.
   *
   * **The second control no outside caller can reach, and the reason is measured.** `ActivateWidget`
   * on the response button of an `Adw.AlertDialog` returns `true` and dismisses nothing — measured on
   * the failure dialog *and* on the permission dialog, so it is libadwaita rather than this dialog.
   * A real pointer is no better: under Wayland `XTestFakeMotionEvent` does not move the pointer at all,
   * and under `GDK_BACKEND=x11` the dialog is mapped but never painted, so there is no button to click
   * even if it moved. `SendKey` answers `false` for Escape.
   *
   * So the "the person closed it" half of a modal's life is unreachable from outside the process, and
   * with it the question that matters: does the *same* failure come back on the next state move? The
   * hook answers it the same way `KU_APP_STOP` answers its question — through the surface, not around
   * it (`FailureDialog.dismiss()` emits the response libadwaita emits when the button is pressed).
   */
  dismissFailure?: boolean;

  /**
   * `KU_APP_SWITCH` — open these session ids in turn, once a failure is on screen. Comma-separated,
   * so a walk away and back is one variable: `fixture-1,fixture-2`.
   *
   * **The sidebar row is the third pointer-only control, and unlike the other two it has no keyboard
   * equivalent either** — nothing in devtools moves the selection in a `Gtk.ListBox`. Without it a
   * window cannot be photographed after a person has moved on to another conversation, which is the
   * only way to see whether a dialog about the *last* session is still up.
   *
   * It waits for a **failure** rather than for a number of seconds, for the reason the permission hook
   * polls: the interesting moment is "the dialog is up and the person clicks away", and a fixed delay
   * would beat the failure on a slow agent and lose to it on a fast one.
   *
   * **A list, not the raw string, because this reader is where a variable's syntax is read** — the
   * same place `'0'` stops meaning on. A bare id is one entry and an entry that is only whitespace is
   * not an entry, so `KU_APP_SWITCH=,` asks for no session at all rather than for one called `''`.
   */
  switchTo?: string[];

  /**
   * `KU_APP_CHOOSE_MODEL` — press the `'model'` failure dialog's **Choose another model**, once it is up.
   *
   * **The fifth pointer-only control, and the one that needed a new hook rather than an old one.**
   * `KU_APP_DISMISS_FAILURE` presses Close through `FailureDialog.close()`, which is the same call a
   * dismissal makes. This dialog's other response has no such shortcut: `Adw.AlertDialog` has no
   * callable `response()` at all, and `ActivateWidget` on its button reports `true` and emits nothing
   * (both measured — `scripts/probes/alert-dialog-close.mjs`). So the state only the button reaches —
   * the config row's model dropdown, popped down and ready to pick from, which is the whole answer the
   * dialog exists to give — had no way to be looked at.
   *
   * **Through `FailureDialog.chooseModel()`, not around the dialog.** That emits the same `response`
   * signal libadwaita's own handler answers to, so the modal closes itself and the dropdown opens in
   * libadwaita's own order. A hook that called `ConfigRow.openModelDropdown()` directly would
   * photograph a dropdown with the modal still up — a state a person cannot be in.
   */
  chooseModel?: boolean;

  /**
   * `KU_APP_PREFERENCES` — open the preferences dialog through its own `app.preferences` action.
   * A flag, so `KU_APP_PREFERENCES=0` leaves it closed.
   */
  preferences?: boolean;

  /**
   * `KU_APP_PREFERENCES_AGENT` — choose a row in that dialog by key (`auto`, `opencode:host`,
   * `opencode:bundled`) through its own handler, and open the dialog first. A combo or radio row is
   * what the devtools plane cannot operate (see above), so this is the only way to photograph the
   * dialog after a choice.
   */
  preferencesAgent?: string;
}

/**
 * Read `KU_APP_*` at startup.
 *
 * **The framework's reader is spread in, and it does not read these ten.** `readAppDevHooks` knows
 * `VIEW`, `FILE` and `DEBUG` and nothing else, so kurier's hooks are read here — the earlier version
 * of this comment claimed the framework's "empty means unset" and truthiness rules were being used,
 * which was false for every key, and it named `KU_APP_THINKING=0` as the disagreement it prevented
 * while being the disagreement: `trimmed()` returns the **string** `'0'`, which is truthy, so
 * `KU_APP_THINKING=0` sent a prompt and `KU_APP_PERMISSION=0` staged a dialog. Both spellings of
 * "off" are now read as off, by `flag` below.
 *
 * **`flag` is the same rule the stand-in agent uses** (`scripts/stand-in-agent.mjs`), copied rather
 * than imported because that script is a standalone program and this is a bundle. It is one rule in
 * the repo and not two: a value that is unset, empty, `0` or `false` is not set; anything else is.
 * A dev hook that is read two ways is a hook whose screenshots depend on which reader ran. The rule
 * and its test live in `hook-value.ts`; this function only wires the keys to it.
 */
export function readHooks(env: Record<string, string | undefined> = process.env): KurierHooks {
  const framework = readAppDevHooks({ prefix: DEV_HOOK_PREFIX, env });
  return {
    ...framework,
    session: hookValue(env, 'SESSION'),
    agent: hookValue(env, 'AGENT'),
    permission: hookFlag(env, 'PERMISSION'),
    config: hookValue(env, 'CONFIG'),
    // Every flag below is a boolean, not the string, so `KU_APP_THINKING=0` reads as off at the call
    // site too — the old `!== undefined` in `window.ts` would have accepted the string `'0'` just as
    // happily. Both Stop hooks are flags for the same reason `THINKING` is: `KU_APP_STOP=0` has to
    // mean "do not press Stop", or the one hook that changes the state under test would be the one
    // that ignores its own off-switch. **The rules themselves live in `hook-value.ts`**, which has no
    // `gi://` in it and is therefore tested on both runtimes — this function is the wiring.
    stop: hookFlag(env, 'STOP'),
    stopEscape: hookFlag(env, 'STOP_ESCAPE'),
    dismissFailure: hookFlag(env, 'DISMISS_FAILURE'),
    // A list, read here because a variable's syntax is read here: the decision of *which* session to
    // open is the window's `#open`, and the order is the variable's own.
    switchTo: hookList(env, 'SWITCH'),
    // A flag for the same reason `DISMISS_FAILURE` is one: it changes the state under test, so it has to
    // honour its own off-switch. `KU_APP_CHOOSE_MODEL=0` must leave the dialog up, not press it.
    chooseModel: hookFlag(env, 'CHOOSE_MODEL'),
    preferences: hookFlag(env, 'PREFERENCES'),
    preferencesAgent: hookValue(env, 'PREFERENCES_AGENT'),
    thinking: hookFlag(env, 'THINKING'),
    prompt: hookValue(env, 'PROMPT'),
  };
}
