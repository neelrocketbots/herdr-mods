// Agent tasks: the task list of the Claude Code session working in the shown
// space, in a sidebar block. Done / now / next, live, read-only.
//
// Which session: the space's Claude Code agents (Herdr's agents(), most
// recently changed first); for each, `hc get` gives the pid of the Claude
// running in its terminal, and <config>/sessions/<pid>.json (in ~/.claude or
// another config folder like ~/.claude2) its sessionId and cwd. The first one
// with a task list wins. None: the space's last session seen live (remembered
// per space), faded as "ended", if its transcript changed in the last day.
// The list: TaskCreate / TaskUpdate calls replayed from the transcript
// (<config>/projects/<cwd as a dir name>/<sessionId>.jsonl). Only new whole
// lines are read each tick; a shorter file starts over. Every 2s while the
// window is visible, and when the space changes. Never writes under ~/.claude.
//
// The layout block (props.block) starts at 0px; this sizes it to its content,
// and back to 0 when there's nothing to show. The header folds it (remembered).
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, hc, readTextFile, theme, run, props, checking, spaces, agents, window } from "herdr";
import { CHUNK, CLAUDE_DIRS, projectDir, pickAgents, newState, feed, list, summary } from "./tasks.js";

const TICK_MS = 2000;
const DIRS_MS = 60_000;               // look for Claude config folders this often
const RETRY_MS = 30_000;              // after a failed or timed-out read
const ENDED_MS = 24 * 3600_000;
const LIST_MAX = 168;                 // px of rows before the list scrolls (~6)
const COLLAPSED_KEY = "agent-tasks.collapsed";
const LAST_KEY = "agent-tasks.last";  // { spaceId: { path, label } }

// Per transcript: bytes read so far, the replay state, when to retry after a
// failure. Module scope, so it survives this view being rebuilt.
const reads = new Map();

const agoText = (ms) => { const m = Math.round((Date.now() - ms) / 60_000); return m < 60 ? `${Math.max(1, m)}m` : `${Math.round(m / 60)}h`; };
const activeSpace = () => spaces().find((s) => s.active) ?? null;

export default class AgentTasks extends View {
  init(_props, cx) {
    this.view = null;        // { label, endedAt, tasks } or null
    this.sig = null;         // what's drawn, to skip redraws that change nothing
    this.showDone = false;
    this.px = null;
    this.spaceId = null;
    this.dirs = null; this.dirsAt = 0;
    try { this.collapsed = localStorage.getItem(COLLAPSED_KEY) === "1"; } catch { this.collapsed = false; }
    try { this.last = JSON.parse(localStorage.getItem(LAST_KEY) ?? "{}") ?? {}; } catch { this.last = {}; }
    if (checking()) return;
    cx.timer.every(TICK_MS, (cx) => this.tick(cx));
    this.tick(cx);
  }

  tick(cx) {
    if (window()?.visible === false) return;
    if (this.task && !this.task.is_done()) { this.again = true; return; } // one read at a time
    this.again = false;
    this.task = cx.spawn(async (cx) => {
      try {
        const { spaceId, view } = await this.load();
        if (activeSpace()?.id !== spaceId) return; // switched meanwhile: the next read has it
        const sig = view ? JSON.stringify([view.label, view.endedAt && agoText(view.endedAt), view.tasks]) : "";
        if (sig !== this.sig) {
          this.sig = sig; this.view = view;
          if (!view) this.size(0);
          cx.notify();
        }
      } catch {} // keep the last list
      if (this.again) this.tick(cx);
    });
  }

  async load() {
    const space = activeSpace();
    if (!space || space.machine) return { spaceId: space?.id ?? null, view: null };
    if (!this.dirs || Date.now() - this.dirsAt > DIRS_MS) {
      const r = await exec("sh", ["-c", CLAUDE_DIRS], { timeout: 5000 });
      this.dirs = r.stdout.split("\n").filter(Boolean); this.dirsAt = Date.now();
    }
    const live = new Set();
    for (const agent of pickAgents(agents(), space.id)) {
      const session = await this.session(agent.address);
      if (!session) continue;
      live.add(session.path);
      const { tasks } = await this.read(session.path);
      if (!tasks.length) continue;
      const label = agent.title || session.name || "Claude Code";
      this.remember(space.id, { path: session.path, label });
      return { spaceId: space.id, view: { label, endedAt: null, tasks } };
    }
    const last = this.last[space.id];
    if (!last || live.has(last.path)) return { spaceId: space.id, view: null };
    const { tasks, mtime } = await this.read(last.path, ENDED_MS);
    return { spaceId: space.id, view: tasks.length ? { label: last.label, endedAt: mtime, tasks } : null };
  }

