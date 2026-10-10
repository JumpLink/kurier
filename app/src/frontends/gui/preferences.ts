/**
 * The preferences dialog: which agent kurier connects to.
 *
 * **Action rows with radio check buttons, not an `Adw.ComboRow`.** A combo row shows one line per item
 * and no subtitle, so the path and version that tell "my opencode" from "the bundled one" would be lost —
 * and the popover is the widget the devtools plane cannot operate (`hooks.ts`). A group of rows wraps its
 * subtitles at 360 px and every choice is visible at once. Titles and subtitles are plain text
 * (`useMarkup: false`): a path may contain `&`.
 *
 * What is listed is decided in `core/settings-view.ts`; this file renders it and passes a choice back.
 * **An unavailable row is selectable**: the choice may be for an install that is coming, and the note says
 * what runs meanwhile. A write that fails is shown here, and the rows are re-read so they show what the
 * file really holds. A settings file kurier must not overwrite locks the rows (`ChoicesView.readOnly`).
 *
 * **The dialog opens before the host has answered.** `load(null)` is the cheap view; where a host question
 * exists (a Flatpak) `detect()` runs it asynchronously, and the rows are drawn again from its result. A
 * dialog closed in the meantime ignores the late answer, and `ready()` is what a dev hook waits on.
 */

import Adw from '@girs/adw-1';
import GLib from '@girs/glib-2.0';
import Gtk from '@girs/gtk-4.0';

import type { AgentChoice, ResolveContext } from '@lotse/core';
import { choiceFromKey, type ChoicesView } from '../../core/settings-view.ts';

/** What the host detection found; the part of a `ResolveContext` the rows are built from. */
export type HostDetection = Pick<ResolveContext, 'detections' | 'bundledAvailable'>;

export interface PreferencesActions {
  /**
   * Read the settings file and build the rows, with no child process. `null` is before the host has
   * answered (host rows pending); after `detect()` it is called with the answer. Called on open and after
   * every choice.
   */
  readonly load: (detected: HostDetection | null) => ChoicesView;
  /** The host detection, or `null` when there is nothing to wait for. Must not reject. */
  readonly detect: (() => Promise<HostDetection>) | null;
  /**
   * Persist a choice (`null` = Automatic). Returns where an old file was moved, if one was. Throws when
   * the file cannot be written or must not be overwritten.
   */
  readonly save: (choice: AgentChoice | null) => { readonly backup: string | null };
}

/** What `select` did, so a caller never claims a write that did not happen. */
export type SelectOutcome = 'chose' | 'unchanged' | 'refused' | 'failed' | 'missing';

const SCOPE_LINE = 'A change applies the next time kurier starts. This window keeps its agent.';

export class PreferencesDialog {
  readonly #actions: PreferencesActions;
  #dialog: Adw.PreferencesDialog | null = null;
  #group: Adw.PreferencesGroup | null = null;
  #note: Gtk.Label | null = null;
  #rows: Adw.ActionRow[] = [];
  readonly #checks = new Map<string, Gtk.CheckButton>();
  #rendering = false;
  #error: string | null = null;
  #backup: string | null = null;
  #detected: HostDetection | null = null;
  #readOnly = false;
  #saved = false;
  #ready: Promise<void> = Promise.resolve();

  constructor(actions: PreferencesActions) {
    this.#actions = actions;
  }

  show(parent: Gtk.Widget): void {
    if (this.#dialog) return;
    const dialog = new Adw.PreferencesDialog({ title: 'Preferences' });
    const page = new Adw.PreferencesPage();
    const noteGroup = new Adw.PreferencesGroup();
    // Plain text: the note carries paths and error messages, and a path may contain `&`.
    const note = new Gtk.Label({ wrap: true, xalign: 0, visible: false, useMarkup: false });
    noteGroup.add(note);
    const group = new Adw.PreferencesGroup({ title: 'Agent', description: SCOPE_LINE });
    page.add(noteGroup);
    page.add(group);
    dialog.add(page);
    this.#dialog = dialog;
    this.#group = group;
    this.#note = note;
    this.#error = null;
    this.#backup = null;
    this.#detected = null;
    dialog.connect('closed', () => {
      if (this.#dialog === dialog) this.#dialog = null;
      this.#rows = [];
      this.#checks.clear();
    });
    this.#render();
    dialog.present(parent);
    const { detect } = this.#actions;
    if (detect) {
      this.#ready = detect().then(
        (detected) => {
          // A dialog closed (or reopened) while the host answered ignores the late result.
          if (this.#dialog !== dialog) return;
          this.#detected = detected;
          this.#render();
        },
        () => undefined,
      );
    } else {
      this.#ready = Promise.resolve();
    }
  }

  /** Resolves once the rows are final: at once when nothing is detected asynchronously. */
  ready(): Promise<void> {
    return this.#ready;
  }

  /**
   * Choose a row by key, the way a click on it does — `KU_APP_PREFERENCES_AGENT` calls this. Only
   * `'chose'` means a write happened.
   */
  select(key: string): SelectOutcome {
    const check = this.#checks.get(key);
    if (!check) return 'missing';
    if (this.#readOnly) return 'refused';
    if (check.active) return 'unchanged';
    this.#saved = false;
    check.set_active(true);
    return this.#saved ? 'chose' : 'failed';
  }

  #render(): void {
    const group = this.#group;
    const note = this.#note;
    if (!group || !note) return;
    let view: ChoicesView;
    try {
      view = this.#actions.load(this.#detected);
    } catch (error) {
      view = {
        rows: [],
        note: `Could not read the settings: ${error instanceof Error ? error.message : String(error)}`,
        readOnly: true,
      };
    }
    this.#readOnly = view.readOnly;
    group.set_sensitive(!view.readOnly);
    this.#rendering = true;
    for (const row of this.#rows) group.remove(row);
    this.#rows = [];
    this.#checks.clear();
    let first: Gtk.CheckButton | null = null;
    for (const entry of view.rows) {
      const check = new Gtk.CheckButton({ valign: Gtk.Align.CENTER, active: entry.selected });
      if (first) check.set_group(first);
      else first = check;
      const row = new Adw.ActionRow({
        title: entry.title,
        subtitle: entry.subtitle,
        useMarkup: false,
        activatableWidget: check,
      });
      row.add_prefix(check);
      if (!entry.available) row.add_css_class('dim-label');
      check.connect('toggled', () => {
        if (this.#rendering || !check.active) return;
        this.#choose(entry.key);
      });
      group.add(row);
      this.#rows.push(row);
      this.#checks.set(entry.key, check);
    }
    this.#rendering = false;
    const moved = this.#backup === null ? null : `The earlier settings file was moved to ${this.#backup}.`;
    const lines = [this.#error, moved, view.note].filter((line): line is string => line !== null);
    note.set_label(lines.join('\n'));
    note.set_visible(lines.length > 0);
    note.set_css_classes(['caption', this.#error !== null ? 'error' : 'warning']);
  }

  #choose(key: string): void {
    const choice = choiceFromKey(key);
    if (choice === undefined || this.#readOnly) return;
    try {
      const { backup } = this.#actions.save(choice);
      if (backup !== null) this.#backup = backup;
      this.#error = null;
      this.#saved = true;
    } catch (error) {
      this.#error = `Could not save your choice: ${error instanceof Error ? error.message : String(error)}`;
    }
    // After the handler returns: the widget that emitted `toggled` must not be removed from inside it.
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      if (this.#dialog) this.#render();
      return GLib.SOURCE_REMOVE;
    });
  }
}
