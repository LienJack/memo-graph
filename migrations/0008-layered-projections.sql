CREATE TABLE layered_projection_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  status TEXT NOT NULL
    CHECK (status IN ('ready', 'pending', 'rebuilding', 'unavailable')),
  ledger_epoch INTEGER NOT NULL CHECK (ledger_epoch >= 0),
  tombstone_epoch INTEGER NOT NULL CHECK (tombstone_epoch >= 0),
  projection_epoch INTEGER NOT NULL CHECK (projection_epoch >= 0),
  source_frontier_hash TEXT
    CHECK (
      source_frontier_hash IS NULL
      OR (
        length(source_frontier_hash) = 71
        AND source_frontier_hash GLOB 'sha256:[0-9a-f]*'
      )
    ),
  projection_frontier_hash TEXT
    CHECK (
      projection_frontier_hash IS NULL
      OR (
        length(projection_frontier_hash) = 71
        AND projection_frontier_hash GLOB 'sha256:[0-9a-f]*'
      )
    ),
  transform_versions_json TEXT NOT NULL
    CHECK (json_valid(transform_versions_json)),
  updated_at TEXT NOT NULL,
  error_code TEXT
) STRICT;

INSERT INTO layered_projection_state (
  singleton,
  status,
  ledger_epoch,
  tombstone_epoch,
  projection_epoch,
  source_frontier_hash,
  projection_frontier_hash,
  transform_versions_json,
  updated_at,
  error_code
)
SELECT
  1,
  'ready',
  ledger_state.ledger_epoch,
  tombstone_state.tombstone_epoch,
  0,
  NULL,
  NULL,
  json('[]'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  NULL
FROM ledger_state, tombstone_state
WHERE ledger_state.singleton = 1
  AND tombstone_state.singleton = 1;

CREATE TABLE projection_write_guard (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  operation TEXT NOT NULL,
  opened_at TEXT NOT NULL
) STRICT;

CREATE TABLE projection_objects (
  projection_id TEXT PRIMARY KEY,
  projection_type TEXT NOT NULL
    CHECK (
      projection_type IN (
        'topic', 'scenario', 'procedure', 'relation', 'core'
      )
    ),
  abstraction TEXT NOT NULL
    CHECK (
      abstraction IN (
        'l2_topic', 'l2_scenario', 'l2_relation', 'l3_core'
      )
    ),
  principal_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL
    CHECK (
      scope_kind IN (
        'thread', 'topic', 'scenario', 'user', 'workspace', 'agent'
      )
    ),
  scope_id TEXT NOT NULL,
  lifecycle TEXT NOT NULL
    CHECK (
      lifecycle IN (
        'working', 'candidate', 'active', 'superseded',
        'revoked', 'quarantined', 'purged'
      )
    ),
  current_revision_id TEXT
    REFERENCES projection_revisions(projection_revision_id)
    DEFERRABLE INITIALLY DEFERRED,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (
    principal_id, scope_kind, scope_id, projection_type, projection_id
  ),
  CHECK (lifecycle <> 'active' OR current_revision_id IS NOT NULL),
  CHECK (lifecycle <> 'purged' OR current_revision_id IS NULL)
) STRICT;

CREATE INDEX projection_objects_scope_type_lifecycle
  ON projection_objects (
    principal_id,
    scope_kind,
    scope_id,
    projection_type,
    lifecycle,
    projection_id
  );

CREATE TABLE projection_revisions (
  projection_revision_id TEXT PRIMARY KEY,
  projection_id TEXT NOT NULL REFERENCES projection_objects(projection_id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  projection_type TEXT NOT NULL
    CHECK (
      projection_type IN (
        'topic', 'scenario', 'procedure', 'relation', 'core'
      )
    ),
  abstraction TEXT NOT NULL
    CHECK (
      abstraction IN (
        'l2_topic', 'l2_scenario', 'l2_relation', 'l3_core'
      )
    ),
  principal_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL
    CHECK (
      scope_kind IN (
        'thread', 'topic', 'scenario', 'user', 'workspace', 'agent'
      )
    ),
  scope_id TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  authority TEXT NOT NULL CHECK (authority = 'derived'),
  sensitivity TEXT NOT NULL
    CHECK (
      sensitivity IN (
        'public', 'internal', 'personal', 'sensitive', 'secret'
      )
    ),
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  recorded_at TEXT NOT NULL,
  content_hash TEXT NOT NULL
    CHECK (
      length(content_hash) = 71
      AND content_hash GLOB 'sha256:[0-9a-f]*'
    ),
  payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  content_json TEXT CHECK (content_json IS NULL OR json_valid(content_json)),
  evidence_ids_json TEXT NOT NULL CHECK (json_valid(evidence_ids_json)),
  supersedes_projection_revision_id TEXT
    REFERENCES projection_revisions(projection_revision_id),
  transform_name TEXT NOT NULL,
  transform_version TEXT NOT NULL,
  ledger_epoch INTEGER NOT NULL CHECK (ledger_epoch >= 0),
  tombstone_epoch INTEGER NOT NULL CHECK (tombstone_epoch >= 0),
  projection_epoch INTEGER NOT NULL CHECK (projection_epoch > 0),
  source_frontier_hash TEXT NOT NULL,
  projection_frontier_hash TEXT NOT NULL,
  revision_json TEXT NOT NULL CHECK (json_valid(revision_json)),
  created_at TEXT NOT NULL,
  purged_at TEXT,
  UNIQUE (projection_id, revision),
  CHECK (
    (revision = 1 AND supersedes_projection_revision_id IS NULL)
    OR
    (revision > 1 AND supersedes_projection_revision_id IS NOT NULL)
  ),
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CHECK (
    (purged_at IS NULL AND payload_json IS NOT NULL AND content_json IS NOT NULL)
    OR
    (purged_at IS NOT NULL AND payload_json IS NULL AND content_json IS NULL)
  )
) STRICT;

CREATE INDEX projection_revisions_scope_type_frontier
  ON projection_revisions (
    principal_id,
    scope_kind,
    scope_id,
    projection_type,
    projection_epoch,
    projection_revision_id
  );
CREATE INDEX projection_revisions_projection_revision
  ON projection_revisions (projection_id, revision DESC);
CREATE INDEX projection_revisions_frontier_hash
  ON projection_revisions (
    source_frontier_hash,
    projection_frontier_hash,
    projection_revision_id
  );
CREATE INDEX projection_revisions_content_hash
  ON projection_revisions (content_hash, projection_revision_id);

CREATE TABLE projection_revision_sources (
  projection_revision_id TEXT NOT NULL
    REFERENCES projection_revisions(projection_revision_id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  source_kind TEXT NOT NULL
    CHECK (source_kind IN ('memory_revision', 'projection_revision')),
  source_revision_id TEXT NOT NULL,
  source_memory_id TEXT REFERENCES memory_objects(memory_id),
  source_projection_id TEXT REFERENCES projection_objects(projection_id),
  source_abstraction TEXT NOT NULL,
  source_content_hash TEXT NOT NULL,
  source_principal_id TEXT NOT NULL,
  source_scope_kind TEXT NOT NULL,
  source_scope_id TEXT NOT NULL,
  source_authority TEXT NOT NULL,
  source_sensitivity TEXT NOT NULL,
  source_valid_from TEXT NOT NULL,
  source_valid_to TEXT,
  source_recorded_at TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL CHECK (json_valid(evidence_ids_json)),
  PRIMARY KEY (projection_revision_id, ordinal),
  UNIQUE (projection_revision_id, source_revision_id),
  CHECK (
    (source_kind = 'memory_revision'
      AND source_memory_id IS NOT NULL
      AND source_projection_id IS NULL)
    OR
    (source_kind = 'projection_revision'
      AND source_memory_id IS NULL
      AND source_projection_id IS NOT NULL)
  )
) STRICT;

CREATE INDEX projection_revision_sources_descendants
  ON projection_revision_sources (
    source_revision_id,
    projection_revision_id
  );
CREATE INDEX projection_revision_sources_scope
  ON projection_revision_sources (
    source_principal_id,
    source_scope_kind,
    source_scope_id,
    source_revision_id
  );

CREATE TABLE projection_invalidations (
  invalidation_id TEXT PRIMARY KEY,
  projection_id TEXT NOT NULL REFERENCES projection_objects(projection_id),
  projection_revision_id TEXT NOT NULL
    REFERENCES projection_revisions(projection_revision_id),
  source_revision_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  invalidated_at TEXT NOT NULL,
  UNIQUE (projection_revision_id, source_revision_id, reason)
) STRICT;

CREATE INDEX projection_invalidations_projection
  ON projection_invalidations (
    projection_revision_id,
    invalidated_at,
    invalidation_id
  );

CREATE TABLE relation_objects (
  relation_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  current_relation_revision_id TEXT
    REFERENCES relation_revisions(relation_revision_id)
    DEFERRABLE INITIALLY DEFERRED,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (lifecycle <> 'active' OR current_relation_revision_id IS NOT NULL),
  CHECK (lifecycle <> 'purged' OR current_relation_revision_id IS NULL)
) STRICT;

CREATE INDEX relation_objects_scope_lifecycle
  ON relation_objects (
    principal_id, scope_kind, scope_id, lifecycle, relation_id
  );

CREATE TABLE relation_revisions (
  relation_revision_id TEXT PRIMARY KEY,
  relation_id TEXT NOT NULL REFERENCES relation_objects(relation_id),
  projection_revision_id TEXT NOT NULL UNIQUE
    REFERENCES projection_revisions(projection_revision_id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  source_revision_id TEXT NOT NULL,
  target_revision_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('directed', 'undirected')),
  description TEXT,
  principal_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  projection_epoch INTEGER NOT NULL CHECK (projection_epoch > 0),
  relation_json TEXT NOT NULL CHECK (json_valid(relation_json)),
  created_at TEXT NOT NULL,
  UNIQUE (relation_id, revision),
  CHECK (source_revision_id <> target_revision_id),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
) STRICT;

CREATE INDEX relation_revisions_outbound
  ON relation_revisions (
    principal_id,
    scope_kind,
    scope_id,
    source_revision_id,
    relation_type,
    relation_revision_id
  );
CREATE INDEX relation_revisions_inbound
  ON relation_revisions (
    principal_id,
    scope_kind,
    scope_id,
    target_revision_id,
    relation_type,
    relation_revision_id
  );

CREATE TABLE projection_batches (
  idempotency_key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  projection_epoch INTEGER NOT NULL UNIQUE CHECK (projection_epoch > 0),
  frontier_json TEXT NOT NULL CHECK (json_valid(frontier_json)),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE projection_rebuild_receipts (
  rebuild_receipt_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('incremental', 'full')),
  projection_epoch INTEGER NOT NULL CHECK (projection_epoch >= 0),
  structural_digest TEXT NOT NULL,
  projection_count INTEGER NOT NULL CHECK (projection_count >= 0),
  relation_count INTEGER NOT NULL CHECK (relation_count >= 0),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  completed_at TEXT NOT NULL
) STRICT;

CREATE INDEX projection_rebuild_receipts_epoch
  ON projection_rebuild_receipts (
    projection_epoch, completed_at, rebuild_receipt_id
  );

CREATE TABLE projection_outbox_jobs (
  job_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('refresh', 'invalidate', 'rebuild')),
  aggregate_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  source_revision_ids_json TEXT NOT NULL
    CHECK (json_valid(source_revision_ids_json)),
  status TEXT NOT NULL
    CHECK (
      status IN ('pending', 'processing', 'processed', 'failed')
    ),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL,
  claimed_by TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  processed_at TEXT,
  last_error_code TEXT,
  CHECK (
    (status = 'processing'
      AND claimed_by IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND processed_at IS NULL)
    OR
    (status = 'processed'
      AND claimed_by IS NULL
      AND lease_expires_at IS NULL
      AND processed_at IS NOT NULL
      AND last_error_code IS NULL)
    OR
    (status IN ('pending', 'failed')
      AND claimed_by IS NULL
      AND lease_expires_at IS NULL
      AND processed_at IS NULL)
  )
) STRICT;

CREATE INDEX projection_outbox_claim
  ON projection_outbox_jobs (
    status, available_at, job_id
  );
CREATE INDEX projection_outbox_aggregate
  ON projection_outbox_jobs (
    principal_id, scope_kind, scope_id, aggregate_id, job_id
  );

CREATE TRIGGER layered_projection_state_guarded_update
BEFORE UPDATE ON layered_projection_state
WHEN NOT EXISTS (
  SELECT 1 FROM projection_write_guard WHERE singleton = 1
)
OR NEW.singleton <> OLD.singleton
OR NEW.projection_epoch < OLD.projection_epoch
OR NEW.projection_epoch > OLD.projection_epoch + 1
BEGIN
  SELECT RAISE(ABORT, 'PROJECTION_TRANSACTION_REQUIRED');
END;

CREATE TRIGGER layered_projection_state_no_delete
BEFORE DELETE ON layered_projection_state BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:layered_projection_state');
END;

CREATE TRIGGER projection_write_guard_no_update
BEFORE UPDATE ON projection_write_guard BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:projection_write_guard');
END;

CREATE TRIGGER projection_objects_guarded_update
BEFORE UPDATE ON projection_objects
WHEN NOT EXISTS (
  SELECT 1 FROM projection_write_guard WHERE singleton = 1
)
BEGIN
  SELECT RAISE(ABORT, 'PROJECTION_TRANSACTION_REQUIRED');
END;

CREATE TRIGGER projection_objects_guarded_delete
BEFORE DELETE ON projection_objects
WHEN NOT EXISTS (
  SELECT 1 FROM projection_write_guard WHERE singleton = 1
)
BEGIN
  SELECT RAISE(ABORT, 'PROJECTION_TRANSACTION_REQUIRED');
END;

CREATE TRIGGER projection_revisions_no_update
BEFORE UPDATE ON projection_revisions BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:projection_revisions');
END;

CREATE TRIGGER projection_revisions_no_delete
BEFORE DELETE ON projection_revisions BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:projection_revisions');
END;

CREATE TRIGGER projection_revision_sources_no_update
BEFORE UPDATE ON projection_revision_sources BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:projection_revision_sources');
END;

CREATE TRIGGER projection_revision_sources_no_delete
BEFORE DELETE ON projection_revision_sources BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:projection_revision_sources');
END;

CREATE TRIGGER projection_invalidations_no_update
BEFORE UPDATE ON projection_invalidations BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:projection_invalidations');
END;

CREATE TRIGGER projection_invalidations_no_delete
BEFORE DELETE ON projection_invalidations BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:projection_invalidations');
END;

CREATE TRIGGER relation_objects_guarded_update
BEFORE UPDATE ON relation_objects
WHEN NOT EXISTS (
  SELECT 1 FROM projection_write_guard WHERE singleton = 1
)
BEGIN
  SELECT RAISE(ABORT, 'PROJECTION_TRANSACTION_REQUIRED');
END;

CREATE TRIGGER relation_objects_guarded_delete
BEFORE DELETE ON relation_objects
WHEN NOT EXISTS (
  SELECT 1 FROM projection_write_guard WHERE singleton = 1
)
BEGIN
  SELECT RAISE(ABORT, 'PROJECTION_TRANSACTION_REQUIRED');
END;

CREATE TRIGGER relation_revisions_no_update
BEFORE UPDATE ON relation_revisions BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:relation_revisions');
END;

CREATE TRIGGER relation_revisions_no_delete
BEFORE DELETE ON relation_revisions BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:relation_revisions');
END;

CREATE TRIGGER projection_batches_no_update
BEFORE UPDATE ON projection_batches BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:projection_batches');
END;

CREATE TRIGGER projection_batches_no_delete
BEFORE DELETE ON projection_batches BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:projection_batches');
END;

CREATE TRIGGER projection_rebuild_receipts_no_update
BEFORE UPDATE ON projection_rebuild_receipts BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:projection_rebuild_receipts');
END;

CREATE TRIGGER projection_rebuild_receipts_no_delete
BEFORE DELETE ON projection_rebuild_receipts BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:projection_rebuild_receipts');
END;

CREATE TRIGGER projection_outbox_guarded_update
BEFORE UPDATE ON projection_outbox_jobs
WHEN NOT EXISTS (
  SELECT 1 FROM projection_write_guard WHERE singleton = 1
)
BEGIN
  SELECT RAISE(ABORT, 'PROJECTION_TRANSACTION_REQUIRED');
END;

CREATE TRIGGER projection_outbox_no_delete
BEFORE DELETE ON projection_outbox_jobs BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:projection_outbox_jobs');
END;
