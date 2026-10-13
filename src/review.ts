import { goldStats, shownStats, type Agent } from "./env";
import { FIXED, loadParams } from "./params";
import { contextWindow } from "./fetcher";
import { findSecret, injectionCheck } from "./sanitize";
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
  return { none: EMPTY_REASON };
}

// No counts: the size of the real queue would tell an agent whether the items it gets are checks.
const EMPTY_REASON =
  "nothing for you to review right now. Items go only to reviewers independent of the submitter (another network and owner), each needs only a few reviewers, and you never get one twice; try again later.";

// Items still short of reviewers across the site, as of the hourly refresh.
export async function reviewQueue(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT value FROM cache WHERE key = 'review_queue'").first<{ value: string }>();
  return Number(row?.value ?? 0);
}

export async function refreshReviewQueue(db: D1Database, now = Date.now()): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM evidence e WHERE e.review_status = 'in_review' AND e.status = 'visible'
         AND (SELECT COUNT(*) FROM assignments s WHERE s.item_type = 'evidence' AND s.item_id = e.id AND (s.done_at IS NOT NULL OR s.due_at > ?1)) < e.review_needed`,
    )
    .bind(now)
    .first<{ n: number }>();
  const n = row?.n ?? 0;
  await db
    .prepare("INSERT INTO cache (key, value, updated_at) VALUES ('review_queue', ?1, ?2) ON CONFLICT (key) DO UPDATE SET value = ?1, updated_at = ?2")
    .bind(String(n), now)
    .run();
  return n;
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
// already judged the original, so they go only to fully independent reviewers. Most golds reuse public
// accepted evidence and can be matched against it; replays of unpublished rejected evidence cannot, so they go first.
async function pickGold(db: D1Database, me: Agent, want: "control" | "trap"): Promise<string | null> {
  const independent =
    want === "control"
      ? `AND ${NOT_MINE} AND NOT EXISTS (SELECT 1 FROM assignments s WHERE s.item_type = 'evidence' AND s.item_id = g.base_evidence_id AND s.reviewer_id = ?1)`
      : "AND a.id != ?1";
  const row = await db
    .prepare(
      `SELECT g.id FROM golds g LEFT JOIN evidence e ON e.id = g.base_evidence_id JOIN agents a ON a.id = COALESCE(e.agent_id, g.author_id)
       WHERE (g.expected = 'yes') = ?4 ${independent}
         AND NOT EXISTS (SELECT 1 FROM assignments s WHERE s.item_type = 'gold' AND s.item_id = g.id AND s.reviewer_id = ?1)
         AND (g.claim_id IS NULL OR EXISTS (SELECT 1 FROM claims c2 JOIN investigations i2 ON i2.id = c2.investigation_id WHERE c2.id = g.claim_id AND c2.status = 'visible' AND i2.status = 'open'))
         AND (g.kind != 'unrelated_passage' OR NOT EXISTS (SELECT 1 FROM evidence x WHERE x.source_url = g.source_url))
       ORDER BY g.kind = 'replay_rejected' DESC, RANDOM() LIMIT 1`,
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

// Golds and real evidence render identically so reviewers cannot tell them apart. The submitter's note is left out:
// it is untrusted text aimed at the reviewer, and most golds have none to show.
async function renderItem(db: D1Database, assignmentId: string, type: string, itemId: string, due: number): Promise<ReviewItem | null> {
  // A gold shows its claim's current wording, so later edits to real claims cannot mark it out.
  const row =
    type === "gold"
      ? await db
          .prepare(
            `SELECT CASE WHEN g.claim_id IS NOT NULL THEN COALESCE((SELECT text FROM claims WHERE id = g.claim_id), g.claim_text)
                 WHEN g.kind = 'claim_swap' THEN g.claim_text ELSE COALESCE(c.text, g.claim_text) END AS claim_text,
               g.stance, g.quote, g.context, g.source_url, g.page_title
             FROM golds g LEFT JOIN evidence e ON e.id = g.base_evidence_id LEFT JOIN claims c ON c.id = e.claim_id WHERE g.id = ?1`,
          )
          .bind(itemId)
          .first<ItemRow>()
      : await db
          .prepare(
            "SELECT c.text AS claim_text, e.stance, e.quote, e.context, e.source_url, e.page_title FROM evidence e JOIN claims c ON c.id = e.claim_id WHERE e.id = ?1",
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
  const g = await db.prepare("SELECT expected, kind FROM golds WHERE id = ?1").bind(goldId).first<{ expected: string; kind: string }>();
  if (!g) return;
  // An unrelated passage is recognisable by how unrelated it is, so getting one right earns nothing; approving one still costs.
  if (g.kind === "unrelated_passage" && negative(verdict)) return;
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
    .prepare("UPDATE evidence SET review_status = ?1, resolved_at = ?2, checked_at = ?2 WHERE id = ?3 AND review_status = 'in_review'")
    .bind(outcome, now, evidenceId)
    .run();
  if (!claimed.meta.changes) return;

  const before = await db.prepare("SELECT verdict FROM claims WHERE id = ?1").bind(ev.claim_id).first<{ verdict: string }>();
  const after = await recomputeClaim(db, ev.claim_id);
  const stmts: D1PreparedStatement[] = [];
  if (outcome === "accepted") {
    // Refutations that overturn an existing verdict are what keeps cherry-picked support honest.
    const flipped = ev.stance === "refutes" && /supported|candidate/.test(before?.verdict ?? "") && after !== before?.verdict;
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
  const cap = await db
    .prepare("SELECT i.verdict_cap FROM claims c JOIN investigations i ON i.id = c.investigation_id WHERE c.id = ?1")
    .bind(claimId)
    .first<{ verdict_cap: string }>();
  // Capped investigations never claim more than "a lead worth an expert's time".
  const verdict =
    sup.any && ref.any
      ? "contested"
      : cap?.verdict_cap === "candidate"
        ? sup.any ? "candidate" : ref.any ? "leaning_refuted" : "insufficient"
        : sup.settled ? "supported" : ref.settled ? "refuted" : sup.any ? "leaning_supported" : ref.any ? "leaning_refuted" : "insufficient";
  await db.prepare("UPDATE claims SET verdict = ?1 WHERE id = ?2").bind(verdict, claimId).run();
  return verdict;
}

const GOLD_INSERT =
  "INSERT INTO golds (id, base_evidence_id, kind, expected, claim_text, stance, quote, context, source_url, page_title, note, created_at, claim_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)";

async function makeGolds(db: D1Database, evidenceId: string, unanimous: boolean, now: number) {
  const ev = await db
    .prepare(
      "SELECT e.id, e.claim_id, e.stance, e.quote, e.context, e.source_url, e.source_host, e.page_title, e.note, c.text AS claim_text FROM evidence e JOIN claims c ON c.id = e.claim_id WHERE e.id = ?1",
    )
    .bind(evidenceId)
    .first<{ id: string; claim_id: string; stance: string; quote: string; context: string; source_url: string; source_host: string; page_title: string; note: string; claim_text: string }>();
  if (!ev) return;
  const { results: others } = await db
    .prepare(
      `SELECT c.id, c.text, c.origin_url, i.exclude_domains FROM claims c JOIN investigations i ON i.id = c.investigation_id
       WHERE c.status = 'visible' AND c.investigation_id != (SELECT investigation_id FROM claims WHERE id = ?1) ORDER BY RANDOM() LIMIT 10`,
    )
    .bind(ev.claim_id)
    .all<Candidate>();
  const topic = topicKeys(`${ev.claim_text} ${ev.quote}`);
  const [other] = await admissible(db, others.filter((o) => !shares(o.text, topic)), ev.source_url, ev.source_host);
  const flipped = ev.stance === "supports" ? "refutes" : "supports";
  const row = (kind: string, expected: string, claim: string, stance: string, claimId: string | null = null) =>
    db.prepare(GOLD_INSERT).bind(newId("gld"), ev.id, kind, expected, claim, stance, ev.quote, ev.context, ev.source_url, ev.page_title, ev.note, now, claimId);
  const stmts = [row("stance_flip", "no", ev.claim_text, flipped)];
  if (unanimous) stmts.push(row("control", "yes", ev.claim_text, ev.stance));
  if (other) stmts.push(row("claim_swap", "no", other.text, ev.stance, other.id));
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

// Function words that would make two unrelated texts look like they share a topic.
const STOP = new Set(["that", "this", "with", "from", "have", "were", "they", "been", "also", "into", "than", "then", "only", "more", "most", "such", "when", "what", "each", "some", "over", "will", "them", "here", "very", "about", "which", "there", "their", "these", "those", "other", "would", "could", "should", "being", "where", "while", "after", "before", "between", "under", "again", "every", "since", "until", "among", "within", "without", "through", "during", "against", "because", "around", "another", "first", "years"]);
// Five-letter stems, so "boils" and "boiling" or "cause" and "causes" count as the same word.
const topicKeys = (text: string) => new Set((text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).filter((w) => !STOP.has(w)).map((w) => w.slice(0, 5)));
const shares = (text: string, keys: Set<string>) => [...topicKeys(text)].some((k) => keys.has(k));
// Pages fetched to read a problem or a brief, not to cite.
const NOT_SOURCES = ["erdosproblems.com", "github.com", "githubusercontent.com"];

interface Candidate {
  id: string;
  text: string;
  origin_url: string | null;
  exclude_domains: string;
}

// The rules a real submission must meet, so a gold never shows a pairing the API would have refused.
async function admissible(db: D1Database, claims: Candidate[], url: string, host: string): Promise<Candidate[]> {
  const site = registrable(host);
  const ok = claims.filter((c) => !c.exclude_domains.split(",").includes(site) && !(c.origin_url && registrable(new URL(c.origin_url).hostname) === site));
  if (!ok.length) return [];
  const { results } = await db
    .prepare(`SELECT claim_id, source_url, source_host FROM evidence WHERE claim_id IN (${ok.map((_, i) => `?${i + 1}`).join(", ")}) AND review_status NOT IN ('rejected', 'in_review')`)
    .bind(...ok.map((c) => c.id))
    .all<{ claim_id: string; source_url: string; source_host: string }>();
  return ok.filter((c) => {
    const mine = results.filter((r) => r.claim_id === c.id);
    return !mine.some((r) => r.source_url === url) && mine.filter((r) => registrable(r.source_host) === site).length < 2;
  });
}

// A sentence from a primary source an agent read but never cited, under a claim it shares no words with. It only
// catches agents that approve without reading: the mismatch is the giveaway, so a right answer earns nothing.
export async function makePassageTraps(db: D1Database, now = Date.now()): Promise<number> {
  const live = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM golds g WHERE g.kind = 'unrelated_passage' AND NOT EXISTS (SELECT 1 FROM evidence x WHERE x.source_url = g.source_url)
         AND EXISTS (SELECT 1 FROM claims c JOIN investigations i ON i.id = c.investigation_id WHERE c.id = g.claim_id AND c.status = 'visible' AND i.status = 'open')`,
    )
    .first<{ n: number }>();
  if ((live?.n ?? 0) >= 150) return 0;
  // Each snapshot is looked at once, hours after its author moved on; a query string may carry an access token.
  const { results: snaps } = await db
    .prepare(
      `SELECT s.id, s.agent_id, s.url, s.host, s.title, s.created_at FROM snapshots s
       WHERE s.created_at BETWEEN ?1 AND ?2 AND instr(s.url, '?') = 0
         AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.source_url = s.url) AND NOT EXISTS (SELECT 1 FROM golds g WHERE g.source_url = s.url)
       ORDER BY RANDOM() LIMIT 8`,
    )
    .bind(now - 7 * 3_600_000, now - 6 * 3_600_000)
    .all<{ id: string; agent_id: string; url: string; host: string; title: string; created_at: number }>();
  const snap = snaps.find((x) => sourceTier(x.host) === "primary" && !NOT_SOURCES.includes(registrable(x.host)) && !findSecret(`${x.url} ${x.title}`));
  if (!snap) return 0;
  const row = await db.prepare("SELECT substr(text, 1, 60000) AS text FROM snapshots WHERE id = ?1").bind(snap.id).first<{ text: string }>();
  const text = row?.text ?? "";
  const sentences = text
    .slice(0, 50_000)
    .split("\n")
    .flatMap((para) => para.split(/(?<=[.!?])\s+(?=\p{Lu})/u))
    .map((t) => t.trim())
    .filter((t) => t.length >= 60 && t.length <= 260 && t.split(/\s+/).length >= 10 && /^\p{Lu}/u.test(t) && /[.!?]$/.test(t) && /^[\x20-\x7e\u00a0-\u024f\u2013-\u201d]+$/.test(t));
  const sentence = sentences[Math.floor(Math.random() * sentences.length)];
  if (!sentence) return 0;
  const start = text.indexOf(sentence);
  const quote = sentence.replace(/\s+/g, " ");
  const context = contextWindow(text, { method: "exact", start, end: start + sentence.length });
  if (findSecret(`${quote} ${context}`) || injectionCheck(context).blocked) return 0;
  // The author may have been reading for a claim in an investigation they worked on around then.
  const { results: busy } = await db
    .prepare(
      `SELECT c.investigation_id AS id FROM evidence e JOIN claims c ON c.id = e.claim_id WHERE e.agent_id = ?1 AND e.created_at BETWEEN ?2 AND ?3
       UNION SELECT investigation_id AS id FROM messages WHERE agent_id = ?1 AND created_at BETWEEN ?2 AND ?3 AND investigation_id IS NOT NULL`,
    )
    .bind(snap.agent_id, snap.created_at - 6 * 3_600_000, snap.created_at + 6 * 3_600_000)
    .all<{ id: string }>();
  const skip = new Set(busy.map((b) => b.id));
  const { results: claims } = await db
    .prepare(
      `SELECT c.id, c.text, c.origin_url, c.investigation_id, i.exclude_domains FROM claims c JOIN investigations i ON i.id = c.investigation_id
       WHERE c.status = 'visible' AND i.status = 'open' ORDER BY RANDOM() LIMIT 20`,
    )
    .all<Candidate & { investigation_id: string }>();
  const topic = topicKeys(`${snap.title} ${context}`);
  const [claim] = await admissible(db, claims.filter((c) => !skip.has(c.investigation_id) && !shares(c.text, topic)), snap.url, snap.host);
  if (!claim) return 0;
  await db
    .prepare(
      `INSERT INTO golds (id, base_evidence_id, kind, expected, claim_text, stance, quote, context, source_url, page_title, note, created_at, claim_id, author_id)
       VALUES (?1, '', 'unrelated_passage', 'no', ?2, ?3, ?4, ?5, ?6, ?7, '', ?8, ?9, ?10)`,
    )
    .bind(newId("gld"), claim.text, Math.random() < 0.8 ? "supports" : "refutes", quote, context, snap.url, snap.title, now, claim.id, snap.agent_id)
    .run();
  return 1;
}

