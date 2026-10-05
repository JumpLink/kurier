/**
 * The window: the behaviour, and the wiring between the shell and the surface.
 *
 * **The tree is in `window.blp`; this file is what happens to it.** Every pane, header bar and
 * status page that does not depend on a running agent is declared once, in the template, and read
 * back here as an internal child. What stays in TypeScript is the three widgets whose content is a
 * running agent's — the session list, the transcript, the composer — plus every decision the window
 * makes about them.
 *
 * **This file decides nothing.** Every question it answers — may Send be pressed, what does the
 * status line say, where does the scroll go — is answered by `core/`, and the window's job is to pass
 * the answer to a widget and to hand the widget's events back. Plan §7 step 5 is where that stops
 * being theoretical: there is a live turn behind the composer now, so a decision taken here would be a
 * decision with a process behind it.
 *
 * **Two panes, two header bars, and that is not the thing being avoided.** An
 * `Adw.NavigationSplitView` gives each pane its own `Adw.HeaderBar`. The reference apps this surface
 * is being compared against get minimalism wrong in a different way
 * — Alpaca stacks two header rows of four icons each, LibreChat adds an icon rail *next to* a text
 * sidebar. The rule this window follows is not "fewer controls" but "no control that points at
 * nothing": every element is here because something in the kernel produced it.
 *
 * **The shell is declared here rather than taken from `createNavShell`.** That is a real decision with
 * a measured reason, not a preference: the packaged shell takes a `readonly NavItem[]` and hands
 * back a plain `Gtk.Stack` with no `Gtk.ListBox` in it, so the list cannot grow when a session
 * arrives, has no handle for `Gtk.ListBox`'s `set_header_func` (which is how "Today" / "Yesterday"
 * groups work), and has no bottom bar — and the composer *has to* be in a bottom bar, because it is
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
 * So `ToolbarView` is the shape, and the template says so where the shape is. There is no public
 * property on `AdwNavigationSplitView` to hide the separator at all — only `collapsed`, `content`,
 * `min_/max_sidebar_width`.
 *
 * **One agent subprocess for this whole window, and the window never touches it.** `AgentSession` owns
 * the process and the turns; `window.ts` only passes it a callback for lines and one for snapshots. It
 * is the reason a person can click through thirty sessions without spawning thirty `opencode`s (plan
 * §6), and the reason the composer's Send was able to be a real button in this step instead of the
 * disabled one step 4 shipped.
 */

import Adw from '@girs/adw-1';
import Gio from '@girs/gio-2.0';
import GLib from '@girs/glib-2.0';
import GObject from '@girs/gobject-2.0';
// Type-only, and the reason it reads that way: the `Gtk.Stack` the window names is the template's
// `contentStack`, and the only mention of `Gtk` left in this file is that declaration. The import
// that used to *build* one is gone with `buildSplitView`.
import Gtk from '@girs/gtk-4.0';

import { labelOf, type AgentSource, type SessionRecord, type TranscriptEntry } from '@kurier/session';

import { AgentSession, type AgentSnapshot } from '../../core/agent-session.ts';
import type { RecordedResolution } from '../../core/agents/resolve.ts';
import type { AgentCommand } from '../../core/agents/stdio.ts';
import { displayCwd } from '../../core/cwd.ts';
import type { EmptyStateView, NoticeView } from '../../core/empty-state.ts';
import type { AgentAttachment } from '../../core/turn.ts';
import { keepsDraft, type ComposerInput } from '../../core/composer-state.ts';
import { parseConfigOptionSpec, type ConfigRowView } from '../../core/config-row.ts';
import { LoginController } from '../../core/login/controller.ts';
import { loginUnavailableReason, openLoginSession } from '../../core/login/session.ts';
import { failureAction, failureToShow, staleDialog, type FailureNotice } from '../../core/failure.ts';
import { agentStatus } from '../../core/turn.ts';
import {
  APP_NAME,
  COLLAPSE_WIDTH_PX,
  WINDOW_HEIGHT,
  WINDOW_MIN_WIDTH_PX,
  WINDOW_WIDTH,
} from './constants.ts';
import type { KurierHooks } from './hooks.ts';
import { Composer } from './composer.ts';
import { ConfigRow } from './config-row.ts';
import { FailureDialog } from './failure-dialog.ts';
import { LoginDialog } from './login-dialog.ts';
import { PermissionDialog } from './permission-dialog.ts';
import { PreferencesDialog, type PreferencesActions } from './preferences.ts';
import { SessionList } from './session-list.ts';
import { TranscriptView } from './transcript-view.ts';
import Template from './window.blp';

/**
 * How often `KU_APP_PERMISSION` reconsiders, and how long it waits for a real request before it
 * stages one of its own.
 *
 * **A poll, not a single timeout, because "has a real request arrived yet" is not knowable in
 * advance.** The agent's own question lands somewhere after the prompt goes out, and where depends on
 * the agent: against the stand-in it is `KU_STANDIN_DELAY_MS × (chunks + the opening beats)` — over
 * three seconds at the defaults, and longer the moment somebody sets `KU_STANDIN_DELAY_MS=900`. A
 * fixed delay either fires before the real question (and the fixture is what gets photographed) or
 * far after it. Polling is what makes "the agent's question wins" true rather than approximately true,
 * and the cost is one timer that says nothing.
 *
 * **Two different waits, because there are two different situations.** With no turn running there is
 * no agent that could ask, so the fixture is staged at the first tick — a screenshot run does not sit
 * through a deadline to get its dialog. With a turn running, the wait is the deadline, and it exists
 * so the hook cannot hang forever against an agent that never asks.
 */
const PERMISSION_STAGE_POLL_MS = 250;
const PERMISSION_STAGE_DEADLINE_MS = 8_000;

/**
 * How often the failure-dialog hooks reconsiders, and what one step buys them.
 *
 * **A step, not a deadline, because there is nothing here to wait *for* except the failure.** Both
 * hooks photograph the same moment — a dialog about session A while the person moves to session B —
 * and that moment is defined by the failure, which arrives when the agent's `session/load` answers and
 * not before. A deadline would have to be long enough for the slowest agent in reach and short enough
 * that a screenshot run does not sit through it, which is the same false choice `PERMISSION_STAGE_*`
 * documents.
 *
 * **250 ms is long enough to be sure the dialog is on screen and short enough not to matter.** The
 * dialog for the failure has just been presented when the first tick that finds it runs, and a
 * screenshot taken afterwards shows the state the hook set out to create.
 */
const FAILURE_HOOK_STEP_MS = 250;
/** Finer than the failure hooks: the stand-in's chunks are ~900 ms apart, and the hook must land between two. */
const MIDTURN_HOOK_STEP_MS = 50;

/**
 * What the window needs in order to own a turn.
 *
 * **`append` is a separate argument from `loadSessions` rather than one store passed whole**, because
 * the window's two uses of it have nothing to do with each other: one reads the file once at startup
 * (and may fail, which belongs to the sidebar's error page), the other writes a line per streamed chunk.
 * A `SessionStore` would drag `create`/`update`/`remove` in beside them, and the window would then
 * have methods nothing calls.
 */
export interface MainWindowOptions {
  /** Read once at startup. See `hooks.ts` — a state only a click can reach is a state untested. */
  readonly hooks: KurierHooks;
  /**
   * The records to list, already filtered to the principal this window is for. A function rather
   * than an array so a failure to read is the window's to *show* — thrown here, it lands on the
   * error page instead of killing the app before there is a window to say why.
   */
  readonly loadSessions: () => readonly SessionRecord[];
  /** Which agent to start on the first prompt. Resolved in `main.ts`: `KU_APP_AGENT`, else the available setting, else host install, else bundled. */
  readonly agent: AgentCommand;
  /** Which copy `agent` is — what a new conversation's record names. */
  readonly agentSource?: AgentSource;
  /**
   * Where a new chat runs, and the home it is abbreviated against. `null` when no directory could be
   * found at all: then there is no New chat and the window opens on the session list alone.
   */
  readonly newChat: { readonly cwd: string; readonly home: string | null } | null;
  /** Write a new conversation's record. `SessionStore.create`. */
  readonly createSession?: (record: SessionRecord) => void;
  /**
   * The agent a stored session names, on the copy that held it — `resolveRecorded`. Left out when
   * `KU_APP_AGENT` pins an agent, so a fixture record naming `opencode` is still answered by the stand-in.
   */
  readonly resolveAgent?: (id: string, source: AgentSource | undefined) => Promise<RecordedResolution>;
  /** What the preferences dialog reads and writes. Absent: no Preferences entry. */
  readonly preferences?: PreferencesActions;
  /** Nothing could be resolved: the content pane says so and Send is off. Absent: an agent exists. */
  readonly noAgent?: Extract<EmptyStateView, { kind: 'no-agent' }>;
  /** The privacy banner to show under the content header, until it is dismissed. */
  readonly notice?: NoticeView;
  /** Remember that the notice was dismissed. */
  readonly rememberNotice?: (id: NoticeView['id']) => void;
  /** Persist streamed transcript lines. Called once per arriving batch, in order. */
  readonly appendTurns?: (sessionId: string, entries: TranscriptEntry[]) => void;
  /** The clock, injected so a screenshot run is the only place a real one is used. */
  readonly now?: () => string;
}

