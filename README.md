# Kurier

An [ACP](https://agentclientprotocol.com) client: a command-line tool that starts a coding agent
(currently [opencode](https://opencode.ai)) as a subprocess, talks to it over the **Agent Client
Protocol** — JSON-RPC 2.0 over stdio — and keeps a local record of your sessions.

Kurier has no agent of its own and no model of its own. It runs on **GJS** (GNOME's JavaScript
runtime) via [gjsify](https://github.com/gjsify/gjsify), like [postbote](../mail/README.md) and
[beifahrer](../beifahrer/README.md).

> **Status: early.** One adapter (opencode), one prompt turn per `start`/`resume` call, no
> graphical surface yet.

## Why ACP instead of one SDK per agent

ACP is the reason kurier does not need a driver for every coding agent it wants to run. The agent
decides which model does the work; kurier only owns the environment — which working directory the
session runs in, what it is allowed to do, and which MCP servers it may connect to. That split is
standard, not something this project invented: `session/request_permission` is how an agent asks
for permission, `fs/read_text_file`/`fs/write_text_file` are how it would read or write files
*through kurier* if kurier allowed it (it does not — those two are answered `false`), and
`session/new` with `mcpServers` is how it reaches whichever MCP servers kurier hands it.

Measured, not assumed — a real `initialize` handshake against `opencode acp` 2.0.19, run entirely
inside one GJS process with no Node process anywhere in the chain:

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

## Install and run

```bash
gjsify install
gjsify workspace kurier-cli build
gjsify run app/dist/kurier.gjs.mjs agents
```

The first time you run a session against opencode, you likely need to log in first:

```bash
kurier auth --agent opencode
```

`opencode acp` advertises an interactive login (`Run \`opencode auth login\` in the terminal`) as
its auth method — not a token kurier could hand over by itself. Without `kurier auth`, a session
started before you are logged in dies on `-32000 auth_required` instead of on your prompt.

## Commands

```bash
kurier start [--agent opencode] [prompt…]   # new session, one prompt turn, prints the agent's stream
kurier sessions                             # list kurier's own records for the local principal
kurier resume <id> [prompt…]                # reattach a stored session, then optionally one prompt turn
kurier cancel <id>                          # send session/cancel
kurier auth [--agent opencode]              # the interactive-login escape hatch
kurier agents                               # the launchers that are registered, and whether the binary is on PATH
```

## Where your data lives

Kurier keeps one record per session — which agent, which directory, the transcript, whether it is
bound to anything else — at `$XDG_DATA_HOME/kurier/sessions.json` (mode `0600`), written
atomically. Never inside this repository: **this repository is public**, and `.gitignore` is only
the second line of defence, not the first.

A session record says what is *reachable*, never what is *allowed*. Nothing in it can grant a
future call permission on its own — every request the agent makes is checked again, every time. See
[AGENTS.md](AGENTS.md) for why that distinction is load-bearing rather than a style choice.

## What it does not do yet

No graphical surface (a GTK4/libadwaita one is planned, not a browser page), no Telegram bot, no
wiring to kurier's own MCP servers, no policy for more than one person in a session, and no adapter
for Claude Code. Details and the reasoning: [AGENTS.md](AGENTS.md).

## Releasing

`git tag vX.Y.Z && git push --tags` runs the whole of CI — tests, type check, lint — and, if it
passes, builds and attaches every installable format to the tag's GitHub release: `.deb`, `.rpm`,
`.AppImage`, a Flatpak (`eu.jumplink.Kurier.flatpak`, from the manifest in
[data/README.md](data/README.md)), a macOS `.app.zip` (arm64 + x64), and a Windows program
directory `.zip` and `.msi` (x64). All of it packages the GUI (`kurier-app`), the one binary with
a desktop entry and an App-ID; the `kurier` CLI installs alongside it inside the `.deb`/`.rpm`/
Flatpak but ships no format of its own.

Everything is unsigned, which is a legitimate deliverable rather than a placeholder (gjsify ADR
0024 § A13) — see the comment above the macOS/Windows packaging steps in
[ci.yml](.github/workflows/ci.yml) for where `--sign`/`--notarize` would attach once a signing
identity exists. `workflow_dispatch` on [release.yml](.github/workflows/release.yml) re-cuts
assets for an existing tag without moving it.

## Development

See [AGENTS.md](AGENTS.md).

## License

[AGPL-3.0-or-later](LICENSE) © Pascal Garber.
