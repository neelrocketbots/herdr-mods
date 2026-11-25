// Agent tasks: the task list of the Claude Code session working in the shown
// space, and of its subagents, in a sidebar block. Done / now / next, live,
// read-only.
//
// Which session: the space's Claude Code agents (Herdr's agents(), most
// recently changed first); for each, `hc get` gives the pid of the Claude
// running in its terminal, and <config>/sessions/<pid>.json (in ~/.claude or
// another config folder like ~/.claude2) its sessionId and cwd. The first one
// with a task list (its own or a subagent's) wins. None: the space's last
// session seen live (remembered per space), faded as "ended", if it changed in
// the last day.
// The lists: TaskCreate / TaskUpdate calls replayed from the transcript
// (<config>/projects/<cwd as a dir name>/<sessionId>.jsonl) and each
// subagent's (<sessionId>/subagents/agent-*.jsonl, named by its .meta.json).
// Only new whole lines are read; a shorter file starts over.
// When: event-driven. It watches the transcripts' folder (watchFolder), wakes
// when the space or its Claude agents change, and checks every 30s anyway;
// nothing while the window is hidden. Never writes under ~/.claude*.
//
// The layout block (props.block) starts at 0px; this sizes it to its content.
// With nothing to show it keeps its header line ("Tasks · no task list yet").
// The list's height animates, and it fades across a space switch. The header
// folds it (remembered).
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, hc, readTextFile, watchFolder, theme, run, props, checking, spaces, agents, window } from "herdr";
import { CHUNK, CLAUDE_DIRS, FILES, HAS_TASKS, touches, parseFiles, parseMeta, projectDir, pickAgents, newState, feed, list, summary } from "./tasks.js";

const FALLBACK_MS = 30_000;           // check this often even without events
const SETTLE_MS = 400;                // at most one read per this, however many writes
const HIDDEN_MS = 2000;               // how often to look whether the window is back
const DIRS_MS = 60_000;               // look for Claude config folders this often
const RETRY_MS = 30_000;              // after a failed or timed-out read
const ENDED_MS = 24 * 3600_000;
const SUBS_MAX = 4;                   // subagents shown, most recent first
const LIST_MAX = 168;                 // px of rows before the list scrolls (~6)
const COLLAPSED_KEY = "agent-tasks.collapsed";
const LAST_KEY = "agent-tasks.last";  // { spaceId: { path, label } }
const READS_MAX = 400;                // transcripts remembered before the oldest are dropped

// Per transcript: bytes read so far, the replay state, when to retry after a
// failure; per subagent meta file: its mtime and contents; per terminal: the
// pid of its Claude (asked of hc only when that pid's session file is gone).
// Module scope, so they survive this view being rebuilt.
const reads = new Map();
const metas = new Map();
const pids = new Map();

const agoText = (ms) => { const m = Math.round((Date.now() - ms) / 60_000); return m < 60 ? `${Math.max(1, m)}m` : `${Math.round(m / 60)}h`; };
const activeSpace = () => spaces().find((s) => s.active) ?? null;
const folderOf = (path) => path.slice(0, path.lastIndexOf("/"));
const never = new Promise(() => {});

export default class AgentTasks extends View {
  init(_props, cx) {
    this.view = null;        // { label, endedAt, tasks, subs: [{ label, finished, tasks }] } or null
    this.sig = null;         // what's drawn, to skip redraws that change nothing
    this.showDone = false;
    this.px = null;
    this.key = null;         // active space + its Claude agents, as of the last render
    this.spaceId = null;
    this.reason = "";       // why there's no list: shown in the header
    this.listH = 0;          // the list's height, animated toward its content's
    this.fade = false;       // the list fades out while a new space is read
    this.dirs = null; this.dirsAt = 0;
    try { this.collapsed = localStorage.getItem(COLLAPSED_KEY) === "1"; } catch { this.collapsed = false; }
    try { this.last = JSON.parse(localStorage.getItem(LAST_KEY) ?? "{}") ?? {}; } catch { this.last = {}; }
  }

