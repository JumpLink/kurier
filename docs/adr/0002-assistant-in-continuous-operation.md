# 2. The assistant in continuous operation

- Status: **Accepted**
- Date: 2026-10-10
- Deciders: Pascal Garber
- Related: [ADR 0001](0001-lotse-as-an-embeddable-widget.md),
  [werkstatt ADR 0004](../../../../docs/adr/0004-gnome-is-optional.md) (GNOME is optional),
  Curlew ADR 0004 (sending and writing, granted per capability)

## Context

kurier today runs one turn at a time: `kurier start`, `kurier resume`, and the window. A person
is always there to answer `session/request_permission`.

The next step is an assistant that runs all the time. It notices what needs doing, asks its
person by messenger on the phone, and acts after a yes. The person can also give it work over the
same messenger. Two scenarios carry the design:

- **School dates.** A mail from a school, or a message in a class group chat, contains dates. The
  assistant extracts them, asks "add these three dates?", and on a yes creates calendar entries,
  without duplicates when the same mail arrives twice.
- **Customer request.** A customer asks for a small website change. The assistant asks whether to
  take it on. On a yes an agent works in a separate worktree of that project, the assistant sends
  the diff and asks again, and only on a second yes publishes, drafts a reply to the customer and
  records the work.

`AGENTS.md` lists three things as deliberately absent: MCP wiring against the real apps, a
principal policy and a Telegram bot. This record decides the first two. The Telegram bot becomes a
Curlew backend later.

## Decision

1. **`kurier serve` is a long-running process**, run as a systemd user unit. It builds on
   `@kurier/core` (ADR 0001) and runs headless: no `gi://` GTK import, no display (werkstatt ADR
   0004).
2. **Triggers start the work.** Three kinds: a schedule (poll a source through its own CLI or MCP
   server at an interval), a message on the channel, and later a push (a D-Bus signal, a webhook).
   Each trigger passes a **deterministic prefilter before any model is called**: sender, group,
   tag, and a read position so nothing is handled twice. A trigger that does not match costs no
   model call. A task also carries a ceiling: a maximum number of open questions and a maximum
   of questions per hour. Beyond either, the trigger is logged and dropped without a model
   call — a source that suddenly floods must not become a stream of questions nobody reads.
3. **Tasks are configuration, not code.** A task names its triggers, its prefilter, its profile,
   the MCP servers its sessions may reach, a prompt template and the rights level it asks for.
   Tasks live in a private, gitignored configuration under `$XDG_CONFIG_HOME/kurier/`. kurier's
   code knows no particular task, no person and no address. Example tasks in this repository use
   synthetic values only.

   **`serve` reads that configuration once, at start.** The rights level and the released areas
   of every task are fixed for the life of the process. `serve` records a hash of the task
   configuration and refuses to continue when the hash changes, so an edit takes effect on a
   restart the person performs and never under a session that is already running.
4. **Users and profiles are in the data model from the start.** A *user* has one or more channel
   addresses. A *profile* belongs to a user and holds tasks, MCP servers, rights and the agent and
   model. Several users are possible; the first build serves one. A message from an address no
   user claims is logged and ignored, without a model call.
5. **A profile that handles private data names its model.** The profile marks its data as
   private or public. A private profile runs only on the agents and models its configuration
   allows. There is no fallback to another model, and an unavailable one stops the task with a
   message to the person.
6. **Three rights levels per task.**
   - **Read:** sessions reach read-only tools only.
   - **Confirm** (the default as soon as anything writes): before an action, the person gets a
     question that names the concrete action. A yes allows that action once.
   - **Released:** an area the person released without questions, for example "create entries
     in this one calendar". It is recorded in the task configuration as the person's decision,
     never in a session record.

   The owning app's own gate stays the hard limit. kurier cannot widen it: a Curlew tool that
   is not granted in Curlew's configuration does not exist for the session (Curlew ADR 0004).

   And no session `serve` starts may have write access to kurier's or Curlew's configuration
   directory. A rights level a session can rewrite is not a limit, and a released area is the
   person's decision, not the assistant's working material. kurier cannot take file access away
   from an agent process, so the profile's sandbox enforces this; the hash check in §3 is the
   backstop that turns a missed edit into a stop instead of a wider right.
