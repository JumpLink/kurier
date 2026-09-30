/**
 * The composer: the message entry and the one button under the conversation.
 *
 * **It is a bottom bar, not a child of the transcript.** Plan §3 draws the composer under the
 * conversation and §7 step 4 puts it in "the bottom bar of the per-session view's own
 * `Adw.ToolbarView`". Both are about the same thing and the difference is load-bearing: a bottom bar
 * does not move when the transcript scrolls, so the text being written stays where it was written
 * while the conversation moves under it. It is also one of the three things `createNavShell` cannot
 * host, which is the measured reason the shell is hand-built (`window.ts`'s header).
 *
 * **`Gtk.TextView`, not `Gtk.Entry` and not `Adw.Entry`.** A prompt one line tall is a prompt a person
 * cannot write a stack trace into, and a multi-line box that grows to a limit is what every chat
 * surface this window is drawn from does. `Gtk.Entry` cannot wrap at all. Growth is capped by a
 * `Gtk.ScrolledWindow` rather than by the entry's own height, because a `Gtk.TextView` in an
 * unconstrained box asks for its whole natural height — a hundred-line paste would push the transcript
 * and the header bar off the window.
 *
 * **The rounded frame is a `Gtk.Box` with a class, not a `Gtk.Frame`.** `GtkFrame` draws a border and a
 * title gap and nothing in Adwaita turns it into the rounded surface this needs; a box with
 * `background-color` + `border-radius` is what `.kurier-bubble` already is in this window, so the
 * composer reads as the same kind of object as a message instead of a form field.
 *
 * **Nothing here is markup, and that is structural rather than a flag.** The Send button's label is
 * our own word. The entry is a `Gtk.TextView`, which has no markup rendering at all — there is no
 * `set_use_markup` anywhere near a typed message. The one label that *could* have taken somebody
 * else's words is `#reason`, and it passes `useMarkup: false` **in the constructor**, because Pango
 * parses on assignment: `css.ts` and `transcript-view.ts` both record that a later
 * `set_use_markup(false)` is too late.
 *
 * **The placeholder is a visible line, not `Gtk.TextView:placeholder-text`.** That property exists on
 * the GTK 4.22.5 this runs against (measured: `scripts/probes/composer-props.mjs`) and does **not**
 * exist in the `@girs/gtk-4.0` 4.6.0 typings this repo compiles against — so writing it would be a
 * type error here and a silently absent placeholder on any older GTK. `#reason` carries the same
 * sentence under the entry, which is better anyway: it is on screen in a screenshot taken with no
 * pointer anywhere near the button.
 *
 * **The button is one widget whose content is swapped, never two widgets shown and hidden.** Two
 * buttons in one spot means two tab stops, two tooltips and a `Gtk.Stack` to keep in step with the
 * turn state. `composerView` returns one action and `Adw.ButtonContent` is re-filled with that one's
 * icon and label.
 */

import Adw from '@girs/adw-1';
import Gdk from '@girs/gdk-4.0';
import Gtk from '@girs/gtk-4.0';

import { composerView, type TurnState } from '../../core/composer-state.ts';
import { CONTENT_MAX_WIDTH_PX } from './constants.ts';
import { CSS } from './css.ts';

/**
 * The Send icon. **`send-symbolic` does not exist** — checked with `Gtk.IconTheme.has_icon` and
 * recorded in `scripts/probes/icon-names.mjs`, alongside the two that do: `mail-send-symbolic` (used
 * here — a paper plane, which is what sending is) and `process-stop-symbolic` (used for Stop).
 *
 * The names are constants rather than inline strings for the reason the probe exists: a name the
 * Adwaita theme does not have renders as a broken-image placeholder, which is exactly what a
 * screenshot then shows as an unexplained gap. Verified on GTK 4.22.5 / libadwaita 1.9.3.
 */
const SEND_ICON = 'mail-send-symbolic';
/** The Stop icon. A filled square, which is what stopping a running turn looks like. */
const STOP_ICON = 'process-stop-symbolic';
/** Button labels. Fixed English — see `core/session-groups.ts` §2 on why not `Intl`. */
const SEND_LABEL = 'Send';
const STOP_LABEL = 'Stop';
/**
 * Tooltips for the two buttons while they are **working**.
 *
 * Needed because `composerView` returns `''` for a sensitive button, and `''` as a tooltip is no
 * tooltip: without these the Send button is the one control in the window with nothing to say about
 * itself. Fixed English — see `core/session-groups.ts` §2 on why not `Intl`.
 */
const SEND_TOOLTIP = 'Send this message to the agent.';
const STOP_TOOLTIP = 'Stop the running turn.';

/** The entry's resting height in logical pixels: two lines, so "write a prompt" is visibly possible. */
const ENTRY_MIN_HEIGHT = 56;
/** Where the entry stops growing and starts scrolling. A window's bottom bar has a budget. */
const ENTRY_MAX_HEIGHT = 180;

