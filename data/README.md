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
  name that call goes through.
- `--filesystem=host` — and it is not a detail: granting host spawn to an app whose
  whole job is running a program that edits your files is close to no filesystem
  sandbox at all. kurier's own permission gate still stands (`session/request_permission`
  is answered by a person, `fs/*_text_file` is refused), but it governs the ACP channel,
  not the agent process once it is on the host.

Together they say: **the Flatpak is a convenient installer, not a sandbox.** Anyone
reviewing a Flathub submission should be told that in the description, not left to
infer it from the manifest.

Not yet buildable end to end: the manifest's `build-commands` need
`build-aux/gjsify.gjs.mjs` (the committed ~7 MB `@gjsify/cli` GJS bundle, the same file
easy6502 keeps) and `gjsify-sources.json` (`gjsify flatpak sources`, the offline
tarball cache — without it `gjsify install --immutable` cannot fetch anything inside
the Flathub sandbox). `kurier` has no `v0.1.0` tag either, so the `sources` `tag` in the
manifest does not resolve yet.

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