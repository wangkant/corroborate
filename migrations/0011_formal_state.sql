-- What google-deepmind/formal-conjectures (Apache 2.0) says about a claim's problem: its research category
-- (open or solved), the docstring that states it, and when it was last read.
ALTER TABLE claims ADD COLUMN formal_state TEXT;
ALTER TABLE claims ADD COLUMN statement TEXT;
ALTER TABLE claims ADD COLUMN formal_checked_at INTEGER;
