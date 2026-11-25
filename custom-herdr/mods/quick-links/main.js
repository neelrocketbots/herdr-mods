// Quick links: GitHub repo, PR and Linear issue for the focused terminal,
// as buttons on the right of the top bar, plus an editor button that opens the
// terminal's folder in your editor. Every link comes from context (the
// terminal's folder, git remote and branch).
// On a worktree whose PR is merged, "Merged · clean up" opens the worktree
// dialog on its Remove. The PR button carries a CI dot (click while failing opens the failing run).
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { exec, focused, panes, spaces, run, theme, window, checking, props, notify, openOverlay, layout, shared, setShared, readTextFile, appHome, nextCommand } from "herdr";
import { ciSummary, CI_COLOR, CI_WORD } from "./ci.js";
import { readSettings, editorOf, openInEditor, SETTINGS } from "./editor.js";
import { linearId, issueStatus, NoLinearKey, STATUS_COLOR } from "./linear.js";

// Settings come from herdr-mods.json in the app folder (see editor.js),
// re-read every SETTINGS_MS. `linear` maps a GitHub owner to its Linear
// workspace slug, "*" for any owner. Linear links and issue-PR lookups only
// happen for mapped owners, so personal repos with names like `plan-1/...`
// stay quiet. No mapping, no Linear links. `editor` picks the editor button's app.
// With a Linear API key in the Keychain, the Linear button shows the issue's
// status (see linear.js).
const SETTINGS_MS = 5000;
// No PR lookup on these: they are merge targets, not PR heads.
const BASE_BRANCHES = new Set(["main", "master", "dev", "develop", "staging", "production"]);
const REPO_TTL = 60_000;
const ISSUE_TTL = 5 * 60_000;
// Linear status: asked again after STATUS_TTL; without a key, checked again after NO_KEY_TTL.
const STATUS_TTL = 2 * 60_000;
const NO_KEY_TTL = 5 * 60_000;
// How long a PR lookup stays fresh: running CI changes fast, a merged or
// closed PR not at all, a branch without a PR yet somewhere between.
function prTtl(pr) {
  if (!pr) return 2 * 60_000;
  if (pr.state !== "OPEN") return 10 * 60_000;
  return ciSummary(pr.statusCheckRollup)?.state === "pending" ? 30_000 : 60_000;
}
// Lookups are kept in localStorage (a file that survives restarts and mod
// reloads), so links show at once and refresh behind; written at most every
// SAVE_MS, entries older than CACHE_DAYS or past CACHE_MAX per map dropped.
const CACHE_KEY = "quick-links.cache.v1";
const SAVE_MS = 15_000;
const CACHE_DAYS = 7;
const CACHE_MAX = 200;
// Focus check: a string compare, no programs run. Work only happens on a
// change, or every REFRESH_MS to catch a new or merged PR.
const TICK_MS = 300;
const WT_TTL = 60_000; // worktree counts for the Worktree badge
const WT_CHANGED = "issue-worktree.changed"; // issue-worktree bumps it after create/rename/remove
const REFRESH_MS = 20_000;
const icon = (name) => `mods/quick-links/${name}.svg`;
const PR_COLOR = { OPEN: "ansi2", MERGED: "ansi5", CLOSED: "ansi1" };

