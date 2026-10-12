import { claimsForNamedProblems, problemOf } from "./erdos";
import { decodeEntities } from "./fetcher";
import { clean } from "./sanitize";

const QUERY = "(cat:math.CO OR cat:math.NT OR cat:math.MG) AND (abs:Erdős OR abs:Erdos OR ti:Erdős OR ti:Erdos)";
const PROBLEM_REF = /(?:Erd[őo]s(?:'s)?\s+[Pp]roblems?\s*(?:#|[Nn]o\.?\s*|[Nn]umber\s*)?|erdosproblems\.com\/(?:forum\/thread\/)?)(\d{1,4})\b/g;

export interface Lead {
  id: string;
  title: string;
  authors: string;
  summary: string;
  published: number;
  problems: string[];
}

const tag = (xml: string, name: string) => decodeEntities(xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1] ?? "").replace(/\s+/g, " ").trim();

export function problemNumbers(text: string): string[] {
  return [...new Set([...text.matchAll(PROBLEM_REF)].map((m) => String(Number(m[1]))))];
}

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
  const claimsAdded = await claimsForNamedProblems(db, leads.flatMap((l) => l.problems), userAgent, now);
  return { fetched: leads.length, added: results.slice(0, -1).reduce((n, r) => n + (r.meta.changes ?? 0), 0), claims_added: claimsAdded };
}

export interface LeadView extends Lead {
  claims: { problem: string; claim_id: string; investigation_id: string; verdict: string }[];
}

// Claims are matched at read time, so batches opened later still pick up older papers.
export async function recentLeads(db: D1Database, sinceDays: number, limit = 60): Promise<LeadView[]> {
  const { results } = await db
    .prepare("SELECT id, title, authors, summary, published, problems FROM leads WHERE published > ?1 ORDER BY published DESC LIMIT ?2")
    .bind(Date.now() - sinceDays * 86_400_000, limit)
    .all<{ id: string; title: string; authors: string; summary: string; published: number; problems: string }>();
  const nums = [...new Set(results.flatMap((r) => (r.problems ? r.problems.split(",") : [])))].slice(0, 40);
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
    const problems = r.problems ? r.problems.split(",") : [];
    return {
      ...r,
      problems,
      claims: problems.flatMap((p) => byProblem(p).map((c) => ({ problem: p, claim_id: c.id, investigation_id: c.investigation_id, verdict: c.verdict }))),
    };
  });
}
