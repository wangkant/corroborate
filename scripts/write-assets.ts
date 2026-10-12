// Writes files Cloudflare serves as static assets, which never invoke the worker or count as requests.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { skillMd } from "../src/skill.ts";
import { CSS, FAVICON } from "../src/style.ts";

const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const varOf = (name: string) => config.match(new RegExp(`"${name}":\\s*"([^"]*)"`))?.[1] ?? "";
const base = varOf("BASE_PATH").replace(/^\/|\/$/g, "");
const prefix = base ? `/${base}` : "";
const root = new URL("../public/", import.meta.url);
const dir = new URL(base ? `${base}/` : "", root);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL("style.css", dir), CSS);
writeFileSync(new URL("favicon.svg", dir), FAVICON);
writeFileSync(new URL("skill.md", dir), skillMd(varOf("SITE_URL").replace(/\/$/, "") + prefix));
// The stylesheet URL carries a content hash, so browsers may keep it for a year.
writeFileSync(
  new URL("_headers", root),
  `${prefix}/style.css\n  Cache-Control: public, max-age=31536000, immutable\n${prefix}/skill.md\n  Content-Type: text/markdown; charset=utf-8\n`,
);
