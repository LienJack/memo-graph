ALTER TABLE operational_repair_jobs ADD COLUMN principal_id TEXT;
ALTER TABLE operational_repair_jobs ADD COLUMN scope_kind TEXT;
ALTER TABLE operational_repair_jobs ADD COLUMN scope_id TEXT;

-- Pre-0019 non-FTS repair rows were global and cannot be assigned an honest
-- principal/scope after the fact. Quarantine interrupted rows as blocked so
-- they remain inspectable but can never be resumed as a scoped repair.
UPDATE operational_repair_jobs
SET state = 'blocked',
    artifact_count = 0,
    relation_count = 0,
    ledger_epoch = (
      SELECT ledger_epoch FROM ledger_state WHERE singleton = 1
    ),
    result_hash = request_hash,
    completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE repair_kind IN ('layered_projection', 'sqlite_relations')
  AND state = 'rebuilding';

CREATE TRIGGER operational_repair_jobs_scope_immutable
BEFORE UPDATE ON operational_repair_jobs
WHEN NEW.principal_id IS NOT OLD.principal_id
  OR NEW.scope_kind IS NOT OLD.scope_kind
  OR NEW.scope_id IS NOT OLD.scope_id
BEGIN
  SELECT RAISE(ABORT, 'INVALID_OPERATIONAL_REPAIR_SCOPE_TRANSITION');
END;

-- A secret purge receipt proves the authoritative rows were retired, but it
-- must not be exposed as terminal until backup copies, external ciphertext,
-- and SQLite free pages have been physically cleaned. Existing receipts are
-- conservatively upgraded into pending maintenance so an interrupted pre-0019
-- purge is repaired on the next writable open.
CREATE TABLE secret_purge_physical_maintenance (
  operation_id TEXT PRIMARY KEY,
  request_digest TEXT NOT NULL,
  receipt_id TEXT NOT NULL UNIQUE REFERENCES operational_receipts(receipt_id),
  receipt_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (
    (state = 'pending' AND completed_at IS NULL)
    OR
    (state = 'completed' AND completed_at IS NOT NULL)
  )
) STRICT;

INSERT INTO secret_purge_physical_maintenance (
  operation_id, request_digest, receipt_id, receipt_hash, state,
  requested_at, completed_at
)
SELECT operation_id, request_digest, receipt_id, receipt_hash, 'pending',
       created_at, NULL
FROM operational_receipts
WHERE operation_kind = 'secret_purge';

CREATE INDEX secret_purge_physical_maintenance_state
  ON secret_purge_physical_maintenance (state, operation_id);

CREATE TRIGGER secret_purge_physical_maintenance_valid_transition
BEFORE UPDATE ON secret_purge_physical_maintenance
WHEN NOT (
  NEW.operation_id IS OLD.operation_id
  AND NEW.request_digest IS OLD.request_digest
  AND NEW.receipt_id IS OLD.receipt_id
  AND NEW.receipt_hash IS OLD.receipt_hash
  AND NEW.requested_at IS OLD.requested_at
  AND OLD.state = 'pending'
  AND NEW.state = 'completed'
  AND OLD.completed_at IS NULL
  AND NEW.completed_at IS NOT NULL
) BEGIN
  SELECT RAISE(ABORT, 'INVALID_SECRET_PURGE_MAINTENANCE_TRANSITION');
END;

CREATE TRIGGER secret_purge_physical_maintenance_no_delete
BEFORE DELETE ON secret_purge_physical_maintenance BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:secret_purge_physical_maintenance');
END;

CREATE TABLE recovery_frontier_write_guard (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  opened_at TEXT NOT NULL
) STRICT;

CREATE TABLE recovery_frontier_changes (
  change_id INTEGER PRIMARY KEY AUTOINCREMENT,
  component TEXT NOT NULL CHECK (
    component IN (
      'ledger', 'receipt', 'tombstone', 'purge', 'fts', 'layered',
      'relation', 'context', 'learning', 'encryption', 'release_control',
      'maintenance'
    )
  ),
  table_name TEXT NOT NULL,
  row_key TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('insert', 'update', 'delete')),
  old_row_json TEXT CHECK (old_row_json IS NULL OR json_valid(old_row_json)),
  new_row_json TEXT CHECK (new_row_json IS NULL OR json_valid(new_row_json)),
  changed_at TEXT NOT NULL,
  CHECK (
    (operation = 'insert' AND old_row_json IS NULL AND new_row_json IS NOT NULL)
    OR (operation = 'update' AND old_row_json IS NOT NULL AND new_row_json IS NOT NULL)
    OR (operation = 'delete' AND old_row_json IS NOT NULL AND new_row_json IS NULL)
  )
) STRICT;

CREATE INDEX recovery_frontier_changes_component
ON recovery_frontier_changes(component, change_id);

CREATE TRIGGER recovery_frontier_changes_no_update
BEFORE UPDATE ON recovery_frontier_changes BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:recovery_frontier_changes');
END;