  // Read, then wait for a change in a watched folder, a wake from render, or
  // the fallback timer; again. Started (and restarted after a mod reload)
  // from render.
  async run(cx) {
    let dirs = [], targets = [];
    for (;;) {
      if (window()?.visible === false) { await cx.sleep(HIDDEN_MS); continue; }
      this.dirty = false;
      // Watch before reading, so a write during the read still wakes us.
      const watches = new Map(dirs.map((dir) => [dir, watchFolder(dir)]));
      try {
        const r = await this.load();
        dirs = r.watch; targets = r.targets ?? [];
        for (const dir of dirs) if (!watches.has(dir)) watches.set(dir, watchFolder(dir));
        if (activeSpace()?.id !== r.spaceId) this.dirty = true; // switched meanwhile: read again
        else {
          const sig = r.view ? JSON.stringify([r.view.label, r.view.endedAt && agoText(r.view.endedAt), r.view.tasks, r.view.subs]) : `none:${r.reason}`;
          if (sig !== this.sig || this.fade) {
            this.sig = sig; this.view = r.view; this.reason = r.reason ?? "";
            this.fade = false; // fade the new space's list in
            cx.notify();
          }
        }
      } catch {} // keep the last list
      if (!this.dirty) {
        const woke = new Promise((resolve) => { this.wake = resolve; });
        const timer = cx.sleep(FALLBACK_MS);
        for (;;) {
          const hit = await Promise.race([woke, timer,
            ...[...watches].map(([dir, w]) => w.then((paths) => ({ dir, paths }), () => never))]);
          if (!hit?.paths || touches(hit.paths, targets, dirs)) break;
          // Another session's file in the same folder: keep waiting.
          watches.set(hit.dir, watchFolder(hit.dir));
        }
        this.wake = null;
      }
      for (const w of watches.values()) w.cancel();
      // Throttle: a burst of writes costs at most one read per SETTLE_MS.
      await cx.sleep(SETTLE_MS);
    }
  }

  async load() {
    const space = activeSpace();
    if (!space || space.machine) return { spaceId: space?.id ?? null, view: null, watch: [], reason: space ? "on another machine" : "" };
    if (!this.dirs || Date.now() - this.dirsAt > DIRS_MS) {
      const r = await exec("sh", ["-c", CLAUDE_DIRS], { timeout: 5000 });
      this.dirs = r.stdout.split("\n").filter(Boolean); this.dirsAt = Date.now();
    }
    const live = new Set(), watch = new Set(), claudes = pickAgents(agents(), space.id);
    for (const agent of claudes) {
      const session = await this.session(agent.address);
      if (!session) continue;
      live.add(session.path); watch.add(folderOf(session.path));
      const lists = await this.lists(session.path);
      if (!lists) continue;
      const label = agent.title || session.name || "Claude Code";
      this.remember(space.id, { path: session.path, label });
      return { spaceId: space.id, view: { label, endedAt: null, ...lists }, watch: [...watch], targets: [...live] };
    }
    const last = this.last[space.id];
    const reason = claudes.length ? "no task list yet" : "no Claude here";
    if (!last || live.has(last.path)) return { spaceId: space.id, view: null, watch: [...watch], targets: [...live], reason };
    watch.add(folderOf(last.path));
    const lists = await this.lists(last.path, ENDED_MS);
    return { spaceId: space.id, view: lists ? { label: last.label, endedAt: lists.mtime, ...lists } : null, watch: [...watch], targets: [...live, last.path], reason };
  }