  // The Claude session in terminal `address`: { path, name } or null.
  async session(address) {
    const r = await hc(["get", address, "--json"]).catch(() => null);
    let pid = null;
    try { pid = JSON.parse(r?.stdout ?? "").foreground?.pid; } catch {}
    if (!Number.isInteger(pid)) return null;
    for (const dir of this.dirs) {
      const text = await readTextFile(`${dir}/sessions/${pid}.json`).catch(() => null);
      if (!text) continue;
      let s = null;
      try { s = JSON.parse(text); } catch {}
      if (s?.sessionId && typeof s.cwd === "string") return { path: `${dir}/projects/${projectDir(s.cwd)}/${s.sessionId}.jsonl`, name: s.name };
    }
    return null;
  }

  remember(spaceId, entry) {
    const was = this.last[spaceId];
    if (was?.path === entry.path && was?.label === entry.label) return;
    const ids = new Set(spaces().map((s) => s.id));
    this.last = Object.fromEntries(Object.entries({ ...this.last, [spaceId]: entry }).filter(([id]) => ids.has(id)));
    try { localStorage.setItem(LAST_KEY, JSON.stringify(this.last)); } catch {}
  }

  // The transcript's tasks, reading only whole lines added since the last
  // call. Older than maxAgeMs: none, without reading it.
  async read(path, maxAgeMs = Infinity) {
    const st = await exec("stat", ["-f", "%z %m", path], { timeout: 5000 });
    if (st.code !== 0) return { tasks: [], mtime: 0 };
    const [size, mtimeS] = st.stdout.trim().split(/\s+/).map(Number);
    const mtime = mtimeS * 1000;
    if (Date.now() - mtime > maxAgeMs) return { tasks: [], mtime };
    let r = reads.get(path);
    if (!r || size < r.offset) { r = { offset: 0, state: newState(), retryAt: 0 }; reads.set(path, r); }
    if (size > r.offset && Date.now() >= r.retryAt) {
      try {
        const g = await exec("sh", ["-c", CHUNK, "sh", path, String(r.offset), String(size)], { timeout: 15_000 });
        if (g.code === 0 || g.code === 1) { feed(r.state, g.stdout.split("\n")); r.offset = size; } // 1: no task lines
        else if (g.code !== 3) r.retryAt = Date.now() + RETRY_MS;                                // 3: mid-line, next tick
      } catch { r.retryAt = Date.now() + RETRY_MS; }
    }
    return { tasks: list(r.state), mtime };
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
    // A new space: read it now rather than at the next tick.
    const sid = activeSpace()?.id ?? null;
    if (sid !== this.spaceId) { this.spaceId = sid; if (!checking()) this.tick(cx); }
    const t = theme(), v = this.view;
    const root = v_flex().id("agent-tasks").w_full().bg(t.chrome).text_color(t.foreground);
    if (!v) return root;
    const s = summary(v.tasks), faded = v.endedAt != null;
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
    const header = h_flex().id("at-toggle").px(8).pt(2).pb(4).gap(6).items_center().cursor_pointer().text_size(11).text_color(t.dim)
      .hover((st) => st.text_color(t.foreground))
      .tooltip(this.collapsed ? "Show the tasks" : "Just the count")
      .on_click((_e, cx) => this.toggle(cx))
      .child(div().flex_none().child("Tasks"))
      .child(div().flex_1().min_w(0).truncate().child(faded ? `· ${v.label} · ended ${agoText(v.endedAt)} ago` : `· ${v.label}`))
      .child(div().flex_none().w(44).h(3).rounded(2).bg(t.input).overflow_hidden()
        .child(div().h_full().w(Math.round((44 * pct) / 100)).bg(t.ansi2)))
      .child(div().flex_none().child(`${s.done}/${s.total}`))
      .child(div().flex_none().child(this.collapsed ? "▸" : "▾"));

    const rows = [
      ...(s.done ? [doneRow] : []),
      ...(this.showDone ? s.completed.map(doneTask) : []),
      ...s.current.map(nowTask),
      ...s.pending.map(nextTask),
    ];
    return root.child(v_flex().id("at-content").w_full().px(10).pt(6).pb(6).gap(1).border_t(1).border_color(t.border)
      .on_size_change((size) => this.fit(size.height))
      .child(header)
      .when(!this.collapsed, (el) => el.child(v_flex().id("at-list").max_h(LIST_MAX).overflow_y_scroll().gap(1)
        .when(faded, (l) => l.opacity(0.6))
        .children(rows))));
  }
}
