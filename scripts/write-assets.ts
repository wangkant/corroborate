// Writes the stylesheet and icon where Cloudflare serves them as static assets, which never invoke the worker.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CSS, FAVICON } from "../src/style.ts";

const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const base = (config.match(/"BASE_PATH":\s*"([^"]*)"/)?.[1] ?? "").replace(/^\/|\/$/g, "");
const dir = new URL(`../public/${base ? base + "/" : ""}`, import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL("style.css", dir), CSS);
writeFileSync(new URL("favicon.svg", dir), FAVICON);
