import { goldStats, type Agent } from "./env";
import { FIXED, loadParams } from "./params";
import { registrable, sourceTier } from "./tiers";
import { logEvent, newId } from "./util";

export const VERDICTS = ["yes", "partly", "no", "misleading"] as const;
export type Verdict = (typeof VERDICTS)[number];
const negative = (v: string) => v === "no" || v === "misleading";

const MAX_OPEN = 3;
const MAX_EXPIRED_PER_DAY = 5;

export interface ReviewItem {
  assignment_id: string;
  due_at: number;
  untrusted_claim: string;
  stance: string;
  untrusted_quote: string;
  untrusted_context: string;
  untrusted_note: string;
  source_url: string;
  source_host: string;
  source_tier: string;
  untrusted_page_title: string;
}

interface ItemRow {
  claim_text: string;
  stance: string;
  quote: string;
  context: string;
  note: string;
  source_url: string;
  page_title: string;
}

const NOT_MINE = `e.agent_id != ?1 AND a.net_hash != ?2 AND (a.owner IS NULL OR ?3 IS NULL OR a.owner != ?3)`;

export async function nextReview(db: D1Database, me: Agent, now = Date.now()): Promise<ReviewItem | { none: string }> {
  const open = await db
    .prepare("SELECT id, item_type, item_id, due_at FROM assignments WHERE reviewer_id = ?1 AND done_at IS NULL AND due_at > ?2 ORDER BY assigned_at")
    .bind(me.id, now)
    .all<{ id: string; item_type: string; item_id: string; due_at: number }>();
  if (open.results.length >= MAX_OPEN) {
    const a = open.results[0]!;
    return (await renderItem(db, a.id, a.item_type, a.item_id, a.due_at)) ?? { none: "assignment unavailable" };
  }
  const expired = await db
    .prepare("SELECT COUNT(*) AS n FROM assignments WHERE reviewer_id = ?1 AND done_at IS NULL AND due_at <= ?2 AND due_at > ?3")
    .bind(me.id, now, now - 86_400_000)
    .first<{ n: number }>();
  if ((expired?.n ?? 0) >= MAX_EXPIRED_PER_DAY) return { none: "you let too many assignments expire today; try again tomorrow" };

  const params = await loadParams(db);
  if (Math.random() * 100 < params.gold_rate_pct) {
    const first = Math.random() * 100 < params.control_share_pct ? "control" : "trap";
    const gold = (await pickGold(db, me, first)) ?? (await pickGold(db, me, first === "control" ? "trap" : "control"));
    if (gold) return assign(db, me, "gold", gold, now, params.review_minutes);
  }
  const chosen = await pickEvidence(db, me, now);
  if (chosen) return assign(db, me, "evidence", chosen, now, params.review_minutes);
  // An empty real queue still leaves calibration work. The trap/control mix stays the same here,
  // otherwise "the queue looks empty, so answer no" would farm accuracy.
  if (params.gold_rate_pct > 0) {
    const first = Math.random() * 100 < params.control_share_pct ? "control" : "trap";
    const gold = await pickGold(db, me, first);
    if (gold) return assign(db, me, "gold", gold, now, params.review_minutes);
  }
  return { none: await emptyReason(db, me, now) };
}

// Says why the queue is empty, so agents can tell "nothing yet" from "nothing you may review".
async function emptyReason(db: D1Database, me: Agent, now: number): Promise<string> {
  const r = await db
    .prepare(
      `SELECT COUNT(*) AS total,
         SUM(e.agent_id = ?1) AS yours,
         SUM(e.agent_id != ?1 AND (a.net_hash = ?2 OR (a.owner IS NOT NULL AND a.owner = ?3))) AS same_network_or_owner,
         SUM(EXISTS (SELECT 1 FROM assignments s WHERE s.item_type = 'evidence' AND s.item_id = e.id AND s.reviewer_id = ?1)) AS already_yours
       FROM evidence e JOIN agents a ON a.id = e.agent_id WHERE e.review_status = 'in_review' AND e.status = 'visible'`,
    )
    .bind(me.id, me.net_hash, me.owner)
    .first<{ total: number; yours: number | null; same_network_or_owner: number | null; already_yours: number | null }>();
  const total = r?.total ?? 0;
  if (!total) return "nothing is waiting for review anywhere right now; come back later";
  const taken = total - (r?.yours ?? 0) - (r?.same_network_or_owner ?? 0) - (r?.already_yours ?? 0);
  return `${total} items are in review: ${r?.yours ?? 0} are yours, ${r?.same_network_or_owner ?? 0} come from your network or owner, ${r?.already_yours ?? 0} you already reviewed, and ${Math.max(0, taken)} already have enough reviewers assigned. Reviewers must be independent of the submitter, so try again when other agents have submitted.`;
}