export class MainWindow extends Adw.ApplicationWindow {
  // The GType name is also the template's `template $KurierMainWindow` — the two must agree, and
  // `window.blp` is where the tree is.
  static readonly GTypeName = 'KurierMainWindow';

  /** The split view, and the breakpoint target. `window.blp` owns the widths. */
  declare readonly _split: Adw.NavigationSplitView;
  /**
   * The sidebar pane and its `Adw.WindowTitle`, both named in the template and both titled here.
   *
   * **`APP_NAME` is the only place the app's name is spelled.** A template cannot import a
   * TypeScript constant, so the two `Adw.NavigationPage` titles and the sidebar's `Adw.WindowTitle`
   * are set from the constructor instead of being written into `window.blp` as literals that would
   * have to be kept in step with `constants.ts` by hand.
   */
  declare readonly _sidebarPage: Adw.NavigationPage;
  declare readonly _sidebarTitle: Adw.WindowTitle;
  /** Holds the session list. `Adw.Bin` in the template, so nothing wraps the list but a bin. */
  declare readonly _sidebarHost: Adw.Bin;
  /** Retitled when a session opens — which is also what turns the content header's title on. */
  declare readonly _contentPage: Adw.NavigationPage;
  /** Holds the transcript. One view for the whole window, refilled per session. See the constructor. */
  declare readonly _transcriptHost: Adw.Bin;
  /**
   * The content pane's two states — "nothing is open" and "this session" — in one `Gtk.Stack`.
   *
   * A stack rather than swapping `Adw.ToolbarView.set_content`, and the reason is the composer: the
   * header bar and the composer belong to the *pane* and must survive the switch. A session list of
   * thirty rows behind thirty `NavigationPage`s would rebuild the composer's scroller on every click,
   * which loses the entry's scroll position and its text — the two things a person is in the middle
   * of. Two named children and one assignment is the whole mechanism, and the three named states are
   * the template's.
   */
  declare readonly _contentStack: Gtk.Stack;
  declare readonly _contentHeader: Adw.HeaderBar;
  /**
   * Holds the agent's config row, directly above the composer in the same bottom bar.
   *
   * Its own field rather than a part of the composer because the two have different clocks: the
   * composer re-renders on every turn state move, this re-renders when the agent answers about its
   * options. One host per widget keeps that split visible in the markup.
   */
  declare readonly _configHost: Adw.Bin;
  /** Holds the composer, as the content pane's bottom bar. Plan §7 step 4. */
  declare readonly _composerHost: Adw.Bin;
  /** One dim line under the composer naming the directory a new chat will run in. Hidden otherwise. */
  declare readonly _cwdCaption: Gtk.Label;
  declare readonly _noticeBanner: Adw.Banner;
  declare readonly _noAgentPage: Adw.StatusPage;
  declare readonly _noAgentBody: Gtk.Label;
  declare readonly _noAgentCommands: Gtk.Box;
  declare readonly _noAgentDocs: Gtk.Label;
  declare readonly _noAgentPreferences: Gtk.Button;

  readonly #sessions: SessionList;
  /** One transcript view for the whole window, refilled per session. See the constructor. */
  readonly #transcript: TranscriptView;
  /** The composer, as the content pane's bottom bar. Plan §7 step 4. */
  readonly #composer: Composer;
  /**
   * The agent's own configuration, directly above the composer. Plan §7 step 7.
   *
   * **Its own field rather than a part of the composer, because the two have different clocks.** The
   * composer re-renders on every turn state move; this re-renders when the agent answers about its
   * options. A combined widget would mean every streamed update rebuilt the model dropdown, and every
   * model change rebuilt the composer's status line.
   */
  readonly #config: ConfigRow;
  /**
   * The approval dialog. One per window, because one question is ever shown at a time — `core/permission.ts`
   * queues the rest, and `PermissionDialog.show` replaces rather than stacks.
   */
  readonly #permissions: PermissionDialog;
  /**
   * The modal a failure earns: plan §6's auth trap, its reattach refusal, and a provider refusal after
   * a prompt was sent (issue #2, which offers a different model).
   *
   * **Its own field, and only ever raised from `#onSnapshot`.** What to say is `core/failure.ts`'s
   * decision; all this file does is notice that the controller reported a failure *of a kind that has
   * a dialog* and put the sentence up. `start` failures never come here — see `failureNotice`.
   */
  readonly #failures: FailureDialog;
  readonly #login = new LoginDialog();
  /** The agent the window starts, which is also the one a login is for. */
  readonly #loginAgent: AgentCommand;
  /**
   * The failure this window has already put a dialog up for, held by identity.
   *
   * **The field that stops the dialog from coming back.** `#onSnapshot` runs on every state move and
   * `attachment` stays `failed` until the next attach, so a guard on "is a dialog up right now" is not a
   * guard at all — dismissing one clears it and the next emit opens it again. Holding the *object* is
   * what makes the rule right in both directions: this failure is never shown twice, and the next
   * failure — which `AgentSession` builds as a new attachment — is shown as soon as it happens. The
   * decision itself is `failureToShow` in `core/failure.ts`; this is only where the answer is kept.
   */
  #shownFailure: AgentAttachment | null = null;
  /** The turn machinery. One per window, one agent subprocess behind it. */
  readonly #agent: AgentSession;
  /** The session on screen, or `null` while none is. The only place the window answers "which". */
  #openRecord: SessionRecord | null = null;
  /** The records the sidebar lists, newest first — the list a new conversation is added to. */
  #records: SessionRecord[] = [];
  readonly #loadSessions: () => readonly SessionRecord[];
  readonly #newChat: MainWindowOptions['newChat'];
  /** The `KU_APP_NEW_CHAT` poll, so a close cannot fire it into a window that is gone. */
  #newChatSource: number | null = null;
  #midTurnSource: number | null = null;
  /** Lines from the agent (not the person's own) drawn so far; `KU_APP_NEW_CHAT_MIDTURN` waits for one. */
  #streamed = 0;
  /**
   * The spawn-time closer, once the agent has one. Written by the `onCloser` hook below.
   *
   * Held here so the window's own close path is not the only thing that knows a process exists: during
   * the handshake there is one and no turn, and a window closed in that moment would otherwise leave it
   * running behind it.
   */
  #agentClose: (() => void) | null = null;
  /** True between "a close was requested" and "the agent has ended", so a second close is not blocked. */
  #closing = false;
  /** Lines from the agent that are not transcript entries. Nowhere to put them yet — see `#onNotice`. */
  readonly #notices: string[] = [];
  /** The `KU_APP_PERMISSION` staging timer, so a close cannot fire it into a window that is gone. */
  #permissionSource: number | null = null;
  /** How many times the staging poll has fired. See `PERMISSION_STAGE_POLL_MS`. */
  #permissionTicks = 0;
  #preferences: PreferencesDialog | null = null;
  /** Why no prompt can be sent at all (no agent found), or `undefined`. Feeds the composer. */
  readonly #unavailable: string | undefined;
  #notice: NoticeView | null = null;
  #rememberNotice: ((id: NoticeView['id']) => void) | undefined;

