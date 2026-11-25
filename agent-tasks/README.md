# agent-tasks

The task list of the Claude Code session working in the space you're in, live,
in the sidebar above Usage: what's done, what it's doing now, what's next. It
reads the list Claude Code already keeps, so there's nothing to set up.

![The sidebar's Tasks block: three done tasks folded into one row, the task in progress with what the agent is doing, and three next](screenshot.png)

## What it does

- **Which session**: the Claude Code running in one of the shown space's
  terminals (matched by its process, so it's always the space's own, whatever
  folder the space starts in). Several in one space: the most recently active
  one with a task list. Claude config folders other than `~/.claude` (like
  `~/.claude2` via `CLAUDE_CONFIG_DIR`) work too.
- **The list**: done tasks fold into "✓ 3 done" (click to see them); the task
  in progress is highlighted with a spinner and what the agent says it's doing
  ("Running the billing tests…"); next tasks one line each, the full text and
  description in the tooltip. Long lists scroll after about six rows.
- **Header**: "Tasks · <the agent's title>", a progress bar and `done/total`.
  Click it to fold the block to just that line (remembered).
- **Ended**: the space's last session with a task list, once it's no longer
  running, if it changed in the last day: its last list, faded, "ended 2h ago".
- **Nothing to show** (no session, or no task list): the block shrinks to 0.
- Follows each change within about 2 seconds and switches with the space at
  once; nothing while the Herdr window is minimized, hidden or covered.

## Install

```sh
sh install.sh agent-tasks
```

Or ask your Herdr agent to add this folder. Then add a block to your layout's
sidebar column, above Usage (`custom-herdr` has it):

```json
{ "id": "tasks", "type": "block", "size": { "px": 0 },
  "content": { "mod": "agent-tasks", "props": { "block": "tasks" } } }
```

It sizes the block to its rows, and back to 0 when there's nothing to show.
Don't add it hidden: Herdr starts a block's mod only once it shows.

## What it runs

`hc get` for the process in each of the space's Claude terminals, then that
session's small JSON file in `~/.claude*/sessions`; `stat`, `tail`, `head`,
`od` and `grep` to read the new end of its transcript in
`~/.claude*/projects`; `sh` to list the `~/.claude*` folders. No network. It
never writes anything under `~/.claude*`.

## Limits

- Claude Code only (Codex plans aren't read).
- One session per space.
- An ended session is remembered only once the block has seen it running.
- Only Claude Code terminals Herdr recognizes as agents.
- Read-only: you can't tick tasks here.

How it's built: [RECIPE.md](RECIPE.md). Part of [herdr-mods](../README.md).
