// Task list items for the markdown preview. Herdr's TextView.markdown shows
// "- [ ] x" as plain text, so task lines are lifted out (with their line
// number) and the preview draws each as a checkbox row; toggling one rewrites
// just that line's box in the file. Code blocks are left alone.

// "- [ ] text", "* [x] text", "1. [X] text", indented for nesting.
const TASK = /^(\s*)(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(\S.*)$/;

// Markdown -> [{ md: text } | { tasks: [{ line, indent, checked, text }] }].
// Consecutive task lines share a part; indent is the nesting level (2 spaces).
export function splitTasks(markdown) {
  const parts = [];
  let md = [], tasks = null, fence = null;
  const lines = markdown.split("\n");
  lines.forEach((raw, line) => {
    const text = raw.replace(/\r$/, "");
    const f = text.match(/^\s*(`{3,}|~{3,})/);
    const m = !fence && !f && text.match(TASK);
    if (f) fence = fence === null ? f[1][0] : f[1][0] === fence ? null : fence;
    if (m) {
      if (md.length) { parts.push({ md: md.join("\n") }); md = []; }
      if (!tasks) { tasks = { tasks: [] }; parts.push(tasks); }
      tasks.tasks.push({ line, indent: Math.floor(m[1].replace(/\t/g, "  ").length / 2), checked: m[2] !== " ", text: m[3] });
      return;
    }
    tasks = null;
    md.push(raw);
  });
  if (md.length && md.some((l) => l.trim())) parts.push({ md: md.join("\n") });
  return parts;
}

// `text` with task `{ line, checked, text }` flipped, or null when that line
// isn't that task in that state any more (the file changed since it was read).
export function toggleTask(text, task) {
  const lines = text.split("\n");
  const raw = lines[task.line];
  if (raw == null) return null;
  const cr = raw.endsWith("\r") ? "\r" : "";
  const m = raw.replace(/\r$/, "").match(TASK);
  if (!m || (m[2] !== " ") !== task.checked || m[3] !== task.text) return null;
  lines[task.line] = raw.replace(/\[([ xX])\]/, task.checked ? "[ ]" : "[x]").replace(/\r?$/, cr);
  return lines.join("\n");
}
