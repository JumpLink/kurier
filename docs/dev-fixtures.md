# Dev fixtures and the states only they can reach

Everything an agent would have to do for real to see a state: the stand-in peer's knobs, the dev hooks
that press controls a pointer would, and the probes that measure libadwaita. Moved out of
`AGENTS.md` because it is **reference** — a flag list and a set of recipes — and the hub rule is that a
listing belongs in `docs/` and is linked from the rule that needs it. The rules stay in `AGENTS.md`; only
the tables and the copy-paste lines moved, and nothing was shortened on the way.

The rules that *change behaviour* rather than describe it are deliberately **not** here — they
belong beside the code they change, so they live in `AGENTS.md` § Run / build / test: **a hook set to
`0` or `false` is off**, and **`KU_STANDIN_CHUNKS` takes a prefix** of the stand-in's four fixed
sentences. Everything below is the knob list, the copy-paste line and the measurement behind each one.

## Watching a turn without a model

`scripts/stand-in-agent.mjs` is a real ACP peer over stdio — real framing, real method names, the
`fork` marker `opencode acp` sends and the v1 schema does not define. It answers without a model, a
network or a quota, so a turn can be streamed, stopped and killed as often as needed and looks the
same twice. `KU_APP_AGENT=stand-in` selects it; it is reachable through the dev hooks and **not** in
`LAUNCHERS`, which is the table of programs a person installs.

```bash
# a turn that streams and then ends on its own
KU_APP_AGENT=stand-in KU_APP_THINKING=1 ./node_modules/.bin/gjsify run app/dist/kurier-app.gjs.mjs

# the two states that are unreachable against a real agent: mid-stream, and a dying agent
KU_STANDIN_HANG=1             # never answers end_turn — the running state, and what Stop is for
KU_STANDIN_EXIT_MID_TURN=1    # exits with code 3 during the turn — the gone state
KU_STANDIN_DELAY_MS=900 KU_STANDIN_CHUNKS=2   # a short, slow answer, to shoot mid-stream
KU_STANDIN_PERMISSION=1       # asks session/request_permission mid-turn and waits for the answer
```

**`KU_STANDIN_PERMISSION=1` sends all four option kinds**, so the dialog on screen shows four buttons.
That is the point of the fixture: the two `*_always` kinds used to be filtered out of the projection,
and a stand-in that only sent the `*_once` pair would have let that filter pass.

**The order on screen is not the order kurier adds them, and neither is the order the stand-in lists
them.** Three orders, all measured (`orderOptions` in `app/src/core/permission.ts` has the reasoning;
case 9 of `alert-dialog-close.mjs` prints the two GTK facts):

| | order |
| --- | --- |
| the stand-in sends | `allow_once`, `allow_always`, `reject_once`, `reject_always` |
| kurier **adds** the buttons | `reject_once`, `allow_once`, `allow_always`, `reject_always` |
| they appear on screen, top to bottom | `Always decline`, `Always allow`, `Allow once`, `Decline` |

The screen order is the reverse of the add order — libadwaita fills the row bottom-up — so the first
added is the **bottom** button and the last added is the **topmost**, the one a hand reaches first. The
focus goes to the bottom one, `Decline`, and the topmost is a decline too. **The stand-in's own names
("Always allow in this session") are what such a screenshot shows exactly once, as a caption line in the
body** — the label rule itself, and why the names sit there rather than on a button, is in `AGENTS.md`
§ Run / build / test.

Three knobs reach the shapes around this, and **all three are off unless set** (same rule as every other
hook here):

| Variable                              | What it sends                                             | Why it is a knob |
| ------------------------------------- | --------------------------------------------------------- | ---------------- |
| `KU_STANDIN_PERMISSION_ONCE`          | only `allow_once` + `reject_once`                          | what an agent with no lasting grant looks like — the minimal two-button dialog |
| `KU_STANDIN_PERMISSION_ALWAYS_FIRST`  | all four, `*_always` listed **first**                      | the order that used to decide where libadwaita put the focus, so a screenshot can show kurier's order winning |
| `KU_STANDIN_PERMISSION_NO_REJECT`     | only `allow_once` + `allow_always`                         | **the state with nothing safe to name.** There is no decline, so `default_response` has nothing to point at and libadwaita's fallback lands on `allow_once`; kurier's own grab in `show()` is the only thing keeping the focus on the diff body (case 10 measures what happens without one). Off by default, because the default keeps a decline available |

