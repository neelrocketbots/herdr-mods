// What Herdr's TextView.markdown doesn't draw, done here: the preview's
// markdown is split into parts, each drawn by main.js:
//   { md }        text for TextView, after inline() fixes
//   { code }      fenced code, { lang, text }: drawn with a read-only editor
//                 (syntax colors; TextView's code blocks have none)
//   { alert }     GitHub alerts (> [!NOTE] …), { kind, md }
//   { details }   <details><summary>…</summary>…</details>, { summary, md }
//   { deflist }   "Term" then ": definition" lines, [{ term, defs }]
//   { tasks }     task list lines (markdown-tasks.js)
//   { footnotes } [^id]: notes, numbered by first reference, at the end
// Indented code, quotes, lists and the rest stay markdown.
import { splitTasks } from "./markdown-tasks.js";

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/;
const ALERT = /^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i;
const NOTE_DEF = /^\[\^([^\]\s]+)\]:\s*(.*)$/;
const NOTE_REF = /\[\^([^\]\s]+)\](?!:)/g;

const SUP = { 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹", "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ", i: "ⁱ" };
const SUB = { 0: "₀", 1: "₁", 2: "₂", 3: "₃", 4: "₄", 5: "₅", 6: "₆", 7: "₇", 8: "₈", 9: "₉", "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎" };
// Characters mapped when every one has a form; otherwise the plain text.
const script = (map, text) => ([...text].every((c) => map[c]) ? [...text].map((c) => map[c]).join("") : text);
export const sup = (n) => script(SUP, String(n));

const EMOJI = {
  rocket: "🚀", tada: "🎉", sparkles: "✨", fire: "🔥", zap: "⚡", boom: "💥", star: "⭐", heart: "❤️",
  white_check_mark: "✅", heavy_check_mark: "✔️", x: "❌", warning: "⚠️", no_entry: "⛔", stop_sign: "🛑",
  question: "❓", exclamation: "❗", information_source: "ℹ️", bulb: "💡", memo: "📝", pushpin: "📌",
  bug: "🐛", construction: "🚧", lock: "🔒", unlock: "🔓", key: "🔑", wrench: "🔧", hammer: "🔨", gear: "⚙️",
  package: "📦", truck: "🚚", recycle: "♻️", art: "🎨", lipstick: "💄", broom: "🧹", test_tube: "🧪",
  mag: "🔍", link: "🔗", books: "📚", calendar: "📅", hourglass: "⏳", chart_with_upwards_trend: "📈",
  computer: "💻", iphone: "📱", globe_with_meridians: "🌐", speech_balloon: "💬", eyes: "👀",
  "+1": "👍", "-1": "👎", thumbsup: "👍", thumbsdown: "👎", clap: "👏", pray: "🙏", ok_hand: "👌",
  muscle: "💪", wave: "👋", smile: "😄", joy: "😂", thinking: "🤔", rotating_light: "🚨",
  arrow_up: "⬆️", arrow_down: "⬇️", arrow_right: "➡️", arrow_left: "⬅️", checkered_flag: "🏁",
  trophy: "🏆", gift: "🎁", coffee: "☕", red_circle: "🔴", green_circle: "🟢", yellow_circle: "🟡",
  large_blue_circle: "🔵", white_circle: "⚪", lock_with_ink_pen: "🔏", card_file_box: "🗃️",
};

const stripTags = (s) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

// A simple HTML table (no nesting) as a markdown table; the first row heads it.
function htmlTable(html) {
  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map(([, row]) => [...row.matchAll(/<t([hd])\b[^>]*>([\s\S]*?)<\/t\1>/gi)].map(([, , cell]) => stripTags(cell).replace(/\|/g, "\\|")));
  if (!rows.length || !rows[0].length) return stripTags(html);
  const width = Math.max(...rows.map((r) => r.length));
  const line = (r) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
  return ["", line(rows[0]), `| ${Array(width).fill("---").join(" | ")} |`, ...rows.slice(1).map(line), ""].join("\n");
}

// Inline fixes for text TextView draws: emoji shortcodes, <kbd> as code,
// <sub>/<sup> as Unicode where possible, HTML tables as markdown tables.
// Code spans are left alone.
export function inline(md) {
  return md.split(/(`+[^`]*?`+)/).map((seg, i) => (i % 2 ? seg : seg
    .replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (t) => htmlTable(t))
    .replace(/<kbd>([\s\S]*?)<\/kbd>/gi, (_, k) => `\`${k}\``)
    .replace(/<sub>([\s\S]*?)<\/sub>/gi, (_, t) => script(SUB, t))
    .replace(/<sup>([\s\S]*?)<\/sup>/gi, (_, t) => script(SUP, t))
    .replace(/:([a-z0-9_+-]+):/g, (m, name) => EMOJI[name] ?? m))).join("");
}

