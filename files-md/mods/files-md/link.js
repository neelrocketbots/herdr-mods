// Ctrl/Cmd-click on a file path in a terminal: open it in the Files panel
// (this mod's block in the layout), at its line when the path has one
// (file.ts:42, #L5). Images, archives, folders, remote and missing files, and
// layouts without this mod go on to the next handler (in the end Herdr's own
// opener). mod.json's link_handlers says which links reach here.
import { exec, run, setShared, layout } from "herdr";

export const OPEN_KEY = "files-md.open";

const BINARY = /\.(png|jpe?g|gif|webp|bmp|ico|icns|tiff?|heic|svgz|pdf|zip|gz|tgz|bz2|xz|zst|7z|rar|dmg|pkg|iso|mp[34]|mov|m4[av]|wav|flac|ogg|webm|avi|mkv|woff2?|ttf|otf|eot|sqlite3?|db|exe|dll|so|dylib|class|jar|wasm|node|o|a)$/i;

// Ancestors of this mod's block, root first, ending with the block; null when absent.
function trail(node, path = []) {
  if (!node || typeof node !== "object") return null;
  const here = [...path, node];
  if (node.content?.mod === "files-md") return here;
  for (const child of node.children ?? []) {
    const found = trail(child, here);
    if (found) return found;
  }
  return null;
}

export async function handleLink({ link }) {
  if (!link.path || BINARY.test(link.path)) return "pass";
  const nodes = trail(layout());
  if (!nodes) return "pass";
  const isFile = await exec("test", ["-f", link.path]).then((r) => r.code === 0, () => false);
  if (!isFile) return "pass";
  setShared(OPEN_KEY, { path: link.path, line: link.line ?? null, at: Date.now() });
  // Uncover the block: pick it in every stack on the way and show hidden nodes.
  nodes.forEach((node, i) => {
    const next = nodes[i + 1];
    if (next && node.type === "stack" && node.active !== next.id) run("layout.select", { stack: node.id, child: next.id });
    if (node.hidden && node.id) run("layout.show", { id: node.id });
  });
  return "handled";
}
