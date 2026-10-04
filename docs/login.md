# Logging in to a provider from kurier

Status: **the core, `kurier login` and the window's dialog exist.** The window offers **Log in…** on the
auth dialog (`KU_APP_LOGIN=1` opens it for a screenshot) and restarts the agent after a login. Measured on
opencode 2.0.22, 2026-10-04.

## Why this is not the old "no in-window login"

`core/failure.ts` used to say a window cannot log in, because that would store a credential kurier has no
safe place for. That was right for the only path then available (`opencode auth login` in a terminal) and
it stays right for an **API key**. It is not true for an **OAuth flow run by opencode**: opencode starts it,
talks to the provider and keeps the result in its own store. kurier shows a URL and a code and asks whether
it is finished. Nothing is stored here, so the privacy rule holds unchanged: there is still no `secret` tier.

## How it works

opencode v2 has an HTTP API for it (`opencode auth login` does not work without a TTY: it answers
`Cancelled` at once). kurier starts a private `opencode serve --port 0` (`core/agents/server.ts`), bound to
`127.0.0.1`, with a per-start Basic-auth password that exists only in memory and in the child's environment,
under the same isolation environment as the agent, and closes it when the login is over.

| Call | Meaning |
|---|---|
| `GET /api/integration` | every provider and the ways to connect it (229 on 2.0.22; 8 have OAuth) |
| `POST /api/integration/{id}/connect/oauth` `{methodID, answer?}` | begin: `{attemptID, url, instructions, mode, time}` |
| `GET …/oauth/{attempt}` | `pending` \| `complete` \| `failed{message}` \| `expired` |
| `POST …/{attempt}/complete` `{code}` | for `mode: "code"` |
| `DELETE …/{attempt}` | cancel |

`mode` is `auto` (the person approves in a browser, kurier polls) or `code` (a code is pasted back).
`core/login/flow.ts` runs one attempt with no widget and no clock of its own, so the CLI, the window and the
tests share it; `core/login/providers.ts` reads the catalog; `core/login/api.ts` is the transport-agnostic
client. Everything is tested on both runtimes against a scripted API.

## What is on offer

OAuth methods only. `app/data/login-providers.json` holds the two things kurier owns: the providers it does
not offer (`xai`, by decision of 2026-10-04, each with a reason) and the order of the rest. A provider in
neither list is still shown, after the preferred ones. Methods that ask a question (a GitHub Enterprise host,
a Snowflake account) work through `--answer key=value`; a field type kurier has no widget for leaves the
method out.

## No login wall

Nothing here runs unless the agent asks for it. kurier starts and works as before, including the free Zen
models; a login is offered when opencode answers `-32000` before a prompt, which is the existing `auth`
failure. That was the reason to build on opencode in the first place.

## Limits, and what is not known

- **v2 only.** v1 answers a 404 on the catalog and `kurier login` says "use `kurier auth`".
- **A host opencode under a Flatpak is out of reach:** it runs outside the sandbox, so its loopback port is
  not ours. `kurier auth` is the path there. The bundled copy runs inside, so it works.
- **Not measured: does an already running `opencode acp` see a fresh login?** Needs a real account.
  `kurier login` says an agent that is already running may need a restart.
- **GJS keeps the main loop alive after the server has gone.** Any child `startServer` launches, even a
  plain `sh` that exits by itself, leaves `kurier login` running after its handler returns; the same child
  through a bare `spawn` does not. Not isolated (stdout/stderr listeners, encoding, timers, `unref`, closing
  on `close` instead of `exit`, destroying the streams, deferring the resolve: none of them changed it).
  The command therefore ends itself. Worth a minimal reproduction for gjsify.
- **Forms:** only `string` fields with `eq` conditions are understood.
