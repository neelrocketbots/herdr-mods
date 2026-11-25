// PR inbox: a side panel (next to Files and Changes, opened by the top bar's
// PRs button), or a dialog (`mod.open:pr-inbox`, cmd-alt-p) in layouts without
// a "prs" panel slot, with the open PRs waiting on your review and your own open PRs,
// across every repo, from one GitHub GraphQL query through `gh`.
//
// Each row: title, repo#number, author, review state, conflicts, CI dot, age.
// Click: go to the space whose branch is that PR's (your worktree for it), else
// open it on GitHub; ↗ always opens GitHub. Bots and PRs untouched for 30 days
// fold into a row of their own. Refreshes every 3 minutes while the panel is
// shown (and on opening it, when its data is over a minute old), every 10
// while hidden, for the top bar's count. The last result is kept in
// localStorage, so the panel fills at once after a restart.
// Publishes the review count as shared("prinbox.review") for the top bar.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar } from "gpui-base";
import { exec, run, theme, spaces, shared, setShared, checking, layout, props, window } from "herdr";

const QUERY = `query {
  review: search(query: "is:pr is:open archived:false review-requested:@me", type: ISSUE, first: 50) { nodes { ...pr } }
  mine: search(query: "is:pr is:open archived:false author:@me", type: ISSUE, first: 50) { nodes { ...pr } }
}
fragment pr on PullRequest {
  number title url isDraft updatedAt headRefName reviewDecision mergeable
  repository { nameWithOwner } author { login }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`;
const SHOWN_MS = 3 * 60_000;   // refresh while the panel is shown
const HIDDEN_MS = 10 * 60_000; // ... and while it isn't (keeps the count fresh)
const OPENED_MS = 60_000;      // on opening the panel, refresh data older than this
const CACHE_KEY = "pr-inbox.cache.v1";
const STALE_DAYS = 30;
const BOTS = new Set(["github-actions", "dependabot", "renovate", "crowdin", "snyk-bot"]);
const isBot = (login) => !login || login.endsWith("[bot]") || BOTS.has(login);
const CI = { SUCCESS: ["ansi2", "CI passing"], FAILURE: ["ansi1", "CI failing"], ERROR: ["ansi1", "CI error"],
  PENDING: ["ansi3", "CI running"], EXPECTED: ["ansi3", "CI waiting"] };

const ago = (iso) => {
  const d = (Date.now() - Date.parse(iso)) / 1000;
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < 86400 ? `${Math.round(d / 3600)}h` : d < 86400 * 60 ? `${Math.round(d / 86400)}d` : `${Math.round(d / 86400 / 30)}mo`;
};
const stale = (pr) => Date.now() - Date.parse(pr.updatedAt) > STALE_DAYS * 86400_000;