  // The Claude session in terminal `address`: { path, name } or null.
  async session(address) {
    const cached = pids.get(address);
    if (cached != null) {
      const s = await this.sessionOf(cached);
      if (s) return s;
      pids.delete(address); // that Claude ended: ask hc again
    }
    const r = await hc(["get", address, "--json"]).catch(() => null);
    let pid = null;
    try { pid = JSON.parse(r?.stdout ?? "").foreground?.pid; } catch {}
    if (!Number.isInteger(pid)) return null;
    const s = await this.sessionOf(pid);
    if (s) pids.set(address, pid);
    return s;
  }

  // <config>/sessions/<pid>.json, in whichever config folder has it.
  async sessionOf(pid) {
    for (const dir of this.dirs) {
      const text = await readTextFile(`${dir}/sessions/${pid}.json`).catch(() => null);
      if (!text) continue;
      let s = null;
      try { s = JSON.parse(text); } catch {}
      if (s?.sessionId && typeof s.cwd === "string") return { path: `${dir}/projects/${projectDir(s.cwd)}/${s.sessionId}.jsonl`, name: s.name };
    }
    return null;
  }

  // The session's tasks and its subagents' (those with tasks, newest first):
  // { tasks, subs, mtime } or null when there are none. Older than maxAgeMs
  // (its newest file): null, without reading.
  async lists(path, maxAgeMs = Infinity) {
    const r = await exec("sh", ["-c", FILES, "sh", path], { timeout: 5000 });
    const files = parseFiles(r.stdout);
    const main = files.find((f) => f.path === path);
    if (!main) return null;
    const mtime = Math.max(...files.map((f) => f.mtime));
    if (Date.now() - mtime > maxAgeMs) return null;
    const tasks = await this.read(main, false);
    const others = files.filter((f) => f !== main);
    // Subagent files with new bytes: one grep finds those with task lines;
    // the rest are marked read without reading them.
    const grown = others.filter((f) => f.size > (reads.get(f.path)?.offset ?? 0));
    if (grown.length) {
      const g = await exec("sh", ["-c", HAS_TASKS, "sh", ...grown.map((f) => f.path)], { timeout: 15_000 }).catch(() => null);
      if (g) {
        const has = new Set(g.stdout.split("\n").filter(Boolean));
        for (const f of grown) if (!has.has(f.path) && !reads.get(f.path)?.state.tasks.size) {
          reads.set(f.path, { offset: f.size, state: newState({ sidechain: true }), retryAt: 0 });
        }
      }
    }
    const subs = [];
    for (const f of others.sort((a, b) => b.mtime - a.mtime)) {
      const subTasks = await this.read(f, true);
      if (!subTasks.length) continue;
      subs.push({ ...(await this.meta(f)), tasks: subTasks });
      if (subs.length === SUBS_MAX) break;
    }
    return tasks.length || subs.length ? { tasks, subs, mtime } : null;
  }

  async meta(file) {
    const metaPath = file.path.replace(/\.jsonl$/, ".meta.json");
    const hit = metas.get(metaPath);
    if (hit && hit.mtime === file.mtime) return hit.meta;
    const meta = parseMeta((await readTextFile(metaPath).catch(() => null)) ?? "");
    metas.set(metaPath, { mtime: file.mtime, meta });
    return meta;
  }

  remember(spaceId, entry) {
    const was = this.last[spaceId];
    if (was?.path === entry.path && was?.label === entry.label) return;
    const ids = new Set(spaces().map((s) => s.id));
    this.last = Object.fromEntries(Object.entries({ ...this.last, [spaceId]: entry }).filter(([id]) => ids.has(id)));
    try { localStorage.setItem(LAST_KEY, JSON.stringify(this.last)); } catch {}
  }

