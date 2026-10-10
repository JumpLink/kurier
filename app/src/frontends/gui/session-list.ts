/**
 * The sidebar's session list: kurier's own records, grouped under "Today" / "Yesterday" / "This
 * week" / "Earlier", newest first.
 *
 * **The window never reads the store itself.** It is handed the records, or a failure, by whoever
 * built it — `main.ts` today, a file monitor later. That keeps the one question this widget answers
 * ("what does a list of sessions look like") separate from the one it must not answer ("where do
 * sessions come from"), which is the same split `@lotse/session`'s store makes one layer down.
 *
 * Three states, one `Gtk.Stack`, and each is a different sentence: a list, **no sessions yet**, and
 * **the session file could not be read**. An empty list for the third would tell a person their
 * history is gone when it is only unreadable — the one lie this surface must never tell about a file
 * that holds their conversations.
 *
 * The grouping and the time labels are pure (`core/session-groups.ts`) and tested on both runtimes;
 * nothing in here decides which day a session belongs to.
 *
 * **The open session is marked by this file, not by `Gtk.ListBox`'s selection.** The list runs in
 * `SelectionMode.NONE` and the mark is a CSS class plus an accessible state; see `#mark` for why
 * that is not a preference but the only way to get what the window means by "open".
 */

import Adw from '@girs/adw-1';
import GLib from '@girs/glib-2.0';
import Gtk from '@girs/gtk-4.0';
import Pango from '@girs/pango-1.0';
import { basename } from 'node:path';

import { labelOf, type SessionRecord } from '@lotse/session';

import { GROUP_TITLES, groupByDate, groupOf, timeLabelOf } from '../../core/session-groups.ts';
import { CSS } from './css.ts';

export interface SessionListOptions {
  /** A row was activated — by click, tap or Enter. Fires again for the row that is already open. */
  readonly onOpen: (record: SessionRecord) => void;
}

type ListState = 'list' | 'empty' | 'error';

/** Read after the row's name, which is where "the one you are looking at" belongs. See `#mark`. */
const OPEN_SESSION_DESC = 'The session you are looking at.';

export class SessionList {
  /** Pack this. The list, the empty state and the error state are its three children. */
  readonly widget: Gtk.Stack;

  readonly #list: Gtk.ListBox;
  readonly #error: Adw.StatusPage;
  /** Row order, so `row.get_index()` names a record. Rebuilt with the rows, never patched. */
  #records: SessionRecord[] = [];
  /** The clock the headers were computed against — one "now" per fill, so two rows never disagree. */
  #now = new Date();
  /** The session the content pane shows. `#marked` is where that is drawn; this names it. */
  #openId: string | null = null;
  /** The row carrying the mark, so `select` can take the old one off. Not a lookup by id. */
  #marked: Gtk.ListBoxRow | null = null;

