#!/bin/sh
# Renders the README images and each unit's marketplace preview.png from these
# mockups (made-up data) with headless Chrome at 2x.
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
shot "file://$here/overview.html" "$repo/docs/overview.png" 1400 820
shot "file://$here/worktree.html" "$repo/docs/worktree.png" 568 620
shot "file://$here/files.html" "$repo/docs/files.png" 488 524
for unit in quick-links issue-worktree pr-inbox files-md changes-editor custom-herdr; do
	shot "file://$here/card.html?unit=$unit" "$repo/$unit/preview.png" 1600 800
done
