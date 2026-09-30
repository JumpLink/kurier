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
| `kurier-cli` (`app/`) | yargs CLI, the stdio child-process adapters, the agent launcher table, the terminal permission gate, XDG paths | all of the above |

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
kurier agents                              # launchers, and whether the binary is on PATH
```

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
2. **Fail closed on `request_permission`.** `denyAll` is the default `PermissionGate`. Never
   "auto-allow because the agent asked".
3. **`fs/read_text_file` and `fs/write_text_file` are answered `false`** in the capability
   announcement, and answered a refusal error if an agent asks anyway. The agent gets no file
   access through that channel at all. File access is a decision, not a default.
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
```

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

> **`gjsify test` reuses `app/dist/test.*.mjs` when the entry file looks unchanged — and its
> staleness check misses workspace sources behind a symlink.** Measured here: editing
> `packages/session/src/model.ts` and re-running left the bundle untouched (mtime unchanged) and
> printed **136 tests passed** for code that no longer existed. Touching `app/tests/test.mts`, the
> entry, forced the rebuild and the change appeared.
>
> So a green run here means "the last build is green", not "the source is green". **After editing
> anything outside `app/tests/`, `rm -rf app/dist` before you trust a test result.** This is the
> worst kind of failure — a silent green — and it is not kurier's bug: the runner belongs to
> gjsify, and the fix belongs there.

`refs/acp/schema.v1.json` is the normative artifact `packages/acp`'s types are written against,
refreshed by `./scripts/update-acp-schema`. `scripts/check-schema.mjs` fails the build when the
code and the schema disagree about a method name or a required field — read the diff before
committing a refresh; a refresh that only changes the JSON is a sign the schema was copied but not
read (see [refs/acp/SOURCE.md](refs/acp/SOURCE.md)).

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
- All `@gjsify/*` packages pinned to the **same exact version** (0.49.0 here). gjsify ships as one
  release train; a CLI ↔ libs skew produces silently broken bundles.
- `gjsify foreach -A check` (the `-A` includes `private: true` workspaces), `gjsify workspace
  <name> <script>` for one — **no `run` keyword**.
- **After editing a workspace source, `rm -rf app/dist` before trusting a test result** — see the
  `gjsify test` staleness note above. This is the single most dangerous moment in the workflow,
  because the failure mode is a green run.
- `typescript` pinned `^6.0.3`, **not** 7: `gjsify tsc` runs a bundle with 6.0.3 baked in,
  regardless of what is installed locally.
- Conventional commits (`feat(acp): …`, `fix(session): …`), imperative, subject ≤ 50 chars.
- This repo is a submodule of werkstatt: commit here first, then bump the pointer in the parent.
  NEVER stage across that boundary in one commit.

## What is deliberately not here yet

Surface (comes later on `@gjsify/adwaita-app`, real GTK4/libadwaita — **not** adwaita-web, which is
the browser path per beifahrer ADR 0008) · Telegram bot · MCP wiring against the real apps ·
principal policy · troedler integration · a Claude adapter (parked on a non-technical question:
per `docs/concepts/ai-document-workflow.md` the Claude Agent SDK has drawn its own monthly quota
since 2026-06-15, separate from the interactive subscription — verify before building against it,
never assume).