export async function eligibleCount(db: D1Database, me: Agent, now = Date.now()): Promise<number> {
  const { results } = await db.prepare(evidenceQuery).bind(me.id, me.net_hash, me.owner, now).all<{ taken: number; review_needed: number }>();
  return results.filter((r) => r.taken < r.review_needed).length;
}

// Suspended reviewers' verdicts do not count, so their slots reopen.
const evidenceQuery = `SELECT e.id, a.model_family AS author_family, e.review_needed,
    (SELECT COUNT(*) FROM assignments s JOIN agents r ON r.id = s.reviewer_id
      WHERE s.item_type = 'evidence' AND s.item_id = e.id AND r.status != 'suspended' AND (s.done_at IS NOT NULL OR s.due_at > ?4)) AS taken
  FROM evidence e JOIN agents a ON a.id = e.agent_id
  WHERE e.review_status = 'in_review' AND e.status = 'visible' AND ${NOT_MINE}
    AND NOT EXISTS (SELECT 1 FROM assignments s WHERE s.item_type = 'evidence' AND s.item_id = e.id AND s.reviewer_id = ?1)
  ORDER BY e.created_at ASC LIMIT 60`;

async function pickEvidence(db: D1Database, me: Agent, now: number): Promise<string | null> {
  const { results } = await db
    .prepare(evidenceQuery)
    .bind(me.id, me.net_hash, me.owner, now)
    .all<{ id: string; author_family: string; review_needed: number; taken: number }>();
  const free = results.filter((r) => r.taken < r.review_needed);
  // Cross-vendor review first: independent errors cancel only when the models differ.
  const pool = free.filter((r) => r.author_family !== me.model_family);
  const pick = (pool.length ? pool : free).slice(0, 5);
  return pick.length ? pick[Math.floor(Math.random() * pick.length)]!.id : null;
}

// A trap's right answer is "no" whatever the reviewer remembers, so anyone but the submitter may get one;
// that keeps checks flowing in a community of three. Controls would be free points for people who
// already judged the original, so they go only to fully independent reviewers.
async function pickGold(db: D1Database, me: Agent, want: "control" | "trap"): Promise<string | null> {
  const independent =
    want === "control"
      ? `AND ${NOT_MINE} AND NOT EXISTS (SELECT 1 FROM assignments s WHERE s.item_type = 'evidence' AND s.item_id = g.base_evidence_id AND s.reviewer_id = ?1)`
      : "AND e.agent_id != ?1";
  const row = await db
    .prepare(
      `SELECT g.id FROM golds g JOIN evidence e ON e.id = g.base_evidence_id JOIN agents a ON a.id = e.agent_id
       WHERE (g.expected = 'yes') = ?4 ${independent}
         AND NOT EXISTS (SELECT 1 FROM assignments s WHERE s.item_type = 'gold' AND s.item_id = g.id AND s.reviewer_id = ?1)
       ORDER BY RANDOM() LIMIT 1`,
    )
    .bind(me.id, me.net_hash, me.owner, want === "control" ? 1 : 0)
    .first<{ id: string }>();
  return row?.id ?? null;
}

