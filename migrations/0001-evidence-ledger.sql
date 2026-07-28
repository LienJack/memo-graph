CREATE TABLE ledger_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  ledger_epoch INTEGER NOT NULL DEFAULT 0 CHECK (ledger_epoch >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO ledger_state (singleton, ledger_epoch, created_at, updated_at)
VALUES (1, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE artifacts (
  content_hash TEXT PRIMARY KEY
    CHECK (length(content_hash) = 71 AND content_hash GLOB 'sha256:[0-9a-f]*'),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  media_type TEXT NOT NULL,
  relative_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE evidence_events (
  evidence_id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  scope_kind TEXT NOT NULL
    CHECK (scope_kind IN ('thread', 'topic', 'scenario', 'user', 'workspace', 'agent')),
  scope_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  actor_authority TEXT NOT NULL,
  source TEXT NOT NULL
    CHECK (source IN ('conversation_turn', 'tool_result', 'artifact', 'user_feedback', 'evaluation', 'import')),
  authority TEXT NOT NULL,
  sensitivity TEXT NOT NULL,
  payload_storage TEXT NOT NULL CHECK (payload_storage IN ('inline', 'blob')),
  payload_inline TEXT,
  payload_blob_hash TEXT REFERENCES artifacts(content_hash),
  media_type TEXT NOT NULL,
  content_hash TEXT NOT NULL
    CHECK (length(content_hash) = 71 AND content_hash GLOB 'sha256:[0-9a-f]*'),
  schema_version TEXT NOT NULL,
  CHECK (
    (payload_storage = 'inline' AND payload_inline IS NOT NULL AND payload_blob_hash IS NULL)
    OR
    (payload_storage = 'blob' AND payload_inline IS NULL AND payload_blob_hash IS NOT NULL)
  )
) STRICT;

CREATE INDEX evidence_events_scope_occurred_at
  ON evidence_events (scope_kind, scope_id, occurred_at DESC);
CREATE INDEX evidence_events_content_hash
  ON evidence_events (content_hash);

CREATE TABLE episodes (
  episode_id TEXT PRIMARY KEY,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  outcome TEXT NOT NULL
    CHECK (outcome IN ('succeeded', 'failed', 'partial', 'abandoned')),
  artifact_hashes_json TEXT NOT NULL CHECK (json_valid(artifact_hashes_json)),
  sealed_hash TEXT NOT NULL UNIQUE
    CHECK (length(sealed_hash) = 71 AND sealed_hash GLOB 'sha256:[0-9a-f]*'),
  schema_version TEXT NOT NULL
) STRICT;

CREATE TABLE episode_events (
  episode_id TEXT NOT NULL REFERENCES episodes(episode_id),
  evidence_id TEXT NOT NULL UNIQUE REFERENCES evidence_events(evidence_id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (episode_id, ordinal),
  UNIQUE (episode_id, evidence_id)
) STRICT;

CREATE TABLE mutation_receipts (
  receipt_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  receipt_hash TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  resulting_epoch INTEGER NOT NULL CHECK (resulting_epoch >= 0),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE idempotency_keys (
  idempotency_key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  receipt_id TEXT NOT NULL UNIQUE REFERENCES mutation_receipts(receipt_id),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE outbox_jobs (
  job_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  processed_at TEXT,
  last_error_code TEXT
) STRICT;

CREATE INDEX outbox_jobs_status_available_at
  ON outbox_jobs (status, available_at, job_id);

CREATE TABLE backup_manifests (
  backup_id TEXT PRIMARY KEY,
  relative_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  ledger_epoch INTEGER NOT NULL CHECK (ledger_epoch >= 0),
  latest_receipt_hash TEXT,
  migration_hashes_json TEXT NOT NULL CHECK (json_valid(migration_hashes_json)),
  blob_hashes_json TEXT NOT NULL CHECK (json_valid(blob_hashes_json)),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  integrity_check TEXT NOT NULL
) STRICT;

CREATE TRIGGER evidence_events_no_update
BEFORE UPDATE ON evidence_events BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:evidence_events');
END;

CREATE TRIGGER evidence_events_no_delete
BEFORE DELETE ON evidence_events BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:evidence_events');
END;

CREATE TRIGGER episodes_no_update
BEFORE UPDATE ON episodes BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:episodes');
END;

CREATE TRIGGER episodes_no_delete
BEFORE DELETE ON episodes BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:episodes');
END;

CREATE TRIGGER episode_events_no_update
BEFORE UPDATE ON episode_events BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:episode_events');
END;

CREATE TRIGGER episode_events_no_delete
BEFORE DELETE ON episode_events BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:episode_events');
END;

CREATE TRIGGER mutation_receipts_no_update
BEFORE UPDATE ON mutation_receipts BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:mutation_receipts');
END;

CREATE TRIGGER mutation_receipts_no_delete
BEFORE DELETE ON mutation_receipts BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:mutation_receipts');
END;

CREATE TRIGGER idempotency_keys_no_update
BEFORE UPDATE ON idempotency_keys BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:idempotency_keys');
END;

CREATE TRIGGER idempotency_keys_no_delete
BEFORE DELETE ON idempotency_keys BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:idempotency_keys');
END;
