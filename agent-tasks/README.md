# agent-tasks

The task list of the Claude Code session working in the space you're in, live,
in the sidebar above Usage: what's done, what it's doing now, what's next. It
reads the list Claude Code already keeps, so there's nothing to set up.

![The sidebar's Tasks block: three done tasks folded into one row, the task in progress with what the agent is doing, and three next](screenshot.png)

## What it does

- **Which session**: the running Claude Code session in the shown space. A
  session belongs to the space whose folder is the closest match for its own,
  so a worktree's session shows in the worktree's space, not in the repo's or
  `~/Dev`'s. Several in one space: the one active most recently.
- **The list**: done tasks fold into "✓ 3 done" (click to see them); the task
  in progress is highlighted with a spinner and what the agent says it's doing
  ("Running the billing tests…"); next tasks one line each, the full text and
  description in the tooltip. Long lists scroll after about six rows.
- **Header**: "Tasks · <the agent's title>", a progress bar and `done/total`.
  Click it to fold the block to just that line (remembered).
- **Ended**: no session running in the space, but one ran in its folder in the
  last day: its last list, faded, "ended 2h ago".
- **Nothing to show** (no session, or no task list): the block hides.
- Follows each change within about 2 seconds, and not while the Herdr window
  is minimized, hidden or covered.

## Install

```sh
sh install.sh agent-tasks
```

Or ask your Herdr agent to add this folder. Then add a block to your layout's
sidebar column, above Usage (`custom-herdr` has it):

```json
{ "id": "tasks", "type": "block", "size": { "px": 120 }, "hidden": true,
  "content": { "mod": "agent-tasks", "props": { "block": "tasks" } } }
```

It sizes the block to its rows, and shows and hides it.

## What it runs

`sh`, `tr` and `ps` to find the running sessions in `~/.claude/sessions` (one
small JSON file per session), `stat`, `tail`, `head` and `grep` to read the new
end of that session's transcript in `~/.claude/projects`, `ls` for an ended
one. No network. It never writes anything under `~/.claude`.

## Limits

- Claude Code only (Codex plans aren't read).
- One session per space.
- An ended session is found only if it ran in the space's own folder, not a
  subfolder.
- Read-only: you can't tick tasks here.

How it's built: [RECIPE.md](RECIPE.md). Part of [herdr-mods](../README.md).
