CREATE TABLE vector_projection_write_guard (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  operation TEXT NOT NULL,
  opened_at TEXT NOT NULL
) STRICT;

CREATE TABLE vector_embedding_epochs (
  epoch_id TEXT PRIMARY KEY
    CHECK (
      length(epoch_id) = 71
      AND substr(epoch_id, 1, 7) = 'sha256:'
      AND substr(epoch_id, 8) NOT GLOB '*[^0-9a-f]*'
    ),
  epoch_json TEXT NOT NULL CHECK (json_valid(epoch_json)),
  registered_at TEXT NOT NULL
) STRICT;

CREATE TABLE vector_runtime_configuration (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  mode TEXT NOT NULL
    CHECK (mode IN ('disabled', 'evaluating', 'enabled')),
  desired_epoch_id TEXT REFERENCES vector_embedding_epochs(epoch_id),
  configured_at TEXT NOT NULL,
  CHECK (
    (mode = 'disabled' AND desired_epoch_id IS NULL)
    OR
    (mode IN ('evaluating', 'enabled') AND desired_epoch_id IS NOT NULL)
  )
) STRICT;

INSERT INTO vector_runtime_configuration (
  singleton, mode, desired_epoch_id, configured_at
) VALUES (1, 'disabled', NULL, '1970-01-01T00:00:00.000Z');

CREATE TABLE vector_projection_scope_state (
  principal_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL
    CHECK (
      scope_kind IN (
        'thread', 'topic', 'scenario', 'user', 'workspace', 'agent'
      )
    ),
  scope_id TEXT NOT NULL,
  desired_epoch_id TEXT NOT NULL
    REFERENCES vector_embedding_epochs(epoch_id),
  active_epoch_id TEXT REFERENCES vector_embedding_epochs(epoch_id),
  desired_generation_id TEXT NOT NULL,
  active_generation_id TEXT,
  state TEXT NOT NULL
    CHECK (
      state IN (
        'disabled', 'pending', 'building', 'quarantined',
        'published', 'degraded'
      )
    ),
  ledger_epoch INTEGER NOT NULL CHECK (ledger_epoch >= 0),
  tombstone_epoch INTEGER NOT NULL CHECK (tombstone_epoch >= 0),
  source_frontier_hash TEXT NOT NULL
    CHECK (
      length(source_frontier_hash) = 71
      AND substr(source_frontier_hash, 1, 7) = 'sha256:'
      AND substr(source_frontier_hash, 8) NOT GLOB '*[^0-9a-f]*'
    ),
  next_validity_transition_at TEXT,
  logical_digest TEXT
    CHECK (
      logical_digest IS NULL
      OR (
        length(logical_digest) = 71
        AND substr(logical_digest, 1, 7) = 'sha256:'
        AND substr(logical_digest, 8) NOT GLOB '*[^0-9a-f]*'
      )
    ),
  last_job_id TEXT,
  failure_category TEXT
    CHECK (
      failure_category IS NULL
      OR failure_category IN (
        'MODEL_MISSING', 'MODEL_IDENTITY_MISMATCH',
        'DEPENDENCY_UNAVAILABLE', 'INDEX_MISSING', 'INDEX_LOCKED',
        'INDEX_CORRUPT', 'EPOCH_STALE', 'FRONTIER_STALE',
        'REBUILDING', 'PROCESS_TIMEOUT', 'PROCESS_EXIT',
        'PROTOCOL_INVALID', 'RESOURCE_LIMIT'
      )
    ),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, scope_kind, scope_id),
  CHECK (
    state <> 'published'
    OR (
      active_epoch_id = desired_epoch_id
      AND active_generation_id = desired_generation_id
      AND logical_digest IS NOT NULL
      AND failure_category IS NULL
    )
  ),
  CHECK (
    (state = 'degraded') = (failure_category IS NOT NULL)
  )
) STRICT;

CREATE INDEX vector_projection_scope_state_status
  ON vector_projection_scope_state (
    state, principal_id, scope_kind, scope_id
  );

CREATE INDEX vector_projection_scope_state_temporal
  ON vector_projection_scope_state (
    next_validity_transition_at, state, principal_id, scope_kind, scope_id
  );

CREATE TABLE vector_projection_outbox_jobs (
  job_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL
    CHECK (
      scope_kind IN (
        'thread', 'topic', 'scenario', 'user', 'workspace', 'agent'
      )
    ),
  scope_id TEXT NOT NULL,
  reason TEXT NOT NULL
    CHECK (
      reason IN (
        'enable', 'canonical_change', 'temporal_transition',
        'epoch_change', 'purge', 'rebuild', 'recovery'
      )
    ),
  desired_epoch_id TEXT NOT NULL
    REFERENCES vector_embedding_epochs(epoch_id),
  desired_generation_id TEXT NOT NULL,
  source_frontier_hash TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (
      status IN (
        'pending', 'processing', 'applied', 'failed',
        'stale', 'purged', 'disabled'
      )
    ),
  attempts INTEGER NOT NULL CHECK (attempts BETWEEN 0 AND 32),
  available_at TEXT NOT NULL,
  claimed_by TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  failure_category TEXT
    CHECK (
      failure_category IS NULL
      OR failure_category IN (
        'MODEL_MISSING', 'MODEL_IDENTITY_MISMATCH',
        'DEPENDENCY_UNAVAILABLE', 'INDEX_MISSING', 'INDEX_LOCKED',
        'INDEX_CORRUPT', 'EPOCH_STALE', 'FRONTIER_STALE',
        'REBUILDING', 'PROCESS_TIMEOUT', 'PROCESS_EXIT',
        'PROTOCOL_INVALID', 'RESOURCE_LIMIT'
      )
    ),
  CHECK (
    status <> 'processing'
    OR (
      claimed_by IS NOT NULL
      AND lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL
    )
  )
) STRICT;