export interface ComposerOptions {
  /**
   * Called with the entry's text when Send is pressed.
   *
   * **Absent means "no agent", and the button is then disabled.** Plan §7 step 4 builds the composer
   * *without an agent* and step 5 adds `openAgent` and `runTurn`, so in this slice there is genuinely
   * nowhere for a message to go. A Send that accepted and dropped the text would be the
   * control-that-points-at-nothing this window's own header forbids, so the honest state is the
   * disabled button carrying its reason on screen.
   */
  readonly onSend?: (text: string) => void;
  /** Called when Stop is pressed. Never reachable in step 4, because no turn can start. */
  readonly onStop?: () => void;
  /**
   * Whether an agent is behind this window. **Not a guess and not a global:** the caller says, and
   * step 4 says `false`. This is the one input `composerView` needs beyond the turn state, and it is a
   * parameter so a test can ask "what does the composer look like with nothing attached" and get an
   * answer rather than whatever the machine happens to be running.
   */
  readonly attached: boolean;
}

export class Composer {
  /** Pack this into the `Adw.ToolbarView` as its bottom bar. */
  readonly widget: Gtk.Widget;

  readonly #entry: Gtk.TextView;
  readonly #button: Gtk.Button;
  readonly #buttonContent: Adw.ButtonContent;
  /** The reason line under the entry, so "why" is on screen and not only in a tooltip. */
  readonly #reason: Gtk.Label;
  readonly #onSend: ((text: string) => void) | undefined;
  readonly #onStop: (() => void) | undefined;
  #state: TurnState = 'idle';
  #attached: boolean;

