CREATE TABLE graph_projection_write_guard (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  operation TEXT NOT NULL,
  opened_at TEXT NOT NULL
) STRICT;

CREATE TABLE graph_projection_scope_state (
  backend TEXT NOT NULL CHECK (backend = 'ladybugdb'),
  principal_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL
    CHECK (
      scope_kind IN (
        'thread', 'topic', 'scenario', 'user', 'workspace', 'agent'
      )
    ),
  scope_id TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (
      status IN (
        'disabled', 'pending', 'rebuilding', 'ready', 'unavailable'
      )
    ),
  ledger_epoch INTEGER NOT NULL CHECK (ledger_epoch >= 0),
  tombstone_epoch INTEGER NOT NULL CHECK (tombstone_epoch >= 0),
  projection_epoch INTEGER NOT NULL CHECK (projection_epoch >= 0),
  graph_projection_epoch INTEGER NOT NULL
    CHECK (graph_projection_epoch >= 0),
  frontier_json TEXT CHECK (
    frontier_json IS NULL OR json_valid(frontier_json)
  ),
  logical_digest TEXT CHECK (
    logical_digest IS NULL
    OR (
      length(logical_digest) = 71
      AND substr(logical_digest, 1, 7) = 'sha256:'
      AND substr(logical_digest, 8) NOT GLOB '*[^0-9a-f]*'
    )
  ),
  backend_identity_json TEXT CHECK (
    backend_identity_json IS NULL OR json_valid(backend_identity_json)
  ),
  updated_at TEXT NOT NULL,
  last_failure TEXT CHECK (
    last_failure IS NULL
    OR last_failure IN (
      'GRAPH_DISABLED',
      'GRAPH_OPTIONAL_DEPENDENCY_MISSING',
      'GRAPH_IDENTITY_MISMATCH',
      'GRAPH_PROCESS_START_FAILED',
      'GRAPH_PROTOCOL_INVALID',
      'GRAPH_REQUEST_LIMIT_EXCEEDED',
      'GRAPH_DEADLINE_EXCEEDED',
      'GRAPH_CHILD_EXITED',
      'GRAPH_CIRCUIT_OPEN',
      'GRAPH_STORE_LOCKED',
      'GRAPH_STORE_CORRUPT',
      'GRAPH_SCOPE_STALE',
      'GRAPH_SCOPE_PENDING',
      'GRAPH_SCOPE_REBUILDING',
      'GRAPH_DIGEST_MISMATCH',
      'GRAPH_POSTVALIDATION_FAILED',
      'GRAPH_UNKNOWN_WORK'
    )
  ),
  PRIMARY KEY (backend, principal_id, scope_kind, scope_id),
  CHECK (
    status <> 'ready'
    OR (
      frontier_json IS NOT NULL
      AND logical_digest IS NOT NULL
      AND backend_identity_json IS NOT NULL
      AND last_failure IS NULL
    )
  )
) STRICT;

CREATE INDEX graph_projection_scope_state_status
  ON graph_projection_scope_state (
    backend, status, principal_id, scope_kind, scope_id
  );

