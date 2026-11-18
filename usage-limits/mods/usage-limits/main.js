// Usage limits: a row per account, Claude (one per Claude Code config folder)
// and Codex: its name, then every limit as a small gauge, like a status line:
// `5h ━── 8% 4h   7d ━── 5% 6d   fbl ── 0%` (green, yellow from 50%, red from
// 80%; a model's weekly limit drops its reset when it matches 7d's). The
// tooltip has the full names and reset times. The layout block holding this mod (props.block, default "usage")
// resizes to fit. Standalone: it needs nothing from your status line.
//
//   Claude  every ~/.claude* folder that has a Claude Code login in the macOS
//           Keychain ("Claude Code-credentials", plus "-<sha256(folder)[:8]>"
//           for folders other than ~/.claude, as Claude Code names them). A
//           shell reads that login's access token and pipes it to curl, which
//           asks Anthropic's usage endpoint (/api/oauth/usage, undocumented),
//           so the token never reaches the mod, a file or a command line. Asked
//           every CLAUDE_MS; an expired token (Claude Code renews it while it
//           runs) or an error keeps the last answer.
//   Codex   the last `rate_limits` (primary / secondary windows) in its newest
//           session file under ~/.codex/sessions that has one.
// An account without data has no row. A limit past its reset time shows 0%.
// Last answers are kept in localStorage, so rows show at once after a restart.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, home, theme, run, props, checking, knownAgents } from "herdr";

const CODEX_DIR = ".codex/sessions"; // under home
const CODEX_MS = 30_000;
const CLAUDE_MS = 5 * 60_000;
const BACKOFF_MS = 15 * 60_000;      // after Anthropic says 429
const CACHE_KEY = "usage-limits.v2"; // localStorage: last answers

const pctColor = (p) => (p >= 80 ? "ansi1" : p >= 50 ? "ansi3" : "ansi2");

// Compact countdown, as status lines show it: 47m / 3h / 5d.
function short(ms) {
  const s = (ms - Date.now()) / 1000;
  if (s <= 0) return "now";
  if (s < 5400) return `${Math.ceil(s / 60)}m`;
  if (s < 172800) return `${Math.ceil(s / 3600)}h`;
  return `${Math.ceil(s / 86400)}d`;
}

