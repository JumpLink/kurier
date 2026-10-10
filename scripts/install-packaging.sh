#!/bin/sh
# Install the packaging files into an XDG data directory.
#
# Why this exists at all, when `gjsify ship` builds a real `.deb`/`.rpm`/Flatpak:
# `ship` packs a payload, it does not put an app into the desktop of the machine
# running it. Two of kurier's consumers need the files *in place*: GTK resolves
# the window icon by NAME (`main.ts`: `applicationIcon: APP_ID`), and under Wayland
# the compositor matches a window to a launcher only through an INSTALLED
# `.desktop`. `app/data/README.md` in buchhaltung says the same for the same
# reason — this is the "does it show up in the shell" step, not a package.
#
# `PREFIX` decides where. Default is the per-user XDG data dir, which needs no
# root and which a package install overrides; `DESTDIR` (packaging convention) is
# honoured so a distribution can reuse this as a staging step.
set -eu

: "${DESTDIR:=}"
: "${PREFIX:=${XDG_DATA_HOME:-$HOME/.local/share}}"
root="${DESTDIR}${PREFIX}"
here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

# `-D` so the hicolor and applications subtrees are created in one go; `-m` fixed
# rather than taken from the umask, because an icon another user cannot read is an
# icon the icon theme skips.
install -Dm644 "$here/data/eu.jumplink.Lotse.desktop" \
	"$root/applications/eu.jumplink.Lotse.desktop"
install -Dm644 "$here/data/eu.jumplink.Lotse.metainfo.xml" \
	"$root/metainfo/eu.jumplink.Lotse.metainfo.xml"
install -Dm644 "$here/data/icons/hicolor/scalable/apps/eu.jumplink.Lotse.svg" \
	"$root/icons/hicolor/scalable/apps/eu.jumplink.Lotse.svg"
install -Dm644 "$here/data/icons/hicolor/symbolic/apps/eu.jumplink.Lotse-symbolic.svg" \
	"$root/icons/hicolor/symbolic/apps/eu.jumplink.Lotse-symbolic.svg"

# The two caches are what a desktop shell actually reads. Both tools are optional:
# without `update-desktop-database` the entry still launches, it just does not
# re-sort until something else rebuilds the cache — so a missing tool is a note,
# not a failure. `gtk-update-icon-cache` is per-theme and only the hicolor dir
# changed, hence the argument.
if command -v update-desktop-database >/dev/null 2>&1; then
	update-desktop-database -q "$root/applications"
else
	echo "update-desktop-database not found: launcher works, menu order may lag" >&2
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
	gtk-update-icon-cache -qtf "$root/icons/hicolor" || :
else
	echo "gtk-update-icon-cache not found: icons are found by path, cache stays stale" >&2
fi

echo "installed desktop entry, metainfo and icons under $root"
echo "Exec=lotse-app is a binary this install does NOT create — see data/README.md"