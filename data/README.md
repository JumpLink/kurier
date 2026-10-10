# `data/` — desktop entry, AppStream metainfo, icons

Everything the GNOME desktop needs to *know* lotse exists. None of it is built or
bundled: `gjsify flatpak init` renders the first two from `package.json#gjsify.flatpak`,
and the icons are hand-written files.

| File | Read by | Written by |
|---|---|---|
| `eu.jumplink.Lotse.desktop` | the shell, the compositor, `desktop-file-validate` | `gjsify flatpak init` |
| `eu.jumplink.Lotse.metainfo.xml` | GNOME Software, `appstreamcli` | `gjsify flatpak init` |
| `icons/hicolor/scalable/apps/eu.jumplink.Lotse.svg` | GTK, by icon **name** | placeholder |
| `icons/hicolor/symbolic/apps/eu.jumplink.Lotse-symbolic.svg` | GTK, `<app id>-symbolic` | placeholder |

No `.in` suffix: that suffix means "input for an i18n `merge_file`", and this repo has
no gettext pipeline and no Meson to run one. `gjsify flatpak init` defaults to `.in`
and takes the paths as flags.

### Regenerating the four files

```bash
./node_modules/.bin/gjsify flatpak init --force --no-format \
  --manifest eu.jumplink.Lotse.json \
  --metainfo data/eu.jumplink.Lotse.metainfo.xml \
  --desktop data/eu.jumplink.Lotse.desktop \
  --flathub-json flathub.json
```

`--no-format` because the repo's own `oxfmt` run owns the formatting, and every path is
given explicitly — the defaults put the files somewhere this repo does not keep them.

**`package.json#gjsify.flatpak` is the source of truth for the first two.** Editing a
generated file is a change that the next `flatpak init --force` silently reverts, so
change the config and re-run. The one thing a re-run does lose is the screenshot TODO
inside the metainfo — which is why the same TODO lives in the config as an absent
`screenshots` key, not as prose.

### The two elements the generator cannot write

