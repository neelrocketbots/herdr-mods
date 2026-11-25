import { test } from "node:test";
import assert from "node:assert/strict";
import { splitTasks, toggleTask } from "../mods/files-md/markdown-tasks.js";

test("splitTasks lifts task lines out, with their line numbers, indent and state", () => {
  const md = ["# Plan", "", "- [ ] Write tests", "- [x] Read code", "  - [X] nested done", "* [ ] star bullet", "1. [ ] numbered", "", "Text after."].join("\n");
  assert.deepEqual(splitTasks(md), [
    { md: "# Plan\n" },
    { tasks: [
      { line: 2, indent: 0, checked: false, text: "Write tests" },
      { line: 3, indent: 0, checked: true, text: "Read code" },
      { line: 4, indent: 1, checked: true, text: "nested done" },
      { line: 5, indent: 0, checked: false, text: "star bullet" },
      { line: 6, indent: 0, checked: false, text: "numbered" },
    ] },
    { md: "\nText after." },
  ]);
});

test("splitTasks leaves code blocks and look-alikes alone", () => {
  const md = ["```md", "- [ ] in a fence", "```", "- [] not a task", "-[ ] no space", "- [ ]", "- [ ] real"].join("\n");
  const parts = splitTasks(md);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].md, ["```md", "- [ ] in a fence", "```", "- [] not a task", "-[ ] no space", "- [ ]"].join("\n"));
  assert.deepEqual(parts[1].tasks.map((t) => [t.line, t.text]), [[6, "real"]]);
});

test("splitTasks with no tasks is one markdown part", () => {
  assert.deepEqual(splitTasks("just text\n- a list"), [{ md: "just text\n- a list" }]);
});

test("toggleTask flips only that line's box, and refuses a changed line", () => {
  const text = "a\n- [ ] one [ ] keep\n  - [x] two\n";
  assert.equal(toggleTask(text, { line: 1, checked: false, text: "one [ ] keep" }), "a\n- [x] one [ ] keep\n  - [x] two\n");
  assert.equal(toggleTask(text, { line: 2, checked: true, text: "two" }), "a\n- [ ] one [ ] keep\n  - [ ] two\n");
  assert.equal(toggleTask(text, { line: 1, checked: true, text: "one [ ] keep" }), null);   // state moved on
  assert.equal(toggleTask(text, { line: 1, checked: false, text: "other" }), null);         // line changed
  assert.equal(toggleTask("a\r\n- [ ] crlf\r\n", { line: 1, checked: false, text: "crlf" }), "a\r\n- [x] crlf\r\n");
});
