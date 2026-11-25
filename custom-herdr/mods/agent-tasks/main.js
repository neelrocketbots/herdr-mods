// Agent tasks: the task list of the Claude Code session working in the shown
// space, in a sidebar block. Done / now / next, live, read-only.
//
// Which session: every running one in ~/.claude/sessions/<pid>.json (pid
// checked with ps), owned by the space whose folder is the longest prefix of
// its cwd, the most recently updated. None running: the newest transcript in
// the space folder's own project dir, if it changed in the last day ("ended").
// The list: TaskCreate / TaskUpdate calls replayed from the session transcript
// (~/.claude/projects/<cwd as a dir name>/<sessionId>.jsonl). Only new bytes
// are read each tick; a shorter file starts over. Every 2s while the window is
// visible. Never writes under ~/.claude.
//
// The layout block (props.block, default "tasks") is sized to fit, and hidden
// when there's nothing to show. The header folds it (remembered).
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, home, theme, run, props, checking, spaces, agents, panes, window } from "herdr";
import { TASK_GREP, projectDir, pickSession, newState, feed, list, summary } from "./tasks.js";

const TICK_MS = 2000;
const ENDED_MS = 24 * 3600_000;
const LIST_MAX = 168;                 // px of rows before the list scrolls (~6)
const COLLAPSED_KEY = "agent-tasks.collapsed";

// One session file per line (they have no trailing newline).
const SESSIONS = 'for f in "$1"/*.json; do [ -f "$f" ] && { tr -d "\\n" < "$f"; echo; }; done';
// Task lines in bytes [from, to) of a transcript, without request copies.
const CHUNK = `tail -c +$(($2 + 1)) "$1" | head -c $(($3 - $2)) | grep -E '${TASK_GREP}' | grep -v '"type":"api-request'`;

// Per transcript: bytes read so far and the replay state. Module scope, so it
// survives this view being rebuilt.
const reads = new Map();

const block = () => props()?.block ?? "tasks";
const agoText = (ms) => { const m = Math.round((Date.now() - ms) / 60_000); return m < 60 ? `${Math.max(1, m)}m` : `${Math.round(m / 60)}h`; };

export default class AgentTasks extends View {
  init(cx) {
    this.view = null;        // { label, endedAt, tasks } or null
    this.showDone = false;
    this.px = -1;
    this.shown = null;
    try { this.collapsed = localStorage.getItem(COLLAPSED_KEY) === "1"; } catch { this.collapsed = false; }
    if (checking()) return;
    this.dir = `${home()}/.claude`;
    cx.timer.every(TICK_MS, (cx) => this.tick(cx));
    this.tick(cx);
  }

  tick(cx) {
    if (window()?.visible === false) return;
    if (this.task && !this.task.is_done()) return; // the last read is still running
    this.task = cx.spawn(async (cx) => {
      try {
        const view = await this.load();
        this.view = view;
        this.showBlock(Boolean(view));
        cx.notify();
      } catch {} // keep the last list
    });
  }

  async load() {
    const all = spaces(), space = all.find((s) => s.active);
    if (!space || space.machine) return null;
    const folders = all.filter((s) => !s.machine).map((s) => s.folder || home());
    const folder = space.folder || home();
    const r = await exec("sh", ["-c", SESSIONS, "sh", `${this.dir}/sessions`], { timeout: 5000 });
    const sessions = r.stdout.split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const pids = sessions.map((s) => s.pid).filter(Number.isInteger);
    const ps = pids.length ? await exec("ps", ["-o", "pid=", "-p", pids.join(",")], { timeout: 5000 }) : { stdout: "" };
    const alive = new Set(ps.stdout.split(/\s+/).filter(Boolean));
    const live = pickSession(sessions, alive, folder, folders);
    if (live) {
      const { tasks } = await this.read(`${this.dir}/projects/${projectDir(live.cwd)}/${live.sessionId}.jsonl`);
      return tasks.length ? { label: this.label(space, live), endedAt: null, tasks } : null;
    }
    const last = await exec("sh", ["-c", 'ls -t "$1"/*.jsonl 2>/dev/null | head -1', "sh", `${this.dir}/projects/${projectDir(folder)}`], { timeout: 5000 });
    const path = last.stdout.trim();
    if (!path) return null;
    const { tasks, mtime } = await this.read(path);
    if (!tasks.length || Date.now() - mtime > ENDED_MS) return null;
    return { label: "last session", endedAt: mtime, tasks };
  }

  // The transcript's tasks, reading only bytes added since the last call.
  async read(path) {
    const st = await exec("stat", ["-f", "%z %m", path], { timeout: 5000 });
    if (st.code !== 0) return { tasks: [], mtime: 0 };
    const [size, mtimeS] = st.stdout.trim().split(/\s+/).map(Number);
    let r = reads.get(path);
    if (!r || size < r.offset) { r = { offset: 0, state: newState() }; reads.set(path, r); }
    if (size > r.offset) {
      const g = await exec("sh", ["-c", CHUNK, "sh", path, String(r.offset), String(size)], { timeout: 15_000 });
      if (g.code <= 1) { feed(r.state, g.stdout.split("\n")); r.offset = size; } // 1: no task lines in it
    }
    return { tasks: list(r.state), mtime: mtimeS * 1000 };
  }

  // The Herdr agent's title for the session's pane, else its session name.
  label(space, session) {
    const byPane = new Map(panes().map((p) => [p.pane, p]));
    const agent = agents().find((a) => a.space === space.id && a.app === "claude-code" && byPane.get(a.pane)?.cwd === session.cwd);
    return agent?.title || session.name || "Claude Code";
  }

  showBlock(on) {
    if (on === this.shown || !props()?.block) return;
    this.shown = on;
    if (on) this.px = -1; // re-fit once shown
    run(on ? "layout.show" : "layout.hide", { id: block() });
  }

  fit(height) {
    const px = Math.ceil(height);
    if (px <= 0 || px === this.px || !props()?.block) return;
    this.px = px;
    run("layout.resize", { id: block(), px });
  }

  toggle(cx) {
    this.collapsed = !this.collapsed;
    try { localStorage.setItem(COLLAPSED_KEY, this.collapsed ? "1" : "0"); } catch {}
    cx.notify();
  }

  render(cx) {
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
