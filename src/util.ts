import { sha256Hex } from "./fetcher";

export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return prefix + "_" + [...bytes].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 14);
}

export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return "cb_" + btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const hashToken = (token: string) => sha256Hex("token:" + token);

// Hashes the network block (/24 for IPv4, /48 for IPv6) so rotating addresses within one block does not help.
export function netBlock(ip: string): string {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip.split(".").slice(0, 3).join(".") + ".0/24";
  if (ip.includes(":")) {
    const [head = "", tail = ""] = ip.split("::");
    const left = head ? head.split(":") : [];
    const right = tail ? tail.split(":") : [];
    const full = ip.includes("::") ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
    return full.slice(0, 3).map((g) => g.toLowerCase().padStart(4, "0")).join(":") + "::/48";
  }
  return ip;
}

export const hashNet = (ip: string, salt: string) => sha256Hex("net:" + salt + ":" + netBlock(ip)).then((h) => h.slice(0, 24));

export function today(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function modelFamily(model: string): string {
  const m = model.toLowerCase();
  if (/claude|anthropic|opus|sonnet|haiku|fable/.test(m)) return "anthropic";
  if (/gpt|openai|codex|\bo\d/.test(m)) return "openai";
  if (/gemini|google|gemma/.test(m)) return "google";
  if (/llama|meta/.test(m)) return "meta";
  if (/deepseek/.test(m)) return "deepseek";
  if (/qwen|alibaba/.test(m)) return "alibaba";
  if (/mistral|mixtral/.test(m)) return "mistral";
  if (/grok|xai/.test(m)) return "xai";
  if (/kimi|moonshot/.test(m)) return "moonshot";
  if (/glm|zhipu/.test(m)) return "zhipu";
  return "other";
}

// Atomically counts one use; returns the new count so callers compare against their limit.
export async function bump(db: D1Database, subject: string, action: string, now = Date.now()): Promise<number> {
  const row = await db
    .prepare(
      "INSERT INTO usage (subject, day, action, count) VALUES (?1, ?2, ?3, 1) ON CONFLICT (subject, day, action) DO UPDATE SET count = count + 1 RETURNING count",
    )
    .bind(subject, today(now), action)
    .first<{ count: number }>();
  return row?.count ?? 1;
}

export async function usageToday(db: D1Database, subject: string): Promise<Record<string, number>> {
  const { results } = await db
    .prepare("SELECT action, count FROM usage WHERE subject = ?1 AND day = ?2")
    .bind(subject, today())
    .all<{ action: string; count: number }>();
  return Object.fromEntries(results.map((r) => [r.action, r.count]));
}

export async function logEvent(db: D1Database, agentId: string | null, kind: string, refId: string | null, summary: string) {
  await db
    .prepare("INSERT INTO events (at, agent_id, kind, ref_id, summary) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(Date.now(), agentId, kind, refId, summary)
    .run();
}
