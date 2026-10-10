/**
 * The config row: the agent's own model, thought level and mode, above the composer.
 *
 * **It is at the composer and not in the header, and the plan says why (plan §5).** What you pick
 * applies to *the next thing you are about to send*, which is where a person looks when picking it; the
 * header already carries the title and Stop; and a 400-entry searchable dropdown is not a header
 * widget. So it sits in the content pane, directly above the entry — the same place the composer
 * reads for "what is this conversation for", one step earlier.
 *
 * **`Gtk.DropDown`, not `Adw.DropDown`, and not `Adw.ComboRow`.** There is no `Adw.DropDown` at all,
 * and a `Gtk.DropDown` over a `Gtk.StringList` with a `Gtk.PropertyExpression` is what the 400-entry
 * requirement actually needs: `enableSearch` needs an expression over the row's string or there is
 * nothing to search *for*. `Gtk.DropDown` also hands back an **index**, which is the value-id mapping
 * `core/config-row.ts` exists to own.
 *
 * **A `Gtk.FlowBox` with one control per line, and the number is measured.** `max-children-per-line: 1`
 * is what puts each control on its own line at every width, which sounds wasteful until the alternative
 * is named: at 360 px a row of three dropdowns has ~90 px each, and a model name at 90 px is an
 * ellipsis with no way to read the model. One per line gives every control the full measure, and at
 * 1024 px the row is three lines tall inside the same bottom bar the composer is in. The row does not
 * raise the window's width floor: `scripts/probes/window-min-width.mjs` measures that the floor is
 * `Adw.NavigationSplitView`'s, not kurier's content's, and the dropdowns at a fixed width into whatever width
 * is there.
 *
 * **Every label that could carry an agent's words says `useMarkup: false` in the constructor.** Not a
 * flag set later: Pango parses on assignment, so a `set_use_markup(false)` after the text is in arrives
 * too late (measured, `css.ts`; the plan §12 lists this as the most likely way a surface becomes the
 * theatre it exists to replace). An agent-supplied label here is a model name, and `a < b` is a
 * plausible model name.
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
import Pango from '@girs/pango-1.0';

import {
  configSelection,
  emptyConfigRow,
  isConfigChange,
  modelControl,
  type ConfigRowControl,
  type ConfigRowView,
} from '../../core/config-row.ts';
import { CONTENT_MAX_WIDTH_PX } from './constants.ts';
import { CSS } from './css.ts';

/** Width asked of each dropdown; see `#buildControl`. */
const CONFIG_CONTROL_WIDTH_PX = 200;

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
   * Pack this into the content pane directly above the composer. Starts `visible: false`: a window with
   * no agent must not have a gap where a row would be.
   */
  readonly widget: Gtk.Widget;

  readonly #clamp: Adw.Clamp;
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
      // **One control per line, at every width.** See the file header: at 360 px a shared line gives
      // each dropdown about 90 px, which is an ellipsis rather than a model name. Measured at the
      // phone floor with the real window — three lines, every value readable, nothing dropped.
      maxChildrenPerLine: 1,
      // No selection: the row is a set of independent controls, and a highlight moving between them
      // would read as "this one is chosen" — which is not a statement this row makes.
      selectionMode: Gtk.SelectionMode.NONE,
      rowSpacing: 6,
      columnSpacing: 6,
    });

    this.#box = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 6,
      marginTop: 8,
      marginBottom: 2,
      marginStart: 12,
      marginEnd: 12,
    });
    this.#box.append(this.#flow);
    this.#box.append(this.#caption);

    // **The same clamp as the transcript and the composer, imported rather than written out.** Three
    // numbers that happen to be equal is a coincidence that survives exactly until somebody changes
    // one of them, and this row sits between the other two in the same column.
    this.#clamp = new Adw.Clamp({
      child: this.#box,
      maximumSize: CONTENT_MAX_WIDTH_PX,
      tighteningThreshold: CONTENT_MAX_WIDTH_PX,
    });
    this.widget = this.#clamp;
  }

  /** A new view. Rendered whole — see the header on why this is not a diff. */
  setView(view: ConfigRowView): void {
    this.#view = view;
    this.#render();
  }

  #render(): void {
    // `visible` on the clamp, because the clamp **is** the widget the parent lays out: hiding the inner
    // box instead would leave the margins of a box that is not there.
    this.#clamp.visible = this.#view.visible;
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
      // One group per render: the labels share a width so the three dropdowns start at one edge,
      // which is what makes three lines read as one control row instead of three form fields.
      const labels = new Gtk.SizeGroup({ mode: Gtk.SizeGroupMode.HORIZONTAL });
      for (const control of this.#view.controls) {
        this.#flow.append(this.#buildControl(control, labels));
      }
    } finally {
      this.#rendering = false;
    }
    this.#caption.label = this.#view.error ?? '';
    this.#caption.visible = this.#caption.label !== '';
  }

  /** One control: a caption and a dropdown, in a box that shares the measure with the others. */
  #buildControl(control: ConfigRowControl, labels: Gtk.SizeGroup): Gtk.Widget {
    const label = new Gtk.Label({
      // **The agent's own words, with markup off in the constructor.** `opencode`'s model ids and
      // names are arbitrary strings, and `a < b` is a plausible one.
      useMarkup: false,
      xalign: 0,
      label: control.name,
      cssClasses: [CSS.dim, 'caption'],
      // The tooltip is the agent's `description` when it sent one. On the *label*, not the dropdown,
      // because the description is about the control rather than about the current value.
      tooltipText: control.description,
      ellipsize: Pango.EllipsizeMode.END,
    });

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
      // Compact, not a full-width form field: wide enough for a model name to be recognisable, narrow
      // enough that the 360 px floor still fits label + control (the row's floor is the window's).
      halign: Gtk.Align.START,
      widthRequest: CONFIG_CONTROL_WIDTH_PX,
      sensitive: control.selectable,
      tooltipText: control.description,
      valign: Gtk.Align.CENTER,
      cssClasses: [CSS.configControl],
    });

    dropdown.connect('notify::selected', () => this.#onSelected(control, dropdown));
    // Registered here rather than returned, because `#render` throws the reference away and the one
    // caller that needs it later (`openModelDropdown`) cannot be handed a widget from a method whose
    // return value nobody keeps. Keyed by the control id, so the map is read by the same name the rest
    // of the row is.
    this.#dropdowns.set(control.id, dropdown);

    const row = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 8,
    });
    labels.add_widget(label);
    row.append(label);
    row.append(dropdown);
    return row;
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
