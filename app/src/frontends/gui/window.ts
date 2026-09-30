/**
 * The window — the shell, and nothing else yet.
 *
 * This file is deliberately the *smallest* thing that can be wrong in an instructive way. It proves
 * the whole chain — `gi://Adw` → the bundler → a real display — before there is a transcript in it,
 * because every later mistake is cheaper to find while the only variable is "does the window come
 * up at all".
 *
 * **Two panes, two header bars, and that is not the thing being avoided.** An
 * `Adw.NavigationSplitView` gives each pane its own `Adw.HeaderBar`. The reference apps this surface
 * is being compared against get minimalism wrong in a different way
 * — Alpaca stacks two header rows of four icons each, LibreChat adds an icon rail *next to* a text
 * sidebar. The rule this window follows is not "fewer controls" but "no control that points at
 * nothing": every element is here because something in the kernel produced it.
 *
 * **The shell is built here rather than taken from `createNavShell`.** That is a real decision with
 * a measured reason, not a preference: the packaged shell takes a `readonly NavItem[]` and hands
 * back a plain `Gtk.Stack` with no `Gtk.ListBox` in it, so the list cannot grow when a session
 * arrives, has no handle for `Gtk.ListBox`'s `set_header_func` (which is how "Today" / "Yesterday"
 * groups work), and has no bottom bar — and the composer *has* to be in a bottom bar, because it is
 * the one control that belongs under the conversation rather than in it. The breakpoint is copied
 * from it verbatim.
 *
 * The gap is upstream, and the honest move is both: build the shell kurier needs, and file the
 * feature request — https://github.com/gjsify/gjsify/issues/1911. A slice is not hostage to somebody
 * else's release train, and a workaround that ossifies is worse than a small local one that is
 * honestly labelled.
 *
 * **The vertical line between the two panes is wanted. Do not "fix" it.** It is
 * `AdwNavigationSplitView`'s own separator — `strings libadwaita-1.so.0` names
 * `adw-navigation-split-view.c` and `adw_flap_set_separator` — and it runs the full window height,
 * header row included. That looked wrong until the pixels said why: the header bars are transparent
 * by design (libadwaita ≥ 1.4), so one pane is one surface from top to bottom. The two panes really
 * are two surfaces, and the hairline is what says so. A tonal step alone reads as a rendering seam;
 * the line reads as structure — the better of the two.
 *
 * The pane shape decides how that line looks, and this file once claimed the opposite — that a bare
 * `Adw.HeaderBar` in a `Gtk.Box` and an `Adw.ToolbarView` top bar render pixel-identical. They do
 * not, and `scripts/probes/headerbar-ab.mjs` is where the numbers come from; it renders both shapes
 * and prints columns 255–263 at four heights, dark style, GTK 4.22.5 / libadwaita 1.9.3:
 *
 * - At y=20 and again below the header row, both shapes give the sidebar pane (46,46,50) and the
 *   content pane (34,34,38) — two surfaces, and that is the whole reason the separator is wanted.
 * - Shape A, the bare header bar: the header row is a surface of its own and a (77,77,81) column
 *   sits at x=260, and at y=46 a (29,29,34) border runs across it with (63,63,67) at x=260.
 * - Below that, at y ≥ 47, both shapes show one unbroken (29,29,34) column at x=259.
 *
 * So `ToolbarView` is the shape, see `buildSidebar`. There is no public property on
 * `AdwNavigationSplitView` to hide the separator at all — only `collapsed`, `content`,
 * `min_/max_sidebar_width`.
 */

import Adw from '@girs/adw-1';
import GObject from '@girs/gobject-2.0';
import GLib from '@girs/glib-2.0';
import Gtk from '@girs/gtk-4.0';

import { labelOf, type SessionRecord } from '@kurier/session';

import { APP_NAME, COLLAPSE_WIDTH_PX, WINDOW_HEIGHT, WINDOW_WIDTH } from './constants.ts';
import type { KurierHooks } from './hooks.ts';
import { SessionList } from './session-list.ts';

