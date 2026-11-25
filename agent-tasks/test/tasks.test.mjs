import { test } from "node:test";
import assert from "node:assert/strict";
import { projectDir, ownerFolder, pickSession, newState, feed, list, summary } from "../mods/agent-tasks/tasks.js";

const J = (o) => JSON.stringify(o);
const create = (useId, input, side = false) => J({ type: "assistant", isSidechain: side, message: { content: [{ type: "tool_use", id: useId, name: "TaskCreate", input }] } });
const result = (useId, task) => J({ type: "user", isSidechain: false, message: { content: [{ type: "tool_result", tool_use_id: useId, content: `Task #${task.id} created` }] }, toolUseResult: { task } });
const update = (input) => J({ type: "assistant", isSidechain: false, message: { content: [{ type: "tool_use", id: `u${Math.random()}`, name: "TaskUpdate", input }] } });
const blob = (inner) => J({ type: "api-request-blob", message: { content: JSON.parse(inner).message.content } });

test("projectDir replaces every non-alphanumeric char", () => {
  assert.equal(projectDir("/Users/a/web/.worktrees/X-1"), "-Users-a-web--worktrees-X-1");
});

test("ownerFolder picks the longest containing folder", () => {
  const folders = ["/u/Dev", "/u/Dev/web", "/u/Dev/web/.worktrees/X", "/u/Dev/webapp"];
  assert.equal(ownerFolder("/u/Dev/web/.worktrees/X/src", folders), "/u/Dev/web/.worktrees/X");
  assert.equal(ownerFolder("/u/Dev/web/src", folders), "/u/Dev/web");
  assert.equal(ownerFolder("/u/Dev/webapp", folders), "/u/Dev/webapp");
  assert.equal(ownerFolder("/u/Dev/other", folders), "/u/Dev");
  assert.equal(ownerFolder("/tmp", folders), null);
});

test("pickSession: live, owned by the space, newest; dead pids ignored", () => {
  const folders = ["/u/Dev", "/u/Dev/web", "/u/Dev/web/.worktrees/X"];
  const sessions = [
    { pid: 1, sessionId: "a", cwd: "/u/Dev/web/.worktrees/X", updatedAt: 5 },
    { pid: 2, sessionId: "b", cwd: "/u/Dev/web/.worktrees/X/sub", updatedAt: 9 },
    { pid: 3, sessionId: "c", cwd: "/u/Dev/web/.worktrees/X", updatedAt: 99 },
    { pid: 4, sessionId: "d", cwd: "/u/Dev/web", updatedAt: 50 },
  ];
  const alive = new Set(["1", "2", "4"]); // 3 crashed, its file stayed
  assert.equal(pickSession(sessions, alive, "/u/Dev/web/.worktrees/X", folders).sessionId, "b");
  assert.equal(pickSession(sessions, alive, "/u/Dev/web", folders).sessionId, "d");
  assert.equal(pickSession(sessions, alive, "/u/Dev", folders), null);
});

test("feed/list: create, update, rename, delete, sidechain and request copies", () => {
  const lines = [
    create("t1", { subject: "Read code", description: "d1", activeForm: "Reading code" }),
    result("t1", { id: "1", subject: "Read code", description: "d1" }),
    create("t2", { subject: "Write test", description: "d2", activeForm: "Writing the test" }),
    result("t2", { id: "2", subject: "Write test", description: "d2" }),
    create("t3", { subject: "Old idea", description: "", activeForm: "" }),
    result("t3", { id: "3", subject: "Old idea", description: "" }),
    create("s1", { subject: "Subagent task", description: "", activeForm: "" }, true),
    update({ taskId: "1", status: "completed" }),
    update({ taskId: "2", status: "in_progress", subject: "Write the failing test" }),
    update({ taskId: "3", status: "deleted" }),
    blob(update({ taskId: "1", status: "pending" })),
    "not json",
  ];
  const tasks = list(feed(newState(), lines));
  assert.deepEqual(tasks.map((t) => [t.id, t.subject, t.status]), [
    ["1", "Read code", "completed"],
    ["2", "Write the failing test", "in_progress"],
  ]);
  assert.equal(tasks[1].activeForm, "Writing the test");
});

test("feed is incremental, and an update before its create's result still applies", () => {
  const state = newState();
  feed(state, [create("t1", { subject: "A", description: "", activeForm: "Doing A" })]);
  assert.equal(list(state).length, 0);
  feed(state, [update({ taskId: "1", status: "in_progress" }), result("t1", { id: "1", subject: "A", description: "" })]);
  assert.deepEqual(list(state).map((t) => t.status), ["in_progress"]);
});

test("a fresh state after a reset forgets old tasks", () => {
  const state = feed(newState(), [create("t1", { subject: "A" }), result("t1", { id: "1", subject: "A" })]);
  assert.equal(list(state).length, 1);
  assert.equal(list(newState()).length, 0);
});

test("summary counts and groups", () => {
  const s = summary([
    { id: "1", status: "completed" }, { id: "2", status: "in_progress" },
    { id: "3", status: "pending" }, { id: "4", status: "completed" },
  ]);
  assert.equal(s.done, 2); assert.equal(s.total, 4);
  assert.deepEqual([s.completed, s.current, s.pending].map((g) => g.map((t) => t.id)), [["1", "4"], ["2"], ["3"]]);
});
