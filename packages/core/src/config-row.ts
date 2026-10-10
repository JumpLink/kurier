/**
 * The config row, as data — every decision about it that a screenshot cannot be asked about.
 *
 * **Why this file exists.** Plan §7 step 7 draws a row of dropdowns above the composer, and the
 * interesting parts of it are not the drawing:
 *
 * - **a control exists only if the agent reported one** — an empty option list means *no row at all*,
 *   and "no row" is a decision about visibility, not about a label;
 * - **a refused set must not move the row** — the person clicked, the agent said no, and a dropdown
 *   still showing the value they chose is a lie about what the agent is doing;
 * - **re-selecting the current value sends nothing** — the row is rebuilt on every answer, and a
 *   rebuild that fires a request turns "kurier showed the model" into "kurier set the model";
 * - **a value the agent did not offer is never sent**, whatever the widget believes is selected.
 *
 * Each of those compiles, each of them runs, and each of them is the bug. `permission.ts` made the
 * same argument for the same reason and `composer.ts` followed it: the widget renders, core decides,
 * and the decisions are testable on GJS and Node with no display and no pointer.
 *
 * **What is here, in one line:** `configRowInput` (what to draw), `configSelection` (which value a
 * dropdown row means), `configRequest` (what goes on the wire), `configAfterSet` (what the answer did
 * to the row), `isConfigChange` (whether this is a change at all) and `parseConfigOptionSpec` (the one
 * format `KU_APP_CONFIG` is read in).
 *
 * **The agent's `currentValue` is the only truth.** Every view here is built from the last list the
 * agent reported — from `session/new`, from `session/load`/`session/resume`, from a
 * `config_option_update`, and from the answer to a set. Nothing is remembered between sessions and
 * nothing is persisted: kurier keeping a preferred model would be kurier holding configuration
 * authority over the agent, which is the "always allow" mistake in different clothes (see
 * `LOTSE_CLIENT_CAPABILITIES`).
 *
 * **A `boolean` option is skipped, and that is not an oversight.** kurier announces
 * `session.configOptions: {}` without the `boolean` capability (`gate.ts`), so an agent entitled to
 * believe it has promised no booleans — and the one agent measured (`opencode acp` 2.0.19) refuses a
 * tagged value outright. `projectConfigOptions` still projects them, because the `type` check belongs
 * to the protocol boundary; announcing the capability and drawing the widget go in together, and
 * until then a switch would be a control the agent is not obliged to honour.
 */
import { configValue, projectConfigOptions, type ConfigControl, type ConfigValue } from './config.ts';
import type { SessionConfigOption, SessionUpdate, SetSessionConfigOptionRequest } from '@lotse/acp/types';

/** What the row needs that is not the agent's own answer: a set in flight, and a sentence. */
export interface ConfigRowInput {
  /**
   * The agent's last reported options, exactly as it sent them. `null` before it has answered — and
   * before it has answered there is nothing to draw, which is why this is `null` and not `[]`.
   */
  readonly options: SessionConfigOption[] | null;
  /** True while a `session/set_config_option` is in flight. The row goes insensitive, and never queues. */
  readonly busy?: boolean;
  /** A sentence a refused set left behind, or `null`. Never an agent's own words — see `REFUSED`. */
  readonly error?: string | null;
}

