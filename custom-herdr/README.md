# custom-herdr

Herdr's main layout with the whole kit wired in: `quick-links` in the top bar,
`files-md`, `changes-editor`, `pr-inbox` and `issue-worktree` as the side panels, `agent-tasks`
and `usage-limits` at the bottom of the sidebar, and shortcuts for
the Worktrees panel and the PR inbox.

![The custom-herdr layout: spaces with their worktrees and agents on the left, a focused Claude Code pane over a faded shell, quick links in the top bar and the PR inbox open on the right](screenshot.png)

## What's in it

- `layouts/custom-herdr.json`: Herdr's `main` layout with a `quick-links` block
  after the tabs, and the side panel stack (`panel-body`) holding `files`
  (`files-md`), `changes` (`changes-editor`), `prs` (`pr-inbox`) and
  `worktrees` (`issue-worktree`). The Files, Changes, PRs and Worktree buttons
  toggle them.
- Panes you're not in fade a little (`"veil": 0.4` on the pane frame; 0 turns it off).
- Ctrl/Cmd-clicking a file path in a terminal opens it in the Files panel
  (`"link_handlers": ["files-md"]`).
- `layouts/custom-herdr.svg`: its picture in Settings.
- A `tasks` block (`agent-tasks`) above Usage: the space's Claude Code task list, hidden when there's none.
- A `usage` block (`usage-limits`) above the sidebar footer.
- `mods/`: copies of all seven mods, so the layout installs on its own.
- `keys.json`: **⌘⌥N** worktrees panel (in this layout; the dialog elsewhere), **⌘⌥P** PR inbox.

## Install

```sh
sh install.sh custom-herdr --switch
```

Or ask your Herdr agent: *Read ~/.config/herdr-app/AGENTS.md, then add this
layout:* this folder. Switch back to Herdr's own with **ctrl-shift-l** or
Settings; deleting the files removes it.

## Settings

`~/.config/herdr-app/herdr-mods.json`: `editor` and `linear` (see the
[root README](../README.md#settings-configherdr-appherdr-modsjson)).

How it's built: [RECIPE.md](RECIPE.md). Part of [herdr-mods](../README.md).
