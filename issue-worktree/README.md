# issue-worktree

A side panel (or, in layouts without a slot for it, a dialog) for working one git worktree per issue: name it after the Linear issue,
and it makes `<repo>/.worktrees/<name>` on a branch of that name, from a fresh
`origin/master`, and opens a space there. Below, every existing worktree with
its PR and CI, ready to open, rename or remove.

![The New worktree dialog: the name WEB-140, then four worktrees with PR state, CI dots, open, editor, rename and remove, one asking to confirm Remove](screenshot.png)

## What it does

- **Create**: type a name (`WEB-140`), Enter. Fetches `origin/master`, adds the
  worktree, opens a space with a terminal in it. A name that exists opens it instead.
  A prefix is kept on the branch only: `hotfix/WEB-140` makes branch
  `hotfix/WEB-140` in `.worktrees/WEB-140`.
- **List**: every worktree of the repo (not the main checkout), newest commit
  first, filtered as you type, including ones nested deeper
  (`.worktrees/WEB-140/web`) or outside `.worktrees/`. Each row is titled by its
  folder, with the branch under it when that says more, then its PR (`#482 open`, `draft`,
  `merged`) with a CI dot, its Linear issue's status when there's a Linear API
  key ([setup](../README.md#linear-issue-status-optional); click opens the issue), `open` when a space shows
  it, else how long since its last commit.
- **Click a row**: go to its space, or open one there.
- **Editor icon**: open the worktree in your editor.
- **rename**: rename the branch; optionally move the folder to
  `.worktrees/<last part of the new name>` too (closes and reopens its space). Warns when the branch
  was pushed: the remote keeps the old name.
- **remove**: removes the worktree, its local branch and its space, after a
  confirm that warns about uncommitted changes and names anything still running
  in the folder (a dev server, a shell). If a removal stopped partway, the next
  one clears the leftover files (only inside `.worktrees/`). Removing or moving
  a nested worktree also deletes the parent folders it leaves empty, never
  `.worktrees/` itself.

As a panel (the layout's `panel-body` child `worktrees`, next to Files, Changes
and PRs) it follows the focused terminal's repo and stays open while you work;
the quick-links Worktree button toggles it. Without that slot, the button and
⌘⌥N open it as a dialog.

All worktrees' PRs come from one GitHub request, and their Linear statuses from
one Linear request, both remembered for a minute between opens.

## Install

```sh
sh install.sh issue-worktree
```

Or ask your Herdr agent to add this folder. Open it with **⌘⌥N** (from
`keys.json`), the Worktree button of `quick-links`, or `mod.open:issue-worktree`.

## Settings

`editor` in `~/.config/herdr-app/herdr-mods.json` picks the editor. The base
branch is `BASE` at the top of `main.js` (`origin/master`).

## What it runs

`git fetch`, `git worktree add/move/remove`, `git branch -m/-D`, `git status`;
`gh api graphql` (GitHub, with `gh`'s login); your editor. When the repo doesn't
already ignore `.worktrees/`, it appends that line to `.git/info/exclude`.
With a Linear key: `security` reads it from the Keychain, `curl` asks Linear's API.

How it's built: [RECIPE.md](RECIPE.md). Part of [herdr-mods](../README.md).
