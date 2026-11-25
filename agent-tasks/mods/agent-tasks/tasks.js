// Pure helpers for agent-tasks (no Herdr imports, so `node --test` can load
// them): the space's Claude agents, the shell scripts that read Claude's
// files, and a session's task list rebuilt from transcript lines, a chunk at
// a time.

// Lines worth parsing: task calls and their results.
export const TASK_GREP = '"name":"Task(Create|Update)"|"task":\\{"id"';

// Claude Code's folder under ~/.claude/projects for a cwd.
export const projectDir = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, "-");

// Claude Code config folders: ~/.claude, plus others like ~/.claude2
// (CLAUDE_CONFIG_DIR). One per line.
export const CLAUDE_DIRS = `for d in "$HOME"/.claude "$HOME"/.claude?*; do [ -d "$d" ] && printf '%s\\n' "$d"; done`;

// sh -c CHUNK sh <transcript> <from> <to>: the task lines in bytes [from, to),
// without request copies (which feed() ignores anyway, but they're up to
// ~150KB each). Exits 3, printing nothing, when byte to-1 isn't a newline
// (the read would end mid-line: try again next time); 1 when there are no
// task lines. LC_ALL=C: byte matching, ~6x faster on big files.
export const CHUNK = `[ "$(tail -c +$3 "$1" | head -c 1 | od -An -tx1 | tr -d ' \\n')" = 0a ] || exit 3
tail -c +$(($2 + 1)) "$1" | head -c $(($3 - $2)) | LC_ALL=C grep -E '${TASK_GREP}' | LC_ALL=C grep -v '"type":"api-request'`;

// sh -c FILES sh <transcript>: "size mtime path" per line for the transcript
// and each of its subagents' (<session>/subagents/agent-*.jsonl), with one
// stat call (a session can have hundreds of subagents). GNU stat (Linux)
// first, else BSD stat (macOS).
export const FILES = `t=$1; set -- "\${t%.jsonl}"/subagents/agent-*.jsonl; [ -e "$1" ] || shift; set -- "$t" "$@"
[ -e "$t" ] || exit 0
stat -c '%s %Y %n' "$@" 2>/dev/null || stat -f '%z %m %N' "$@" 2>/dev/null; true`;

// sh -c HAS_TASKS sh <files...>: the files that have task lines, one grep for
// all (subagents rarely do; their files are then skipped unread).
export const HAS_TASKS = `LC_ALL=C grep -l -E '${TASK_GREP}' "$@"; true`;

// Whether a watch's changed paths concern the shown sessions: a transcript in
// `targets`, a file under its <session>/ folder (subagents), or a watched
// folder itself (the watch's "refresh everything").
export function touches(paths, targets, dirs) {
  return paths.some((p) => dirs.includes(p) || targets.some((t) => p === t || p.startsWith(`${t.slice(0, -".jsonl".length)}/`)));
}

// FILES' output: [{ size, mtime (ms), path }].
export function parseFiles(text) {
  return text.split("\n").map((l) => l.match(/^(\d+) (\d+) (.+)$/)).filter(Boolean)
    .map(([, size, mtime, path]) => ({ size: Number(size), mtime: Number(mtime) * 1000, path }));
}

// A subagent's agent-*.meta.json: its description (else its type) and whether
// it finished.
export function parseMeta(text) {
  let m = null;
  try { m = JSON.parse(text); } catch {}
  return { label: m?.description || m?.agentType || "subagent", finished: Boolean(m?.finished) };
}

// The space's Claude Code agents (Herdr's agents()), most recently changed
// first.
export function pickAgents(agents, spaceId) {
  return agents.filter((a) => a.space === spaceId && a.app === "claude-code").sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0));
}

// sidechain: replay a subagent's transcript, whose lines are all isSidechain.
export const newState = ({ sidechain = false } = {}) => ({ tasks: new Map(), pending: new Map(), early: new Map(), sidechain });

const FIELDS = ["subject", "description", "activeForm", "status"];
const apply = (task, input) => { for (const k of FIELDS) if (typeof input[k] === "string") task[k] = input[k]; };

// Adds transcript lines to `state`. A TaskCreate gets its id from its result
// line; an update seen before that waits in `early`.
export function feed(state, lines) {
  for (const line of lines) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (!d || (d.isSidechain && !state.sidechain) || !Array.isArray(d.message?.content)) continue;
    for (const c of d.message.content) {
      if (!c || typeof c !== "object") continue;
      if (d.type === "assistant" && c.type === "tool_use" && c.name === "TaskCreate" && c.input) {
        state.pending.set(c.id, c.input);
      } else if (d.type === "assistant" && c.type === "tool_use" && c.name === "TaskUpdate" && c.input?.taskId != null) {
        const id = String(c.input.taskId), task = state.tasks.get(id);
        if (task) apply(task, c.input);
        else state.early.set(id, [...(state.early.get(id) ?? []), c.input]);
      } else if (d.type === "user" && c.type === "tool_result" && state.pending.has(c.tool_use_id)) {
        const made = d.toolUseResult?.task;
        if (made?.id == null) continue;
        const input = state.pending.get(c.tool_use_id);
        state.pending.delete(c.tool_use_id);
        const id = String(made.id);
        const task = { id, subject: made.subject ?? input.subject ?? "", description: made.description ?? input.description ?? "", activeForm: input.activeForm ?? "", status: "pending" };
        for (const u of state.early.get(id) ?? []) apply(task, u);
        state.early.delete(id);
        state.tasks.set(id, task);
      }
    }
  }
  return state;
}

// The tasks in creation order, without deleted ones.
export const list = (state) => [...state.tasks.values()].filter((t) => t.status !== "deleted");

export function summary(tasks) {
  const completed = tasks.filter((t) => t.status === "completed");
  return {
    done: completed.length, total: tasks.length, completed,
    current: tasks.filter((t) => t.status === "in_progress"),
    pending: tasks.filter((t) => t.status !== "completed" && t.status !== "in_progress"),
  };
}
