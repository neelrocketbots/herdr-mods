#!/bin/sh
# Static checks for CI and before a commit (no Herdr app needed):
# every mod script parses, every JSON file is valid, the shared helpers are
# identical copies, the custom-herdr bundle matches the units, and every unit
# has its RECIPE.md and preview.png.
set -eu
cd "$(dirname "$0")/.."
fail=0
err() { echo "FAIL: $*" >&2; fail=1; }

for f in */mods/*/*.js; do node --check "$f" 2>/dev/null || err "$f doesn't parse"; done
for f in $(git ls-files '*.json'); do jq empty "$f" 2>/dev/null || err "$f isn't valid JSON"; done
for helper in editor.js ci.js; do
	n=$(for f in */mods/*/"$helper"; do [ -f "$f" ] && shasum "$f" | cut -d' ' -f1; done | sort -u | wc -l | tr -d ' ')
	[ "$n" -le 1 ] || err "copies of $helper differ (keep them identical)"
done
for dir in custom-herdr/mods/*/; do
	name=$(basename "$dir")
	if [ -d "$name/mods/$name" ]; then diff -r -q "$name/mods/$name" "$dir" >/dev/null || err "custom-herdr/mods/$name differs from $name/ (run scripts/pull.sh)"
	else err "custom-herdr/mods/$name has no unit folder"; fi
done
for dir in */mods; do
	unit=$(dirname "$dir")
	[ -f "$unit/RECIPE.md" ] || err "$unit has no RECIPE.md"
	[ -f "$unit/preview.png" ] || err "$unit has no preview.png"
done
[ "$fail" = 0 ] && echo "all checks passed"
exit "$fail"