CREATE TRIGGER recovery_frontier_changes_delete_guard
BEFORE DELETE ON recovery_frontier_changes
WHEN NOT EXISTS (SELECT 1 FROM recovery_frontier_write_guard WHERE singleton = 1)
BEGIN
  SELECT RAISE(ABORT, 'RECOVERY_FRONTIER_WRITE_GUARD');
END;

CREATE TABLE recovery_frontier_rows (
  component TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_key TEXT NOT NULL,
  row_json TEXT NOT NULL CHECK (json_valid(row_json)),
  row_hash TEXT NOT NULL CHECK (
    length(row_hash) = 71 AND row_hash GLOB 'sha256:[0-9a-f]*'
  ),
  PRIMARY KEY (component, table_name, row_key)
) STRICT;

CREATE TABLE recovery_frontier_seed (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  minimums_json TEXT NOT NULL CHECK (json_valid(minimums_json)),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  state_commitment_hash TEXT NOT NULL CHECK (
    length(state_commitment_hash) = 71
    AND state_commitment_hash GLOB 'sha256:[0-9a-f]*'
  ),
  last_change_id INTEGER NOT NULL CHECK (last_change_id >= 0),
  rows_hash TEXT NOT NULL CHECK (
    length(rows_hash) = 71 AND rows_hash GLOB 'sha256:[0-9a-f]*'
  ),
  seed_hash TEXT NOT NULL UNIQUE CHECK (
    length(seed_hash) = 71 AND seed_hash GLOB 'sha256:[0-9a-f]*'
  ),
  seeded_at TEXT NOT NULL
) STRICT;

CREATE TABLE recovery_frontier_cache (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version TEXT NOT NULL CHECK (schema_version = '1.0.0'),
  minimums_json TEXT CHECK (minimums_json IS NULL OR json_valid(minimums_json)),
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
  state_commitment_hash TEXT CHECK (
    state_commitment_hash IS NULL OR (
      length(state_commitment_hash) = 71
      AND state_commitment_hash GLOB 'sha256:[0-9a-f]*'
    )
  ),
  last_change_id INTEGER NOT NULL CHECK (last_change_id >= 0),
  cache_hash TEXT CHECK (
    cache_hash IS NULL OR (
      length(cache_hash) = 71 AND cache_hash GLOB 'sha256:[0-9a-f]*'
    )
  ),
  initialized_at TEXT,
  updated_at TEXT,
  full_scan_count INTEGER NOT NULL DEFAULT 0 CHECK (full_scan_count >= 0),
  CHECK (
    (minimums_json IS NULL AND metadata_json IS NULL
      AND state_commitment_hash IS NULL AND cache_hash IS NULL
      AND initialized_at IS NULL AND updated_at IS NULL)
    OR
    (minimums_json IS NOT NULL AND metadata_json IS NOT NULL
      AND state_commitment_hash IS NOT NULL AND cache_hash IS NOT NULL
      AND initialized_at IS NOT NULL AND updated_at IS NOT NULL)
  )
) STRICT;

INSERT INTO recovery_frontier_cache (
  singleton, schema_version, minimums_json, metadata_json,
  state_commitment_hash, last_change_id, cache_hash,
  initialized_at, updated_at, full_scan_count
) VALUES (1, '1.0.0', NULL, NULL, NULL, 0, NULL, NULL, NULL, 0);

CREATE TRIGGER recovery_frontier_rows_insert_guard
BEFORE INSERT ON recovery_frontier_rows
WHEN NOT EXISTS (SELECT 1 FROM recovery_frontier_write_guard WHERE singleton = 1)
BEGIN
  SELECT RAISE(ABORT, 'RECOVERY_FRONTIER_WRITE_GUARD');
END;

CREATE TRIGGER recovery_frontier_rows_update_guard
BEFORE UPDATE ON recovery_frontier_rows
WHEN NOT EXISTS (SELECT 1 FROM recovery_frontier_write_guard WHERE singleton = 1)
BEGIN
  SELECT RAISE(ABORT, 'RECOVERY_FRONTIER_WRITE_GUARD');
END;

CREATE TRIGGER recovery_frontier_rows_delete_guard
BEFORE DELETE ON recovery_frontier_rows
WHEN NOT EXISTS (SELECT 1 FROM recovery_frontier_write_guard WHERE singleton = 1)
BEGIN
  SELECT RAISE(ABORT, 'RECOVERY_FRONTIER_WRITE_GUARD');
END;

CREATE TRIGGER recovery_frontier_seed_insert_guard
BEFORE INSERT ON recovery_frontier_seed
WHEN NOT EXISTS (SELECT 1 FROM recovery_frontier_write_guard WHERE singleton = 1)
BEGIN
  SELECT RAISE(ABORT, 'RECOVERY_FRONTIER_WRITE_GUARD');
END;

