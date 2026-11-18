// Shared: identical copies in quick-links and issue-worktree (mods can't
// import across folders).
// Linear issue IDs in branch names, and their status from Linear's API.
//
// Status needs a Linear personal API key (Linear: Settings → Account →
// Security & access → Personal API keys; read access is enough), in the macOS
// Keychain as service KEYCHAIN:
//   security add-generic-password -a "$USER" -s herdr-mods-linear -w
// (prompts for it), or in $LINEAR_API_KEY. A shell reads it on each request
// and hands it to curl on stdin, so the key never passes through the mod, a
// file, or a command line. No key: no status, nothing else changes.
import { exec } from "herdr";

export const KEYCHAIN = "herdr-mods-linear";

// A Linear issue ID anywhere in the branch: <TEAM>-<number> between
// separators, any team key. One written in UPPERCASE wins (people type IDs
// that way: `merge/main-into-WEB-204-x`), else the first one.
// Version-like words (`node-18`, `vue-3`, `step-2`) are not team keys.
// `hotfix/web-1138-title`, `sam/api-396-x` -> WEB-1138, API-396.
const NOT_TEAMS = new Set(["v", "ver", "version", "node", "react", "vue", "angular", "next", "nuxt", "vite", "webpack",
  "es", "ts", "js", "py", "python", "java", "php", "ruby", "go", "ios", "android", "macos", "win", "utf", "iso", "rfc",
  "sha", "md5", "http", "tls", "ssl", "pnpm", "npm", "yarn", "step", "phase", "part", "day", "week", "sprint", "round", "try", "attempt"]);

export function linearId(branch) {
  const found = [];
  for (const m of branch.matchAll(/(?<=^|[\/_.-])([A-Za-z][A-Za-z0-9]{0,9})-(\d{1,6})(?=$|[\/_.-])/g)) {
    if (!NOT_TEAMS.has(m[1].toLowerCase())) found.push({ team: m[1], n: m[2] });
  }
  const pick = found.find((f) => f.team === f.team.toUpperCase() && /[A-Z]/.test(f.team)) ?? found[0];
  return pick ? `${pick.team.toUpperCase()}-${pick.n}` : null;
}

// sh -c REQUEST sh <GraphQL body>. Exit 3: no key.
const REQUEST = `k="\${LINEAR_API_KEY:-$(security find-generic-password -s ${KEYCHAIN} -w 2>/dev/null)}"
[ -n "$k" ] || exit 3
printf 'Authorization: %s\\n' "$k" | curl -sS --max-time 15 -H @- -H 'Content-Type: application/json' --data-binary "$1" https://api.linear.app/graphql`;

// Thrown when there's no key, or Linear refuses it.
export class NoLinearKey extends Error {}

async function graphql(query) {
  const r = await exec("sh", ["-c", REQUEST, "sh", JSON.stringify({ query })], { timeout: 20_000 });
  if (r.code === 3) throw new NoLinearKey("No Linear API key");
  if (r.code !== 0) throw new Error(r.stderr.trim() || "Linear request failed");
  const body = JSON.parse(r.stdout);
  if (body.errors?.some((e) => e.extensions?.code === "AUTHENTICATION_ERROR")) throw new NoLinearKey("Linear refused the API key");
  if (!body.data && body.errors?.length) throw new Error(body.errors[0].message);
  return body.data;
}

const FIELDS = "identifier title url state { name type color }";
const pack = (n) => ({ id: n.identifier, title: n.title, url: n.url, state: n.state.name, type: n.state.type,
  color: /^#[0-9a-f]{6}$/i.test(n.state.color ?? "") ? n.state.color : null });

// IDs -> { [asked ID]: { id (current; differs once moved to another team),
// title, url, state, type, color } | null (not found) }. One request for all
// by team key + number; IDs not found that way (an issue moved to another
// team keeps answering to its old ID) are asked for one by one.
export async function issueStatus(ids) {
  const want = [...new Set(ids)].map((id) => { const [team, n] = id.split("-"); return { id, team, n: Number(n) }; });
  const out = {};
  if (!want.length) return out;
  const or = want.map((w) => `{ team: { key: { eq: ${JSON.stringify(w.team)} } }, number: { eq: ${w.n} } }`).join(", ");
  const data = await graphql(`query { issues(first: ${want.length}, filter: { or: [${or}] }) { nodes { ${FIELDS} } } }`);
  for (const n of data.issues?.nodes ?? []) out[n.identifier] = pack(n);
  await Promise.all(want.filter((w) => !(w.id in out)).map(async (w) => {
    try {
      const d = await graphql(`query { issue(id: ${JSON.stringify(w.id)}) { ${FIELDS} } }`);
      out[w.id] = d.issue ? pack(d.issue) : null;
    } catch (e) {
      if (e instanceof NoLinearKey) throw e;
      out[w.id] = null;
    }
  }));
  return out;
}

// Theme color for a status without a usable Linear color, by its type.
export const STATUS_COLOR = { triage: "ansi1", backlog: "dim", unstarted: "muted", started: "ansi3", completed: "ansi5", canceled: "dim" };