```sh
# four buttons — the default, and the dialog to photograph
KU_APP_AGENT=stand-in KU_APP_THINKING=1 KU_STANDIN_PERMISSION=1 ./node_modules/.bin/gjsify run app/dist/kurier-app.gjs.mjs

# two allows and no decline: the focus must land on the diff body, not on "Always allow"
KU_APP_AGENT=stand-in KU_APP_THINKING=1 KU_STANDIN_PERMISSION=1 KU_STANDIN_PERMISSION_NO_REJECT=1 \
  ./node_modules/.bin/gjsify run app/dist/kurier-app.gjs.mjs
```

`KU_APP_THINKING=1` sends the prompt, `KU_APP_PROMPT=<text>` says which. The two rules about *reading* a
knob — what `KU_STANDIN_CHUNKS` does with a number, and that both spellings of "off" are off — are stated
once, in `AGENTS.md` § Run / build / test, and the front matter above says why they are not here again.
What a fixture needs from them is only that the stand-in's `flag()` and kurier's
`frontends/gui/hook-value.ts` read one value the same way, which is tested on both runtimes.

**The config row, in the same spirit: one flag, and the values it carries.** `KU_STANDIN_CONFIG=1`
makes the stand-in report a model / effort / mode row and answer `session/set_config_option` with the
**full** option list, the way `opencode acp` does — a bare `[]` would empty the row on every pick, which
is a different state ("this agent has no configuration") dressed up as an answer.

| Variable                   | Default | What it does                                                              |
| -------------------------- | ------- | ------------------------------------------------------------------------- |
| `KU_STANDIN_CONFIG`        | unset   | Report `model` / `effort` / `mode` and answer a config-option set.          |
| `KU_STANDIN_CONFIG_MODELS` | `3`     | How many models the list holds. `400` is opencode's real size, and the one the dropdown's search field is for. |
| `KU_STANDIN_CONFIG_REFUSE` | unset   | Refuse **every** configuration change — the fail-closed state, which no real agent in reach produces. |
| `KU_STANDIN_CONFIG_PUSH`   | `1`     | Push `config_option_update` after a *model* change. `0` leaves only the answer, so both doors can be exercised. |

**`KU_APP_CONFIG` sets an option through the real path, and its format is `configId=valueId`** — both
halves, because a control id says which option and not to what, and a value id cannot be resolved on
its own (`parseConfigOptionSpec`, and a half-spec is refused with a line in the log rather than quietly
picking something). It **sends the prompt itself when no turn has run**, because the agent is started on
the first prompt and an option can only be set on a live agent: so `KU_APP_PROMPT` (or a fixture
sentence) goes out, `session/load` answers with the options, and only then is
`session/set_config_option` sent. It is therefore applied **before** `KU_APP_THINKING` — one prompt, one
turn, one set. What a screenshot shows is the row in the state a person's click produces.

```bash
# a real set, over the real chain, with the stand-in's 400-model list
KU_APP_AGENT=stand-in KU_STANDIN_CONFIG=1 KU_STANDIN_CONFIG_MODELS=400 \
  KU_APP_SESSION=fixture-2 KU_APP_CONFIG=model=openrouter/vendor/model-012 KU_APP_PROMPT=hi \
  ./node_modules/.bin/gjsify run app/dist/kurier-app.gjs.mjs

# the refusal: the agent says no, the row stays on what the agent last answered
KU_APP_AGENT=stand-in KU_STANDIN_CONFIG=1 KU_STANDIN_CONFIG_REFUSE=1 \
  KU_APP_SESSION=fixture-2 KU_APP_CONFIG=mode=plan KU_APP_PROMPT=hi \
  ./node_modules/.bin/gjsify run app/dist/kurier-app.gjs.mjs
```

**One line while the three controls fit, wrapped when they do not, and the row raises no floor.** The
controls sit in a `Gtk.FlowBox` (`max-children-per-line: 3`) with each dropdown inside an `Adw.Clamp` that
caps what it asks for (`CONFIG_CONTROL_WIDTH_PX`), so a long model id cannot force a wrap. The row sits on
the composer's card rather than in a strip of its own, so the width cap around it is the composer's clamp.
The window stops at 360 however the row wraps — so the floor is `Adw.NavigationSplitView`'s and not kurier's content's. The row's own
minimum is 293 px with a 32-character model id, which is where "raises no floor" comes from rather than
from the clamp: a clamp caps a natural width and passes the minimum through
(`scripts/probes/window-min-width.mjs` prints both, and the sweep).

What the row may show and when is decided in `app/src/core/config-row.ts` and tested on both runtimes;
the widget only renders.

**Two known limits of the row, written down rather than discovered later.**