CREATE TRIGGER recovery_frontier_seed_update_guard
BEFORE UPDATE ON recovery_frontier_seed
WHEN NOT EXISTS (SELECT 1 FROM recovery_frontier_write_guard WHERE singleton = 1)
BEGIN
  SELECT RAISE(ABORT, 'RECOVERY_FRONTIER_WRITE_GUARD');
END;

CREATE TRIGGER recovery_frontier_seed_no_delete
BEFORE DELETE ON recovery_frontier_seed BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:recovery_frontier_seed');
END;

CREATE TRIGGER recovery_frontier_cache_update_guard
BEFORE UPDATE ON recovery_frontier_cache
WHEN NOT EXISTS (SELECT 1 FROM recovery_frontier_write_guard WHERE singleton = 1)
BEGIN
  SELECT RAISE(ABORT, 'RECOVERY_FRONTIER_WRITE_GUARD');
END;

CREATE TRIGGER recovery_frontier_cache_no_delete
BEFORE DELETE ON recovery_frontier_cache BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:recovery_frontier_cache');
END;

CREATE VIEW recovery_frontier_source_rows AS
SELECT 'ledger' AS component, 'ledger_state' AS table_name,
       CAST(singleton AS TEXT) AS row_key,
       json_object('singleton', singleton, 'ledger_epoch', ledger_epoch) AS row_json
FROM ledger_state
UNION ALL
SELECT 'receipt', 'mutation_receipts', receipt_id,
       json_object(
         'receipt_id', receipt_id, 'resulting_epoch', resulting_epoch,
         'receipt_hash', receipt_hash, 'receipt_json', receipt_json
       )
FROM mutation_receipts
UNION ALL
SELECT 'tombstone', 'tombstone_state', CAST(singleton AS TEXT),
       json_object('singleton', singleton, 'tombstone_epoch', tombstone_epoch)
FROM tombstone_state
UNION ALL
SELECT 'purge', 'artifact_purge_frontiers', store_id,
       json_object(
         'store_id', store_id, 'tombstone_epoch', tombstone_epoch,
         'debt_count', debt_count, 'frontier_hash', frontier_hash,
         'source_purge_job_id', source_purge_job_id
       )
FROM artifact_purge_frontiers
UNION ALL
SELECT 'maintenance', 'purge_physical_maintenance',
       purge_job_id || char(31) || CAST(attempt AS TEXT),
       json_object(
         'purge_job_id', purge_job_id, 'attempt', attempt,
         'state', state, 'outcomes_hash', outcomes_hash,
         'requested_at', requested_at, 'completed_at', completed_at
       )
FROM purge_physical_maintenance
UNION ALL
SELECT 'maintenance', 'purge_legacy_physical_maintenance', purge_job_id,
       json_object(
         'purge_job_id', purge_job_id, 'attempt', attempt,
         'receipt_id', receipt_id, 'receipt_hash', receipt_hash,
         'state', state, 'requested_at', requested_at,
         'completed_at', completed_at
       )
FROM purge_legacy_physical_maintenance
UNION ALL
SELECT 'maintenance', 'secret_purge_physical_maintenance', operation_id,
       json_object(
         'operation_id', operation_id, 'request_digest', request_digest,
         'receipt_id', receipt_id, 'receipt_hash', receipt_hash,
         'state', state, 'requested_at', requested_at,
         'completed_at', completed_at
       )
FROM secret_purge_physical_maintenance
UNION ALL
SELECT 'fts', 'projection_state', projection_name,
       json_object('projection_name', projection_name, 'last_epoch', last_epoch)
FROM projection_state
UNION ALL
SELECT 'layered', 'layered_projection_state', CAST(singleton AS TEXT),
       json_object(
         'singleton', singleton, 'status', status, 'ledger_epoch', ledger_epoch,
         'tombstone_epoch', tombstone_epoch, 'projection_epoch', projection_epoch,
         'source_frontier_hash', source_frontier_hash,
         'projection_frontier_hash', projection_frontier_hash,
         'transform_versions_json', transform_versions_json
       )
FROM layered_projection_state
UNION ALL
SELECT 'relation', 'relation_objects', relation_id,
       json_object(
         'relation_id', relation_id,
         'current_relation_revision_id', current_relation_revision_id,
         'lifecycle', lifecycle
       )
FROM relation_objects
UNION ALL
SELECT 'context', 'context_slices', context_slice_id,
       json_object('context_slice_id', context_slice_id, 'frozen_hash', frozen_hash)
FROM context_slices
UNION ALL
SELECT 'learning', 'learning_control_state', principal_id,
       json_object(
         'principal_id', principal_id, 'status', status,
         'control_epoch', control_epoch, 'frontier_hash', frontier_hash,
         'runtime_identity_hash', runtime_identity_hash,
         'configuration_hash', configuration_hash, 'corpus_hash', corpus_hash
       )
FROM learning_control_state
UNION ALL
SELECT 'learning', 'learning_release_pointers', release_slot_hash,
       json_object(
         'release_slot_hash', release_slot_hash,
         'active_release_id', active_release_id,
         'pointer_revision', pointer_revision, 'pointer_hash', pointer_hash
       )
