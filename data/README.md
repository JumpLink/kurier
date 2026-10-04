# `data/` — desktop entry, AppStream metainfo, icons

Everything the GNOME desktop needs to *know* kurier exists. None of it is built or
bundled: `gjsify flatpak init` renders the first two from `package.json#gjsify.flatpak`,
and the icons are hand-written files.

| File | Read by | Written by |
|---|---|---|
| `eu.jumplink.Kurier.desktop` | the shell, the compositor, `desktop-file-validate` | `gjsify flatpak init` |
| `eu.jumplink.Kurier.metainfo.xml` | GNOME Software, `appstreamcli` | `gjsify flatpak init` |
| `icons/hicolor/scalable/apps/eu.jumplink.Kurier.svg` | GTK, by icon **name** | placeholder |
| `icons/hicolor/symbolic/apps/eu.jumplink.Kurier-symbolic.svg` | GTK, `<app id>-symbolic` | placeholder |

No `.in` suffix: that suffix means "input for an i18n `merge_file`", and this repo has
no gettext pipeline and no Meson to run one. `gjsify flatpak init` defaults to `.in`
and takes the paths as flags.

**`package.json#gjsify.flatpak` is the source of truth for the first two.** Editing a
generated file is a change that the next `flatpak init --force` silently reverts, so
change the config and re-run. The one thing a re-run does lose is the screenshot TODO
inside the metainfo — which is why the same TODO lives in the config as an absent
`screenshots` key, not as prose.

## Running from a checkout

`gjsify run app/dist/kurier-app.gjs.mjs` needs no installation. Installation buys two
things a checkout does not have:

- the window icon, because `main.ts` sets `applicationIcon: APP_ID` and GTK resolves
  that by **name** against the installed icon theme;
- a launcher entry, because under Wayland the compositor maps a window to a desktop
  file only if the file is **installed**.

```sh
gjsify install
gjsify workspace kurier-cli build:app
npm run packaging:install          # per-user XDG data dir
PREFIX=/usr npm run packaging:install   # or system-wide, needs root
```

`packaging:install` runs `scripts/install-packaging.sh`, which honours `DESTDIR` and
rebuilds both caches (`update-desktop-database`, `gtk-update-icon-cache`) when those
tools exist. A full `install -D` line per file is in the script header if you prefer
to do it by hand.

**`Exec=kurier-app` names a binary this install does not create.** `gjsify ship` is
what produces one — it stages `bin/kurier-app` with a launcher that derives its own
prefix, plus the same four files, and packs it as `.deb`/`.rpm`/Flatpak. Until you run
it, the desktop entry is installed and points at a command that is not on `PATH`.

## The Flatpak, and what it gives up

`eu.jumplink.Kurier.json` is the Flathub build. Its two non-obvious finish-args are
deliberate and are the reason to read it before trusting it:

- `--talk-name=org.freedesktop.Flatpak` — kurier starts coding agents, and the agents
  are **host** programs (`opencode` and its own credentials, model config and git).
  Inside a Flatpak, `node:child_process` spawns *inside the sandbox*, where those do not
  exist. Reaching the host means `flatpak-spawn --host`, and this argument is the bus
  name that call goes through. `app/src/core/agents/sandbox.ts` builds that command; it is
  a no-op outside a Flatpak (it tests `/.flatpak-info` and nothing else — deliberately
  not `FLATPAK_ID`, which a Flatpak-installed terminal also sets), so a desktop install
  spawns exactly what it always did.
- `--filesystem=host` — and it is not a detail: granting host spawn to an app whose
  whole job is running a program that edits your files is close to no filesystem
  sandbox at all. kurier's own permission gate still stands (`session/request_permission`
  is answered by a person, `fs/*_text_file` is refused), but it governs the ACP channel,
  not the agent process once it is on the host.

Together they say: **the Flatpak is a convenient installer, not a sandbox.** Anyone
reviewing a Flathub submission should be told that in the description, not left to
infer it from the manifest.

### What it does to start the agent, and what it cannot do

`app/src/core/agents/sandbox.ts` rewrites an agent command into
`flatpak-spawn --host … /bin/sh -c …`, and it is a **no-op outside a Flatpak** — a
desktop install spawns exactly what it always did. Two things about the host side are
worth knowing before filing an issue against "kurier cannot find my agent":

- **The PATH is the host's, recovered from the person's own shell config.** `flatpak-spawn
  --host` passes the *session bus* PATH, which is not the PATH an interactive terminal
  has, and on this machine it does not contain `~/.opencode/bin` at all. kurier therefore
  runs the agent through the host's login shell and reads `~/.zshrc` or `~/.bashrc` first.
  **Known limit:** a `.bashrc` guarded by `[ -t 0 ]` returns early when there is no
  terminal, and there never is one here, so such a person gets the login PATH and
  `kurier agents` says NOT FOUND. A `$-`-style guard is fine. The fix belongs on the
  machine: put the agent's PATH in `~/.profile` or `~/.bash_profile`.