- **Every answer rebuilds every dropdown.** A whole-row rebuild (`Composer` and `SessionList` do the same)
  is what keeps a half-updated row from existing, and it costs a rebuilt `Gtk.StringList` — 400 rows for
  the model control — on each agent answer. Cheap enough today; if a future agent pushes
  `config_option_update` on every keystroke of a thinking level, that is where it will show.
- **A notification that lands while a set is in flight is discarded, not merged.** The set's answer wins,
  because the answer is the state *after* the change and both carry the whole list. The cost is that an
  agent-side change to a *different* option arriving in that window is not shown until the next answer or
  the next `session/load` (`#takeConfigUpdate`). Reached from a real agent? Unmeasured — see
  `config-row.ts` and the fixture knob `holdConfigAnswer`, which is what makes the race testable at all.

**One agent session's options at a time, kept for the sessions this window has prompted.** The last
list the agent reported is cached per session id, in memory only, up to eight (`CONFIG_MEMORY_LIMIT`) —
nothing is written to disk, and nothing is merged or re-interpreted: the agent's `currentValue` still
wins on every answer. The cache exists because `bind(A) → bind(B) → bind(A)` with no prompt in between
re-binds nothing (selecting a session starts nothing, plan §6), so there is nothing to re-ask. An agent
that dies takes the cache with it, because live dropdowns over a process that has exited are controls
pointing at nothing.

**Four stand-in knobs for the states no real agent in reach produces**, same off-rule as `flag()`
(`KU_STANDIN_AUTH` / `KU_STANDIN_PROMPT_AUTH` / `KU_STANDIN_NO_RESUME` / `KU_STANDIN_USAGE`). They exist
because each of the four is a failure or a line that a healthy agent produces in the middle of a
conversation, and kurier's surface has a decision for each that nothing else here reaches:

```sh
# trap 1: initialize succeeds, session/load answers -32000 → the auth dialog naming `kurier auth`
KU_STANDIN_AUTH=1

# trap 2: neither loadSession nor resume → the refusal dialog, not an empty transcript
KU_STANDIN_NO_RESUME=1

# issue #2: session/prompt answers the *same* -32000 → the model dialog, not the auth one
KU_STANDIN_PROMPT_AUTH=1

# a usage_update with the cost a double really carries → the rounded line in the transcript
KU_STANDIN_USAGE=1
```

### `KU_STANDIN_PROMPT_AUTH=1` — the same error code, a different kind

**The one knob that is not a trap but a misreport.** Measured 2026-10-02 against `opencode acp` 2.0.19
with **no login**: the anonymous default model `opencode/fledge-alpha-free` is geo-blocked from Germany
(HTTP 403), and opencode answers any provider 403 on `session/prompt` with
`-32000 "Authentication required: provider authentication required"` — the same class and the same
code as `KU_STANDIN_AUTH`'s answer at `session/load`. Nothing on the wire separates the two except that
one has a prompt behind it, which is what `failureKind`'s `promptSent` reads. Upstream:
<https://github.com/JumpLink/kurier/issues/2>.

**Nothing streams first.** The measured turn carries no `stopReason` and no text at all, so a fixture
that echoed the prompt or wrote a thought before refusing would photograph a window that looks as though
the agent had started answering. `KU_STANDIN_CONFIG=1` is what puts a model dropdown on the row, and the
dialog's **Choose another model** button is only there when it is.

```sh
# the model-refusal dialog, over the real chain, with a model list behind it
KU_APP_AGENT=stand-in KU_STANDIN_CONFIG=1 KU_STANDIN_PROMPT_AUTH=1 \
  KU_APP_SESSION=fixture-2 KU_APP_THINKING=1 KU_APP_PROMPT=hi \
  ./node_modules/.bin/gjsify run app/dist/kurier-app.gjs.mjs

# the same refusal with no configuration row → the dialog still appears, Close only
KU_APP_AGENT=stand-in KU_STANDIN_PROMPT_AUTH=1 \
  KU_APP_SESSION=fixture-2 KU_APP_THINKING=1 \
  ./node_modules/.bin/gjsify run app/dist/kurier-app.gjs.mjs
```

**The dropdown opening is the state only a button can reach,** like the dialog's own dismissal: a
`Gtk.DropDown` is a widget the devtools plane cannot operate (`hooks.ts`), and `ActivateWidget` on an
`Adw.AlertDialog` response reports `true` and emits no `response`. There is no hook for pressing it —
the button is pressed from inside the process, by `ConfigRow.openModelDropdown()`, and the run's log
line `the model dropdown is open` (or `… is not on the row — nothing to open`) is what says afterwards
whether it reached. `scripts/probes/` has the measurement behind the one call that does it:
`gtk_drop_down_get_popup()` is not introspectable on GTK 4.22.5, so the widget calls `activate()` —
see `activateDropdown` in `frontends/gui/config-row.ts`.


