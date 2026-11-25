import { test } from "node:test";
import assert from "node:assert/strict";
import { splitBlocks, inline } from "../mods/files-md/markdown-blocks.js";

const kinds = (parts) => parts.map((p) => Object.keys(p).find((k) => k !== "line"));

test("fenced code becomes a code part with its language; indented code stays markdown", () => {
  const parts = splitBlocks(["Intro", "```js", "const x = 1;", "```", "", "    indented", "End"].join("\n"));
  assert.deepEqual(kinds(parts), ["md", "code", "md"]);
  assert.deepEqual(parts[1].code, { lang: "js", text: "const x = 1;" });
  assert.ok(parts[2].md.includes("    indented"));
});

test("an unclosed fence runs to the end; tildes work", () => {
  assert.deepEqual(splitBlocks("~~~\na\nb").map((p) => p.code), [{ lang: "", text: "a\nb" }]);
});

test("GitHub alerts become alert parts", () => {
  const parts = splitBlocks(["> [!WARNING]", "> Careful **now**", "> second line", "", "> plain quote"].join("\n"));
  assert.deepEqual(kinds(parts), ["alert", "md"]);
  assert.deepEqual(parts[0].alert, { kind: "warning", md: "Careful **now**\nsecond line" });
  assert.ok(parts[1].md.includes("> plain quote"));
});

test("<details> becomes a details part with its summary", () => {
  const parts = splitBlocks(["<details>", "<summary>More info</summary>", "", "hidden *text*", "</details>", "after"].join("\n"));
  assert.deepEqual(kinds(parts), ["details", "md"]);
  assert.deepEqual(parts[0].details, { summary: "More info", md: "hidden *text*" });
});

test("definition lists become deflist parts", () => {
  const parts = splitBlocks(["Term one", ": First def", ": Second def", "", "Term two", ": Its def"].join("\n"));
  assert.deepEqual(kinds(parts), ["deflist"]);
  assert.deepEqual(parts[0].deflist, [{ term: "Term one", defs: ["First def", "Second def"] }, { term: "Term two", defs: ["Its def"] }]);
});

test("task lines keep absolute line numbers after other blocks", () => {
  const parts = splitBlocks(["```", "x", "```", "- [ ] after code"].join("\n"));
  assert.deepEqual(kinds(parts), ["code", "tasks"]);
  assert.equal(parts[1].tasks[0].line, 3);
});

test("footnotes: references numbered by first use, definitions gathered at the end", () => {
  const parts = splitBlocks(["See this[^b] and that[^a], again[^b].", "", "[^a]: Note A", "[^b]: Note B", "", "```", "[^c]: not a note", "```"].join("\n"));
  assert.equal(parts[0].md.trim(), "See this¹ and that², again¹.");
  assert.deepEqual(parts.at(-1).footnotes, [{ n: 1, md: "Note B" }, { n: 2, md: "Note A" }]);
  assert.ok(parts.some((p) => p.code?.text === "[^c]: not a note"));
});

test("inline: emoji, kbd, sub/sup, HTML tables; code spans left alone", () => {
  assert.equal(inline("Ship it :rocket: :nope:"), "Ship it 🚀 :nope:");
  assert.equal(inline("<kbd>Cmd</kbd>+<kbd>K</kbd>"), "`Cmd`+`K`");
  assert.equal(inline("H<sub>2</sub>O and x<sup>2</sup>, e<sup>-n</sup>, <sup>abc</sup>"), "H₂O and x², e⁻ⁿ, abc");
  assert.equal(inline("`:rocket: <kbd>x</kbd>` stays"), "`:rocket: <kbd>x</kbd>` stays");
  assert.equal(inline("<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>"),
    "\n| A | B |\n| --- | --- |\n| 1 | 2 |\n");
});
