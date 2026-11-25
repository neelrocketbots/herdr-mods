import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectDir, pickAgents, CHUNK, FILES, parseFiles, parseMeta, newState, feed, list, summary } from "../mods/agent-tasks/tasks.js";

const J = (o) => JSON.stringify(o);
const create = (useId, input, side = false) => J({ type: "assistant", isSidechain: side, message: { content: [{ type: "tool_use", id: useId, name: "TaskCreate", input }] } });
const result = (useId, task) => J({ type: "user", isSidechain: false, message: { content: [{ type: "tool_result", tool_use_id: useId, content: `Task #${task.id} created` }] }, toolUseResult: { task } });
const update = (input) => J({ type: "assistant", isSidechain: false, message: { content: [{ type: "tool_use", id: `u${Math.random()}`, name: "TaskUpdate", input }] } });
const blob = (inner) => J({ type: "api-request-blob", message: { content: JSON.parse(inner).message.content } });

test("projectDir replaces every non-alphanumeric char", () => {
  assert.equal(projectDir("/Users/a/web/.worktrees/X-1"), "-Users-a-web--worktrees-X-1");
});

test("pickAgents: the space's Claude Code agents, most recently changed first", () => {
  const agents = [
    { address: "t1", space: "A", app: "claude-code", seq: 3 },
    { address: "t2", space: "B", app: "claude-code", seq: 9 },
    { address: "t3", space: "A", app: "codex", seq: 8 },
    { address: "t4", space: "A", app: "claude-code", seq: 7 },
  ];
  assert.deepEqual(pickAgents(agents, "A").map((a) => a.address), ["t4", "t1"]);
  assert.deepEqual(pickAgents(agents, "C"), []);
});

// Runs the CHUNK script on bytes [from, to) of a file: { code, lines }.
const chunk = (path, from, to) => {
  const r = spawnSync("sh", ["-c", CHUNK, "sh", path, String(from), String(to)], { encoding: "utf8" });
  return { code: r.status, lines: r.stdout.split("\n").filter(Boolean) };
};

test("CHUNK returns task lines in a byte range, without request copies", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-tasks-"));
  const path = join(dir, "t.jsonl");
  const a = create("t1", { subject: "A b c", activeForm: "Doing" }), r = result("t1", { id: "1", subject: "A b c" });
  const noise = J({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
  const copy = J({ type: "api-request-blob", message: { content: [{ type: "tool_use", name: "TaskCreate" }] } });
  writeFileSync(path, [noise, a, copy, r, ""].join("\n"));
  const size = statSync(path).size, mid = noise.length + 1 + a.length + 1;
  assert.deepEqual(chunk(path, 0, mid), { code: 0, lines: [a] });
  assert.deepEqual(chunk(path, mid, size), { code: 0, lines: [r] });
  assert.equal(chunk(path, mid + copy.length + 1, size).code, 0);
});

test("CHUNK refuses a range that ends mid-line (exit 3), so nothing is lost", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-tasks-"));
  const path = join(dir, "t.jsonl");
  const a = create("t1", { subject: "A" });
  writeFileSync(path, a + "\n" + a.slice(0, 20));
  const r = chunk(path, 0, statSync(path).size);
  assert.equal(r.code, 3);
  assert.deepEqual(r.lines, []);
});

test("CHUNK with no task lines exits 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-tasks-"));
  const path = join(dir, "t.jsonl");
  writeFileSync(path, J({ type: "user", message: { content: [] } }) + "\n");
  assert.equal(chunk(path, 0, statSync(path).size).code, 1);
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

test("a subagent state replays sidechain lines; the main one skips them", () => {
  const lines = [create("s1", { subject: "Sub task", activeForm: "Subbing" }, true),
    J({ type: "user", isSidechain: true, message: { content: [{ type: "tool_result", tool_use_id: "s1" }] }, toolUseResult: { task: { id: "1", subject: "Sub task" } } })];
  assert.deepEqual(list(feed(newState({ sidechain: true }), lines)).map((t) => t.subject), ["Sub task"]);
  assert.deepEqual(list(feed(newState(), lines)), []);
});

test("FILES lists the transcript and its subagents' (paths with spaces); parseFiles reads it", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent tasks "));
  const main = join(dir, "abc.jsonl");
  writeFileSync(main, "x\n");
  mkdirSync(join(dir, "abc", "subagents"), { recursive: true });
  writeFileSync(join(dir, "abc", "subagents", "agent-1.jsonl"), "yy\n");
  writeFileSync(join(dir, "abc", "subagents", "agent-1.meta.json"), "{}");
  const out = spawnSync("sh", ["-c", FILES, "sh", main], { encoding: "utf8" }).stdout;
  const files = parseFiles(out);
  assert.deepEqual(files.map((f) => [f.path, f.size]), [[main, 2], [join(dir, "abc", "subagents", "agent-1.jsonl"), 3]]);
  assert.ok(files.every((f) => f.mtime > 1e12)); // ms
  assert.deepEqual(parseFiles(spawnSync("sh", ["-c", FILES, "sh", join(dir, "none.jsonl")], { encoding: "utf8" }).stdout), []);
});

test("parseMeta: description and finished, tolerant of junk", () => {
  assert.deepEqual(parseMeta('{"description":"Check logs","finished":true,"agentType":"x"}'), { label: "Check logs", finished: true });
  assert.deepEqual(parseMeta('{"agentType":"Explore"}'), { label: "Explore", finished: false });
  assert.deepEqual(parseMeta("nope"), { label: "subagent", finished: false });
});