export default class PrInbox extends View {
  init(_props, cx) {
    this.data = null;     // { review, mine } once loaded
    this.error = null;
    this.loading = false;
    this.at = 0;
    this.tab = "review";
    this.expanded = new Set(); // "review:bots", "mine:old", ...
    this.shown = false;
    if (checking()) return;
    // Let the tab bar keep this panel per space like Files and Changes.
    const panels = shared("workspace.panels") ?? ["files", "changes"];
    if (!panels.includes("prs")) setShared("workspace.panels", [...panels, "prs"]);
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null");
      if (c?.data) { this.data = c.data; this.at = c.at; }
    } catch {}
    this.maybeRefresh(cx);
    cx.timer.every(30_000, (cx) => this.maybeRefresh(cx));
  }

  // Is it on screen (a dialog, or the layout's panel shown on this child)?
  visible() {
    if (props()?.overlay) return true;
    const find = (n, id) => !n || typeof n !== "object" ? null : n.id === id ? n : (n.children ?? []).reduce((f, c) => f ?? find(c, id), null);
    const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
    return Boolean(panel && !panel.hidden && body?.active === "prs");
  }

  maybeRefresh(cx) {
    // Window minimized, hidden or covered: ask GitHub again once it's back (render).
    if (window()?.visible === false) { this.paused = true; return; }
    this.paused = false;
    const age = Date.now() - this.at;
    if (age > (this.visible() ? SHOWN_MS : HIDDEN_MS)) this.refresh(cx);
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("gh", ["api", "graphql", "-f", `query=${QUERY}`], { timeout: 60_000 });
        if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || "gh api failed (is gh signed in?)");
        const d = JSON.parse(r.stdout).data;
        const clean = (nodes) => nodes.filter((n) => n?.number).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
        this.data = { review: clean(d.review.nodes), mine: clean(d.mine.nodes) };
        this.error = null;
        this.at = Date.now();
        try { localStorage.setItem(CACHE_KEY, JSON.stringify({ at: this.at, data: this.data })); } catch {}
        // Only on change: every setShared re-renders every mod.
        const waiting = this.data.review.filter((p) => !isBot(p.author?.login) && !stale(p)).length;
        if (shared("prinbox.review") !== waiting) setShared("prinbox.review", waiting);
      } catch (e) {
        this.error = String(e?.message ?? e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  // Your space for this PR's branch (a worktree you made for it), if any.
  spaceFor(pr) {
    return spaces().find((s) => !s.machine && s.branch === pr.headRefName) ?? null;
  }

  open(pr) {
    const s = this.spaceFor(pr);
    if (s) run("space.select", { id: s.id });
    else exec("open", [pr.url]).catch(() => {});
  }

  row(pr, t, mine) {
    const ci = CI[pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state];
    const space = this.spaceFor(pr);
    const states = [];
    if (pr.isDraft) states.push(["draft", t.dim]);
    if (pr.reviewDecision === "APPROVED") states.push(["approved", t.ansi2]);
    if (pr.reviewDecision === "CHANGES_REQUESTED") states.push(["changes requested", t.ansi1]);
    if (pr.mergeable === "CONFLICTING") states.push(["conflicts", t.ansi1]);
    const ready = mine && !pr.isDraft && pr.reviewDecision === "APPROVED" && pr.mergeable === "MERGEABLE" && ci?.[0] === "ansi2";
    if (ready) states.unshift(["ready to merge", t.ansi2]);
    const [owner, repo] = pr.repository.nameWithOwner.split("/");
    return v_flex().id(`pr-${pr.repository.nameWithOwner}-${pr.number}`).flex_none().px(10).py(7).gap(3).rounded(7).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.open(pr))
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(pr.title))
        .when(Boolean(ci), (el) => el.child(div().size(7).rounded(4).flex_none().bg(t[ci[0]])))
        .child(div().id(`pr-gh-${owner}-${repo}-${pr.number}`).flex_none().px(4).rounded(4).text_size(11).text_color(t.dim)
          .hover((s) => s.bg(t.raised).text_color(t.foreground)).tooltip("Open on GitHub")
          .on_click((_e, cx) => { cx.stop_propagation(); exec("open", [pr.url]).catch(() => {}); }).child("↗")))
      .child(h_flex().gap(6).items_center().text_size(11.5).text_color(t.dim)
        .child(div().flex_none().child(`${repo}#${pr.number}`))
        .when(!mine, (el) => el.child(div().flex_none().truncate().max_w(110).child(pr.author?.login ?? "")))
        .children(states.map(([w, c]) => div().flex_none().text_color(c).child(w)))
        .when(Boolean(space), (el) => el.child(div().flex_none().text_color(t.accent).child("space")))
        .child(div().flex_1())
        .child(div().flex_none().child(ago(pr.updatedAt))))
      .tooltip(`${pr.repository.nameWithOwner}#${pr.number} · ${pr.headRefName}${ci ? ` · ${ci[1]}` : ""}${space ? " · click: go to its space" : " · click: open on GitHub"}`);
  }

  // Rows, with bots and stale PRs each folded behind a row of their own.
  section(list, t, mine) {
    const main = [], bots = [], old = [];
    for (const pr of list) (!mine && isBot(pr.author?.login) ? bots : stale(pr) ? old : main).push(pr);
    const fold = (key, label, items) => {
      if (!items.length) return [];
      const k = `${this.tab}:${key}`, open = this.expanded.has(k);
      return [h_flex().id(`fold-${k}`).flex_none().px(10).py(6).gap(6).rounded(7).cursor_pointer().text_size(11.5).text_color(t.dim)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { open ? this.expanded.delete(k) : this.expanded.add(k); cx.notify(); })
        .child(open ? "▾" : "▸").child(`${label} (${items.length})`), ...(open ? items.map((p) => this.row(p, t, mine)) : [])];
    };
    return [...main.map((p) => this.row(p, t, mine)), ...fold("bots", "Bots", bots), ...fold("old", `No activity for ${STALE_DAYS}+ days`, old)];
  }

  render(cx) {
    if (this.paused && window()?.visible) this.maybeRefresh(cx);
    // Just opened: refresh if what's shown is over a minute old.
    const shown = this.visible();
    if (shown && !this.shown && !checking() && Date.now() - this.at > OPENED_MS) this.refresh(cx);
    this.shown = shown;
    const t = theme();
    const d = this.data;
    const count = (list, mine) => list.filter((p) => !(!mine && isBot(p.author?.login)) && !stale(p)).length;
    const tab = (id, label, n) => h_flex().id(`tab-${id}`).h(26).px(9).gap(5).items_center().rounded(6).cursor_pointer().text_size(12)
      .bg(this.tab === id ? t.selected : t.background).text_color(this.tab === id ? t.foreground : t.muted)
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { this.tab = id; cx.notify(); })
      .child(label).when(n !== null, (el) => el.child(div().text_size(11).text_color(t.dim).child(String(n))));
    const list = d ? (this.tab === "review" ? d.review : d.mine) : [];
    const rows = d ? this.section(list, t, this.tab === "mine") : [];
    return v_flex().id("pr-inbox").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Pull requests"))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child(this.loading ? "refreshing…" : this.at ? `updated ${ago(new Date(this.at).toISOString())} ago` : ""))
        .child(div().id("pr-refresh").px(6).py(1).rounded(5).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Refresh").on_click((_e, cx) => this.refresh(cx)).child("↻")))
      .child(h_flex().flex_none().px(10).py(8).gap(4).border_b(1).border_color(t.border)
        .child(tab("review", "Needs your review", d ? count(d.review, false) : null))
        .child(tab("mine", "Yours", d ? count(d.mine, true) : null)))
      .when(Boolean(this.error), (el) => el.child(div().px(14).py(8).text_size(12).text_color(t.ansi1).child(this.error)))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("pr-list").absolute().inset_0().overflow_y_scroll().p(6).gap(2)
          .children(rows)
          .when(!rows.length, (el) => el.child(div().p(8).text_size(12).text_color(t.dim)
            .child(!d ? (this.loading ? "Loading pull requests…" : "") : this.tab === "review" ? "Nothing waiting on your review" : "No open pull requests"))))
        .child(Scrollbar.vertical("pr-list").absolute().inset_0()));
  }
}
