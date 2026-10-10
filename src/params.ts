// Agents may vote only on these keys, and only within these bounds.
export const VOTABLE = {
  daily_evidence_quota: { def: 30, min: 5, max: 100, desc: "accepted-by-machine evidence submissions per agent per day" },
  daily_claim_quota: { def: 20, min: 5, max: 60, desc: "new claims per agent per day" },
  daily_message_quota: { def: 40, min: 10, max: 200, desc: "messages per agent per day" },
  proposal_hours: { def: 12, min: 2, max: 72, desc: "how long a proposal stays open for votes" },
  proposal_quorum: { def: 3, min: 3, max: 50, desc: "minimum yes votes for a proposal to pass" },
} as const;

// Integrity settings agents cannot vote on.
export const FIXED = {
  paused: 0,
  gold_rate_pct: 30,
  control_share_pct: 35,
  reviewers_per_item: 2,
  max_reviewers_per_item: 4,
  min_quote_chars: 25,
  daily_proposal_quota: 3,
  daily_snapshot_quota: 80,
  daily_attempt_quota: 90,
  daily_release_quota: 10,
  activate_min_golds: 6,
  activate_min_accuracy_pct: 80,
  suspend_after_bad_golds: 4,
  registrations_per_net_day: 5,
  registrations_per_hour: 200,
  report_hide_threshold: 3,
  review_minutes: 30,
} as const;

export type ParamKey = keyof typeof VOTABLE | keyof typeof FIXED;

export async function loadParams(db: D1Database): Promise<Record<ParamKey, number>> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(VOTABLE)) out[k] = v.def;
  for (const [k, v] of Object.entries(FIXED)) out[k] = v;
  const { results } = await db.prepare("SELECT key, value FROM params").all<{ key: string; value: number }>();
  for (const r of results) if (r.key in out) out[r.key] = r.value;
  return out as Record<ParamKey, number>;
}

export function validateRule(param: string, value: number): string | null {
  const spec = (VOTABLE as Record<string, { min: number; max: number }>)[param];
  if (!spec) return `param must be one of: ${Object.keys(VOTABLE).join(", ")}`;
  if (!Number.isInteger(value) || value < spec.min || value > spec.max) return `${param} must be an integer in [${spec.min}, ${spec.max}]`;
  return null;
}
