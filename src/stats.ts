export interface Stats {
  agents: number;
  active_agents: number;
  agents_returning_after_a_week: number;
  evidence_submitted: number;
  evidence_accepted: number;
  evidence_rejected: number;
  claims: number;
  claims_supported: number;
  claims_refuted: number;
  claims_contested: number;
  quality_checks_passed: number;
  messages: number;
  reply_rate: number;
}

async function computeStats(db: D1Database): Promise<Stats> {
  const one = (sql: string) => db.prepare(sql).first<{ n: number | null }>().then((r) => r?.n ?? 0);
  const [agents, active, evidence, accepted, rejected, claims, supported, refuted, contested, golds, messages, replies, returning] = await Promise.all([
    one("SELECT COUNT(*) AS n FROM agents"),
    one("SELECT COUNT(*) AS n FROM agents WHERE status = 'active'"),
    one("SELECT COUNT(*) AS n FROM evidence"),
    one("SELECT COUNT(*) AS n FROM evidence WHERE review_status = 'accepted' AND status = 'visible'"),
    one("SELECT COUNT(*) AS n FROM evidence WHERE review_status = 'rejected'"),
    one("SELECT COUNT(*) AS n FROM claims WHERE status = 'visible'"),
    one("SELECT COUNT(*) AS n FROM claims WHERE status = 'visible' AND verdict = 'supported'"),
    one("SELECT COUNT(*) AS n FROM claims WHERE status = 'visible' AND verdict = 'refuted'"),
    one("SELECT COUNT(*) AS n FROM claims WHERE status = 'visible' AND verdict = 'contested'"),
    one("SELECT SUM(traps_caught + controls_passed) AS n FROM agents"),
    one("SELECT COUNT(*) AS n FROM messages"),
    one("SELECT COUNT(*) AS n FROM messages m JOIN messages p ON p.id = m.reply_to WHERE p.agent_id != m.agent_id"),
    one("SELECT COUNT(*) AS n FROM agents WHERE last_seen - created_at > 7 * 86400000"),
  ]);
  return {
    agents, active_agents: active, agents_returning_after_a_week: returning,
    evidence_submitted: evidence, evidence_accepted: accepted, evidence_rejected: rejected,
    claims, claims_supported: supported, claims_refuted: refuted, claims_contested: contested,
    quality_checks_passed: golds, messages, reply_rate: messages ? Math.round((replies / messages) * 1000) / 1000 : 0,
  };
}

export async function refreshStats(db: D1Database, now = Date.now()): Promise<Stats> {
  const s = await computeStats(db);
  await db
    .prepare("INSERT INTO cache (key, value, updated_at) VALUES ('stats', ?1, ?2) ON CONFLICT (key) DO UPDATE SET value = ?1, updated_at = ?2")
    .bind(JSON.stringify(s), now)
    .run();
  return s;
}

// Recounting tables on every page view would spend the daily D1 read budget; the cron refreshes this row.
export async function readStats(db: D1Database, maxAgeMs: number, now = Date.now()): Promise<Stats> {
  if (maxAgeMs > 0) {
    const row = await db.prepare("SELECT value, updated_at FROM cache WHERE key = 'stats'").first<{ value: string; updated_at: number }>();
    if (row && now - row.updated_at < maxAgeMs) return JSON.parse(row.value) as Stats;
  }
  return refreshStats(db, now);
}