  constructor(options: SessionListOptions) {
    // `NONE`, and not `SINGLE`. Measured on GTK 4.22.5: in `SINGLE` mode activating a row selects it
    // as well — `row-selected` fires and `selected_row` is that row — so the selection is a *second*
    // answer to "which session is open", one GTK owns. The first version listened to it and put the
    // selection back whenever it disagreed with `#openId`, which meant the handler meant to protect
    // the mark reverted the very click that produced it. Focus belongs to the keyboard, the mark
    // belongs to the content pane, and with nothing in between this list can hold the two apart.
    this.#list = new Gtk.ListBox({
      selectionMode: Gtk.SelectionMode.NONE,
      cssClasses: ['navigation-sidebar'],
    });
    this.#list.set_header_func((row, before) => this.#header(row, before));
    // `row-activated`, not `row-selected`: it fires for a click *and* for Enter on the focused row,
    // and it fires again for the row that is already open — which matters on a collapsed window,
    // where a person goes back and taps the same row again.
    this.#list.connect('row-activated', (_list, row) => {
      const record = this.#records[row.get_index()];
      if (!record) return;
      this.select(record.id);
      options.onOpen(record);
    });

    this.#error = new Adw.StatusPage({
      iconName: 'dialog-warning-symbolic',
      title: 'Could not read the sessions',
      vexpand: true,
      cssClasses: ['compact'],
    });

    this.widget = new Gtk.Stack({ vexpand: true });
    this.widget.add_named(new Gtk.ScrolledWindow({ child: this.#list, vexpand: true }), 'list');
    // One quiet line and no second placeholder: the `+` in the sidebar's header bar is the affordance,
    // and the content pane already carries the call to action. `valign: START` so it sits where the
    // first row would, not in the middle of an empty pane.
    this.widget.add_named(
      new Gtk.Label({
        label: 'No sessions yet',
        useMarkup: false,
        wrap: true,
        valign: Gtk.Align.START,
        marginTop: 18,
        marginStart: 12,
        marginEnd: 12,
        vexpand: true,
        cssClasses: [CSS.dim, 'caption'],
      }),
      'empty',
    );
    this.widget.add_named(this.#error, 'error');
    this.#show('empty');
  }

  /**
   * Replace the whole list.
   *
   * Rebuilt rather than diffed: the record count is a person's own history, not a feed, and a
   * rebuild cannot leave a stale index behind — which is the bug a hand-patched row list gets.
   */
  setSessions(records: readonly SessionRecord[], now: Date = new Date()): void {
    this.#now = now;
    // **Rows first, then `#records`** — and that order is load-bearing.
    // GTK calls the header func for rows it is removing as well: measured, `remove_all` over a
    // three-row list calls it three times, each time for the row left at index 0. The func reads
    // `#records[row.get_index()]`, so with the new array already in place it would read record *n*
    // of the new list for row *n* of the old one — a wrong group header on a row already on its way
    // out. Emptying the list first means every one of those calls sees the array the rows were built
    // from.
    this.#list.remove_all();
    this.#marked = null;
    this.#records = groupByDate(records, now).flatMap((group) => [...group.records]);
    for (const record of this.#records) this.#list.append(buildRow(record, now));
    // The header func again, over every row: `append` evaluates only the row it inserted (measured
    // — appending a fifth row calls it for index 4 alone), so this is what makes each header a
    // function of the finished list rather than of the order the rows arrived in. One call, where
    // deciding headers row by row here would be one per row.
    this.#list.invalidate_headers();
    // A session that is no longer in the list is no longer open as far as the list is concerned.
    // Re-applied rather than kept: the rows are new widgets, so the old mark died with them.
    const open = this.#rowOf(this.#openId);
    this.#openId = open ? this.#openId : null;
    this.#mark(open);
    this.#show(this.#records.length === 0 ? 'empty' : 'list');
  }

  /** The file exists but could not be read or parsed. Its message is shown as it is. */
  showError(message: string): void {
    // `description` is Pango markup. A path with `&` in it would otherwise blank the whole page —
    // and the error page is the one place a broken rendering hides the actual problem.
    this.#error.description = GLib.markup_escape_text(message, -1);
    this.#show('error');
  }

  /** Mark a session as the open one, without activating it. Returns it, or `undefined`. */
  select(id: string): SessionRecord | undefined {
    const row = this.#rowOf(id);
    if (!row) return undefined;
    this.#openId = id;
    this.#mark(row);
    return this.#records[row.get_index()];
  }

  /** Nothing is open: the mark goes, and no row stands for the pane. */
  clearSelection(): void {
    this.#openId = null;
    this.#mark(null);
  }

  /**
   * Move the mark to this row, or to none.
   *
   * A CSS class for the eye and an `AccessibleProperty.DESCRIPTION` for a screen reader, because the
   * class is invisible to one and the description is invisible to everybody. Neither is GTK's own
   * selection: with `SelectionMode.NONE` no row ever gets `:selected`, so the theme's selected-row
   * styling never fires here and the mark has to be one this file applies.
   *
   * **The description, not `AccessibleState.SELECTED`, and that is a measurement.** The obvious
   * encoding of "this is the open session" is the selected state, and it cannot be set from GJS on
   * GTK 4.22.5: `row.update_state([Gtk.AccessibleState.SELECTED], [true])` emits
   * `GLib-GObject-CRITICAL: g_value_get_int: assertion 'G_VALUE_HOLDS_INT (value)' failed` — GTK holds
   * the state as an integer, GJS hands over a boolean — and it does so **once per call**, so every
   * click in the list cost a warning. Measured and ruled out, all on GTK 4.22.5 / GJS 1.88.1:
   * `[true]`, `[1]`, the states flattened into one array, and a `GObject.Value` typed as boolean
   * (`new GObject.Value(GObject.TYPE_BOOLEAN)`, which GJS rejects outright as "not initialized with a
   * type"). `Gtk.AccessibleProperty.SELECTED_TEXT` is the same defect — it warns too.
   * `AccessibleProperty.DESCRIPTION` and `.LABEL` are clean, and a description is the better sentence
   * anyway: it is read after the name, which is where "the session you are looking at" belongs.
   *
   * What is lost: a screen reader no longer reports the row as *selected*, which is a state some
   * assistive technology surfaces as such. In exchange the surface stops writing a critical to stderr
   * on every click, and stderr is where this project's own warnings are counted. `AGENTS.md` sends
   * that class of defect upstream rather than working around it silently — this comment is that note.
   */
  #mark(row: Gtk.ListBoxRow | null): void {
    if (this.#marked) {
      this.#marked.remove_css_class(CSS.openRow);
      this.#marked.update_property([Gtk.AccessibleProperty.DESCRIPTION], ['']);
    }
    this.#marked = row;
    if (!row) return;
    row.add_css_class(CSS.openRow);
    row.update_property([Gtk.AccessibleProperty.DESCRIPTION], [OPEN_SESSION_DESC]);
  }

  #rowOf(id: string | null): Gtk.ListBoxRow | null {
    if (id === null) return null;
    const index = this.#records.findIndex((record) => record.id === id);
    return index < 0 ? null : this.#list.get_row_at_index(index);
  }

  #show(state: ListState): void {
    this.widget.visibleChildName = state;
  }

  /**
   * A header above the first row of each group, and nowhere else.
   *
   * Called by GTK on every invalidation, and for rows it is removing as well — which is why
   * `setSessions` empties the list *before* it replaces `#records`. The `if (!record) return` is the
   * other half of that: this func is handed row indices, and a row whose index has no record behind
   * it is a row that no longer belongs to `#records`. It gets no header rather than the next row's.
   */
  #header(row: Gtk.ListBoxRow, before: Gtk.ListBoxRow | null): void {
    const record = this.#records[row.get_index()];
    if (!record) return;
    const group = groupOf(record.updatedAt, this.#now);
    const previous = before ? this.#records[before.get_index()] : undefined;
    if (previous && groupOf(previous.updatedAt, this.#now) === group) {
      row.set_header(null);
      return;
    }
    // Rebuilt only when it changes: GTK calls this on every invalidation, and a new label each time
    // would churn widgets for a header that says the same word.
    const current = row.get_header();
    if (current instanceof Gtk.Label && current.label === GROUP_TITLES[group]) return;
    row.set_header(
      new Gtk.Label({
        label: GROUP_TITLES[group],
        xalign: 0,
        cssClasses: [CSS.dateHeader, CSS.dim],
      }),
    );
  }
}

/**
 * One session: its label, and under it where it ran and when.
 *
 * `Gtk.Label`s rather than an `Adw.ActionRow`, because `ActionRow.title` is **markup by default** and
 * the label here is the agent's own words — an answer containing `<` or `&` would render as nothing,
 * or as something else. A plain label has no markup unless asked for.
 */
function buildRow(record: SessionRecord, now: Date): Gtk.ListBoxRow {
  const title = new Gtk.Label({
    label: labelOf(record),
    xalign: 0,
    // Ellipsized, not wrapped — see `.lotse-session-title`.
    ellipsize: Pango.EllipsizeMode.END,
    cssClasses: [CSS.sessionTitle],
  });
  const where = new Gtk.Label({
    // Only the parts that are there: a record with no usable `cwd` reads "opencode", not
    // "opencode · " — a dangling separator is the only thing on screen, which is the worst of both.
    label: [record.agent, basenameOf(record.cwd)].filter((part) => part !== '').join(' · '),
    xalign: 0,
    hexpand: true,
    ellipsize: Pango.EllipsizeMode.END,
    cssClasses: [CSS.dim, 'caption'],
  });
  const when = new Gtk.Label({
    label: timeLabelOf(record.updatedAt, now),
    cssClasses: [CSS.dim, 'caption', 'numeric'],
  });
  const meta = new Gtk.Box({ spacing: 6 });
  meta.append(where);
  meta.append(when);

  const box = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    spacing: 2,
    marginTop: 6,
    marginBottom: 6,
  });
  box.append(title);
  box.append(meta);

  const row = new Gtk.ListBoxRow({ child: box });
  // The accessible name is the label, not "label, agent, dir, time" read as one run-on sentence.
  row.update_property([Gtk.AccessibleProperty.LABEL], [labelOf(record)]);
  return row;
}

/**
 * The last path segment, or the whole string when there is nothing to shorten.
 *
 * Guarded on the *type*, not on emptiness: `SessionRecord.cwd` is typed `string` and the store is a
 * file a person can edit, and `basename(undefined)` throws. One record with a missing `cwd` would
 * take the whole list down with it — and `#load`'s try/catch turns that into the "could not read the
 * sessions" page, so the page would be about a store that reads fine and has one bad row in it.
 */
function basenameOf(cwd: unknown): string {
  return typeof cwd === 'string' && cwd.length > 0 ? basename(cwd) : '';
}
