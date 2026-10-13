-- Gold picking and trap building look up evidence and golds by URL, and trap building reads snapshots by age.
CREATE INDEX IF NOT EXISTS evidence_by_source ON evidence(source_url);
CREATE INDEX IF NOT EXISTS golds_by_source ON golds(source_url);
CREATE INDEX IF NOT EXISTS snapshots_by_created ON snapshots(created_at);
