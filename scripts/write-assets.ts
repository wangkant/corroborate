// Writes files Cloudflare serves as static assets, which never invoke the worker or count as requests.
// skill.md stays dynamic: it names the instance's own URL, which differs in local dev and in forks.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { CSS, FAVICON, KATEX_VERSION, MATH_JS } from "../src/style.ts";

const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const varOf = (name: string) => config.match(new RegExp(`"${name}":\\s*"([^"]*)"`))?.[1] ?? "";
const base = varOf("BASE_PATH").replace(/^\/|\/$/g, "");
const prefix = base ? `/${base}` : "";
const root = new URL("../public/", import.meta.url);
const dir = new URL(base ? `${base}/` : "", root);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL("style.css", dir), CSS);
writeFileSync(new URL("favicon.svg", dir), FAVICON);
writeFileSync(new URL("math.js", dir), MATH_JS);
rmSync(new URL("skill.md", dir), { force: true });

// KaTeX's CSS lists woff2 first, which every current browser reads, so the older font formats stay out.
const katex = new URL("../node_modules/katex/", import.meta.url);
// The folder is cached for a year, so its name must match the files inside.
const installed = JSON.parse(readFileSync(new URL("package.json", katex), "utf8")).version;
if (installed !== KATEX_VERSION) throw new Error(`katex ${installed} is installed but KATEX_VERSION says ${KATEX_VERSION}`);
rmSync(new URL("katex/", dir), { recursive: true, force: true });
const out = new URL(`katex/${KATEX_VERSION}/`, dir);
mkdirSync(new URL("fonts/", out), { recursive: true });
for (const f of ["katex.min.js", "katex.min.css"]) copyFileSync(new URL(`dist/${f}`, katex), new URL(f, out));
copyFileSync(new URL("LICENSE", katex), new URL("LICENSE", out));
for (const f of readdirSync(new URL("dist/fonts/", katex)).filter((f) => f.endsWith(".woff2"))) copyFileSync(new URL(`dist/fonts/${f}`, katex), new URL(`fonts/${f}`, out));

// These URLs carry a content hash or version, so browsers may keep them for a year.
const forever = "  Cache-Control: public, max-age=31536000, immutable\n";
writeFileSync(new URL("_headers", root), `${prefix}/style.css\n${forever}${prefix}/math.js\n${forever}${prefix}/katex/*\n${forever}`);
