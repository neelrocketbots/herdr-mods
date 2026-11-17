// Shared: identical copies in quick-links and issue-worktree (mods can't
// import across folders).
// CI summary from `gh ... --json statusCheckRollup`: the latest run of each
// check (reruns share a name), then failing > running > passing.
// Returns null (no checks) or { state: "failing" | "pending" | "passing", url?, failed? }.
const BAD = new Set(["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "ERROR", "STARTUP_FAILURE"]);

export function ciSummary(rollup) {
  if (!Array.isArray(rollup) || !rollup.length) return null;
  const latest = new Map();
  for (const c of rollup) {
    const name = c.name ?? c.context ?? "";
    const at = Date.parse(c.completedAt || c.startedAt || "") || 0;
    const prev = latest.get(name);
    if (!prev || at >= prev.at) latest.set(name, { ...c, at });
  }
  const checks = [...latest.values()];
  const failed = checks.filter((c) => BAD.has(c.conclusion ?? c.state));
  if (failed.length) {
    // Prefer a GitHub Actions run over third-party links (socket.dev, ...).
    const pick = failed.find((c) => (c.detailsUrl ?? "").includes("/actions/runs/")) ?? failed[0];
    return { state: "failing", url: pick.detailsUrl ?? pick.targetUrl ?? null, failed: failed.map((c) => c.name ?? c.context) };
  }
  const pending = checks.some((c) => c.__typename === "CheckRun" ? c.status !== "COMPLETED" : ["PENDING", "EXPECTED"].includes(c.state));
  return { state: pending ? "pending" : "passing" };
}

export const CI_COLOR = { failing: "ansi1", pending: "ansi3", passing: "ansi2" };
export const CI_WORD = { failing: "CI failing", pending: "CI running", passing: "CI passing" };
