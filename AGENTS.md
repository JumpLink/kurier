# AGENTS.md — kurier

Operating guide for AI agents in the **kurier** repo. Follows the [agents.md](https://agents.md/)
convention; the human overview is [README.md](README.md). This repo is a submodule of
**werkstatt**, whose [AGENTS.md](../../AGENTS.md) carries the broader workspace rules — this file
is the lotse-specific layer and wins where they differ.

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
| `@lotse/acp` | **Pure.** The ACP wire types against `refs/acp/schema.v1.json`, the JSON-RPC codec (`jsonrpc.ts`), the `Transport` seam (`transport.ts`), the client session lifecycle (`client.ts`), the gate that answers what an agent may ask of a client (`gate.ts`) | nothing |
| `@lotse/session` | The model (`SessionRecord`, transcript, resume binding, principal, scope) and a JSON file store | `@lotse/acp`, `node:fs` — no `gi://`, no agent adapter |
| `@lotse/core` | Everything decision-shaped that is not a surface: the agents (`agents/*`, with `data/bundled-agents.json`), the session controller (`agent-session.ts`), one turn (`run.ts`, `turn.ts`), the login (`auth.ts`, `login/*`), the failure classification (`failure.ts`) and the view-model files the widget will need | `@lotse/acp`, `@lotse/session`, `node:*` — no `gi://`, no yargs, no widget |
| `@lotse/widget` | **The chat surface, as a widget.** `LotseChat` (`chat.ts` + `chat.blp`) — one conversation: transcript (`transcript-view.ts`, `tool-line.ts`), composer (`composer.ts`, `config-row.ts`), the approval dialog (`permission-dialog.ts` + `permission-body.blp`), the failure and login dialogs, self-installed CSS | `@lotse/core`, `@lotse/session`, `gi://` (GTK 4, Adw 1) — no app, no decisions of its own |
| `lotse-cli` (`app/`) | yargs CLI, the terminal permission gate, the XDG path resolver, the settings and notices files, and the Adwaita shell in `src/frontends/gui/` (its own bundle) around one `LotseChat` | all of the above; `gi://` only under `frontends/gui/` |

**`packages/acp` does not know that subprocesses exist.** No `spawn`, no `node:child_process`, no
`gi://`, no dependencies at all — the transport is an injected interface (`Transport` in
`transport.ts`). That is postbote's `store`-knows-no-backend rule one layer up, and it is what lets
the same protocol code run as the Node unit test and the GJS integration test.

**There are two directories called core, and the difference is the whole point.** `packages/core/src` is
LGPL and holds what a *host* would need; `app/src/core` is AGPL and holds what is true of **this** app
only — the XDG resolver (`paths.ts`), the settings file (`settings.ts`, `settings-view.ts`), the notices
file (`notices.ts`), `session-groups.ts`, `private-file.ts`. Three of those are split on purpose: the
`LotsePaths` shape, `AgentChoice`/`describeChoice` and `NOTICE_IDS`/`noticeDue` are decisions and live in
the package, while reading and writing one app's file stays here. Before adding to `app/src/core`, ask
whether a host would want it; if yes it belongs one level down. [ADR
0001](docs/adr/0001-lotse-as-an-embeddable-widget.md) records what stayed and why.

**The app imports `@lotse/core`, never a file inside it** — and the same for `@lotse/widget`. Each
package's `src/index.ts` is a deliberate barrel, so what is public is a decision somebody made rather than
whatever a consumer reached for; a new export is one line there. The widget also exports `./tool-line` and
`./permission-dialog`, both **for measurements, not for hosts** (a Node-capable unit test, the focus probe).
The unit tests live in `app/tests/unit/` and import the barrels like any other consumer — one runner
(`app/tests/test.mts`) is what keeps the dual GJS + Node run working.

**`app/src/frontends/gui/` is the shell around one `LotseChat`.** Window, sidebar, menu, Preferences and
the `LOTSE_APP_*` hooks are this app's; the transcript, composer, dialogs and chat states are the widget's,
reached only through its getters and methods. The two idle pages are built in `window.blp` and handed in as
`closedPage`/`noAgentPage` — their copy belongs to whatever surrounds a chat. **No named imports from a
`.blp`, anywhere**: [docs/toolchain-traps.md](docs/toolchain-traps.md#named-imports-from-a-blp).

`@lotse/session`'s store takes a path and never decides one: the app resolves `$XDG_DATA_HOME` once into a
`LotsePaths` (`app/src/core/paths.ts`, passed to the commands and the window; `lotsePathsUnder(root)`
from `@lotse/core` for a host), a test passes a temp dir.

## The CLI

```bash
lotse start [prompt..] --agent opencode   # new session, one prompt turn
lotse sessions [--all] [--long]           # kurier's own records, one principal
lotse resume <id> [prompt..]              # reattach, then optionally one turn
lotse cancel <id>                         # session/cancel
lotse auth [--agent opencode]             # trap 1's way out
lotse login [provider] [--method id]       # login, no terminal (docs/login.md)
lotse agents                              # launchers, SOURCE, what lotse would use
```

**Host before bundled, and the bundled copy is off PATH.** A Flatpak build unpacks the agents in
`packages/core/data/bundled-agents.json` under `BUNDLED_PREFIX` (`agents/catalog.ts` there, the one place the
prefix is written), never `/app/bin` — there it would shadow the person's own opencode, which carries
their login. The prefix is `/app/extra/agents`, not `/app/libexec`: the archive is Flatpak `extra-data`,
fetched at *install* time, and `apply_extra` can write only `/app/extra` (data/README.md).
`detectAgents` ignores a host hit under the prefix; `resolveAgent` takes the setting, else the first
host install, else the first bundled copy (`agents/detect.ts`, pure over facts gathered by
`probe.ts`). The catalog's `env` is flags only, never a credential.
The person's choice (`{id, source}`, so "bundled opencode" ≠ "my opencode") is `app/src/core/settings.ts`, in
`$XDG_CONFIG_HOME/kurier/settings.json` (`KURIER_SETTINGS_FILE`), 0600/0700, an allowlist that accepts no secret;
precedence is `--agent` (CLI) / `LOTSE_APP_AGENT` (GUI dev hook) > setting > host > bundled, and a setting that names something
unavailable is reported (`note`), never skipped silently; a corrupt file falls back to defaults and says so.
`lotse agents --use <id>[:bundled|host]|none` writes it.
The GUI writes it from Preferences (`<Ctrl>comma`); a change applies the next time kurier starts, and a settings file kurier could not read is never destroyed by a save (`saveDecision`). The dialog's rows, its Flatpak async path and the hooks `LOTSE_APP_PREFERENCES[_AGENT]`: docs/dev-fixtures.md#the-preferences-dialog.
An empty session file opens on a live composer: the first prompt sends `session/new` (cwd: `KURIER_CWD` → host cwd → `$HOME`), writes the record through the same `conversationRecord` as `lotse start`, and New chat is `win.new-chat` (`<Ctrl>n`). A stored session reattaches on the copy its record names (`agentSource`) unless `LOTSE_APP_AGENT` pins one; hooks `LOTSE_APP_NEW_CHAT`/`LOTSE_APP_CWD` are in docs/dev-fixtures.md#first-run-and-new-chat. A bundled agent earns a one-time banner (`notices.json`), no agent at all an empty state naming the remedy; hooks in docs/dev-fixtures.md#the-bundled-agent-notice-and-the-no-agent-page.
With no `--agent` (CLI) or `LOTSE_APP_AGENT` (GUI), every command and the window use that resolution; `resume` and `cancel`
use the agent the session recorded. A **bundled copy runs inside the sandbox** (`AgentCommand.bundled`;
`toHostCommand` leaves it alone, the host cannot see `/app/extra`) with its own `HOME` and `XDG_*` under
`<data dir>/agents/<id>/` (`isolation.ts`, 0700), because `--filesystem=host` puts the person's real
`~/.config/opencode` in reach and its login must not be shared; `lotse auth` logs in there too.
The two copies keep separate histories, so `lotse start` records `SessionRecord.agentSource`
(`host`|`bundled`; **absent = host**, the old records) and `resolveRecorded` resumes on that copy — a copy
that is gone is an error naming why, never a fall to the other. The window resolves with
`gatherResolveContext(paths, false)`: no `--version` spawn, so it never waits on a child before it appears.

**One turn, not a REPL**, and that is a decision rather than a missing feature. A REPL needs
somewhere to put the approval surface, and the plan puts the surface in a later slice; a REPL now
would either prompt on a stdin that is also carrying the questions, or pretend the gate is not
there. `lotse start` with no prompt opens a session and stops, which is how you get an id for
`lotse resume`.

- **stdout is the answer, stderr is everything about it.** The agent's message goes to stdout so
  `lotse start "…"` pipes somewhere useful; progress, notices, tool questions, thought chunks and
  the agent's own log lines go to stderr. A model's private reasoning is never on stdout.
- **Ctrl-C is the protocol's cancellation, not a kill**: `session/cancel` goes out, the agent stops
  cleanly and answers the turn with `cancelled`, and the transcript ends where the work ended.
- **A piped or redirected stdin cannot ask, so it declines.** The terminal gate needs a person;
  without one the only honest answer is no. `--deny-all` forces that even on a terminal.
- Every option is read with `pickArgv`, which asks for both spellings. yargs exposes `--deny-all`
  as `denyAll` or `deny-all` depending on version, and a gate that silently stopped firing is the
  worst failure a flag whose whole job is stopping things can have.

## Licence

Apps (`app/`, the repo root) are AGPL-3.0-or-later; the reusable packages under `packages/*` are
LGPL-3.0-or-later (own `LICENSE` + `COPYING`). A LGPL package never depends on an AGPL one; new
packages under `packages/*` follow the same split. No SPDX headers in sources.

## Privacy — this repo is PUBLIC

- The session file holds **the text of a person's conversations with an agent**. It lives at
  `$XDG_DATA_HOME/kurier/sessions.json`, mode `0600` in a `0700` directory, **never** inside the
  repository. `.gitignore` is the second line of defence; not writing there is the first, and it
  lives in `app/src/core/paths.ts`. Backup tier: `state` — declared in `.werkstatt-state.json`.
- There is **no `secret` tier, and adding one needs a reason.** kurier stores no credential:
  `lotse auth` runs the agent's own login. The agent keeps its credentials and kurier never reads them
  back; a pasted API key (`lotse login`, login dialog) is held in memory for one call, never written. Do not
  put a token in a session record, in a launcher `env`, or in any file here — there is no file here
  with a safe place for it.
- Test fixtures are **synthetic only**. A real session id, a real prompt or a real model reply from
  a machine's history never goes into a test.
- The transcript is a *record of what happened*, not a re-derivation of it. The agent's own
  `session/load` is the authority on history; kurier's copy exists so `lotse sessions` can show
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
   kurier could pick. **`lotse serve` amends this** ([ADR 0002](docs/adr/0002-assistant-in-continuous-operation.md)):
   its gate answers `allow_once` only for a question the person answered yes or an area the person
   released in the task configuration, and that policy only narrows what the owning app allows. It
   strips every `*_always` option and never selects one; a yes mints one single-use token bound to
   session, tool and a digest of the call arguments; a question expires to `cancelled`. Guardrail 1
   stands: a session record never holds a grant.
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

**Trap 1 — `authMethods` is real and interactive.** Measured against `opencode acp` 2.0.19 (the
`authMethods` entry is in the handshake below): no `type` tag, and a `description` the schema does not
define. Without `lotse auth` the first
session dies on an error message instead of on code. `classifyAuthMethods` (`gate.ts`) reads this
as the protocol's *agent* auth method: it means the client has to arrange the login itself, which
is what `lotse auth` runs outside the ACP channel.

**What to do about it is decided once, in `@lotse/core`'s `auth.ts`** — `authPlan` (which of the two
paths the methods allow), `describeAuthMethods` (the handshake notice), `loginCommandFor` (the program,
the bundled copy's own) and `arrangeAuth` (ask the agent, run the login, **ask it again** — the second
handshake is the agent's own yes rather than an exit code read as one). A surface passes in only what
genuinely differs: `runLogin`, which the CLI runs with inherited stdio because a login that opens a
browser cannot open one from a pipe, and `open` for a test. It lived in `frontends/cli/auth.ts` once,
which is why the window had no way to log anyone in.

**Trap 2 — capability negotiation is uneven.** `loadSession`, `sessionCapabilities.{list,resume,
close,delete,fork}` — not every agent can do everything. **Check the capability, do not assume
it.** `AcpClient.reattach` tries `session/load` first (the default), falls back to `session/resume`,
and rejects with `UnsupportedCapabilityError` rather than a silent empty session if the agent
offers neither. Asking for a capability the agent never advertised is a hard error, always.

**What a real agent answers** — the verbatim `initialize` result of `opencode acp` 2.0.19, measured
inside one GJS process with no Node in the chain — is in
[refs/acp/SOURCE.md](refs/acp/SOURCE.md#what-one-real-agent-answers), beside the schema.

## Run / build / test

```bash
gjsify install                                  # never npm install
gjsify foreach -A check                          # type-check everything
node scripts/check-schema.mjs                    # the code against refs/acp/schema.v1.json
gjsify workspace lotse-cli build                # → app/dist/lotse.gjs.mjs
gjsify workspace lotse-cli test                 # @gjsify/unit, on gjs AND node
gjsify workspace lotse-cli test:real-agent      # the real stdio chain against a real agent
gjsify run app/dist/lotse.gjs.mjs <command>
gjsify workspace lotse-cli build:app            # → app/dist/lotse-app.gjs.mjs (GTK, separate bundle)
```

**GTK behaviour setup:** [docs/dev-fixtures.md](docs/dev-fixtures.md#gtk-behaviour-moved-from-agentsmd) — GUI is looked at, not believed: start detached, dev tools, synthetic sessions.

### Watching a turn without a model

`scripts/stand-in-agent.mjs` is a real ACP peer over stdio — real framing, real method names, the
`fork` marker `opencode acp` sends and the v1 schema does not define — and `LOTSE_APP_AGENT=stand-in`
selects it: it is reachable through the dev hooks and **not** in `LAUNCHERS`, which is the table of
programs a person installs.

**Every knob, every recipe and every measured GTK fact is in
[docs/dev-fixtures.md](docs/dev-fixtures.md)** — the stand-in's turn knobs, its three permission-option
knobs, the config row's four values and its two known limits, the per-session option cache, the failure
knobs (`LOTSE_STANDIN_AUTH` / `LOTSE_STANDIN_PROMPT_AUTH` / `LOTSE_STANDIN_NO_RESUME` / `LOTSE_STANDIN_USAGE`), and
[the two kinds of GTK probe](docs/dev-fixtures.md#probes) with the commands that print the numbers. Two
rules that change behaviour stay here:

- **`LOTSE_STANDIN_CHUNKS` takes a prefix** of the stand-in's four fixed sentences, so its default is `4`
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

**Five pointer-only controls, and a hook for each** — `LOTSE_APP_STOP`, `LOTSE_APP_STOP_ESCAPE`,
`LOTSE_APP_DISMISS_FAILURE`, `LOTSE_APP_CHOOSE_MODEL`, `LOTSE_APP_SWITCH=id[,id…]`, what each does and the
measurements that forced a hook rather than a pointer are in
[docs/dev-fixtures.md](docs/dev-fixtures.md#the-five-pointer-only-controls). What stays here is the rule
they all follow: every one goes **through the surface** (the composer's own `clicked`,
`dismissPermission('dismissed')`, the dialog's own `close()` and its own `response` signal, and `#open` —
the same call a sidebar row makes) rather than around it, so a screenshot is of the window and not of a
re-implementation.

**Three dialogs, and only three failures earn one.** Plan §6 asks for the auth trap and the reattach
refusal to be *shown*, and `@lotse/core`'s `failure.ts` is where that is decided: `failureKind` classifies an error
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

**The free-model hint is order, never a choice.** `packages/core/data/free-models.json` (ids, the date checked, the
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

**Two refusals, two buttons.** `auth` offers **Log in…** (opencode only, `@lotse/core`'s `login/`, [docs/login.md](docs/login.md)): the
agent's own browser login or an API key (kept by the agent) through a private `opencode serve`, `LoginController` (no widget) under `login-dialog.ts`; kurier
stores no credential, and `restartAgent()` makes the next prompt read the new one. Without that login (another agent,
a host opencode in a Flatpak) the dialog names `lotse auth`. `'model'`/`'quota'` offer **Choose another model**: it
opens the row's dropdown and picks nothing, and `failureAction` withholds either button when the window cannot do it.

**The permission dialog, in two halves.** `LOTSE_STANDIN_PERMISSION=1` is the *agent's* own mid-turn
`session/request_permission`, carried over the real stdio chain, with **all four option kinds on the
wire** — so a screenshot shows kurier's ordering, labels, styling and focus rules acting on the full
set the agent offered, `*_always` included. `LOTSE_APP_PERMISSION=1` is kurier's side: it puts a fixture
request through **the same gate** the agent's requests go through, so a screenshot shows the gate's
behaviour rather than a dialog built for the screenshot. It is a fallback, not a competitor, and it
waits by polling for the gate to be asked rather than for a fixed delay (`window.ts`) — a fixed delay
would either beat the agent's question or lose to it. The dialog's behaviour, the two halves and the
measured GTK facts behind it are in
[docs/dev-fixtures.md](docs/dev-fixtures.md#the-permission-dialog); what it does and does not do is
decided in `packages/core/src/permission.ts` and tested on both runtimes, while the widget only renders.

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
  (`lotse-cli test:real-agent`).

If a change makes the Node run impossible, the change is in the wrong file — that dual run is the
entire point of the `packages/acp` ↔ `app` split.

**Freshness: a green run can be the wrong bundle.** Before gjsify 0.53.0 a green `gjsify test` tested
the last build, not the source; 0.53.0 fixed it with `<outfile>.inputs.json`, and the measurement is
worth repeating whenever the toolchain moves — treat a suspiciously fast green as this, not as a win.
**Run a fix's new test against the unfixed code first**: a test that cannot fail without its fix is
decoration. And **the `gjsify` on `PATH` decides**: a global install wins over
`node_modules/.bin/gjsify`. The incidents: [docs/toolchain-traps.md](docs/toolchain-traps.md).

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
npm run packaging:validate   # THE gate: desktop-file-validate + appstreamcli validate --no-net
npm run packaging:install    # the four files into $XDG_DATA_HOME (or DESTDIR/PREFIX)
```

The `gjsify flatpak init` invocation that regenerates them:
[data/README.md](data/README.md#regenerating-the-four-files).

`flatpak-builder --show-manifest` only *prints* the manifest — it parses, it does not validate, so
a green run of it says nothing. The two real validators are `desktop-file-validate` and
`appstreamcli validate`, wired into `packaging:validate` because easy6502 gates its `meson test`
the same way. `packaging:install` installs metadata only: `bin/lotse-app` is produced by
`gjsify ship`, not by this script.

**Three finish-args are not free.** `--talk-name=org.freedesktop.Flatpak` is the only way a Flatpak can
reach `flatpak-spawn --host`, and `--filesystem=host` is what that then needs — without them kurier
cannot start the agent it exists to start, and with them the sandbox is close to decorative: treat
this manifest as *an installer*, not as isolation, and say so to any Flathub reviewer.
`--share=network` is for the bundled agent, which runs inside the sandbox (data/README.md).

`packages/core/src/agents/sandbox.ts` is what crosses the boundary, and it is a **no-op outside a Flatpak**:
it rewrites an `AgentCommand` into `flatpak-spawn --host …`, and outside a sandbox it returns the very
same object. **Four things about it are measured rather than assumed, each with a test, and each one
bites a different way** — `/.flatpak-info` and not `FLATPAK_ID` decides whether to rewrite at all; the
agent's PATH comes from the person's own `~/.zshrc`/`~/.bashrc` because the session bus PATH does not
have it; the protocol pipes are parked on fds 3/4 so a shell banner cannot land in the JSON-RPC stream;
and ending the agent is SIGTERM to a `flatpak-spawn` that forwards it, never SIGKILL, which is what
`killGraceMs` is for. The measurements and the known limits are in
[data/README.md](data/README.md#what-it-does-to-start-the-agent-and-what-it-cannot-do) — read them
before changing `sandbox.ts`.

Full details, including the placeholder icons and the build inputs: [data/README.md](data/README.md).

## The project rule that came out of a mismeasurement

> **In a gjsify project you import `node:child_process` — not `@gjsify/child_process`.**

Not a gjsify bug: the package specifier bypasses the bundler's resolution. The two failures that
looked like two bugs: [docs/toolchain-traps.md](docs/toolchain-traps.md#nodechild_process-not-gjsifychild_process).

## Conventions

- `gjsify install` — never `npm install`, it prunes gjsify deps.
- All `@gjsify/*` packages pinned to the **same exact version** (0.54.0 here). gjsify ships as one
  release train; a CLI ↔ libs skew produces silently broken bundles. `@gjsify/napi` is absent on
  purpose: [docs/toolchain-traps.md](docs/toolchain-traps.md#why-gjsifynapi-is-not-pinned).
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

A web surface (**not** adwaita-web, which is the browser path per beifahrer ADR 0008) · Telegram bot (becomes a Curlew
backend) · `lotse serve`, MCP wiring against the real apps and the principal policy (decided in
[ADR 0002](docs/adr/0002-assistant-in-continuous-operation.md), not built) · troedler integration ·
a Claude Code adapter (decided, not built; terms and billing: [docs/claude-code.md](docs/claude-code.md)).
