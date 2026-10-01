/**
 * The window: the shell, the surface, and the wiring between them.
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
 * **The shell is built here rather than taken from `createNavShell`.** That is a real decision with a
 * measured reason, not a preference: the packaged shell takes a `readonly NavItem[]` and hands
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
 * So `ToolbarView` is the shape, see `buildSidebar`. There is no public property on
 * `AdwNavigationSplitView` to hide the separator at all — only `collapsed`, `content`,
 * `min_/max_sidebar_width`.
 *
 * **One agent subprocess for this whole window, and the window never touches it.** `AgentSession` owns
 * the process and the turns; `window.ts` only passes it a callback for lines and one for snapshots. It
 * is the reason a person can click through thirty sessions without spawning thirty `opencode`s (plan
 * §6), and the reason the composer's Send was able to be a real button in this step instead of the
 * disabled one step 4 shipped.
 */

import Adw from '@girs/adw-1';
import GLib from '@girs/glib-2.0';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';

import { labelOf, type SessionRecord, type TranscriptEntry } from '@kurier/session';

import { AgentSession, type AgentSnapshot } from '../../core/agent-session.ts';
import type { AgentCommand } from '../../core/agents/stdio.ts';
import { keepsDraft, type ComposerInput } from '../../core/composer-state.ts';
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
import { PermissionDialog } from './permission-dialog.ts';
import { SessionList } from './session-list.ts';
import { TranscriptView } from './transcript-view.ts';

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
  /** Which agent to start on the first prompt. Resolved from `KU_APP_AGENT` in `main.ts`. */
  readonly agent: AgentCommand;
  /** Persist streamed transcript lines. Called once per arriving batch, in order. */
  readonly appendTurns?: (sessionId: string, entries: TranscriptEntry[]) => void;
  /** The clock, injected so a screenshot run is the only place a real one is used. */
  readonly now?: () => string;
}

export class MainWindow extends Adw.ApplicationWindow {
  static readonly GTypeName = 'KurierMainWindow';

  readonly #split: Adw.NavigationSplitView;
  readonly #sessions: SessionList;
  readonly #placeholder: Adw.StatusPage;
  /** One transcript view for the whole window, refilled per session. See the constructor. */
  readonly #transcript: TranscriptView;
  /** The composer, as the content pane's bottom bar. Plan §7 step 4. */
  readonly #composer: Composer;
  /**
   * The approval dialog. One per window, because one question is ever shown at a time — `core/permission.ts`
   * queues the rest, and `PermissionDialog.show` replaces rather than stacks.
   */
  readonly #permissions: PermissionDialog;
  readonly #contentPage: Adw.NavigationPage;
  readonly #contentHeader: Adw.HeaderBar;
  /**
   * The content pane's two states — "nothing is open" and "this session" — in one `Gtk.Stack`.
   *
   * A stack rather than swapping `Adw.ToolbarView.set_content`, and the reason is the composer: the
   * header bar and the composer belong to the *pane* and must survive the switch. A session list of
   * thirty rows behind thirty `NavigationPage`s would rebuild the composer's scroller on every click,
   * which loses the entry's scroll position and its text — the two things a person is in the middle
   * of. Two named children and one assignment is the whole mechanism.
   */
  readonly #contentStack: Gtk.Stack;
  /** The turn machinery. One per window, one agent subprocess behind it. */
  readonly #agent: AgentSession;
  /** The session on screen, or `null` while none is. The only place the window answers "which". */
  #openRecord: SessionRecord | null = null;
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