export interface MainWindowOptions {
  /** Read once at startup. See `hooks.ts` — a state only a click can reach is a state untested. */
  readonly hooks: KurierHooks;
  /**
   * The records to list, already filtered to the principal this window is for. A function rather
   * than an array so a failure to read is the window's to *show* — thrown here, it lands on the
   * error page instead of killing the app before there is a window to say why.
   */
  readonly loadSessions: () => readonly SessionRecord[];
}

export class MainWindow extends Adw.ApplicationWindow {
  static readonly GTypeName = 'KurierMainWindow';

  readonly #split: Adw.NavigationSplitView;
  readonly #sessions: SessionList;
  readonly #placeholder: Adw.StatusPage;
  readonly #contentPage: Adw.NavigationPage;
  readonly #contentHeader: Adw.HeaderBar;

  constructor(app: Adw.Application, options: MainWindowOptions) {
    super({
      application: app,
      title: APP_NAME,
      defaultWidth: WINDOW_WIDTH,
      defaultHeight: WINDOW_HEIGHT,
      // A floor, not the phone form factor. See `constants.ts`: 480×400 is roughly the narrowest
      // window in which the collapsed conversation plus its composer are still usable, and it is
      // deliberately well above the 360×294 a phone app would have to claim.
      widthRequest: 480,
      heightRequest: 400,
    });

    this.#sessions = new SessionList({ onOpen: (record) => this.#open(record) });
    this.#placeholder = buildPlaceholder();
    const panes = buildSplitView(this.#sessions.widget, this.#placeholder);
    this.#split = panes.split;
    this.#contentPage = panes.contentPage;
    this.#contentHeader = panes.contentHeader;

    // `content`, not `set_child`: `Adw.ApplicationWindow` refuses the GtkWindow setter with
    // "gtk_window_set_child() is not supported for AdwApplicationWindow", and the property is the
    // documented replacement. A property rather than a `set_content()` method — that method belongs
    // to `Adw.ToolbarView`, which is a different class and an easy one to reach for by mistake.
    this.content = this.#split;

    // **After** the content, and the order is load-bearing. Measured on libadwaita 1.9.3: adding a
    // breakpoint before the content is set trips
    // `adw_breakpoint_bin_add_breakpoint: assertion 'ADW_IS_BREAKPOINT_BIN (self)' failed`, and the
    // collapse then silently never happens. With the content in place first, the same breakpoint
    // sets `collapsed` on the first frame at 500 px — checked by running it, not by reading it.
    this.#applyBreakpoint();
    this.#load(options.loadSessions);
    this.#applyDevHooks(options.hooks);
  }

  #load(loadSessions: () => readonly SessionRecord[]): void {
    try {
      this.#sessions.setSessions(loadSessions());
    } catch (error) {
      this.#sessions.showError(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Show a session in the content pane.
   *
   * `show_content = true` is what makes the collapsed window work at all. Its default is **false**
   * (`Adw-1.gir`: `default-value="FALSE"`, and read back at runtime), so on a narrow window the
   * sidebar is what shows, and until a row set it nothing ever brought the content pane forward.
   * Peer review caught that. Setting it is also what makes libadwaita's own back button appear —
   * see `buildContent`.
   *
   * **Only `description` is escaped, and that is not an oversight.** `Adw.StatusPage.title` and
   * `Adw.NavigationPage.title` are plain text on both: `adw-status-page.ui` sets `use-markup` on
   * the description label only and the title label is filled with `gtk_label_set_text`. A label
   * whose own words go through `gtk_label_set_text` would drop the agent's `<` and `&`, so escaping
   * them would be the bug. `description` is the one field here that *is* Pango markup, so a working
   * directory with an `&` in it has to be escaped — into nothing, and then the page reads right.
   *
   * What it shows is what the record holds, and no more: the transcript is the next step, and a
   * page that pretended to have one would be the "control that points at nothing" in prose.
   */
  #open(record: SessionRecord): void {
    const label = labelOf(record);
    // Not `chat-symbolic`: the Adwaita icon theme has no such icon and the page showed a broken-image
    // placeholder. Checked with `Gtk.IconTheme.has_icon`, like every icon name in this file.
    this.#placeholder.iconName = 'utilities-terminal-symbolic';
    // Plain text, not markup — see the note on escaping below.
    this.#placeholder.title = label;
    const entries = record.turns.length === 1 ? '1 entry' : `${record.turns.length} entries`;
    // The description IS markup (`adw-status-page.ui` sets `use-markup` on that label), and a working
    // directory is the person's own and may hold an `&`.
    this.#placeholder.description = GLib.markup_escape_text(
      `${record.agent} in ${record.cwd} · ${entries}`,
      -1,
    );
    this.#contentPage.title = label;
    // The title can be shown now: it names the session, not the app, so it is no longer the
    // double title `buildContent` hides it against.
    this.#contentHeader.showTitle = true;
    this.#split.showContent = true;
  }

