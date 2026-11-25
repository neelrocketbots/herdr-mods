// A lazy file browser for the focused pane's folder, with bounded read-only previews.
// files-md: clone of the shipped `files` mod that also renders markdown
// (Preview / Source toggle in the header), wraps long lines (Wrap toggle),
// opens the shown file in your editor (herdr-mods.json), and opens files
// Ctrl/Cmd-clicked in a terminal (link.js hands them over). Shipped mods are
// rewritten on every start, so changes live here; the custom-herdr layout's
// Files block points at it.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView, Checkbox } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, writeTextFile, watchFolder, theme, settings, window, checking, shared } from "herdr";
import { openInEditor, editorName } from "./editor.js";
import { splitImages, loadImage } from "./markdown-images.js";
import { splitTasks, toggleTask } from "./markdown-tasks.js";
import { OPEN_KEY } from "./link.js";

// The panels share data in one VM, but their host tasks belong to separate copies.
const scans = globalThis[Symbol.for("herdr.repoStatus.v2")] ??= new Map();

async function repoStatus(root, on, { after, visiting, urgent, allowInactive }, cx, current) {
  const repo = JSON.stringify([on, root]), now = Date.now();
  for (const [key, scan] of scans) {
    if (scan.pollAt <= now || (!scan.pollAt && scan.task.is_done())) scans.delete(key);
  }
  while (current()) {
    let scan = scans.get(repo);
    const pending = scan && !scan.pollAt && !scan.task.is_done();
    const reusable = scan?.status?.code === 0 && Date.now() < scan.pollAt
      && (scan.started >= after || (!urgent && Date.now() < scan.watchAt));
    if (!reusable && (!pending || (visiting && scan.started !== undefined && scan.started < after))) {
      if (!allowInactive && window()?.active === false) return null;
      const next = {};
      next.task = cx.spawn(async cx => {
        await cx.sleep(25); // Let both listeners for a watch batch join before starting Git.
        if (!allowInactive && window()?.active === false) return;
        next.started = Date.now();
        try {
          next.status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd: root, on });
        } catch (error) {
          next.error = error;
        } finally {
          const finished = Date.now(), duration = finished - next.started;
          const delay = duration < 500 ? 0 : Math.min(60000, 5 * duration);
          next.watchAt = finished + delay;
          next.pollAt = finished + Math.max(10000, delay);
          if (next.status?.code !== 0 && scans.get(repo) === next) scans.delete(repo);
        }
      });
      scans.set(repo, next);
      scan = next;
    }
    // Resume through our own host task, so another copy's close cannot cancel our follow-up work.
    while (current() && !scan.pollAt && !scan.task.is_done()) await cx.sleep(50);
    if (!current()) return null;
    if (!scan.pollAt) continue; // The scanning copy closed or reloaded.
    return scan;
  }
  return null;
}

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const MARKDOWN = new Set(["md", "markdown", "mdx", "mdown", "mkd"]);
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html",
  md: "markdown", markdown: "markdown", mdx: "markdown", mdown: "markdown", mkd: "markdown" };