export function splitBlocks(markdown) {
  const lines = markdown.split("\n");
  // Footnotes, outside fences: definitions (dropped from the text), then
  // numbers in order of first reference.
  const defs = new Map(), defLines = new Set(), order = new Map();
  let fence = null;
  lines.forEach((l, i) => {
    const f = l.match(FENCE);
    if (f) { fence = fence === null ? f[1][0] : f[1][0] === fence ? null : fence; return; }
    if (fence) return;
    const d = l.match(NOTE_DEF);
    if (d) { defs.set(d[1], d[2]); defLines.add(i); }
  });
  fence = null;
  lines.forEach((l, i) => {
    const f = l.match(FENCE);
    if (f) { fence = fence === null ? f[1][0] : f[1][0] === fence ? null : fence; return; }
    if (fence || defLines.has(i)) return;
    for (const [, id] of l.matchAll(NOTE_REF)) if (defs.has(id) && !order.has(id)) order.set(id, order.size + 1);
  });
  const notes = (md) => md.replace(NOTE_REF, (m, id) => (order.has(id) ? sup(order.get(id)) : m));

  const parts = [];
  let run = [], runStart = 0;
  const flush = () => {
    if (run.some((l) => l.trim())) {
      for (const p of splitTasks(run.join("\n"), runStart)) parts.push(p.md !== undefined ? { md: inline(notes(p.md)) } : p);
    }
    run = [];
  };
  const push = (part) => { flush(); parts.push(part); };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const f = l.match(FENCE);
    if (f) {
      const body = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const g = lines[j].match(/^\s*(`{3,}|~{3,})\s*$/);
        if (g && g[1][0] === f[1][0] && g[1].length >= f[1].length) break;
        body.push(lines[j]);
      }
      push({ code: { lang: f[2].toLowerCase(), text: body.join("\n") } });
      i = j;
      continue;
    }
    const a = l.match(ALERT);
    if (a) {
      const body = [];
      while (i + 1 < lines.length && lines[i + 1].startsWith(">")) body.push(lines[++i].replace(/^>\s?/, ""));
      push({ alert: { kind: a[1].toLowerCase(), md: inline(notes(body.join("\n"))) } });
      continue;
    }
    if (/^\s*<details\b[^>]*>/i.test(l)) {
      const block = [l];
      let j = i;
      while (!/<\/details>/i.test(lines[j]) && j + 1 < lines.length) block.push(lines[++j]);
      const text = block.join("\n");
      const summary = stripTags(text.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/i)?.[1] ?? "Details");
      const body = text.replace(/^\s*<details\b[^>]*>/i, "").replace(/<summary\b[^>]*>[\s\S]*?<\/summary>/i, "").replace(/<\/details>\s*$/i, "").trim();
      push({ details: { summary, md: inline(notes(body)) } });
      i = j;
      continue;
    }
    // "Term" then ": definition" lines; blank lines between entries join them.
    if (l.trim() && !/^\s*[>#|:-]/.test(l) && /^:\s+\S/.test(lines[i + 1] ?? "")) {
      const entries = [];
      let j = i;
      while (j < lines.length && lines[j].trim() && /^:\s+\S/.test(lines[j + 1] ?? "")) {
        const entry = { term: inline(notes(lines[j].trim())), defs: [] };
        j++;
        while (j < lines.length && /^:\s+\S/.test(lines[j])) entry.defs.push(inline(notes(lines[j++].replace(/^:\s+/, ""))));
        entries.push(entry);
        let k = j; // skip blanks only if another entry follows
        while (k < lines.length && !lines[k].trim()) k++;
        if (k < lines.length && /^:\s+\S/.test(lines[k + 1] ?? "") && !/^\s*[>#|:-]/.test(lines[k])) j = k; else break;
      }
      push({ deflist: entries });
      i = j - 1;
      continue;
    }
    if (defLines.has(i)) continue;
    if (!run.length) runStart = i;
    run.push(l);
  }
  flush();
  if (order.size) parts.push({ footnotes: [...order].map(([id, n]) => ({ n, md: inline(notes(defs.get(id))) })) });
  return parts;
}
