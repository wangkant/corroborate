import { createInvestigation } from "./governance";
import { logEvent } from "./util";

// Shared with scripts/harvest_erdos.py; keep the wording and the pinned commit in step.
export const LEAN_COMMIT = "34ee0e3c5fd52d202d62a71094a37970cb5fb870";
export const lean = (n: string) => `https://github.com/google-deepmind/formal-conjectures/blob/${LEAN_COMMIT}/FormalConjectures/ErdosProblems/${n}.lean`;
export const EXCLUDE = ["wikipedia.org", "wolfram.com", "erdosproblems.com", "github.com"];

// Where an agent can read the problem it is checking. Snapshots of these pages work, but they never count as evidence.
export const problemSources = (n: string, originUrl: string | null) => ({
  number: Number(n),
  statement_page: `https://www.erdosproblems.com/${n}`,
  formal_statement: originUrl?.includes("/ErdosProblems/") ? originUrl.replace("https://github.com/", "https://raw.githubusercontent.com/").replace("/blob/", "/") : null,
  how_to_read:
    "POST /api/snapshot with statement_page (or formal_statement, plain text) to read the problem through the server. These pages cannot be cited as evidence for the claim.",
});

export const problemOf = (originUrl: string | null) =>
  originUrl?.match(/\/ErdosProblems\/(\d+)\.lean$/)?.[1] ?? originUrl?.match(/^https:\/\/www\.erdosproblems\.com\/(\d+)$/)?.[1];
const DATA = "https://raw.githubusercontent.com/teorth/erdosproblems/main/data/problems.yaml";
const OPEN_STATES = new Set(["open", "falsifiable", "verifiable", "decidable"]);

export const ROLLING_BRIEF =
  "Literature check for Erdős problems that a new arXiv paper names while the Erdős problems database still lists them as open. " +
  "No one here is trying to solve them; we only ask whether the new paper (or other published work) answers one, so mathematicians can check. " +
  "Nothing is posted to erdosproblems.com, the OEIS or GitHub. The problem is the main statement on its erdosproblems.com page, or theorem erdos_N in the " +
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
  const block = ("\n" + yaml).match(new RegExp(`\\n- number: "${n}"\\n([\\s\\S]*?)(?=\\n- number:|$)`))?.[1];
  if (!block) return null;
  return {
    state: block.match(/informal_status:\n {4}state: "([^"]+)"/)?.[1] ?? "",
    formalized: block.match(/formalized:\n {4}state: "([^"]+)"/)?.[1] === "yes",
  };
}

export const isOpenState = (state: string) => OPEN_STATES.has(state);

function allStates(yaml: string): Map<string, string> {
  const out = new Map<string, string>();
  // The file starts with its first entry, so a newline is added to split it like the rest.
  for (const block of ("\n" + yaml).split('\n- number: "').slice(1)) {
    const n = block.slice(0, block.indexOf('"'));
    const state = block.match(/informal_status:\n {4}state: "([^"]+)"/)?.[1];
    if (state) out.set(n, state);
  }
  return out;
}

// When the problem list marks a problem that has a claim here as settled, its maintainers have recorded a
// result: the clearest outside check on whether a candidate reference held up.
export async function refreshUpstream(db: D1Database, userAgent: string, now = Date.now(), force = false): Promise<number | null> {
  const last = await db.prepare("SELECT value FROM params WHERE key = 'upstream_at'").first<{ value: number }>();
  if (!force && last && now - last.value < 20 * 3_600_000) return null;
  await db
    .prepare("INSERT INTO params (key, value, updated_at, updated_by) VALUES ('upstream_at', ?1, ?1, 'cron') ON CONFLICT (key) DO UPDATE SET value = ?1, updated_at = ?1")
    .bind(now)
    .run();
  const { results } = await db
    .prepare("SELECT id, problem, upstream_state FROM claims WHERE problem IS NOT NULL AND status = 'visible'")
    .all<{ id: string; problem: string; upstream_state: string | null }>();
  if (!results.length) return 0;
  const res = await fetch(DATA, { headers: { "user-agent": userAgent }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`problems database returned HTTP ${res.status}`);
  const states = allStates(await res.text());
  let settled = 0;
  for (const cl of results) {
    const state = states.get(cl.problem);
    if (!state || state === cl.upstream_state) continue;
    await db.prepare("UPDATE claims SET upstream_state = ?2, upstream_changed_at = ?3 WHERE id = ?1").bind(cl.id, state, now).run();
    // The first reading only records the starting point; later changes to a settled state are news.
    if (cl.upstream_state && !isOpenState(state)) {
      settled++;
      await logEvent(db, null, "upstream", cl.id, `the Erdős problems database now lists problem #${cl.problem} as ${state} (it was ${cl.upstream_state})`);
    }
  }
  return settled;
}

async function rollingInvestigation(db: D1Database, now: number): Promise<string> {
  const title = `Erdős problems named in new papers, ${new Date(now).toISOString().slice(0, 7)}`;
  const existing = await db.prepare("SELECT id FROM investigations WHERE title = ?1 AND status = 'open'").bind(title).first<{ id: string }>();
  if (existing) return existing.id;
  return createInvestigation(db, null, title, ROLLING_BRIEF, [], null, now, { excludeDomains: EXCLUDE, verdictCap: "candidate" });
}

export const claimFor = (db: D1Database, n: string) => db.prepare("SELECT id FROM claims WHERE problem = ?1").bind(n).first<{ id: string }>();

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
    const text = `A published paper or arXiv preprint answers the main question of Erdős Problem #${n} ${where} in full (proof, disproof, or the exact value asked for) with no hypotheses beyond the problem's own.`;
    return db
      .prepare("INSERT OR IGNORE INTO claims (id, investigation_id, text, text_key, created_by, created_at, origin_url, problem) VALUES (?1, ?2, ?3, ?4, 'system', ?5, ?6, ?7)")
      .bind(`clm_erdos${n}x${now.toString(36).slice(-4)}`, invId, text, `erdos problem ${n} literature check`, now, origin, n);
  });
  await db.batch(stmts);
  return { added: fresh.length, covered: [...covered, ...fresh.map((p) => p.n)] };
}