/** One control, with everything a widget needs and nothing it has to compute. */
export interface ConfigRowControl {
  readonly id: string;
  /** The agent's label for the control itself. The row draws it verbatim, with `useMarkup: false`. */
  readonly name: string;
  /** The tooltip: the agent's `description` when it sent one, otherwise the name it must show. */
  readonly description: string;
  /**
   * The agent's own category for this control, or `null` when it sent none.
   *
   * **Carried through rather than dropped, because `modelControl` needs it.** The widget does not draw
   * a category and would have no use for the field; the *surface* does, when a failure dialog asks
   * whether there is a model dropdown to open (`core/failure.ts`'s `failureAction`), and deciding that
   * by re-reading the raw options in the window would be a second opinion about what may be drawn.
   */
  readonly category: string | null;
  /**
   * The values in the agent's order, each already labelled — `group: name` for a grouped list.
   *
   * `ConfigValue` and not a slimmer shape of our own: the row has no use for `group` beyond the label
   * `core/config.ts` already put into `name`, and a second value type would be a second place for the
   * "what is a value called" rule to live.
   */
  readonly values: readonly ConfigValue[];
  /**
   * The index of the current value, or `-1`.
   *
   * `-1` rather than a throw: `Gtk.DropDown` has a perfectly good way to say "nothing is selected",
   * and a control that claims a selection it does not have is the failure this row exists to avoid.
   */
  readonly selected: number;
  /** Whether the list needs a search field. A fact about the data — decided in `core/config.ts`. */
  readonly searchable: boolean;
  /** False while a set is in flight: one set at a time, and no queue behind it. */
  readonly selectable: boolean;
}

/** The whole row: whether it exists, and what is on it. */
export interface ConfigRowView {
  /**
   * Whether there is a row at all.
   *
   * **False for an agent that reported nothing, and false before one has answered.** The plan's rule
   * is "render nothing when the agent reports nothing": not an empty row, not a disabled one, not a
   * placeholder that points at no value. A row of nothing is a gap in the layout that reads as a bug,
   * and this window's rule is that every element is here because something in the kernel produced it.
   */
  readonly visible: boolean;
  readonly controls: readonly ConfigRowControl[];
  readonly busy: boolean;
  /** The refusal sentence, or `null`. Cleared by the next set and by any new agent answer. */
  readonly error: string | null;
}

/** What one dropdown row means: a control and one of its values, or nothing at all. */
export interface ConfigSelection {
  readonly controlId: string;
  readonly value: string;
}

/**
 * The category the model control carries, as `opencode acp` 2.0.19 sends it. Measured, not guaranteed
 * — the same standing as `MODE_CONTROL_ID` below, and for the same reason.
 */
const MODEL_CATEGORY = 'model';

/**
 * The row's model control, or `null` when the agent reported no model option.
 *
 * **This is the whole of "is there a dropdown to open", and it is asked here rather than in the
 * window.** `core/failure.ts`'s `failureAction` needs the answer to decide whether the `'model'`
 * failure dialog may carry a "Choose another model" button, and the honest source for it is the view
 * the row drew — a window that looked at the raw options, or at `ConfigRowView.controls[0]`, would be
 * guessing at a list whose order and membership it does not own.
 *
 * **`category`, not the id `'model'`.** Same reasoning as `modelFirst` in `core/config.ts`: an agent
 * that does not categorise gets no button rather than a button that opens the thought level, and a
 * button pointing at the wrong dropdown is worse than no button.
 */
export function modelControl(view: ConfigRowView): ConfigRowControl | null {
  return view.controls.find((control) => control.category === MODEL_CATEGORY) ?? null;
}

/**
 * The sentence a refused set leaves on the row. Fixed English, no `Intl`.
 *
 * **Not the agent's error text.** An agent's message is written for whoever debugs it — it names
 * internal ids and error codes — and putting it in a caption under a model dropdown makes the window
 * look broken and says nothing about what the person can do. The detail goes to the log
 * (`AgentSession`), and this says the one thing that is both true and actionable: it did not change,
 * so what you see is what is in use. See `core/session-groups.ts` §2 on why this repo has no `Intl`.
 */
export const REFUSED = 'The agent did not change this. Its previous value is still in use.';

/**
 * The starting view, for a surface that has an agent but no answer yet.
 *
 * Not `configRowInput({ options: null })` written at the call site: "nothing yet" is the state a
 * window spends most of its life in, and it should have one name.
 */
export function emptyConfigRow(): ConfigRowView {
  return { visible: false, controls: [], busy: false, error: null };
}

/**
 * Project the agent's answer into the row.
 *
 * The one join of "what the agent offers" (`core/config.ts`) and "what is happening right now" (a set
 * in flight, a refusal to show). A widget that assembled either from the other would be re-deriving a
 * rule that is cheap to test and easy to get subtly wrong.
 */
