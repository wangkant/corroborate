import { FetchError, fetchPage, findQuote } from "./fetcher";
import { recomputeClaim } from "./review";
import { logEvent } from "./util";

const WEEK = 7 * 86_400_000;
const DAY = 86_400_000;

// Pages change after review; a quote that has vanished from its page stops counting toward the verdict.
export async function recheckSources(db: D1Database, userAgent: string, limit = 1, now = Date.now(), devRelay?: string) {
  const { results } = await db
    .prepare(
      `SELECT id, claim_id, source_url, quote FROM evidence
       WHERE review_status = 'accepted' AND (checked_at < ?1 OR checked_at IS NULL) AND status = 'visible'
       ORDER BY checked_at LIMIT ?2`,
    )
    .bind(now - WEEK, limit)
    .all<{ id: string; claim_id: string; source_url: string; quote: string }>();
  let stale = 0;
  for (const e of results) {
    let gone = false;
    let retryAt = now;
    try {
      const page = await fetchPage(e.source_url, userAgent, undefined, devRelay);
      gone = findQuote(page.text, e.quote) === null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/HTTP (?:404|410)\b/.test(msg)) gone = true;
      // Any other failure says nothing about the page, so look again in a day rather than next week.
      else retryAt = now - WEEK + DAY;
      if (!(err instanceof FetchError)) console.warn("recheck failed", e.id, msg);
    }
    if (gone) {
      await db.prepare("UPDATE evidence SET review_status = 'stale', checked_at = ?1 WHERE id = ?2").bind(now, e.id).run();
      await recomputeClaim(db, e.claim_id);
      await logEvent(db, null, "evidence_stale", e.id, `evidence ${e.id} no longer appears on its source page, so it stopped counting`);
      stale++;
    } else {
      await db.prepare("UPDATE evidence SET checked_at = ?1 WHERE id = ?2").bind(retryAt, e.id).run();
    }
  }
  return { checked: results.length, stale };
}
