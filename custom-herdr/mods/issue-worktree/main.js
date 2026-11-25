// New worktree: a dialog that makes one git worktree (usually one per Linear
// issue, e.g. WEB-140, but any name works) and opens it as a space with a
// terminal.
//
//   <repo>/.worktrees/<name>   on branch <name>
//   branched from a fresh origin/master
//
// A name with a prefix (hotfix/WEB-140) is the branch; the folder is its last
// part (.worktrees/WEB-140). Worktrees nested deeper (.worktrees/WEB-140/web)
// or outside .worktrees are listed too; removing or moving one also deletes
// the parent folders it leaves empty, but only inside .worktrees/.
//
// Below the form it lists the repo's existing worktrees (newest commit first,
// filtered by what's typed in the name field). Clicking one goes to its space,
// or opens a new space there with a terminal. Creating an issue whose folder
// already exists does the same. Each row also shows its PR (state + CI dot,
// click opens it), its Linear issue's status when there's a Linear API key (see
// linear.js; click opens the issue), an open-in-editor button, and Remove (worktree + local branch + its
// space, after a confirm that warns about uncommitted changes), and Rename
// (the branch; optionally the folder too). props.remove = a worktree path
// opens straight on that row's Remove (the top bar's "merged · clean up").
//
// A side panel (the layout's panel-body child "worktrees", next to Files,
// Changes and PRs, toggled by the quick-links "Worktree" button) that follows
// the focused terminal's repo. In layouts without that slot it's a dialog,
// opened by the button with props { cwd } (any folder inside the repo or one
// of its worktrees), or by `mod.open:issue-worktree` (keys.json) for the
// focused terminal's folder. The top bar's "Merged · clean up" asks for a
// row's Remove with props.remove (dialog) or shared("issue-worktree.remove")
// (panel).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { exec, run, props, closeOverlay, theme, checking, focused, spaces, panes, home, notify, shared, setShared, layout } from "herdr";
import { ciSummary, CI_COLOR, CI_WORD } from "./ci.js";
import { openInEditor, editorName } from "./editor.js";
import { linearId, issueStatus, STATUS_COLOR } from "./linear.js";

const BASE = { remote: "origin", branch: "master" };
const LIST_MAX = 320; // px of worktree list before it scrolls (dialog)
const REMOVE_KEY = "issue-worktree.remove"; // panel: a worktree path whose Remove to open
const find = (n, id) => !n || typeof n !== "object" ? null : n.id === id ? n : (n.children ?? []).reduce((f, c) => f ?? find(c, id), null);
// One part of a name, safe as both a folder and a branch name part.
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// "hotfix/WEB-140" -> { branch: "hotfix/WEB-140", folder: "WEB-140" }; null when invalid.
function parseName(id) {
  const parts = id.split("/");
  if (id.includes("..") || !parts.every((p) => SEGMENT.test(p) && !p.endsWith(".lock"))) return null;
  return { branch: id, folder: parts[parts.length - 1] };
}
// A row's title: its folder under .worktrees/ (FRONT-504/web), else the folder's name.
function folderLabel(path, root) {
  const under = `${root}/.worktrees/`;
  return path.startsWith(under) ? path.slice(under.length) : path.split("/").pop();
}

const git = (args, cwd, timeout = 60_000) => exec("git", args, { cwd, timeout });

// After a worktree at `path` is removed or moved: delete the parent folders it
// left empty, deepest first, never .worktrees/ itself or anything outside it.
// rmdir only removes empty folders, so anything with files in it stays.
async function pruneEmptyParents(path, root) {
  const top = `${root}/.worktrees`;
  for (let dir = path.slice(0, path.lastIndexOf("/")); dir.startsWith(`${top}/`); dir = dir.slice(0, dir.lastIndexOf("/"))) {
    if ((await exec("rmdir", [dir])).code !== 0) return;
  }
}

// Programs whose working folder is inside `path` (a dev server, a shell, an
// agent): "node (4211)". Removing a worktree under them can stop partway.
async function runningIn(path) {
  const r = await exec("lsof", ["-a", "-d", "cwd", "-F", "pcn"], { timeout: 10_000 }).catch(() => null);
  if (!r?.stdout) return [];
  const out = [];
  let pid = null, cmd = null;
  for (const line of r.stdout.split("\n")) {
    if (line[0] === "p") pid = line.slice(1);
    else if (line[0] === "c") cmd = line.slice(1);
    else if (line[0] === "n" && (line.slice(1) === path || line.slice(1).startsWith(`${path}/`))) out.push(`${cmd} (${pid})`);
  }
  return [...new Set(out)];
}

