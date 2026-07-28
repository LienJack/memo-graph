CREATE TABLE tombstone_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  tombstone_epoch INTEGER NOT NULL DEFAULT 0 CHECK (tombstone_epoch >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO tombstone_state (
  singleton, tombstone_epoch, created_at, updated_at
) VALUES (
  1, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

CREATE TABLE purge_jobs (
  purge_job_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL UNIQUE REFERENCES memory_objects(memory_id),
  tombstone_epoch INTEGER NOT NULL UNIQUE CHECK (tombstone_epoch > 0),
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'running', 'partial', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_error_code TEXT
) STRICT;

CREATE INDEX purge_jobs_status_updated_at
  ON purge_jobs (status, updated_at, purge_job_id);

CREATE TABLE memory_tombstones (
  memory_id TEXT PRIMARY KEY REFERENCES memory_objects(memory_id),
  revision_id TEXT NOT NULL REFERENCES memory_revisions(revision_id),
  tombstone_epoch INTEGER NOT NULL UNIQUE CHECK (tombstone_epoch > 0),
  purge_job_id TEXT NOT NULL UNIQUE REFERENCES purge_jobs(purge_job_id),
  principal_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE purge_store_outcomes (
  purge_job_id TEXT NOT NULL REFERENCES purge_jobs(purge_job_id),
  store TEXT NOT NULL
    CHECK (store IN ('memory_revisions', 'candidates', 'conflicts', 'fts', 'context', 'exports', 'blobs', 'backups', 'projections')),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  status TEXT NOT NULL CHECK (status IN ('verified', 'residual', 'failed')),
  residual_hashes_json TEXT NOT NULL CHECK (json_valid(residual_hashes_json)),
  error_code TEXT,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (purge_job_id, store, attempt),
  CHECK (
    (status = 'verified' AND error_code IS NULL)
    OR
    (status = 'residual' AND error_code IS NULL)
    OR
    (status = 'failed' AND error_code IS NOT NULL)
  )
) STRICT;

CREATE TABLE purge_receipts (
  receipt_id TEXT PRIMARY KEY,
  purge_job_id TEXT NOT NULL REFERENCES purge_jobs(purge_job_id),
  request_hash TEXT NOT NULL,
  receipt_hash TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL
    CHECK (state IN ('partial', 'failed', 'purged')),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX purge_receipts_job_created_at
  ON purge_receipts (purge_job_id, created_at, receipt_id);

CREATE TABLE approval_consumptions (
  approval_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
  consumed_at TEXT NOT NULL,
  receipt_id TEXT NOT NULL UNIQUE
    REFERENCES mutation_receipts(receipt_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE export_cache_inventory (
  inventory_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memory_objects(memory_id),
  store TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('live', 'purged', 'residual')),
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX export_cache_inventory_memory_status
  ON export_cache_inventory (memory_id, status, inventory_id);

CREATE TABLE purge_redaction_guard (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  purge_job_id TEXT NOT NULL REFERENCES purge_jobs(purge_job_id),
  memory_id TEXT NOT NULL REFERENCES memory_objects(memory_id),
  opened_at TEXT NOT NULL
) STRICT;

ALTER TABLE evidence_events ADD COLUMN purged_at TEXT;
ALTER TABLE backup_manifests
  ADD COLUMN tombstone_epoch INTEGER NOT NULL DEFAULT 0
  CHECK (tombstone_epoch >= 0);

DROP TRIGGER receipt_access_scopes_no_update;
DROP TRIGGER receipt_access_scopes_no_delete;
DROP INDEX receipt_access_principal_scope;
ALTER TABLE receipt_access_scopes RENAME TO receipt_access_scopes_legacy;

CREATE TABLE receipt_access_scopes (
  receipt_id TEXT NOT NULL,
  receipt_kind TEXT NOT NULL
    CHECK (receipt_kind IN ('mutation', 'retrieval', 'purge')),
  principal_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (
    receipt_id, receipt_kind, principal_id, scope_kind, scope_id
  )
) STRICT;

INSERT INTO receipt_access_scopes (
  receipt_id, receipt_kind, principal_id, scope_kind, scope_id, created_at
)
SELECT
  receipt_id, receipt_kind, principal_id, scope_kind, scope_id, created_at
FROM receipt_access_scopes_legacy;

DROP TABLE receipt_access_scopes_legacy;

CREATE INDEX receipt_access_principal_scope
  ON receipt_access_scopes (
    principal_id, scope_kind, scope_id, receipt_id
  );
CREATE TRIGGER receipt_access_scopes_no_update
BEFORE UPDATE ON receipt_access_scopes BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:receipt_access_scopes');
END;
CREATE TRIGGER receipt_access_scopes_no_delete
BEFORE DELETE ON receipt_access_scopes BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:receipt_access_scopes');
END;

CREATE TRIGGER tombstone_state_one_step
BEFORE UPDATE ON tombstone_state
WHEN NEW.tombstone_epoch <> OLD.tombstone_epoch + 1
  OR NEW.singleton <> OLD.singleton
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'TOMBSTONE_EPOCH:one_step');
END;
CREATE TRIGGER tombstone_state_no_delete
BEFORE DELETE ON tombstone_state BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:tombstone_state');
END;
CREATE TRIGGER memory_tombstones_no_update
BEFORE UPDATE ON memory_tombstones BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:memory_tombstones');
END;
CREATE TRIGGER memory_tombstones_no_delete
BEFORE DELETE ON memory_tombstones BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:memory_tombstones');
END;
CREATE TRIGGER purge_store_outcomes_no_update
BEFORE UPDATE ON purge_store_outcomes BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:purge_store_outcomes');
END;
CREATE TRIGGER purge_store_outcomes_no_delete
BEFORE DELETE ON purge_store_outcomes BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:purge_store_outcomes');
END;
CREATE TRIGGER purge_receipts_no_update
BEFORE UPDATE ON purge_receipts BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:purge_receipts');
END;
CREATE TRIGGER purge_receipts_no_delete
BEFORE DELETE ON purge_receipts BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:purge_receipts');
END;
CREATE TRIGGER approval_consumptions_no_update
BEFORE UPDATE ON approval_consumptions BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:approval_consumptions');
END;
CREATE TRIGGER approval_consumptions_no_delete
BEFORE DELETE ON approval_consumptions BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:approval_consumptions');
END;
CREATE TRIGGER purge_redaction_guard_valid_insert
BEFORE INSERT ON purge_redaction_guard
WHEN NOT EXISTS (
  SELECT 1 FROM purge_jobs AS p
  WHERE p.purge_job_id = NEW.purge_job_id
    AND p.memory_id = NEW.memory_id
    AND p.status = 'running'
)
BEGIN
  SELECT RAISE(ABORT, 'PURGE_GUARD:invalid_job');
END;
CREATE TRIGGER purge_redaction_guard_no_update
BEFORE UPDATE ON purge_redaction_guard BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:purge_redaction_guard');
END;
CREATE TRIGGER purge_redaction_guard_no_delete_without_running_job
BEFORE DELETE ON purge_redaction_guard
WHEN NOT EXISTS (
  SELECT 1 FROM purge_jobs AS p
  WHERE p.purge_job_id = OLD.purge_job_id
    AND p.memory_id = OLD.memory_id
    AND p.status = 'running'
)
BEGIN
  SELECT RAISE(ABORT, 'PURGE_GUARD:invalid_job');
END;

DROP TRIGGER evidence_events_no_update;
CREATE TRIGGER evidence_events_no_update
BEFORE UPDATE ON evidence_events
WHEN NOT (
  EXISTS (
    SELECT 1
    FROM purge_redaction_guard AS g
    JOIN purge_jobs AS p
      ON p.purge_job_id = g.purge_job_id
     AND p.memory_id = g.memory_id
     AND p.status = 'running'
    JOIN memory_revisions AS r ON r.memory_id = g.memory_id
    JOIN memory_revision_evidence AS re
      ON re.revision_id = r.revision_id
     AND re.evidence_id = OLD.evidence_id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM memory_revision_evidence AS other_re
    JOIN memory_revisions AS other_r
      ON other_r.revision_id = other_re.revision_id
    JOIN memory_objects AS other_m
      ON other_m.memory_id = other_r.memory_id
    JOIN purge_redaction_guard AS g
    WHERE other_re.evidence_id = OLD.evidence_id
      AND other_m.memory_id <> g.memory_id
      AND other_m.lifecycle <> 'purged'
  )
  AND NEW.evidence_id IS OLD.evidence_id
  AND NEW.sequence IS OLD.sequence
  AND NEW.occurred_at IS OLD.occurred_at
  AND NEW.recorded_at IS OLD.recorded_at
  AND NEW.scope_kind IS OLD.scope_kind
  AND NEW.scope_id IS OLD.scope_id
  AND NEW.principal_id IS OLD.principal_id
  AND NEW.actor_authority IS OLD.actor_authority
  AND NEW.source IS OLD.source
  AND NEW.authority IS OLD.authority
  AND NEW.sensitivity IS OLD.sensitivity
  AND NEW.content_hash IS OLD.content_hash
  AND NEW.schema_version IS OLD.schema_version
  AND NEW.payload_storage = 'inline'
  AND NEW.payload_inline = '[PURGED]'
  AND NEW.payload_blob_hash IS NULL
  AND NEW.media_type = 'application/x.memo-graph-redacted'
  AND NEW.purged_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:evidence_events');
END;

DROP TRIGGER memory_candidates_no_update;
CREATE TRIGGER memory_candidates_no_update
BEFORE UPDATE ON memory_candidates
WHEN NOT (
  EXISTS (
    SELECT 1
    FROM purge_redaction_guard AS g
    JOIN memory_candidate_links AS l
      ON l.memory_id = g.memory_id
     AND l.candidate_id = OLD.candidate_id
    JOIN purge_jobs AS p
      ON p.purge_job_id = g.purge_job_id
     AND p.status = 'running'
  )
  AND NEW.candidate_id IS OLD.candidate_id
  AND NEW.logical_key IS OLD.logical_key
  AND NEW.logical_key_hash IS OLD.logical_key_hash
  AND NEW.principal_id IS OLD.principal_id
  AND NEW.scope_kind IS OLD.scope_kind
  AND NEW.scope_id IS OLD.scope_id
  AND NEW.kind IS OLD.kind
  AND NEW.sensitivity IS OLD.sensitivity
  AND NEW.inferred IS OLD.inferred
  AND NEW.content_hash IS OLD.content_hash
  AND NEW.valid_from IS OLD.valid_from
  AND NEW.valid_to IS OLD.valid_to
  AND NEW.recorded_at IS OLD.recorded_at
  AND NEW.injection_risk IS OLD.injection_risk
  AND NEW.requires_user_confirmation IS OLD.requires_user_confirmation
  AND NEW.transform_name IS OLD.transform_name
  AND NEW.transform_version IS OLD.transform_version
  AND NEW.created_at IS OLD.created_at
  AND NEW.content_storage = 'redacted'
  AND NEW.content_inline IS NULL
  AND NEW.content_blob_hash IS NULL
  AND NEW.media_type = 'application/x.memo-graph-redacted'
  AND NEW.purged_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:memory_candidates');
END;

DROP TRIGGER memory_revisions_no_update;
CREATE TRIGGER memory_revisions_no_update
BEFORE UPDATE ON memory_revisions
WHEN NOT (
  EXISTS (
    SELECT 1
    FROM purge_redaction_guard AS g
    JOIN purge_jobs AS p
      ON p.purge_job_id = g.purge_job_id
     AND p.status = 'running'
    WHERE g.memory_id = OLD.memory_id
  )
  AND NEW.revision_id IS OLD.revision_id
  AND NEW.memory_id IS OLD.memory_id
  AND NEW.revision IS OLD.revision
  AND NEW.abstraction IS OLD.abstraction
  AND NEW.kind IS OLD.kind
  AND NEW.scope_kind IS OLD.scope_kind
  AND NEW.scope_id IS OLD.scope_id
  AND NEW.authority IS OLD.authority
  AND NEW.sensitivity IS OLD.sensitivity
  AND NEW.valid_from IS OLD.valid_from
  AND NEW.valid_to IS OLD.valid_to
  AND NEW.recorded_at IS OLD.recorded_at
  AND NEW.inferred IS OLD.inferred
  AND NEW.content_hash IS OLD.content_hash
  AND NEW.supersedes_revision_id IS OLD.supersedes_revision_id
  AND NEW.transform_name IS OLD.transform_name
  AND NEW.transform_version IS OLD.transform_version
  AND NEW.created_at IS OLD.created_at
  AND NEW.lifecycle = 'purged'
  AND NEW.content_storage = 'redacted'
  AND NEW.content_inline IS NULL
  AND NEW.content_blob_hash IS NULL
  AND NEW.media_type = 'application/x.memo-graph-redacted'
  AND NEW.purged_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:memory_revisions');
END;

DROP TRIGGER context_slice_items_no_update;
CREATE TRIGGER context_slice_items_no_update
BEFORE UPDATE ON context_slice_items
WHEN NOT (
  EXISTS (
    SELECT 1
    FROM purge_redaction_guard AS g
    JOIN purge_jobs AS p
      ON p.purge_job_id = g.purge_job_id
     AND p.status = 'running'
    WHERE g.memory_id = OLD.memory_id
  )
  AND NEW.context_slice_id IS OLD.context_slice_id
  AND NEW.ordinal IS OLD.ordinal
  AND NEW.memory_id IS OLD.memory_id
  AND NEW.revision_id IS OLD.revision_id
  AND json_valid(NEW.item_json)
  AND json(
    json_remove(NEW.item_json, '$.content')
  ) = json(
    json_remove(OLD.item_json, '$.content')
  )
  AND json_extract(NEW.item_json, '$.content.storage') = 'inline'
  AND json_extract(NEW.item_json, '$.content.text') = '[PURGED]'
  AND json_extract(NEW.item_json, '$.content.media_type')
    = 'application/x.memo-graph-redacted'
  AND (
    SELECT count(*) FROM json_each(
      json_extract(NEW.item_json, '$.content')
    )
  ) = 3
)
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:context_slice_items');
END;

DROP TRIGGER context_slices_no_update;
CREATE TRIGGER context_slices_no_update
BEFORE UPDATE ON context_slices
WHEN NOT (
  EXISTS (
    SELECT 1
    FROM purge_redaction_guard AS g
    JOIN purge_jobs AS p
      ON p.purge_job_id = g.purge_job_id
     AND p.status = 'running'
    JOIN context_slice_items AS i
      ON i.context_slice_id = OLD.context_slice_id
     AND i.memory_id = g.memory_id
  )
  AND NEW.context_slice_id IS OLD.context_slice_id
  AND NEW.request_id IS OLD.request_id
  AND NEW.compiler_version IS OLD.compiler_version
  AND NEW.token_budget IS OLD.token_budget
  AND NEW.token_used IS OLD.token_used
  AND NEW.frozen_hash IS OLD.frozen_hash
  AND NEW.created_at IS OLD.created_at
  AND json_valid(NEW.slice_json)
)
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:context_slices');
END;

CREATE TRIGGER purge_jobs_memory_matches_tombstone
BEFORE UPDATE OF status ON purge_jobs
WHEN NEW.status IN ('partial', 'completed', 'failed')
  AND NOT EXISTS (
    SELECT 1 FROM memory_tombstones AS t
    WHERE t.memory_id = NEW.memory_id
      AND t.purge_job_id = NEW.purge_job_id
      AND t.tombstone_epoch = NEW.tombstone_epoch
  )
BEGIN
  SELECT RAISE(ABORT, 'PURGE_JOB:missing_tombstone');
END;

INSERT INTO evidence_fts(evidence_fts, rank) VALUES('secure-delete', 1);
INSERT INTO memory_fts(memory_fts, rank) VALUES('secure-delete', 1);