## The five pointer-only controls

Five states are unreachable from outside the process, and each has one hook. They are read at startup by
`readHooks` (`frontends/gui/hooks.ts`) and passed down rather than read at the point of use, so a hook
cannot be flipped between two states inside one run.

| Variable | What it presses |
| --- | --- |
| `KU_APP_STOP=1` | the composer's **Stop**, once the turn is running |
| `KU_APP_STOP_ESCAPE=1` | the open permission dialog, the way Escape does |
| `KU_APP_DISMISS_FAILURE=1` | the failure dialog's own **Close** |
| `KU_APP_CHOOSE_MODEL=1` | the `'model'` failure dialog's **Choose another model** (issue #2) |
| `KU_APP_SWITCH=id[,id…]` | `#open` — sessions in turn, once a failure is on screen |

`KU_APP_STOP_ESCAPE` records a dismissal as `not-answered: dismissed`, sends `cancelled` over the wire,
and stops nothing else — the two strings are not the same, so the hook passes the reason and not the
outcome. `KU_APP_CHOOSE_MODEL` presses the one button **issue #2** exists for: the `'model'` dialog's
second response has no shortcut, because `Adw.AlertDialog` has no callable `response()` at all.

```sh
# Stop, mid-turn
KU_APP_AGENT=stand-in KU_APP_THINKING=1 KU_APP_STOP=1 ./node_modules/.bin/gjsify run app/dist/kurier-app.gjs.mjs

# Escape on an open permission dialog, and nothing else
KU_APP_AGENT=stand-in KU_APP_THINKING=1 KU_STANDIN_PERMISSION=1 KU_APP_STOP_ESCAPE=1 \
  ./node_modules/.bin/gjsify run app/dist/kurier-app.gjs.mjs

# Close on the refusal dialog, then the session moving on underneath it
KU_APP_AGENT=stand-in KU_STANDIN_NO_RESUME=1 KU_APP_DISMISS_FAILURE=1 KU_APP_SWITCH=fixture-1,fixture-2 \
  ./node_modules/.bin/gjsify run app/dist/kurier-app.gjs.mjs

# issue #2: the model dialog's button, with a model list behind it
KU_APP_AGENT=stand-in KU_STANDIN_CONFIG=1 KU_STANDIN_PROMPT_AUTH=1 KU_APP_CHOOSE_MODEL=1 \
  ./node_modules/.bin/gjsify run app/dist/kurier-app.gjs.mjs
```

