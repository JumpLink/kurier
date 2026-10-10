/**
 * The config row: the agent's own model, thought level and mode, at the composer's bottom edge.
 *
 * **It is at the composer and not in the header, and the plan says why (plan §5).** What you pick
 * applies to *the next thing you are about to send*, which is where a person looks when picking it; the
 * header already carries the title and Stop; and a 400-entry searchable dropdown is not a header
 * widget. So it sits in the content pane, with the entry — the same place the composer reads for "what
 * is this conversation for".
 *
 * **Inside the composer's card, not in a strip above it, and that cost the per-control captions.**
 * `Composer` packs this widget along the card's bottom edge next to the Send button, which is where
 * every chat surface this window is drawn from puts the model picker. The row therefore has no clamp
 * and no margins of its own — the card is the surface and the composer owns both — and it has room for
 * three controls plus a button only with the captions gone: a `name` label and a 160 px dropdown three
 * times over already filled the 720 px column on its own (measured), so keeping the labels would have
 * wrapped the row to three lines at *every* width rather than only at the phone floor.
 *
 * **So the name moved to the dropdown, where a person and a screen reader can still get at it.** The
 * tooltip names the control and adds the agent's description when it sent one — `core/config-row.ts`
 * signals "it sent none" by making `description` the `name` — and `AccessibleProperty.LABEL` is the
 * name on its own. An unlabelled dropdown with neither would be three anonymous controls, which is the
 * failure no screenshot shows.
 *
 * **`Gtk.DropDown`, not `Adw.DropDown`, and not `Adw.ComboRow`.** There is no `Adw.DropDown` at all,
 * and a `Gtk.DropDown` over a `Gtk.StringList` with a `Gtk.PropertyExpression` is what the 400-entry
 * requirement actually needs: `enableSearch` needs an expression over the row's string or there is
 * nothing to search *for*. `Gtk.DropDown` also hands back an **index**, which is the value-id mapping
 * `core/config-row.ts` exists to own.
 *
 * **A `Gtk.FlowBox` that puts the three controls on one line while they fit, and wraps when they do not.**
 * Each dropdown asks for at most `CONFIG_CONTROL_WIDTH_PX`, so at the 720 px clamp the model, thought
 * level and mode share one line, and narrower they wrap (measured with the real widgets: one line at
 * 720 and 1024, three at 500 and 360, window granted 360) — three side by side at 360 px would leave
 * about 90 px each, an ellipsis with no way to read the model. The row does not raise the window's
 * width floor: `scripts/probes/window-min-width.mjs` measures that the floor is
 * `Adw.NavigationSplitView`'s, not kurier's content's.
 *
 * **What the cap does not do is make a dropdown narrow.** `Adw.Clamp` caps a *natural* width; the
 * minimum passes straight through, so a clamp around a dropdown whose longest value is 32 characters
 * measures the dropdown's own 287 px (the probe prints both). The row asks for 293 and the floor is
 * 360, so this costs nothing today — but a control that has to fit a narrow pane needs an ellipsis,
 * not a clamp.
 *
 * **Every label that could carry an agent's words says `useMarkup: false` in the constructor.** Not a
 * flag set later: Pango parses on assignment, so a `set_use_markup(false)` after the text is in arrives
 * too late (measured, `css.ts`; the plan §12 lists this as the most likely way a surface becomes the
 * theatre it exists to replace). That is `#caption`, which carries the agent's own refusal sentence.
 * The agent's other words here are value names inside a `Gtk.StringList`, which `Gtk.DropDown` renders
 * through labels of its own that have no markup at all — and `a < b` is a plausible model name.
 *
 * **Rebuilt from the view on every change, never diffed.** The same reason `Composer` and
 * `SessionList` do it: a half-updated row is the shape of the bug, and a rebuilt dropdown is one line
 * of code where a correct diff would be forty. The `isConfigChange` guard is what keeps the rebuild
 * from being an act — see the header of `core/config-row.ts`.
 *
 * **No Apply and no Reset.** One action per control, which is the rule `composer.ts` already states:
 * a control the person must remember to commit is a control that will not be committed.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';

import {
  configSelection,
  emptyConfigRow,
  isConfigChange,
  modelControl,
  type ConfigRowControl,
  type ConfigRowView,
} from '../../core/config-row.ts';
import { CSS } from './css.ts';

/** Widest a dropdown asks to be; three of them and the Send button fit the content clamp on one line. */
const CONFIG_CONTROL_WIDTH_PX = 160;