const WRAP_KEY = "files-md.wrap";
const readWrap = () => { try { return localStorage.getItem(WRAP_KEY) !== "0"; } catch { return true; } };
// UTF-16 offsets of a 1-based line, for selecting it in the editor.
function lineRange(text, line) {
  let start = 0;
  for (let n = 1; n < line; n++) {
    const next = text.indexOf("\n", start);
    if (next < 0) return null;
    start = next + 1;
  }
  const end = text.indexOf("\n", start);
  return { start, end: end < 0 ? text.length : end };
}
const PER_FOLDER = 500, TOTAL = 5000;

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.refresh(cx);
    cx.timer.every(500, cx => this.refreshIfDue(cx));
    this.wrap = readWrap();
    this.editor = "editor";
    if (checking()) return;
    // Its name comes from quick-links via shared("herdr-mods.editor"); read the
    // settings once in case quick-links isn't running.
    cx.spawn(async cx => { this.editor = await editorName(); cx.notify(); });
  }

  // A file Ctrl/Cmd-clicked in a terminal (link.js): show it, at its line.
  takeOpen(cx) {
    const req = shared(OPEN_KEY);
    if (!req || req.at === this.openSeen) return;
    this.openSeen = req.at;
    if (Date.now() - req.at > 30_000) return; // left over from an earlier click
    const under = this.root && req.path.startsWith(`${this.root}/`);
    if (req.line && MARKDOWN.has(req.path.split(".").pop().toLowerCase())) this.source = true;
    this.show(under ? req.path.slice(this.root.length + 1) : req.path, cx, req.line);
  }

  refreshIfDue(cx) {
    const active = window()?.active !== false, context = this.context;
    const refocused = active && this.windowActive === false;
    this.windowActive = active;
    if (!context) return;
    if (refocused && (context.dirtyAt || !context.watch)) context.catchUp = true;
    if (!active || this.loading) return;
    const now = Date.now();
    if (context.catchUp || (context.dirtyAt && now >= context.watchAt) || now >= context.pollAt) this.refresh(cx);
  }

  watch(root, context, cx) {
    if (context.on || context.watch?.root === root) return;
    context.watch?.pending?.cancel();
    const watch = { root };
    context.watch = watch;
    cx.spawn(async cx => {
      try {
        while (this.context === context && context.watch === watch) {
          watch.pending = watchFolder(root);
          const paths = await watch.pending;
          if (paths.length && context.watch === watch && this.current(context)) {
            context.dirtyAt = Date.now() + 1;
            this.refreshIfDue(cx);
          }
        }
      } catch {
        if (context.watch === watch) context.watch = null;
      }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    const visiting = next !== this.context?.key;
    if (visiting) {
      if (this.context) {
        this.saved.set(this.context.key, { folders: this.folders, file: this.file });
        this.context.watch?.pending?.cancel();
      }
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on, dirtyAt: 0 }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    const context = this.context;
    const now = Date.now();
    if (!cwd) {
      context.catchUp = false;
      context.dirtyAt = 0;
      context.pollAt = now + 10000;
      return;
    }
    if (this.loading) return;
    if (context.catchUp && !context.dirtyAt) context.dirtyAt = now + 1;
    const request = {
      after: visiting ? now + 1 : context.dirtyAt || (context.lastStatus ?? -1) + 1,
      visiting,
      urgent: visiting || context.catchUp,
      allowInactive: visiting,
    };
    context.catchUp = false;
    context.pollAt = context.watchAt = now + 10000;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        this.watch(cwd, context, cx);
        const dirtyAtListing = context.dirtyAt;
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        if (!this.current(context)) return;
        const marks = {};
        let covered = dirtyAtListing;
        if (top?.code === 0) {
          const root = top.stdout.trim();
          const scan = await repoStatus(root, on, request, cx, () => this.context === context);
          if (!scan || !this.current(context)) return;
          const { status, started, pollAt, watchAt } = scan;
          context.lastStatus = started;
          context.pollAt = pollAt;
          context.watchAt = watchAt;
          covered = Math.min(dirtyAtListing, started);
          if (request.urgent && request.after > started) context.catchUp = true;
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${root}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        } else {
          context.watchAt = Date.now();
        }
        if (!this.current(context)) return;
        if (context.dirtyAt <= covered) context.dirtyAt = 0;
        this.marks = marks; this.error = null;
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally {
        if (this.context === context) this.loading = false;
        cx.notify();
      }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  // `path` is relative to the folder shown, or absolute for a clicked file outside it.
  show(path, cx, line) {
    this.code?.release(); this.code = null; this.markdown = null; this.mdParts = null; this.images = new Map(); this.file = path; this.fileError = null;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    const full = path.startsWith("/") ? path : `${root}/${path}`;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(full, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop().toLowerCase() : "txt";
        const value = text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text;
        if (MARKDOWN.has(ext)) {
          this.markdown = text.length > 400000 ? text.slice(0, 400000) + "\n\n… (file truncated)" : text;
          // TextView draws no images or task checkboxes: lift task lines out
          // (drawn as checkbox rows), then images (loaded into the app folder).
          this.mdTruncated = text.length > 400000;
          this.mdParts = splitTasks(this.markdown).flatMap((p) => (p.md !== undefined ? splitImages(p.md) : [p]));
          const dir = full.split("/").slice(0, -1).join("/");
          for (const part of this.mdParts) for (const img of part.images ?? []) {
            if (on) { this.images.set(img, null); continue; } // a file on another machine: alt text only
            cx.spawn(async cx => {
              const info = await loadImage(img.src, dir);
              if (this.file !== path) return;
              this.images.set(img, info);
              cx.notify();
            });
          }
        }
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true, value, soft_wrap: this.wrap,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6,
            heading: t.ansi4, strong: t.foreground, code: t.ansi2, quote: t.dim, list: t.ansi5, link: t.ansi6 } });
        const range = line ? lineRange(value, line) : null;
        if (range) this.code.set_selected_range(range);
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  // Task list items: a checkbox each, the text as markdown. Clicking writes
  // "[ ]" <-> "[x]" on that line of the file (local, untruncated files only),
  // only if the line is still as shown; otherwise the file is read again.
  mdTasks(tasks, i, t) {
    const editable = !this.on && !this.mdTruncated;
    return v_flex().gap(3).children(tasks.map((task, j) => h_flex().id(`md-task-${i}-${j}`).gap(8).items_start().pl(task.indent * 18)
      .child(Checkbox.new(`md-check-${this.file}-${task.line}`).checked(task.checked).flex_none().mt(3).size(14).rounded(4)
        .border_1().border_color(task.checked ? t.accent : t.input).bg(task.checked ? t.accent : t.background)
        .flex().items_center().justify_center()
        .when(editable, (el) => el.cursor_pointer().hover((st) => st.border_color(t.accent))
          .on_change((_checked, cx) => this.toggleMdTask(task, cx)))
        .when(task.checked, (el) => el.child(svg("mods/files-md/check.svg").size(10).text_color(t.background))))
      .child(div().flex_1().min_w(0).when(task.checked, (el) => el.text_color(t.muted))
        .child(TextView.markdown(`md-task-text-${this.file}-${task.line}`, task.text).selectable(true)))));
  }

  toggleMdTask(task, cx) {
    const path = this.file, full = this.fullPath();
    cx.spawn(async (cx) => {
      const text = await readTextFile(full).catch(() => null);
      if (this.file !== path || text == null) return;
      const next = toggleTask(text, task);
      if (next == null) { this.show(path, cx); cx.notify(); return; } // the file changed: show it as it is now
      try { await writeTextFile(full, next, text); } catch { this.show(path, cx); cx.notify(); return; }
      if (this.file !== path) return;
      task.checked = !task.checked;
      this.markdown = next;
      this.code?.set_value(next);
      cx.notify();
    });
  }

  setWrap(wrap, cx) {
    this.wrap = wrap;
    try { localStorage.setItem(WRAP_KEY, wrap ? "1" : "0"); } catch {}
    this.code?.set_soft_wrap(wrap);
    cx.notify();
  }

  fullPath() { return this.file?.startsWith("/") ? this.file : `${this.root}/${this.file}`; }

  // Opens the shown file in the configured editor (local files only).
  openInEditor() {
    openInEditor(this.fullPath());
  }

  // One markdown image: drawn at its own size (or its width="..."), no wider than
  // the preview; a click opens its link, else the image itself.
  mdImage(img, key, t) {
    const info = this.images.get(img);
    if (!info) return div().text_size(12).text_color(t.dim).child(`${info === null ? "🖼" : "…"} ${img.alt || img.src.split("/").pop()}`);
    const avail = Math.max(80, (this.mdWidth ?? 360) - 36);
    const pct = img.width?.endsWith("%") ? parseFloat(img.width) / 100 : null;
    const want = pct ? pct * avail : parseFloat(img.width ?? "") || info.w || avail;
    const w = Math.min(avail, want), h = info.w ? (w * info.h) / info.w : w * 0.6;
    return div().id(`md-img-${key}`).flex_none().cursor_pointer().tooltip(img.alt || img.src)
      .on_click(() => exec("open", [img.href && /^https?:/i.test(img.href) ? img.href : info.open]).catch(() => {}))
      .child(image(info.path).w(w).h(h));
  }

  headerButton(id, label, onClick, t, on = false) {
    return div().id(id).flex_none().px(8).py(2).rounded(6).cursor_pointer().text_size(12)
      .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_click(onClick).child(label);
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.show(path, cx))
        .child(entry.dir ? svg(`mods/files-md/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/files-md/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    else this.refreshIfDue(cx);
    this.takeOpen(cx);
    const t = theme();
    const preview = this.markdown != null && !this.source;
    const font = this.code ? settings() : null;
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? this.root?.split(/[\\/]/).pop() ?? ""))
        .when(this.markdown != null && Boolean(this.file), el => el.child(
          this.headerButton("files-md-toggle", this.source ? "Preview" : "Source", (_e, cx) => { this.source = !this.source; cx.notify(); }, t)))
        .when(Boolean(this.code) && !preview, el => el.child(
          this.headerButton("files-md-wrap", "Wrap", (_e, cx) => this.setWrap(!this.wrap, cx), t, this.wrap)))
        .when(Boolean(this.file) && !this.on, el => el.child(
          this.headerButton("files-open-editor", `Open in ${shared("herdr-mods.editor") ?? this.editor}`, () => this.openInEditor(), t))))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(preview
        ? v_flex().id("files-md-preview").flex_1().min_h(0).overflow_y_scrollbar().px(18).py(14).gap(6)
            .on_size_change((size, cx) => { if (Math.abs((this.mdWidth ?? 0) - size.width) > 1) { this.mdWidth = size.width; cx.notify(); } })
            .children((this.mdParts ?? [{ md: this.markdown }]).map((part, i) => part.md !== undefined
              ? TextView.markdown(`md-${this.file}-${i}`, part.md).selectable(true)
              : part.tasks ? this.mdTasks(part.tasks, i, t)
              : h_flex().flex_wrap().gap(8).items_start().children(part.images.map((img, j) => this.mdImage(img, `${i}-${j}`, t)))))
        : this.code
        ? Editor.new(this.code).font_family(font.font_family).text_size(font.font_size).flex_1().min_h(0)
        : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")));
  }
}