  constructor(options: ComposerOptions) {
    this.#attached = options.attached;
    this.#onSend = options.onSend;
    this.#onStop = options.onStop;

    this.#entry = new Gtk.TextView({
      // Word *or* character: a long path or a shell command has no spaces to break on, and an
      // unwrapped line in a 480 px window is a horizontal scroll nobody asked for.
      wrapMode: Gtk.WrapMode.WORD_CHAR,
      leftMargin: 8,
      rightMargin: 8,
      topMargin: 8,
      bottomMargin: 8,
      // `acceptsTab` stays at its default `true`: Tab in a text view inserts a tab character and that
      // is correct — the person is writing text, and taking Tab away would strand keyboard
      // navigation inside the composer on a window whose minimum width is 480 px.
      cssClasses: [CSS.composerEntry],
    });
    // Enter sends, Shift+Enter does not — the convention in every chat surface this window is drawn
    // from, and without it a multi-line entry is a trap: the person types what looks like a message
    // and gets a newline instead. It goes through the SAME `#activate()` as the button, so there is
    // one send path rather than two that can disagree.
    this.#entry.add_controller(this.#enterToSend());

    const scroller = new Gtk.ScrolledWindow({
      child: this.#entry,
      hexpand: true,
      // NEVER: a composer that scrolls sideways is a line of text that refused to wrap.
      hscrollbarPolicy: Gtk.PolicyType.NEVER,
      minContentHeight: ENTRY_MIN_HEIGHT,
      maxContentHeight: ENTRY_MAX_HEIGHT,
      // The point of the two bounds: the scroller grows *with* the text up to the maximum and no
      // further. Without this both bounds are advisory and the bottom bar is as tall as the longest
      // message ever pasted into it.
      propagateNaturalHeight: true,
    });

    this.#buttonContent = new Adw.ButtonContent();
    this.#button = new Gtk.Button({
      child: this.#buttonContent,
      // END, so the button sits at the bottom of the entry rather than stretching to the scroller's
      // height when the entry has grown to three lines.
      valign: Gtk.Align.END,
    });
    this.#button.connect('clicked', () => this.#activate());

    this.#reason = new Gtk.Label({
      // In the constructor, and the reason is in the file header: Pango parses on assignment, so a
      // later `set_use_markup(false)` is too late (measured, `css.ts`).
      useMarkup: false,
      xalign: 0,
      wrap: true,
      label: '',
      cssClasses: [CSS.composerReason, CSS.dim, 'caption'],
    });

    const row = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 8,
      marginTop: 8,
      marginBottom: 8,
      marginStart: 12,
      marginEnd: 12,
    });
    row.append(scroller);
    row.append(this.#button);

    const column = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });
    column.append(row);
    column.append(this.#reason);

    // `append`, not a `child:` constructor property: `Gtk.Box` has no such property (only
    // `Gtk.ScrolledWindow` and `Adw.Clamp` do), and `window.ts`'s `buildSidebar` builds its box the
    // same way.
    const frame = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      cssClasses: [CSS.composerFrame],
    });
    frame.append(column);

    // **The same clamp maximum as the transcript, imported rather than written out.** Plan §3 asks for
    // one maximum line width, and the conversation and the thing you type into it are one column: two
    // clamps with two constants that happen to be equal is a coincidence that survives exactly until
    // somebody changes one of them. Below the tightening threshold the clamp hands its child the
    // pane's full width unchanged, which is the 480 px behaviour; above it, an unconstrained entry
    // would stretch across an ultrawide and put the cursor nowhere near the answers it is answering.
    this.widget = new Adw.Clamp({
      child: frame,
      maximumSize: CONTENT_MAX_WIDTH_PX,
      tighteningThreshold: CONTENT_MAX_WIDTH_PX,
    });

    this.#render();
  }

  /** Set when the turn state changes. Renders through `composerView` and nothing else. */
  setState(state: TurnState): void {
    this.#state = state;
    this.#render();
  }

  /** Whether an agent is behind this window. Step 5 turns this on; see `ComposerOptions.attached`. */
  setAttached(attached: boolean): void {
    this.#attached = attached;
    this.#render();
  }

  /** The entry's text, trimmed. Trimmed here so "did I type anything" has exactly one answer. */
  text(): string {
    // `get_buffer()`, not `getBuffer()`: the GIR declares the setter and the method, and the property
    // accessor only for widgets whose bindings generated one — `Gtk.TextView` has neither, so the
    // camelCase form is a compile error and the snake_case one is what compiles and runs.
    const buffer = this.#entry.get_buffer();
    if (!buffer) return '';
    return buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false).trim();
  }

  /**
   * The one send path.
   *
   * Reached from the button and from Enter, and it asks `composerView` again rather than trusting the
   * last render: a key press can arrive between a cancel going out and the next frame, and a control
   * that acts on a stale view is the control-this-window-forbids.
   */
  #activate(): void {
    const view = composerView(this.#state, this.#attached);
    if (!view.buttonEnabled) return;
    if (view.action === 'stop') {
      this.#onStop?.();
      return;
    }
    this.#onSend?.(this.text());
  }

  /**
   * Enter sends; Shift+Enter does not.
   *
   * `Gtk.EventControllerKey` rather than a window key handler, because GTK4 has no window events and
   * the controller's return value is what actually suppresses the newline — `EVENT_STOP`, not
   * `EVENT_PROPAGATE`, or the newline is inserted *and* the turn is sent.
   *
   * Both `KEY_ISO_Enter` and `KEY_KP_Enter` are matched: a laptop at 480 px with an external keyboard
   * is a real configuration and the keypad Enter is the one a person on it presses.
   */
  #enterToSend(): Gtk.EventControllerKey {
    const controller = new Gtk.EventControllerKey();
    controller.connect('key-pressed', (_controller, keyval, _keycode, state) => {
      if (keyval !== Gdk.KEY_ISO_Enter && keyval !== Gdk.KEY_KP_Enter) return Gdk.EVENT_PROPAGATE;
      const shift = (state & Gdk.ModifierType.SHIFT_MASK) !== 0;
      if (shift) return Gdk.EVENT_PROPAGATE;
      this.#activate();
      return Gdk.EVENT_STOP;
    });
    return controller;
  }

  /**
   * Render the whole composer from `composerView`.
   *
   * Rebuilt rather than diffed, for the reason `SessionList.setSessions` and
   * `TranscriptView.setEntries` both give: three states, one function, and a half-updated button is
   * the shape of the bug.
   */
  #render(): void {
    const view = composerView(this.#state, this.#attached);
    const isStop = view.action === 'stop';

    this.#buttonContent.iconName = isStop ? STOP_ICON : SEND_ICON;
    this.#buttonContent.label = isStop ? STOP_LABEL : SEND_LABEL;
    // Swapped, not stacked: `.suggested-action` on Stop would accent "end this turn", and
    // `.destructive-action` on Send would scare a person about posting a message. A `session/cancel`
    // deletes nothing — `AGENTS.md` calls it "the protocol's cancellation, not a kill" — so Stop is
    // styled as the alarming thing it is not, in neither direction.
    this.#button.remove_css_class('suggested-action');
    this.#button.remove_css_class('destructive-action');
    this.#button.add_css_class(isStop ? 'destructive-action' : 'suggested-action');

    this.#button.sensitive = view.buttonEnabled;
    // `composerView` returns an **empty** reason for a button that works — a sentence explaining a
    // button that is fine is noise — so the tooltip has to fall back to the action itself. Passing
    // `view.reason` straight through would leave the enabled button with no tooltip at all.
    this.#button.tooltipText = view.reason || (isStop ? STOP_TOOLTIP : SEND_TOOLTIP);
    // **The accessible name is never blank.** The same empty-reason rule means `view.reason` is `''`
    // exactly when the button works, and assigning `''` to `AccessibleProperty.LABEL` would leave a
    // screen reader announcing an unnamed button — the failure mode is invisible in a screenshot and
    // total for the person it hits. So: the action's own name, plus the reason when there is one.
    this.#button.update_property(
      [Gtk.AccessibleProperty.LABEL],
      [
        view.reason
          ? `${isStop ? STOP_LABEL : SEND_LABEL} — ${view.reason}`
          : isStop
            ? STOP_LABEL
            : SEND_LABEL,
      ],
    );

    this.#entry.editable = view.entryEditable;
    this.#entry.tooltipText = view.reason;

    // **On screen, not only on hover.** A reason nobody can see is a reason the surface has not given.
    this.#reason.label = view.buttonEnabled ? '' : view.reason;
    // With nothing to explain, the line takes no height: an empty caption under the composer is a gap
    // that reads as a layout bug.
    this.#reason.visible = this.#reason.label !== '';
  }
}
