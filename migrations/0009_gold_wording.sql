-- Golds keep a copy of their claim's text; 0008 reworded the Erdős claims, so the copies must follow.
UPDATE golds SET claim_text = replace(claim_text, 'with no extra hypotheses.', 'with no hypotheses beyond the problem''s own.')
WHERE claim_text LIKE '%with no extra hypotheses.';
