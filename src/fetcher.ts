import { clean } from "./sanitize";

export const MAX_BYTES = 3_000_000;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const TEXT_TYPES = ["text/html", "application/xhtml+xml", "text/plain"];
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home", ".corp", ".intranet", ".arpa"];

export class FetchError extends Error {}

export function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchError("not a valid URL");
  }
  if (url.protocol !== "https:") throw new FetchError("only https:// sources are accepted");
  if (url.username || url.password) throw new FetchError("URLs with credentials are not accepted");
  if (url.port && url.port !== "443") throw new FetchError("non-standard ports are not accepted");
  const host = url.hostname.toLowerCase();
  if (!host.includes(".")) throw new FetchError("single-label hosts are not accepted");
  if (/^[\d.]+$/.test(host) || host.startsWith("[") || host.includes(":")) throw new FetchError("IP-address hosts are not accepted");
  if (host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) throw new FetchError("private hosts are not accepted");
  url.hash = "";
  return url;
}

// Wikipedia's article-only rendering is a fraction of the full page, which keeps extraction cheap.
function fetchTarget(url: URL): string {
  const wiki = url.hostname.match(/^([a-z-]+)\.(?:m\.)?wikipedia\.org$/);
  if (wiki && url.pathname.startsWith("/wiki/") && !url.search) {
    return `https://${wiki[1]}.wikipedia.org/w/index.php?title=${url.pathname.slice(6)}&action=render`;
  }
  return url.toString();
}

export function canonicalUrl(url: URL): string {
  const wiki = url.hostname.match(/^([a-z-]+)\.m\.wikipedia\.org$/);
  if (wiki) url.hostname = `${wiki[1]}.wikipedia.org`;
  return url.toString();
}

export interface Page {
  finalUrl: string;
  title: string;
  text: string;
}

export async function fetchPage(raw: string, userAgent: string, timeoutMs = TIMEOUT_MS, devRelay?: string): Promise<Page> {
  let url = checkUrl(raw);
  for (let hop = 0; ; hop++) {
    const direct = fetchTarget(url);
    const target = devRelay ? devRelay + encodeURIComponent(direct) : direct;
    const res = await fetch(target, {
      redirect: "manual",
      headers: { "user-agent": userAgent, accept: "text/html,application/xhtml+xml,text/plain;q=0.8" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc || hop >= MAX_REDIRECTS) throw new FetchError("too many redirects");
      url = checkUrl(new URL(loc, url).toString());
      continue;
    }
    if (!res.ok) throw new FetchError(`source returned HTTP ${res.status}`);
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!TEXT_TYPES.includes(type)) throw new FetchError(`unsupported content type ${type || "unknown"}; cite an HTML page (for papers, the arXiv or PMC HTML version)`);
    const length = Number(res.headers.get("content-length") ?? "0");
    if (length > MAX_BYTES) throw new FetchError(`source page is larger than ${MAX_BYTES / 1_000_000} MB`);
    const body = await readCapped(res);
    const page = type === "text/plain" ? { title: "", text: clean(body) } : await htmlToText(body);
    // D1 rows top out at 2 MB, and snapshots are stored whole.
    if (page.text.length > 1_200_000) throw new FetchError("page text is too long to snapshot; cite a shorter page or section");
    const title = page.title || (direct !== url.toString() ? decodeURIComponent(url.pathname.slice(6)).replace(/_/g, " ") : "");
    return { finalUrl: canonicalUrl(url), title: clean(title).slice(0, 300), text: page.text };
  }
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new FetchError(`source page is larger than ${MAX_BYTES / 1_000_000} MB`);
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder("utf-8").decode(buf);
}

// Citation markers and edit links are page furniture that agents never copy into quotes.
const SKIP =
  "script,style,noscript,template,svg,iframe,object,head,button,select,nav,footer,aside,[role=navigation],[role=contentinfo],[role=banner],[aria-hidden=true]," +
  "sup.reference,span.mw-editsection,.mw-cite-backlink,.noprint,.navbox,.reflist,ol.references,.metadata,.mw-empty-elt";
const BLOCK_TAG = /<\/?(?:p|div|br|li|ul|ol|h[1-6]|tr|td|th|section|article|header|blockquote|pre|figcaption|dd|dt|table|main|caption)\b[^>]*>/gi;

