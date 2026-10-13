import { createInvestigation } from "./governance";
import { logEvent } from "./util";

// Shared with scripts/harvest_erdos.py; keep the wording and the pinned commit in step.
export const LEAN_COMMIT = "34ee0e3c5fd52d202d62a71094a37970cb5fb870";
export const lean = (n: string) => `https://github.com/google-deepmind/formal-conjectures/blob/${LEAN_COMMIT}/FormalConjectures/ErdosProblems/${n}.lean`;
// The live file: states, statements and references shown here are read from it.
const FORMAL_MAIN = (n: string) => `https://raw.githubusercontent.com/google-deepmind/formal-conjectures/main/FormalConjectures/ErdosProblems/${n}.lean`;
export const EXCLUDE = ["wikipedia.org", "wolfram.com", "erdosproblems.com", "github.com"];

// Where an agent can read the problem it is checking. Snapshots of these pages work, but they never count as evidence.
export const problemSources = (n: string, originUrl: string | null) => ({
  number: Number(n),
  statement_page: `https://www.erdosproblems.com/${n}`,
  formal_statement: originUrl?.includes("/ErdosProblems/") ? FORMAL_MAIN(n) : null,
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

function allStates(yaml: string): Map<string, { state: string; formalized: boolean }> {
  const out = new Map<string, { state: string; formalized: boolean }>();
  // The file starts with its first entry, so a newline is added to split it like the rest.
  for (const block of ("\n" + yaml).split('\n- number: "').slice(1)) {
    const n = block.slice(0, block.indexOf('"'));
    const state = block.match(/informal_status:\n {4}state: "([^"]+)"/)?.[1];
    if (state) out.set(n, { state, formalized: block.match(/formalized:\n {4}state: "([^"]+)"/)?.[1] === "yes" });
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
  const res = await fetch(DATA, { headers: { "user-agent": userAgent }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`problems database returned HTTP ${res.status}`);
  const states = allStates(await res.text());
  // One statement for the whole list: the formalized problems that scanFormal compares with formal-conjectures.
  const formalized = Object.fromEntries([...states].filter(([, v]) => v.formalized).map(([n, v]) => [n, v.state]));
  await db
    .prepare(
      `INSERT INTO formal_problems (problem, list_state) SELECT key, value FROM json_each(?1) WHERE true
       ON CONFLICT (problem) DO UPDATE SET list_state = excluded.list_state`,
    )
    .bind(JSON.stringify(formalized))
    .run();
  let settled = 0;
  for (const cl of results) {
    const state = states.get(cl.problem)?.state;
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


// The research category and docstring of theorem erdos_N in a formal-conjectures file.
export function readLean(source: string, n: string): { state: string | null; statement: string | null } {
  const at = source.search(new RegExp(`theorem erdos_${n}(?![.\\w])`));
  if (at < 0) return { state: null, statement: null };
  const before = source.slice(Math.max(0, at - 3000), at);
  const state = [...before.matchAll(/@\[category research (\w+)/g)].pop()?.[1] ?? null;
  const doc = [...before.matchAll(/\/--([\s\S]*?)-\//g)].pop()?.[1]?.replace(/\s+/g, " ").trim() ?? "";
  return { state, statement: doc.length >= 20 ? doc.slice(0, 1500) : null };
}

export interface Ref {
  text: string;
  url: string | null;
}

// The "*References:*" list in a formal-conjectures file header, which often cites the paper that settled the problem.
export function readRefs(source: string): Ref[] {
  const header = source.match(/\/-!([\s\S]*?)-\//)?.[1] ?? "";
  const start = header.indexOf("*References:*");
  if (start < 0) return [];
  const entries: string[] = [];
  for (const line of header.slice(start).split("\n").slice(1)) {
    if (line.startsWith("- ")) entries.push(line.slice(2));
    else if (/^\s+\S/.test(line) && entries.length) entries[entries.length - 1] += " " + line.trim();
    else if (line.trim()) break;
  }
  return entries
    .filter((e) => !/^\[erdosproblems\.com\/\d+\]/.test(e))
    .slice(0, 15)
    .map((e) => {
      const link = [...e.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]!).find((u) => !u.includes("erdosproblems.com"));
      const bare = e.replace(/\[[^\]]*\]\([^)]*\)/g, "").match(/https?:\/\/\S+/)?.[0];
      const arxiv = e.match(/arXiv:(\d{4}\.\d{4,5})/)?.[1];
      const url = link ?? bare ?? (arxiv ? `https://arxiv.org/abs/${arxiv}` : null);
      const text = e.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim().slice(0, 300);
      return { text, url };
    });
}

// Stored references come back as data; only http(s) links survive, so nothing else can reach an href.
export function parseRefs(raw: string | null): Ref[] {
  try {
    const list = raw ? (JSON.parse(raw) as Ref[]) : [];
    return list
      .filter((r) => r && typeof r.text === "string")
      .map((r) => ({ text: r.text.slice(0, 300), url: typeof r.url === "string" && /^https?:\/\//.test(r.url) ? r.url : null }));
  } catch {
    return [];
  }
}

// formal-conjectures marks problems solved sooner than the problem list, so it is read too, a few files per run.
// Every claim is tried, since problems get formalized after their claim opens; a missing file is skipped.
export async function refreshFormal(db: D1Database, userAgent: string, now = Date.now(), limit = 8, force = false): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT id, problem, formal_state FROM claims
       WHERE problem IS NOT NULL AND status = 'visible'
         AND (?3 = 1 OR formal_checked_at IS NULL OR formal_checked_at < ?1)
       ORDER BY formal_checked_at IS NOT NULL, formal_checked_at LIMIT ?2`,
    )
    .bind(now - 20 * 3_600_000, limit, force ? 1 : 0)
    .all<{ id: string; problem: string; formal_state: string | null }>();
  let solved = 0;
  for (const cl of results) {
    await db.prepare("UPDATE claims SET formal_checked_at = ?2 WHERE id = ?1").bind(cl.id, now).run();
    const res = await fetch(FORMAL_MAIN(cl.problem), { headers: { "user-agent": userAgent }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) continue;
    const source = await res.text();
    const { state, statement } = readLean(source, cl.problem);
    if (!state) continue;
    const refs = readRefs(source);
    await db
      .prepare("UPDATE claims SET formal_state = ?2, statement = COALESCE(?3, statement), refs = ?4 WHERE id = ?1")
      .bind(cl.id, state, statement, refs.length ? JSON.stringify(refs) : null)
      .run();
    if (cl.formal_state && cl.formal_state !== state && state === "solved") {
      solved++;
      await logEvent(db, null, "upstream", cl.id, `formal-conjectures now marks Erdős problem #${cl.problem} as solved (it was ${cl.formal_state})`);
    }
  }
  return solved;
}

export interface ErdosRow {
  id: string;
  problem: string;
  verdict: string;
  upstream_state: string | null;
  formal_state: string | null;
  statement: string | null;
  papers: number;
  accepted: number;
}

// Every Erdős problem followed here, with what each outside source says about it.
export async function erdosOverview(db: D1Database): Promise<ErdosRow[]> {
  const { results } = await db
    .prepare(
      `SELECT c.id, c.problem, c.verdict, c.upstream_state, c.formal_state, c.statement,
         (SELECT COUNT(*) FROM leads l WHERE ',' || l.problems || ',' LIKE '%,' || c.problem || ',%' OR ',' || l.matched || ',' LIKE '%,' || c.problem || ',%') AS papers,
         (SELECT COUNT(*) FROM evidence e WHERE e.claim_id = c.id AND e.review_status = 'accepted' AND e.status = 'visible') AS accepted
       FROM claims c JOIN investigations i ON i.id = c.investigation_id
       WHERE c.problem IS NOT NULL AND c.status = 'visible' AND i.status != 'hidden'
       ORDER BY CAST(c.problem AS INTEGER) LIMIT 500`,
    )
    .all<ErdosRow>();
  return results;
}

// A few formal-conjectures files per run, oldest reading first: the whole set in about half a day, then each file again a day later.
export async function scanFormal(db: D1Database, userAgent: string, now = Date.now(), limit = 12): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT problem, fc_state FROM formal_problems WHERE list_state IN ('open', 'falsifiable', 'verifiable', 'decidable')
         AND (checked_at IS NULL OR checked_at < ?2)
       ORDER BY checked_at IS NOT NULL, checked_at LIMIT ?1`,
    )
    .bind(limit, now - 20 * 3_600_000)
    .all<{ problem: string; fc_state: string | null }>();
  let newlySolved = 0;
  for (const row of results) {
    await db.prepare("UPDATE formal_problems SET checked_at = ?2 WHERE problem = ?1").bind(row.problem, now).run();
    const res = await fetch(FORMAL_MAIN(row.problem), { headers: { "user-agent": userAgent }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) continue;
    const { state, statement } = readLean(await res.text(), row.problem);
    if (!state) continue;
    await db.prepare("UPDATE formal_problems SET fc_state = ?2, note = ?3 WHERE problem = ?1").bind(row.problem, state, statement).run();
    if (state === "solved") await claimForSolvedElsewhere(db, row.problem, now);
    if (row.fc_state && row.fc_state !== state && state === "solved") {
      newlySolved++;
      await logEvent(db, null, "upstream", null, `formal-conjectures now marks Erdős problem #${row.problem} as solved; the problem list still says open`);
    }
  }
  return newlySolved;
}

export interface Disagreement {
  problem: string;
  list_state: string;
  note: string | null;
  checked_at: number;
  claim_id: string | null;
}

export async function disagreements(db: D1Database): Promise<Disagreement[]> {
  const { results } = await db
    .prepare(
      `SELECT f.problem, f.list_state, f.note, f.checked_at,
         (SELECT c.id FROM claims c WHERE c.problem = f.problem AND c.status = 'visible' LIMIT 1) AS claim_id
       FROM formal_problems f
       WHERE f.fc_state = 'solved' AND f.list_state IN ('open', 'falsifiable', 'verifiable', 'decidable')
       ORDER BY CAST(f.problem AS INTEGER) LIMIT 300`,
    )
    .all<Disagreement>();
  return results;
}

export const formalPage = (n: string) => `https://github.com/google-deepmind/formal-conjectures/blob/main/FormalConjectures/ErdosProblems/${n}.lean`;

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
  await db.batch(fresh.map(({ n, info }) => claimInsert(db, invId, n, info!.formalized, now)));
  return { added: fresh.length, covered: [...covered, ...fresh.map((p) => p.n)] };
}

function claimInsert(db: D1Database, invId: string, n: string, formalized: boolean, now: number): D1PreparedStatement {
  const origin = formalized ? lean(n) : `https://www.erdosproblems.com/${n}`;
  const where = formalized ? `(theorem erdos_${n} in formal-conjectures)` : `(as stated at erdosproblems.com/${n})`;
  const text = `A published paper or arXiv preprint answers the main question of Erdős Problem #${n} ${where} in full (proof, disproof, or the exact value asked for) with no hypotheses beyond the problem's own.`;
  return db
    .prepare("INSERT OR IGNORE INTO claims (id, investigation_id, text, text_key, created_by, created_at, origin_url, problem) VALUES (?1, ?2, ?3, ?4, 'system', ?5, ?6, ?7)")
    .bind(`clm_erdos${n}x${now.toString(36).slice(-4)}`, invId, text, `erdos problem ${n} literature check`, now, origin, n);
}

export const FORMAL_BRIEF =
  "google-deepmind/formal-conjectures marks these Erdős problems as solved while the Erdős problems list still says open. For each, find the published paper " +
  "or arXiv preprint that answers the main statement, if one exists: formal-conjectures' own note on the problem often cites it. A Lean proof or an announcement " +
  "with no paper is a note, not support. Support a claim only with a quote of a theorem that answers the main statement in full, with the same quantifiers, " +
  "ranges and constants; bounds, special cases and variants are notes. formal-conjectures, GitHub, Wikipedia, MathWorld and erdosproblems.com do not count " +
  "as evidence. Every note names the paper (authors, year, arXiv id or DOI). Nothing is posted to other sites, and results stay candidate references until a " +
  "mathematician reads them.";

// A problem formal-conjectures calls solved while the list says open is a ready-made literature check:
// the paper behind it, if any, is the evidence the list's maintainers would want.
export async function claimForSolvedElsewhere(db: D1Database, n: string, now = Date.now()): Promise<boolean> {
  if (await claimFor(db, n)) return false;
  const title = "Erdős problems that formal-conjectures marks solved";
  const existing = await db.prepare("SELECT id FROM investigations WHERE title = ?1 AND status = 'open'").bind(title).first<{ id: string }>();
  const invId = existing?.id ?? (await createInvestigation(db, null, title, FORMAL_BRIEF, [], null, now, { excludeDomains: EXCLUDE, verdictCap: "candidate" }));
  const r = await claimInsert(db, invId, n, true, now).run();
  if (!r.meta.changes) return false;
  // The list's state is already known from the scan; the daily read would leave it blank until then.
  await db.prepare("UPDATE claims SET upstream_state = (SELECT list_state FROM formal_problems WHERE problem = ?1) WHERE problem = ?1 AND upstream_state IS NULL").bind(n).run();
  return true;
}