export interface ConfigRowOptions {
  /**
   * Called with a control id and a **value id** when a person picks one.
   *
   * The value id and not the dropdown index: `configSelection` does the mapping in core, because an
   * index is only meaningful against the list the widget was built from and the widget is rebuilt on
   * every answer.
   */
  readonly onSelect: (controlId: string, value: string) => void;
}

export class ConfigRow {
  /**
   * Hand this to `Composer`, which packs it along the inside of its card. Starts `visible: false`: a
   * window with no agent must not have a gap where a row would be.
   */
  readonly widget: Gtk.Widget;

  readonly #box: Gtk.Box;
  readonly #flow: Gtk.FlowBox;
  readonly #caption: Gtk.Label;
  readonly #onSelect: (controlId: string, value: string) => void;
  /**
   * The last view rendered.
   *
   * Held because `notify::selected` fires with a *number* and the guard needs the view it belongs to:
   * `isConfigChange` asks whether this value is the one the agent last reported, and "the last
   * reported" is a fact about the view this widget drew, not about the dropdown that fired.
   */
  #view: ConfigRowView;
  /**
   * True while this widget is writing `selected` itself.
   *
   * **The second of two guards, and the cheap one.** `isConfigChange` answers the substantive question
   * ("is this value the one the agent last reported?"), which is the rule and is tested; this one only
   * knows that the signal came from our own rebuild rather than from a person. Keeping it makes the
   * rebuild silent *by construction* instead of by having every rule about the agent's answer hold at
   * the same time — and it costs one boolean.
   */
  #rendering = false;
  /**
   * The dropdown this widget drew per control id, so a caller can point **at** one.
   *
   * **Rebuilt from scratch in `#render`, because the row is.** Everything here is rebuilt whole on
   * every agent answer (see the header), so a map that outlived a render would name widgets GTK has
   * already collected — and a stale `Gtk.DropDown` asked to pop down is a use-after-free wearing a
   * control's clothes. Holding the widget is also the only thing that makes `openModelDropdown` mean
   * "the dropdown the person sees" rather than "a dropdown we once made".
   */
  readonly #dropdowns = new Map<string, Gtk.DropDown>();

