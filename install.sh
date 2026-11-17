#!/bin/sh
# Installs units of this repo into the Herdr app.
#
#   sh install.sh                    every unit, including the custom-herdr layout
#   sh install.sh pr-inbox files-md  only those units
#   sh install.sh --switch           ...and switch the window to custom-herdr
#
# A unit is a folder with mods/<name>/, maybe layouts/ and keys.json. Its mods
# replace ones of the same name (the app hot-reloads them). A layout file that
# differs is kept as <file>.bak-<time> first. keys.json bindings are added to
# yours; a key you already use for something else is left alone and listed.
# Your settings, herdr-mods.json in the app folder, are made from
# herdr-mods.example.json only when missing.
#
# The app folder is $HERDR_APP_HOME, else ~/.config/herdr-app.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
home=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
command -v herdr-app >/dev/null 2>&1 || { echo "herdr-app isn't on PATH: install the Herdr app first" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "jq is needed to merge keys.json" >&2; exit 1; }
[ -d "$home" ] || { echo "no Herdr app folder at $home" >&2; exit 1; }

switch=no units=""
for arg in "$@"; do
	case $arg in
		--switch) switch=yes ;;
		*) [ -d "$here/$arg/mods" ] || { echo "no unit named $arg" >&2; exit 1; }; units="$units $arg" ;;
	esac
done
if [ -z "$units" ]; then
	for dir in "$here"/*/mods; do units="$units $(basename "$(dirname "$dir")")"; done
fi

for unit in $units; do
	src="$here/$unit"
	for dir in "$src"/mods/*/; do
		name=$(basename "$dir")
		mkdir -p "$home/mods/$name"
		rsync -a "$dir" "$home/mods/$name/"
		herdr-app check "$home/mods/$name" >/dev/null || { echo "$unit: mod $name failed herdr-app check" >&2; exit 1; }
	done
	if [ -d "$src/layouts" ]; then
		mkdir -p "$home/layouts"
		for file in "$src"/layouts/*; do
			target="$home/layouts/$(basename "$file")"
			[ -f "$target" ] && ! cmp -s "$file" "$target" && cp "$target" "$target.bak-$(date +%Y%m%d%H%M%S)"
			cp "$file" "$target"
		done
	fi
	if [ -f "$src/keys.json" ]; then
		[ -f "$home/keys.json" ] || echo '{}' > "$home/keys.json"
		jq -r -s '.[0] as $mine | .[1] | to_entries[] | .key as $s | .value | to_entries[]
			| select(($mine[$s][.key] // null) != null and $mine[$s][.key] != .value)
			| "  \($s) \(.key) is already \($mine[$s][.key]); not bound to \(.value)"' \
			"$home/keys.json" "$src/keys.json"
		jq -s '.[0] as $mine | reduce (.[1] | to_entries[]) as $sec ($mine;
			reduce ($sec.value | to_entries[]) as $k (.; if (.[$sec.key][$k.key] // null) == null then .[$sec.key][$k.key] = $k.value else . end))' \
			"$home/keys.json" "$src/keys.json" > "$home/keys.json.tmp" && mv "$home/keys.json.tmp" "$home/keys.json"
	fi
	echo "installed $unit"
done

if [ ! -f "$home/herdr-mods.json" ]; then
	cp "$here/herdr-mods.example.json" "$home/herdr-mods.json"
	echo "Created $home/herdr-mods.json: set your editor and Linear workspace there (see the README)."
fi

if [ "$switch" = yes ]; then
	herdr-app do layout.switch --name custom-herdr >/dev/null
	echo "Switched to the custom-herdr layout."
fi
