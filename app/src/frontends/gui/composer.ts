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
 * else's words is `#status`, and it passes `useMarkup: false` **in the constructor**, because Pango
 * parses on assignment: `css.ts` and `transcript-view.ts` both record that a later
 * `set_use_markup(false)` is too late.
 *
 * **The placeholder is a visible line, with `placeholder-text` only as a hint on top.** That property exists on
 * the GTK 4.22.5 this runs against (measured: `scripts/probes/composer-props.mjs`) and does **not**
 * exist in the `@girs/gtk-4.0` 4.6.0 typings this repo compiles against — so writing it would be a
 * type error here and a silently absent placeholder on any older GTK. `#status` carries the same
 * sentences under the entry, which is better anyway: they are on screen in a screenshot taken with no
 * pointer anywhere near the button.
 *
 * **The button is one widget whose content is swapped, never two widgets shown and hidden.** Two
 * buttons in one spot means two tab stops, two tooltips and a `Gtk.Stack` to keep in step with the
 * turn state. `composerView` returns one action and `Adw.ButtonContent` is re-filled with that one's
 * icon and label.
 *
 * **Two lines under the entry, and only one of them is ever visible at a time.** `ComposerView.reason`
 * explains a *disabled* control and is therefore empty exactly when the button works; `ComposerView.status`
 * says what is happening when there is nothing to disable. One merged label rather than two stacked
 * ones: with a dead agent and no session both have something to say, and two sentences under an entry
 * read as two problems when there is one.
 *
 * **`clearDraft` is a method rather than a side effect of `setState`, for one reason.** Whether a
 * draft survives a state change is a decision, and it lives in `core/composer-state.ts` as
 * `keepsDraft`. A widget that quietly emptied the entry whenever the state changed would put that
 * decision in the widget, where it could not be tested without a display — and the window would have to
 * remember to ask instead of being unable to forget.
 */

import Adw from '@girs/adw-1';
import Gdk from '@girs/gdk-4.0';
import Gtk from '@girs/gtk-4.0';

import { composerView, type ComposerInput } from '../../core/composer-state.ts';
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
   * Called with the entry's text when Send is pressed. Only reachable while an agent is attached and a
   * session is open, because `composerView` disables the button otherwise.
   *
   * The window's implementation appends the prompt to the store and the transcript itself: the surface
   * that will show it is the one that has to write it, and a controller that recorded it would mean the
   * controller knew about a widget it does not own.
   */
  readonly onSend?: (text: string) => void;
  /** Called when Stop is pressed. Reachable only while a turn runs, so it needs no guard. */
  readonly onStop?: () => void;
  /**
   * The render inputs, read once. See `core/composer-state.ts`: every one of them is somebody else's
   * answer (the turn machine, the agent's life, which session is open), which is what makes the composer
   * a renderer rather than a second opinion.
   */
  readonly input: ComposerInput;
}

export class Composer {
  /** Pack this into the `Adw.ToolbarView` as its bottom bar. */
  readonly widget: Gtk.Widget;

  readonly #entry: Gtk.TextView;
  readonly #button: Gtk.Button;
  readonly #buttonContent: Adw.ButtonContent;
  /** The one line under the entry: the reason, or the status, never both. See the file header. */
  readonly #status: Gtk.Label;
  readonly #onSend: ((text: string) => void) | undefined;
  readonly #onStop: (() => void) | undefined;
  #input: ComposerInput;

  constructor(options: ComposerOptions) {
    this.#input = options.input;
    this.#onSend = options.onSend;
    this.#onStop = options.onStop;

    this.#entry = new Gtk.TextView({
      // Word *or* character: a long path or a shell command has no spaces to break on, and an
      // unwrapped line in a 360 px window is a horizontal scroll nobody asked for.
      wrapMode: Gtk.WrapMode.WORD_CHAR,
      leftMargin: 8,
      rightMargin: 8,
      topMargin: 8,
      bottomMargin: 8,
      // `acceptsTab` stays at its default `true`: Tab in a text view inserts a tab character and that
      // is correct — the person is writing text, and taking Tab away would strand keyboard
      // navigation inside the composer, which at the 360 px phone floor has nowhere else to go.
      cssClasses: [CSS.composerEntry],
    });
    // The typings (4.6.0) do not know `placeholder-text`; the GTK this runs on does (see the header and
    // `scripts/probes/composer-props.mjs`). Set after construction through a cast, so an older GTK gets a
    // plain JS property and no placeholder instead of a thrown constructor.
    (this.#entry as Gtk.TextView & { placeholderText?: string }).placeholderText = 'Ask the agent…';
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

    this.#status = new Gtk.Label({
      // In the constructor, and the reason is in the file header: Pango parses on assignment, so a
      // later `set_use_markup(false)` is too late (measured, `css.ts`).
      useMarkup: false,
      xalign: 0,
      wrap: true,
      label: '',
      cssClasses: [CSS.composerStatus, 'caption'],
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
    column.append(this.#status);

    // `append`, not `child:` constructor property: `Gtk.Box` has no such property (only
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
    // pane's full width unchanged, which is what the 360 px phone floor gets; above it, an unconstrained entry
    // would stretch across an ultrawide and put the cursor nowhere near the answers it is answering.
    this.widget = new Adw.Clamp({
      child: frame,
      maximumSize: CONTENT_MAX_WIDTH_PX,
      tighteningThreshold: CONTENT_MAX_WIDTH_PX,
    });

    this.#render();
  }

  /** New render inputs. Renders through `composerView` and nothing else. */
  setInput(input: ComposerInput): void {
    this.#input = input;
    this.#render();
  }

  /**
   * Press the composer's own button, the way a pointer press does.
   *
   * **`emit('clicked')` and not the callback, and that is the point of this method.** The window holds
   * `onStop` already and could call it; calling *that* would be a second way to press Stop, and the two
   * would drift the moment the button's handler grew a step — which it has, twice: the dialog teardown
   * with `turn-cancelled` before the cancel, and the clear-draft that follows. Emitting the signal goes
   * through the one handler a person's click goes through, so a screenshot of `KU_APP_STOP` is a
   * screenshot of the surface rather than of a re-implementation of it.
   *
   * **A no-op when the button is not Stop.** `KU_APP_STOP` fires on the first tick that finds a running
   * turn, and the turn may have settled in the meantime; clicking a Send button instead would send a
   * prompt, which is not what the hook asked for. The action check is the guard, and it is the same
   * `composerView` answer the button was last rendered from.
   */
  stop(): void {
    if (composerView(this.#input).action !== 'stop') return;
    this.#button.emit('clicked');
  }

  /** Empty the entry. The *caller* decides whether to — see `keepsDraft`. */
  clearDraft(): void {
    const buffer = this.#entry.get_buffer();
    if (!buffer) return;
    // The explicit length, not the one-argument form: `Gtk.TextBuffer.set_text` has wanted both since
    // GTK 3 and only the two-argument one is in the `@girs` typings this repo compiles against. An
    // empty string with length 0 is "replace the whole buffer with nothing", which is what is meant.
    buffer.set_text('', 0);
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
    const view = composerView(this.#input);
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
    const view = composerView(this.#input);
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
    // The reason wins over the status: they never both have anything to say (`composerView` returns a
    // reason only where the button is off), and a disabled control is the more urgent of the two.
    this.#status.label = view.reason || view.status;
    // With nothing to explain, the line takes no height: an empty caption under the composer is a gap
    // that reads as a layout bug.
    this.#status.visible = this.#status.label !== '';
  }
}