  constructor(options: ConfigRowOptions) {
    this.#onSelect = options.onSelect;
    this.#view = emptyConfigRow();

    this.#caption = new Gtk.Label({
      // In the constructor: this label can carry the refusal sentence about an agent's refusal, and
      // Pango parses on assignment.
      useMarkup: false,
      xalign: 0,
      wrap: true,
      label: '',
      cssClasses: ['caption'],
    });

    this.#flow = new Gtk.FlowBox({
      // **One line while the controls fit, one control per line when they do not.** See the file header.
      maxChildrenPerLine: 3,
      // No selection: the row is a set of independent controls, and a highlight moving between them
      // would read as "this one is chosen" — which is not a statement this row makes.
      selectionMode: Gtk.SelectionMode.NONE,
      rowSpacing: 6,
      columnSpacing: 6,
      // **START, or the three controls spread themselves across the card.** A `Gtk.FlowBox` gives
      // every child in a line the same share of the width it was given, so at `FILL` the model sat at
      // the card's left edge, the mode at its right, and the thought level exactly between them —
      // three unrelated controls reading as a toolbar. `START` hands the box its *natural* width when
      // the pane has it, which is the three packed together, and its available width when the pane
      // does not — so the wrapping at the 360 px floor is unchanged (measured: two lines, then one).
      halign: Gtk.Align.START,
    });

    // **No margins and no clamp.** Both used to be here because the row was its own strip in the
    // bottom bar; inside the composer's card the inset is the card's padding and the width cap is the
    // composer's clamp, and a second set of either would be this file holding an opinion about a
    // surface it does not own. `valign: CENTER` so the controls line up with the Send button beside
    // them rather than stretching to its row's height.
    this.#box = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 6,
      valign: Gtk.Align.CENTER,
      hexpand: true,
    });
    this.#box.append(this.#flow);
    this.#box.append(this.#caption);
    this.widget = this.#box;
  }

  /** A new view. Rendered whole — see the header on why this is not a diff. */
  setView(view: ConfigRowView): void {
    this.#view = view;
    this.#render();
  }

  #render(): void {
    // `visible` on the box, because the box **is** the widget the composer lays out. It used to be the
    // clamp around it, for the same reason: hiding something further in leaves the parent allocating
    // space for a row that is not there.
    this.#box.visible = this.#view.visible;
    if (!this.#view.visible) {
      this.#caption.label = '';
      this.#caption.visible = false;
      return;
    }
    this.#rendering = true;
    try {
      this.#dropdowns.clear();
      while (this.#flow.get_first_child() !== null) {
        const child = this.#flow.get_first_child();
        if (!child) break;
        this.#flow.remove(child);
      }
      for (const control of this.#view.controls) {
        this.#flow.append(this.#buildControl(control));
      }
    } finally {
      this.#rendering = false;
    }
    this.#caption.label = this.#view.error ?? '';
    this.#caption.visible = this.#caption.label !== '';
  }

  /** One control: a dropdown, clamped so it shares the measure with the others. */
  #buildControl(control: ConfigRowControl): Gtk.Widget {
    const list = new Gtk.StringList();
    for (const value of control.values) list.append(value.name);

    const dropdown = new Gtk.DropDown({
      model: list,
      selected: control.selected,
      // The expression is what makes search work at all: `Gtk.DropDown`'s search matches against the
      // *model's* strings through this expression, and without it a 400-entry list has a search field
      // that finds nothing. `Gtk.StringObject` is the row type of a `Gtk.StringList` — and the `$gtype`,
      // not the class, because the constructor wants a `GType` and the class is not one in the typings
      // (`Gtk.PropertyExpression.new(this_type: GObject.GType, …)`).
      expression: Gtk.PropertyExpression.new(Gtk.StringObject.$gtype, null, 'string'),
      // Only a long list needs it — 400 model ids cannot be scanned; six effort levels can. The
      // decision is a fact about the data and lives in `core/config.ts`.
      enableSearch: control.searchable,
      sensitive: control.selectable,
      // **Names the control, then describes it.** With no caption beside it this tooltip is where a
      // person reads *which* setting they are about to change, so the name comes first and the
      // agent's description follows it. `core/config-row.ts` sets `description` to the `name` when
      // the agent sent none, which is exactly the case where there is nothing to append.
      tooltipText:
        control.description === control.name ? control.name : `${control.name} — ${control.description}`,
      valign: Gtk.Align.CENTER,
      // `flat`: Adwaita's own name for a control with no raised surface of its own, which is what a
      // dropdown sitting on the composer's card has to be — a bordered button inside a card reads as
      // a second card. The theme keeps the hover and the pressed state, so it is still visibly a
      // control.
      cssClasses: ['flat', CSS.configControl],
    });
    // **The one thing a caption was still doing.** An icon-less dropdown announces its *value*, so
    // without this a screen reader reads "claude-opus-5, button" three times with nothing saying
    // which of the three settings it is. The name on its own, not the tooltip's sentence: the
    // description is help text, and an accessible name is a label.
    dropdown.update_property([Gtk.AccessibleProperty.LABEL], [control.name]);

    dropdown.connect('notify::selected', () => this.#onSelected(control, dropdown));
    // Registered here rather than returned, because `#render` throws the reference away and the one
    // caller that needs it later (`openModelDropdown`) cannot be handed a widget from a method whose
    // return value nobody keeps. Keyed by the control id, so the map is read by the same name the rest
    // of the row is.
    this.#dropdowns.set(control.id, dropdown);

    // A long model id would make the dropdown's natural width the line's, and the row would wrap at
    // 720 px with room to spare. The clamp caps what it *asks* for, so the row is one line when the
    // three fit and wraps (`FlowBox`) when they do not; the child still shrinks below the cap.
    return new Adw.Clamp({
      child: dropdown,
      maximumSize: CONFIG_CONTROL_WIDTH_PX,
      tighteningThreshold: CONFIG_CONTROL_WIDTH_PX,
      halign: Gtk.Align.START,
    });
  }

  /**
   * A person picked something. One request, or none — and no queue: the next pick has to wait for the
   * answer, because two sets in flight against one agent's option list is a race nobody can act on.
   *
   * Three refusals before anything goes out, none of them defensive:
   *
   * - `#rendering` — a write from our own rebuild. `isConfigChange` catches those as well; this one is
   *   true by construction.
   * - `isConfigChange` — the value is the one the agent already reported, so a re-selection sends
   *   nothing. This is the rule, and it is what makes the rebuild silent.
   * - `configSelection` — an index that is not on the list resolves to nothing rather than to a value
   *   from another control.
   *
   * The mapping is done **once** here rather than in each of the two checks above, so the row cannot
   * decide about one value and then act on another.
   */
  #onSelected(control: ConfigRowControl, dropdown: Gtk.DropDown): void {
    if (this.#rendering) return;
    const selection = configSelection(this.#view, control.id, dropdown.selected);
    if (!selection) return;
    if (!isConfigChange(this.#view, selection.controlId, selection.value)) return;
    this.#onSelect(selection.controlId, selection.value);
  }

  /**
   * Whether the row has a model dropdown at all — the fact `core/failure.ts`'s `failureAction` needs
   * before it offers a "Choose another model" button.
   *
   * **A getter over the last rendered view, not over the raw options.** The view is what the person
   * sees; a window that answered this from the agent's raw list could offer a button for a control
   * `projectConfigOptions` had dropped, and it would open nothing.
   */
  hasModelControl(): boolean {
    return modelControl(this.#view) !== null;
  }

  /**
   * Pop the model dropdown down. `false` when there is nothing to open.
   *
   * **This is the only way out of the process for "open the dropdown", and the caller is a failure
   * dialog** (`core/failure.ts`'s `'choose-model'`). It does not pick anything: the person still chooses
   * a value, the row still sends the set through `onSelect`, and `isConfigChange` still decides whether
   * that is a change. A dialog that picked a model on the person's behalf would be kurier holding
   * configuration authority over the agent, which is the "always allow" mistake in different clothes.
   */
  openModelDropdown(): boolean {
    const control = modelControl(this.#view);
    if (control === null) return false;
    const dropdown = this.#dropdowns.get(control.id);
    if (dropdown === undefined) return false;
    activateDropdown(dropdown);
    return true;
  }
}

/**
 * Open a `Gtk.DropDown`'s popover, which is the call a click, Enter and Space all end at.
 *
 * **A cast, and here is why one is the honest answer rather than a workaround.** `gtk_drop_down_activate`
 * is what a press on the control does, and it is **not declared in `node_modules/@girs/gtk-4.0`** — that
 * class block lists `get_model`, `set_selected`, `set_enable_search` and the four factories, and nothing
 * else. The other way in, `gtk_drop_down_get_popup`, is not even introspectable: `typeof dropdown.get_popup`
 * is `undefined` on GTK 4.22.5.
 *
 * **Measured, not assumed:** on a realized dropdown inside a presented `Adw.ApplicationWindow`,
 * `activate()` flips the control's internal `Gtk.Popover` from `visible=false` to `visible=true` on the
 * next main-loop turn (`gjs -m`, `GDK_BACKEND=x11`) — see the sibling probe the AGENTS.md dev-fixtures
 * recipe points at. The alternatives are worse: a second widget for the same value is a second control
 * for one setting, and reaching for the popover by walking `get_first_child()` would make the open depend
 * on GTK's internal child order.
 */
function activateDropdown(dropdown: Gtk.DropDown): void {
  (dropdown as Gtk.DropDown & { activate(): void }).activate();
}
