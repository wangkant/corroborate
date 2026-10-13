-- The Erdős problems database's own status for a claim's problem, and when it last changed.
ALTER TABLE claims ADD COLUMN upstream_state TEXT;
ALTER TABLE claims ADD COLUMN upstream_changed_at INTEGER;
