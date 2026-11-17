#!/bin/sh
# Copies the live mods and layout from the Herdr app back into this repo, after
# editing them in place (the app hot-reloads ~/.config/herdr-app). Each unit's
# mods come from the app; the custom-herdr bundle's copies come from the units.
# Your own herdr-mods.json is never copied. Review with `git diff`, then commit.
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
home=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
sync() { rsync -a --delete --exclude gpui-kit.d.ts --exclude jsconfig.json --exclude node_modules --exclude '.*' "$1" "$2"; }

for dir in "$repo"/*/mods/*/; do
	unit=$(basename "$(dirname "$(dirname "$dir")")")
	name=$(basename "$dir")
	[ "$unit" = custom-herdr ] && continue
	if [ -d "$home/mods/$name" ]; then sync "$home/mods/$name/" "$dir"; else echo "skip $name: not in $home/mods" >&2; fi
done
for dir in "$repo"/custom-herdr/mods/*/; do
	name=$(basename "$dir")
	[ -d "$repo/$name/mods/$name" ] && sync "$repo/$name/mods/$name/" "$dir"
done
for file in "$repo"/custom-herdr/layouts/*; do
	src="$home/layouts/$(basename "$file")"
	[ -f "$src" ] && cp "$src" "$file"
done
git -C "$repo" status --short