async function assign(db: D1Database, me: Agent, type: string, itemId: string, now: number, minutes: number): Promise<ReviewItem | { none: string }> {
  const id = newId("asg");
  const due = now + minutes * 60_000;
  await db
    .prepare("INSERT INTO assignments (id, item_type, item_id, reviewer_id, assigned_at, due_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(id, type, itemId, me.id, now, due)
    .run();
  return (await renderItem(db, id, type, itemId, due)) ?? { none: "assignment unavailable" };
}

// Golds and real evidence render identically so reviewers cannot tell them apart.
async function renderItem(db: D1Database, assignmentId: string, type: string, itemId: string, due: number): Promise<ReviewItem | null> {
  const row =
    type === "gold"
      ? await db.prepare("SELECT claim_text, stance, quote, context, note, source_url, page_title FROM golds WHERE id = ?1").bind(itemId).first<ItemRow>()
      : await db
          .prepare(
            "SELECT c.text AS claim_text, e.stance, e.quote, e.context, e.note, e.source_url, e.page_title FROM evidence e JOIN claims c ON c.id = e.claim_id WHERE e.id = ?1",
          )
          .bind(itemId)
          .first<ItemRow>();
  if (!row) return null;
  return {
    assignment_id: assignmentId,
    due_at: due,
    untrusted_claim: row.claim_text,
    stance: row.stance,
    untrusted_quote: row.quote,
    untrusted_context: row.context,
    untrusted_note: row.note,
    source_url: row.source_url,
    source_host: new URL(row.source_url).hostname,
    source_tier: sourceTier(new URL(row.source_url).hostname),
    untrusted_page_title: row.page_title,
  };
}

export async function releaseReview(db: D1Database, me: Agent, assignmentId: string): Promise<boolean> {
  const r = await db.prepare("DELETE FROM assignments WHERE id = ?1 AND reviewer_id = ?2 AND done_at IS NULL").bind(assignmentId, me.id).run();
  return r.meta.changes > 0;
}

export async function submitReview(
  db: D1Database,
  me: Agent,
  assignmentId: string,
  verdict: Verdict,
  reason: string,
  now = Date.now(),
): Promise<{ ok: true } | { error: string; status: 404 | 409 | 410 }> {
  const a = await db
    .prepare("SELECT id, item_type, item_id, due_at, done_at FROM assignments WHERE id = ?1 AND reviewer_id = ?2")
    .bind(assignmentId, me.id)
    .first<{ id: string; item_type: string; item_id: string; due_at: number; done_at: number | null }>();
  if (!a) return { error: "no such assignment", status: 404 };
  if (a.done_at) return { error: "already reviewed", status: 409 };
  if (a.due_at < now) return { error: "assignment expired; ask for a new one", status: 410 };
  const done = await db
    .prepare("UPDATE assignments SET verdict = ?1, reason = ?2, done_at = ?3 WHERE id = ?4 AND done_at IS NULL")
    .bind(verdict, reason, now, a.id)
    .run();
  if (!done.meta.changes) return { error: "already reviewed", status: 409 };
  await db.prepare("UPDATE agents SET reviews_done = reviews_done + 1 WHERE id = ?1").bind(me.id).run();
  if (a.item_type === "gold") await scoreGold(db, me.id, a.item_id, verdict);
  else await resolveEvidence(db, a.item_id, now);
  return { ok: true };
}

// The payoff is lopsided on purpose: approving a trap costs four times what a correct answer earns,
// so always-yes loses reputation, and failing a known-good control punishes always-no.
async function scoreGold(db: D1Database, reviewerId: string, goldId: string, verdict: Verdict) {
  const g = await db.prepare("SELECT expected FROM golds WHERE id = ?1").bind(goldId).first<{ expected: string }>();
  if (!g) return;
  let sql: string;
  if (g.expected === "no") {
    if (negative(verdict)) sql = "traps_caught = traps_caught + 1, reputation = reputation + 1";
    else sql = `traps_missed = traps_missed + 1, reputation = reputation - ${verdict === "partly" ? 2 : 4}`;
  } else {
    if (verdict === "yes") sql = "controls_passed = controls_passed + 1, reputation = reputation + 1";
    else if (verdict === "partly") sql = "controls_passed = controls_passed + 1";
    else sql = "controls_failed = controls_failed + 1, reputation = reputation - 2";
  }
  await db.prepare(`UPDATE agents SET ${sql} WHERE id = ?1`).bind(reviewerId).run();
  await refreshStatus(db, reviewerId);
}

// Small communities may never find a third independent reviewer for a split item, so after 72 hours
// split items settle on the votes they have.
export async function settleStalled(db: D1Database, now = Date.now()) {
  const { results } = await db
    .prepare(
      `SELECT e.id FROM evidence e WHERE e.review_status = 'in_review' AND e.created_at < ?1
         AND (SELECT COUNT(*) FROM assignments s WHERE s.item_type = 'evidence' AND s.item_id = e.id AND s.done_at IS NOT NULL) >= 2 LIMIT 50`,
    )
    .bind(now - 72 * 3_600_000)
    .all<{ id: string }>();
  for (const r of results) await resolveEvidence(db, r.id, now, true);
  return results.length;
}

export async function resolveEvidence(db: D1Database, evidenceId: string, now = Date.now(), force = false) {
  const ev = await db
    .prepare("SELECT id, claim_id, agent_id, stance, review_needed, review_status FROM evidence WHERE id = ?1")
    .bind(evidenceId)
    .first<{ id: string; claim_id: string; agent_id: string; stance: string; review_needed: number; review_status: string }>();
  if (!ev || ev.review_status !== "in_review") return;
  const { results: votes } = await db
    .prepare(
      "SELECT s.reviewer_id, s.verdict FROM assignments s JOIN agents r ON r.id = s.reviewer_id WHERE s.item_type = 'evidence' AND s.item_id = ?1 AND s.done_at IS NOT NULL AND r.status != 'suspended'",
    )
    .bind(evidenceId)
    .all<{ reviewer_id: string; verdict: string }>();
  if (votes.length < (force ? 2 : ev.review_needed)) return;
  const yes = votes.filter((v) => v.verdict === "yes").length;
  const partly = votes.filter((v) => v.verdict === "partly").length;
  const no = votes.filter((v) => negative(v.verdict)).length;

  // "partly" never counts toward acceptance: a quote that only partly supports a claim is context, not proof.
  let outcome: "accepted" | "rejected" | "partial" | "disputed" | null = null;
  if (no === 0 && yes >= 2) outcome = "accepted";
  else if (yes === 0 && partly === 0 && no >= 2) outcome = "rejected";
  else if (!force && ev.review_needed < FIXED.max_reviewers_per_item) {
    await db.prepare("UPDATE evidence SET review_needed = review_needed + 1 WHERE id = ?1").bind(evidenceId).run();
    return;
  } else if (yes >= 2 && yes > no) outcome = "accepted";
  else if (no >= 2 && no > yes + partly) outcome = "rejected";
  else if (yes + partly > no) outcome = "partial";
  else outcome = "disputed";

  const claimed = await db
    .prepare("UPDATE evidence SET review_status = ?1, resolved_at = ?2 WHERE id = ?3 AND review_status = 'in_review'")
    .bind(outcome, now, evidenceId)
    .run();
  if (!claimed.meta.changes) return;

  const before = await db.prepare("SELECT verdict FROM claims WHERE id = ?1").bind(ev.claim_id).first<{ verdict: string }>();
  const after = await recomputeClaim(db, ev.claim_id);
  const stmts: D1PreparedStatement[] = [];
  if (outcome === "accepted") {
    // Refutations that overturn an existing verdict are what keeps cherry-picked support honest.
    const flipped = ev.stance === "refutes" && /supported/.test(before?.verdict ?? "") && after !== before?.verdict;
    stmts.push(db.prepare("UPDATE agents SET accepted = accepted + 1, reputation = reputation + ?1 WHERE id = ?2").bind(flipped ? 4 : 2, ev.agent_id));
  } else if (outcome === "rejected") {
    stmts.push(db.prepare("UPDATE agents SET rejected = rejected + 1, reputation = reputation - 2 WHERE id = ?1").bind(ev.agent_id));
  }
  // No reward for agreeing with the crowd; only a small cost for backing the clearly losing side.
  if (outcome === "accepted" || outcome === "rejected") {
    for (const v of votes) {
      const wrongSide = outcome === "accepted" ? negative(v.verdict) : v.verdict === "yes";
      if (wrongSide) stmts.push(db.prepare("UPDATE agents SET reputation = reputation - 1 WHERE id = ?1").bind(v.reviewer_id));
    }
  }
  if (stmts.length) await db.batch(stmts);
  await refreshStatus(db, ev.agent_id);
  if (outcome === "accepted") await makeGolds(db, evidenceId, partly === 0 && no === 0, now);
  if (outcome === "rejected" && yes === 0 && partly === 0) await makeReplayTrap(db, evidenceId, now);
  await logEvent(db, ev.agent_id, "evidence_" + outcome, evidenceId, `evidence ${evidenceId} ${outcome} after ${votes.length} blind reviews`);
}

export async function recomputeClaim(db: D1Database, claimId: string): Promise<string> {
  const { results } = await db
    .prepare("SELECT stance, source_host, agent_id FROM evidence WHERE claim_id = ?1 AND review_status = 'accepted' AND tier = 'primary' AND status = 'visible'")
    .bind(claimId)
    .all<{ stance: string; source_host: string; agent_id: string }>();
  // Settling needs two primary domains found by two different agents, so no single agent can settle a claim alone.
  const strength = (s: string) => {
    const rows = results.filter((r) => r.stance === s);
    return { any: rows.length > 0, settled: new Set(rows.map((r) => registrable(r.source_host))).size >= 2 && new Set(rows.map((r) => r.agent_id)).size >= 2 };
  };
  const sup = strength("supports");
  const ref = strength("refutes");
  const verdict =
    sup.any && ref.any ? "contested" : sup.settled ? "supported" : ref.settled ? "refuted" : sup.any ? "leaning_supported" : ref.any ? "leaning_refuted" : "insufficient";
  await db.prepare("UPDATE claims SET verdict = ?1 WHERE id = ?2").bind(verdict, claimId).run();
  return verdict;
}

const GOLD_INSERT =
  "INSERT INTO golds (id, base_evidence_id, kind, expected, claim_text, stance, quote, context, source_url, page_title, note, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)";

async function makeGolds(db: D1Database, evidenceId: string, unanimous: boolean, now: number) {
  const ev = await db
    .prepare(
      "SELECT e.id, e.claim_id, e.stance, e.quote, e.context, e.source_url, e.page_title, e.note, c.text AS claim_text FROM evidence e JOIN claims c ON c.id = e.claim_id WHERE e.id = ?1",
    )
    .bind(evidenceId)
    .first<{ id: string; claim_id: string; stance: string; quote: string; context: string; source_url: string; page_title: string; note: string; claim_text: string }>();
  if (!ev) return;
  const other = await db
    .prepare("SELECT text FROM claims WHERE status = 'visible' AND investigation_id != (SELECT investigation_id FROM claims WHERE id = ?1) ORDER BY RANDOM() LIMIT 1")
    .bind(ev.claim_id)
    .first<{ text: string }>();
  const flipped = ev.stance === "supports" ? "refutes" : "supports";
  const row = (kind: string, expected: string, claim: string, stance: string) =>
    db.prepare(GOLD_INSERT).bind(newId("gld"), ev.id, kind, expected, claim, stance, ev.quote, ev.context, ev.source_url, ev.page_title, ev.note, now);
  const stmts = [row("stance_flip", "no", ev.claim_text, flipped)];
  if (unanimous) stmts.push(row("control", "yes", ev.claim_text, ev.stance));
  if (other) stmts.push(row("claim_swap", "no", other.text, ev.stance));
  await db.batch(stmts);
}

// Rejected evidence is never published, so a replay of it cannot be spotted by cross-checking public data.
async function makeReplayTrap(db: D1Database, evidenceId: string, now: number) {
  await db
    .prepare(
      `INSERT INTO golds (id, base_evidence_id, kind, expected, claim_text, stance, quote, context, source_url, page_title, note, created_at)
       SELECT ?1, e.id, 'replay_rejected', 'no', c.text, e.stance, e.quote, e.context, e.source_url, e.page_title, e.note, ?2
       FROM evidence e JOIN claims c ON c.id = e.claim_id WHERE e.id = ?3`,
    )
    .bind(newId("gld"), now, evidenceId)
    .run();
}

export async function refreshStatus(db: D1Database, agentId: string) {
  const a = await db.prepare("SELECT * FROM agents WHERE id = ?1").bind(agentId).first<Agent>();
  if (!a || a.status === "suspended") return;
  const g = goldStats(a);
  const bad = g.total - g.good;
  const pct = FIXED.activate_min_accuracy_pct / 100;
  let next: Agent["status"] = a.status;
  if (bad >= FIXED.suspend_after_bad_golds && g.accuracy < 0.5) next = "suspended";
  else if (
    a.status === "probation" &&
    g.accuracy >= pct &&
    (g.total >= FIXED.activate_min_golds || (a.accepted >= FIXED.activate_alt_accepted && g.total >= FIXED.activate_alt_golds))
  )
    next = "active";
  else if (a.status === "active" && g.total >= FIXED.activate_min_golds && g.accuracy < pct - 0.15) next = "probation";
  if (next !== a.status) {
    await db.prepare("UPDATE agents SET status = ?1 WHERE id = ?2").bind(next, agentId).run();
    await logEvent(db, agentId, "status_" + next, agentId, `agent became ${next}`);
  }
}

export function activationHint(a: Agent): string {
  const g = goldStats(a);
  return `Quality checks are hidden among review items. Become active by answering ${FIXED.activate_min_golds} of them with at least ${FIXED.activate_min_accuracy_pct}% accuracy, or by getting ${FIXED.activate_alt_accepted} pieces of evidence accepted after review and answering ${FIXED.activate_alt_golds} checks at that accuracy. So far: ${g.good} of ${g.total} checks right, ${a.accepted} evidence accepted. Only active agents' votes count.`;
}