**Why a hook for each, measured rather than assumed.** `ActivateWidget` on an `Adw.AlertDialog` response
button reports `true` and emits no `response` (the permission dialog too, so it is libadwaita),
`SendKey` answers `false` for Escape, nothing in devtools moves a `Gtk.ListBox` selection, and a real
pointer cannot stand in: under Wayland `XTestFakeMotionEvent` does not move it, and under
`GDK_BACKEND=x11` a dialog is mapped but never painted. **The failure dialog's close-response is
`close`, so `close()`, Escape and pressing Close are the same call** — `scripts/probes/alert-dialog-close.mjs`
case 1 measures it, and the fourth fact it prints is in [## Probes](#probes); the same case records that
`Adw.AlertDialog` has no callable `response()` at all, which is why `KU_APP_CHOOSE_MODEL` emits the signal
itself.

The two rules these five all follow — each hook goes **through the surface** rather than around it, and a
hook's value is read by `frontends/gui/hook-value.ts` and not by `hooks.ts` — are stated once, with the
reason for each, in `AGENTS.md` § Run / build / test.

## The preferences dialog

Not a sixth pointer-only control in the table above, but the same reason: radio rows are not operable from the devtools plane. `KU_APP_PREFERENCES=1` opens the dialog through `app.preferences`, the action the menu and `<Ctrl>comma` run. `KU_APP_PREFERENCES_AGENT=<key>` opens it and chooses a row through the dialog's own handler; keys are `auto`, `<id>:host`, `<id>:bundled`. Both follow `flag()`/`hookValue` rules, and each logs one line saying whether it reached.

```sh
# 360 px: with GJSIFY_DEVTOOLS=1, resize afterwards:
#   gdbus call --session --dest eu.jumplink.Kurier --object-path /eu/jumplink/Kurier/devtools \
#     --method org.gjsify.Devtools.ResizeWindow 360 600
GJSIFY_DEVTOOLS=1 KURIER_SETTINGS_FILE=/tmp/x/settings.json KU_APP_AGENT=stand-in KU_APP_PREFERENCES_AGENT=opencode:bundled \
  ./node_modules/.bin/gjsify run app/dist/kurier-app.gjs.mjs
```

Rows are action rows with radio buttons rather than an `Adw.ComboRow`: a combo row has no per-item subtitle (path, version, "not found") and wraps badly at 360 px. Versions are never probed here (`--version` is skipped), so a host row shows no version.

## The login dialog

`KU_APP_LOGIN=1` opens it the way the auth dialog's **Log in…** does, on the real path: a private `opencode serve` and its real provider list, so it needs opencode v2 on `PATH`. Rows are `Adw.ActionRow`s, which the devtools plane can activate. A window that is not visible renders nothing (`Screenshot` answers `empty-snapshot`); a headless `mutter --headless --wayland --virtual-monitor 1280x800` on its own session bus is a display that always draws.

## First run and New chat

**First run is an empty `KURIER_SESSIONS_FILE`** (the window opens on the `new` page with a live composer, and no process until a prompt is sent). The first prompt connects, sends `session/new` for the resolved cwd, writes the record (`conversationRecord`, shared with `kurier start`: title from the prompt, `agent`, `agentSource`, `cwd`, `reattach`) and then prompts; the sidebar gets the row on top and marks it. **New chat** is `win.new-chat`: the button in the sidebar header bar, `<Ctrl>n` and `KU_APP_NEW_CHAT` all activate that one action.

**The cwd** is `KURIER_CWD` → the directory kurier was started from (inside a Flatpak: the host shell's, asked once before the window exists, up to 5 s) → `$HOME`; one that is not an absolute existing directory falls through (`core/cwd.ts`). The window shows it as one dim line under the composer, home as `~`. The host question is not measured here — this machine is not a Flatpak — only its pure half and the argv are tested.

- `KU_APP_NEW_CHAT=1` — press New chat through `win.new-chat`. With a turn running it waits for the turn to end, so `KU_APP_THINKING=1 KU_APP_PROMPT=… KU_APP_NEW_CHAT=1` photographs the empty composer *after* a chat exists. The action is activated with `lookup_action('new-chat').activate(null)`: `this.activate_action('win.new-chat', null)` resolves to `Gio.ActionGroup`'s on a window, takes no prefix, returns nothing and did nothing (measured).
- `KU_APP_NEW_CHAT_MIDTURN=1` — press New chat **while the turn is streaming**: polls (50 ms) until the agent has said something and the turn is still running, then activates `win.new-chat`. New chat stops the turn the way Stop does (`session/cancel`; an open permission settles `cancelled`, `turn-cancelled`), the turn ends `idle` (never `Stopped.` on the new chat), and anything the old turn still says goes to its own record and never to the visible pane — the same holds for opening another row mid-turn (`bind`). After the agent has exited (`gone`), New chat retires the dead handle (awaiting its `close()`) so the next prompt starts a fresh agent; a record that cannot be written after `session/new` says so (`unsavedMessage`: not saved, why, press New chat).
  ```sh
  GJSIFY_DEVTOOLS=1 KURIER_SESSIONS_FILE=/tmp/x/sessions.json KURIER_SETTINGS_FILE=/tmp/x/settings.json \
    KU_APP_AGENT=stand-in KU_APP_CWD=/tmp/x/project KU_STANDIN_DELAY_MS=1500 \
    KU_APP_THINKING=1 KU_APP_PROMPT='Say hello.' KU_APP_NEW_CHAT_MIDTURN=1 \
    ./node_modules/.bin/gjsify run app/dist/kurier-app.gjs.mjs
  ```
- `KU_APP_CWD=<path>` — pin the cwd so a screenshot never shows a private path; beats `KURIER_CWD`. `KU_APP_THINKING` + `KU_APP_PROMPT` also send into the pending chat.
- The stand-in answers `session/new` with `ses_standin_0001`, then `…_2`, `…_3`: two chats in one window must not collide in the store.
- A session opened from the list is reattached on the copy of the agent its record names (`resolveRecorded`), asked on its first prompt. **Not wired with `KU_APP_AGENT`**: that pins one agent for the whole window, otherwise a fixture record naming `opencode` would start a real one.

```sh
# first run, a prompt, then the empty composer again — synthetic file, pinned cwd
mkdir -p /tmp/x/project
GJSIFY_DEVTOOLS=1 KURIER_SESSIONS_FILE=/tmp/x/sessions.json KURIER_SETTINGS_FILE=/tmp/x/settings.json \
  KU_APP_AGENT=stand-in KU_APP_CWD=/tmp/x/project KU_APP_THINKING=1 KU_APP_PROMPT='Say hello.' KU_APP_NEW_CHAT=1 \
  ./node_modules/.bin/gjsify run app/dist/kurier-app.gjs.mjs
```

Two defects found on the way, both fixed: `agentStatus({status: 'none'})` was `attached: false`, so Send stayed disabled until an agent existed — and the agent only starts on the first prompt (only `KU_APP_THINKING` could send one); and `#open` re-read nothing, so a chat revisited after streaming showed the startup copy of its transcript.

## The bundled-agent notice and the no-agent page

The bundled copy exists only inside a Flatpak, so two hooks stand in for it. Both are flags (`0`/`false` = off) and both go through the window's own paths.

- `KU_APP_NOTICE=1` — force the bundled-agent condition: the `Adw.Banner` under the content header shows (fixed English text from `core/empty-state.ts`, one **Got it**). Not shown for a host install, with no agent, or once dismissed. The text is kept to three lines at 360 px: `Adw.Banner` ellipsizes beyond that, which cut the statement itself.
- `KU_APP_NOTICE_DISMISS=1` — press **Got it** by emitting the banner's own `button-clicked`; logs one line. The id lands in `$KURIER_NOTICES_FILE` (default `$XDG_DATA_HOME/kurier/notices.json`, 0600 in 0700, atomic write); a corrupt or unreadable file shows the notice again and never stops startup.
- `KU_APP_NO_AGENT=1` — force the nothing-found resolution (beats `KU_APP_AGENT`): the content pane says "No agent found" with the install command (selectable text, no markup), the docs link and a **Preferences** button (`app.preferences`); Send and the entry are off with the reason under the composer. `kurier start`, `kurier auth` and `kurier agents` print the same remedy (`NO_AGENT_REMEDY`).

```sh
# synthetic everything; a missing sessions file is first run
GJSIFY_DEVTOOLS=1 KURIER_SESSIONS_FILE=/tmp/x/sessions.json KURIER_SETTINGS_FILE=/tmp/x/settings.json \
  KURIER_NOTICES_FILE=/tmp/x/notices.json KU_APP_CWD=/tmp/x/project KU_APP_AGENT=stand-in \
  KU_APP_NOTICE=1 ./node_modules/.bin/gjsify run app/dist/kurier-app.gjs.mjs   # or KU_APP_NO_AGENT=1
```

## The permission dialog

**The three GTK facts behind it are measured, not read from the signal docs**: `Adw.Dialog` emits
`closed` **before** `response` (so a dialog that settles on `closed` can never allow anything),
`force_close()` emits neither (so it would hang the turn), and with no `default_response` libadwaita
focuses the **first added** response — not the last, which is what `Adw-1.gir` says. The probes that
print the numbers, and the split between the two kinds of probe, are in [## Probes](#probes).

**The rank behind the order** (`orderOptions`) is `reject_once`, `allow_once`, `allow_always`,
`reject_always`, stable within a kind, and the row appears **bottom-up from that** — the order on screen
is the mirror of the order kurier adds in. The rules that follow from it (both end slots a decline,
`buildDialog` naming `default_response`, `show()` grabbing the focus, and the four short button labels
with the agent's wording moved into the body's caption line `agentNames`) are in `AGENTS.md` § Run /
build / test; what is measured here is why they hold — case 9 prints both the focus and the layout
direction, and case 10 builds a look-alike three ways (grab in `map`, grab in an idle, no grab) of which
**only the third reads `allow_once`**, so **a grab is what matters, not which kind of grab**.

**Stop is not pointer-reachable while the permission dialog is up, and that is libadwaita's doing.** An
`Adw.AlertDialog` grabs input on the window it is presented over, so the composer's Stop button cannot
be clicked from underneath it — measured under `GDK_BACKEND=x11` with a real `XWarpPointer` click at the
button's coordinates: the click is swallowed and the turn keeps running. The controller enforces Stop's
rule anyway (`stop()` settles the open question `cancelled` first), so the fail-closed behaviour does
not depend on the pointer; the dialog's own **Decline** covers the case a person can reach, answering
`reject_once` and letting the turn continue. A dialog is the right place for the answer to "may this
run?", not for "end this turn".

**`KU_APP_PERMISSION` is a fallback, not a competitor**, and the wait is a poll rather than a fixed
delay (`window.ts`): with `KU_STANDIN_PERMISSION=1` the agent's question is the better thing to
photograph and it arrives an unpredictable moment after the prompt goes out, so a fixed delay would
either beat it or lose to it. It stages only once the gate has not been asked; with no turn running
that is the first tick, because there is no agent that could ask.

```bash
# the agent's own question, mid-turn, over the real chain
KU_APP_AGENT=stand-in KU_APP_THINKING=1 KU_STANDIN_PERMISSION=1 ./node_modules/.bin/gjsify run app/dist/kurier-app.gjs.mjs

# just the dialog, with no agent at all
KU_APP_PERMISSION=1 ./node_modules/.bin/gjsify run app/dist/kurier-app.gjs.mjs
```

## The window floor

The floor itself — 360 px, `WINDOW_MIN_WIDTH_PX` — is stated once, in `AGENTS.md`, along with whose
limit it is. What is here is how to reproduce it, and what it costs elsewhere: the same 360 px is what
makes the config row on the composer's card wrap.

```sh
gjs -m scripts/probes/window-min-width.mjs        # the sweep, with no floor of its own
gjs -m scripts/probes/window-min-width.mjs 320    # what a different floor does
```

Pass a number to reproduce a different floor, or nothing to see what the window does without one.

**Run it on a headless mutter, not on the desktop session.** `set_default_size` on a mapped window is a
request, and this machine's session compositor granted none of them: the sweep printed the window's
two-pane minimum seven times, which reads like a layout that refuses to be narrow. The probe's own header
has the `dbus-run-session`/`mutter --headless` invocation and the numbers that come out of it.

## Probes

**Two kinds of GTK probe, and which is which.** `scripts/probes/` measures *libadwaita* with
look-alikes (`gjs -m scripts/probes/<name>.mjs`); `app/tests/probes/` measures *kurier's own widget*,
so it is a TypeScript entry that imports the widget and has to be bundled first:

```sh
./node_modules/.bin/gjsify build app/tests/probes/permission-focus.ts --app gjs --outfile /tmp/focus.gjs.mjs
DISPLAY=:0 ./node_modules/.bin/gjsify run /tmp/focus.gjs.mjs
```

The split exists because a look-alike cannot answer a question about our widget — the first version of
the permission dialog left libadwaita's focus fallback in place, and the plain probe said the focus was
on the allow button while the app's own screenshot showed a highlighted label instead.

**The focus case measures both readings of `default_response`.** Case 9 of `alert-dialog-close.mjs`
builds the dialog twice, `allow_once, reject_once` and `reject_once, allow_once`, because the two
readings agree on every single-order dialog: measured both ways on libadwaita 1.9.3, the focus follows
the **first** add — which is *not* what `Adw-1.gir` says ("the last added response will be focused by
default"). The same case prints the layout direction from `get_allocation().y` — the row is filled
**bottom-up from the add order**, so the last added response is the *topmost* button — which is why
`orderOptions` puts a decline in both end slots.

The permission-focus probe carries six cases for this, four of them with the `*_always` kinds, and its
allow-button test matches the *rendered* label of **any** allowing kind rather than `allow_once` alone: a
focused "Always allow" answers Enter exactly as a focused "Allow once" does, and also widens the answer.
It also samples the focus **every main-loop turn until it settles**, not once, so a focus that passes
through an allow button and lands somewhere safe afterwards cannot pass. The last two cases exist only
because kurier began passing the `*_always` kinds through: an agent offering `allow_once` and
`allow_always` and nothing rejecting leaves no safe button, and the probe fails if any sampled turn names
one.

**The two probes do not cover the same turn, and which covers what is worth knowing.** Case 10 of
`alert-dialog-close.mjs` is the look-alike version: two allows, no `default_response`, the same dialog
built three times — grabbing synchronously inside `map`, deferring the grab to an idle, and not grabbing
at all. The first sample is the body in the first two and `Allow once` in the third, which stays there.
So **a grab is what matters**, not which kind; the synchronous form is kept because an idle libadwaita
queues after ours, which is a structural argument and not a measured one. That
case cannot be reproduced against `PermissionDialog` at all: `present()` maps synchronously, so by the
time `permission-focus.ts` has a timer running, kurier's grab has already happened and the pre-idle frame
is not observable from outside. The widget probe therefore covers the **settled** focus and the
turn-by-turn sequence; neither result is stretched to answer the other.

The fourth fact is the failure dialog's: an external `close()` emits `closed` and *then*
`response("close")` — the same pair, with the same argument, that the one response button produces — so
on that dialog "the person pressed Close" and "the window closed it" are the same call, and there is
nothing to simulate. `Adw.AlertDialog` has no callable `response()` at all; the signal is reachable only
through `emit`, which is what `AdwAlertDialog` does internally.

**That measurement still holds now that the `'model'` dialog has a second response, and it is why.**
`FailureDialog` names its dismissal `close`, and `close` is libadwaita's default `close-response` — so
`close()`, Escape and pressing Close all arrive as `response("close")`, and never as the remedy. So
`KU_APP_DISMISS_FAILURE` still photographs a *dismissed* dialog on the one dialog that has something to
dismiss, and the window's single `close()` still takes down whichever dialog is up. The rule was "one
response, so there is one dismissal"; the rule that survives is the stronger one, "the dismissal is the
response named `close`".

*The GUI run recipe — detached start, `GJSIFY_DEVTOOLS=1`, a synthetic `KURIER_SESSIONS_FILE`,
`KU_APP_SESSION` — is in `AGENTS.md` § Run / build / test, where it belongs: it is how the work is
run, not a fixture.*

### GTK Behaviour (moved from AGENTS.md)

**The GUI is looked at, not believed:** start it detached (a foreground GJS process is killed by the
agent sandbox), with `GJSIFY_DEVTOOLS=1` for `org.gjsify.Devtools` on `/eu/jumplink/Kurier/devtools`
(`Screenshot`, `DumpTree`), `KURIER_SESSIONS_FILE=<synthetic file>` so no real conversation ends up in a
screenshot, and `KU_APP_SESSION=<id>` to open a session without a pointer. GTK behaviour a comment
relies on gets a probe in `scripts/probes/` that prints the numbers the comment quotes.

**Three GTK facts behind the permission dialog, measured not read from signal docs:**
- `Adw.Dialog` emits `closed` before `response`, so a dialog that settles on `closed` can never allow anything
- `force_close()` emits neither signal (so it would hang the turn)
- With no `default_response` set, libadwaita focuses the **first added** response — contrary to
  `Adw-1.gir` which says "the last added response will be focused by default"

**Kurier owns the button order, not just the button set** (`orderOptions`). The agent's order is chosen
by the agent; the rank is `reject_once`, `allow_once`, `allow_always`, `reject_always`, stable within a
kind, and the row appears **bottom-up from that**, so the first added is the bottom button and the last
added is the topmost. Two measured libadwaita facts fix it: with no `default_response` **the focus goes
to the *first* added response** (not the last — `Adw-1.gir` says otherwise and case 9 measures both
directions), and the layout is bottom-up from the add order. So the first slot is a decline and the
topmost button is a decline. `buildDialog` names `default_response` explicitly rather than letting the
add order choose it, and `show()` grabs the focus — **case 10 builds a look-alike three ways** (grab in
`map`, grab in an idle, no grab) and only the third reads `allow_once`, which is the whole justification
for that grab. It is not observable from outside `PermissionDialog` (`present()` maps synchronously), so
the widget probe measures the settled focus and every turn in between instead.

**The button labels are kurier's four short sentences and the agent's own names are not on them.** A
button is the decision, so its label has to fit one line — the labels were once "kurier's word + the
agent's name" and read "Always decline: Always decline in thi…" at the 360 px floor. The agent's wording
moved into the body as one caption line (`agentNames`), shown only when a name says something the kind
does not. The terminal prompt follows the same rule: it prints `y = Allow once`, the option a `y` actually
grants, in the same words as the button.

**The phone floor is 360 px** (`WINDOW_MIN_WIDTH_PX` in `constants.ts`), and it is the width
`Adw.NavigationSplitView` stops at on its own — not a preference. Narrower than that the window is
unusable, and `gjs -m scripts/probes/window-min-width.mjs [floor]` prints the sweep that says so; pass a
number to reproduce a different floor, or nothing to see what the window does without one.

**GJS is mandatory, not optional.** A pure Node test would be green and would not answer the real
question. Both runtimes, as in postbote and beifahrer:

- **Node**: fast, injected `Transport` and `FixtureAgent` (`app/tests/support/fixture-agent.ts`), no
  subprocess. The fixture is a real ACP peer, not a mock — it speaks the protocol including the
  inconvenient parts (a `_meta` bag it invented, a mid-turn `request_permission`, a paginated
  `session/list`), so a client that only passes against a polite peer is not tested.
- **GJS**: one integration test that proves the real stdio chain against a real agent
  (`kurier-cli test:real-agent`).

If a change makes the Node run impossible, the change is in the wrong file — that dual run is the
entire point of the `packages/acp` ↔ `app` split.
