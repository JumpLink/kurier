# Dev fixtures and the states only they can reach

Everything an agent would have to do for real to see a state: the stand-in peer's knobs, the dev hooks
that press controls a pointer would, and the probes that measure libadwaita. Moved out of
`AGENTS.md` because it is **reference** — a flag list and a set of recipes — and the hub rule is that a
listing belongs in `docs/` and is linked from the rule that needs it. The rules stay in `AGENTS.md`; only
the tables and the copy-paste lines moved, and nothing was shortened on the way.

The one rule that is *not* here, because it changes behaviour rather than describing it: **a hook set
to `0` or `false` is off** — unset, empty, `0` and `false` all mean not set, in kurier and in the
stand-in alike, so there is one rule for "is this on" in the repo
(`frontends/gui/hook-value.ts`, tested on both runtimes).

## Watching a turn without a model

### Watching a turn without a model

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
focus goes to the bottom one, `Decline`, and the topmost is a decline too. **The button labels are
kurier's four short sentences; the stand-in's own names ("Always allow in this session") appear once,
as a caption line in the body** — they used to be appended to the button, which read "Always decline:
Always decline in thi…" and was unreadable at the 360 px floor.

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

`KU_APP_THINKING=1` sends the prompt, `KU_APP_PROMPT=<text>` says which. A hook set to `0` or `false`
is **off** — unset, empty, `0` and `false` all mean not set, in kurier and in the stand-in alike, so
there is one rule for "is this on" in the repo.

`KU_STANDIN_CHUNKS` takes a **prefix** of the stand-in's four fixed sentences, so its default is `4`
and a value above it is the same four sentences. It is a knob for a *shorter* answer — a reply that is
still arriving, where the newest bubble is below the fold — and the default was `5` against a list of
four, which read as a knob that could grow and could not.

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

**One control per line, at every width, and the row raises no floor.** The three controls sit in a
`Gtk.FlowBox` with `max-children-per-line: 1`: at 360 px a shared line leaves each dropdown about 90 px,
which is an ellipsis rather than a model name. Measured with the row on screen, the real window still
stops at 360 — asked for 320, granted 360 — so the floor is still `Adw.NavigationSplitView`'s and not
kurier's content's (`scripts/probes/window-min-width.mjs` prints the sweep).

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

**Three stand-in knobs for the states no real agent in reach produces**, same off-rule as `flag()`
(`KU_STANDIN_AUTH` / `KU_STANDIN_NO_RESUME` / `KU_STANDIN_USAGE`). They exist because each of the
three is a failure or a line that a healthy agent produces in the middle of a conversation, and
kurier's surface has a decision for each that nothing else here reaches:

```sh
# trap 1: initialize succeeds, session/load answers -32000 → the auth dialog naming `kurier auth`
KU_STANDIN_AUTH=1

# trap 2: neither loadSession nor resume → the refusal dialog, not an empty transcript
KU_STANDIN_NO_RESUME=1

# a usage_update with the cost a double really carries → the rounded line in the transcript
KU_STANDIN_USAGE=1
```


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
on the allow button while the app's own screenshot showed a highlighted label instead. Three GTK facts
behind the dialog are measured rather than read from the signal docs: `Adw.Dialog` emits `closed`
**before** `response` (so a dialog that settles on `closed` can never allow anything), `force_close()`
emits neither signal (so it would hang the turn), and with no `default_response` set libadwaita focuses
the **first added** response — which is *not* what `Adw-1.gir` says ("the last added response will be
focused by default"). Case 9 of `alert-dialog-close.mjs` builds the dialog twice, `allow_once, reject_once`
and `reject_once, allow_once`, because the two readings agree on every single-order dialog: measured both
ways on libadwaita 1.9.3, the focus follows the **first** add. The same case prints the layout direction
from `get_allocation().y` — the row is filled **bottom-up from the add order**, so the last added
response is the *topmost* button — which is why `orderOptions` puts a decline in both end slots.

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
queues after ours would run after ours, which is a structural argument and not a measured one. That
case cannot be reproduced against `PermissionDialog` at all: `present()` maps synchronously, so by the
time `permission-focus.ts` has a timer running, kurier's grab has already happened and the pre-idle frame
is not observable from outside. The widget probe therefore covers the **settled** focus and the
turn-by-turn sequence; neither result is stretched to answer the other.

The fourth fact is the failure dialog's: an external `close()` emits `closed` and *then*
`response("close")` — the same pair, with the same argument, that the one response button produces — so
on that dialog "the person pressed Close" and "the window closed it" are the same call, and there is
nothing to simulate. `Adw.AlertDialog` has no callable `response()` at all; the signal is reachable only
through `emit`, which is what `AdwAlertDialog` does internally.
