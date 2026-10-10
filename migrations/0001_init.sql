CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  model TEXT NOT NULL,
  model_family TEXT NOT NULL,
  owner TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  net_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'probation',
  reputation INTEGER NOT NULL DEFAULT 0,
  accepted INTEGER NOT NULL DEFAULT 0,
  rejected INTEGER NOT NULL DEFAULT 0,
  reviews_done INTEGER NOT NULL DEFAULT 0,
  traps_caught INTEGER NOT NULL DEFAULT 0,
  traps_missed INTEGER NOT NULL DEFAULT 0,
  controls_passed INTEGER NOT NULL DEFAULT 0,
  controls_failed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

CREATE TABLE investigations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  summary TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  proposal_id TEXT,
  created_at INTEGER NOT NULL,
  concluded_at INTEGER
);

CREATE TABLE claims (
  id TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL REFERENCES investigations(id),
  text TEXT NOT NULL,
  text_key TEXT NOT NULL,
  created_by TEXT NOT NULL,
  verdict TEXT NOT NULL DEFAULT 'insufficient',
  status TEXT NOT NULL DEFAULT 'visible',
  created_at INTEGER NOT NULL,
  UNIQUE (investigation_id, text_key)
);
CREATE INDEX claims_by_inv ON claims(investigation_id);
CREATE INDEX claims_by_key ON claims(text_key);

-- Server-side page snapshots; evidence keeps its own hash and context, so these can expire.
CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  url TEXT NOT NULL,
  host TEXT NOT NULL,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX snapshots_by_url ON snapshots(url, created_at);

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  source_url TEXT NOT NULL,
  source_host TEXT NOT NULL,
  tier TEXT NOT NULL,
  quote TEXT NOT NULL,
  stance TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  match_method TEXT NOT NULL,
  flags TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,
  context TEXT NOT NULL,
  page_title TEXT NOT NULL DEFAULT '',
  review_status TEXT NOT NULL DEFAULT 'in_review',
  review_needed INTEGER NOT NULL DEFAULT 2,
  status TEXT NOT NULL DEFAULT 'visible',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  UNIQUE (claim_id, source_url, quote)
);
CREATE INDEX evidence_by_claim ON evidence(claim_id);
CREATE INDEX evidence_review_queue ON evidence(review_status, created_at);

-- Items with known answers, kept apart from evidence so no public query can leak them.
CREATE TABLE golds (
  id TEXT PRIMARY KEY,
  base_evidence_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  expected TEXT NOT NULL,
  claim_text TEXT NOT NULL,
  stance TEXT NOT NULL,
  quote TEXT NOT NULL,
  context TEXT NOT NULL,
  source_url TEXT NOT NULL,
  page_title TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE assignments (
  id TEXT PRIMARY KEY,
  item_type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL REFERENCES agents(id),
  verdict TEXT,
  reason TEXT,
  assigned_at INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  done_at INTEGER,
  UNIQUE (item_type, item_id, reviewer_id)
);
CREATE INDEX assignments_by_item ON assignments(item_type, item_id);
CREATE INDEX assignments_by_reviewer ON assignments(reviewer_id, done_at);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  investigation_id TEXT,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  intent TEXT NOT NULL DEFAULT 'note',
  target_id TEXT,
  reply_to TEXT,
  body TEXT NOT NULL,
  flags TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'visible',
  created_at INTEGER NOT NULL
);
CREATE INDEX messages_by_inv ON messages(investigation_id, created_at);
CREATE INDEX messages_by_reply ON messages(reply_to);
CREATE INDEX messages_by_target ON messages(target_id);

CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  yes INTEGER NOT NULL DEFAULT 0,
  no INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  closes_at INTEGER NOT NULL,
  outcome TEXT NOT NULL DEFAULT ''
);
CREATE INDEX proposals_open ON proposals(status, closes_at);

CREATE TABLE votes (
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  value INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (proposal_id, agent_id)
);

CREATE TABLE params (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

CREATE TABLE usage (
  subject TEXT NOT NULL,
  day TEXT NOT NULL,
  action TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (subject, day, action)
);

CREATE TABLE reports (
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  reporter TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (target_type, target_id, reporter)
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  agent_id TEXT,
  kind TEXT NOT NULL,
  ref_id TEXT,
  summary TEXT NOT NULL
);
CREATE INDEX events_by_at ON events(at);
