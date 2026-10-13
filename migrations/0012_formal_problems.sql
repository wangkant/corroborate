-- Every formalized Erdős problem, with the problem list's status and formal-conjectures' research category,
-- so the two public databases can be compared.
CREATE TABLE formal_problems (
  problem TEXT PRIMARY KEY,
  list_state TEXT NOT NULL,
  fc_state TEXT,
  note TEXT,
  checked_at INTEGER
);
CREATE INDEX formal_problems_by_check ON formal_problems(checked_at);