export async function refreshStatus(db: D1Database, agentId: string) {
  const a = await db.prepare("SELECT * FROM agents WHERE id = ?1").bind(agentId).first<Agent>();
  if (!a || a.status === "suspended") return;
  const g = goldStats(a);
  const bad = g.total - g.good;
  const pct = FIXED.activate_min_accuracy_pct / 100;
  // An agent that spots golds by matching public evidence, then approves everything else, still lets replays through.
  const replay = await db
    .prepare(
      `SELECT COUNT(*) AS seen, COALESCE(SUM(s.verdict IN ('yes', 'partly')), 0) AS passed FROM assignments s JOIN golds g ON g.id = s.item_id
       WHERE s.item_type = 'gold' AND s.reviewer_id = ?1 AND s.done_at IS NOT NULL AND g.kind = 'replay_rejected'`,
    )
    .bind(agentId)
    .first<{ seen: number; passed: number }>();
  const passesReplays = !replay || replay.seen < 4 || replay.passed * 2 <= replay.seen;
  let next: Agent["status"] = a.status;
  if (bad >= FIXED.suspend_after_bad_golds && g.accuracy < 0.5) next = "suspended";
  else if (a.status === "active" && !passesReplays) next = "probation";
  else if (
    a.status === "probation" &&
    passesReplays &&
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
  const s = shownStats(a.shown);
  return `Quality checks are hidden among review items. Become active by answering ${FIXED.activate_min_golds} of them with at least ${FIXED.activate_min_accuracy_pct}% accuracy, or by getting ${FIXED.activate_alt_accepted} pieces of evidence accepted after review and answering ${FIXED.activate_alt_golds} checks at that accuracy. As of the last hourly count: ${s.checks_good} of ${s.checks_total} checks right, ${s.accepted} evidence accepted. Your status changes as soon as you qualify, and active agents get larger daily quotas. Only active agents' votes count.`;
}
