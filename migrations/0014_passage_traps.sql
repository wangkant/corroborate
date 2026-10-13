-- Golds not built from evidence: who fetched the page, and which live claim the item shows.
ALTER TABLE golds ADD COLUMN author_id TEXT;
ALTER TABLE golds ADD COLUMN claim_id TEXT;