  /**
   * `KU_APP_DISMISS_FAILURE`, `KU_APP_CHOOSE_MODEL` and `KU_APP_SWITCH`, and the one timer that runs all
   * three.
   *
   * **One state object and one timer for the failure-dialog hooks, because they are one photograph.**
   * "The person closes the dialog", "the person picks another model" and "the person opens another
   * conversation" are the same moment seen from three sides, and running them from three timers would
   * let the second one fire in between and photograph a walk that nobody made.
   *
   * `waiting` is the half that is not a timestamp: the hooks do nothing until a failure is *on
   * screen*, because a dismissal before the dialog exists dismisses nothing and a session switch
   * before the failure is just a different starting point.
   */
  #failureHooks: {
    dismiss: boolean;
    chooseModel: boolean;
    switchTo: string[];
    waiting: boolean;
    source: number | null;
  } = {
    dismiss: false,
    chooseModel: false,
    switchTo: [],
    waiting: false,
    source: null,
  };

  constructor(app: Adw.Application, options: MainWindowOptions) {
    // **The size is a constructor argument, not template markup, and the reason is that
    // `constants.ts` carries the measurement.** `WINDOW_MIN_WIDTH_PX` in particular is 360 because
    // `scripts/probes/window-min-width.mjs` swept the real window and found the toolkit stops there
    // by itself — a sweep with its table in the comment, which a `.blp` literal would have replaced
    // with a number nobody can check. The tree is in the template; the numbers are here.
    super({
      application: app,
      title: APP_NAME,
      defaultWidth: WINDOW_WIDTH,
      defaultHeight: WINDOW_HEIGHT,
      // The phone form factor, replacing a 480 px floor that was asserted rather than measured.
      // `WINDOW_MIN_WIDTH_PX` carries the sweep — `scripts/probes/window-min-width.mjs` — including the
      // part that corrects the story: with no floor the window stops at 360 by itself, so 480 was a
      // typed literal clamping a window the toolkit would have sized correctly on its own.
      widthRequest: WINDOW_MIN_WIDTH_PX,
      heightRequest: 400,
    });

    // The app's name, in the three places the template left for it. See `_sidebarPage`.
    this._sidebarPage.title = APP_NAME;
    this._contentPage.title = APP_NAME;
    this._sidebarTitle.title = APP_NAME;

    this.#unavailable = options.noAgent?.sendReason;
    this.#loadSessions = options.loadSessions;
    this.#newChat = options.newChat;
    this.#sessions = new SessionList({ onOpen: (record) => this.#open(record) });
    this.#permissions = new PermissionDialog(this);
    this.#failures = new FailureDialog();
    this.#loginAgent = options.agent;
    // **One transcript view for the whole window, refilled — not a stack child per session.**
    // Plan §7 step 4 asks for exactly that, and the review's F5 names the same reason: thirty sessions
    // means thirty `NavigationPage`s, thirty scrollers, and a composer whose entry and scroll position
    // are rebuilt on every click. One view, `setEntries` on each open, is also the reason a session
    // switch cannot leak a row from the previous transcript — the rebuild is total, not a diff.
    this.#transcript = new TranscriptView();
    // **Before the controller, and that order is deliberate.** `onConfig` is a closure over this
    // field, so a controller that emitted a config view from its own constructor would reach a
    // `#config` that does not exist yet — the crash `AgentSession`'s constructor comment describes for
    // `#composer`, and the same trap twice is a rule rather than a coincidence. Building it first makes
    // the window's construction order match the data flow: widgets, then the controller that fills them.
    this.#config = new ConfigRow({
      // One path out of the row and into the protocol. The window does not check the value, does not
      // look the control up, and does not decide whether this is a change — the controller does all of
      // that (`setConfigOption`), and a widget-level check would be a second opinion with no tests.
      onSelect: (controlId, value) => {
        void this.#agent.setConfigOption(controlId, value);
      },
    });
    this.#agent = new AgentSession({
      command: options.agent,
      ...(options.appendTurns ? { append: options.appendTurns } : {}),
      ...(options.createSession ? { create: options.createSession } : {}),
      ...(options.agentSource ? { source: options.agentSource } : {}),
      ...(options.resolveAgent ? { resolveAgent: options.resolveAgent } : {}),
      ...(options.now ? { now: options.now } : {}),
      events: {
        onSnapshot: (snapshot) => this.#onSnapshot(snapshot),
        onEntries: (entries) => this.#onEntries(entries),
        onConversation: (record, current) => this.#onConversation(record, current),
        onNotice: (message) => this.#onNotice(message),
        // Kept so `close-request` can end a process that exists while the handshake is still running
        // and no turn has been awaited — the orphan `onSpawn` exists to prevent. `shutdown()` below
        // already ends it; this is the same closer, held here so the window's own close path is not
        // the only thing that knows a process exists.
        onCloser: (close) => {
          this.#agentClose = close;
        },
        // **The dialog, through the controller's gate.** `onPermission` is the whole of what the
        // window contributes to an approval: it shows the question and resolves with the id that was
        // pressed. It does not decide anything about that id — a dismissal arrives here as an id the
        // agent never offered, and what it means is `core/permission.ts`'s to say, not this file's.
        onPermission: (question) => this.#permissions.show(question),
        // **The row, through the controller's decided view.** The window passes it through and does
        // not decide anything about it — `core/config-row.ts` has already decided which controls may
        // exist, what is selected, and what a refusal says. The window's own contribution is one
        // callback, so `notify::selected` goes to `setConfigOption` and nothing else.
        onConfig: (view) => this.#config.setView(view),
      },
    });
    // `attached: false` in step 4 became a real render input in step 5: the controller reports the
    // agent's own life and the composer asks `core/composer-state.ts` what to do with it.
    this.#composer = new Composer({
      // **From the controller's own `snapshot`, not from a hand-written initial value.** A literal
      // `idle / none / null` here would be a second source of truth for the composer's inputs that has
      // to be kept in step with the controller's defaults by hand — and the first version of this line
      // did exactly that, and then the controller's constructor emitted its own state into a composer
      // that did not exist yet. Reading the snapshot cannot be stale, because it is the thing itself.
      input: composerInput(this.#agent.snapshot, this.#unavailable),
      onSend: (text) => this.#onSend(text),
      // **Stop takes the dialog down with it, and names the reason before it does.** The window
      // contributes only the ordering — `agent.stop()` settles the question itself — so the two calls
      // cannot disagree about the answer, only about who asked first. `turn-cancelled` rather than the
      // vaguer `dismissed`: the person did not walk away from this question, they ended the turn it
      // belonged to, and a transcript that says otherwise puts a decision in their mouth.
      onStop: () => {
        this.#agent.dismissPermission('turn-cancelled');
        this.#permissions.close();
        this.#agent.stop();
      },
    });
    // **The four TypeScript-built widgets into the template's four hosts, and nothing else.** The
    // shell is markup; what an agent says is code, and code cannot be written into a template. Each
    // `Adw.Bin` is a placeholder with exactly one child, so this is a substitution rather than a
    // nesting — the tree that renders is the tree `window.blp` draws.
    this._sidebarHost.child = this.#sessions.widget;
    this._transcriptHost.child = this.#transcript.widget;
    this._composerHost.child = this.#composer.widget;
    // **The config row goes inside the composer's bottom bar, not into `Adw.ToolbarView`'s own.**
    // `Adw.ToolbarView` has exactly one bottom bar, and that one belongs to the composer. The row is
    // the template's box above it, so it lands "directly above the composer" in the plan's sense (§7
    // step 7) rather than as a sibling that could be reordered or, worse, given its own raised border
    // and read as a second pane.
    this._configHost.child = this.#config.widget;

    // **After** the content, and the order is load-bearing. The content is the template's, so it is
    // already in place — but the breakpoint still has to come after `super()` returned, and it is
    // worth saying why that is not a detail: measured on libadwaita 1.9.3, adding a breakpoint before
    // the content is set trips `adw_breakpoint_bin_add_breakpoint: assertion 'ADW_IS_BREAKPOINT_BIN
    // (self)' failed`, and the collapse then silently never happens. With the content in place first,
    // the same breakpoint sets `collapsed` on the first frame at 500 px — checked by running it, not
    // by reading it.
    this.#applyBreakpoint();
    if (options.noAgent) this.#showNoAgent(options.noAgent, options.preferences !== undefined);
    if (options.notice) this.#showNotice(options.notice, options.rememberNotice);
    if (options.preferences) this.#installPreferences(app, options.preferences);
    this.#installNewChat(app);
    this.#installLogin();
    this.#load(options.loadSessions);
    this.#applyDevHooks(options.hooks);
    this.#watchCloseRequest();
  }

  /** The nothing-found page: what `emptyStateView` said, on screen, with the commands selectable. */
  #showNoAgent(view: Extract<EmptyStateView, { kind: 'no-agent' }>, hasPreferences: boolean): void {
    this._noAgentPage.title = view.title;
    this._noAgentBody.label = view.body;
    for (const command of view.commands) {
      const label = new Gtk.Label({
        label: command,
        selectable: true,
        useMarkup: false,
        wrap: true,
        xalign: 0,
      });
      label.add_css_class('monospace');
      this._noAgentCommands.append(label);
    }
    this._noAgentDocs.label = `or see ${view.docsUrl}`;
    this._noAgentPreferences.visible = hasPreferences;
    this._contentStack.visibleChildName = 'no-agent';
  }

  #showNotice(view: NoticeView, remember: ((id: NoticeView['id']) => void) | undefined): void {
    this.#notice = view;
    this.#rememberNotice = remember;
    this._noticeBanner.title = view.text;
    this._noticeBanner.buttonLabel = view.button;
    this._noticeBanner.connect('button-clicked', () => this.#dismissNotice());
    this._noticeBanner.revealed = true;
  }

  #dismissNotice(): void {
    const view = this.#notice;
    if (!view) return;
    this.#notice = null;
    this._noticeBanner.revealed = false;
    this.#rememberNotice?.(view.id);
  }

  /**
   * The Preferences entry: `app.preferences`, `<Ctrl>comma`, and a primary menu in the content header.
   * The action is the one entry point, so the menu, the accelerator and `KU_APP_PREFERENCES` all run the
   * same call.
   */
  #installPreferences(app: Adw.Application, actions: PreferencesActions): void {
    const dialog = new PreferencesDialog(actions);
    this.#preferences = dialog;
    // Installed once: the window is the app's only one (`AdwaitaApp` memoises `createWindow`), so this
    // constructor runs once per process and the action and its accelerator are never added twice.
    const action = new Gio.SimpleAction({ name: 'preferences' });
    action.connect('activate', () => dialog.show(this));
    app.add_action(action);
    app.set_accels_for_action('app.preferences', ['<Ctrl>comma']);
  }

  /**
   * `win.login`: the menu's "Log in to a provider…", reachable with or without a working login — a person
   * may want a second provider. Disabled where the dialog could only say no (another agent than opencode,
   * a host opencode outside the sandbox), so the entry is insensitive rather than pointing at nothing.
   */
  #installLogin(): void {
    const action = new Gio.SimpleAction({
      name: 'login',
      enabled: loginUnavailableReason(this.#loginAgent) === null,
    });
    action.connect('activate', () => this.#openLogin());
    this.add_action(action);
  }

  /**
   * `win.new-chat`: the sidebar button, `<Ctrl>n` and `KU_APP_NEW_CHAT` all activate this one action.
   * Window-scoped rather than `app.`: what it resets is this window's composer. Disabled when no
   * directory could be found, so the button is insensitive rather than pointing at nothing.
   */
  #installNewChat(app: Adw.Application): void {
    const action = new Gio.SimpleAction({ name: 'new-chat', enabled: this.#newChat !== null });
    action.connect('activate', () => this.#startNewChat());
    this.add_action(action);
    app.set_accels_for_action('win.new-chat', ['<Ctrl>n']);
  }

  /**
   * The empty composer: no session is open and the first prompt makes one. **Starts nothing** — the
   * agent and `session/new` wait for the prompt, so a window nobody types in owns no process.
   *
   * The draft is left alone: a person who was writing something and reached for New chat has not asked
   * to lose it. `show_content` brings the pane forward on a collapsed window, where this is a tap on the
   * sidebar's own header.
   */
  #startNewChat(): void {
    const chat = this.#newChat;
    if (!chat) return;
    this.#failures.close();
    this.#openRecord = null;
    this.#sessions.clearSelection();
    // The agent stops a running turn itself (`startConversation`), settling any open question
    // `cancelled`; the dialog widget goes down after it, like Stop's.
    this.#agent.startConversation(chat.cwd);
    this.#permissions.close();
    this.#transcript.setEntries([]);
    this._contentStack.visibleChildName = this.#unavailable ? 'no-agent' : 'new';
    this._contentPage.title = APP_NAME;
    this._contentHeader.showTitle = false;
    this._cwdCaption.label = `in ${displayCwd(chat.cwd, chat.home)}`;
    this._cwdCaption.visible = !this.#unavailable;
    this._split.showContent = true;
  }

  /**
   * A new conversation has its session and its record. The sidebar gets the row at the top and, when the
   * person is still in that chat, marks it open — the transcript already shows what they sent, so this
   * does not go through `#open`, which would replace it with the (empty) stored copy.
   */
  #onConversation(record: SessionRecord, current: boolean): void {
    this.#records = [record, ...this.#records.filter((existing) => existing.id !== record.id)];
    this.#sessions.setSessions(this.#records);
    if (!current) return;
    this.#sessions.select(record.id);
    this.#openRecord = record;
    this._contentPage.title = labelOf(record);
    this._contentHeader.showTitle = true;
    this._cwdCaption.visible = false;
    this._contentStack.visibleChildName = 'open';
  }

  #load(loadSessions: () => readonly SessionRecord[]): void {
    try {
      this.#records = [...loadSessions()];
      this.#sessions.setSessions(this.#records);
      // First run: nothing to list, so the window is the chat. With sessions it stays on the list's
      // "pick one" page, as before.
      if (this.#records.length === 0) this.#startNewChat();
    } catch (error) {
      this.#sessions.showError(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * The record as the store holds it now. The window's list was read at startup, and a session that
   * streamed or was created since is longer on disk — showing the startup copy would be a transcript
   * that loses its own last answer. A read that fails falls back to the copy in hand.
   */
  #fresh(record: SessionRecord): SessionRecord {
    try {
      return this.#loadSessions().find((candidate) => candidate.id === record.id) ?? record;
    } catch {
      return record;
    }
  }

  /**
   * Show a session in the content pane.
   *
   * `show_content = true` is what makes the collapsed window work at all. Its default is **false**
   * (`Adw-1.gir`: `default-value="FALSE"`, and read back at runtime), so on a narrow window the
   * sidebar is what shows, and until a row set it nothing ever brought the content pane forward.
   * Peer review caught that. Setting it is also what makes libadwaita's own back button appear —
   * see `window.blp`'s content header.
   *
   * **The `Adw.StatusPage` is left exactly as the template declared it.** It used to be refilled here
   * with the session's title, agent and directory, which was the whole content pane while the
   * transcript did not exist. Now the transcript *is* the content pane, and a page one click away
   * carrying the same title is a second answer to "which session am I looking at" — the defect
   * `session-list.ts` avoids by keeping `#openId` as the one source of that answer. The status page now
   * means one thing and one thing only: nothing is open.
   *
   * **`record.turns` is handed over unchanged.** `TranscriptView.setEntries` takes exactly what the
   * store holds and projects it through `core/transcript-items.ts`; a surface that filtered first
   * would be re-deriving history the agent's own `session/load` is the authority on (AGENTS.md §
   * Privacy: the transcript is a record of what happened, not a re-derivation of it).
   *
   * **Selecting a session spawns nothing** (plan §6). `#open` calls `AgentSession.bind`, which records
   * the session and emits a snapshot; the process starts on the first prompt. That is what lets this
   * method stay a pure view operation — no await, no failure path, no process to leak when a person
   * clicks through a list.
   */
  #open(listed: SessionRecord): void {
    // A login dialog is about the agent as it was; leaving for another session closes it.
    this.#login.close();
    const record = this.#fresh(listed);
    const label = labelOf(record);
    this.#openRecord = record;
    this._cwdCaption.visible = false;
    // **A session switch takes the failure dialog down, and keeps `#shownFailure`.** The dialog is about
    // the window, not about the session — but a person who clicked another conversation while a modal
    // sentence about the last one was up is now looking at a *different* conversation, and a modal that
    // no longer describes what is on screen is the "control that points at nothing" this window forbids.
    // `#open` then emits, and `failureToShow` answers `null` for the failure this window already showed,
    // so closing it here does not buy it back on the next state move — that was the whole defect.
    this.#failures.close();
    // The recorded agent travels with the session, so the first prompt reattaches it on the copy that
    // holds its history (`resolveRecorded`) rather than on the window's single agent.
    this.#agent.bind({
      id: record.id,
      cwd: record.cwd,
      agent: record.agentSource ? { id: record.agent, source: record.agentSource } : { id: record.agent },
    });
    // `bind` stopped a turn that belongs to another chat; its question, if any, is already settled.
    this.#permissions.close();
    this.#transcript.setEntries(record.turns);
    // Named, not indexed: `'closed'`/`'open'`/`'empty'` read at the assignment and a `Gtk.Stack` is a
    // map, so an index would be a second naming scheme for the same three states.
    //
    // **`'empty'` is its own state, not the closed page reused.** A session that is open and holds no
    // turns is a third thing, not the second one: `kurier start` with no prompt produces exactly
    // that. Showing the transcript's blank column for it reads as a failed load, and showing
    // "No session open" for a session that *is* open is a lie in the title bar's own words.
    this._contentStack.visibleChildName = record.turns.length === 0 ? 'empty' : 'open';
    this._contentPage.title = label;
    // The title can be shown now: it names the session, not the app, so it is no longer the
    // double title the template's content header hides it against.
    this._contentHeader.showTitle = true;
    this._split.showContent = true;
  }

  /**
   * Collapse the sidebar below `COLLAPSE_WIDTH_PX`, and only below it.
   *
   * Copied from `@gjsify/adwaita-app`'s `createNavShell` rather than imported, because the packaged
   * shell cannot host this window — see the file header. The number is the same, and the reason is the
   * same: it is where a 300 px sidebar plus a readable conversation stops being possible.
   *
   * `Adw.Breakpoint` rather than a `size-allocate` handler, so the condition is declared once and
   * the framework owns the transition — a handler that sets `collapsed` on every allocation also
   * fights the person's own toggle, which is the kind of bug that only shows up on a resize.
   */
  #applyBreakpoint(): void {
    const condition = Adw.BreakpointCondition.parse(`max-width: ${COLLAPSE_WIDTH_PX}px`);
    if (!condition) return;
    const breakpoint = new Adw.Breakpoint({ condition });
    breakpoint.add_setter(this._split, 'collapsed', true);
    this.add_breakpoint(breakpoint);
  }

  // ─── the turn ───────────────────────────────────────────────────────────────────────────────

  /**
   * Send: record the prompt, clear the entry, start the turn.
   *
   * **The prompt is written down before the turn starts, and by this file rather than by the
   * controller.** The controller's `prompt()` appends it too — through the same `append` the stream
   * uses, so a crash cannot lose the message — and the window draws it, because the widget that will
   * show it is the one that has to decide it is shown. The draft is cleared here for the same reason
   * `keepsDraft` exists in core: sending is a person clearing their own message, which is not the same
   * event as a state change arriving.
   */
  #onSend(text: string): void {
    if (text.trim() === '' || this.#unavailable) return;
    this.#composer.clearDraft();
    void this.#agent.prompt(text);
  }

  /**
   * A new snapshot: hand it to the composer, and act on a state that changed the draft's fate.
   *
   * **A `gone` snapshot also takes the dialog down**, and it is the only place that does. The agent
   * dying mid-question is a state the controller settles (`#reportFailure` cancels the desk with
   * `agent-gone`, so the answer is `cancelled` rather than a hang), but the *widget* is this window's,
   * and a modal left up over an agent that has exited is a question about work that can no longer
   * happen. Plan §6 asks for exactly this — "any open permission dialog closes". Reading it off the
   * snapshot rather than off a separate callback is what keeps the window from having two sources of
   * truth about whether the app is alive.
   */
  #onSnapshot(snapshot: AgentSnapshot): void {
    this.#composer.setInput(composerInput(snapshot, this.#unavailable));
    // `keepsDraft` is the decision and it lives in core; the window only carries it out. An agent that
    // exited can never receive what is in the entry, and leaving it there collects words that go
    // nowhere — so `gone` is the one state that discards it.
    if (!keepsDraft(snapshot.state)) this.#composer.clearDraft();
    if (snapshot.attachment.status === 'gone') this.#permissions.close();
    this.#showFailure(snapshot);
  }

  /**
   * Put up the dialog a failure has earned — **once per failure, and never a stale one.**
   *
   * Three decisions, all of them made in `core/failure.ts` and all about as easy to get wrong as they
   * look:
   *
   * - `failureToShow(attachment, shown)` — is this failure still owed a dialog? It is `null` for a
   *   failure this window has already shown (identity, not "is one open": a dismissal closes the dialog
   *   and the *next* snapshot would otherwise re-open it, which is the bug this field exists for) and
   *   `null` for a `start` failure, which earns no modal at all.
   * - `staleDialog(shown, attachment)` — is a dialog that is up now about something the window has
   *   moved on from? A dialog is modal, so one left up over an attached agent or another session both
   *   lies and blocks the window.
   * - `failureAction(notice, { modelChoice })` — may the dialog carry its button? The `'model'` notice
   *   (a provider refusal, issue #2) offers "Choose another model", and it may only if the agent
   *   reported a model option at all. Without one the button would open nothing, so the dialog is
   *   built with Close alone and the sentence still says what to do instead.
   *
   * **`#shownFailure` is only forgotten when a dialog is genuinely closed as stale.** Clearing it on
   * every session switch would put the *same* auth dialog straight back up, because the attachment is
   * still the same object; the switch closes the dialog and keeps the memory, so the failure stays
   * shown-once and a genuinely new failure is a new object and is shown.
   *
   * **Nothing here decides anything.** This method carries out `core/failure.ts`'s answers and holds
   * the one piece of state those answers need.
   */
  #showFailure(snapshot: AgentSnapshot): void {
    const attachment = snapshot.attachment;
    if (staleDialog(this.#shownFailure, attachment)) this.#failures.close();
    const notice: FailureNotice | null = failureToShow(attachment, this.#shownFailure);
    if (notice === null) return;
    this.#shownFailure = attachment;
    const action = failureAction(notice, {
      modelChoice: this.#config.hasModelControl(),
      login: loginUnavailableReason(this.#loginAgent) === null,
    });
    this.#failures.show(notice, this, {
      ...(action === 'choose-model' ? { onChooseModel: () => this.#openModelDropdown() } : {}),
      ...(action === 'login' ? { onLogin: () => this.#openLogin() } : {}),
    });
  }

  /**
   * Open the model dropdown, for the failure dialog's "Choose another model".
   *
   * **Through the row's own method and nothing else** — no `set_selected`, no request, no value. A
   * dialog that picked a model on the person's behalf would be kurier deciding configuration for the
   * agent, which is the "always allow" mistake in different clothes; what this does is put the list in
   * front of them.
   *
   * **One line in the log either way, and that is deliberate.** The pointer cannot press this button —
   * `ActivateWidget` on an `Adw.AlertDialog` response reports `true` and emits no `response` (measured,
   * `scripts/probes/alert-dialog-close.mjs`), which is why the whole dismissal half of a failure dialog
   * needed a hook. So a screenshot run has to be able to say afterwards whether the button reached the
   * dropdown or whether there was no model option to open, and "no log line" would not distinguish
   * "worked" from "never ran".
   */
  /**
   * Open the login dialog. The controller starts a private server and stops it when the dialog goes away;
   * after a login the agent is restarted, because it reads its credentials once at start and the process
   * that hit the login trap would keep saying "log in".
   */
  #openLogin(): void {
    const agent = this.#loginAgent;
    const controller = new LoginController({
      openSession: () => openLoginSession(agent),
      unavailableReason: () => loginUnavailableReason(agent),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
      onConnected: async () => {
        // A turn in flight is left alone, so say so instead of claiming a restart that did not happen.
        if (!(await this.#agent.restartAgent()))
          throw new Error('a turn is still running — send again once it ends');
      },
    });
    this.#login.show(this, controller);
  }

  #openModelDropdown(): void {
    const opened = this.#config.openModelDropdown();
    console.log(`kurier: the model dropdown is ${opened ? 'open' : 'not on the row — nothing to open'}`);
  }

  /**
   * Lines that just arrived. Drawn as they come, with no batching and no timer.
   *
   * **Appended, never re-projected from the store.** The window's copy of the session is the one the
   * sidebar read at startup; re-reading the file per chunk would mean a JSON parse and a full rebuild
   * of a thirty-session file for every token, and it would draw the *stored* transcript rather than the
   * one being streamed.
   */
  #onEntries(entries: TranscriptEntry[]): void {
    this.#transcript.appendEntries(entries);
    this.#streamed += entries.filter((entry) => entry.kind !== 'user').length;
    // A session that was showing `'empty'` has just said something. Left as it is, the pane keeps the
    // "Nothing here yet" status page *underneath* the new bubble, and the sentence contradicts what is
    // on top of it.
    // The same for a new chat, whose first line is drawn before its session exists.
    const visible = this._contentStack.visibleChildName;
    if (visible === 'empty' || visible === 'new') this._contentStack.visibleChildName = 'open';
  }

  /**
   * A line from the agent that is not a transcript entry.
   *
   * **Collected and counted in one line, and that is a limitation with a name.** An auth advertisement,
   * a `SIGTERM` from a killed tool, a cancellation that could not be sent: all real, all things a
   * person wants to know, none of them belonging in the conversation. There is nowhere in this layout
   * to put them — a notice area is a control, and a control that is a text box nobody can act on is the
   * control-this-window-forbids. Until there is one they go to stderr with a count, which is honest:
   * they are reported, and nothing claims they are on screen.
   */
  #onNotice(message: string): void {
    this.#notices.push(message);
    console.log(`kurier: ${message}`);
  }

  /**
   * Close with a live turn: cancel, wait, terminate, and only then let the window go.
   *
   * **`return true` holds the close**, and the second `close()` after `shutdown()` is what actually
   * closes it — `#closing` is what keeps that second call from being held again, so this cannot loop.
   * The order inside `shutdown()` is plan §6's and is not interchangeable: cancelling first gives the
   * agent the chance to answer `cancelled` and flush, and terminating first would SIGTERM it out of
   * the turn it is in the middle of, which is the one ordering that loses work.
   *
   * **A close with nothing running is left to GTK.** The handler is only installed once the window has
   * an agent behind it at all, so the common case — a window somebody opened, read and closed — does
   * not go through an async path at all.
   */
  #watchCloseRequest(): void {
    this.connect('close-request', () => {
      if (this.#closing) return false;
      // **A dialog is a reason to run the close path, even with nothing running.** It is modal, so it
      // blocks the window — and a close-request it swallows would leave a window that cannot be
      // closed.
      //
      // The reason is named **before** the widget goes down, and that order is the point:
      // `dismissPermission` settles the question, and only then does `close()` make the dialog report
      // a dismissal — which would land on nothing, because there is no longer an open question. Both
      // answers are `cancelled` over the wire, and only one of them says which ending this was.
      this.#agent.dismissPermission('window-closed');
      this.#permissions.close();
      // A failure dialog is the same case: it is modal, so a close-request it swallowed would leave a
      // window that cannot be closed. Nothing is waiting on it, so taking it down before the async
      // close path costs nothing.
      this.#failures.close();
      this.#login.close();
      // The staging timer dies with the window. `source_remove` is only reached for a timer that has
      // not fired yet — the callback clears the field before it returns, so an already-fired id is
      // never removed twice.
      if (this.#permissionSource !== null) {
        GLib.source_remove(this.#permissionSource);
        this.#permissionSource = null;
      }
      // Same for the failure-dialog hooks: a window closed between arming them and the failure
      // arriving would otherwise be called back into — and the walk opens sessions, which is the last
      // thing a closing window should do.
      if (this.#failureHooks.source !== null) {
        GLib.source_remove(this.#failureHooks.source);
        this.#failureHooks.source = null;
      }
      if (this.#newChatSource !== null) {
        GLib.source_remove(this.#newChatSource);
        this.#newChatSource = null;
      }
      if (this.#midTurnSource !== null) {
        GLib.source_remove(this.#midTurnSource);
        this.#midTurnSource = null;
      }
      if (!this.#agent.turnRunning && !this.#agent.agentRunning) return false;
      this.#closing = true;
      void (async () => {
        await this.#agent.shutdown();
        // The spawn-time closer, as a backstop for a process that existed while this window was closing
        // and that no turn ever awaited. `shutdown()` has already ended the connection; `AcpClient.close`
        // and `StdioChannel.terminate` are both idempotent, so a second call costs nothing.
        this.#agentClose?.();
        this.#closing = false;
        this.close();
      })();
      return true;
    });
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
    if (hooks.config !== undefined) {
      const spec = parseConfigOptionSpec(hooks.config);
      if (!spec) {
        // A hook that cannot be parsed is a typo, and a typo that silently did nothing is how a surface
        // ends up with a screenshot nobody can account for. Named loudly, with the format.
        console.log(`kurier: KU_APP_CONFIG=${hooks.config} — not in "configId=valueId" form, not acted on`);
      } else if (!this.#hasChat()) {
        console.log('kurier: KU_APP_CONFIG — no session is open, so there is no agent to ask');
      } else {
        console.log(
          `kurier: KU_APP_CONFIG — setting ${spec.controlId} to ${spec.value} through the real path`,
        );
        // Through `stageConfigOption`, so the prompt that starts the agent, the `session/load` that
        // binds it and the `session/set_config_option` that sets the value are all the real ones. A hook
        // that set the option itself would photograph a state the window cannot reach.
        //
        // **Applied before `KU_APP_THINKING`, and that order decides what happens when both are set.**
        // `stageConfigOption` starts the agent itself when there is none — an option can only be set on
        // a live agent, and the agent starts on the first prompt (plan §6). So this hook sends the
        // prompt, and the `thinking` hook below finds a turn already in flight and does nothing. That is
        // the wanted outcome rather than a collision: one prompt, one turn, one set.
        void this.#agent.stageConfigOption(spec.controlId, spec.value, hooks.prompt);
      }
    }
    if (hooks.permission === true) {
      // **A poll, not a straight call, and the wait is the point.** A real request — the stand-in
      // agent's own mid-turn question, or a real agent's — is the better thing to photograph, and it
      // arrives a moment after the prompt goes out. So this asks again every
      // `PERMISSION_STAGE_POLL_MS` and only stages its fixture request if the gate has not been asked
      // by then; with `KU_STANDIN_PERMISSION=1` the agent's question wins and this one never appears.
      // Staging straight away would mean the fixture always won, which would make `KU_APP_PERMISSION`
      // untestable against a real agent.
      // A GLib timeout rather than `setTimeout`: the staging must happen on the GTK main loop, and a
      // pending timer must die with the window instead of firing into a window that is gone.
      this.#permissionSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PERMISSION_STAGE_POLL_MS, () => {
        this.#permissionTicks += 1;
        const waitedMs = this.#permissionTicks * PERMISSION_STAGE_POLL_MS;
        // The agent asked: its own question is on screen, which is what this run wanted to photograph.
        // Waiting for the deadline after that would put a second dialog in the queue behind it.
        const asked = this.#agent.permissionAsked;
        // Nothing is running and the first tick has passed: there is no agent that could ask, so
        // waiting buys nothing and a screenshot run should not sit through a deadline for its dialog.
        const idle = !this.#agent.turnRunning && this.#permissionTicks > 1;
        const outwaited = waitedMs >= PERMISSION_STAGE_DEADLINE_MS;
        if (asked || idle || outwaited) {
          this.#permissionSource = null;
          // `asked` is the one case where this hook has nothing left to do. The other two are the
          // fallback firing, and it goes through the same gate either way.
          if (!asked) this.#stagePermission();
          return GLib.SOURCE_REMOVE;
        }
        return GLib.SOURCE_CONTINUE;
      });
    }
    if (hooks.noticeDismiss === true) {
      if (this.#notice) {
        console.log('kurier: KU_APP_NOTICE_DISMISS — pressing the banner’s Got it');
        this._noticeBanner.emit('button-clicked');
      } else {
        console.log('kurier: KU_APP_NOTICE_DISMISS — no notice is showing, nothing to dismiss');
      }
    }
    if (hooks.debug) console.log('kurier: verbose dev logging on');
    // `KU_APP_THINKING` sends a prompt, because this is the step that has a turn to send. It is a real
    // turn against whatever agent was selected — no staged fake stream — because a fake one would test
    // the staging code instead of the window. The prompt defaults to a fixture sentence rather than to
    // anything from the session file: a screenshot must not carry a real conversation out of it.
    if (hooks.thinking === true) {
      const prompt = hooks.prompt ?? 'Summarise this repository in three sentences.';
      if (this.#unavailable) {
        // The composer refuses to send here, so the hook does too: a hook that could send where a person
        // cannot would photograph a window that does not exist.
        console.log(`kurier: KU_APP_THINKING — not sent: ${this.#unavailable}`);
      } else if (!this.#hasChat()) {
        console.log('kurier: KU_APP_THINKING — no session is open, so there is nowhere to send it');
      } else {
        console.log(
          `kurier: KU_APP_THINKING — sending to ${this.#openRecord?.id ?? 'a new chat, which this creates'}`,
        );
        this.#composer.clearDraft();
        void this.#agent.prompt(prompt);
      }
    }
    this.#applyStopHook(hooks);
    this.#applyNewChatHook(hooks);
    this.#applyNewChatMidTurnHook(hooks);
    this.#applyFailureHooks(hooks);
    this.#applyPreferencesHooks(hooks);
    if (hooks.login === true) {
      console.log('kurier: KU_APP_LOGIN — opening the login dialog');
      this.#openLogin();
    }
  }

  /**
   * `KU_APP_NEW_CHAT`: press New chat — through `win.new-chat`, the action the button and `<Ctrl>n` run.
   *
   * **After the running turn, not during it.** Combined with `KU_APP_THINKING` the point is to photograph
   * the empty composer *after* a chat exists, and a New chat in the middle of the first answer would
   * photograph a half-streamed one. Nothing running: it fires at once.
   */
  #applyNewChatHook(hooks: KurierHooks): void {
    if (hooks.newChat !== true) return;
    const press = (): void => {
      console.log('kurier: KU_APP_NEW_CHAT — activating win.new-chat');
      // The action itself, not `this.activate_action(…)`: on a window GJS resolves that name to
      // `Gio.ActionGroup`'s, which takes the name *without* the `win.` prefix and returns nothing — the
      // prefixed spelling is a silent no-op (measured: the first version of this hook did nothing and
      // logged success). `activate` on the action is what the button's `action-name` ends up calling.
      const action = this.lookup_action('new-chat');
      if (!action) console.log('kurier: KU_APP_NEW_CHAT — no such action on this window');
      else action.activate(null);
    };
    if (!this.#agent.turnRunning) {
      press();
      return;
    }
    this.#newChatSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FAILURE_HOOK_STEP_MS, () => {
      if (this.#agent.turnRunning) return GLib.SOURCE_CONTINUE;
      this.#newChatSource = null;
      press();
      return GLib.SOURCE_REMOVE;
    });
  }

  /**
   * `KU_APP_NEW_CHAT_MIDTURN`: press New chat once the running turn has streamed something and is still
   * going — the one-keystroke path that used to leave the old answer streaming into the empty pane.
   * Through the same action as the button. Polls, because the turn starts a moment after the hook runs.
   */
  #applyNewChatMidTurnHook(hooks: KurierHooks): void {
    if (hooks.newChatMidTurn !== true) return;
    this.#midTurnSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MIDTURN_HOOK_STEP_MS, () => {
      if (!this.#agent.turnRunning || this.#streamed === 0) return GLib.SOURCE_CONTINUE;
      this.#midTurnSource = null;
      console.log('kurier: KU_APP_NEW_CHAT_MIDTURN — activating win.new-chat with the turn still running');
      const action = this.lookup_action('new-chat');
      if (!action) console.log('kurier: KU_APP_NEW_CHAT_MIDTURN — no such action on this window');
      else action.activate(null);
      return GLib.SOURCE_REMOVE;
    });
  }

  /** A session is open, or a new chat is waiting for its first prompt — either way a prompt has somewhere to go. */
  #hasChat(): boolean {
    return this.#openRecord !== null || this.#agent.snapshot.startsConversation;
  }

  /** `KU_APP_PREFERENCES` opens the dialog through its action; `KU_APP_PREFERENCES_AGENT` also chooses a row. */
  #applyPreferencesHooks(hooks: KurierHooks): void {
    if (hooks.preferences !== true && hooks.preferencesAgent === undefined) return;
    const dialog = this.#preferences;
    const app = this.application;
    if (!dialog || !app) {
      console.log('kurier: KU_APP_PREFERENCES — this window has no preferences dialog');
      return;
    }
    console.log('kurier: KU_APP_PREFERENCES — opening the dialog through app.preferences');
    app.activate_action('preferences', null);
    const key = hooks.preferencesAgent;
    if (key === undefined) return;
    // The rows are final once the host detection (if any) has answered; the dialog says when.
    void dialog.ready().then(() => {
      const outcome = dialog.select(key);
      const said: Record<typeof outcome, string> = {
        chose: `chose ${key} through the dialog`,
        unchanged: `${key} is already the saved choice — nothing written`,
        refused: 'the dialog is locked (the settings file is not overwritten) — nothing written',
        failed: `choosing ${key} did not save — see the dialog`,
        missing: `no row ${key} in the dialog`,
      };
      console.log(`kurier: KU_APP_PREFERENCES_AGENT — ${said[outcome]}`);
    });
  }

  /**
   * Arm `KU_APP_DISMISS_FAILURE`, `KU_APP_CHOOSE_MODEL` and `KU_APP_SWITCH`.
   *
   * **All three are about controls that nothing outside the process can press.** `ActivateWidget` on the
   * failure dialog's response button reports `true` and dismisses nothing, `Adw.AlertDialog` has no
   * callable `response()`, and neither can a pointer (measured; `hooks.ts` has the three-way result), so
   * the sidebar row, the dialog's own Close and the dialog's model button are the last three
   * pointer-only controls in this window. A guard that cannot be observed is a guard that has not been
   * checked, and the guards in question are the ones that decide whether a failure is shown once or on
   * every state move, and whether its one button reaches the dropdown it names.
   *
   * **Armed but idle until a failure is on screen** — see `#failureHooksStep`. Nothing here runs at
   * startup, so a run that sets these hooks and never fails is a run that did what it was asked and
   * said nothing, rather than a run that switched sessions for no reason.
   */
  #applyFailureHooks(hooks: KurierHooks): void {
    const switchTo = hooks.switchTo ?? [];
    if (hooks.dismissFailure !== true && hooks.chooseModel !== true && switchTo.length === 0) return;
    this.#failureHooks.dismiss = hooks.dismissFailure === true;
    this.#failureHooks.chooseModel = hooks.chooseModel === true;
    this.#failureHooks.switchTo = [...switchTo];
    this.#failureHooks.waiting = true;
    this.#failureHooks.source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FAILURE_HOOK_STEP_MS, () =>
      this.#failureHooksStep(),
    );
  }

  /**
   * One step of the failure-dialog hooks: dismiss, then walk the sessions.
   *
   * **`#shownFailure` is the trigger, because it is the one thing that says the dialog is up.** It is
   * set in `#showFailure` at the moment the dialog is presented and never cleared, so the first tick
   * that finds it is the tick after the failure was photographed — a `status === 'failed'` test would
   * fire on the same snapshot, before `present()` had a frame, and the screenshot would catch a dialog
   * on its way in.
   *
   * **The dismissal is the dialog's own `close()`, and that *is* the person's Close.** This dialog has
   * one response, and `scripts/probes/alert-dialog-close.mjs` (case 1) measures that an external
   * `close()` emits `closed` and then `response("close")` — the same pair with the same argument the
   * button produces. That is still right on the `'model'` dialog, which has a second response: the
   * dismissal reports `"close"` and never the remedy.
   *
   * **The other arm is a press, and it goes through the dialog too.** `KU_APP_CHOOSE_MODEL` calls
   * `FailureDialog.chooseModel()`, which emits the `response` signal libadwaita's own handler answers
   * to — so the modal takes itself down and the dropdown opens in libadwaita's order. Calling
   * `ConfigRow.openModelDropdown()` directly would photograph a popover with the modal still up, which
   * is not a state a person can be in.
   */
  #failureHooksStep(): boolean {
    const hooks = this.#failureHooks;
    if (hooks.source === null) return GLib.SOURCE_REMOVE;
    if (hooks.waiting) {
      if (this.#shownFailure === null) return GLib.SOURCE_CONTINUE;
      hooks.waiting = false;
      if (hooks.dismiss) {
        console.log('kurier: KU_APP_DISMISS_FAILURE — closing the failure dialog');
        hooks.dismiss = false;
        this.#failures.close();
        // **A step of its own, so the walk starts only after the dismissal has had a frame.** The
        // question these hooks exist for is whether the *same* failure comes back on the emit a
        // session switch causes, and a walk that began in the same tick would be photographed with
        // the dialog never having been visibly closed.
        return GLib.SOURCE_CONTINUE;
      }
      if (hooks.chooseModel) {
        // **One press, and the log says whether it happened.** `chooseModel` answers `false` for a
        // dialog that is not up or that carries no such response — which is the state this run *should*
        // be in with `KU_STANDIN_CONFIG` unset, and a screenshot in that state has to be recognisable
        // as "the button was never offered" rather than as a broken fixture.
        const pressed = this.#failures.chooseModel();
        console.log(
          `kurier: KU_APP_CHOOSE_MODEL — ${
            pressed ? 'pressing Choose another model' : 'the dialog offers no such button'
          }`,
        );
        hooks.chooseModel = false;
        // **The timer stops here**, so a `KU_APP_SWITCH` walk in the same run is not photographed over
        // an open popover: one press is the whole photograph, and the walk would close the session the
        // dropdown is standing in. The popover appears inside that call and paints on the next frame.
        if (pressed) {
          hooks.source = null;
          return GLib.SOURCE_REMOVE;
        }
      }
    }
    const next = hooks.switchTo.shift();
    if (next === undefined) {
      hooks.source = null;
      return GLib.SOURCE_REMOVE;
    }
    const record = this.#sessions.select(next);
    if (record === undefined) {
      console.log(`kurier: KU_APP_SWITCH=${next} — no such session in the list, not opened`);
    } else {
      // `#open`, because that is what a row click does — `SessionList`'s `onOpen` is a closure over
      // this method. A hook that called `agent.bind()` directly would skip the window's own half and
      // photograph a session the window did not open.
      console.log(`kurier: KU_APP_SWITCH — opening ${next}`);
      this.#open(record);
    }
    return GLib.SOURCE_CONTINUE;
  }

  /**
   * Press Stop once the turn is running, for `KU_APP_STOP`.
   *
   * **Once, synchronously, because the turn already exists.** `AgentSession.prompt()` assigns `#turn`
   * *before its first `await* (`agent-session.ts:456`; every statement above that one is synchronous),
   * and `KU_APP_THINKING` calls it immediately above this one — so there is nothing to wait for, and a
   * poll over an already-set field either fires on its first tick or has already missed the turn.
   *
   * **Through the composer's handler, not the controller.** See `hooks.ts`: the ordering the screenshot
   * has to show — the permission dialog dismissed with `turn-cancelled` first, then the cancel sent — is
   * the *window's* contribution, and bypassing it would photograph the controller.
   */
  #applyStopHook(hooks: KurierHooks): void {
    if (hooks.stop !== true && hooks.stopEscape !== true) return;
    if (!this.#hasChat()) {
      console.log('kurier: KU_APP_STOP — no session is open, so there is no turn to stop');
      return;
    }
    // **No timer, and the earlier version had one that could not do anything.** `AgentSession.prompt()`
    // assigns `#turn` *before its first `await* (`agent-session.ts:456`, and every statement above that
    // is synchronous), so by the time `KU_APP_THINKING` has called it — and it is the statement right
    // above this one — `turnRunning` is already true. A poll over that either fires on its first tick
    // or has already missed the turn, which is why the version this replaces gave up on tick 2 and left
    // its own deadline unreachable. One check, and the log says what it did.
    if (!this.#agent.turnRunning) {
      console.log('kurier: KU_APP_STOP — no turn is running, so nothing was stopped');
      return;
    }
    if (hooks.stopEscape === true) {
      // Escape's path and only Escape's. See `hooks.ts`: `PermissionDialog` reports a dismissal as the
      // id `'close'`, `decideFromView` maps that to `not-answered: dismissed`, and `answerFor` sends
      // `cancelled` — so `dismissPermission('dismissed')` is literally what Escape does, and the turn
      // keeps running afterwards, which is the difference from Stop that `dismissed` names.
      console.log('kurier: KU_APP_STOP_ESCAPE — dismissing the open permission dialog as Escape does');
      this.#agent.dismissPermission('dismissed');
      this.#permissions.close();
    }
    if (hooks.stop === true) {
      console.log('kurier: KU_APP_STOP — pressing Stop');
      this.#composer.stop();
    }
  }

  /**
   * Put a fixture permission request through the **real** gate, for `KU_APP_PERMISSION`.
   *
   * **Nothing here builds a dialog.** It asks the same `AgentSession` the agent's own requests go
   * through, which means what a screenshot shows is the gate's behaviour and not a picture of one: the
   * buttons are the options this request offers, the body is what `permissionView` projects, and an
   * Escape on it produces the same `cancelled` the agent would get. A hook that constructed its own
   * dialog would photograph a widget and prove nothing about the gate.
   *
   * **The answer is logged, never recorded.** `stagePermissionRequest` does not write a transcript
   * line, and this hook deliberately does not invent one: a decision nobody made, filed in a session's
   * history, is a fabricated event — and `AGENTS.md` is explicit that the transcript is a record of
   * what happened. The line goes to stderr instead, where a dev run can see it and a session file
   * cannot.
   *
   * Only reached as the fallback the poll above decides on, so the "a real request is already up"
   * case is settled there rather than guessed at again here.
   */
  #stagePermission(): void {
    if (!this.#hasChat()) {
      console.log('kurier: KU_APP_PERMISSION — no session is open, so there is nothing to ask about');
      return;
    }
    console.log('kurier: KU_APP_PERMISSION — staging a fixture request through the real gate');
    void this.#agent.stagePermissionRequest().then((answer) => {
      console.log(`kurier: KU_APP_PERMISSION — the staged question was answered ${JSON.stringify(answer)}`);
    });
  }
}

