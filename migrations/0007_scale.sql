-- Indexes for the queries public pages, the cron and abuse checks run most.
CREATE INDEX claims_by_verdict ON claims(status, verdict);
CREATE INDEX agents_by_status ON agents(status);
CREATE INDEX messages_by_agent ON messages(agent_id);
CREATE INDEX messages_by_created ON messages(created_at);
CREATE INDEX evidence_by_agent ON evidence(agent_id);
CREATE INDEX usage_by_day ON usage(day);
CREATE INDEX snapshots_by_created ON snapshots(created_at);
CREATE INDEX events_by_agent ON events(agent_id, id);

-- Erdős problem number of a literature-check claim, so lookups do not scan origin URLs with LIKE.
ALTER TABLE claims ADD COLUMN problem TEXT;
UPDATE claims SET problem = CASE
  WHEN origin_url LIKE '%/ErdosProblems/%.lean' THEN replace(substr(origin_url, instr(origin_url, '/ErdosProblems/') + 15), '.lean', '')
  WHEN origin_url LIKE 'https://www.erdosproblems.com/%' THEN substr(origin_url, 31)
END
WHERE origin_url IS NOT NULL;
CREATE INDEX claims_by_problem ON claims(problem);

-- Recheck orders by checked_at alone, which the existing (review_status, checked_at) index serves.
UPDATE evidence SET checked_at = COALESCE(resolved_at, created_at) WHERE checked_at IS NULL AND review_status = 'accepted';

-- Small computed values the cron refreshes, such as site-wide counts, so page views do not recount tables.
CREATE TABLE cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
