// Shared by the herdr-mods mods (each keeps a copy: mods can't import across
// folders; keep them identical). Settings come from herdr-mods.json in the app
// folder (~/.config/herdr-app), read fresh each time so edits apply at once.
//
//   "editor": "zed" | "cursor" | "vscode" | "windsurf" | "sublime" | "webstorm" | "idea" | "nova"
//   "editor": { "name": "Helix", "command": ["wezterm", "start", "--", "hx", "{path}"] }
//   "editor": { "name": "BBEdit", "app": "BBEdit" }        (macOS app name, via `open -a`)
import { exec, readTextFile, appHome, notify } from "herdr";

export const SETTINGS = "herdr-mods.json";

const PRESETS = {
  zed: { name: "Zed", cli: "zed", app: "Zed" },
  cursor: { name: "Cursor", cli: "cursor", app: "Cursor" },
  vscode: { name: "VS Code", cli: "code", app: "Visual Studio Code" },
  code: { name: "VS Code", cli: "code", app: "Visual Studio Code" },
  windsurf: { name: "Windsurf", cli: "windsurf", app: "Windsurf" },
  sublime: { name: "Sublime Text", cli: "subl", app: "Sublime Text" },
  webstorm: { name: "WebStorm", cli: "webstorm", app: "WebStorm" },
  idea: { name: "IntelliJ IDEA", cli: "idea", app: "IntelliJ IDEA" },
  nova: { name: "Nova", cli: "nova", app: "Nova" },
};
const DEFAULT = "zed";

// The settings object; {} when the file is missing. Throws on invalid JSON.
export async function readSettings() {
  const raw = await readTextFile(`${appHome()}/${SETTINGS}`);
  return raw === null || !raw.trim() ? {} : JSON.parse(raw);
}

// { name, cli?, app?, command? } for the configured editor.
export function editorOf(settings) {
  const e = settings?.editor ?? DEFAULT;
  if (typeof e === "string") return PRESETS[e.toLowerCase()] ?? { name: e, cli: e, app: e };
  return { name: e.name ?? "editor", cli: e.cli, app: e.app, command: Array.isArray(e.command) ? e.command : null };
}

// The editor's name for button labels; the default's when settings can't be read.
export async function editorName() {
  try { return editorOf(await readSettings()).name; } catch { return editorOf({}).name; }
}

// Open a file or folder in the configured editor: its command, else its CLI,
// else its macOS app. A notification says when none of them worked.
export async function openInEditor(path) {
  let ed;
  try { ed = editorOf(await readSettings()); } catch (e) {
    notify({ title: `${SETTINGS} is invalid`, body: String(e?.message ?? e), level: "error" });
    ed = editorOf({});
  }
  const tries = [];
  if (ed.command?.length) tries.push([ed.command[0], ed.command.slice(1).map((a) => a.replaceAll("{path}", path))]);
  if (ed.cli) tries.push([ed.cli, [path]]);
  if (ed.app) tries.push(["open", ["-a", ed.app, path]]);
  for (const [cmd, args] of tries) {
    try { if ((await exec(cmd, args)).code === 0) return; } catch {}
  }
  notify({ title: `Couldn't open in ${ed.name}`, body: path, level: "error" });
}