The rename from Kurier needs `<provides><id>eu.jumplink.Kurier</id>` and
`<replaces><id>eu.jumplink.Kurier</id></replaces>` in the metainfo, so an installed copy
and its ODRS reviews survive the new app id ([AppStream
spec](https://www.freedesktop.org/software/appstream/docs/chap-Metadata.html),
[Flathub](https://docs.flathub.org/docs/for-app-authors/metainfo-guidelines)).
`gjsify flatpak init` renders `provides.binaries`, `.mimetypes` and `.dbus` and has no
field for either element, so **both are hand-written into the generated file** — the one
exception to the paragraph above, and a capability gjsify should grow.

`node scripts/check-metainfo.mjs` is what keeps that from being lost: it fails if the id
is not `eu.jumplink.Lotse`, if either old-id element is missing, or if the file still
names a `kurier` binary. It runs as part of `npm run packaging:validate`, so the
regeneration that drops them fails the gate instead of shipping.

## Running from a checkout

`gjsify run app/dist/lotse-app.gjs.mjs` needs no installation. Installation buys two
things a checkout does not have:

- the window icon, because `main.ts` sets `applicationIcon: APP_ID` and GTK resolves
  that by **name** against the installed icon theme;
- a launcher entry, because under Wayland the compositor maps a window to a desktop
  file only if the file is **installed**.

```sh
gjsify install
gjsify workspace lotse-cli build:app
npm run packaging:install          # per-user XDG data dir
PREFIX=/usr npm run packaging:install   # or system-wide, needs root
```

`packaging:install` runs `scripts/install-packaging.sh`, which honours `DESTDIR` and
rebuilds both caches (`update-desktop-database`, `gtk-update-icon-cache`) when those
tools exist. A full `install -D` line per file is in the script header if you prefer
to do it by hand.

**`Exec=lotse-app` names a binary this install does not create.** `gjsify ship` is
what produces one — it stages `bin/lotse-app` with a launcher that derives its own
prefix, plus the same four files, and packs it as `.deb`/`.rpm`/Flatpak. Until you run
it, the desktop entry is installed and points at a command that is not on `PATH`.

## The Flatpak, and what it gives up

`eu.jumplink.Lotse.json` is the Flathub build. Its two non-obvious finish-args are
deliberate and are the reason to read it before trusting it:

- `--talk-name=org.freedesktop.Flatpak` — lotse starts coding agents, and the agents
  are **host** programs (`opencode` and its own credentials, model config and git).
  Inside a Flatpak, `node:child_process` spawns *inside the sandbox*, where those do not
  exist. Reaching the host means `flatpak-spawn --host`, and this argument is the bus
  name that call goes through. `packages/core/src/agents/sandbox.ts` builds that command; it is
  a no-op outside a Flatpak (it tests `/.flatpak-info` and nothing else — deliberately
  not `FLATPAK_ID`, which a Flatpak-installed terminal also sets), so a desktop install
  spawns exactly what it always did.
- `--filesystem=host` — and it is not a detail: granting host spawn to an app whose
  whole job is running a program that edits your files is close to no filesystem
  sandbox at all. lotse's own permission gate still stands (`session/request_permission`
  is answered by a person, `fs/*_text_file` is refused), but it governs the ACP channel,
  not the agent process once it is on the host.

Together they say: **the Flatpak is a convenient installer, not a sandbox.** Anyone
reviewing a Flathub submission should be told that in the description, not left to
infer it from the manifest.

### What it does to start the agent, and what it cannot do

`packages/core/src/agents/sandbox.ts` rewrites an agent command into
`flatpak-spawn --host … /bin/sh -c …`, and it is a **no-op outside a Flatpak** — a
desktop install spawns exactly what it always did. Four things about the host side are
worth knowing before filing an issue against "lotse cannot find my agent", and each has
a test:

- **Detection is `/.flatpak-info` alone, not `FLATPAK_ID`.** A terminal, editor or IDE
  installed *as a Flatpak* sets `FLATPAK_ID` in an otherwise host environment; treating
  that as sandboxed would route its agents through `flatpak-spawn --host` and lose the
  PATH it already had.
- **The protocol pipes are fenced off.** A login shell reads several files before the
  agent starts and any of them may print (a banner lands in the JSON-RPC stream) or `read`
  from stdin (an `ssh-add` prompt swallows `initialize` and the handshake hangs with no
  error). The wrapper parks the pipes on fds 3/4 and points the inherited ones at
  `/dev/null`/stderr, and the inner script hands them back before the agent starts.
- **The PATH is the host's, recovered from the person's own shell config.** `flatpak-spawn
  --host` passes the *session bus* PATH, which is not the PATH an interactive terminal
  has, and on this machine it does not contain `~/.opencode/bin` at all. lotse therefore
  runs the agent through the host's login shell and reads `~/.zshrc` or `~/.bashrc` first.
  A login shell ALONE is not enough — `-l` does not read `~/.zshrc` — and neither is
  sourcing it from `/bin/sh`, because `~/.zshrc` is zsh syntax that dash cannot parse.
  **Known limit:** a `.bashrc` guarded by `[ -t 0 ]` returns early when there is no
  terminal, and there never is one here, so such a person gets the login PATH and
  `lotse agents` says NOT FOUND. A `$-`-style guard is fine. The fix belongs on the
  machine: put the agent's PATH in `~/.profile` or `~/.bash_profile`.
- **`$SHELL` that is not zsh or bash (fish, nushell, csh) gets the login PATH and no
  rc**, because the inner script is POSIX `sh` and their config is not.

Ending the agent is subtler than it looks: the pid lotse holds is the sandbox-side
`flatpak-spawn`, and SIGTERM to it *is* forwarded (measured — Stop and a closed window
leave no `opencode acp` behind), while **SIGKILL cannot be forwarded** and would orphan
the host process. `killGraceMs` exists for that reason.

The build is end to end: it installs `lotse-app` and the `lotse` CLI, both with a
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
`packages/core/data/bundled-agents.json` (2.0.22, one url/sha256/size per arch). It is `extra-data`,
not a build source: flatpak-builder only *records* the url, and the client downloads and
verifies the archive when the app is **installed**. `/app/bin/apply_extra` then runs in a
sandbox with no network whose only writable path is `/app/extra` — the rest of `/app` is
the read-only build result — so the archive unpacks to `/app/extra/agents/opencode/`
(`BUNDLED_PREFIX` in `packages/core/src/agents/catalog.ts`). That is off PATH on purpose: in
`/app/bin` it would shadow the person's own opencode. `apply_extra` uses the runtime's
`tar` and `gzip` (both present in `org.gnome.Platform//50`).

**The archive is an npm tarball, not a GitHub release.** opencode v2 is published as
`@opencode/cli`, one binary package per platform in the wrapper's `optionalDependencies`
(`@opencode/cli-linux-x64`, `-linux-arm64`; glibc, because the GNOME runtime is). The tarball
holds `package/package.json` and `package/bin/opencode`, so the catalog's `binary` is
`package/bin/opencode`: `apply_extra` keeps its four steps and only its `chmod` path follows. There is no GitHub release for v2 —
the latest one there is v1.18.34. Resolve the version through the wrapper, never through a
platform package's own `latest` tag: that one points at an unrelated 1.18.18 with a binary called
`lildax`. v2 is about 90 MB to download and 204 MB unpacked, against 60 MB for v1.

**Refreshing the pin:** `./scripts/refresh-bundled-agent` (dry run) and `--write`. It resolves the
version, verifies the registry's sha512, computes the sha256 `extra-data` needs, checks the binary's
path in the archive, and updates both `bundled-agents.json` and the module in `package.json`. Then
re-run the `gjsify flatpak init --force …` line from AGENTS.md § Packaging. The catalog tests fail
when the module in either `package.json` or the generated `eu.jumplink.Lotse.json` disagrees with
the catalog, so a forgotten `init --force` is red.

**The bundled copy gets its own `HOME`** (`@lotse/core`'s `agents/isolation.ts`). opencode v2 reads
`~/.claude/skills` and `~/.agents/skills`, v1's `OPENCODE_DISABLE_CLAUDE_CODE` and
`OPENCODE_DISABLE_EXTERNAL_SKILLS` are gone, and under `--filesystem=host` the sandbox's `HOME` is
the person's real home (measured). So the one switch left is `HOME` itself.

**`gjsify ship` drops it.** `ship` renders exactly one module of its own and reads neither
`modules` nor `extraModules`, so a Flatpak built with `ship` has no bundled agent. Only the
manifest above carries it.

**`--share=network` is load-bearing for the bundled agent.** It runs *inside* the sandbox, and a
sandbox with this app's other grants has no DNS and no route out — measured with `flatpak run
--filesystem=host --command=sh org.freedesktop.Platform//25.08`: `curl https://registry.npmjs.org`
fails, and with `--share=network` it answers 200. Without it the bundled agent could not reach one
model provider, and no login could finish. A host agent is unaffected: it runs on the other side of
`flatpak-spawn --host`.

**`--filesystem=host` is load-bearing twice now.** Besides what `flatpak-spawn --host`
needs, the bundled agent runs *inside* the sandbox, and that grant is what lets it read and
edit the project it is pointed at.

What is still open: both icons are placeholders (see the table above) until the real mark
lands. The `sources` `tag` in the manifest names the release being cut (`v0.1.1`) and only
resolves once that tag is pushed; the release workflow swaps it for the checkout.

## Validate

```sh
npm run packaging:validate
desktop-file-validate data/eu.jumplink.Lotse.desktop
appstreamcli validate --no-net --explain data/eu.jumplink.Lotse.metainfo.xml
flatpak-builder --show-manifest eu.jumplink.Lotse.json DIR   # prints, does NOT validate
```

`--show-manifest` is not a validator — it accepted `buildsystem: "nonsense"` at exit 0
when it was measured — so the gate is `packaging:validate`, which is the two tools that
do read the files.