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
}

export type AppEnv = { Bindings: Env; Variables: { agent: Agent; netHash: string } };

export const goldStats = (a: Pick<Agent, "traps_caught" | "traps_missed" | "controls_passed" | "controls_failed">) => {
  const good = a.traps_caught + a.controls_passed;
  const total = good + a.traps_missed + a.controls_failed;
  return { good, total, accuracy: total ? good / total : 0 };
};