FROM learning_release_pointers
UNION ALL
SELECT 'encryption', 'encryption_keys', key_id,
       json_object(
         'key_id', key_id, 'key_generation', key_generation, 'state', state,
         'authority_key_id', authority_key_id,
         'commitment_key_id', commitment_key_id, 'created_at', created_at,
         'state_changed_at', state_changed_at
       )
FROM encryption_keys
UNION ALL
SELECT 'encryption', 'key_rotations', rotation_id,
       json_object(
         'rotation_id', rotation_id, 'old_key_id', old_key_id,
         'new_key_id', new_key_id, 'state', state, 'total_items', total_items,
         'rewritten_items', rewritten_items, 'request_digest', request_digest,
         'started_at', started_at, 'updated_at', updated_at,
         'completed_at', completed_at, 'receipt_id', receipt_id
       )
FROM key_rotations
UNION ALL
SELECT 'encryption', 'operational_receipts', receipt_id,
       json_object(
         'operation_kind', operation_kind, 'operation_id', operation_id,
         'request_digest', request_digest, 'receipt_hash', receipt_hash
       )
FROM operational_receipts
WHERE operation_kind LIKE 'key_%' OR operation_kind = 'secret_purge'
UNION ALL
SELECT 'encryption', 'encrypted_contents', ciphertext_id,
       json_object('ciphertext_id', ciphertext_id, 'key_id', key_id)
FROM encrypted_contents
UNION ALL
SELECT 'encryption', 'encrypted_content_owners',
       owner_kind || char(31) || owner_id || char(31) || CAST(owner_generation AS TEXT),
       json_object(
         'owner_kind', owner_kind, 'owner_id', owner_id,
         'owner_generation', owner_generation, 'ciphertext_id', ciphertext_id,
         'key_id', coalesce(
           (SELECT key_id FROM encrypted_contents
            WHERE ciphertext_id = encrypted_content_owners.ciphertext_id),
           (SELECT json_extract(row_json, '$.key_id')
            FROM recovery_frontier_rows
            WHERE component = 'encryption'
              AND table_name = 'encrypted_content_owners'
              AND row_key = encrypted_content_owners.owner_kind || char(31)
                || encrypted_content_owners.owner_id || char(31)
                || CAST(encrypted_content_owners.owner_generation AS TEXT))
         ),
         'active', active
       )
FROM encrypted_content_owners
UNION ALL
SELECT 'release_control', 'g6_release_controls', control_id,
       json_object('control_id', control_id, 'control_hash', control_hash)
FROM g6_release_controls;

