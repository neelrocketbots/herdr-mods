// Pure helpers for agent-tasks (no Herdr imports, so `node --test` can load
// them): which Claude Code session belongs to a space, and its task list
// rebuilt from transcript lines, a chunk at a time.

// Lines worth parsing: task calls and their results. The caller also drops
// "api-request-*" lines (copies of whole requests, up to ~150KB each).
export const TASK_GREP = '"name":"Task(Create|Update)"|"task":\\{"id"';

// Claude Code's folder under ~/.claude/projects for a cwd.
export const projectDir = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, "-");

const inside = (path, folder) => path === folder || path.startsWith(folder.endsWith("/") ? folder : `${folder}/`);

// The longest of `folders` that holds `path`, or null.
export function ownerFolder(path, folders) {
  let best = null;
  for (const f of folders) if (f && inside(path, f) && (!best || f.length > best.length)) best = f;
  return best;
}

// The space's session: running (pid in `alive`), its cwd owned by `folder`,
// the most recently updated.
export function pickSession(sessions, alive, folder, folders) {
  return sessions
    .filter((s) => s && typeof s.cwd === "string" && s.sessionId && alive.has(String(s.pid)) && ownerFolder(s.cwd, folders) === folder)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0] ?? null;
}

export const newState = () => ({ tasks: new Map(), pending: new Map(), early: new Map() });

const FIELDS = ["subject", "description", "activeForm", "status"];
const apply = (task, input) => { for (const k of FIELDS) if (typeof input[k] === "string") task[k] = input[k]; };

// Adds transcript lines to `state`. A TaskCreate gets its id from its result
// line; an update seen before that waits in `early`.
export function feed(state, lines) {
  for (const line of lines) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (!d || d.isSidechain || !Array.isArray(d.message?.content)) continue;
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
