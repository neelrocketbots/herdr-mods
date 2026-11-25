# Agent tasks

A sidebar block showing the task list (TaskCreate / TaskUpdate) of the Claude
Code session working in the shown space: done, now, next. Read-only, live.

![Agent tasks](preview.png)

## What you see

- A block on `chrome` with a 1px `border` line on top, 10px side padding,
  above the usage-limits block.
- Header, 11px `dim` (`foreground` on hover): "Tasks", "· <label>" truncated,
  a 44×3px bar on `input` filled in `ansi2` to done/total, `done/total`, and
  ▾/▸. Clicking it folds the block to the header; kept in localStorage
  (`agent-tasks.collapsed`).
- Rows, 12px, 8px gaps, a 13px mark column:
  - "✓ N done" in `dim` with ▸/▾: click to list the done tasks (✓ in `ansi2`,
    subject in `dim`, one line).
  - In progress: `raised` background, 6px corners, the spinner (`working`,
    else `ansi3`) turning, the subject in `foreground` wrapping, then its
    `activeForm` + "…" in 11px `working`.
  - Pending: an 11px ring in `dim`, subject in `muted`, one line.
  - Tooltip on every task: subject, a blank line, description.
- The rows scroll past 168px (about six).
- Ended session: label "· last session · ended 2h ago", rows at 0.6 opacity,
  no spinner turning, no activeForm.
- Label: the Herdr agent title of the Claude pane in that space whose folder
  is the session's cwd (`agents()` + `panes()`), else the session's `name`.

## How it behaves

- Every 2s while `window()?.visible` isn't false, one read at a time (the read
  is a stored `Task`, checked with `is_done()`).
- Sessions: `~/.claude/sessions/<pid>.json`, one per running Claude Code
  (`{ pid, sessionId, cwd, name, status, updatedAt }`), read by one `sh` (`tr`
  strips their newlines, so one per line). A file can outlive a crash, so
  pids are checked with `ps -o pid= -p`.
- The space: the active one in `spaces()`; another machine's: nothing. Its
  folder, empty meaning home. A session belongs to the space whose folder is
  the longest prefix of its cwd, among all this machine's spaces; of the
  space's sessions, the latest `updatedAt`.
- Transcript: `~/.claude/projects/<cwd, every non-alphanumeric char → "-">/<sessionId>.jsonl`.
- Reading it: `stat -f "%z %m"`; when it grew, only bytes `[offset, size)` via
  `tail -c +N | head -c M`, then `grep -E` for task calls and results and
  `grep -v '"type":"api-request'`. Those request lines are copies of whole API
  requests (up to ~150KB) that repeat earlier tool calls; replaying them would
  undo updates. A smaller file than the offset starts over from 0. Offsets and
  replay state live in module scope per transcript.
- Replay (`tasks.js`, pure, tested with `node --test`): an `assistant` line's
  `tool_use` `TaskCreate` waits for the `user` line's `tool_result` with the
  same `tool_use_id`, whose `toolUseResult.task.id` is the task id; its
  `activeForm` comes from the call. `TaskUpdate` (`taskId`, `status`,
  `subject`, `description`, `activeForm`) merges; `deleted` drops it; an
  update before its create's result waits. `isSidechain` lines (subagents)
  and unparseable lines are skipped.
- No running session: the newest `.jsonl` in the space folder's own project
  dir (`ls -t`), if it changed in the last 24h and has tasks: shown as ended.
- Block: hidden (`layout.hide` on `props.block`) with nothing to show, shown
  otherwise, and sized to its content (`layout.resize`). Without
  `props.block` it leaves the layout alone.

## Watch out

- Saving a mod file reloads it in place: its timers and tasks stop, instance
  state stays. The read is a stored Task, so a killed one doesn't block the
  next tick.
- Use the `cx` that `cx.spawn` / `cx.timer` hand in; a click's or render's
  `cx` throws on `notify()` once that call returned.
- The transcript format is Claude Code's, undocumented; checked on 2.1.329 to
  2.1.332.