// PRs per branch, by repo root, kept in module scope on purpose: each dialog
// open is a new copy of this mod, and module state is shared by copies (until
// the mod's code changes), so reopening shows the last known PRs at once and
// only asks GitHub again after PR_TTL.
const PR_CACHE = new Map(); // root -> { at, prs: { [branch]: pr | null } }
const PR_TTL = 60_000;
// Linear status per issue ID, the same way; no API key: {} (asked again after STATUS_TTL).
const STATUS_CACHE = { at: 0, issues: {} };
const STATUS_TTL = 60_000;

// One GraphQL request for every branch's latest PR (open, merged or closed)
// with its checks, instead of one `gh pr list` per worktree.
const PR_FIELDS = `nodes { number state isDraft url title
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
    __typename
    ... on CheckRun { name status conclusion detailsUrl startedAt completedAt }
    ... on StatusContext { context state targetUrl createdAt } } } } } } } }`;
async function prsFor(root, branches) {
  const remote = await git(["remote", "get-url", "origin"], root, 5000);
  const m = remote.stdout.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  if (!m || !branches.length) return {};
  const fields = branches.map((b, i) => `b${i}: pullRequests(headRefName: ${JSON.stringify(b)}, first: 1, ` +
    `states: [OPEN, MERGED, CLOSED], orderBy: {field: UPDATED_AT, direction: DESC}) { ${PR_FIELDS} }`).join("\n");
  const query = `query { repository(owner: ${JSON.stringify(m[1])}, name: ${JSON.stringify(m[2])}) { ${fields} } }`;
  const r = await exec("gh", ["api", "graphql", "-f", `query=${query}`], { cwd: root, timeout: 30_000 });
  if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || "gh api failed");
  const repo = JSON.parse(r.stdout).data?.repository ?? {};
  const out = {};
  branches.forEach((b, i) => {
    const n = repo[`b${i}`]?.nodes?.[0];
    out[b] = n ? { number: n.number, state: n.state, isDraft: n.isDraft, url: n.url, title: n.title,
      statusCheckRollup: n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [] } : null;
  });
  return out;
}

// The repo a folder belongs to: its git dir and main checkout, even from inside
// another worktree.
async function repoOf(cwd) {
  const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
  if (common.code !== 0) throw new Error("Not inside a git repository");
  const gitDir = common.stdout.trim();
  const root = gitDir.endsWith("/.git") ? gitDir.slice(0, -5) : (await git(["rev-parse", "--show-toplevel"], cwd)).stdout.trim();
  return { gitDir, root };
}

// The repo's worktrees (not the main checkout), most recently committed first:
// { path, branch, at, locked } (locked: null, or the lock's reason, maybe "").
async function worktrees(root) {
  const list = await git(["worktree", "list", "--porcelain"], root);
  if (list.code !== 0) return [];
  const refs = await git(["for-each-ref", "--format=%(refname:short)%09%(committerdate:unix)", "refs/heads"], root);
  const when = new Map(refs.stdout.trim().split("\n").map((l) => l.split("\t")).map(([b, at]) => [b, Number(at) || 0]));
  const out = [];
  for (const [i, block] of list.stdout.trim().split(/\n\n+/).entries()) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (i === 0 || !path || lines.some((l) => l === "bare" || l.startsWith("prunable"))) continue;
    const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? null;
    const lock = lines.find((l) => l === "locked" || l.startsWith("locked "));
    out.push({ path, branch, at: branch ? (when.get(branch) ?? 0) : 0, locked: lock === undefined ? null : lock.slice(7) });
  }
  return out.sort((a, b) => b.at - a.at);
}

// The local space showing a folder: one of its terminals is inside it (the
// deepest worktree wins, so the main checkout's space doesn't claim them).
function spaceOf(path, all) {
  const inside = (p, dir) => p === dir || p.startsWith(dir + "/");
  const paneList = panes();
  return spaces().find((s) => {
    if (s.machine) return false;
    const tabs = new Set((s.tabs ?? []).map((c) => c.id));
    const at = paneList.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
    if (!at || !inside(at, path)) return false;
    return !all.some((c) => c.path !== path && c.path.length > path.length && inside(at, c.path));
  });
}

const ago = (s) => {
  const d = Date.now() / 1000 - s;
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < 86400 ? `${Math.round(d / 3600)}h` : d < 86400 * 60 ? `${Math.round(d / 86400)}d` : `${Math.round(d / 86400 / 30)}mo`;
};

