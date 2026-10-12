import { createInvestigation } from "./governance";

// Shared with scripts/harvest_erdos.py; keep the wording and the pinned commit in step.
export const LEAN_COMMIT = "34ee0e3c5fd52d202d62a71094a37970cb5fb870";
export const lean = (n: string) => `https://github.com/google-deepmind/formal-conjectures/blob/${LEAN_COMMIT}/FormalConjectures/ErdosProblems/${n}.lean`;
export const EXCLUDE = ["wikipedia.org", "wolfram.com", "erdosproblems.com", "github.com"];

export const problemOf = (originUrl: string | null) =>
  originUrl?.match(/\/ErdosProblems\/(\d+)\.lean$/)?.[1] ?? originUrl?.match(/^https:\/\/www\.erdosproblems\.com\/(\d+)$/)?.[1];
const DATA = "https://raw.githubusercontent.com/teorth/erdosproblems/main/data/problems.yaml";
const OPEN_STATES = new Set(["open", "falsifiable", "verifiable", "decidable"]);

export const ROLLING_BRIEF =
  "Literature check for Erdős problems that a new arXiv paper names while the Erdős problems database still lists them as open. " +
  "No one here is trying to solve them; we only ask whether the new paper (or other published work) answers one, so mathematicians can check. " +
  "Nothing is sent to erdosproblems.com, the OEIS or GitHub. The problem is the main statement on its erdosproblems.com page, or theorem erdos_N in the " +
  "formal-conjectures file when the claim links one. Support a claim only with a quote of a theorem that answers that main statement in full, with the same " +
  "quantifiers, ranges and constants. Bounds, special cases, variants, conditional results and claims of unpublished proofs are notes, not support. " +
  "A source from the last three years saying the problem is still open refutes the claim. An arXiv preprint and its journal version are one source. " +
  "Wikipedia, MathWorld and erdosproblems.com do not count. Every note names the paper (authors, year, arXiv id or DOI) and says in one line how its " +
  "theorem matches the problem. Results stay candidate references until a mathematician reads them. New papers to start from: GET /api/leads.";

interface ProblemInfo {
  state: string;
  formalized: boolean;
}

function lookup(yaml: string, n: string): ProblemInfo | null {
  const block = yaml.match(new RegExp(`\\n- number: "${n}"\\n([\\s\\S]*?)(?=\\n- number:|$)`))?.[1];
  if (!block) return null;
  return {
    state: block.match(/informal_status:\n {4}state: "([^"]+)"/)?.[1] ?? "",
    formalized: block.match(/formalized:\n {4}state: "([^"]+)"/)?.[1] === "yes",
  };
}

async function rollingInvestigation(db: D1Database, now: number): Promise<string> {
  const title = `Erdős problems named in new papers, ${new Date(now).toISOString().slice(0, 7)}`;
  const existing = await db.prepare("SELECT id FROM investigations WHERE title = ?1 AND status = 'open'").bind(title).first<{ id: string }>();
  if (existing) return existing.id;
  return createInvestigation(db, null, title, ROLLING_BRIEF, [], null, now, { excludeDomains: EXCLUDE, verdictCap: "candidate" });
}

export const claimFor = (db: D1Database, n: string) =>
  db.prepare("SELECT id FROM claims WHERE origin_url LIKE ?1 OR origin_url = ?2").bind(`%/ErdosProblems/${n}.lean`, `https://www.erdosproblems.com/${n}`).first<{ id: string }>();

// A paper naming a problem the database still lists as open is the best lead there is, so it becomes a claim to check.
// Returns how many claims were added and which of the problems now have one.
export async function claimsForProblems(db: D1Database, problems: string[], userAgent: string, now = Date.now()): Promise<{ added: number; covered: string[] }> {
  const covered: string[] = [];
  const uncovered: string[] = [];
  for (const n of [...new Set(problems)].slice(0, 20)) ((await claimFor(db, n)) ? covered : uncovered).push(n);
  if (!uncovered.length) return { added: 0, covered };
  const res = await fetch(DATA, { headers: { "user-agent": userAgent }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`problems database returned HTTP ${res.status}`);
  const yaml = await res.text();
  const fresh = uncovered.map((n) => ({ n, info: lookup(yaml, n) })).filter((p) => p.info && OPEN_STATES.has(p.info.state));
  if (!fresh.length) return { added: 0, covered };
  const invId = await rollingInvestigation(db, now);
  const stmts = fresh.map(({ n, info }) => {
    const origin = info!.formalized ? lean(n) : `https://www.erdosproblems.com/${n}`;
    const where = info!.formalized ? `(theorem erdos_${n} in formal-conjectures)` : `(as stated at erdosproblems.com/${n})`;
    const text = `A published paper or arXiv preprint answers the main question of Erdős Problem #${n} ${where} in full (proof, disproof, or the exact value asked for) with no extra hypotheses.`;
    return db
      .prepare("INSERT OR IGNORE INTO claims (id, investigation_id, text, text_key, created_by, created_at, origin_url) VALUES (?1, ?2, ?3, ?4, 'system', ?5, ?6)")
      .bind(`clm_erdos${n}x${now.toString(36).slice(-4)}`, invId, text, `erdos problem ${n} literature check`, now, origin);
  });
  await db.batch(stmts);
  return { added: fresh.length, covered: [...covered, ...fresh.map((p) => p.n)] };
}
