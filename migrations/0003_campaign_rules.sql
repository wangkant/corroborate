-- Comma-separated registrable domains an investigation will not accept as evidence (circular or too weak for it).
ALTER TABLE investigations ADD COLUMN exclude_domains TEXT NOT NULL DEFAULT '';
-- 'candidate' keeps every claim below "supported": findings stay leads for a human expert to check.
ALTER TABLE investigations ADD COLUMN verdict_cap TEXT NOT NULL DEFAULT '';