export default class IssueWorktree extends View {
  init(_props, cx) {
    this.issue = "";
    this.busy = null;   // what it's doing now, or null
    this.busyPath = null; // the worktree row it's working on (rename, remove), or null
    this.error = null;
    this.repo = null;   // { gitDir, root } once found
    this.list = undefined;
    this.cwd = undefined; // the folder whose repo is shown
    this.onScreen = false; // panel: on screen at the last render
    this.loadedAt = 0;
    this.home = checking() ? "" : home();
    this.issueInput = InputState.new({ placeholder: "WEB-140 or hotfix/WEB-140 (also filters the list below)" });
    this.issueInput.on("change", (_e, cx) => { this.issue = this.issueInput.value(); this.error = null; cx.notify(); });
    this.issueInput.on("submit", (_e, cx) => this.create(cx));
    this.handle = cx.focus_handle();
    this.editor = "editor";
    this.confirm = null; // { path, dirty } while a Remove waits for confirmation
    this.renaming = null; // { path, branch, move, pushed } while a row is being renamed
    this.renameText = "";
    this.renameInput = InputState.new({ placeholder: "new name, e.g. hotfix/WEB-140-export-timeout" });
    this.renameInput.on("change", (_e, cx) => { this.renameText = this.renameInput.value(); this.error = null; cx.notify(); });
    this.renameInput.on("submit", (_e, cx) => this.rename(cx));
    if (checking()) return;
    cx.spawn(async (cx) => { this.editor = await editorName(); cx.notify(); });
    if (this.panel()) {
      // Let the tab bar keep this panel per space like Files, Changes and PRs.
      const panels = shared("workspace.panels") ?? ["files", "changes"];
      if (!panels.includes("worktrees")) setShared("workspace.panels", [...panels, "worktrees"]);
      return; // render() follows the focused terminal while shown
    }
    this.issueInput.focus();
    cx.timer.after(600, () => this.issueInput.focus());
    this.follow(props()?.cwd ?? focused()?.cwd, cx);
  }

  // A panel in the layout, or a dialog?
  panel() { return !props()?.overlay; }

  // Is it on screen (a dialog, or the layout's panel shown on this child)?
  visible() {
    if (!this.panel()) return true;
    const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
    return Boolean(panel && !panel.hidden && body?.active === "worktrees");
  }

  // Show the repo around `cwd`: find it, then list its worktrees. The same
  // repo again just reloads (PRs stay cached for PR_TTL).
  follow(cwd, cx) {
    this.cwd = cwd;
    if (!cwd) { this.repo = null; this.repoError = "No folder: focus a terminal inside a repo first"; this.list = []; this.followed = cwd; cx.notify(); return; }
    this.followTask = cx.spawn(async (cx) => {
      let repo;
      try {
        repo = await repoOf(cwd);
      } catch (e) {
        if (this.cwd !== cwd) return;
        this.repo = null; this.repoError = String(e?.message ?? e); this.list = []; this.followed = cwd;
        cx.notify();
        return;
      }
      if (this.cwd !== cwd) return;
      if (repo.root !== this.repo?.root) { this.list = undefined; this.confirm = null; this.renaming = null; }
      this.repo = repo; this.repoError = null;
      try { await this.reload(cx); } finally { this.followed = cwd; } // a failed reload mustn't retry on every render
      this.loadedAt = Date.now();
      // Opened from the top bar's "merged · clean up": go straight to its Remove.
      const target = props()?.remove && this.list.find((c) => c.path === props().remove);
      if (target) this.askRemove(target, cx);
    });
  }

  // Panel: follow the focused terminal while shown, reload when shown again
  // after PR_TTL, focus the name field on showing, and take a pending Remove.
  track(cx) {
    const shown = this.visible();
    if (shown) {
      const cwd = focused()?.cwd ?? this.cwd ?? spaces().find((s) => s.active)?.folder;
      // Also again when the last follow never finished (a mod reload stops it).
      const lost = this.followed !== cwd && !(this.followTask && !this.followTask.is_done());
      if (cwd !== this.cwd || lost || (!this.onScreen && Date.now() - this.loadedAt > PR_TTL)) this.follow(cwd, cx);
      if (!this.onScreen) cx.timer.after(50, () => this.issueInput.focus());
      const want = shared(REMOVE_KEY);
      const target = want && this.list?.find((c) => c.path === want);
      if (target) { setShared(REMOVE_KEY, null); this.askRemove(target, cx); }
    }
    this.onScreen = shown;
  }

  // Read the worktrees and show them with the PRs known so far, then (when
  // those are older than PR_TTL, or a branch is new) ask GitHub once for all.
  // force: after a rename or remove, when branches changed.
  async reload(cx, force = false) {
    if (force) setShared("issue-worktree.changed", Date.now()); // the top bar's badge recounts
    const root = this.repo.root;
    const list = await worktrees(root);
    const cached = PR_CACHE.get(root);
    for (const c of list) {
      c.pr = c.branch ? cached?.prs[c.branch] : undefined;
      c.issue = c.branch ? linearId(c.branch) : null;
      c.status = c.issue ? STATUS_CACHE.issues[c.issue] : undefined;
    }
    this.list = list;
    cx.notify();
    this.reloadStatus(cx, force);
    const branches = list.map((c) => c.branch).filter(Boolean);
    const stale = force || !cached || Date.now() - cached.at > PR_TTL || branches.some((b) => !(b in cached.prs));
    if (!stale) return;
    try {
      const prs = await prsFor(root, branches);
      PR_CACHE.set(root, { at: Date.now(), prs });
      for (const c of this.list) if (c.branch) c.pr = prs[c.branch];
    } catch {}
    cx.notify();
  }