CREATE TABLE graph_projection_outbox_jobs (
  job_id TEXT PRIMARY KEY,
  operation TEXT NOT NULL
    CHECK (operation IN ('scope_replace', 'full_rebuild')),
  backend TEXT NOT NULL CHECK (backend = 'ladybugdb'),
  principal_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL
    CHECK (
      scope_kind IN (
        'thread', 'topic', 'scenario', 'user', 'workspace', 'agent'
      )
    ),
  scope_id TEXT NOT NULL,
  target_frontier_json TEXT CHECK (
    target_frontier_json IS NULL OR json_valid(target_frontier_json)
  ),
  expected_logical_digest TEXT CHECK (
    expected_logical_digest IS NULL
    OR (
      length(expected_logical_digest) = 71
      AND substr(expected_logical_digest, 1, 7) = 'sha256:'
      AND substr(expected_logical_digest, 8)
        NOT GLOB '*[^0-9a-f]*'
    )
  ),
  status TEXT NOT NULL
    CHECK (
      status IN (
        'pending', 'processing', 'applied', 'failed', 'stale', 'skipped'
      )
    ),
  attempts INTEGER NOT NULL CHECK (attempts BETWEEN 0 AND 32),
  available_at TEXT NOT NULL,
  claimed_by TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  last_failure TEXT CHECK (
    last_failure IS NULL
    OR last_failure IN (
      'GRAPH_DISABLED',
      'GRAPH_OPTIONAL_DEPENDENCY_MISSING',
      'GRAPH_IDENTITY_MISMATCH',
      'GRAPH_PROCESS_START_FAILED',
      'GRAPH_PROTOCOL_INVALID',
      'GRAPH_REQUEST_LIMIT_EXCEEDED',
      'GRAPH_DEADLINE_EXCEEDED',
      'GRAPH_CHILD_EXITED',
      'GRAPH_CIRCUIT_OPEN',
      'GRAPH_STORE_LOCKED',
      'GRAPH_STORE_CORRUPT',
      'GRAPH_SCOPE_STALE',
      'GRAPH_SCOPE_PENDING',
      'GRAPH_SCOPE_REBUILDING',
      'GRAPH_DIGEST_MISMATCH',
      'GRAPH_POSTVALIDATION_FAILED',
      'GRAPH_UNKNOWN_WORK'
    )
  ),
  CHECK (
    (target_frontier_json IS NULL) =
      (expected_logical_digest IS NULL)
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

CREATE INDEX graph_projection_outbox_claim
  ON graph_projection_outbox_jobs (
    backend, status, available_at, job_id
  );

CREATE INDEX graph_projection_outbox_scope
  ON graph_projection_outbox_jobs (
    backend, principal_id, scope_kind, scope_id, status, job_id
  );

CREATE TABLE graph_projection_receipts (
  receipt_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES graph_projection_outbox_jobs(job_id),
  backend TEXT NOT NULL CHECK (backend = 'ladybugdb'),
  principal_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL
    CHECK (
      scope_kind IN (
        'thread', 'topic', 'scenario', 'user', 'workspace', 'agent'
      )
    ),
  scope_id TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('applied', 'failed', 'stale', 'skipped')),
  logical_digest TEXT CHECK (
    logical_digest IS NULL
    OR (
      length(logical_digest) = 71
      AND substr(logical_digest, 1, 7) = 'sha256:'
      AND substr(logical_digest, 8) NOT GLOB '*[^0-9a-f]*'
    )
  ),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  completed_at TEXT NOT NULL
) STRICT;

CREATE INDEX graph_projection_receipts_job
  ON graph_projection_receipts (job_id, completed_at, receipt_id);

CREATE TRIGGER graph_projection_scope_state_guarded_insert
BEFORE INSERT ON graph_projection_scope_state
WHEN NOT EXISTS (
  SELECT 1 FROM graph_projection_write_guard WHERE singleton = 1
)
BEGIN
  SELECT RAISE(ABORT, 'GRAPH_PROJECTION_TRANSACTION_REQUIRED');
END;

CREATE TRIGGER graph_projection_scope_state_guarded_update
BEFORE UPDATE ON graph_projection_scope_state
WHEN NOT EXISTS (
  SELECT 1 FROM graph_projection_write_guard WHERE singleton = 1
)
OR NEW.backend <> OLD.backend
OR NEW.principal_id <> OLD.principal_id
OR NEW.scope_kind <> OLD.scope_kind
OR NEW.scope_id <> OLD.scope_id
OR NEW.ledger_epoch < OLD.ledger_epoch
OR NEW.tombstone_epoch < OLD.tombstone_epoch
OR NEW.projection_epoch < OLD.projection_epoch
OR NEW.graph_projection_epoch < OLD.graph_projection_epoch
BEGIN
  SELECT RAISE(ABORT, 'GRAPH_PROJECTION_TRANSACTION_REQUIRED');
END;

CREATE TRIGGER graph_projection_scope_state_no_delete
BEFORE DELETE ON graph_projection_scope_state BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:graph_projection_scope_state');
END;

CREATE TRIGGER graph_projection_outbox_guarded_insert
BEFORE INSERT ON graph_projection_outbox_jobs
WHEN NOT EXISTS (
  SELECT 1 FROM graph_projection_write_guard WHERE singleton = 1
)
BEGIN
  SELECT RAISE(ABORT, 'GRAPH_PROJECTION_TRANSACTION_REQUIRED');
END;

CREATE TRIGGER graph_projection_outbox_guarded_update
BEFORE UPDATE ON graph_projection_outbox_jobs
WHEN NOT EXISTS (
  SELECT 1 FROM graph_projection_write_guard WHERE singleton = 1
)
OR NEW.job_id <> OLD.job_id
OR NEW.operation <> OLD.operation
OR NEW.backend <> OLD.backend
OR NEW.principal_id <> OLD.principal_id
OR NEW.scope_kind <> OLD.scope_kind
OR NEW.scope_id <> OLD.scope_id
OR NEW.target_frontier_json IS NOT OLD.target_frontier_json
OR NEW.expected_logical_digest IS NOT OLD.expected_logical_digest
OR NEW.attempts < OLD.attempts
BEGIN
  SELECT RAISE(ABORT, 'GRAPH_PROJECTION_TRANSACTION_REQUIRED');
END;

CREATE TRIGGER graph_projection_outbox_no_delete
BEFORE DELETE ON graph_projection_outbox_jobs BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:graph_projection_outbox_jobs');
END;

CREATE TRIGGER graph_projection_receipts_guarded_insert
BEFORE INSERT ON graph_projection_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM graph_projection_write_guard WHERE singleton = 1
)
BEGIN
  SELECT RAISE(ABORT, 'GRAPH_PROJECTION_TRANSACTION_REQUIRED');
END;

CREATE TRIGGER graph_projection_receipts_no_update
BEFORE UPDATE ON graph_projection_receipts BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:graph_projection_receipts');
END;

CREATE TRIGGER graph_projection_receipts_no_delete
BEFORE DELETE ON graph_projection_receipts BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:graph_projection_receipts');
END;
