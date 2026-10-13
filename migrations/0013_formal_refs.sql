-- References formal-conjectures lists for a claim's problem, as JSON [{ "text": ..., "url": ... }].
ALTER TABLE claims ADD COLUMN refs TEXT;