  /**
   * Collapse the sidebar below `COLLAPSE_WIDTH_PX`, and only below it.
   *
   * Copied from `@gjsify/adwaita-app`'s `createNavShell` rather than imported, because the packaged
   * shell cannot host this window — see the file header. The number is the same, and the reason is
   * the same: it is where a 300 px sidebar plus a readable conversation stops being possible.
   *
   * `Adw.Breakpoint` rather than a `size-allocate` handler, so the condition is declared once and
   * the framework owns the transition — a handler that sets `collapsed` on every allocation also
   * fights the person's own toggle, which is the kind of bug that only shows up on a resize.
   */
  #applyBreakpoint(): void {
    const condition = Adw.BreakpointCondition.parse(`max-width: ${COLLAPSE_WIDTH_PX}px`);
    if (!condition) return;
    const breakpoint = new Adw.Breakpoint({ condition });
    breakpoint.add_setter(this.#split, 'collapsed', true);
    this.add_breakpoint(breakpoint);
  }

  /**
   * Apply the startup hooks.
   *
   * **Logged, not silently ignored.** A hook that does nothing is indistinguishable from a typo in
   * its name, and the whole point of a hook is to be relied on; the first version of a surface whose
   * states cannot be screenshotted is one where nobody knows which ones were ever looked at. Every
   * line that says "not yet" says it because at this stage that is the truth rather than an excuse.
   *
   * `KU_APP_SESSION` is the first one acted on: it opens the session exactly as a click would, so
   * the collapsed content pane and its back button are reachable without a pointer.
   */
  #applyDevHooks(hooks: KurierHooks): void {
    if (hooks.session !== undefined) {
      const record = this.#sessions.select(hooks.session);
      if (record) this.#open(record);
      else console.log(`kurier: KU_APP_SESSION=${hooks.session} — no such session in the list`);
    }
    for (const [name, value] of [
      ['CONFIG', hooks.config],
      ['PERMISSION', hooks.permission],
      ['THINKING', hooks.thinking],
    ] as const) {
      if (value === undefined || value === false) continue;
      console.log(`kurier: KU_APP_${name}=${String(value)} — read, not yet acted on`);
    }
    if (hooks.debug) console.log('kurier: verbose dev logging on');
  }
}

/**
 * The content pane, before a session is chosen.
 *
 * An `Adw.StatusPage` rather than an empty white area, because "nothing here yet" and "something
 * failed to load" look identical in an empty box — and only one of them is true right now. The
 * wording is about kurier rather than about the agent: no agent is running yet, and copy that
 * implies otherwise is a small lie in the first screen anybody sees.
 *
 * `vexpand` so it centres in the pane: an empty area with content jammed under the header reads as a
 * layout bug rather than as a deliberate empty state.
 */
function buildPlaceholder(): Adw.StatusPage {
  return new Adw.StatusPage({
    iconName: 'mail-send-receive-symbolic',
    title: 'No session open',
    // Neither "on the left" (on a narrow window the list is a page of its own) nor "start one"
    // (there is no control for that yet, and copy that points at one is a control that isn't there).
    description: 'Pick a session from the list to see it here.',
    vexpand: true,
  });
}