export function configRowInput(input: ConfigRowInput): ConfigRowView {
  const busy = input.busy === true;
  const controls = projectSelects(input.options).map((control) => ({ ...control, selectable: !busy }));
  if (controls.length === 0) return emptyConfigRow();
  return {
    visible: true,
    controls,
    busy,
    // While a set is in flight there is nothing to say about the previous one: the row is about to
    // be replaced by the answer, and a refusal that is still being read as the state is a lie.
    error: busy ? null : (input.error ?? null),
  };
}

/** Project, and keep only what the row can draw. See the header on why a switch is not that. */
function projectSelects(options: SessionConfigOption[] | null): ConfigRowControl[] {
  const controls: ConfigRowControl[] = [];
  for (const control of projectConfigOptions(options)) {
    if (control.kind !== 'select') continue;
    controls.push({
      id: control.id,
      name: control.name,
      description: control.description ?? control.name,
      category: control.category,
      values: control.values,
      // `currentValue` is one of the values — that is what `narrowConfigSelect` guarantees — so this
      // is never `-1` for a control that got this far. Written as the index anyway, because the index
      // is what the widget needs and `-1` is what GTK offers for "nothing".
      selected: control.values.findIndex((value) => value.value === control.currentValue),
      searchable: control.searchable,
      selectable: true,
    });
  }
  return controls;
}

/**
 * Which value a dropdown row means, or `null`.
 *
 * **The id↔row mapping belongs here, because it is the part that is easy to get wrong and impossible
 * to see.** A `Gtk.DropDown` hands out an *index*; `session/set_config_option` wants a value id; the
 * two agree only while the list is the list the widget was built from. An index past the end, or an
 * index into a control that is not on the row, is `null` — never a value from another control, which
 * is the failure mode of doing this arithmetic in the widget: it types, it compiles, and it sets the
 * wrong model.
 */
export function configSelection(
  view: ConfigRowView,
  controlId: string,
  index: number,
): ConfigSelection | null {
  const control = view.controls.find((candidate) => candidate.id === controlId);
  if (!control) return null;
  if (!Number.isInteger(index) || index < 0 || index >= control.values.length) return null;
  return { controlId, value: control.values[index]!.value };
}

/**
 * The value payload for a `session/set_config_option`, or `null` when the agent does not offer it.
 *
 * `configValue` knows the `anyOf` asymmetry in the request — a bare string for a `select`, a
 * `{type:"boolean"}` object for a switch — and this adds the check that has to come first: **a value
 * the agent did not offer is not sent.** A caller that resolved an id from somewhere else (a stale
 * list, a dev hook, a bug) gets `null` here rather than a request the agent will refuse.
 *
 * A `boolean` control is `null` too, and for the same reason `projectSelects` does not put one on the
 * row: nothing may send a tagged boolean while `LOTSE_CLIENT_CAPABILITIES` does not announce it.
 */
export function configRequest(
  control: ConfigControl,
  value: string,
): SetSessionConfigOptionRequest['value'] | null {
  if (control.kind !== 'select') return null;
  if (!control.values.some((entry) => entry.value === value)) return null;
  return configValue(control, value);
}

/**
 * What an answered set did to the row.
 *
 * **The agent's answer replaces the row, and a refusal does not move it at all.** Two halves of one
 * rule: the answer carries the full option list, so an agent that clamped the value has told us the
 * clamped one; and on an error there is no new truth, so the row stays on the agent's last answered
 * state with a sentence saying so. Keeping the person's click instead would show a model the agent
 * never accepted, which is the failure the "the agent's list is the truth" rule exists to prevent —
 * `client.ts` says the same of the response.
 */
export function configAfterSet(view: ConfigRowView, answer: SessionConfigOption[] | Error): ConfigRowView {
  // An answer that is neither an `Error` nor a list cannot be projected, so there is nothing to show
  // and nothing to throw in a setter a widget calls — which is `REFUSED` as well.
  if (answer instanceof Error || !Array.isArray(answer)) {
    return { ...view, busy: false, error: REFUSED };
  }
  return configRowInput({ options: answer });
}