CREATE TRIGGER recovery_frontier_ledger_update
AFTER UPDATE ON ledger_state BEGIN
  INSERT INTO recovery_frontier_changes (
    component, table_name, row_key, operation, old_row_json, new_row_json, changed_at
  ) VALUES (
    'ledger', 'ledger_state', CAST(NEW.singleton AS TEXT), 'update',
    json_object('singleton', OLD.singleton, 'ledger_epoch', OLD.ledger_epoch),
    json_object('singleton', NEW.singleton, 'ledger_epoch', NEW.ledger_epoch),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER recovery_frontier_receipt_insert
AFTER INSERT ON mutation_receipts BEGIN
  INSERT INTO recovery_frontier_changes (
    component, table_name, row_key, operation, old_row_json, new_row_json, changed_at
  ) VALUES (
    'receipt', 'mutation_receipts', NEW.receipt_id, 'insert', NULL,
    json_object(
      'receipt_id', NEW.receipt_id, 'resulting_epoch', NEW.resulting_epoch,
      'receipt_hash', NEW.receipt_hash, 'receipt_json', NEW.receipt_json
    ),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER recovery_frontier_tombstone_update
AFTER UPDATE ON tombstone_state BEGIN
  INSERT INTO recovery_frontier_changes (
    component, table_name, row_key, operation, old_row_json, new_row_json, changed_at
  ) VALUES (
    'tombstone', 'tombstone_state', CAST(NEW.singleton AS TEXT), 'update',
    json_object('singleton', OLD.singleton, 'tombstone_epoch', OLD.tombstone_epoch),
    json_object('singleton', NEW.singleton, 'tombstone_epoch', NEW.tombstone_epoch),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER recovery_frontier_purge_insert
AFTER INSERT ON artifact_purge_frontiers BEGIN
  INSERT INTO recovery_frontier_changes VALUES (
    NULL, 'purge', 'artifact_purge_frontiers', NEW.store_id, 'insert', NULL,
    json_object(
      'store_id', NEW.store_id, 'tombstone_epoch', NEW.tombstone_epoch,
      'debt_count', NEW.debt_count, 'frontier_hash', NEW.frontier_hash,
      'source_purge_job_id', NEW.source_purge_job_id
    ), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER recovery_frontier_purge_update
AFTER UPDATE ON artifact_purge_frontiers BEGIN
  INSERT INTO recovery_frontier_changes VALUES (
    NULL, 'purge', 'artifact_purge_frontiers', NEW.store_id, 'update',
    json_object(
      'store_id', OLD.store_id, 'tombstone_epoch', OLD.tombstone_epoch,
      'debt_count', OLD.debt_count, 'frontier_hash', OLD.frontier_hash,
      'source_purge_job_id', OLD.source_purge_job_id
    ),
    json_object(
      'store_id', NEW.store_id, 'tombstone_epoch', NEW.tombstone_epoch,
      'debt_count', NEW.debt_count, 'frontier_hash', NEW.frontier_hash,
      'source_purge_job_id', NEW.source_purge_job_id
    ), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER recovery_frontier_maintenance_insert
AFTER INSERT ON purge_physical_maintenance BEGIN
  INSERT INTO recovery_frontier_changes VALUES (
    NULL, 'maintenance', 'purge_physical_maintenance',
    NEW.purge_job_id || char(31) || CAST(NEW.attempt AS TEXT),
    'insert', NULL,
    json_object(
      'purge_job_id', NEW.purge_job_id, 'attempt', NEW.attempt,
      'state', NEW.state, 'outcomes_hash', NEW.outcomes_hash,
      'requested_at', NEW.requested_at, 'completed_at', NEW.completed_at
    ), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER recovery_frontier_maintenance_update
AFTER UPDATE ON purge_physical_maintenance BEGIN
  INSERT INTO recovery_frontier_changes VALUES (
    NULL, 'maintenance', 'purge_physical_maintenance',
    NEW.purge_job_id || char(31) || CAST(NEW.attempt AS TEXT), 'update',
    json_object(
      'purge_job_id', OLD.purge_job_id, 'attempt', OLD.attempt,
      'state', OLD.state, 'outcomes_hash', OLD.outcomes_hash,
      'requested_at', OLD.requested_at, 'completed_at', OLD.completed_at
    ),
    json_object(
      'purge_job_id', NEW.purge_job_id, 'attempt', NEW.attempt,
      'state', NEW.state, 'outcomes_hash', NEW.outcomes_hash,
      'requested_at', NEW.requested_at, 'completed_at', NEW.completed_at
    ), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER recovery_frontier_legacy_maintenance_update
AFTER UPDATE ON purge_legacy_physical_maintenance BEGIN
  INSERT INTO recovery_frontier_changes VALUES (
    NULL, 'maintenance', 'purge_legacy_physical_maintenance',
    NEW.purge_job_id, 'update',
    json_object(
      'purge_job_id', OLD.purge_job_id, 'attempt', OLD.attempt,
      'receipt_id', OLD.receipt_id, 'receipt_hash', OLD.receipt_hash,
      'state', OLD.state, 'requested_at', OLD.requested_at,
      'completed_at', OLD.completed_at
    ),
    json_object(
      'purge_job_id', NEW.purge_job_id, 'attempt', NEW.attempt,
      'receipt_id', NEW.receipt_id, 'receipt_hash', NEW.receipt_hash,
      'state', NEW.state, 'requested_at', NEW.requested_at,
      'completed_at', NEW.completed_at
    ), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER recovery_frontier_secret_maintenance_insert
AFTER INSERT ON secret_purge_physical_maintenance BEGIN
  INSERT INTO recovery_frontier_changes VALUES (
    NULL, 'maintenance', 'secret_purge_physical_maintenance',
    NEW.operation_id, 'insert', NULL,
    json_object(
      'operation_id', NEW.operation_id,
      'request_digest', NEW.request_digest,
      'receipt_id', NEW.receipt_id, 'receipt_hash', NEW.receipt_hash,
      'state', NEW.state, 'requested_at', NEW.requested_at,
      'completed_at', NEW.completed_at
    ), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER recovery_frontier_secret_maintenance_update
AFTER UPDATE ON secret_purge_physical_maintenance BEGIN
  INSERT INTO recovery_frontier_changes VALUES (
    NULL, 'maintenance', 'secret_purge_physical_maintenance',
    NEW.operation_id, 'update',
    json_object(
      'operation_id', OLD.operation_id,
      'request_digest', OLD.request_digest,
      'receipt_id', OLD.receipt_id, 'receipt_hash', OLD.receipt_hash,
      'state', OLD.state, 'requested_at', OLD.requested_at,
      'completed_at', OLD.completed_at
    ),
    json_object(
      'operation_id', NEW.operation_id,
      'request_digest', NEW.request_digest,
      'receipt_id', NEW.receipt_id, 'receipt_hash', NEW.receipt_hash,
      'state', NEW.state, 'requested_at', NEW.requested_at,
      'completed_at', NEW.completed_at
    ), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER recovery_frontier_fts_update
AFTER UPDATE ON projection_state
WHEN OLD.projection_name IS NOT NEW.projection_name
  OR OLD.last_epoch IS NOT NEW.last_epoch
BEGIN
  INSERT INTO recovery_frontier_changes VALUES (
    NULL, 'fts', 'projection_state', NEW.projection_name, 'update',
    json_object('projection_name', OLD.projection_name, 'last_epoch', OLD.last_epoch),
    json_object('projection_name', NEW.projection_name, 'last_epoch', NEW.last_epoch),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER recovery_frontier_layered_update
AFTER UPDATE ON layered_projection_state BEGIN
  INSERT INTO recovery_frontier_changes VALUES (
    NULL, 'layered', 'layered_projection_state', CAST(NEW.singleton AS TEXT), 'update',
    json_object(
      'singleton', OLD.singleton, 'status', OLD.status, 'ledger_epoch', OLD.ledger_epoch,
      'tombstone_epoch', OLD.tombstone_epoch, 'projection_epoch', OLD.projection_epoch,
      'source_frontier_hash', OLD.source_frontier_hash,
      'projection_frontier_hash', OLD.projection_frontier_hash,
      'transform_versions_json', OLD.transform_versions_json
    ),
    json_object(
      'singleton', NEW.singleton, 'status', NEW.status, 'ledger_epoch', NEW.ledger_epoch,
      'tombstone_epoch', NEW.tombstone_epoch, 'projection_epoch', NEW.projection_epoch,
      'source_frontier_hash', NEW.source_frontier_hash,
      'projection_frontier_hash', NEW.projection_frontier_hash,
      'transform_versions_json', NEW.transform_versions_json
    ), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER recovery_frontier_relation_insert
AFTER INSERT ON relation_objects BEGIN
  INSERT INTO recovery_frontier_changes VALUES (
    NULL, 'relation', 'relation_objects', NEW.relation_id, 'insert', NULL,
    json_object(
      'relation_id', NEW.relation_id,
      'current_relation_revision_id', NEW.current_relation_revision_id,
      'lifecycle', NEW.lifecycle
    ), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER recovery_frontier_relation_update
AFTER UPDATE ON relation_objects BEGIN
  INSERT INTO recovery_frontier_changes VALUES (
    NULL, 'relation', 'relation_objects', NEW.relation_id, 'update',
    json_object(
      'relation_id', OLD.relation_id,
      'current_relation_revision_id', OLD.current_relation_revision_id,
      'lifecycle', OLD.lifecycle
    ),
    json_object(
      'relation_id', NEW.relation_id,
      'current_relation_revision_id', NEW.current_relation_revision_id,
      'lifecycle', NEW.lifecycle
    ), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER recovery_frontier_relation_delete
AFTER DELETE ON relation_objects BEGIN
  INSERT INTO recovery_frontier_changes VALUES (
    NULL, 'relation', 'relation_objects', OLD.relation_id, 'delete',
    json_object(
      'relation_id', OLD.relation_id,
      'current_relation_revision_id', OLD.current_relation_revision_id,
      'lifecycle', OLD.lifecycle
    ), NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER recovery_frontier_context_insert
AFTER INSERT ON context_slices BEGIN
  INSERT INTO recovery_frontier_changes VALUES (
    NULL, 'context', 'context_slices', NEW.context_slice_id, 'insert', NULL,
    json_object('context_slice_id', NEW.context_slice_id, 'frozen_hash', NEW.frozen_hash),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER recovery_frontier_context_update
AFTER UPDATE ON context_slices BEGIN
  INSERT INTO recovery_frontier_changes VALUES (
    NULL, 'context', 'context_slices', NEW.context_slice_id, 'update',
    json_object('context_slice_id', OLD.context_slice_id, 'frozen_hash', OLD.frozen_hash),
    json_object('context_slice_id', NEW.context_slice_id, 'frozen_hash', NEW.frozen_hash),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER recovery_frontier_learning_control_insert
AFTER INSERT ON learning_control_state BEGIN
  INSERT INTO recovery_frontier_changes VALUES (
    NULL, 'learning', 'learning_control_state', NEW.principal_id, 'insert', NULL,
    json_object(
      'principal_id', NEW.principal_id, 'status', NEW.status,
      'control_epoch', NEW.control_epoch, 'frontier_hash', NEW.frontier_hash,
      'runtime_identity_hash', NEW.runtime_identity_hash,
      'configuration_hash', NEW.configuration_hash, 'corpus_hash', NEW.corpus_hash
    ), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER recovery_frontier_learning_control_update
AFTER UPDATE ON learning_control_state BEGIN
  INSERT INTO recovery_frontier_changes VALUES (
    NULL, 'learning', 'learning_control_state', NEW.principal_id, 'update',
    json_object(
      'principal_id', OLD.principal_id, 'status', OLD.status,
      'control_epoch', OLD.control_epoch, 'frontier_hash', OLD.frontier_hash,
      'runtime_identity_hash', OLD.runtime_identity_hash,
      'configuration_hash', OLD.configuration_hash, 'corpus_hash', OLD.corpus_hash
    ),
    json_object(
      'principal_id', NEW.principal_id, 'status', NEW.status,
      'control_epoch', NEW.control_epoch, 'frontier_hash', NEW.frontier_hash,
      'runtime_identity_hash', NEW.runtime_identity_hash,
      'configuration_hash', NEW.configuration_hash, 'corpus_hash', NEW.corpus_hash
    ), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER recovery_frontier_learning_pointer_insert
AFTER INSERT ON learning_release_pointers BEGIN
  INSERT INTO recovery_frontier_changes VALUES (
    NULL, 'learning', 'learning_release_pointers', NEW.release_slot_hash, 'insert', NULL,
    json_object(
      'release_slot_hash', NEW.release_slot_hash,
      'active_release_id', NEW.active_release_id,
      'pointer_revision', NEW.pointer_revision, 'pointer_hash', NEW.pointer_hash
    ), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER recovery_frontier_learning_pointer_update
AFTER UPDATE ON learning_release_pointers BEGIN
  INSERT INTO recovery_frontier_changes VALUES (
    NULL, 'learning', 'learning_release_pointers', NEW.release_slot_hash, 'update',
    json_object(
      'release_slot_hash', OLD.release_slot_hash,
      'active_release_id', OLD.active_release_id,
      'pointer_revision', OLD.pointer_revision, 'pointer_hash', OLD.pointer_hash
    ),
    json_object(
      'release_slot_hash', NEW.release_slot_hash,
      'active_release_id', NEW.active_release_id,
      'pointer_revision', NEW.pointer_revision, 'pointer_hash', NEW.pointer_hash
    ), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER recovery_frontier_key_insert
AFTER INSERT ON encryption_keys BEGIN
  INSERT INTO recovery_frontier_changes VALUES (
    NULL, 'encryption', 'encryption_keys', NEW.key_id, 'insert', NULL,
    json_object(
      'key_id', NEW.key_id, 'key_generation', NEW.key_generation, 'state', NEW.state,
      'authority_key_id', NEW.authority_key_id,
      'commitment_key_id', NEW.commitment_key_id, 'created_at', NEW.created_at,
      'state_changed_at', NEW.state_changed_at
    ), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER recovery_frontier_key_update
AFTER UPDATE ON encryption_keys BEGIN
  INSERT INTO recovery_frontier_changes VALUES (
    NULL, 'encryption', 'encryption_keys', NEW.key_id, 'update',
    json_object(
      'key_id', OLD.key_id, 'key_generation', OLD.key_generation, 'state', OLD.state,
      'authority_key_id', OLD.authority_key_id,
      'commitment_key_id', OLD.commitment_key_id, 'created_at', OLD.created_at,
      'state_changed_at', OLD.state_changed_at
    ),
    json_object(
      'key_id', NEW.key_id, 'key_generation', NEW.key_generation, 'state', NEW.state,
      'authority_key_id', NEW.authority_key_id,
      'commitment_key_id', NEW.commitment_key_id, 'created_at', NEW.created_at,
      'state_changed_at', NEW.state_changed_at
    ), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER recovery_frontier_rotation_insert
AFTER INSERT ON key_rotations BEGIN
  INSERT INTO recovery_frontier_changes VALUES (
    NULL, 'encryption', 'key_rotations', NEW.rotation_id, 'insert', NULL,
    json_object(
      'rotation_id', NEW.rotation_id, 'old_key_id', NEW.old_key_id,
      'new_key_id', NEW.new_key_id, 'state', NEW.state,
      'total_items', NEW.total_items, 'rewritten_items', NEW.rewritten_items,
      'request_digest', NEW.request_digest, 'started_at', NEW.started_at,
      'updated_at', NEW.updated_at, 'completed_at', NEW.completed_at,
      'receipt_id', NEW.receipt_id
    ), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER recovery_frontier_rotation_update
AFTER UPDATE ON key_rotations BEGIN
  INSERT INTO recovery_frontier_changes VALUES (
    NULL, 'encryption', 'key_rotations', NEW.rotation_id, 'update',
    json_object(
      'rotation_id', OLD.rotation_id, 'old_key_id', OLD.old_key_id,
      'new_key_id', OLD.new_key_id, 'state', OLD.state,
      'total_items', OLD.total_items, 'rewritten_items', OLD.rewritten_items,
      'request_digest', OLD.request_digest, 'started_at', OLD.started_at,
      'updated_at', OLD.updated_at, 'completed_at', OLD.completed_at,
      'receipt_id', OLD.receipt_id
    ),
    json_object(
      'rotation_id', NEW.rotation_id, 'old_key_id', NEW.old_key_id,
      'new_key_id', NEW.new_key_id, 'state', NEW.state,
      'total_items', NEW.total_items, 'rewritten_items', NEW.rewritten_items,
      'request_digest', NEW.request_digest, 'started_at', NEW.started_at,
      'updated_at', NEW.updated_at, 'completed_at', NEW.completed_at,
      'receipt_id', NEW.receipt_id
    ), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER recovery_frontier_operational_receipt_insert
AFTER INSERT ON operational_receipts
WHEN NEW.operation_kind LIKE 'key_%' OR NEW.operation_kind = 'secret_purge'
BEGIN
  INSERT INTO recovery_frontier_changes VALUES (
    NULL, 'encryption', 'operational_receipts', NEW.receipt_id, 'insert', NULL,
    json_object(
      'operation_kind', NEW.operation_kind, 'operation_id', NEW.operation_id,
      'request_digest', NEW.request_digest, 'receipt_hash', NEW.receipt_hash
    ), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER recovery_frontier_ciphertext_insert
AFTER INSERT ON encrypted_contents BEGIN
  INSERT INTO recovery_frontier_changes VALUES (
    NULL, 'encryption', 'encrypted_contents', NEW.ciphertext_id, 'insert', NULL,
    json_object('ciphertext_id', NEW.ciphertext_id, 'key_id', NEW.key_id),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER recovery_frontier_ciphertext_delete
AFTER DELETE ON encrypted_contents BEGIN
  INSERT INTO recovery_frontier_changes VALUES (
    NULL, 'encryption', 'encrypted_contents', OLD.ciphertext_id, 'delete',
    json_object('ciphertext_id', OLD.ciphertext_id, 'key_id', OLD.key_id), NULL,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER recovery_frontier_owner_insert
AFTER INSERT ON encrypted_content_owners BEGIN
  INSERT INTO recovery_frontier_changes VALUES (
    NULL, 'encryption', 'encrypted_content_owners',
    NEW.owner_kind || char(31) || NEW.owner_id || char(31) || CAST(NEW.owner_generation AS TEXT),
    'insert', NULL,
    json_object(
      'owner_kind', NEW.owner_kind, 'owner_id', NEW.owner_id,
      'owner_generation', NEW.owner_generation, 'ciphertext_id', NEW.ciphertext_id,
      'key_id', (SELECT key_id FROM encrypted_contents WHERE ciphertext_id = NEW.ciphertext_id),
      'active', NEW.active
    ), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER recovery_frontier_owner_update
AFTER UPDATE ON encrypted_content_owners BEGIN
  INSERT INTO recovery_frontier_changes VALUES (
    NULL, 'encryption', 'encrypted_content_owners',
    NEW.owner_kind || char(31) || NEW.owner_id || char(31) || CAST(NEW.owner_generation AS TEXT),
    'update',
    json_object(
      'owner_kind', OLD.owner_kind, 'owner_id', OLD.owner_id,
      'owner_generation', OLD.owner_generation, 'ciphertext_id', OLD.ciphertext_id,
      'key_id', coalesce(
        (SELECT key_id FROM encrypted_contents WHERE ciphertext_id = OLD.ciphertext_id),
        (SELECT json_extract(row_json, '$.key_id')
         FROM recovery_frontier_rows
         WHERE component = 'encryption'
           AND table_name = 'encrypted_contents'
           AND row_key = OLD.ciphertext_id)
      ),
      'active', OLD.active
    ),
    json_object(
      'owner_kind', NEW.owner_kind, 'owner_id', NEW.owner_id,
      'owner_generation', NEW.owner_generation, 'ciphertext_id', NEW.ciphertext_id,
      'key_id', (SELECT key_id FROM encrypted_contents WHERE ciphertext_id = NEW.ciphertext_id),
      'active', NEW.active
    ), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER recovery_frontier_owner_delete
AFTER DELETE ON encrypted_content_owners BEGIN
  INSERT INTO recovery_frontier_changes VALUES (
    NULL, 'encryption', 'encrypted_content_owners',
    OLD.owner_kind || char(31) || OLD.owner_id || char(31) || CAST(OLD.owner_generation AS TEXT),
    'delete',
    json_object(
      'owner_kind', OLD.owner_kind, 'owner_id', OLD.owner_id,
      'owner_generation', OLD.owner_generation, 'ciphertext_id', OLD.ciphertext_id,
      'key_id', coalesce(
        (SELECT key_id FROM encrypted_contents WHERE ciphertext_id = OLD.ciphertext_id),
        (SELECT json_extract(row_json, '$.key_id')
         FROM recovery_frontier_rows
         WHERE component = 'encryption'
           AND table_name = 'encrypted_contents'
           AND row_key = OLD.ciphertext_id)
      ),
      'active', OLD.active
    ), NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

CREATE TRIGGER recovery_frontier_release_control_insert
AFTER INSERT ON g6_release_controls BEGIN
  INSERT INTO recovery_frontier_changes VALUES (
    NULL, 'release_control', 'g6_release_controls', NEW.control_id, 'insert', NULL,
    json_object('control_id', NEW.control_id, 'control_hash', NEW.control_hash),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;
