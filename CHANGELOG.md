# Changelog

Notable changes to lotse. The per-release notes that ship in the AppStream metainfo are generated
from the `gjsify.flatpak.releases` block in `package.json`; this file is the developer-facing view
and also records changes that are not a release of their own.

## Unreleased

### Changed

- **The project is now called lotse** (German for the pilot who comes aboard a ship and steers it
  through unfamiliar water). Everything up to and including 0.1.1 was released as **Kurier**; the
  rename happened before the first npm publish, so no published package name changes:
  - npm packages `@kurier/{acp,session,core,widget}` → `@lotse/{acp,session,core,widget}`
  - the command and the binary `kurier` → `lotse`
  - the application id `eu.jumplink.Kurier` → `eu.jumplink.Lotse`. The metainfo carries
    `<provides>` and `<replaces>` for the old id, so an installed Kurier is upgraded rather than
    duplicated.
  - the data and config directories `$XDG_DATA_HOME/kurier` and `$XDG_CONFIG_HOME/kurier` →
    `.../lotse`. Each one is renamed **once** on startup when the new name is free; two
    directories are never merged, and a move that fails leaves lotse on the old directory and
    says so.
  - every environment knob `KURIER_*` → `LOTSE_*`. The old spelling is still read as a fallback —
    the new name wins when both are set.
  - the development hooks `KU_APP_*` / `KU_STANDIN_*` → `LOTSE_APP_*` / `LOTSE_STANDIN_*`, with
    no fallback: those are for working on lotse, not for using it.

## 0.1.1 — 2026-10-10

Released as **Kurier**. The first release with installable packages: login to a model provider
from the app, a Flatpak that brings its own copy of opencode, a distinct message for an account
without credit, Windows and macOS fixes, and packages for `.deb`, `.rpm`, AppImage, macOS,
Windows and Flatpak (all unsigned).

## 0.1.0 — 2026-10-01

Released as **Kurier**. The first release: the session list, one real agent turn with streaming
and Stop, the permission dialog, and the agent resolution that prefers your own opencode over the
bundled copy.