  // A transcript's tasks ({ path, size } from FILES), reading only whole lines
  // added since the last call. sidechain: a subagent's.
  async read({ path, size }, sidechain) {
    let r = reads.get(path);
    if (!r || size < r.offset) {
      r = { offset: 0, state: newState({ sidechain }), retryAt: 0 };
      reads.set(path, r);
      if (reads.size > READS_MAX) for (const key of [...reads.keys()].slice(0, reads.size - READS_MAX)) reads.delete(key);
    }
    if (size > r.offset && Date.now() >= r.retryAt) {
      try {
        const g = await exec("sh", ["-c", CHUNK, "sh", path, String(r.offset), String(size)], { timeout: 15_000 });
        if (g.code === 0 || g.code === 1) { feed(r.state, g.stdout.split("\n")); r.offset = size; } // 1: no task lines
        else if (g.code !== 3) r.retryAt = Date.now() + RETRY_MS;                                // 3: mid-line, next time
      } catch { r.retryAt = Date.now() + RETRY_MS; }
    }
    return list(r.state);
  }

  size(px) {
    if (!props()?.block || px === this.px) return;
    this.px = px;
    run("layout.resize", { id: props().block, px });
  }

  fit(height) {
    const px = Math.ceil(height);
    if (px > 0) this.size(px);
  }

  toggle(cx) {
    this.collapsed = !this.collapsed;
    try { localStorage.setItem(COLLAPSED_KEY, this.collapsed ? "1" : "0"); } catch {}
    cx.notify();
  }

