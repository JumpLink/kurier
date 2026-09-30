/**
 * The window — the shell, and nothing else yet.
 *
 * This file is deliberately the *smallest* thing that can be wrong in an instructive way. It proves
 * the whole chain — `gi://Adw` → the bundler → a real display — before there is a transcript in it,
 * because every later mistake is cheaper to find while the only variable is "does the window come
 * up at all".
 *
 * **Two panes, two header bars, and that is not the thing being avoided.** An
 * `Adw.NavigationSplitView` gives each pane its own `Adw.HeaderBar`, and that is exactly what makes
 * the collapsed back button appear: `Adw.HeaderBar` grows one for you inside an `Adw.NavigationPage`.
 * The reference apps this surface is being compared against get minimalism wrong in a different way
 * — Alpaca stacks two header rows of four icons each, LibreChat adds an icon rail *next to* a text
 * sidebar. The rule this window follows is not "fewer controls" but "no control that points at
 * nothing": every element is here because something in the kernel produced it.
 *
 * **The shell is built here rather than taken from `createNavShell`.** That is a real decision with
 * a measured reason, not a preference: the packaged shell takes a `readonly NavItem[]` and hands
 * back a `LoadingStack`, so the list cannot grow when a session arrives, has no handle for
 * `Gtk.ListBox`'s `set_header_func` (which is how "Today" / "Yesterday" groups work), and has no
 * bottom bar — and the composer *has* to be in a bottom bar, because it is the one control that
 * belongs under the conversation rather than in it. The breakpoint is copied from it verbatim.
 *
 * The gap is upstream, and the honest move is both: build the shell kurier needs, and file the
 * feature request. A slice is not hostage to somebody else's release train, and a workaround that
 * ossifies is worse than a small local one that is honestly labelled.
 */

import Adw from '@girs/adw-1';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';

import { APP_NAME, COLLAPSE_WIDTH_PX, WINDOW_HEIGHT, WINDOW_WIDTH } from './constants.ts';
import type { KurierHooks } from './hooks.ts';

export interface MainWindowOptions {
  /** Read once at startup. See `hooks.ts` — a state only a click can reach is a state untested. */
  readonly hooks: KurierHooks;
}

export class MainWindow extends Adw.ApplicationWindow {
  static readonly GTypeName = 'KurierMainWindow';

  readonly #split: Adw.NavigationSplitView;
  readonly #sessionList: Gtk.ListBox;
  readonly #placeholder: Adw.StatusPage;

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

    this.#sessionList = buildSessionList();
    this.#placeholder = buildPlaceholder();
    this.#split = buildSplitView(this.#sessionList, this.#placeholder);

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
    this.#applyDevHooks(options.hooks);
  }

  /** The session list, for the next slice to fill. Exposed rather than private from the start. */
  get sessionList(): Gtk.ListBox {
    return this.#sessionList;
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
   * line says "not yet", because at this stage that is the truth rather than an excuse.
   */
  #applyDevHooks(hooks: KurierHooks): void {
    for (const [name, value] of [
      ['SESSION', hooks.session],
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
 * The sidebar's session list, empty.
 *
 * A `Gtk.ListBox` rather than the packaged shell's `Adw.NavigationView`, for one measured reason:
 * `set_header_func` is how the "Today" / "Yesterday" groups get drawn, and a list that cannot carry
 * group headers cannot be sorted the way a person reads a list of sessions. It is also the only
 * handle that survives a row being added later, which is the next thing that happens to it.
 *
 * `NONE` selection mode: clicking a row will *open* a session, and a row that also shows a focus
 * ring suggests a mode this list does not have.
 */
function buildSessionList(): Gtk.ListBox {
  return new Gtk.ListBox({
    selectionMode: Gtk.SelectionMode.NONE,
    cssClasses: ['navigation-sidebar'],
  });
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
    description: 'Pick a session on the left, or start one to begin a conversation with an agent.',
    vexpand: true,
  });
}

/** The sidebar pane: a title bar with the app's name, and the list under it. */
function buildSidebar(list: Gtk.ListBox): Adw.NavigationPage {
  const box = new Adw.ToolbarView({ vexpand: true });
  // An `Adw.HeaderBar` is a **top bar of an `Adw.ToolbarView`**, never a child of a plain `Gtk.Box`.
  // That is the documented shape since libadwaita 1.4 and it is what `@gjsify/adwaita-app`'s own
  // `createNavShell` builds. It also decides how the pane's edge looks: a bare header bar does not
  // merge with the pane beside it, and `Adw.NavigationSplitView` then draws its separator straight
  // through the header row — a vertical rule across the top of the window that no GNOME app has.
  // Measured in both shapes by screenshot, not believed.
  box.add_top_bar(
    new Adw.HeaderBar({
      showEndTitleButtons: false,
      showStartTitleButtons: false,
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
 * The bar itself stays, empty, because it is what gives the collapsed view its back button — adding
 * a title later is a smaller change than discovering the surface has no way back from a
 * conversation.
 */
function buildContent(placeholder: Adw.StatusPage): Adw.NavigationPage {
  const box = new Adw.ToolbarView({ vexpand: true });
  box.add_top_bar(new Adw.HeaderBar({ showTitle: false }));
  box.set_content(placeholder);
  return new Adw.NavigationPage({ title: APP_NAME, child: box });
}

/** The split view, with a page per side — see the file header on why there are two header bars. */
function buildSplitView(sidebar: Gtk.ListBox, content: Adw.StatusPage): Adw.NavigationSplitView {
  return new Adw.NavigationSplitView({
    sidebar: buildSidebar(sidebar),
    content: buildContent(content),
    minSidebarWidth: 260,
    maxSidebarWidth: 340,
    // Not collapsed on a wide monitor: a sidebar that starts hidden hides the list for no reason,
    // which is the "control that points at nothing" in its other direction. The breakpoint below
    // collapses it when the window genuinely has no room.
    collapsed: false,
  });
}

GObject.registerClass(MainWindow);
