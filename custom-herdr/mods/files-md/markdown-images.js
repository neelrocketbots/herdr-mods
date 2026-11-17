// Images for the markdown preview. Herdr's TextView.markdown draws no images
// (not local, file://, remote or <img>), and image() only loads files under the
// app folder. So lines made only of images are lifted out of the markdown, each
// image is copied (or downloaded) into data/files-md/img in the app folder, and
// the preview draws it with image() between the text sections.
import { exec, appHome, readTextFile } from "herdr";

const CACHE = "data/files-md/img";

// ![alt](src "title"), optionally wrapped in a link: [![alt](src)](href).
const MD_IMG = /\[?!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)(?:\]\(\s*<?([^)\s>]+)>?\s*\))?/g;
const HTML_IMG = /<img\b[^>]*>/gi;
const WRAPPERS = /<\/?(p|a|div|picture|source|br|center)\b[^>]*>/gi;

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? m[1] ?? m[2] ?? m[3] : null;
}

// Markdown -> [{ md: text } | { images: [{ alt, src, href, width }] }].
// A line holding only images (plus <p>/<a>/... wrappers) becomes an image row;
// consecutive image lines share a row. Images inside text become their alt
// text in italics. Code blocks are left alone.
export function splitImages(markdown) {
  const parts = [];
  let md = [], fence = null, row = null;
  const flush = () => {
    if (md.some((l) => l.trim())) parts.push({ md: md.join("\n") });
    if (md.length) row = null;
    md = [];
  };
  for (const line of markdown.split("\n")) {
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f || fence) {
      if (f) fence = fence === null ? f[1][0] : f[1][0] === fence ? null : fence;
      md.push(line);
      continue;
    }
    const images = [];
    const rest = line
      .replace(MD_IMG, (_, alt, src, href) => { images.push({ alt, src, href: href ?? null, width: null }); return ""; })
      .replace(HTML_IMG, (tag) => {
        const src = attr(tag, "src");
        if (src) images.push({ alt: attr(tag, "alt") ?? "", src, href: null, width: attr(tag, "width") });
        return "";
      })
      .replace(WRAPPERS, "")
      .trim();
    if (images.length && !rest) {
      flush();
      if (!row) { row = { images: [] }; parts.push(row); }
      row.images.push(...images);
      continue;
    }
    if (!rest && WRAPPERS.test(line)) continue; // a lone <p> or </p> around image lines
    WRAPPERS.lastIndex = 0;
    md.push(images.length
      ? line.replace(MD_IMG, (_, alt) => (alt ? `*${alt}*` : "")).replace(HTML_IMG, (tag) => (attr(tag, "alt") ? `*${attr(tag, "alt")}*` : ""))
      : line);
  }
  flush();
  return parts;
}

function fnv(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, "0");
}
const extOf = (p) => (p.split(/[?#]/)[0].match(/\.(png|jpe?g|gif|webp|svg|bmp|tiff?)$/i)?.[1] ?? "").toLowerCase();

function normalize(path) {
  const out = [];
  for (const seg of path.split("/")) {
    if (seg === "..") out.pop();
    else if (seg && seg !== ".") out.push(seg);
  }
  return "/" + out.join("/");
}

// Downloads are kept for the app's life; local files are copied each time a
// file is shown, so an edited image shows its new version.
const downloads = new Map(); // url -> Promise<info | null>

// { path (app-relative, for image()), w, h, open (what a click opens) } | null.
export function loadImage(src, fileDir) {
  if (/^https?:\/\//i.test(src)) {
    if (!downloads.has(src)) downloads.set(src, fetchImage({ url: src }).catch(() => null));
    return downloads.get(src);
  }
  if (/^[a-z]+:/i.test(src) && !/^file:/i.test(src)) return Promise.resolve(null); // data:, mailto:, ...
  let p = src.split(/[?#]/)[0];
  try { p = decodeURI(p); } catch {}
  if (p.startsWith("file://")) p = p.slice(7);
  return fetchImage({ path: p.startsWith("/") ? normalize(p) : normalize(`${fileDir}/${p}`) }).catch(() => null);
}

async function fetchImage(source) {
  const dir = `${appHome()}/${CACHE}`;
  const name = fnv(source.url ?? source.path);
  let ext = extOf(source.url ?? source.path);
  if (source.url) {
    const tmp = `${dir}/${name}.download`;
    const r = await exec("sh", ["-c", 'mkdir -p "$1" && curl -sfL --max-time 15 -o "$2" -w "%{content_type}" "$3"', "sh", dir, tmp, source.url], { timeout: 20_000 });
    if (r.code !== 0) return null;
    const type = r.stdout;
    if (!ext) ext = /svg/i.test(type) ? "svg" : /jpe?g/i.test(type) ? "jpg" : /gif/i.test(type) ? "gif" : /webp/i.test(type) ? "webp" : "png";
    if ((await exec("mv", ["-f", tmp, `${dir}/${name}.${ext}`])).code !== 0) return null;
  } else {
    if (!ext) return null;
    const r = await exec("sh", ["-c", 'mkdir -p "$1" && cp -f "$2" "$3"', "sh", dir, source.path, `${dir}/${name}.${ext}`]);
    if (r.code !== 0) return null;
  }
  const size = await sizeOf(`${dir}/${name}.${ext}`, ext);
  return { path: `${CACHE}/${name}.${ext}`, w: size?.w ?? 0, h: size?.h ?? 0, open: source.url ?? source.path };
}

async function sizeOf(file, ext) {
  if (ext === "svg") {
    const text = await readTextFile(file).catch(() => null);
    const tag = text?.match(/<svg\b[^>]*>/i)?.[0] ?? "";
    const num = (v) => (v && !v.includes("%") ? parseFloat(v) : NaN);
    let w = num(attr(tag, "width")), h = num(attr(tag, "height"));
    if (!(w > 0 && h > 0)) {
      const vb = attr(tag, "viewBox")?.trim().split(/[\s,]+/).map(Number);
      if (vb?.length === 4) { w = vb[2]; h = vb[3]; }
    }
    return w > 0 && h > 0 ? { w, h } : null;
  }
  const r = await exec("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file]);
  const w = Number(r.stdout.match(/pixelWidth:\s*(\d+)/)?.[1]), h = Number(r.stdout.match(/pixelHeight:\s*(\d+)/)?.[1]);
  return w > 0 && h > 0 ? { w, h } : null;
}
