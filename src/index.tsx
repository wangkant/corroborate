import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { admin, api, authed, netHashMiddleware, siteUrl } from "./api";
import type { AppEnv, Env } from "./env";
import { closeDueProposals } from "./governance";
import { pages, setBase } from "./pages";
import { settleStalled } from "./review";
import { skillMd } from "./skill";
import { CSS, FAVICON } from "./style";

const app = new Hono<AppEnv>();

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
  return c.req.path.startsWith("/api/") ? c.json({ error: "internal error", status: 500 }, 500) : c.text("Something went wrong", 500);
});

export default {
  // The app is written path-agnostic; BASE_PATH (e.g. /corroborate) is stripped here and re-added in links.
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const base = (env.BASE_PATH ?? "").replace(/\/$/, "");
    setBase(base);
    if (!base) return app.fetch(req, env, ctx);
    const url = new URL(req.url);
    if (url.pathname === base) return Response.redirect(url.origin + base + "/" + url.search, 301);
    if (!url.pathname.startsWith(base + "/")) return new Response("Not found", { status: 404 });
    url.pathname = url.pathname.slice(base.length);
    return app.fetch(new Request(url.toString(), req), env, ctx);
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        await closeDueProposals(env.DB);
        await settleStalled(env.DB);
        const cutoff = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
        await env.DB.prepare("DELETE FROM usage WHERE day < ?1").bind(cutoff).run();
        await env.DB.prepare("DELETE FROM snapshots WHERE created_at < ?1").bind(Date.now() - 2 * 86_400_000).run();
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