  // Every row's Linear issue status in one request (none without a Linear API key).
  async reloadStatus(cx, force) {
    const ids = [...new Set(this.list.map((c) => c.issue).filter(Boolean))];
    if (!ids.length) return;
    if (!force && Date.now() - STATUS_CACHE.at < STATUS_TTL && ids.every((id) => id in STATUS_CACHE.issues)) return;
    if (!force && Date.now() - STATUS_CACHE.at < STATUS_TTL && STATUS_CACHE.out) return;
    try {
      STATUS_CACHE.issues = { ...STATUS_CACHE.issues, ...(await issueStatus(ids)) };
      STATUS_CACHE.out = false;
    } catch {
      STATUS_CACHE.out = true; // no API key, or Linear unreachable
    }
    STATUS_CACHE.at = Date.now();
    for (const c of this.list) if (c.issue) c.status = STATUS_CACHE.issues[c.issue];
    cx.notify();
  }

  startRename(c, cx) {
    this.confirm = null;
    this.renaming = { path: c.path, branch: c.branch, move: !c.branch, pushed: false };
    this.renameText = c.branch ?? c.path.split("/").pop();
    this.renameInput.set_value(this.renameText);
    this.renameInput.focus();
    cx.notify();
    if (!c.branch) return;
    cx.spawn(async (cx) => {
      const up = await git(["rev-parse", "--abbrev-ref", `${c.branch}@{u}`], this.repo.root);
      if (this.renaming?.path === c.path) { this.renaming.pushed = up.code === 0; cx.notify(); }
    });
  }

  // Rename the branch; with `move`, also move the folder to .worktrees/<last
  // part of the name> (closing and reopening its space, whose terminals end).
  rename(cx) {
    const r = this.renaming;
    if (!r || this.busy) return;
    const name = this.renameText.trim(), folder = name.split("/").pop();
    const c = (this.list ?? []).find((x) => x.path === r.path);
    if (!c) return;
    const dir = `${this.repo.root}/.worktrees/${folder}`;
    const branchChanges = Boolean(r.branch) && name !== r.branch, moves = r.move && dir !== r.path;
    if (!branchChanges && !moves) { this.renaming = null; cx.notify(); return; }
    this.busy = "Renaming…"; this.busyPath = r.path; this.error = null; cx.notify();
    this.busyTask = cx.spawn(async (cx) => {
      try {
        if (branchChanges) {
          const ok = await git(["check-ref-format", "--branch", name], this.repo.root);
          if (ok.code !== 0) throw new Error(`"${name}" isn't a valid branch name`);
          const mv = await git(["branch", "-m", r.branch, name], this.repo.root);
          if (mv.code !== 0) throw new Error(mv.stderr.trim() || "git branch -m failed");
        }
        if (moves) {
          if ((await exec("test", ["-e", dir])).code === 0) throw new Error(`.worktrees/${folder} already exists`);
          const s = spaceOf(r.path, this.list ?? []);
          if (s) run("space.close", { id: s.id, confirmed: true });
          const wm = await git(["worktree", "move", r.path, dir], this.repo.root);
          if (wm.code !== 0) throw new Error(wm.stderr.trim() || "git worktree move failed");
          await pruneEmptyParents(r.path, this.repo.root);
          if (s) run("space.new", { folder: dir });
        }
        this.renaming = null;
        this.busy = null; this.busyPath = null;
        await this.reload(cx, true);
      } catch (e) {
        this.busy = null; this.busyPath = null;
        this.error = String(e?.message ?? e);
        cx.notify();
        await this.reload(cx).catch(() => {});
      }
    });
  }

  askRemove(c, cx) {
    if (this.busy) return;
    this.renaming = null;
    // git status and lsof can take a moment: show it on the row meanwhile.
    this.busy = "Checking…"; this.busyPath = c.path;
    cx.notify();
    const started = Date.now();
    this.checking = started;
    // However the checks end (done, failed, or stuck past 20s), the spinner goes.
    // The cx of each async callback, never the caller's: that one is dead
    // once the click or render that started this has returned.
    const finish = (cx, confirm, error) => {
      if (this.checking !== started) return;
      this.checking = null; this.busy = null; this.busyPath = null;
      if (confirm) this.confirm = confirm;
      if (error) this.error = error;
      cx.notify();
    };
    cx.timer.after(20_000, (cx) => finish(cx, null, "Checking this worktree took too long (git status or lsof didn't answer). Try Remove again."));
    this.busyTask = cx.spawn(async (cx) => {
      try {
        const [status, running] = await Promise.all([
          git(["--no-optional-locks", "status", "--porcelain"], c.path, 15_000).catch((e) => ({ code: -1, stdout: "", stderr: String(e?.message ?? e) })),
          runningIn(c.path),
        ]);
        finish(cx, { path: c.path, dirty: status.code !== 0 || status.stdout.trim() !== "", running, locked: c.locked });
      } catch (e) {
        finish(cx, null, `Couldn't check this worktree: ${e?.message ?? e}`);
      }
    });
  }