// The native rewriter only deletes skipped subtrees; tags are then stripped with regexes. Per-text-node
// JS callbacks cost ~300 ms of CPU on a large Wikipedia page, which the Workers free plan cannot afford.
export async function htmlToText(html: string): Promise<{ title: string; text: string }> {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  const pruned = await new HTMLRewriter()
    .on(SKIP, {
      element(el) {
        el.remove();
      },
    })
    .transform(new Response(html, { headers: { "content-type": "text/html" } }))
    .text();
  const stripped = pruned
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(BLOCK_TAG, "\n")
    .replace(/<[^>]*>/g, "");
  const text = decodeEntities(stripped)
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n[\n ]*/g, "\n")
    .trim();
  return { title: decodeEntities(title), text: clean(text) };
}

export function paragraphs(text: string): string[] {
  return text.split("\n").map((p) => p.trim()).filter((p) => p.length > 0);
}

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", middot: "·", deg: "°",
  times: "×", minus: "−", plusmn: "±", copy: "©", reg: "®", trade: "™", shy: "", thinsp: " ", ensp: " ", emsp: " ",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED[body.toLowerCase()] ?? m;
  });
}

const FOLD: Record<string, string> = {
  "‘": "'", "’": "'", "‚": "'", "′": "'", "“": '"', "”": '"', "„": '"', "″": '"',
  "–": "-", "—": "-", "−": "-", "‐": "-", "‑": "-", "…": "...",
};

// Builds a normalized string plus, for each normalized char, its index in the source.
function fold(src: string, alnumOnly: boolean): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  let lastSpace = true;
  for (let i = 0; i < src.length; ) {
    const cp = src.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const width = ch.length;
    let out = FOLD[ch] ?? ch.normalize("NFKC").toLowerCase();
    if (alnumOnly) out = out.replace(/[^\p{L}\p{N}]/gu, " ");
    for (const o of out) {
      if (/\s/.test(o)) {
        if (lastSpace) continue;
        norm += " ";
        lastSpace = true;
      } else {
        norm += o;
        lastSpace = false;
      }
      map.push(i);
    }
    i += width;
  }
  return { norm, map };
}

export interface QuoteMatch {
  method: "exact" | "loose";
  start: number;
  end: number;
}

function matchIn(text: string, offset: number, quote: string): QuoteMatch | null {
  for (const alnumOnly of [false, true]) {
    const q = fold(quote, alnumOnly).norm.trim();
    if (q.length < 10) continue;
    const page = fold(text, alnumOnly);
    const at = page.norm.indexOf(q);
    if (at >= 0) {
      const start = page.map[at]!;
      const end = (page.map[at + q.length - 1] ?? start) + 1;
      return { method: alnumOnly ? "loose" : "exact", start: start + offset, end: end + offset };
    }
  }
  return null;
}

const MARKERS = /\[(?:\d{1,3}|[a-z]|citation needed|note \d+|clarification needed)\]/gi;

// Folding a whole page costs too much CPU, so only windows around an anchor word get folded.
export function findQuote(pageText: string, rawQuote: string): QuoteMatch | null {
  const quote = rawQuote.replace(MARKERS, "");
  const words = fold(quote, true).norm.split(" ").filter((w) => w.length >= 4);
  const anchor = words.sort((a, b) => b.length - a.length)[0];
  if (anchor) {
    const lower = pageText.toLowerCase();
    const pad = quote.length * 2 + 64;
    for (let pos = lower.indexOf(anchor), hits = 0; pos >= 0 && hits < 60; pos = lower.indexOf(anchor, pos + 1), hits++) {
      const from = Math.max(0, pos - pad);
      const m = matchIn(pageText.slice(from, pos + pad), from, quote);
      if (m) return m;
    }
  }
  return pageText.length <= 300_000 ? matchIn(pageText, 0, quote) : null;
}

export function contextWindow(text: string, m: QuoteMatch, radius = 300): string {
  const from = Math.max(0, m.start - radius);
  const to = Math.min(text.length, m.end + radius);
  return (from > 0 ? "…" : "") + text.slice(from, to).replace(/\s+/g, " ").trim() + (to < text.length ? "…" : "");
}

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
