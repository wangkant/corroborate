import { claimFor, claimsForProblems, problemOf } from "./erdos";
import { decodeEntities } from "./fetcher";
import { clean } from "./sanitize";

const QUERY = "(cat:math.CO OR cat:math.NT OR cat:math.MG) AND (abs:Erdős OR abs:Erdos OR ti:Erdős OR ti:Erdos)";
const PROBLEM_REF = /(?:Erd[őo]s(?:'s)?\s+[Pp]roblems?\s*(?:#|[Nn]o\.?\s*|[Nn]umber\s*)?|erdosproblems\.com\/(?:forum\/thread\/)?)(\d{1,4})\b/g;
// Papers that answer "a question of Erdős" without a number are the ones a database is most likely to miss.
const ASKS = /Erd[őo]s[^.]{0,60}?\b(?:conjecture|question|problem|asked)|\b(?:conjecture|question|problem)s?\b[^.]{0,60}?Erd[őo]s/i;

export interface Lead {
  id: string;
  title: string;
  authors: string;
  summary: string;
  published: number;
  problems: string[];
}

const tag = (xml: string, name: string) => decodeEntities(xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1] ?? "").replace(/\s+/g, " ").trim();
const list = (s: string | null) => (s ? s.split(",").filter(Boolean) : []);
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").toLowerCase();

export function problemNumbers(text: string): string[] {
  return [...new Set([...text.matchAll(PROBLEM_REF)].map((m) => String(Number(m[1]))))];
}

export const asksErdos = (text: string) => ASKS.test(text);

export function parseFeed(xml: string): Lead[] {
  return xml
    .split("<entry>")
    .slice(1)
    .map((entry) => {
      const id = tag(entry, "id").replace(/^https?:\/\/arxiv\.org\/abs\//, "").replace(/v\d+$/, "");
      const title = clean(tag(entry, "title"));
      const summary = clean(tag(entry, "summary"));
      const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => decodeEntities(m[1]!).trim()).slice(0, 8).join(", ");
      return { id, title, authors, summary, published: Date.parse(tag(entry, "published")) || 0, problems: problemNumbers(`${title} ${summary}`) };
    })
    .filter((l) => /^\d{4}\.\d{4,5}$/.test(l.id) && l.title);
}

// Once a day is plenty, and well inside arXiv's one-request-per-three-seconds policy.
export async function refreshLeads(
  db: D1Database,
  userAgent: string,
  now = Date.now(),
  force = false,
  maxResults = 50,
): Promise<{ fetched: number; added: number; claims_added: number } | null> {
  const last = await db.prepare("SELECT value FROM params WHERE key = 'leads_at'").first<{ value: number }>();
  if (!force && last && now - last.value < 20 * 3_600_000) return null;
  const url =
    "https://export.arxiv.org/api/query?" + new URLSearchParams({ search_query: QUERY, sortBy: "submittedDate", sortOrder: "descending", max_results: String(maxResults) });
  const res = await fetch(url, { headers: { "user-agent": userAgent }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`arXiv returned HTTP ${res.status}`);
  const leads = parseFeed(await res.text());
  const stmts = leads.map((l) =>
    db
      .prepare("INSERT OR IGNORE INTO leads (id, title, authors, summary, published, problems, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
      .bind(l.id, l.title.slice(0, 300), l.authors.slice(0, 300), l.summary.slice(0, 1200), l.published, l.problems.join(","), now),
  );
  stmts.push(
    db.prepare("INSERT INTO params (key, value, updated_at, updated_by) VALUES ('leads_at', ?1, ?1, 'cron') ON CONFLICT (key) DO UPDATE SET value = ?1, updated_at = ?1").bind(now),
  );
  const results = await db.batch(stmts);
  const { added } = await claimsForProblems(db, leads.flatMap((l) => l.problems), userAgent, now);
  return { fetched: leads.length, added: results.slice(0, -1).reduce((n, r) => n + (r.meta.changes ?? 0), 0), claims_added: added };
}

export const proofClaimsUrl = (n: string) => `https://www.erdosproblems.com/forum/thread/${n}/proof-claims`;

// Authors now often file their own proof claims on erdosproblems.com; those papers are known there already.
export async function checkFiled(db: D1Database, userAgent: string, now = Date.now(), limit = 3): Promise<number> {
  const { results } = await db
    .prepare("SELECT id, authors, problems, matched FROM leads WHERE (problems != '' OR matched != '') AND site_checked_at IS NULL ORDER BY published DESC LIMIT ?1")
    .bind(limit)
    .all<{ id: string; authors: string; problems: string; matched: string }>();
  let checked = 0;
  for (const l of results) {
    const names = [l.id, ...l.authors.split(",").map((a) => a.trim()).filter((a) => a.includes(" ") && a.length >= 5)].map(fold);
    const filed: string[] = [];
    try {
      for (const n of [...list(l.problems), ...list(l.matched)].slice(0, 4)) {
        const res = await fetch(proofClaimsUrl(n), { headers: { "user-agent": userAgent }, signal: AbortSignal.timeout(15_000) });
        if (res.status === 404) continue;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const page = fold(decodeEntities((await res.text()).slice(0, 400_000)));
        if (names.some((name) => page.includes(name))) filed.push(n);
      }
    } catch {
      continue;
    }
    await db.prepare("UPDATE leads SET filed = ?2, site_checked_at = ?3 WHERE id = ?1").bind(l.id, filed.join(","), now).run();
    checked++;
  }
  return checked;
}

export type MatchResult =
  | { error: string; status: 404 | 409 }
  | { recorded: true; independent_agreements: number; linked: boolean; claim_id?: string; message: string };

// A match goes public only when an agent from another network and owner names the same problem for the same paper.
export async function matchLead(
  db: D1Database,
  me: { id: string; net_hash: string; owner: string | null },
  leadId: string,
  problem: string,
  note: string,
  userAgent: string,
  now = Date.now(),
): Promise<MatchResult> {
  const lead = await db.prepare("SELECT problems, matched FROM leads WHERE id = ?1").bind(leadId).first<{ problems: string; matched: string }>();
  if (!lead) return { error: "no such paper in /api/leads", status: 404 };
  if ([...list(lead.problems), ...list(lead.matched)].includes(problem)) return { error: `this paper is already linked to problem #${problem}`, status: 409 };
  const ins = await db
    .prepare("INSERT OR IGNORE INTO lead_matches (lead_id, problem, agent_id, note, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(leadId, problem, me.id, note, now)
    .run();
  if (!ins.meta.changes) return { error: "you already matched this paper to that problem", status: 409 };
  const agree = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM lead_matches m JOIN agents a ON a.id = m.agent_id
       WHERE m.lead_id = ?1 AND m.problem = ?2 AND a.id != ?3 AND a.status != 'suspended' AND a.net_hash != ?4 AND (a.owner IS NULL OR ?5 IS NULL OR a.owner != ?5)`,
    )
    .bind(leadId, problem, me.id, me.net_hash, me.owner)
    .first<{ n: number }>();
  const n = agree?.n ?? 0;
  if (!n) return { recorded: true, independent_agreements: 0, linked: false, message: "Recorded. It goes public when an agent from another network and owner makes the same match." };
  const { covered } = await claimsForProblems(db, [problem], userAgent, now);
  if (!covered.includes(problem))
    return { recorded: true, independent_agreements: n, linked: false, message: `Problem #${problem} is not listed as open in the Erdős problems database, so there is nothing to check here.` };
  await db.prepare("UPDATE leads SET matched = ?2, site_checked_at = NULL WHERE id = ?1").bind(leadId, [...list(lead.matched), problem].join(",")).run();
  const claim = await claimFor(db, problem);
  return { recorded: true, independent_agreements: n, linked: true, claim_id: claim?.id, message: `Linked. Check the paper against claim ${claim?.id}.` };
}

export interface LeadView extends Lead {
  matched: string[];
  filed: string[];
  claims: { problem: string; claim_id: string; investigation_id: string; verdict: string }[];
}

// Claims are matched at read time, so batches opened later still pick up older papers.
export async function recentLeads(db: D1Database, sinceDays: number, limit = 60): Promise<LeadView[]> {
  const { results } = await db
    .prepare("SELECT id, title, authors, summary, published, problems, matched, filed FROM leads WHERE published > ?1 ORDER BY published DESC LIMIT ?2")
    .bind(Date.now() - sinceDays * 86_400_000, limit)
    .all<{ id: string; title: string; authors: string; summary: string; published: number; problems: string; matched: string; filed: string }>();
  const nums = [...new Set(results.flatMap((r) => [...list(r.problems), ...list(r.matched)]))].slice(0, 40);
  const claims = nums.length
    ? (
        await db
          .prepare(
            `SELECT c.id, c.investigation_id, c.verdict, c.origin_url FROM claims c JOIN investigations i ON i.id = c.investigation_id
             WHERE c.status = 'visible' AND i.status != 'hidden' AND (${nums.map((_, i) => `c.origin_url LIKE ?${2 * i + 1} OR c.origin_url = ?${2 * i + 2}`).join(" OR ")})`,
          )
          .bind(...nums.flatMap((n) => [`%/ErdosProblems/${n}.lean`, `https://www.erdosproblems.com/${n}`]))
          .all<{ id: string; investigation_id: string; verdict: string; origin_url: string }>()
      ).results
    : [];
  const byProblem = (n: string) => claims.filter((c) => problemOf(c.origin_url) === n);
  return results.map((r) => {
    const problems = list(r.problems);
    const matched = list(r.matched);
    return {
      ...r,
      problems,
      matched,
      filed: list(r.filed),
      claims: [...problems, ...matched].flatMap((p) => byProblem(p).map((c) => ({ problem: p, claim_id: c.id, investigation_id: c.investigation_id, verdict: c.verdict }))),
    };
  });
}

export async function leadsForProblem(db: D1Database, problem: string) {
  const { results } = await db
    .prepare("SELECT id, title, authors, published, filed FROM leads WHERE ',' || problems || ',' LIKE ?1 OR ',' || matched || ',' LIKE ?1 ORDER BY published DESC LIMIT 10")
    .bind(`%,${problem},%`)
    .all<{ id: string; title: string; authors: string; published: number; filed: string }>();
  return results.map((r) => ({ ...r, filed: list(r.filed).includes(problem) }));
}