  // Close its space, remove the worktree, delete its local branch.
  remove(c, cx) {
    const dirty = this.confirm?.dirty, locked = this.confirm?.locked != null;
    this.confirm = null;
    this.busy = "Removing…"; this.busyPath = c.path;
    cx.notify();
    this.busyTask = cx.spawn(async (cx) => {
      try {
        const s = spaceOf(c.path, this.list ?? []);
        if (s) run("space.close", { id: s.id, confirmed: true });
        // Locked (git worktree lock): the confirm said so, and Remove means unlock first.
        if (locked) await git(["worktree", "unlock", c.path], this.repo.root);
        const rm = await git(["worktree", "remove", ...(dirty ? ["--force"] : []), c.path], this.repo.root);
        if (rm.code !== 0) {
          // A removal that stopped partway (a dev server still running in the
          // folder, say) leaves files git no longer tracks, and every retry then
          // fails with "is not a working tree". Once git has let go of it, clear
          // the leftovers, but only inside <repo>/.worktrees/.
          await git(["worktree", "prune"], this.repo.root);
          const listed = (await git(["worktree", "list", "--porcelain"], this.repo.root)).stdout
            .split("\n").some((l) => l === `worktree ${c.path}`);
          if (listed || !c.path.startsWith(`${this.repo.root}/.worktrees/`)) throw new Error(rm.stderr.trim() || "git worktree remove failed");
          const left = await exec("rm", ["-rf", c.path]);
          if (left.code !== 0) throw new Error(`Couldn't delete the leftover folder: ${left.stderr.trim()}`);
          notify({ title: "Worktree removed", body: "git had already let go of it; its leftover files were deleted.", level: "info" });
        }
        await pruneEmptyParents(c.path, this.repo.root);
        if (c.branch) {
          const br = await git(["branch", "-D", c.branch], this.repo.root);
          if (br.code !== 0) notify({ title: "Worktree removed, branch kept", body: br.stderr.trim(), level: "warning" });
        }
        this.busy = null; this.busyPath = null;
        await this.reload(cx, true);
      } catch (e) {
        this.busy = null; this.busyPath = null;
        this.error = String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  id() { return this.issue.trim(); }

  shown() {
    const f = this.issue.trim().toLowerCase();
    return (this.list ?? []).filter((c) => !f || `${c.branch ?? ""} ${c.path}`.toLowerCase().includes(f));
  }

  openEditor(path) {
    openInEditor(path);
  }

  // Go to the worktree's space, or open one there with a terminal.
  open(path) {
    if (this.busyPath === path) return;
    const s = spaceOf(path, this.list ?? []);
    if (!this.panel()) closeOverlay(props()?.overlay);
    if (s) run("space.select", { id: s.id });
    else run("space.new", { folder: path });
  }

  create(cx) {
    if (this.busy) return;
    const name = parseName(this.id());
    if (!name) { this.error = "Use letters, numbers, dot, dash or underscore, / separates a prefix, e.g. WEB-140 or hotfix/WEB-140"; cx.notify(); return; }
    if (!this.repo) { this.error = this.repoError ?? "Still finding the repo…"; cx.notify(); return; }
    const { gitDir, root } = this.repo, { branch, folder } = name, dir = `${root}/.worktrees/${folder}`;
    this.busy = "Checking…"; this.error = null; cx.notify();

    this.busyTask = cx.spawn(async (cx) => {
      const step = (text) => { this.busy = text; cx.notify(); };
      try {
        if ((await exec("test", ["-d", dir])).code === 0) { this.open(dir); return; }
        if ((await git(["check-ref-format", "--branch", branch], root)).code !== 0) throw new Error(`"${branch}" isn't a valid branch name`);

        step(`Fetching ${BASE.remote}/${BASE.branch}…`);
        const fetch = await git(["fetch", BASE.remote, BASE.branch], root, 120_000);
        if (fetch.code !== 0) throw new Error(fetch.stderr.trim() || "git fetch failed");

        // Keep .worktrees/ out of `git status` in repos that don't ignore it.
        if ((await git(["check-ignore", "-q", `.worktrees/${folder}`], root)).code !== 0) {
          await exec("sh", ["-c", 'mkdir -p "$(dirname "$1")" && printf "\\n.worktrees/\\n" >> "$1"', "sh", `${gitDir}/info/exclude`]);
        }

        step(`Creating ${branch}…`);
        const add = await git(["worktree", "add", "-b", branch, dir, `${BASE.remote}/${BASE.branch}`], root);
        if (add.code !== 0) throw new Error(add.stderr.trim() || "git worktree add failed");

        if (!this.panel()) closeOverlay(props()?.overlay);
        setShared("issue-worktree.changed", Date.now());
        this.busy = null; this.busyPath = null; this.issue = ""; this.issueInput.set_value("");
        run("space.new", { folder: dir });
        if (this.panel()) await this.reload(cx, true);
      } catch (e) {
        this.busy = null; this.busyPath = null;
        this.error = String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  renderList(t) {
    const all = this.list, rows = this.shown(), panel = this.panel();
    const tilde = (p) => (this.home && p.startsWith(this.home) ? `~${p.slice(this.home.length)}` : p);
    const PR_COLOR = { OPEN: "ansi2", MERGED: "ansi5", CLOSED: "ansi1" };
    const action = (id, child, onClick, hover = t.foreground) => div().id(id).flex_none().px(5).py(1).rounded(5)
      .text_size(11).text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.raised).text_color(hover))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }).child(child);
    const row = (c, i) => {
      const there = spaceOf(c.path, all), pr = c.pr, confirming = this.confirm?.path === c.path;
      const renaming = this.renaming?.path === c.path ? this.renaming : null;
      const ci = pr?.state === "OPEN" ? ciSummary(pr.statusCheckRollup) : null;
      const prWord = pr ? (pr.isDraft && pr.state === "OPEN" ? "draft" : pr.state.toLowerCase()) : null;
      // Title: the folder (short, unique); the branch goes under it when it says more.
      const label = folderLabel(c.path, this.repo?.root ?? ""), branchNote = c.branch === label ? null : (c.branch ?? "detached");
      // The worktree whose space is the one shown now.
      const current = Boolean(there?.active), working = this.busyPath === c.path;
      return v_flex().id(`iw-wt-${i}`).flex_none().px(10).justify_center().rounded(7).cursor_pointer()
        .when(panel, (el) => el.py(7).gap(3)).when(!panel, (el) => el.min_h(44).py(5))
        .when(current && !confirming && !renaming, (el) => el.bg(t.selected))
        .when(confirming || Boolean(renaming), (el) => el.bg(t.raised)).when(!confirming && !renaming, (el) => el.hover((s) => s.bg(t.hover)))
        .when(working, (el) => el.opacity(0.7))
        .on_click(() => this.open(c.path))
        .child(h_flex().gap(6).items_center()
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(label))
          .when(Boolean(pr), (el) => el.child(h_flex().id(`iw-pr-${i}`).flex_none().gap(4).items_center().px(5).py(1).rounded(5)
            .text_size(11).text_color(pr.isDraft ? t.dim : t[PR_COLOR[pr.state]] ?? t.muted).cursor_pointer().hover((s) => s.bg(t.raised))
            .tooltip(`${pr.title}${ci ? ` · ${CI_WORD[ci.state]}` : ""}`)
            .on_click((_e, cx) => { cx.stop_propagation(); exec("open", [ci?.state === "failing" && ci.url ? ci.url : pr.url]).catch(() => {}); })
            .child(`#${pr.number} ${prWord}`)
            .when(Boolean(ci), (el) => el.child(div().size(6).rounded(3).bg(t[CI_COLOR[ci.state]])))))
          .when(Boolean(c.status), (el) => el.child(h_flex().id(`iw-st-${i}`).flex_none().gap(4).items_center().px(5).py(1).rounded(5)
            .text_size(11).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.raised).text_color(t.foreground))
            .tooltip(`${c.status.id}: ${c.status.title}${c.status.id !== c.issue ? ` (was ${c.issue})` : ""}`)
            .on_click((_e, cx) => { cx.stop_propagation(); exec("open", [c.status.url]).catch(() => {}); })
            .child(svg("mods/issue-worktree/linear.svg").size(12).text_color(c.status.color ?? t[STATUS_COLOR[c.status.type] ?? "muted"]))
            .child(c.status.state)))
          .when(c.locked != null, (el) => el.child(div().id(`iw-lock-${i}`).flex_none().text_size(11).text_color(t.blocked)
            .tooltip(c.locked ? `Locked: ${c.locked}` : "Locked (git worktree lock)").child("locked")))
          .when(Boolean(there), (el) => el.child(div().flex_none().text_size(11).text_color(t.accent).child("open")))
          .when(!there && c.at > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(ago(c.at)))))
        .child(h_flex().gap(2).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(branchNote ? `${branchNote}  ·  ${tilde(c.path)}` : tilde(c.path)))
          .when(working, (el) => el.child(h_flex().flex_none().gap(5).items_center().px(5).text_size(11).text_color(t.muted)
            .child(svg("mods/issue-worktree/spinner.svg").size(12).text_color(t.working ?? t.accent).spin(900)).child(this.busy ?? "Working…")))
          .when(!working, (el) => el
            .child(action(`iw-editor-${i}`, svg("mods/issue-worktree/editor.svg").size(13), () => this.openEditor(c.path)).tooltip(`Open in ${shared("herdr-mods.editor") ?? this.editor}`))
            .child(action(`iw-rn-${i}`, "rename", (cx) => this.startRename(c, cx)))
            .child(action(`iw-rm-${i}`, "remove", (cx) => this.askRemove(c, cx), t.ansi1))))
        .when(confirming, (el) => el.child(h_flex().pt(6).gap(6).items_center()
          .child(div().flex_1().min_w(0).text_size(11.5).text_color(this.confirm.dirty || this.confirm.running?.length || this.confirm.locked != null ? t.ansi1 : t.muted)
            .child((this.confirm.running?.length ? `Still running in it: ${this.confirm.running.join(", ")}. Stop them first. ` : "") +
              (this.confirm.locked != null ? `It's locked${this.confirm.locked ? ` (${this.confirm.locked})` : ""}: Remove unlocks it first. ` : "") +
              (this.confirm.dirty ? "Uncommitted changes will be lost. Remove anyway?" : `Remove the worktree${c.branch ? " and its local branch" : ""}${there ? ", and close its space" : ""}?`)))
          .child(action(`iw-rm-no-${i}`, "cancel", (cx) => { this.confirm = null; cx.notify(); }))
          .child(div().id(`iw-rm-yes-${i}`).flex_none().px(8).py(2).rounded(5).text_size(11).bg(t.ansi1).text_color(t.background).cursor_pointer()
            .on_click((_e, cx) => { cx.stop_propagation(); this.remove(c, cx); }).child("Remove"))))
        .when(Boolean(renaming), (el) => {
          const stop = (_e, cx) => cx.stop_propagation();
          const folder = this.renameText.trim().split("/").pop() || "—";
          const box = div().size(12).rounded(3).border_1().border_color(renaming.move ? t.accent : t.input).bg(renaming.move ? t.accent : t.background);
          return el.child(v_flex().pt(6).gap(6).on_mouse_down("left", stop).on_click(stop)
            .child(Input.new(this.renameInput).h(30).px(8).rounded(7).border_1().border_color(t.accent).bg(t.background).text_size(12).text_color(t.foreground))
            .when(Boolean(c.branch), (el) => el.child(h_flex().id(`iw-rn-move-${i}`).gap(6).items_center().cursor_pointer().text_size(11.5).text_color(t.muted)
              .on_click((_e, cx) => { cx.stop_propagation(); renaming.move = !renaming.move; cx.notify(); })
              .child(box).child(`Also move the folder to .worktrees/${folder}${there ? " (closes and reopens its space)" : ""}`)))
            .when(renaming.pushed, (el) => el.child(div().text_size(11.5).text_color(t.blocked)
              .child("Pushed branch: the remote keeps the old name, and an open PR stays on it. Push the new name and open a new PR.")))
            .child(h_flex().gap(6).justify_end()
              .child(action(`iw-rn-no-${i}`, "cancel", (cx) => { this.renaming = null; cx.notify(); }))
              .child(div().id(`iw-rn-yes-${i}`).flex_none().px(8).py(2).rounded(5).text_size(11).bg(t.solid).text_color(t.solid_foreground).cursor_pointer()
                .on_click((_e, cx) => { cx.stop_propagation(); this.rename(cx); }).child("Rename"))));
        });
    };
    const count = all === undefined ? "loading…" : rows.length === all.length ? `${all.length}` : `${rows.length}/${all.length}`;
    // A content-sized dialog gives the list no height to scroll in, so it gets
    // one: its rows' height, at most LIST_MAX (then it scrolls). The panel's
    // list takes whatever height is left.
    const box = panel ? div().flex_1().min_h(0).relative()
      : div().relative().h(Math.min(LIST_MAX, Math.max(40, rows.reduce((h, c) =>
          h + 56 + (this.renaming?.path === c.path ? 120 : 0) + (this.confirm?.path === c.path ? 36 : 0), 0))));
    const heading = h_flex().gap(6).items_center()
      .child(div().text_size(11.5).text_color(t.dim).child("Existing worktrees"))
      .child(div().text_size(11).text_color(t.dim).child(count));
    return v_flex().when(panel, (el) => el.flex_1().min_h(0)).when(!panel, (el) => el.pt(16))
      .child(panel ? heading.flex_none().px(16).pt(10).pb(4) : heading.pb(6).border_t(1).border_color(t.border).pt(12))
      .child(box
        .child(v_flex().id("iw-list").size_full().overflow_y_scroll().gap(2).when(panel, (el) => el.p(6))
          .children(rows.map(row))
          .when(all !== undefined && rows.length === 0, (el) => el.child(div().px(10).py(8).text_size(12).text_color(t.dim)
            .child(this.repoError ?? (all.length ? "No worktree matches" : "No worktrees yet")))))
        .child(Scrollbar.vertical("iw-list").absolute().inset_0()));
  }

  render(cx) {
    // A busy flag with no live task behind it (a mod reload stops tasks but can
    // keep this state) would spin for ever: drop it.
    if (this.busy && !(this.busyTask && !this.busyTask.is_done())) { this.busy = null; this.busyPath = null; this.checking = null; }
    if (this.panel() && !checking()) this.track(cx);
    const t = theme(), panel = this.panel();
    const label = (text) => div().pt(14).pb(6).text_size(11.5).text_color(t.dim).child(text);
    const button = (id, text, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .when(Boolean(this.busy), (el) => el.opacity(0.6))
      .hover((s) => s.opacity(0.88)).on_click(action).child(text);
    const name = parseName(this.id());
    const exists = name && this.repo && (this.list ?? []).some((c) => c.path === `${this.repo.root}/.worktrees/${name.folder}`);

    const repoName = this.repo?.root.split("/").pop();
    const hints = v_flex().gap(3).text_size(11.5).text_color(t.dim)
      .child(div().truncate().child(exists ? `.worktrees/${name.folder} already exists · Enter opens it` : `Branch  ${name?.branch ?? "—"}`))
      .when(!exists, (el) => el.child(div().truncate().child(`Folder  .worktrees/${name?.folder ?? "—"}  ·  from ${BASE.remote}/${BASE.branch}  ·  opens a terminal`)));

    const busyLine = h_flex().gap(6).items_center().text_size(11.5).text_color(t.muted)
      .child(svg("mods/issue-worktree/spinner.svg").size(12).text_color(t.working ?? t.accent).spin(900)).child(this.busy ?? "");
    if (panel) {
      // Sized like the PRs panel: 13px text, a 42px header, 11.5px secondary lines.
      return v_flex().id("issue-worktree").track_focus(this.handle).size_full().min_h(0).rounded(10).overflow_hidden()
        .bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
        .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
          .child(div().flex_none().font_semibold().child("Worktrees"))
          .when(Boolean(repoName), (el) => el.child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(repoName))))
        .child(v_flex().flex_none().px(14).py(10).gap(8).border_b(1).border_color(t.border)
          .child(h_flex().gap(6).items_center()
            .child(Input.new(this.issueInput).flex_1().h(30).px(9).rounded(7).border_1().border_color(t.accent)
              .bg(t.background).text_size(12).text_color(t.foreground))
            .child(h_flex().id("iw-create").h(30).px(12).flex_none().items_center().rounded(7).bg(t.solid)
              .text_color(t.solid_foreground).text_size(12).font_medium().cursor_pointer()
              .when(Boolean(this.busy), (el) => el.opacity(0.6)).hover((s) => s.opacity(0.88))
              .on_click((_e, cx) => this.create(cx)).child(this.busy ? "Working…" : exists ? "Open" : "Create")))
          .child(hints)
          .when(Boolean(this.busy) && !this.busyPath, (el) => el.child(busyLine))
          .when(Boolean(this.error), (el) => el.child(div().text_size(11.5).text_color(t.ansi1).child(this.error))))
        .child(this.renderList(t));
    }

    return v_flex().id("issue-worktree").track_focus(this.handle).w_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1().text_size(15).font_semibold().child("New worktree"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(label("Worktree name"))
      .child(Input.new(this.issueInput).h(36).px(10).rounded(9).border_1().border_color(t.accent)
        .bg(t.background).text_size(12.8).text_color(t.foreground))
      .child(hints.pt(14))
      .when(Boolean(this.error), (el) => el.child(div().pt(10).text_size(11.5).text_color(t.ansi1).child(this.error)))
      .child(h_flex().pt(18).gap(8).items_center()
        .child(div().flex_1().when(Boolean(this.busy) && !this.busyPath, (el) => el.child(busyLine)))
        .child(button("iw-cancel", "Cancel", false, () => closeOverlay(props()?.overlay)))
        .child(button("iw-create", this.busy ? "Working…" : exists ? "Open" : "Create", true, (_e, cx) => this.create(cx))))
      .child(this.renderList(t));
  }
}