/**
 * The composer's render inputs from a snapshot.
 *
 * **A function rather than an object literal at the call site**, because it is the *only* place that
 * knows `AgentSnapshot` and `ComposerInput` are two views of one thing: `agentStatus` turns the
 * attachment into the two fields the composer needs, and `composerView` turns those into a button. If
 * the window assembled the input itself, the join between the two core modules would be a second
 * implementation of it — and this file's header is about not having decisions here.
 */
function composerInput(snapshot: AgentSnapshot, unavailable?: string): ComposerInput {
  return {
    ...(unavailable ? { unavailable } : {}),
    state: snapshot.state,
    agent: agentStatus(snapshot.attachment),
    sessionId: snapshot.sessionId,
    startsConversation: snapshot.startsConversation,
  };
}

GObject.registerClass(
  {
    GTypeName: MainWindow.GTypeName,
    Template,
    // **The children the constructor fills and the methods that act on the shell.** The three
    // `*Host` bins are where the TypeScript-built widgets go; the rest are the shell itself,
    // named here so a method can reach it without searching the markup for the right nesting.
    InternalChildren: [
      'split',
      'sidebarPage',
      'sidebarTitle',
      'sidebarHost',
      'contentPage',
      'contentHeader',
      'contentStack',
      'transcriptHost',
      'configHost',
      'composerHost',
      'cwdCaption',
      'noticeBanner',
      'noAgentPage',
      'noAgentBody',
      'noAgentCommands',
      'noAgentDocs',
      'noAgentPreferences',
    ],
  },
  MainWindow,
);