/**
 * Whether picking `value` for `controlId` is a change at all.
 *
 * **The guard every rebuild needs.** The row is rebuilt whenever the agent answers, and setting
 * `Gtk.DropDown.selected` to the value the agent reported fires `notify::selected` — the same signal
 * a person picking fires. Without this guard, showing the row after a set sends that set again, in a
 * loop, against an agent that has been asked nothing. So: a re-selection of the value that is already
 * current is *not* a change, and neither is an unknown control — there is nothing there to change.
 *
 * **A value the agent did not offer *is* a change, and that is deliberate rather than an oversight.**
 * This function answers one question — "did the person choose something other than what is in use?"
 * — and an unoffered value is plainly not what is in use. Whether it may be *sent* is a different
 * question with a different answer, and it lives in `configRequest`: a caller that wants both (which
 * `AgentSession.setConfigOption` does) asks both. Folding them into one function was the earlier shape,
 * and it left the second check unreachable for anyone who had not read this comment.
 */
export function isConfigChange(view: ConfigRowView, controlId: string, value: string): boolean {
  const control = view.controls.find((candidate) => candidate.id === controlId);
  if (!control) return false;
  const current = control.values[control.selected];
  if (!current) return false;
  return current.value !== value;
}

/**
 * A `session/update` as an answer about what the options now are, or `null` when it is not one.
 *
 * **The two updates that mean something to the row, and both mean it fully.**
 *
 * - `config_option_update` carries `configOptions` — the agent's **whole** list, not a delta, which
 *   is why it replaces rather than merges. This is the only way the row hears about a change it did
 *   not ask for: opencode pushes one when the model changes and answers with the list for `effort`
 *   and `mode`, so a row that only read set answers would be stale after an agent-side change.
 * - `current_mode_update` carries one id and no list. It moves the **mode control** and nothing else,
 *   because it is a statement about the mode; rewriting `effort` or `model` from it would be inventing
 *   a value the agent never sent.
 *
 * `null` for every other update, so the caller can hand this each notification without filtering
 * first — the same bargain `narrowSessionUpdate` makes one level up.
 */
export function applyConfigUpdate(
  options: SessionConfigOption[] | null,
  update: SessionUpdate,
): SessionConfigOption[] | undefined {
  if (update.sessionUpdate === 'config_option_update') {
    return Array.isArray(update.configOptions) ? update.configOptions : undefined;
  }
  if (update.sessionUpdate === 'current_mode_update' && options !== null) {
    return options.map((option) =>
      option.id === MODE_CONTROL_ID ? { ...option, currentValue: update.currentModeId } : option,
    );
  }
  return undefined;
}

/**
 * The `configId` a `current_mode_update` moves.
 *
 * `'mode'` is the id opencode 2.0.19 uses, measured; it is not something the schema guarantees and
 * not worth guessing at beyond that one name — an agent that calls its mode option something else
 * keeps whatever `currentValue` its last full list carried, which is honest rather than wrong. A
 * constant rather than a parameter so the rule is one line in one file and a test can name it.
 */
const MODE_CONTROL_ID = 'mode';

/**
 * `KU_APP_CONFIG`'s one format: `configId=valueId`.
 *
 * **Both halves are required, and neither is guessed.** A control id alone says which option to set
 * and not to what, and a value id alone cannot be resolved — a hook that picked the other half would
 * make a screenshot of "some model" rather than of the value in the variable. Splitting on the first
 * `=` rather than on whitespace or a colon: a value id is an opaque agent string, and an agent is
 * free to put anything but an `=` in it.
 */
export function parseConfigOptionSpec(spec: string): ConfigSelection | null {
  const at = spec.indexOf('=');
  if (at <= 0 || at === spec.length - 1) return null;
  return { controlId: spec.slice(0, at), value: spec.slice(at + 1) };
}
