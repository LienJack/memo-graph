CREATE TABLE recovery_root_identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  root_id TEXT NOT NULL UNIQUE,
  principal_id TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER recovery_root_identity_no_update
BEFORE UPDATE ON recovery_root_identity BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:recovery_root_identity');
END;

CREATE TRIGGER recovery_root_identity_no_delete
BEFORE DELETE ON recovery_root_identity BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:recovery_root_identity');
END;

CREATE TABLE complete_backup_manifests (
  backup_id TEXT PRIMARY KEY REFERENCES backup_manifests(backup_id),
  manifest_hash TEXT NOT NULL UNIQUE
    CHECK (
      length(manifest_hash) = 71
      AND manifest_hash GLOB 'sha256:[0-9a-f]*'
    ),
  database_raw_hash TEXT NOT NULL
    CHECK (
      length(database_raw_hash) = 71
      AND database_raw_hash GLOB 'sha256:[0-9a-f]*'
    ),
  database_logical_hash TEXT NOT NULL
    CHECK (
      length(database_logical_hash) = 71
      AND database_logical_hash GLOB 'sha256:[0-9a-f]*'
    ),
  root_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE backup_manifest_purge_authorizations (
  backup_id TEXT PRIMARY KEY,
  authorized_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER backup_manifest_purge_authorizations_no_update
BEFORE UPDATE ON backup_manifest_purge_authorizations BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:backup_manifest_purge_authorizations');
END;

CREATE TRIGGER complete_backup_manifests_no_update
BEFORE UPDATE ON complete_backup_manifests BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:complete_backup_manifests');
END;

CREATE TRIGGER complete_backup_manifests_no_delete
BEFORE DELETE ON complete_backup_manifests
WHEN NOT EXISTS (
  SELECT 1 FROM backup_manifest_purge_authorizations
  WHERE backup_id = OLD.backup_id
) BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:complete_backup_manifests');
END;

CREATE TABLE backup_artifact_inventory (
  backup_id TEXT NOT NULL
    REFERENCES complete_backup_manifests(backup_id),
  artifact_id TEXT NOT NULL,
  artifact_kind TEXT NOT NULL
    CHECK (artifact_kind IN ('blob', 'ciphertext')),
  storage_kind TEXT NOT NULL
    CHECK (storage_kind IN ('inline', 'external')),
  bundle_path TEXT,
  raw_hash TEXT NOT NULL
    CHECK (
      length(raw_hash) = 71
      AND raw_hash GLOB 'sha256:[0-9a-f]*'
    ),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  PRIMARY KEY (backup_id, artifact_kind, artifact_id),
  UNIQUE (backup_id, bundle_path),
  CHECK (
    (storage_kind = 'inline' AND artifact_kind = 'ciphertext'
      AND bundle_path IS NULL)
    OR
    (storage_kind = 'external' AND bundle_path IS NOT NULL)
  )
) STRICT;

CREATE TRIGGER backup_artifact_inventory_no_update
BEFORE UPDATE ON backup_artifact_inventory BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:backup_artifact_inventory');
END;

CREATE TRIGGER backup_artifact_inventory_no_delete
BEFORE DELETE ON backup_artifact_inventory
WHEN NOT EXISTS (
  SELECT 1 FROM backup_manifest_purge_authorizations
  WHERE backup_id = OLD.backup_id
) BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:backup_artifact_inventory');
END;

CREATE TABLE backup_manifest_purge_intents (
  backup_id TEXT PRIMARY KEY,
  relative_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER backup_manifest_purge_intents_no_update
BEFORE UPDATE ON backup_manifest_purge_intents BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:backup_manifest_purge_intents');
END;

CREATE TABLE recovery_anchored_effects (
  pending_id TEXT PRIMARY KEY,
  operation_kind TEXT NOT NULL CHECK (
    operation_kind IN (
      'canonical',
      'control',
      'purge',
      'projection',
      'context',
      'learning',
      'key',
      'release_control'
    )
  ),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  prior_minimums_hash TEXT NOT NULL,
  prior_state_commitment_hash TEXT NOT NULL,
  prior_head_hash TEXT,
  committed_minimums_json TEXT NOT NULL,
  committed_state_commitment_hash TEXT NOT NULL,
  root_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  backup_manifest_hash TEXT,
  effect_receipt_hash TEXT,
  state TEXT NOT NULL
    CHECK (state IN ('effect_committed', 'reconciled')),
  anchor_hash TEXT,
  created_at TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  reconciled_at TEXT,
  CHECK (
    (state = 'effect_committed' AND reconciled_at IS NULL AND anchor_hash IS NULL)
    OR
    (state = 'reconciled' AND reconciled_at IS NOT NULL AND anchor_hash IS NOT NULL)
  )
) STRICT;

CREATE INDEX recovery_anchored_effects_idempotency
ON recovery_anchored_effects(idempotency_key, request_hash, prior_head_hash);

CREATE TRIGGER recovery_anchored_effects_valid_transition
BEFORE UPDATE ON recovery_anchored_effects
WHEN NOT (
  NEW.pending_id IS OLD.pending_id
  AND NEW.operation_kind IS OLD.operation_kind
  AND NEW.idempotency_key IS OLD.idempotency_key
  AND NEW.request_hash IS OLD.request_hash
  AND NEW.prior_minimums_hash IS OLD.prior_minimums_hash
  AND NEW.prior_state_commitment_hash IS OLD.prior_state_commitment_hash
  AND NEW.prior_head_hash IS OLD.prior_head_hash
  AND NEW.committed_minimums_json IS OLD.committed_minimums_json
  AND NEW.committed_state_commitment_hash IS OLD.committed_state_commitment_hash
  AND NEW.root_id IS OLD.root_id
  AND NEW.principal_id IS OLD.principal_id
  AND NEW.backup_manifest_hash IS OLD.backup_manifest_hash
  AND NEW.effect_receipt_hash IS OLD.effect_receipt_hash
  AND NEW.created_at IS OLD.created_at
  AND NEW.committed_at IS OLD.committed_at
  AND OLD.state = 'effect_committed'
  AND NEW.state = 'reconciled'
  AND OLD.anchor_hash IS NULL
  AND NEW.anchor_hash IS NOT NULL
  AND OLD.reconciled_at IS NULL
  AND NEW.reconciled_at IS NOT NULL
) BEGIN
  SELECT RAISE(ABORT, 'INVALID_RECOVERY_ANCHOR_TRANSITION');
END;

CREATE TRIGGER recovery_anchored_effects_no_delete
BEFORE DELETE ON recovery_anchored_effects BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:recovery_anchored_effects');
END;

CREATE TABLE recovery_anchor_checkpoint (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  anchor_hash TEXT,
  state_commitment_hash TEXT,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  updated_at TEXT,
  CHECK (
    (generation = 0 AND anchor_hash IS NULL
      AND state_commitment_hash IS NULL AND updated_at IS NULL)
    OR
    (generation > 0 AND anchor_hash IS NOT NULL
      AND state_commitment_hash IS NOT NULL AND updated_at IS NOT NULL)
  )
) STRICT;

INSERT INTO recovery_anchor_checkpoint (
  singleton, anchor_hash, state_commitment_hash, generation, updated_at
) VALUES (1, NULL, NULL, 0, NULL);

CREATE TRIGGER recovery_anchor_checkpoint_no_delete
BEFORE DELETE ON recovery_anchor_checkpoint BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:recovery_anchor_checkpoint');
END;
