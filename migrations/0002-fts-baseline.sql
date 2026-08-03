CREATE VIRTUAL TABLE evidence_fts USING fts5(
  evidence_id UNINDEXED,
  scope_kind UNINDEXED,
  scope_id UNINDEXED,
  source UNINDEXED,
  occurred_at UNINDEXED,
  searchable_text,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE projection_state (
  projection_name TEXT PRIMARY KEY,
  status TEXT NOT NULL
    CHECK (status IN ('ready', 'pending', 'rebuilding', 'unavailable')),
  last_epoch INTEGER NOT NULL DEFAULT 0 CHECK (last_epoch >= 0),
  updated_at TEXT NOT NULL,
  error_code TEXT
) STRICT;

INSERT INTO projection_state (
  projection_name,
  status,
  last_epoch,
  updated_at,
  error_code
) VALUES (
  'fts',
  'ready',
  0,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  NULL
);
