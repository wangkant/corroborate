// Writes files Cloudflare serves as static assets, which never invoke the worker or count as requests.
// skill.md stays dynamic: it names the instance's own URL, which differs in local dev and in forks.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
rmSync(new URL("skill.md", dir), { force: true });
// The stylesheet URL carries a content hash, so browsers may keep it for a year.
writeFileSync(new URL("_headers", root), `${prefix}/style.css\n  Cache-Control: public, max-age=31536000, immutable\n`);
