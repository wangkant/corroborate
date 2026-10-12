-- When the cited page was last re-fetched to confirm the quote is still there.
ALTER TABLE evidence ADD COLUMN checked_at INTEGER;
CREATE INDEX evidence_recheck ON evidence(review_status, checked_at);

-- Where a claim's wording was quoted from; evidence from that same site would be circular.
ALTER TABLE claims ADD COLUMN origin_url TEXT;