CREATE INDEX vector_projection_outbox_claim
  ON vector_projection_outbox_jobs (status, available_at, job_id);

CREATE INDEX vector_projection_outbox_scope
  ON vector_projection_outbox_jobs (
    principal_id, scope_kind, scope_id, status, job_id
  );

CREATE UNIQUE INDEX vector_projection_outbox_one_pending_scope
  ON vector_projection_outbox_jobs (
    principal_id, scope_kind, scope_id
  )
  WHERE status = 'pending';

CREATE TABLE vector_projection_receipts (
  receipt_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL
    REFERENCES vector_projection_outbox_jobs(job_id),
  principal_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  outcome TEXT NOT NULL
    CHECK (
      outcome IN ('published', 'stale', 'failed', 'purged', 'disabled')
    ),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  receipt_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX vector_projection_receipts_job
  ON vector_projection_receipts (job_id, created_at, receipt_id);

CREATE TRIGGER vector_embedding_epochs_no_update
BEFORE UPDATE ON vector_embedding_epochs BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:vector_embedding_epochs');
END;

CREATE TRIGGER vector_embedding_epochs_no_delete
BEFORE DELETE ON vector_embedding_epochs BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:vector_embedding_epochs');
END;

CREATE TRIGGER vector_runtime_configuration_guarded_update
BEFORE UPDATE ON vector_runtime_configuration
WHEN NOT EXISTS (
  SELECT 1 FROM vector_projection_write_guard WHERE singleton = 1
)
BEGIN
  SELECT RAISE(ABORT, 'VECTOR_PROJECTION_TRANSACTION_REQUIRED');
END;

CREATE TRIGGER vector_projection_scope_state_guarded_insert
BEFORE INSERT ON vector_projection_scope_state
WHEN NOT EXISTS (
  SELECT 1 FROM vector_projection_write_guard WHERE singleton = 1
)
BEGIN
  SELECT RAISE(ABORT, 'VECTOR_PROJECTION_TRANSACTION_REQUIRED');
END;

CREATE TRIGGER vector_projection_scope_state_guarded_update
BEFORE UPDATE ON vector_projection_scope_state
WHEN NOT EXISTS (
  SELECT 1 FROM vector_projection_write_guard WHERE singleton = 1
)
OR NEW.principal_id <> OLD.principal_id
OR NEW.scope_kind <> OLD.scope_kind
OR NEW.scope_id <> OLD.scope_id
OR NEW.ledger_epoch < OLD.ledger_epoch
OR NEW.tombstone_epoch < OLD.tombstone_epoch
BEGIN
  SELECT RAISE(ABORT, 'VECTOR_PROJECTION_TRANSACTION_REQUIRED');
END;

CREATE TRIGGER vector_projection_scope_state_no_delete
BEFORE DELETE ON vector_projection_scope_state BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:vector_projection_scope_state');
END;

CREATE TRIGGER vector_projection_outbox_guarded_insert
BEFORE INSERT ON vector_projection_outbox_jobs
WHEN NOT EXISTS (
  SELECT 1 FROM vector_projection_write_guard WHERE singleton = 1
)
BEGIN
  SELECT RAISE(ABORT, 'VECTOR_PROJECTION_TRANSACTION_REQUIRED');
END;

CREATE TRIGGER vector_projection_outbox_guarded_update
BEFORE UPDATE ON vector_projection_outbox_jobs
WHEN NOT EXISTS (
  SELECT 1 FROM vector_projection_write_guard WHERE singleton = 1
)
OR NEW.job_id <> OLD.job_id
OR NEW.principal_id <> OLD.principal_id
OR NEW.scope_kind <> OLD.scope_kind
OR NEW.scope_id <> OLD.scope_id
OR NEW.reason <> OLD.reason
OR NEW.desired_epoch_id <> OLD.desired_epoch_id
OR NEW.desired_generation_id <> OLD.desired_generation_id
OR NEW.source_frontier_hash <> OLD.source_frontier_hash
OR NEW.attempts < OLD.attempts
BEGIN
  SELECT RAISE(ABORT, 'VECTOR_PROJECTION_TRANSACTION_REQUIRED');
END;

CREATE TRIGGER vector_projection_outbox_no_delete
BEFORE DELETE ON vector_projection_outbox_jobs BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:vector_projection_outbox_jobs');
END;

CREATE TRIGGER vector_projection_receipts_guarded_insert
BEFORE INSERT ON vector_projection_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM vector_projection_write_guard WHERE singleton = 1
)
BEGIN
  SELECT RAISE(ABORT, 'VECTOR_PROJECTION_TRANSACTION_REQUIRED');
END;

CREATE TRIGGER vector_projection_receipts_no_update
BEFORE UPDATE ON vector_projection_receipts BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:vector_projection_receipts');
END;

CREATE TRIGGER vector_projection_receipts_no_delete
BEFORE DELETE ON vector_projection_receipts BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:vector_projection_receipts');
END;
