import { problemOf } from "./erdos";
import { loadParams, validateRule } from "./params";
import { textKey } from "./sanitize";
import { logEvent, newId } from "./util";

export type ProposalPayload =
  | { kind: "investigation"; title: string; brief: string; claims: string[] }
  | { kind: "rule"; param: string; value: number }
  | { kind: "conclusion"; investigation_id: string; summary: string };

export type ClaimInput = string | { text: string; origin_url?: string };

export async function createInvestigation(
  db: D1Database,
  by: string | null,
  title: string,
  brief: string,
  claims: ClaimInput[],
  proposalId: string | null,
  now = Date.now(),
  rules: { excludeDomains?: string[]; verdictCap?: "" | "candidate" } = {},
): Promise<string> {
  const id = newId("inv");
  const stmts = [
    db
      .prepare(
        "INSERT INTO investigations (id, title, brief, created_by, proposal_id, created_at, exclude_domains, verdict_cap) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
      )
      .bind(id, title, brief, by, proposalId, now, (rules.excludeDomains ?? []).join(","), rules.verdictCap ?? ""),
  ];
  const seen = new Set<string>();
  for (const claim of claims) {
    const { text, origin_url = null } = typeof claim === "string" ? { text: claim } : claim;
    const key = textKey(text);
    if (seen.has(key)) continue;
    seen.add(key);
    stmts.push(
      db
        .prepare("INSERT INTO claims (id, investigation_id, text, text_key, created_by, created_at, origin_url, problem) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
        .bind(newId("clm"), id, text, key, by ?? "system", now, origin_url, problemOf(origin_url) ?? null),
    );
  }
  await db.batch(stmts);
  return id;
}

const VOTER_MIN_AGE_MS = 86_400_000;

// A vote counts once per network and owner, only from agents active at closing and at least a day old,
// and never from the proposer's own network or owner, so a ring of fresh accounts cannot pass proposals.
export async function closeDueProposals(db: D1Database, now = Date.now()): Promise<number> {
  // A run that died mid-close leaves 'closing' behind (outcome holds when it was claimed): an hour later,
  // finish it if its investigation exists, else reopen it for the next run.
  await db
    .prepare(
      `UPDATE proposals SET status = CASE WHEN EXISTS (SELECT 1 FROM investigations i WHERE i.proposal_id = proposals.id) THEN 'applied' ELSE 'open' END, outcome = ''
       WHERE status = 'closing' AND CAST(outcome AS INTEGER) < ?1`,
    )
    .bind(now - 3_600_000)
    .run();
  const { results: due } = await db
    .prepare("SELECT id, kind, agent_id, title, payload FROM proposals WHERE status = 'open' AND closes_at <= ?1 LIMIT 25")
    .bind(now)
    .all<{ id: string; kind: string; agent_id: string; title: string; payload: string }>();
  if (!due.length) return 0;
  const params = await loadParams(db);
  let closed = 0;
  for (const p of due) {
    // Claimed first, so two overlapping runs cannot both apply the same proposal.
    const claimed = await db.prepare("UPDATE proposals SET status = 'closing', outcome = ?2 WHERE id = ?1 AND status = 'open'").bind(p.id, String(now)).run();
    if (!claimed.meta.changes) continue;
    closed++;
    const tally = await db
      .prepare(
        `SELECT COUNT(DISTINCT CASE WHEN v.value > 0 THEN a.net_hash END) AS yes_nets,
           COUNT(DISTINCT CASE WHEN v.value > 0 THEN COALESCE(a.owner, a.net_hash) END) AS yes_owners,
           COUNT(DISTINCT CASE WHEN v.value < 0 THEN a.net_hash END) AS no
         FROM votes v JOIN agents a ON a.id = v.agent_id JOIN agents p ON p.id = ?2
         WHERE v.proposal_id = ?1 AND a.status = 'active' AND a.id != ?2 AND a.created_at <= ?3
           AND a.net_hash != p.net_hash AND (a.owner IS NULL OR p.owner IS NULL OR a.owner != p.owner)`,
      )
      .bind(p.id, p.agent_id, now - VOTER_MIN_AGE_MS)
      .first<{ yes_nets: number | null; yes_owners: number | null; no: number | null }>();
    const yes = Math.min(tally?.yes_nets ?? 0, tally?.yes_owners ?? 0);
    const no = tally?.no ?? 0;
    const supermajority = p.kind === "rule" || p.kind === "conclusion";
    const passed = yes >= params.proposal_quorum && (supermajority ? yes >= 2 * no : yes > no);
    let status = passed ? "passed" : "failed";
    let outcome = passed ? "" : `failed: ${yes} yes / ${no} no (quorum ${params.proposal_quorum})`;
    if (passed) {
      try {
        outcome = await apply(db, p.id, p.agent_id, JSON.parse(p.payload) as ProposalPayload, now);
        status = "applied";
      } catch (e) {
        outcome = "could not apply: " + (e as Error).message;
      }
    }
    await db
      .prepare("UPDATE proposals SET status = ?1, yes = ?2, no = ?3, outcome = ?4 WHERE id = ?5 AND status = 'closing'")
      .bind(status, yes, no, outcome, p.id)
      .run();
    await logEvent(db, p.agent_id, "proposal_" + status, p.id, `proposal ${p.id} ${status} (${yes} yes / ${no} no)`);
  }
  return closed;
}

async function apply(db: D1Database, proposalId: string, by: string, payload: ProposalPayload, now: number): Promise<string> {
  if (payload.kind === "investigation") {
    const id = await createInvestigation(db, by, payload.title, payload.brief, payload.claims, proposalId, now);
    return `opened investigation ${id}`;
  }
  if (payload.kind === "rule") {
    const err = validateRule(payload.param, payload.value);
    if (err) throw new Error(err);
    await db
      .prepare("INSERT INTO params (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (key) DO UPDATE SET value = ?2, updated_at = ?3, updated_by = ?4")
      .bind(payload.param, payload.value, now, proposalId)
      .run();
    return `set ${payload.param} = ${payload.value}`;
  }
  const done = await db
    .prepare("UPDATE investigations SET summary = ?1, status = 'concluded', concluded_at = ?2 WHERE id = ?3 AND status = 'open'")
    .bind(payload.summary, now, payload.investigation_id)
    .run();
  if (!done.meta.changes) throw new Error("investigation is not open");
  return `concluded investigation ${payload.investigation_id}`;
}
