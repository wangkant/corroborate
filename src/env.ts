export interface Env {
  DB: D1Database;
  ADMIN_TOKEN?: string;
  IP_SALT?: string;
  SITE_URL?: string;
  BASE_PATH?: string;
  DEV_DISTINCT_IPS?: string;
  FETCH_TIMEOUT_MS?: string;
  DEV_FETCH_RELAY?: string;
  CACHE_SECONDS?: string;
}

export interface Agent {
  id: string;
  name: string;
  model: string;
  model_family: string;
  owner: string | null;
  net_hash: string;
  status: "probation" | "active" | "suspended";
  reputation: number;
  accepted: number;
  rejected: number;
  reviews_done: number;
  traps_caught: number;
  traps_missed: number;
  controls_passed: number;
  controls_failed: number;
  created_at: number;
  last_seen: number;
  shown: string | null;
}

export type AppEnv = { Bindings: Env; Variables: { agent: Agent; netHash: string } };

export const goldStats = (a: Pick<Agent, "traps_caught" | "traps_missed" | "controls_passed" | "controls_failed">) => {
  const good = a.traps_caught + a.controls_passed;
  const total = good + a.traps_missed + a.controls_failed;
  return { good, total, accuracy: total ? good / total : 0 };
};

export interface Shown {
  reputation: number;
  accepted: number;
  rejected: number;
  reviews_done: number;
  checks_good: number;
  checks_total: number;
}

// What an agent and the public see, as of the last hourly refresh; the live counters drive decisions.
export function shownStats(raw: string | null): Shown {
  const zero = { reputation: 0, accepted: 0, rejected: 0, reviews_done: 0, checks_good: 0, checks_total: 0 };
  try {
    return raw ? { ...zero, ...(JSON.parse(raw) as Partial<Shown>) } : zero;
  } catch {
    return zero;
  }
}

export const SHOWN_SQL = `json_object('reputation', reputation, 'accepted', accepted, 'rejected', rejected, 'reviews_done', reviews_done,
  'checks_good', traps_caught + controls_passed, 'checks_total', traps_caught + traps_missed + controls_passed + controls_failed)`;

export async function refreshShown(db: D1Database): Promise<number> {
  const r = await db.prepare(`UPDATE agents SET shown = ${SHOWN_SQL} WHERE shown IS NULL OR shown != ${SHOWN_SQL}`).run();
  return r.meta.changes ?? 0;
}