- **`$SHELL` that is not zsh or bash (fish, nushell, csh) gets the login PATH and no
  rc**, because the inner script is POSIX `sh` and their config is not.

Ending the agent is subtler than it looks: the pid kurier holds is the sandbox-side
`flatpak-spawn`, and SIGTERM to it *is* forwarded (measured — Stop and a closed window
leave no `opencode acp` behind), while **SIGKILL cannot be forwarded** and would orphan
the host process. `killGraceMs` exists for that reason.

The build is end to end: it installs `kurier-app` and the `kurier` CLI, both with a
`#!/usr/bin/gjs -m` shebang, because the manifest's `command` execs them directly and a
bundle without a shebang is handed to `/bin/sh`, which answers with a syntax error. Two
generated inputs make it work offline and both are committed: `build-aux/gjsify.gjs.mjs`
(the ~7 MB `@gjsify/cli` GJS bundle, the same file easy6502 keeps) and
`gjsify-sources.json` (`gjsify flatpak sources` — the offline tarball cache; without it
`gjsify install --immutable` cannot fetch anything inside the Flathub sandbox).

**The icons have to keep their comments INSIDE the `<svg>` root.** `flatpak
build-export` validates an icon by loading it through gdk-pixbuf, whose SVG loader fails
on a comment before the root element and refuses to export with "is not a valid icon:
Format not recognized". Measured here on both icons: unchanged fails, comment inside
succeeds.

### The bundled agent (opencode, as `extra-data`)

The first module in `package.json#gjsify.flatpak.modules` ships opencode, pinned in
`app/data/bundled-agents.json` (2.0.22, one url/sha256/size per arch). It is `extra-data`,
not a build source: flatpak-builder only *records* the url, and the client downloads and
verifies the archive when the app is **installed**. `/app/bin/apply_extra` then runs in a
sandbox with no network whose only writable path is `/app/extra` — the rest of `/app` is
the read-only build result — so the archive unpacks to `/app/extra/agents/opencode/`
(`BUNDLED_PREFIX` in `app/src/core/agents/catalog.ts`). That is off PATH on purpose: in
`/app/bin` it would shadow the person's own opencode. `apply_extra` uses the runtime's
`tar` and `gzip` (both present in `org.gnome.Platform//50`).

**The archive is an npm tarball, not a GitHub release.** opencode v2 is published as
`@opencode/cli`, one binary package per platform in the wrapper's `optionalDependencies`
(`@opencode/cli-linux-x64`, `-linux-arm64`; glibc, because the GNOME runtime is). The tarball
holds `package/package.json` and `package/bin/opencode`, so the catalog's `binary` is
`package/bin/opencode` and `apply_extra` stays unchanged. There is no GitHub release for v2 —
the latest one there is v1.18.34. Resolve the version through the wrapper, never through a
platform package's own `latest` tag: that one points at an unrelated 1.18.18 with a binary called
`lildax`. v2 is about 90 MB to download and 204 MB unpacked, against 60 MB for v1.

**Refreshing the pin:** `./scripts/refresh-bundled-agent` (dry run) and `--write`. It resolves the
version, verifies the registry's sha512, computes the sha256 `extra-data` needs, checks the binary's
path in the archive, and updates both `bundled-agents.json` and the module in `package.json`. Then
re-run the `gjsify flatpak init --force …` line from AGENTS.md § Packaging. The catalog tests fail
when the module in either `package.json` or the generated `eu.jumplink.Kurier.json` disagrees with
the catalog, so a forgotten `init --force` is red.

**The bundled copy gets its own `HOME`** (`core/agents/isolation.ts`). opencode v2 reads
`~/.claude/skills` and `~/.agents/skills`, v1's `OPENCODE_DISABLE_CLAUDE_CODE` and
`OPENCODE_DISABLE_EXTERNAL_SKILLS` are gone, and under `--filesystem=host` the sandbox's `HOME` is
the person's real home (measured). So the one switch left is `HOME` itself.

**`gjsify ship` drops it.** `ship` renders exactly one module of its own and reads neither
`modules` nor `extraModules`, so a Flatpak built with `ship` has no bundled agent. Only the
manifest above carries it.

**`--filesystem=host` is load-bearing twice now.** Besides what `flatpak-spawn --host`
needs, the bundled agent runs *inside* the sandbox, and that grant is what lets it read and
edit the project it is pointed at.

What is still open: `kurier` has no `v0.1.0` tag, so the `sources` `tag` in the manifest
does not resolve until one is pushed; and both icons are placeholders (see the table
above) until the real mark lands.

## Validate

```sh
npm run packaging:validate
desktop-file-validate data/eu.jumplink.Kurier.desktop
appstreamcli validate --no-net --explain data/eu.jumplink.Kurier.metainfo.xml
flatpak-builder --show-manifest eu.jumplink.Kurier.json DIR   # prints, does NOT validate
```

`--show-manifest` is not a validator — it accepted `buildsystem: "nonsense"` at exit 0
when it was measured — so the gate is `packaging:validate`, which is the two tools that
do read the files.