function parseGitHub(url) {
  const m = url.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

function openUrl(url) {
  const platform = window()?.platform;
  const [cmd, args] = platform === "macos" ? ["open", [url]]
    : platform === "windows" ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  // Always on this computer, even for a space on another machine.
  exec(cmd, args).catch(() => {});
}

async function output(cmd, args, ctx, timeout) {
  try {
    const r = await exec(cmd, args, { cwd: ctx.cwd, on: ctx.machine, timeout });
    return r.code === 0 ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

export default class QuickLinks extends View {
  init(_props, cx) {
    this.links = [];
    this.repos = new Map();    // machine|cwd -> { value, at }
    this.prs = new Map();      // machine|owner/repo#branch -> { value, at }
    this.issuePrs = new Map(); // machine|owner#ISSUE-ID -> { value: [pr], at }: open PRs naming the issue, any repo
    this.trees = new Map();    // machine|cwd -> { top, linked }: is it a worktree (not the main checkout)
    this.wtCounts = new Map(); // machine|cwd -> { value: linked worktrees in its repo, at }
    this.statuses = new Map(); // ISSUE-ID -> { value: { id, title, url, state, type, color } | null, at }
    this.noKeyAt = 0;        // when Linear last had no key (or refused it)
    this.inflight = new Map(); // same keys -> Promise, so one lookup per key
    this.key = null;
    this.gen = 0;
    this.at = 0;
    this.px = 0;
    this.linear = {};        // from herdr-mods.json
    this.editor = "Zed";     // the editor's name, for its button
    this.settingsKey = null; // last settings read, to rebuild only on change
    this.settingsBad = false;
    this.installed = { "issue-worktree": false, "pr-inbox": false }; // companion mods present?
    this.dirty = false;      // caches changed since the last save
    if (checking()) return;
    this.restore();
    cx.timer.every(SAVE_MS, () => this.save());
    this.loadSettings(cx);
    cx.timer.every(SETTINGS_MS, (cx) => this.loadSettings(cx));
    cx.timer.every(TICK_MS, (cx) => this.tick(cx));
    this.tick(cx);
    // Key and palette commands (mod.json "palette"; cmd-alt-n in custom-herdr
    // is "quick-links.worktrees"), for the focused terminal's folder.
    cx.spawn(async (cx) => {
      for (;;) {
        this.command(await nextCommand());
        cx.notify();
      }
    });
  }

  command(c) {
    const cwd = focused()?.cwd ?? undefined;
    const link = (test) => this.links.find((l) => test(l.id));
    const open = (l, what) => l ? openUrl(l.page ?? l.url) : notify({ title: `No ${what} for this folder`, level: "info" });
    if (c === "worktrees") this.activate({ dialog: "issue-worktree", cwd });
    else if (c === "new-worktree") {
      if (this.slot("worktrees").has) this.showSlot("worktrees", false);
      else openOverlay({ mod: "issue-worktree", kind: "dialog", width: 460, props: { cwd } });
    } else if (c === "prs") {
      if (this.slot("prs").has) this.showSlot("prs", true);
      else run("mod.open", { name: "pr-inbox" });
    } else if (c === "repo") open(link((id) => id === "repo"), "GitHub repo");
    else if (c === "pr") open(link((id) => id === "pr") ?? link((id) => id.startsWith("pr-issue-")), "pull request");
    else if (c === "linear") open(link((id) => id === "linear"), "Linear issue");
    else if (c === "editor" && cwd) openInEditor(cwd);
  }

  // Settings, and which companion mods are installed: the Worktree and
  // "Merged · clean up" buttons need issue-worktree, the PRs button pr-inbox.
  loadSettings(cx) {
    cx.spawn(async (cx) => {
      let changed = false;
      for (const name of Object.keys(this.installed)) {
        const here = (await readTextFile(`${appHome()}/mods/${name}/mod.json`).catch(() => null)) !== null;
        if (here !== this.installed[name]) { this.installed[name] = here; changed = true; }
      }
      if (changed) { this.at = 0; this.tick(cx); cx.notify(); }
      let settings;
      try {
        settings = await readSettings();
        this.settingsBad = false;
      } catch (e) {
        if (!this.settingsBad) notify({ title: `${SETTINGS} is invalid`, body: String(e?.message ?? e), level: "error" });
        this.settingsBad = true;
        return;
      }
      const key = JSON.stringify(settings);
      if (key === this.settingsKey) return;
      this.settingsKey = key;
      const linear = settings.linear ?? {};
      this.linear = typeof linear === "object" && !Array.isArray(linear) ? linear : {};
      this.editor = editorOf(settings).name;
      // The other mods label their editor buttons from this (no polling there).
      if (shared("herdr-mods.editor") !== this.editor) setShared("herdr-mods.editor", this.editor);
      this.at = 0; // rebuild the links with the new settings
      this.tick(cx);
    });
  }

  restore() {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}");
      for (const name of ["repos", "prs", "issuePrs", "trees", "statuses"]) {
        for (const [k, v] of c[name] ?? []) if (v && typeof v.at === "number") this[name].set(k, v);
      }
    } catch {}
  }

  save() {
    if (!this.dirty) return;
    this.dirty = false;
    const oldest = Date.now() - CACHE_DAYS * 86400_000;
    const keep = (m) => [...m].filter(([, v]) => v.at > oldest).sort((a, b) => b[1].at - a[1].at).slice(0, CACHE_MAX);
    for (const name of ["repos", "prs", "issuePrs", "trees", "statuses"]) this[name] = new Map(keep(this[name]));
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        repos: [...this.repos], prs: [...this.prs], issuePrs: [...this.issuePrs], trees: [...this.trees],
        statuses: [...this.statuses] }));
    } catch {}
  }

  // The Linear workspace for a repo's owner, from herdr-mods.json.
  slug(repo) {
    return this.linear[repo.owner] ?? this.linear["*"] ?? null;
  }

  block() {
    return props()?.block ?? "quick-links";
  }

  context() {
    const f = focused();
    if (!f) return undefined; // an overlay or nothing: keep what's shown
    if (!f.cwd) return null;
    const pane = f.pane ? panes().find((p) => p.pane === f.pane) : null;
    const machine = spaces().find((s) => s.id === f.space)?.machine ?? null;
    return { cwd: f.cwd, branch: pane?.branch ?? null, machine };
  }

  tick(cx) {
    // Window minimized, hidden or covered: no git or GitHub lookups until it's back.
    if (window()?.visible === false) return;
    const ctx = this.context();
    if (ctx === undefined) return;
    const key = ctx ? `${ctx.machine ?? ""}|${ctx.cwd}|${ctx.branch ?? ""}` : "";
    const changed = shared(WT_CHANGED) ?? 0;
    if (changed !== this.wtSeen) { this.wtSeen = changed; this.wtCounts.clear(); this.at = 0; }
    const now = Date.now();
    if (key === this.key && now - this.at < REFRESH_MS) return;
    this.key = key;
    this.at = now;
    const gen = ++this.gen;
    if (!ctx) return this.apply([], cx);
    // Whatever the caches know shows at once; lookups fill in after.
    this.apply(this.build(ctx, ctx.branch), cx);
    cx.spawn(async (cx) => {
      const repoKey = this.repoKey(ctx);
      if (!this.fresh(this.repos.get(repoKey), REPO_TTL)) await this.once(repoKey, () => this.lookupRepo(ctx, repoKey));
      const branch = ctx.branch ?? await output("git", ["branch", "--show-current"], ctx, 5000);
      if (gen !== this.gen) return;
      this.apply(this.build(ctx, branch), cx);
      // The Worktree button's badge: how many linked worktrees the repo has.
      if (!ctx.machine && this.repos.get(repoKey)?.value && !this.fresh(this.wtCounts.get(repoKey), WT_TTL)) {
        const out = await output("git", ["worktree", "list", "--porcelain"], ctx, 5000);
        if (gen !== this.gen) return;
        const n = out == null ? null : out.trim().split(/\n\n+/).slice(1).filter((b) => !/^(bare|prunable)/m.test(b)).length;
        this.wtCounts.set(repoKey, { value: n, at: Date.now() });
        this.apply(this.build(ctx, branch), cx);
      }
      const repo = this.repos.get(repoKey)?.value;
      if (!repo || !branch || BASE_BRANCHES.has(branch)) return;
      const linear = this.slug(repo) ? linearId(branch) : null;
      if (linear && this.wantStatus(linear)) {
        cx.spawn(async (cx) => {
          await this.once(`status|${linear}`, () => this.lookupStatus(linear));
          if (gen === this.gen) this.apply(this.build(ctx, branch), cx);
        });
      }
      const prKey = this.prKey(ctx, repo, branch);
      const known = this.prs.get(prKey);
      if (!this.fresh(known, prTtl(known?.value))) await this.once(prKey, () => this.lookupPr(ctx, repo, branch, prKey));
      if (gen !== this.gen) return;
      // No PR for this branch here: look for open PRs that name its Linear
      // issue anywhere in the org (a worktree WEB-140 whose fix is a PR in
      // another repo, on another branch).
      const issue = this.slug(repo) ? linearId(branch) : null;
      const issueKey = issue ? this.issueKey(ctx, repo, issue) : null;
      if (issueKey && !this.prs.get(prKey)?.value && !this.fresh(this.issuePrs.get(issueKey), ISSUE_TTL)) {
        this.apply(this.build(ctx, branch), cx);
        await this.once(issueKey, () => this.lookupIssuePrs(ctx, repo, issue, issueKey));
        if (gen !== this.gen) return;
      }
      // A merged PR on a worktree offers to clean it up: find out if it is one.
      if (this.prs.get(prKey)?.value?.state === "MERGED" && !ctx.machine && !this.trees.has(this.repoKey(ctx))) {
        const out = await output("git", ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"], ctx, 5000);
        const [top, gitDir, common] = (out ?? "").split("\n");
        this.trees.set(this.repoKey(ctx), { top, linked: Boolean(top) && gitDir !== common, at: Date.now() });
        this.dirty = true;
        if (gen !== this.gen) return;
      }
      this.apply(this.build(ctx, branch), cx);
    });
  }

  fresh(hit, ttl) {
    return hit && Date.now() - hit.at < ttl;
  }

  once(key, fn) {
    if (!this.inflight.has(key)) {
      this.inflight.set(key, fn().finally(() => this.inflight.delete(key)));
    }
    return this.inflight.get(key);
  }

  repoKey(ctx) {
    return `${ctx.machine ?? ""}|${ctx.cwd}`;
  }

  prKey(ctx, repo, branch) {
    return `${ctx.machine ?? ""}|${repo.owner}/${repo.repo}#${branch}`;
  }

  async lookupRepo(ctx, key) {
    const url = await output("git", ["remote", "get-url", "origin"], ctx, 5000);
    this.repos.set(key, { value: url ? parseGitHub(url) : null, at: Date.now() });
    this.dirty = true;
  }

  issueKey(ctx, repo, issue) {
    return `${ctx.machine ?? ""}|${repo.owner}#${issue}`;
  }

  // Open PRs in the owner's repos whose title or description names the issue
  // (GitHub's search is fuzzy, so the ID is checked again), newest first, two
  // at most, each with its checks.
  async lookupIssuePrs(ctx, repo, issue, key) {
    const out = await output("gh", ["search", "prs", issue, "--owner", repo.owner, "--state", "open", "--limit", "10",
      "--json", "repository,number,url,isDraft,title,body,updatedAt"], ctx, 15000);
    let found = [];
    try { found = out ? JSON.parse(out) : []; } catch { found = []; }
    const id = new RegExp(`(^|[^A-Za-z0-9])${issue.replace("-", "[-_ ]")}(?![0-9])`, "i");
    const prs = found.filter((p) => id.test(`${p.title}\n${p.body ?? ""}`))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 2);
    const value = await Promise.all(prs.map(async (p) => {
      const checks = await output("gh", ["pr", "view", String(p.number), "--repo", p.repository.nameWithOwner,
        "--json", "statusCheckRollup"], ctx, 15000);
      let rollup = [];
      try { rollup = JSON.parse(checks ?? "{}").statusCheckRollup ?? []; } catch {}
      return { number: p.number, url: p.url, state: "OPEN", isDraft: p.isDraft, title: p.title,
        repo: p.repository.nameWithOwner, statusCheckRollup: rollup };
    }));
    this.issuePrs.set(key, { value, at: Date.now() });
    this.dirty = true;
  }

  // Ask Linear for an issue's status? Not while known to have no key (checked
  // again after a while), and only when the last answer is old.
  wantStatus(issue) {
    if (Date.now() - this.noKeyAt < NO_KEY_TTL) return false;
    return !this.fresh(this.statuses.get(issue), STATUS_TTL);
  }

  async lookupStatus(issue) {
    try {
      const found = await issueStatus([issue]);
      this.statuses.set(issue, { value: found[issue] ?? null, at: Date.now() });
      this.dirty = true;
    } catch (e) {
      if (e instanceof NoLinearKey) this.noKeyAt = Date.now();
    }
  }

  async lookupPr(ctx, repo, branch, key) {
    const out = await output("gh", ["pr", "view", branch, "--repo", `${repo.owner}/${repo.repo}`,
      "--json", "number,url,state,isDraft,title,statusCheckRollup"], ctx, 15000);
    let value = null;
    try { value = out ? JSON.parse(out) : null; } catch { value = null; }
    this.prs.set(key, { value, at: Date.now() });
    this.dirty = true;
  }

  // The web links, then an editor button for the focused terminal's folder
  // (this computer only: a local editor can't open another machine's folder).
  // In a repo, a Worktree button toggles the worktrees panel (or opens the
  // issue-worktree dialog in layouts without one).
  build(ctx, branch) {
    const web = this.webLinks(ctx, branch);
    if (ctx.machine) return web;
    const worktree = web.length && this.installed["issue-worktree"] ? [{ id: "worktree", icon: "worktree", label: "Worktree", dialog: "issue-worktree", cwd: ctx.cwd, badge: this.wtCounts.get(this.repoKey(ctx))?.value ?? null, tip: "New worktree, or open an existing one" }] : [];
    return [...web, ...worktree, { id: "editor", icon: "editor", label: this.editor, path: ctx.cwd, tip: `Open ${ctx.cwd} in ${this.editor}` }];
  }

  // The layout's side-panel slot `id` (a panel-body child): { has, on }.
  slot(id) {
    const find = (n, k) => !n || typeof n !== "object" ? null : n.id === k ? n : (n.children ?? []).reduce((f, c) => f ?? find(c, k), null);
    const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
    const has = Boolean(body?.children?.some((c) => c.id === id));
    return { has, on: has && Boolean(panel) && !panel.hidden && body.active === id };
  }

  // Show (or with toggle, hide again) the side panel on slot `id`.
  showSlot(id, toggle) {
    if (toggle && this.slot(id).on) { run("layout.hide", { id: "panel" }); return; }
    run("layout.select", { stack: "panel-body", child: id });
    run("layout.show", { id: "panel" });
  }

  activate(l) {
    // Worktrees: the layout's "worktrees" panel when it has one (cleanup
    // hands it the row to remove), else the dialog.
    if (l.dialog === "issue-worktree" && this.slot("worktrees").has) {
      if (l.remove) { setShared("issue-worktree.remove", l.remove); this.showSlot("worktrees", false); }
      else this.showSlot("worktrees", true);
    } else if (l.dialog) openOverlay({ mod: l.dialog, kind: "dialog", width: 460, props: { cwd: l.cwd, remove: l.remove } });
    else if (l.path) openInEditor(l.path);
    else openUrl(l.url);
  }

  // Links from what's cached now (stale entries included: a refresh replaces them).
  webLinks(ctx, branch) {
    const repo = this.repos.get(this.repoKey(ctx))?.value;
    if (!repo) return [];
    const links = [{ id: "repo", icon: "github", label: repo.repo,
      url: `https://github.com/${repo.owner}/${repo.repo}`, tip: `${repo.owner}/${repo.repo}` }];
    if (!branch) return links;

    const prLink = (pr, id, label, note = "") => {
      const state = pr.isDraft && pr.state === "OPEN" ? "draft" : pr.state.toLowerCase();
      const ci = pr.state === "OPEN" ? ciSummary(pr.statusCheckRollup) : null;
      const ciTip = ci ? ` · ${CI_WORD[ci.state]}${ci.failed ? `: ${ci.failed.join(", ")} (click opens the failing run)` : ""}` : "";
      return { id, icon: "pr", label, page: pr.url, url: ci?.state === "failing" && ci.url ? ci.url : pr.url,
        color: pr.isDraft ? "dim" : PR_COLOR[pr.state] ?? "muted", dot: ci ? CI_COLOR[ci.state] : null,
        tip: `${state}: ${pr.title}${ciTip}${note}` };
    };
    const slug = this.slug(repo);
    const issue = slug ? linearId(branch) : null;
    const pr = BASE_BRANCHES.has(branch) ? null : this.prs.get(this.prKey(ctx, repo, branch))?.value;
    if (!pr?.url && issue && !BASE_BRANCHES.has(branch)) {
      const here = `${repo.owner}/${repo.repo}`;
      for (const [i, p] of (this.issuePrs.get(this.issueKey(ctx, repo, issue))?.value ?? []).entries()) {
        const short = p.repo === here ? "" : p.repo.split("/")[1];
        links.push(prLink(p, `pr-issue-${i}`, `${short}#${p.number}`, ` · ${p.repo}, found by ${issue}`));
      }
    }
    if (pr?.url) {
      links.push(prLink(pr, "pr", `#${pr.number}`));
      const tree = pr.state === "MERGED" ? this.trees.get(this.repoKey(ctx)) : null;
      if (tree?.linked && this.installed["issue-worktree"]) {
        links.push({ id: "cleanup", icon: "worktree", label: "Merged · clean up", color: "ansi5", dialog: "issue-worktree",
          cwd: ctx.cwd, remove: tree.top, tip: "Remove this worktree, its local branch and its space" });
      }
    }

    if (issue) {
      // With status: "WEB-140 · In Review", the logo in the status's color; an issue
      // moved to another team shows (and opens) its new ID.
      const s = this.statuses.get(issue)?.value;
      links.push(s
        ? { id: "linear", icon: "linear", label: `${s.id} · ${s.state}`, url: s.url, color: s.color ?? STATUS_COLOR[s.type] ?? "muted",
            tip: `${s.state}: ${s.title}${s.id !== issue ? ` (was ${issue})` : ""}` }
        : { id: "linear", icon: "linear", label: issue, url: `https://linear.app/${slug}/issue/${issue}`, tip: `Linear ${issue}` });
    }
    return links;
  }

  apply(links, cx) {
    if (JSON.stringify(links) === JSON.stringify(this.links)) return;
    this.links = links;
    cx.notify();
  }

  // Fit the block to its buttons; zero wide when there are none. The block is
  // never hidden: a mod only starts once its block shows, so a hidden block
  // (remembered across restarts) would never come back.
  fit(width) {
    const px = width > 0 ? Math.ceil(width) + 10 : 0;
    if (px === this.px) return;
    this.px = px;
    run("layout.resize", { id: this.block(), px });
  }

  render() {
    const t = theme();
    const stop = (_e, cx) => cx.stop_propagation();
    const wtOn = this.slot("worktrees").on;
    const button = (l) => h_flex().id(`ql-${l.id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
      .text_size(12).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .when(l.id === "worktree" && wtOn, (el) => el.bg(t.selected).text_color(t.foreground))
      .on_mouse_down("left", stop)
      .on_click(() => this.activate(l))
      .tooltip(l.tip)
      .child(svg(icon(l.icon)).size(14).text_color(!l.color ? t.muted : l.color.startsWith("#") ? l.color : t[l.color]))
      .child(div().max_w(160).truncate().child(l.label))
      .when(Boolean(l.dot), (el) => el.child(div().size(6).rounded(3).flex_none().bg(t[l.dot])))
      .when(l.badge > 0, (el) => el.child(div().px(5).rounded(8).text_size(10.5).bg(t.accent).text_color(t.background).child(String(l.badge))));
    // PRs: toggles the pr-inbox panel (the layout's panel-body child "prs"),
    // with how many PRs wait on your review once that panel has loaded.
    const find = (n, id) => !n || typeof n !== "object" ? null : n.id === id ? n : (n.children ?? []).reduce((f, c) => f ?? find(c, id), null);
    const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
    // In a layout with a "prs" panel child it toggles that panel; otherwise,
    // with pr-inbox installed, it opens it as a dialog.
    const inLayout = Boolean(body?.children?.some((c) => c.id === "prs"));
    const hasPrs = inLayout || this.installed["pr-inbox"];
    const prsOn = inLayout && panel && !panel.hidden && body.active === "prs";
    const waiting = shared("prinbox.review") ?? 0;
    const prsButton = h_flex().id("ql-prs").h(26).px(8).gap(5).flex_none().items_center().rounded(6).text_size(12)
      .bg(prsOn ? t.selected : t.chrome).text_color(prsOn ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop)
      .on_click(() => {
        if (!inLayout) run("mod.open", { name: "pr-inbox" });
        else if (prsOn) run("layout.hide", { id: "panel" });
        else { run("layout.select", { stack: "panel-body", child: "prs" }); run("layout.show", { id: "panel" }); }
      })
      .tooltip(waiting ? `${waiting} PR${waiting === 1 ? "" : "s"} waiting on your review` : "Pull requests")
      .child(svg(icon("pr")).size(14)).child("PRs")
      .when(waiting > 0, (el) => el.child(div().px(5).rounded(8).text_size(10.5).bg(t.accent).text_color(t.background).child(String(waiting))));
    // PRs and Worktree together, then the focused branch's links, the editor last.
    const tools = this.links.filter((l) => l.id === "worktree"), web = this.links.filter((l) => l.id !== "worktree");
    return h_flex().id("root").size_full().items_center().justify_end().pr(10)
      .bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().id("ql-content").flex_none().h_full().gap(3).items_center()
        .on_size_change((size) => this.fit(size.width))
        .when(hasPrs, (el) => el.child(prsButton))
        .children(tools.map(button))
        .when(web.length > 0 && (hasPrs || tools.length > 0), (el) => el.child(div().w(1).h(16).mx(4).bg(t.border)))
        .children(web.map(button)));
  }
}
