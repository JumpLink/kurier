# AGENTS.md — kurier

Operating guide for AI agents in the **kurier** repo. Follows the [agents.md](https://agents.md/)
convention; the human overview is [README.md](README.md). This repo is a submodule of
**werkstatt**, whose [AGENTS.md](../../AGENTS.md) carries the broader workspace rules — this file
is the kurier-specific layer and wins where they differ.

## What this is

An **ACP client**: a TypeScript app that starts coding agents as subprocesses over the [Agent
Client Protocol](https://agentclientprotocol.com) (JSON-RPC 2.0 over stdio, Apache-2.0), manages
their sessions, and binds them to a surface. Runs on **GJS via gjsify**, like postbote and
beifahrer.

No agent of its own, no model of its own, no policy engine of its own — ACP brings that in as the
standard protocol instead of kurier's own invention. `session/request_permission` is the policy
layer, `fs/read_text_file`/`fs/write_text_file` can be refused outright, and `session/new` with
`mcpServers` lets the agent reach kurier's own MCP servers without a line of suite-specific code.

## Package layout — and the one rule that holds it together

| Package | Contains | May import |
|---|---|---|
| `@kurier/acp` | **Pure.** The ACP wire types against `refs/acp/schema.v1.json`, the JSON-RPC codec (`jsonrpc.ts`), the `Transport` seam (`transport.ts`), the client session lifecycle (`client.ts`), the gate that answers what an agent may ask of a client (`gate.ts`) | nothing |
| `@kurier/session` | The model (`SessionRecord`, transcript, resume binding, principal, scope) and a JSON file store | `@kurier/acp`, `node:fs` — no `gi://`, no agent adapter |
| `kurier-cli` (`app/`) | yargs CLI, the stdio child-process adapters, the agent launcher table, the terminal permission gate, XDG paths, and the Adwaita surface in `src/frontends/gui/` (its own bundle) | all of the above; `gi://` only under `frontends/gui/` |

**`packages/acp` does not know that subprocesses exist.** No `spawn`, no `node:child_process`, no
`gi://`, no dependencies at all — the transport is an injected interface (`Transport` in
`transport.ts`). That is postbote's `store`-knows-no-backend rule one layer up, and it is what lets
the same protocol code run as the Node unit test and the GJS integration test.

`@kurier/session`'s store takes a path and never decides one: the app resolves `$XDG_DATA_HOME`, a
test passes a temp dir.

## The CLI

```bash
kurier start [prompt..] --agent opencode   # new session, one prompt turn
kurier sessions [--all] [--long]           # kurier's own records, one principal
kurier resume <id> [prompt..]              # reattach, then optionally one turn
kurier cancel <id>                         # session/cancel
kurier auth [--agent opencode]             # trap 1's escape hatch
kurier login [provider] [--method id]       # login, no terminal (docs/login.md)
kurier agents                              # launchers, SOURCE (host/bundled/not found), what kurier would use
```

**Host before bundled, and the bundled copy is off PATH.** A Flatpak build unpacks the agents in
`app/data/bundled-agents.json` under `BUNDLED_PREFIX` (`core/agents/catalog.ts`, the one place the
prefix is written), never `/app/bin` — there it would shadow the person's own opencode, which carries
their login. The prefix is `/app/extra/agents`, not `/app/libexec`: the archive is Flatpak `extra-data`,
fetched at *install* time, and `apply_extra` can write only `/app/extra` (data/README.md).
`detectAgents` ignores a host hit under the prefix; `resolveAgent` takes the setting, else the first
host install, else the first bundled copy (`core/agents/detect.ts`, pure over facts gathered by
`probe.ts`). The catalog's `env` is flags only, never a credential.
The person's choice (`{id, source}`, so "bundled opencode" ≠ "my opencode") is `core/settings.ts`, in
`$XDG_CONFIG_HOME/kurier/settings.json` (`KURIER_SETTINGS_FILE`), 0600/0700, an allowlist that accepts no secret;
precedence is `--agent` (CLI) / `KU_APP_AGENT` (GUI dev hook) > setting > host > bundled, and a setting that names something
unavailable is reported (`note`), never skipped silently; a corrupt file falls back to defaults and says so.
`kurier agents --use <id>[:bundled|host]|none` writes it.
The GUI writes it from Preferences (`<Ctrl>comma`; `core/settings-view.ts` decides the rows, unavailable ones stay listed) and a change applies the next time kurier starts (the window resolves its agent once and keeps it); a settings file kurier could not read is never destroyed by a save (`saveDecision`: a newer `version` refuses, anything else is first moved to `settings.json.bak`); inside a Flatpak the dialog opens before the host answers (`Checking…`, then async). Hooks `KU_APP_PREFERENCES[_AGENT]` are in docs/dev-fixtures.md.
An empty session file opens on a live composer: the first prompt sends `session/new` (cwd: `KURIER_CWD` → host cwd → `$HOME`), writes the record through the same `conversationRecord` as `kurier start`, and New chat is `win.new-chat` (`<Ctrl>n`). A stored session reattaches on the copy its record names (`agentSource`) unless `KU_APP_AGENT` pins one; hooks `KU_APP_NEW_CHAT`/`KU_APP_CWD` are in docs/dev-fixtures.md#first-run-and-new-chat. A bundled agent earns a one-time banner (`notices.json`), no agent at all an empty state naming the remedy; hooks in docs/dev-fixtures.md#the-bundled-agent-notice-and-the-no-agent-page.
With no `--agent` (CLI) or `KU_APP_AGENT` (GUI), every command and the window use that resolution; `resume` and `cancel`
use the agent the session recorded. A **bundled copy runs inside the sandbox** (`AgentCommand.bundled`;
`toHostCommand` leaves it alone, the host cannot see `/app/extra`) with its own `HOME` and `XDG_*` under
`<data dir>/agents/<id>/` (`isolation.ts`, 0700), because `--filesystem=host` puts the person's real
`~/.config/opencode` in reach and its login must not be shared; `kurier auth` logs in there too.
The two copies keep separate histories, so `kurier start` records `SessionRecord.agentSource`
(`host`|`bundled`; **absent = host**, the old records) and `resolveRecorded` resumes on that copy — a copy
that is gone is an error naming why, never a fall to the other. The window resolves with
`gatherResolveContext(env, false)`: no `--version` spawn, so it never waits on a child before it appears.

**One turn, not a REPL**, and that is a decision rather than a missing feature. A REPL needs
somewhere to put the approval surface, and the plan puts the surface in a later slice; a REPL now
would either prompt on a stdin that is also carrying the questions, or pretend the gate is not
there. `kurier start` with no prompt opens a session and stops, which is how you get an id for
`kurier resume`.

- **stdout is the answer, stderr is everything about it.** The agent's message goes to stdout so
  `kurier start "…"` pipes somewhere useful; progress, notices, tool questions, thought chunks and
  the agent's own log lines go to stderr. A model's private reasoning is never on stdout.
- **Ctrl-C is the protocol's cancellation, not a kill**: `session/cancel` goes out, the agent stops
  cleanly and answers the turn with `cancelled`, and the transcript ends where the work ended.
- **A piped or redirected stdin cannot ask, so it declines.** The terminal gate needs a person;
  without one the only honest answer is no. `--deny-all` forces that even on a terminal.
- Every option is read with `pickArgv`, which asks for both spellings. yargs exposes `--deny-all`
  as `denyAll` or `deny-all` depending on version, and a gate that silently stopped firing is the
  worst failure a flag whose whole job is stopping things can have.

## Privacy — this repo is PUBLIC

- The session file holds **the text of a person's conversations with an agent**. It lives at
  `$XDG_DATA_HOME/kurier/sessions.json`, mode `0600` in a `0700` directory, **never** inside the
  repository. `.gitignore` is the second line of defence; not writing there is the first, and it
  lives in `app/src/core/paths.ts`. Backup tier: `state` — declared in `.werkstatt-state.json`.
- There is **no `secret` tier, and adding one needs a reason.** kurier stores no credential:
  `kurier auth` runs the agent's own login with inherited stdio and keeps nothing. The agent's
  credentials live wherever the agent keeps them and kurier neither reads nor copies them. Do not
  put a token in a session record, in a launcher `env`, or in any file here — there is no file here
  with a safe place for it.
- Test fixtures are **synthetic only**. A real session id, a real prompt or a real model reply from
  a machine's history never goes into a test.
- The transcript is a *record of what happened*, not a re-derivation of it. The agent's own
  `session/load` is the authority on history; kurier's copy exists so `kurier sessions` can show
  something without spawning a process. Do not add filtering to it as "protection" — a filter with
  no gate behind it is a policy in the wrong place.

## The four guardrails

1. **A session is a scope, not a permission.** A stored or bound session may never be
   pre-authorized. It says what is *reachable*; every call inside it is checked again. A session
   with "may use Troedler" is a corridor, not a key — otherwise a group chat is a handed-around
   permission key. Derived from beifahrer [ADR 0006](../beifahrer/docs/adr/0006-recipes-are-data-run-as-ordinary-calls.md).
   `assertScopeIsNotAuthority` (`gate.ts`) is the runtime canary: it throws if a persisted record
   ever grows an `allow`/`permissions`/`grants`/`capabilities`/`policy` key, because a TypeScript
   type alone cannot stop a later `{ ...session, grants: [...] }` from type-checking.
2. **Fail closed on `request_permission`.** `denyAll` remains the default `PermissionGate`; the Adwaita
   surface passes its own, which asks a person and answers `cancelled` on every path where nobody chose
   — Escape, Stop, a closing window, an agent that died, a closed dialog. Never "auto-allow because the
   agent asked". **`allow_always`/`reject_always` are passed through**, not filtered: the **agent**
   remembers an "always" (ACP has no `allowed_always` — the answer is `selected` plus the agent's own
   option id, and it decides whether to ask again), while kurier stores no policy at all. What still
   holds is everything about *how* the choice is made: no allow option holds the focus in any frame, only
   `allow_once` is `SUGGESTED`, the terminal's `y` takes `allow_once` when both allows are offered *and
   says so on the prompt line*, and there is **no timeout** — a diff takes longer than any deadline
   kurier could pick.
3. **`fs/read_text_file` and `fs/write_text_file` are answered `false`** in the capability
   announcement, and answered a refusal error if an agent asks anyway. The agent gets no file
   access through that channel at all. File access is a decision, not a default — these two may be
   enabled later for a **canvas surface**, where kurier would hold the real buffer and hand it over
   deliberately rather than proxying a path the agent named.
4. **`_meta` is passed through, never parsed.** `opencode acp` sends
   `_meta: {"opencode/child-session-updates": true}` and a `sessionCapabilities.fork` marker the v1
   schema does not define. Unknown `_meta` must never be an error — otherwise every agent with an
   extension kurier doesn't know breaks.

Plus two more that are in the code, not just the plan: **no central capability registry** (not
even in gjsify — it would be exactly the gate beifahrer forbids, one level up and worse because it
looks neutral; manifest and policy stay in the app that holds the gate), and **MCP is passed
through, not known** (`newSession` forwards `mcpServers` to `session/new` as opaque objects and
never reads past `type`, so the project stays standalone-publishable and gets suite integration for
free).

## The two traps

**Trap 1 — `authMethods` is real and interactive.** Measured against `opencode acp` 2.0.19:

```json
"authMethods":[{"description":"Run `opencode auth login` in the terminal","name":"Login with opencode","id":"opencode-login"}]
```

No `type` tag, and a `description` the schema does not define. Without `kurier auth` the first
session dies on an error message instead of on code. `classifyAuthMethods` (`gate.ts`) reads this
as the protocol's *agent* auth method: it means the client has to arrange the login itself, which
is what `kurier auth` runs outside the ACP channel.

**Trap 2 — capability negotiation is uneven.** `loadSession`, `sessionCapabilities.{list,resume,
close,delete,fork}` — not every agent can do everything. **Check the capability, do not assume
it.** `AcpClient.reattach` tries `session/load` first (the default), falls back to `session/resume`,
and rejects with `UnsupportedCapabilityError` rather than a silent empty session if the agent
offers neither. Asking for a capability the agent never advertised is a hard error, always.

## The measured handshake

A real `initialize` against `opencode acp` runs completely inside one GJS process, with no Node
process anywhere in the chain:

```json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,
  "agentCapabilities":{"loadSession":true,
    "mcpCapabilities":{"http":true,"sse":false},
    "promptCapabilities":{"embeddedContext":true,"image":true},
    "sessionCapabilities":{"close":{},"delete":{},"fork":{},"list":{},"resume":{}}},
  "authMethods":[{"description":"Run `opencode auth login` in the terminal",
                  "name":"Login with opencode","id":"opencode-login"}],
  "agentInfo":{"name":"OpenCode","version":"2.0.19"}}}
```

## Run / build / test

```bash
gjsify install                                  # never npm install
gjsify foreach -A check                          # type-check everything
node scripts/check-schema.mjs                    # the code against refs/acp/schema.v1.json
gjsify workspace kurier-cli build                # → app/dist/kurier.gjs.mjs
gjsify workspace kurier-cli test                 # @gjsify/unit, on gjs AND node
gjsify workspace kurier-cli test:real-agent      # the real stdio chain against a real agent
gjsify run app/dist/kurier.gjs.mjs <command>
gjsify workspace kurier-cli build:app            # → app/dist/kurier-app.gjs.mjs (GTK, separate bundle)
```

**GTK behaviour setup:** [docs/dev-fixtures.md](docs/dev-fixtures.md#gtk-behaviour-moved-from-agentsmd) — GUI is looked at, not believed: start detached, dev tools, synthetic sessions.

### Watching a turn without a model

`scripts/stand-in-agent.mjs` is a real ACP peer over stdio — real framing, real method names, the
`fork` marker `opencode acp` sends and the v1 schema does not define — and `KU_APP_AGENT=stand-in`
selects it: it is reachable through the dev hooks and **not** in `LAUNCHERS`, which is the table of
programs a person installs.

**Every knob, every recipe and every measured GTK fact is in
[docs/dev-fixtures.md](docs/dev-fixtures.md)** — the stand-in's turn knobs, its three permission-option
knobs, the config row's four values and its two known limits, the per-session option cache, the failure
knobs (`KU_STANDIN_AUTH` / `KU_STANDIN_PROMPT_AUTH` / `KU_STANDIN_NO_RESUME` / `KU_STANDIN_USAGE`), and
[the two kinds of GTK probe](docs/dev-fixtures.md#probes) with the commands that print the numbers. Two
rules that change behaviour stay here:

- **`KU_STANDIN_CHUNKS` takes a prefix** of the stand-in's four fixed sentences, so its default is `4`
  and a value above it is the same four sentences. It is a knob for a *shorter* answer — a reply still
  arriving, where the newest bubble is below the fold — and the default was `5` against a list of four,
  which read as a knob that could grow and could not.
- **A hook set to `0` or `false` is off**, in kurier and in the stand-in alike, so there is one rule
  for "is this on" in the repo. The reading rules are in `frontends/gui/hook-value.ts`, not in
  `hooks.ts`: `readHooks` imports the framework's reader, whose barrel imports `Adw`, so a test that
  imported it could not run on Node at all — and the rules (unset, empty, `0` and `false` are off; a
  comma list keeps its order and drops its blanks) are the part a future key gets wrong. One rule, two
  copies: the stand-in agent has the same `flag()` and cannot import this file, so it is copied and
  both files say so.

### The states only a hook can reach

**Five pointer-only controls, and a hook for each** — `KU_APP_STOP`, `KU_APP_STOP_ESCAPE`,
`KU_APP_DISMISS_FAILURE`, `KU_APP_CHOOSE_MODEL`, `KU_APP_SWITCH=id[,id…]`, what each does and the
measurements that forced a hook rather than a pointer are in
[docs/dev-fixtures.md](docs/dev-fixtures.md#the-five-pointer-only-controls). What stays here is the rule
they all follow: every one goes **through the surface** (the composer's own `clicked`,
`dismissPermission('dismissed')`, the dialog's own `close()` and its own `response` signal, and `#open` —
the same call a sidebar row makes) rather than around it, so a screenshot is of the window and not of a
re-implementation.

**Three dialogs, and only three failures earn one.** Plan §6 asks for the auth trap and the reattach
refusal to be *shown*, and `core/failure.ts` is where that is decided: `failureKind` classifies an error
by its **type and the turn state** (`RpcError` -32000, `UnsupportedCapabilityError`,
`FailureContext.promptSent`), never by its wording; `failureNotice` returns a dialog for `auth`, `model`
and `unsupported` and **`null` for `start`** — a bad command or a handshake timeout is already the
composer's caption. No failure is written to the transcript: no turn ran, so nothing to record.

**`'auth'` and `'model'` are told apart structurally, because the wire cannot** ([issue
#2](https://github.com/JumpLink/kurier/issues/2), measured in
[docs/dev-fixtures.md](docs/dev-fixtures.md#ku_standin_prompt_auth1--the-same-error-code-a-different-kind)):
a **geo-blocked provider 403** reaches `session/prompt` as the login trap's own `-32000`, so matching the
message is one reword from wrong and matching the code is *already* wrong. What survives is whether a
prompt had gone out — `AgentSession.#promptSent`, as a **required** `FailureContext.promptSent`, so a new
call site cannot omit it and get the login-trap advice back. **A login that expires mid-turn lands here
too**, which is why the notice names *both* remedies in provider-neutral words. This path keeps the agent
(`agentStatus` reads `kind === 'model'` as attached) and the config row, whose model dropdown the one
button opens, and writes no transcript line — the agent answered, so `agentExitedEntry` would be one.

**The free-model hint is order, never a choice.** `app/data/free-models.json` (ids, the date checked, the
criterion, the [zen link](https://opencode.ai/docs/zen)) is applied by `freeModelFirst` to a **model**
control's values only, leaving the rest in the agent's order — the one named exception to "the agent's
order is the order it sent". It never selects, hides or guesses: exact ids, so a model that has gone stops
matching. Plan §3 rejected the alternatives: a default rots, probing burns quota.

**Once per failure, and never over a window that has moved on.** Two more functions in the same file
answer the two questions a surface asks on every state move, and both are needed: `failureToShow` is
`null` for a failure **this window has already shown** — compared by the attachment's *identity*, not
by "is a dialog up right now", because a dismissed dialog closes itself and `attachment` stays `failed`
until the next attach, so a dialog up/down guard re-opens it on the next emit — and `staleDialog` is
`true` for anything that is not the failure that was shown, so an attached agent or another session
takes a modal down rather than leaving it swallowing the close button. Identity rather than a "have I
ever shown one" flag, because `AgentSession` builds a **new** attachment per failure and a genuine
second failure has to be shown.

**Two refusals, two buttons.** `auth` offers **Log in…** (opencode only, `core/login/`, [docs/login.md](docs/login.md)): the
agent's own browser login or an API key (kept by the agent) through a private `opencode serve`, `LoginController` (no widget) under `login-dialog.ts`; kurier
stores no credential, and `restartAgent()` makes the next prompt read the new one. Without that login (another agent,
a host opencode in a Flatpak) the dialog names `kurier auth`. `'model'`/`'quota'` offer **Choose another model**: it
opens the row's dropdown and picks nothing, and `failureAction` withholds either button when the window cannot do it.

**The permission dialog, in two halves.** `KU_STANDIN_PERMISSION=1` is the *agent's* own mid-turn
`session/request_permission`, carried over the real stdio chain, with **all four option kinds on the
wire** — so a screenshot shows kurier's ordering, labels, styling and focus rules acting on the full
set the agent offered, `*_always` included. `KU_APP_PERMISSION=1` is kurier's side: it puts a fixture
request through **the same gate** the agent's requests go through, so a screenshot shows the gate's
behaviour rather than a dialog built for the screenshot. It is a fallback, not a competitor, and it
waits by polling for the gate to be asked rather than for a fixed delay (`window.ts`) — a fixed delay
would either beat the agent's question or lose to it. The dialog's behaviour, the two halves and the
measured GTK facts behind it are in
[docs/dev-fixtures.md](docs/dev-fixtures.md#the-permission-dialog); what it does and does not do is
decided in `app/src/core/permission.ts` and tested on both runtimes, while the widget only renders.

**Kurier owns the button order** (`orderOptions`): the rank, the three orders it produces and the two
measured GTK facts that fix them are in [docs/dev-fixtures.md](docs/dev-fixtures.md#gtk-behaviour-moved-from-agentsmd).
The rules that survive here: the first added button is the bottom one and the last added is the topmost,
so **both end slots are a decline**; `buildDialog` names `default_response` explicitly rather than letting
the add order choose it; and `show()` grabs the focus.

**The button labels** are kurier's four short sentences; the agent's own names are not on them
(captions moved to the body as `agentNames` in [docs/dev-fixtures.md](docs/dev-fixtures.md#gtk-behaviour-moved-from-agentsmd)). A button label must fit one line.

The phone floor is 360 px (`WINDOW_MIN_WIDTH_PX` in `constants.ts`), and it is the width
`Adw.NavigationSplitView` stops at on its own — not a preference. Narrower than that the window is
unusable. [docs/dev-fixtures.md](docs/dev-fixtures.md#gtk-behaviour-moved-from-agentsmd) has the
reproduction sweep and the cost to the config row.

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

> **A green `gjsify test` meant "the last build is green", not "the source is green" — on every gjsify
> before 0.53.0.** Measured here: editing `packages/session/src/model.ts` and re-running left
> `app/dist/test.*.mjs` untouched (mtime unchanged) and printed **136 tests passed** for code that no
> longer existed. Touching the entry, `app/tests/test.mts`, forced the rebuild. The cause was scope,
> not staleness arithmetic: `packageBuildInputs` walks the package directory, and a workspace sibling
> is reached only through a `node_modules` symlink pointing **outside** it. CI never saw it — a fresh
> container has no `dist/`, so it always built, which is why the trap survived the whole 0.5x series
> and then needed an `rm -rf` here after every source edit.
>
> **0.53.0 carries the fix** (gjsify [#1896](https://github.com/gjsify/gjsify/pull/1896),
> [#1905](https://github.com/gjsify/gjsify/issues/1905)): the build records what it actually READ into
> `<outfile>.inputs.json` beside the bundle, from the bundler's own module graph. Re-verified here on
> the release rather than on a checkout — `app/dist/test.gjs.mjs.inputs.json` lists
> `packages/acp/src/*.ts` and `packages/session/src/*.ts` by exact path, and appending a line to
> `packages/session/src/model.ts` moved the bundle's mtime with no `rm -rf`. **The failure mode is a
> green run, which is the one thing a test suite cannot report about itself**, so that measurement is
> worth repeating whenever the toolchain moves; treat a suspiciously fast green as this, not as a win.
>
> **The same family, one level over: a regression test that passes on the code it was meant to fix.**
> A test that cannot fail without its fix is decoration, not a guard — and the most expensive green,
> because it reads as one. **Run a fix's new test against the unfixed code first**; the failure is the
> only evidence it is testing. Worked example, and the test shape that exposed it:
> [the 2026-09-30 review](docs/reviews/2026-09-30-code-review-findings.md).
>
> One trap survives, and it is the same family: **the `gjsify` on `PATH` is the one that decides.** A
> global install in `~/.local/share/gjsify/global/` wins over this repo's `node_modules/.bin/gjsify`,
> so a run that looks like it used the pinned toolchain was a released CLI — and it happily reports a
> test result for a bundle from an earlier run. `./node_modules/.bin/gjsify …` whenever the version
> matters, which under the freshness rule means always.

`refs/acp/schema.v1.json` is the normative artifact `packages/acp`'s types are written against,
refreshed by `./scripts/update-acp-schema`. `scripts/check-schema.mjs` fails the build when the
code and the schema disagree about a method name or a required field — read the diff before
committing a refresh; a refresh that only changes the JSON is a sign the schema was copied but not
read (see [refs/acp/SOURCE.md](refs/acp/SOURCE.md)).

## Packaging

**The `gjsify.flatpak` block in `package.json` is the source of truth** — the desktop entry, the
AppStream metainfo, the manifest and `flathub.json` are all generated from it, so hand-editing
`data/*` is lost on the next run:

```bash
./node_modules/.bin/gjsify flatpak init --force --no-format \
  --manifest eu.jumplink.Kurier.json \
  --metainfo data/eu.jumplink.Kurier.metainfo.xml \
  --desktop data/eu.jumplink.Kurier.desktop \
  --flathub-json flathub.json
npm run packaging:validate   # THE gate: desktop-file-validate + appstreamcli validate --no-net
npm run packaging:install    # the four files into $XDG_DATA_HOME (or DESTDIR/PREFIX)
```

`flatpak-builder --show-manifest` only *prints* the manifest — it parses, it does not validate, so
a green run of it says nothing. The two real validators are `desktop-file-validate` and
`appstreamcli validate`, wired into `packaging:validate` because easy6502 gates its `meson test`
the same way. `packaging:install` installs metadata only: `bin/kurier-app` is produced by
`gjsify ship`, not by this script.

**Three finish-args are not free.** `--talk-name=org.freedesktop.Flatpak` is the only way a Flatpak can
reach `flatpak-spawn --host`, and `--filesystem=host` is what that then needs — without them kurier
cannot start the agent it exists to start, and with them the sandbox is close to decorative: treat
this manifest as *an installer*, not as isolation, and say so to any Flathub reviewer.
`--share=network` is for the bundled agent, which runs inside the sandbox (data/README.md).

`app/src/core/agents/sandbox.ts` is what crosses the boundary, and it is a **no-op outside a Flatpak**:
it rewrites an `AgentCommand` into `flatpak-spawn --host …`, and outside a sandbox it returns the very
same object. Four things about it are measured rather than assumed, and each has a test:

- **Detection is `/.flatpak-info` alone, not `FLATPAK_ID`.** A terminal, editor or IDE installed *as a
  Flatpak* sets `FLATPAK_ID` in an otherwise host environment; treating that as sandboxed would route
  its agents through `flatpak-spawn --host` and lose the PATH it already had.
- **The agent's PATH comes from the host's own shell config.** `flatpak-spawn --host` passes the
  *session bus* PATH, which on this machine does not contain `~/.opencode/bin` at all, so the agent is
  run through the host's login shell with `~/.zshrc`/`~/.bashrc` read first. A login shell ALONE is not
  enough — `-l` does not read `~/.zshrc` — and neither is sourcing it from `/bin/sh`, because `~/.zshrc`
  is zsh syntax that dash cannot parse. The bash limit is real and named: a `[ -t 0 ]` guard in
  `.bashrc` returns early with no terminal, and the answer stays "not installed" rather than a guess.
- **The protocol pipes are fenced off.** A login shell reads several files before the agent starts and
  any of them may print (a banner lands in the JSON-RPC stream) or `read` from stdin (an `ssh-add`
  prompt swallows `initialize` and the handshake hangs with no error). The wrapper parks the pipes on
  fds 3/4 and points the inherited ones at `/dev/null`/stderr, and the inner script hands them back
  before the agent starts.
- **Ending the agent is not a signal to the agent.** The pid kurier holds is the sandbox-side
  `flatpak-spawn`; the agent is under `flatpak-session-helper` on the other side of the bus. SIGTERM
  *is* forwarded (measured: Stop and `flatpak kill` leave no `opencode acp`), SIGKILL cannot be and
  would orphan the host process — which is what `killGraceMs` is for.

Full details, including the placeholder icons and the build inputs: [data/README.md](data/README.md).

## The project rule that came out of a mismeasurement

> **In a gjsify project you import `node:child_process` — not `@gjsify/child_process`.**

Measuring the GJS chain failed twice: under Node `ERR_UNSUPPORTED_ESM_URL_SCHEME: gi:`, under GJS
`Module not found`. Both were the same error — the **package** specifier instead of the **module**
specifier. The bundler is the resolution path: `gjsify build` → `gjsify run` is the chain. **Not a
gjsify bug**: `@gjsify/child_process` carries `runtimes.node: "none"` because there would be
nothing to port under Node, and `test.node.mjs` (48 KB) is a parity suite against the real
`node:child_process`, not a Node port.

## Conventions

- `gjsify install` — never `npm install`, it prunes gjsify deps.
- All `@gjsify/*` packages pinned to the **same exact version** (0.54.0 here). gjsify ships as one
  release train; a CLI ↔ libs skew produces silently broken bundles. One is absent: `@gjsify/napi`,
  which nothing in kurier imports — its rewrite only fires for a compiled `.node` addon inside a
  bundle, and every addon in this tree is build-time tooling that runs under Node. It was also
  unpublishable through 0.53.0 (`packages/napi/**` is not a workspace member — its release leg builds
  a meson prebuild per platform first, and the 0.53.0 tarball never landed); 0.54.0 publishes it
  again, so the pin can come back if a build ever does carry an addon.
- `gjsify foreach -A check` (the `-A` includes `private: true` workspaces), `gjsify workspace
  <name> <script>` for one — **no `run` keyword**.
- **`./node_modules/.bin/gjsify`, not the `gjsify` on `PATH`**, whenever the toolchain version
  matters. The global install wins, and a run that looks linked is then a released CLI.
- `typescript` pinned `^6.0.3`, **not** 7: `gjsify tsc` runs a bundle with 6.0.3 baked in,
  regardless of what is installed locally.
- Conventional commits (`feat(acp): …`, `fix(session): …`), imperative, subject ≤ 50 chars.
- This repo is a submodule of werkstatt: commit here first, then bump the pointer in the parent.
  NEVER stage across that boundary in one commit.

## What is deliberately not here yet

A web surface (the Adwaita one is in `app/src/frontends/gui/`, being built slice by slice; **not**
adwaita-web, which is the browser path per beifahrer ADR 0008) · Telegram bot · MCP wiring against
the real apps · principal policy · troedler integration · a Claude Code adapter (decided,
not built; terms and billing: [docs/claude-code.md](docs/claude-code.md)).
