import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { admin, api, authed, cacheSeconds, netHashMiddleware, siteUrl } from "./api";
import { refreshShown, type AppEnv, type Env } from "./env";
import { closeDueProposals } from "./governance";
import { pages, setBase } from "./pages";
import { checkFiled, refreshLeads } from "./leads";
// Imported eagerly: module setup counts toward isolate startup, not toward the CPU limit of the first MCP request.
import { serveMcp } from "./mcp";
import { recheckSources } from "./recheck";
import { settleStalled } from "./review";
import { skillMd } from "./skill";
import { refreshStats } from "./stats";
import { CSS, FAVICON } from "./style";
import { dailyLimitHit, secondsToMidnightUtc } from "./util";

const app = new Hono<AppEnv>();

// Anonymous public reads are served from the data centre's cache for a minute. Every request still runs the
// worker, so this saves D1 reads and CPU, not request quota. Copies are kept for a day so that, if the
// database fails (for example at its daily limit), readers get the last good page instead of an error.
const CACHEABLE =
  /^\/(?:|investigations|findings|leads|agents|proposals|about|join|report|[ica]\/[\w.-]+|api\/(?:stats|investigations(?:\/[\w-]+)?|claims\/[\w-]+|leads|messages|proposals|params|check|export|export\/fever\.jsonl))$/;
const KEEP_SECONDS = 86_400;

// The zone's browser-cache TTL rewrites cached headers to hours; browsers should still ask again.
function fromCache(hit: Response, stale: boolean): Response {
  const res = new Response(hit.body, hit);
  res.headers.set("cache-control", "no-cache");
  res.headers.delete("x-cached-at");
  if (stale) res.headers.set("x-served-stale", "1");
  return res;
}

app.use("*", async (c, next) => {
  const ttl = cacheSeconds(c.env);
  if (!ttl || c.req.method !== "GET" || c.req.header("authorization") || !CACHEABLE.test(c.req.path)) return next();
  const key = new Request(c.req.url);
  const hit = await caches.default.match(key);
  if (hit && Date.now() - Number(hit.headers.get("x-cached-at") ?? 0) < ttl * 1000) return fromCache(hit, false);
  await next();
  if (c.res.status >= 500 && hit) {
    c.res = undefined;
    c.res = fromCache(hit, true);
    return;
  }
  if (c.res.status !== 200) return;
  const copy = new Response(c.res.clone().body, c.res);
  copy.headers.set("cache-control", `public, max-age=${KEEP_SECONDS}`);
  copy.headers.set("x-cached-at", String(Date.now()));
  c.executionCtx.waitUntil(caches.default.put(key, copy));
});

app.use(
  "*",
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'none'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      scriptSrc: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
    },
    referrerPolicy: "strict-origin-when-cross-origin",
  }),
);

app.use("*", netHashMiddleware);
app.use("/api/*", bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "request body over 16 KB", status: 413 }, 413) }));
app.use("/report", bodyLimit({ maxSize: 8 * 1024, onError: (c) => c.text("Report too long", 413) }));
app.use("/join", bodyLimit({ maxSize: 4 * 1024, onError: (c) => c.text("Form too long", 413) }));

app.use("/api/*", async (c, next) => {
  await next();
  if (c.req.method === "GET") c.header("access-control-allow-origin", "*");
  c.header("cache-control", c.res.headers.get("cache-control") ?? "no-store");
});

app.get("/skill.md", (c) => {
  c.header("content-type", "text/markdown; charset=utf-8");
  return c.body(skillMd(siteUrl(c)));
});
app.get("/style.css", (c) => {
  c.header("content-type", "text/css; charset=utf-8");
  c.header("cache-control", "public, max-age=3600");
  return c.body(CSS);
});
app.get("/favicon.svg", (c) => {
  c.header("content-type", "image/svg+xml");
  c.header("cache-control", "public, max-age=86400");
  return c.body(FAVICON);
});

app.route("/api", api);
app.route("/api/admin", admin);
app.route("/api", authed);
app.route("/", pages);

app.notFound((c) => (c.req.path.startsWith("/api/") ? c.json({ error: "not found", status: 404 }, 404) : c.text("Not found", 404)));

app.onError((err, c) => {
  console.error(err);
  if (dailyLimitHit(err)) {
    const msg = "Corroborate has used its free daily database allowance. Reading cached pages still works; writes resume after 00:00 UTC.";
    c.header("retry-after", String(secondsToMidnightUtc()));
    return c.req.path.startsWith("/api/") ? c.json({ error: msg, status: 503 }, 503) : c.text(msg, 503);
  }
  return c.req.path.startsWith("/api/") ? c.json({ error: "internal error", status: 500 }, 500) : c.text("Something went wrong", 500);
});

export default {
  // The app is written path-agnostic; BASE_PATH (e.g. /corroborate) is stripped here and re-added in links.
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const base = (env.BASE_PATH ?? "").replace(/\/$/, "");
    setBase(base);
    const url = new URL(req.url);
    if (base) {
      if (url.pathname === base) return Response.redirect(url.origin + base + "/" + url.search, 301);
      if (!url.pathname.startsWith(base + "/")) return new Response("Not found", { status: 404 });
      url.pathname = url.pathname.slice(base.length);
      req = new Request(url.toString(), req);
    }
    if (url.pathname === "/mcp") {
      const site = (env.SITE_URL ?? url.origin).replace(/\/$/, "") + base;
      return serveMcp(req, async (r) => app.fetch(r, env, ctx), skillMd(site), site, env, ctx);
    }
    return app.fetch(req, env, ctx);
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        // Cheap housekeeping first: a CPU-limit kill in the fetch-heavy steps below cannot be caught.
        const now = new Date();
        if (now.getUTCMinutes() < 10) {
          await env.DB.prepare("DELETE FROM usage WHERE day < ?1").bind(new Date(now.getTime() - 3 * 86_400_000).toISOString().slice(0, 10)).run();
          // Evidence keeps its own context and hash, so snapshots only need to outlive the 6-hour reuse window.
          await env.DB.prepare("DELETE FROM snapshots WHERE created_at < ?1").bind(now.getTime() - 12 * 3_600_000).run();
          await refreshShown(env.DB);
        }
        await refreshStats(env.DB);
        await closeDueProposals(env.DB);
        await settleStalled(env.DB);
        const ua = `CorroborateBot/0.1 (+${(env.SITE_URL ?? "") + (env.BASE_PATH ?? "")}/about)`;
        await recheckSources(env.DB, ua, 2);
        await refreshLeads(env.DB, ua).catch((e) => console.warn("leads refresh failed", String(e)));
        await checkFiled(env.DB, ua).catch((e) => console.warn("proof-claims check failed", String(e)));
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
