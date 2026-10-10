# `lotse serve` — scheduled tasks that ask before they act

`lotse serve` is a long-running process. It runs agent tasks on a schedule and sends a desktop
notification when an agent needs a decision from you. You answer with `lotse answer`. The contract
behind it is [ADR 0003](adr/0003-serve-tasks-questions-channel.md); the design it builds on is
[ADR 0002](adr/0002-assistant-in-continuous-operation.md).

```bash
lotse serve [--once] [--quiet]     # run due tasks; --once runs what is due now and exits
lotse questions [--all] [--json]   # open questions (--all: also answered, expired, cancelled)
lotse answer <id> <text…>          # yes/no for a permission, free text for a reply
```

## The task file

Tasks live in `$XDG_CONFIG_HOME/lotse/tasks.json` (`LOTSE_TASKS_FILE` overrides it), never in this
repository. Start from [examples/tasks.example.json](../examples/tasks.example.json) and keep the
file at mode `0600`; `serve` warns when it is readable by others.

- **users**: `{id, addresses}`. The desktop channel needs no address.
- **profiles**: `{id, user, agent?, model?, data}`. `data` is `private` or `public` and is required.
  A private profile must name a model that is not on the free list.
- **tasks**: `{id, profile, schedule, prompt | promptFile, cwd, mcpServers, rights, released,
  questions, notify}`. A `promptFile` resolves relative to the task file. `mcpServers` is passed to
  `session/new` unchanged.

Unknown keys are errors, and every problem is reported at start. `serve` reads the file once. When
the file or a prompt file changes, it stops with exit 0 and tells you; restart it to load the edit.

### Schedules

- `{"every": "30m"}`: units `m`, `h`, `d`, at least `1m`.
- `{"at": "07:30", "days": ["mon", "fri"]}`: local time; no `days` means every day. A run missed
  while `serve` was down fires once on start. A task that has never run waits for the next time.

Runs of one task never overlap, across `serve` and `lotse answer` alike.

### Rights

- `read`: every permission request is declined, and no question is asked.
- `confirm` (default): every permission request becomes a question to you.
- `released`: the areas in `released` (`{tool, kind?}`, exact tool title) are allowed once per
  call; anything else becomes a question.

lotse strips every `allow_always`/`reject_always` option and never selects one.

### Question limits

`questions: {expiresIn, maxOpen, maxPerHour}`, defaults `12h`, `3`, `6`. A task at its ceiling is
skipped before an agent starts.

`notify: "questions"` (default) notifies only when the agent asks. `"always"` also sends the
run's final message.

## Question → answer → resume

1. **Permission questions.** The agent asks for a tool the rights do not cover. You get a notification
   with an id such as `#A1`, and the run waits. `lotse answer A1 yes` (or `ja`, `ok`, `no`, `nein`)
   decides it; a yes allows that one call with those arguments, once. An unanswered question
   expires to `cancelled`. If the run ends or `serve` restarts first, the question is cancelled too,
   and a later yes allows nothing.
2. **Reply questions.** A turn that ends normally with a last line ending in `?` becomes a
   question. `lotse answer A2 <text>` continues the session: `session/load`, else `session/resume`,
   else a new session that carries the question and your answer as context. The command says which
   one it used. The agent's reply goes to stdout.

Write prompts so that an agent that needs you ends its message with a question.

## Where the state lives

`$XDG_STATE_HOME/lotse/` (`LOTSE_STATE_DIR` overrides it), mode `0600` in a `0700` directory:
`questions.json`, `runs.json` (last run, outcome, session per task), `serve.log` (JSON lines, ids
and kinds only, never a prompt or a reply) and `locks/`. Closed questions are kept for 7 days.

## Running it as a service

[data/lotse-serve.service](../data/lotse-serve.service) is an example systemd user unit. Nothing
installs it; the install commands are in its header. `Restart=on-failure` does not restart the clean
stop after a config change, so `systemctl --user restart lotse-serve` applies an edit.

## Channels

Messages go through one `ServeChannel` (`packages/core/src/serve/channel.ts`): today a desktop
notification over `org.freedesktop.Notifications`, falling back to stderr when there is no session
bus. A task never names a channel, so an XMPP channel through Curlew can be added without changing
any task.