  render(cx) {
    if (!checking()) {
      if (!(this.loop && !this.loop.is_done())) this.loop = cx.spawn((cx) => this.run(cx));
      // The space or its Claude agents changed: read now.
      const sid = activeSpace()?.id ?? null;
      const key = `${sid}|${pickAgents(agents(), sid).map((a) => a.address).join(",")}`;
      if (key !== this.key) { this.key = key; this.dirty = true; this.wake?.(); }
      if (sid !== this.spaceId) { if (this.spaceId !== null) this.fade = true; this.spaceId = sid; }
    }
    const t = theme(), v = this.view;
    const root = v_flex().id("agent-tasks").w_full().bg(t.chrome).text_color(t.foreground);
    const s = summary(v?.tasks ?? []), faded = v?.endedAt != null;
    const working = t.working ?? t.ansi3;
    const mark = (child) => div().flex_none().size(13).mt(2).flex().items_center().justify_center().child(child);
    const ring = () => div().size(11).rounded_full().border_1().border_color(t.dim);
    const tip = (task) => (task.description ? `${task.subject}\n\n${task.description}` : task.subject);

    const doneRow = h_flex().id("at-done").flex_none().px(8).py(3).gap(8).items_center().rounded(6).cursor_pointer()
      .text_size(12).text_color(t.dim).hover((st) => st.bg(t.hover))
      .on_click((_e, cx) => { this.showDone = !this.showDone; cx.notify(); })
      .child(mark(div().text_size(10).text_color(t.ansi2).child("✓")))
      .child(div().flex_1().child(`${s.done} done`))
      .child(div().flex_none().text_size(11).child(this.showDone ? "▾" : "▸"));
    const doneTask = (task, i) => h_flex().id(`at-c-${i}`).flex_none().px(8).py(3).gap(8).items_start().text_size(12).tooltip(tip(task))
      .child(mark(div().text_size(10).text_color(t.ansi2).child("✓")))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(task.subject));
    const nowTask = (task, i) => h_flex().id(`at-n-${i}`).flex_none().px(8).py(4).gap(8).items_start().rounded(6).bg(t.raised).text_size(12).tooltip(tip(task))
      .child(mark(svg("mods/agent-tasks/spinner.svg").size(11).text_color(working).when(!faded, (el) => el.spin(900))))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().whitespace_normal().text_color(t.foreground).child(task.subject))
        .when(Boolean(task.activeForm) && !faded, (el) => el.child(div().truncate().text_size(11).text_color(working).child(`${task.activeForm}…`))));
    const nextTask = (task, i) => h_flex().id(`at-p-${i}`).flex_none().px(8).py(3).gap(8).items_start().text_size(12).tooltip(tip(task))
      .child(mark(ring()))
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(task.subject));

    const pct = s.total ? (100 * s.done) / s.total : 0;
    const header = h_flex().id("at-toggle").px(8).pt(2).pb(4).gap(6).items_center().text_size(11).text_color(t.dim)
      .when(Boolean(v), (el) => el.cursor_pointer().hover((st) => st.text_color(t.foreground))
        .tooltip(this.collapsed ? "Show the tasks" : "Just the count")
        .on_click((_e, cx) => this.toggle(cx)))
      .child(div().flex_none().child("Tasks"))
      .child(div().flex_1().min_w(0).truncate().child(!v ? (this.reason ? `· ${this.reason}` : "") : faded ? `· ${v.label} · ended ${agoText(v.endedAt)} ago` : `· ${v.label}`))
      .when(s.total > 0, (el) => el
        .child(div().flex_none().w(44).h(3).rounded(2).bg(t.input).overflow_hidden()
          .child(div().h_full().w(Math.round((44 * pct) / 100)).bg(t.ansi2)))
        .child(div().flex_none().child(`${s.done}/${s.total}`)))
      .when(Boolean(v), (el) => el.child(div().flex_none().child(this.collapsed ? "▸" : "▾")));

    // A subagent: one line, its description and count; while it works, its
    // task in progress under it. Tooltip: its whole list.
    const MARK = { completed: "✓", in_progress: "◐" };
    const subRow = (sub, i) => {
      const ss = summary(sub.tasks), now = sub.finished || faded ? null : ss.current[0];
      return h_flex().id(`at-s-${i}`).flex_none().px(8).py(3).gap(8).items_start().rounded(6).text_size(12)
        .tooltip([sub.label, "", ...sub.tasks.map((x) => `${MARK[x.status] ?? "○"} ${x.subject}`)].join("\n"))
        .child(mark(now ? svg("mods/agent-tasks/spinner.svg").size(11).text_color(working).spin(900)
          : ss.done === ss.total ? div().text_size(10).text_color(t.ansi2).child("✓") : ring()))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(h_flex().gap(6).items_center()
            .child(div().flex_none().text_size(11).text_color(t.dim).child("↳"))
            .child(div().flex_1().min_w(0).truncate().text_color(now ? t.muted : t.dim).child(sub.label))
            .child(div().flex_none().text_size(11).text_color(t.dim).child(`${ss.done}/${ss.total}`)))
          .when(Boolean(now), (el) => el.child(div().truncate().text_size(11).text_color(working)
            .child(now.activeForm ? `${now.activeForm}…` : now.subject))));
    };

    const rows = [
      ...(s.done ? [doneRow] : []),
      ...(this.showDone ? s.completed.map(doneTask) : []),
      ...s.current.map(nowTask),
      ...s.pending.map(nextTask),
      ...(v?.subs ?? []).map(subRow),
    ];
    // The list's box animates to its content's height (measured below) and
    // the block follows it (fit, on every size change), so rows slide in and
    // out instead of jumping. On a space switch it fades out, and back in
    // once the new space is read.
    const open = !this.collapsed && rows.length > 0;
    return root.child(v_flex().id("at-content").w_full().px(10).pt(6).pb(6).gap(1).border_t(1).border_color(t.border)
      .on_size_change((size) => this.fit(size.height))
      .child(header)
      .child(div().id("at-clip").w_full().overflow_y_scroll()
        .h(open ? this.listH : 0).transition("height", { duration: 220, easing: "ease-out" })
        .opacity(this.fade ? 0 : faded ? 0.6 : 1).transition("opacity", { duration: 160, easing: "ease-out" })
        .child(v_flex().id("at-list").w_full().gap(1)
          .on_size_change((size, cx) => {
            const h = Math.min(LIST_MAX, Math.ceil(size.height));
            if (h !== this.listH) { this.listH = h; cx.notify(); }
          })
          .children(rows))));
  }
}
