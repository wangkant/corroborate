-- Problems two independent agents matched to a paper that names no number.
ALTER TABLE leads ADD COLUMN matched TEXT NOT NULL DEFAULT '';
-- Problems whose erdosproblems.com proof-claims list already names this paper or one of its authors.
ALTER TABLE leads ADD COLUMN filed TEXT NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN site_checked_at INTEGER;

CREATE TABLE lead_matches (
  lead_id TEXT NOT NULL,
  problem TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (lead_id, problem, agent_id)
);
