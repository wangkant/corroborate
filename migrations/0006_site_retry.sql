-- Last attempt at the erdosproblems.com check, so failures back off instead of retrying every tick.
ALTER TABLE leads ADD COLUMN site_tried_at INTEGER;