// "47m", "2h 14m", "3d 4h"; "now" once passed.
function until(ms) {
  const m = Math.round((ms - Date.now()) / 60_000);
  if (m <= 0) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const windowLabel = (min) => (min === 300 ? "5-hour" : min === 10080 ? "7-day" : min % 1440 === 0 ? `${min / 1440}-day` : `${Math.round(min / 60)}-hour`);
const windowShort = (min) => (min % 1440 === 0 ? `${min / 1440}d` : `${Math.round(min / 60)}h`);
// "Fable" -> "fbl", "Opus" -> "ops": first letter, then consonants, 3 letters.
const abbrev = (name) => { const w = name.toLowerCase().replace(/[^a-z]/g, ""); return (w[0] + w.slice(1).replace(/[aeiou]/g, "")).slice(0, 3) || "?"; };

// Claude Code config folders: ~/.claude and ~/.claude<anything> folders.
const CLAUDE_DIRS = `for d in "$HOME"/.claude "$HOME"/.claude?*; do [ -d "$d" ] && printf '%s\\n' "$d"; done`;

// sh -c CLAUDE_USAGE sh <config folder>. Prints the usage JSON, then the HTTP
// status on its own last line. Exit 3: no login there; 4: its token expired.
const CLAUDE_USAGE = `svc="Claude Code-credentials"
[ "$1" = "$HOME/.claude" ] || svc="$svc-$(printf %s "$1" | shasum -a 256 | cut -c1-8)"
c=$(security find-generic-password -s "$svc" -w 2>/dev/null) || exit 3
t=$(printf %s "$c" | plutil -extract claudeAiOauth.accessToken raw -o - - 2>/dev/null) || exit 3
e=$(printf %s "$c" | plutil -extract claudeAiOauth.expiresAt raw -o - - 2>/dev/null)
[ -n "$e" ] && [ $(( e / 1000 )) -lt "$(date +%s)" ] && exit 4
printf 'Authorization: Bearer %s\\n' "$t" | curl -sS --max-time 10 -H @- -H 'anthropic-beta: oauth-2025-04-20' -w '\\n%{http_code}' https://api.anthropic.com/api/oauth/usage`;

// Claude: limits [{ kind, percent, resets_at, scope }] -> limits.
function claudeLimits(json) {
  const label = (l) => l.kind === "session" ? "5-hour"
    : l.kind === "weekly_all" ? "7-day"
    : l.kind === "weekly_scoped" ? `7-day ${l.scope?.model?.display_name ?? l.scope?.surface ?? "scoped"}`
    : l.kind.replace(/_/g, " ");
  const shortOf = (l) => l.kind === "session" ? "5h" : l.kind === "weekly_all" ? "7d"
    : abbrev(l.scope?.model?.display_name ?? l.scope?.surface ?? l.kind);
  const limits = (json.limits ?? []).filter((l) => typeof l.percent === "number")
    .map((l) => ({ label: label(l), short: shortOf(l), pct: l.percent, resets: Date.parse(l.resets_at) || 0, scoped: l.kind === "weekly_scoped" }));
  // A model's weekly limit resets with 7d: drop its countdown, as the status line does.
  const week = limits.find((l) => l.short === "7d");
  for (const l of limits) if (l.scoped && week && Math.abs(l.resets - week.resets) < 3600_000) l.sameReset = true;
  return limits;
}

// ".claude" -> "Claude", ".claude2" -> "Claude 2", ".claude-work" -> "Claude work".
const claudeName = (dir) => `Claude ${dir.split("/").pop().replace(/^\.claude[-_.]?/, "")}`.trim();

// Codex: { primary, secondary: { used_percent, window_minutes, resets_at (s) } } -> limits.
function codexLimits(rl) {
  return ["primary", "secondary"].map((k) => rl[k]).filter((w) => w && typeof w.used_percent === "number")
    .map((w) => ({ label: windowLabel(w.window_minutes), short: windowShort(w.window_minutes), pct: w.used_percent, resets: (w.resets_at ?? 0) * 1000 }));
}

// Newest Codex session files (last 8 days) first; the last line with rate_limits
// in the first one that has any. Prints "<mtime>\t<line>".
const CODEX_SCRIPT = `cd "$1" 2>/dev/null || exit 0
find . -name '*.jsonl' -mtime -8 -print0 2>/dev/null | xargs -0 ls -t 2>/dev/null | head -5 | while read -r f; do
  l=$(grep '"rate_limits":{' "$f" | tail -1)
  if [ -n "$l" ]; then printf '%s\\t%s\\n' "$(stat -f %m "$f")" "$l"; exit 0; fi
done`;

function findRateLimits(o) {
  if (!o || typeof o !== "object") return null;
  if (o.rate_limits && typeof o.rate_limits === "object") return o.rate_limits;
  for (const v of Object.values(o)) { const r = findRateLimits(v); if (r) return r; }
  return null;
}

export default class UsageLimits extends View {
  init(_props, cx) {
    this.rows = {};     // key -> { key, name, tip, icon, limits: [{ label, pct, resets }], at }
    this.codexSeen = 0; // newest Codex session file read (mtime)
    this.waitUntil = {}; // Claude folder -> no request before this time (429)
    this.icons = {};    // "claude" / "codex" -> program (icon, tint, color)
    this.px = 0;
    try { this.rows = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}") ?? {}; } catch {}
    if (checking()) return;
    cx.spawn(async (cx) => {
      for (const p of await knownAgents().catch(() => [])) if (p.key === "claude" || p.key === "codex") this.icons[p.key] = p;
      cx.notify();
    });
    this.pollClaude(cx);
    this.pollCodex(cx);
    cx.timer.every(CLAUDE_MS, (cx) => this.pollClaude(cx));
    cx.timer.every(CODEX_MS, (cx) => this.pollCodex(cx));
    cx.timer.every(60_000, (cx) => cx.notify()); // countdowns
  }

  set(row, cx) {
    if (JSON.stringify(this.rows[row.key]) === JSON.stringify(row)) return;
    this.rows[row.key] = row;
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(this.rows)); } catch {}
    cx.notify();
  }

  pollClaude(cx) {
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", CLAUDE_DIRS]).catch(() => null);
      const dirs = (r?.stdout ?? "").split("\n").filter(Boolean);
      await Promise.all(dirs.map(async (dir) => {
        if (Date.now() < (this.waitUntil[dir] ?? 0)) return;
        const u = await exec("sh", ["-c", CLAUDE_USAGE, "sh", dir], { timeout: 20_000 }).catch(() => null);
        if (!u || u.code !== 0) return; // no login there, expired token, or offline: keep the last answer
        const nl = u.stdout.lastIndexOf("\n");
        const status = Number(u.stdout.slice(nl + 1));
        if (status === 429) { this.waitUntil[dir] = Date.now() + BACKOFF_MS; return; }
        if (status !== 200) return;
        try {
          const limits = claudeLimits(JSON.parse(u.stdout.slice(0, nl)));
          if (limits.length) this.set({ key: `claude:${dir}`, name: claudeName(dir), tip: dir.replace(home(), "~"), icon: "claude", limits, at: Date.now() }, cx);
        } catch {}
      }));
    });
  }

  pollCodex(cx) {
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", CODEX_SCRIPT, "sh", `${home()}/${CODEX_DIR}`], { timeout: 10_000 }).catch(() => null);
      const out = r?.stdout.trim();
      if (!out) return;
      const tab = out.indexOf("\t");
      const at = Number(out.slice(0, tab)) * 1000;
      if (at === this.codexSeen) return;
      try {
        const rl = findRateLimits(JSON.parse(out.slice(tab + 1)));
        if (!rl) return;
        this.codexSeen = at;
        this.set({ key: "codex", name: "Codex", tip: "~/.codex", icon: "codex", limits: codexLimits(rl), at }, cx);
      } catch {}
    });
  }

  fit(height) {
    const px = Math.ceil(height);
    if (px <= 0 || px === this.px) return;
    this.px = px;
    run("layout.resize", { id: props()?.block ?? "usage", px });
  }

  render() {
    const t = theme();
    const now = Date.now();
    const live = (l) => (l.resets && l.resets <= now ? { ...l, pct: 0 } : l);
    const ago = (at) => { const m = Math.round((now - at) / 60_000); return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`; };
    const glyph = (key) => {
      const p = this.icons[key];
      if (!p?.icon) return div().size(14).flex_none();
      return p.tint ? svg(p.icon).size(14).flex_none().text_color(p.color ?? t.muted) : image(p.icon).w(14).h(14).flex_none();
    };
    // Claude accounts first (~/.claude, then the others by name), then Codex.
    const rows = Object.values(this.rows).filter((s) => s.limits?.length)
      .sort((a, b) => (a.icon === b.icon ? a.name.localeCompare(b.name) : a.icon === "claude" ? -1 : 1));
    // `5h ━── 8% 4h`: label, a bar sharing the row's width, the %, the countdown.
    const gauge = (l, id) => h_flex().flex_1().min_w(0).gap(4).items_center().text_size(11)
      .child(div().flex_none().text_color(t.dim).child(l.short))
      .child(div().id(id).flex_1().min_w(12).h(3).rounded(2).bg(t.input)
        .child(div().h_full().rounded(2).w(`${Math.max(0, Math.min(100, l.pct))}%`).bg(t[pctColor(l.pct)])))
      .child(div().flex_none().text_color(t[pctColor(l.pct)]).child(`${Math.round(l.pct)}%`))
      .when(Boolean(l.resets) && !l.sameReset, (el) => el.child(div().flex_none().text_color(t.dim).child(short(l.resets))));
    const row = (s) => {
      const limits = s.limits.map(live);
      const id = s.key.replace(/[^A-Za-z0-9]/g, "-");
      const tip = [`${s.name} (${s.tip}), as of ${ago(s.at)}`,
        ...limits.map((l) => `${l.label}: ${Math.round(l.pct)}%${l.resets ? `, resets in ${until(l.resets)}` : ""}`)].join("\n");
      return v_flex().id(`usage-${id}`).flex_none().px(8).py(4).gap(3).rounded(7).hover((st) => st.bg(t.hover)).tooltip(tip)
        .child(h_flex().gap(8).items_center()
          .child(glyph(s.icon))
          .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(s.name)))
        .child(h_flex().w_full().gap(10)
          .children(limits.map((l, i) => gauge(l, `usage-${id}-${i}`))));
    };
    return v_flex().id("usage-limits").w_full().bg(t.chrome).text_color(t.foreground)
      .child(v_flex().id("usage-content").w_full().px(10).pt(6).pb(6).gap(2).border_t(1).border_color(t.border)
        .on_size_change((size) => this.fit(size.height))
        .child(div().px(8).pt(2).pb(4).text_size(11).text_color(t.dim).child("Usage"))
        .when(rows.length === 0, (el) => el.child(div().px(8).pb(4).text_size(11.5).text_color(t.dim)
          .child("No usage yet: sign in to Claude Code or Codex")))
        .children(rows.map(row)));
  }
}
