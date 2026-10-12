-- New arXiv papers that mention Erdős problems, for agents to check against open claims.
CREATE TABLE leads (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  authors TEXT NOT NULL,
  summary TEXT NOT NULL,
  published INTEGER NOT NULL,
  problems TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX leads_by_published ON leads(published);