7. **The gate in `serve` answers from the person's decisions only.** `request_permission`
   is answered `allow_once` only when it matches a question the person answered yes or a released
   area of the task. Everything else becomes a new question or is answered `cancelled`. This
   amends guardrail 2 for `serve`: kurier now keeps a policy, but it is written by the person,
   lives in the task configuration, and only narrows what the owning app allows. Guardrail 1 stays
   as it is: a session record never holds a grant, and `assertScopeIsNotAuthority` keeps
   checking.

   The amendment has a second half. In the window `allow_always`/`reject_always` are passed
   through, because a person reads the option and the agent remembers the answer. `serve` has no
   such moment: it **strips every `*_always` option** from a `request_permission` before it asks,
   and never selects one. Only `allow_once` and a decline exist there, so one yes over a
   messenger can never leave a standing permission behind.

   **A yes mints one single-use token.** The token is bound to the session id, the tool name and
   a digest of the exact call arguments. The gate consumes it on the first call that matches all
   three and answers `cancelled` for every later one, and the token dies with the question's
   expiry. A yes allows the action the person was shown, not a second call of the same shape.
8. **Questions have an id and an expiry.** Each question has a short id per user (`#A17`), the
   task, the session, the action it would allow, a creation time and an expiry. An answer
   counts when it is a reply to the question's message or names its id. A plain answer counts
   only for a question that was already open at the message's own timestamp: a question created
   after that moment needs the reply-to or the id, and so does any question that would
   allow a write, however few are open. "Yes" and "no" are recognised without a model.
   Other text goes to the session as the person's reply. An expired question is answered
   `cancelled`, and the person is told. A yes resumes the session (`session/load`, or
   `session/resume` as a fallback).
   The window keeps its no-timeout rule: there a person is looking at the dialog. Over a
   messenger an open question that never closes would hold a session forever, and expiring to
   `cancelled` fails closed.

   **A question renders the fields the gate will enforce** — the capability, the target and every
   value that would be written — verbatim and unsummarised, never as a model's précis of a diff
   or a list of dates. The gate then enforces those fields, not the question's text, so the two
   cannot drift apart.

   **A yes with nothing pending is dropped.** When no `request_permission` for the question is
   waiting any more — the ordinary case is a `serve` that restarted in between — the answer is
   discarded and the person is told. It is never applied to a resumed session and never to a new
   one: the pending request is what the yes answers, and without it there is nothing to allow.
9. **The channel goes through Curlew, never through messenger code in kurier.** kurier defines a
   channel interface (send a text to an address, read new messages since a position). Its first
   implementation is an MCP client against Curlew's server, using the assistant's own account and
   the send tool Curlew grants for it. Messages from the person's own accounts are only read.
10. **State and log are declared.** Read positions, open questions, users and profiles, and an
   action log go under kurier's data directory, mode 0600 in 0700. The log has one line per
   trigger, question, answer and allowed action, with source ids instead of message text. Tiers:
   configuration and questions are `state`, the log is `state`. Everything is declared in
   `.werkstatt-state.json`.

### The two scenarios on this design

- **School dates:** a schedule trigger polls Curlew for new mail from the configured sender and
  messages in the configured group → prefilter: sender or group match, read position → a session
  with the read-only Curlew server extracts dates and returns a proposal → question `#A3` with
  the dates → yes → the gate allows `calendar.create` for exactly those entries; for a source key it
  already has, Curlew creates nothing.
- **Customer request:** a schedule trigger polls Curlew for the customer's chat → prefilter:
  contact maps to a project in the private configuration → question `#A17` ("take this on?") →
  yes → a session of the programming profile in a new worktree → diff to the person, question
  `#A18` ("publish?") → yes → the project's own publish command from the configuration, a reply
  draft to the person, the work recorded. kurier does not guess any check or publish command.

## Consequences

- `AGENTS.md` changes on acceptance: "MCP wiring against the real apps" and "principal policy"
  leave the "not here yet" list, and guardrail 2 names the `serve` amendment.
- `serve` needs ADR 0001 steps 2 to 4 first: injectable paths and settings, `@kurier/core`,
  `mcpServers` through `AgentSession`.
- kurier gains an MCP client for the channel. That is not a change to "MCP is passed through, not
  known" for sessions: a session's `mcpServers` stay opaque.
- The action log is the place to answer "what did the assistant do?". It must stay readable
  without a model.
- A private profile on a free model is a configuration error, reported at start, not at the first
  message.

## Order of work

1. ADR 0001 steps 2 to 4.
2. `kurier serve`: unit file, schedule, state, log, state manifest.
3. Users, profiles, tasks: configuration format and validation, with synthetic test fixtures.
4. Channel interface and the Curlew implementation (needs Curlew's XMPP send, Curlew ADR 0004).
5. Questions: ids, expiry, answer parsing, resuming the session, the `serve` gate.
6. First task: "what is on tomorrow?" over the channel, answered from Curlew's calendar.
7. The school dates task, then the customer request task.