  constructor(app: Adw.Application, options: MainWindowOptions) {
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

    this.#sessions = new SessionList({ onOpen: (record) => this.#open(record) });
    this.#placeholder = buildPlaceholder();
    this.#permissions = new PermissionDialog(this);
    // **One transcript view for the whole window, refilled — not a stack child per session.**
    // Plan §7 step 4 asks for exactly that, and the review's F5 names the same reason: thirty sessions
    // means thirty `NavigationPage`s, thirty scrollers, and a composer whose entry and scroll position
    // are rebuilt on every click. One view, `setEntries` on each open, is also the reason a session
    // switch cannot leak a row from the previous transcript — the rebuild is total, not a diff.
    this.#transcript = new TranscriptView();
    this.#agent = new AgentSession({
      command: options.agent,
      ...(options.appendTurns ? { append: options.appendTurns } : {}),
      ...(options.now ? { now: options.now } : {}),
      events: {
        onSnapshot: (snapshot) => this.#onSnapshot(snapshot),
        onEntries: (entries) => this.#onEntries(entries),
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
      input: composerInput(this.#agent.snapshot),
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
    this.#contentStack = new Gtk.Stack({ vexpand: true });
    const panes = buildSplitView(
      this.#sessions.widget,
      this.#placeholder,
      this.#transcript.widget,
      this.#composer.widget,
      this.#contentStack,
    );
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
    this.#watchCloseRequest();
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
   * **The `Adw.StatusPage` is left exactly as the constructor built it.** It used to be refilled here
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
  #open(record: SessionRecord): void {
    const label = labelOf(record);
    this.#openRecord = record;
    this.#agent.bind({ id: record.id, cwd: record.cwd });
    this.#transcript.setEntries(record.turns);
    // Named, not indexed: `'closed'`/`'open'`/`'empty'` read at the assignment and a `Gtk.Stack` is a
    // map, so an index would be a second naming scheme for the same three states.
    //
    // **`'empty'` is its own state, not the closed page reused.** A session that is open and holds no
    // turns is a third thing, not the second one: `kurier start` with no prompt produces exactly
    // that. Showing the transcript's blank column for it reads as a failed load, and showing
    // "No session open" for a session that *is* open is a lie in the title bar's own words.
    this.#contentStack.visibleChildName = record.turns.length === 0 ? 'empty' : 'open';
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
    breakpoint.add_setter(this.#split, 'collapsed', true);
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
    if (text.trim() === '') return;
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
    this.#composer.setInput(composerInput(snapshot));
    // `keepsDraft` is the decision and it lives in core; the window only carries it out. An agent that
    // exited can never receive what is in the entry, and leaving it there collects words that go
    // nowhere — so `gone` is the one state that discards it.
    if (!keepsDraft(snapshot.state)) this.#composer.clearDraft();
    if (snapshot.attachment.status === 'gone') this.#permissions.close();
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
    // A session that was showing `'empty'` has just said something. Left as it is, the pane keeps the
    // "Nothing here yet" status page *underneath* the new bubble, and the sentence contradicts what is
    // on top of it.
    if (this.#contentStack.visibleChildName === 'empty') this.#contentStack.visibleChildName = 'open';
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
      // The staging timer dies with the window. `source_remove` is only reached for a timer that has
      // not fired yet — the callback clears the field before it returns, so an already-fired id is
      // never removed twice.
      if (this.#permissionSource !== null) {
        GLib.source_remove(this.#permissionSource);
        this.#permissionSource = null;
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
      console.log(`kurier: KU_APP_CONFIG=${hooks.config} — read, not yet acted on`);
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
    if (hooks.debug) console.log('kurier: verbose dev logging on');
    // `KU_APP_THINKING` sends a prompt, because this is the step that has a turn to send. It is a real
    // turn against whatever agent was selected — no staged fake stream — because a fake one would test
    // the staging code instead of the window. The prompt defaults to a fixture sentence rather than to
    // anything from the session file: a screenshot must not carry a real conversation out of it.
    if (hooks.thinking === true) {
      const prompt = hooks.prompt ?? 'Summarise this repository in three sentences.';
      const record = this.#openRecord;
      if (!record) {
        console.log('kurier: KU_APP_THINKING — no session is open, so there is nowhere to send it');
      } else {
        console.log(`kurier: KU_APP_THINKING — sending to ${record.id}`);
        this.#composer.clearDraft();
        void this.#agent.prompt(prompt);
      }
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
    if (!this.#openRecord) {
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
function composerInput(snapshot: AgentSnapshot): ComposerInput {
  return {
    state: snapshot.state,
    agent: agentStatus(snapshot.attachment),
    sessionId: snapshot.sessionId,
  };
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
function buildContent(
  header: Adw.HeaderBar,
  placeholder: Adw.StatusPage,
  transcript: Gtk.Widget,
  composer: Gtk.Widget,
  stack: Gtk.Stack,
): Adw.NavigationPage {
  const box = new Adw.ToolbarView({ vexpand: true });
  box.add_top_bar(header);
  // **The stack, not a swap of `set_content`.** The empty state and a session are two answers to one
  // question, and a `Gtk.Stack` holds both so switching back and forth is a `visibleChildName`
  // assignment rather than a reparent. That matters because the *composer* is a bottom bar of this
  // `Adw.ToolbarView` and not part of either child: putting the composer inside whichever child is
  // showing would rebuild its entry on every session switch, and the composer's whole job is to
  // survive one.
  stack.add_named(placeholder, 'closed');
  stack.add_named(transcript, 'open');
  // The third state: a session that is open and has said nothing yet. `kurier start` with no prompt
  // writes exactly such a record, so it arrives from the real CLI and not only from a hand-made
  // fixture — an empty pane there would look like a failure to load somebody's conversation.
  stack.add_named(
    new Adw.StatusPage({
      iconName: 'mail-send-receive-symbolic',
      title: 'Nothing here yet',
      description: 'No prompt has been sent in this session yet. The first one starts it.',
      vexpand: true,
      cssClasses: ['compact'],
    }),
    'empty',
  );
  box.set_content(stack);
  // **The composer is the bottom bar, and `RAISED_BORDER` is a measured choice.** Plan §7 step 4 puts it
  // here and §3 draws it under the conversation. The style is what decides whether the bar reads as
  // part of the pane or as a floating panel: `FLAT` (the default, and what the sidebar's own
  // `Adw.ToolbarView` uses) draws nothing under it, so the composer's rounded frame would sit directly
  // on the transcript's own background with no separation at all. `RAISED_BORDER` gives an opaque
  // background plus a persistent border, which is the one shape that reads correctly in both light and
  // dark without a shadow that then has to be explained.
  box.set_bottom_bar_style(Adw.ToolbarStyle.RAISED_BORDER);
  box.add_bottom_bar(composer);
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
function buildSplitView(
  sidebar: Gtk.Widget,
  placeholder: Adw.StatusPage,
  transcript: Gtk.Widget,
  composer: Gtk.Widget,
  stack: Gtk.Stack,
): Panes {
  const contentHeader = buildContentHeader();
  const contentPage = buildContent(contentHeader, placeholder, transcript, composer, stack);
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
