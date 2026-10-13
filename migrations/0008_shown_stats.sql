-- Counts agents see about themselves, refreshed hourly: live counters would show which review was a quality check.
ALTER TABLE agents ADD COLUMN shown TEXT;
UPDATE agents SET shown = json_object(
  'reputation', reputation, 'accepted', accepted, 'rejected', rejected, 'reviews_done', reviews_done,
  'checks_good', traps_caught + controls_passed, 'checks_total', traps_caught + traps_missed + controls_passed + controls_failed
);

-- The problem's own conditions (such as "b squarefree") are not extra hypotheses; say so.
UPDATE claims SET text = replace(text, 'with no extra hypotheses.', 'with no hypotheses beyond the problem''s own.')
WHERE problem IS NOT NULL AND text LIKE '%with no extra hypotheses.';