/** The sidebar pane: a title bar with the app's name, and the list under it. */
function buildSidebar(list: Gtk.Widget): Adw.NavigationPage {
  const box = new Adw.ToolbarView({ vexpand: true });
  // An `Adw.HeaderBar` is a **top bar of an `Adw.ToolbarView`**, never a child of a plain `Gtk.Box`.
  // That is the documented shape since libadwaita 1.4 and it is what `@gjsify/adwaita-app`'s own
  // `createNavShell` builds. It also decides how the pane's edge looks: a bare header bar does not
  // merge with the pane beside it, and `Adw.NavigationSplitView` then draws its separator straight
  // through the header row — a vertical rule across the top of the window that no GNOME app has.
  // The pixels are in `scripts/probes/headerbar-ab.mjs` and in the file header.
  box.add_top_bar(
    new Adw.HeaderBar({
      // No `show*TitleButtons: false` here. It hid the close button on the collapsed window, where
      // this bar is the only one on screen; left alone, libadwaita puts the window buttons on
      // whichever bar sits at the window's edge, in both shapes.
      // `Adw.WindowTitle`, not a `Gtk.Label` with `title-1`: that name class is for a *window*
      // title, and at that size a sidebar label reads as shouting.
      titleWidget: new Adw.WindowTitle({ title: APP_NAME, subtitle: '' }),
    }),
  );
  box.set_content(list);
  return new Adw.NavigationPage({ title: APP_NAME, child: box });
}

/**
 * The content pane. One page, reused per session later — see the plan's §7 step 4.
 *
 * `showTitle: false`, and **that is not cosmetic.** An `Adw.HeaderBar` inside an
 * `Adw.NavigationPage` shows that page's title, so naming this page "kurier" printed the app's name
 * twice across the top of the window — the sidebar said it and the empty content pane said it
 * again, which is this file's own "no control that points at nothing" rule committed by a title
 * instead of by a button. libadwaita says the same in as many words: "AdwNavigationPage … is
 * missing a title. To hide a header bar title, consider using AdwHeaderBar:show-title instead."
 *
 * **The back button is libadwaita's, not ours.** An `Adw.HeaderBar` in the content page of a
 * collapsed `Adw.NavigationSplitView` grows one by itself as soon as `show_content` is true. This
 * file once claimed the opposite and shipped its own button, from a measurement that rested on an
 * API that does not exist: there is no `get_start_widget()` in libadwaita 1.9.3 (0 hits in
 * `Adw-1.gir`), and `show_content` was `false` — its default — in every state measured, so nothing
 * could have been seen to go back to. The screenshot after the session list first set it to `true`
 * then showed two back buttons side by side. What the collapsed window was missing was never a
 * button; it was `MainWindow.#open`.
 *
 * The title comes back once there is a session to name — `MainWindow.#open` turns it on.
 */
function buildContent(header: Adw.HeaderBar, placeholder: Adw.StatusPage): Adw.NavigationPage {
  const box = new Adw.ToolbarView({ vexpand: true });
  box.add_top_bar(header);
  box.set_content(placeholder);
  return new Adw.NavigationPage({ title: APP_NAME, child: box });
}

/** The content pane's header bar. `MainWindow.#open` turns `showTitle` on and names the page. */
function buildContentHeader(): Adw.HeaderBar {
  return new Adw.HeaderBar({ showTitle: false });
}

interface Panes {
  readonly split: Adw.NavigationSplitView;
  /** Retitled when a session opens. */
  readonly contentPage: Adw.NavigationPage;
  readonly contentHeader: Adw.HeaderBar;
}

/** The split view, with a page per side — see the file header on why there are two header bars. */
function buildSplitView(sidebar: Gtk.Widget, content: Adw.StatusPage): Panes {
  const contentHeader = buildContentHeader();
  const contentPage = buildContent(contentHeader, content);
  const split = new Adw.NavigationSplitView({
    sidebar: buildSidebar(sidebar),
    content: contentPage,
    minSidebarWidth: 260,
    maxSidebarWidth: 340,
    // Not collapsed on a wide monitor: a sidebar that starts hidden hides the list for no reason,
    // which is the "control that points at nothing" in its other direction. The breakpoint collapses
    // it when the window genuinely has no room — and **only** the breakpoint may do that. Measured:
    // a breakpoint applies on a condition *change*, so one manual `collapsed = false` while the
    // window is already narrow means it never collapses again, at any width, in that process. A
    // client moves between the panes with `show_content`; libadwaita owns `collapsed`.
    collapsed: false,
  });
  return { split, contentPage, contentHeader };
}

GObject.registerClass(MainWindow);
