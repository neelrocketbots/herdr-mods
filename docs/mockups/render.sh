#!/bin/sh
# Renders each unit's screenshot.png (README) and preview.png (marketplace card)
# from these mockups (made-up data) with headless Chrome at 2x.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
chrome=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
shot() { # shot <url> <out> <width> <height>
	"$chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
		--allow-file-access-from-files --virtual-time-budget=2000 \
		--default-background-color=00000000 --window-size="$3,$4" --screenshot="$2" "$1" >/dev/null 2>&1
	echo "${2#"$repo"/}"
}
# Each unit's screenshot.png: the UI on its own (READMEs).
shot "file://$here/topbar.html" "$repo/quick-links/screenshot.png" 920 160
shot "file://$here/worktree.html" "$repo/issue-worktree/screenshot.png" 460 510
shot "file://$here/prinbox.html" "$repo/pr-inbox/screenshot.png" 440 510
shot "file://$here/files.html" "$repo/files-md/screenshot.png" 488 524
shot "file://$here/changes.html" "$repo/changes-editor/screenshot.png" 460 510
shot "file://$here/usage.html" "$repo/usage-limits/screenshot.png" 310 215
shot "file://$here/overview.html" "$repo/custom-herdr/screenshot.png" 1400 820
# Each unit's preview.png: the marketplace card.
for unit in quick-links issue-worktree pr-inbox files-md changes-editor usage-limits custom-herdr; do
	shot "file://$here/card.html?unit=$unit" "$repo/$unit/preview.png" 1600 800
done
