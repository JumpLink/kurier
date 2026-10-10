# 3. `lotse serve`: tasks, questions and the channel seam

- Status: **Accepted**
- Date: 2026-10-10
- Deciders: Pascal Garber
- Related: [ADR 0002](0002-assistant-in-continuous-operation.md) (the design this builds on)

## Context

ADR 0002 decided what an assistant in continuous operation is: a long-running `serve`, tasks as
configuration, users and profiles, three rights levels, a gate that answers from the person's
decisions only, questions with an id and an expiry, and a channel that later goes through
Curlew. Its order of work puts the schedule, the configuration format and the questions before the
Curlew channel. This record fixes the contract of that first build: the file format, what a
question is, how an answer reaches a session, and where the channel seam sits, so the Curlew
channel can be added without changing a task.

## Decision

1. **One configuration file, version 1**, at `$XDG_CONFIG_HOME/lotse/tasks.json`
   (`LOTSE_TASKS_FILE` overrides it). The shape:
   `{version: 1, users: [{id, addresses}], profiles: [{id, user, agent?, model?, data}],
   tasks: [{id, profile, schedule, prompt | promptFile, cwd, mcpServers, rights, released,
   questions: {expiresIn, maxOpen, maxPerHour}, notify}]}`. Unknown keys are errors. Every
   problem is reported at start, at once (`parseServeConfig`). A private profile must name a
   model that is not on the free list. `serve` hashes the file plus every prompt file and stops
   when the hash changes (ADR 0002 §3).
2. **Two schedule shapes and nothing else**: `{"every": "30m"}` (units `m`, `h`, `d`; at least
   `1m`) and `{"at": "07:30", "days": ["mon", …]}` in local time. A missed `at` run fires once
   on start; with no last run it waits for the next occurrence. Runs of one task never overlap: a
   lock file per task, held by `serve` and by `lotse answer`.
3. **Two kinds of question.** A `permission` question holds a `session/request_permission` that
   neither a released area nor a token answers; the run polls the question store until it is
   answered or expires. A `reply` question is created when a turn ends with `end_turn` and the
   last line of the agent's message ends with `?` — deterministic, no model call. Ids are `A1`,
   `A2`, … per user, shown as `#A1`. The ceilings of ADR 0002 §2 (`maxOpen`, `maxPerHour`) are
   checked before a run starts and before each question is created.
4. **Answers come in through `lotse answer <id> <text>`** for now. A permission question takes
   only yes or no (`yes y ja j ok okay` / `no n nein`); the waiting run reads it from the store.
   A reply question continues the session with the text: `session/load`, else `session/resume`,
   else a new session that carries the question and the answer as context. The command says
   which of the three it did. An answer to a closed or expired question is dropped and the
   person is told; a permission question whose run ended — including every open one when
   `serve` restarts — is `cancelled`, so a later yes has nothing to allow (ADR 0002 §8).
5. **The gate** is `serveGate`: `read` declines every request, `released` allows a listed area
   (exact tool title, optionally its kind) once per call, and everything else becomes a
   permission question. `*_always` options are stripped and never selected. A yes mints one
   single-use token bound to session, tool and a SHA-256 digest of the call's tool, kind, raw
   input, content and locations; an expired question answers `cancelled`.
6. **The channel is a seam**: `ServeChannel { name, send(user, {title, body, questionId}) }`.
   A task never names a channel; `serve` hands every message for a user to the one channel it was
   started with. The first implementation is a desktop notification over
   `org.freedesktop.Notifications` (Gio D-Bus), with stderr when no session bus answers. The
   Curlew/XMPP channel is a second implementation and adds reading answers off the channel.
7. **State lives under `$XDG_STATE_HOME/lotse`** (`LOTSE_STATE_DIR` overrides it):
   `questions.json` and `runs.json` (last run, outcome, session per task) are `state`; the
   action log `serve.log` (JSON lines, ids and kinds only — no prompt, message or argument) is
   `state`; `locks/` is transient. Files are mode 0600 in a 0700 directory and declared in
   `.werkstatt-state.json`.

## Consequences

- The pure logic — schedule, configuration, questions, gate, runner — lives in
  `packages/core/src/serve/` with no `gi://` import; the app wires files, locks, the clock and
  the notifier. Tests run the whole path against `FixtureAgent` on Node and GJS.
- A question can be answered only on the machine that runs `serve` until the Curlew channel reads
  replies. That is the intended order (ADR 0002, order of work 4).
- The rule "a turn ending in `?` is a question" is a convention the task prompt has to follow.
  It costs no model call, and a prompt that wants an answer can ask for one in that form.
- Triggers other than a schedule, the prefilter and read positions of ADR 0002 §2 are not part
  of this build; a task today is a schedule plus a prompt.
