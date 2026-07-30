-- M6 encryption is never a plaintext backfill. A pre-0015 secret row proves
-- that the database crossed the fail-closed admission boundary and must be
-- recovered from a verified pre-secret backup before this migration can run.
CREATE TEMP TABLE operational_secret_plaintext_guard (
  secret_rows INTEGER NOT NULL CHECK (secret_rows = 0)
) STRICT;

INSERT INTO operational_secret_plaintext_guard (secret_rows)
SELECT
  (SELECT count(*) FROM evidence_events WHERE sensitivity = 'secret')
  + (SELECT count(*) FROM memory_candidates
       WHERE sensitivity = 'secret' AND purged_at IS NULL)
  + (SELECT count(*) FROM memory_revisions
       WHERE sensitivity = 'secret' AND purged_at IS NULL)
  + (SELECT count(*) FROM projection_revisions
       WHERE sensitivity = 'secret' AND purged_at IS NULL);

DROP TABLE operational_secret_plaintext_guard;

-- TRELLIS_MIGRATION_CHECKPOINT:plaintext_guard

CREATE TABLE encryption_keys (
  key_id TEXT PRIMARY KEY,
  key_generation INTEGER NOT NULL UNIQUE CHECK (key_generation > 0),
  state TEXT NOT NULL CHECK (
    state IN (
      'current',
      'rotating_to',
      'retired',
      'revoked_or_compromised',
      'unavailable'
    )
  ),
  verification_tag TEXT NOT NULL
    CHECK (
      length(verification_tag) = 55
      AND verification_tag GLOB 'hmac-sha256:[A-Za-z0-9_-]*'
    ),
  authority_key_id TEXT NOT NULL UNIQUE,
  authority_public_key_base64url TEXT NOT NULL
    CHECK (
      length(authority_public_key_base64url) = 59
      AND authority_public_key_base64url GLOB '[A-Za-z0-9_-]*'
    ),
  commitment_key_id TEXT NOT NULL UNIQUE,
  commitment_verification_tag TEXT NOT NULL
    CHECK (
      length(commitment_verification_tag) = 55
      AND commitment_verification_tag GLOB 'hmac-sha256:[A-Za-z0-9_-]*'
    ),
  created_at TEXT NOT NULL,
  state_changed_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX encryption_keys_one_current
  ON encryption_keys ((1)) WHERE state = 'current';
CREATE UNIQUE INDEX encryption_keys_one_rotating_to
  ON encryption_keys ((1)) WHERE state = 'rotating_to';

CREATE TRIGGER encryption_keys_valid_transition
BEFORE UPDATE ON encryption_keys
WHEN NOT (
  NEW.key_id IS OLD.key_id
  AND NEW.key_generation IS OLD.key_generation
  AND NEW.verification_tag IS OLD.verification_tag
  AND NEW.authority_key_id IS OLD.authority_key_id
  AND NEW.authority_public_key_base64url IS OLD.authority_public_key_base64url
  AND NEW.commitment_key_id IS OLD.commitment_key_id
  AND NEW.commitment_verification_tag IS OLD.commitment_verification_tag
  AND NEW.created_at IS OLD.created_at
  AND NEW.state_changed_at >= OLD.state_changed_at
  AND (
    NEW.state IS OLD.state
    OR (OLD.state = 'current'
      AND NEW.state IN ('retired', 'revoked_or_compromised', 'unavailable'))
    OR (OLD.state = 'rotating_to'
      AND NEW.state IN ('current', 'revoked_or_compromised', 'unavailable'))
    OR (OLD.state = 'retired'
      AND NEW.state IN ('revoked_or_compromised', 'unavailable'))
  )
) BEGIN
  SELECT RAISE(ABORT, 'INVALID_KEY_TRANSITION');
END;

CREATE TRIGGER encryption_keys_no_delete
BEFORE DELETE ON encryption_keys BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:encryption_keys');
END;

CREATE TABLE secret_nonce_reservations (
  operation_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_digest TEXT NOT NULL
    CHECK (length(request_digest) = 71 AND request_digest GLOB 'sha256:[0-9a-f]*'),
  key_id TEXT NOT NULL REFERENCES encryption_keys(key_id),
  key_generation INTEGER NOT NULL CHECK (key_generation > 0),
  nonce_base64url TEXT NOT NULL
    CHECK (length(nonce_base64url) = 16),
  aad_hash TEXT NOT NULL
    CHECK (length(aad_hash) = 71 AND aad_hash GLOB 'sha256:[0-9a-f]*'),
  keyed_plaintext_commitment TEXT NOT NULL
    CHECK (
      length(keyed_plaintext_commitment) = 55
      AND keyed_plaintext_commitment GLOB 'hmac-sha256:[A-Za-z0-9_-]*'
    ),
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('evidence', 'memory_revision')),
  owner_id TEXT NOT NULL,
  owner_generation INTEGER NOT NULL CHECK (owner_generation > 0),
  rotation_id TEXT REFERENCES key_rotations(rotation_id),
  state TEXT NOT NULL CHECK (state IN ('prepared', 'committed', 'retired')),
  ciphertext_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (key_id, nonce_base64url),
  UNIQUE (owner_kind, owner_id, owner_generation, key_generation),
  CHECK (
    (state = 'prepared' AND ciphertext_id IS NULL)
    OR
    (state IN ('committed', 'retired') AND ciphertext_id IS NOT NULL)
  )
) STRICT;

CREATE UNIQUE INDEX secret_nonce_reservations_key_nonce
  ON secret_nonce_reservations (key_id, nonce_base64url);

CREATE TRIGGER secret_nonce_reservations_valid_transition
BEFORE UPDATE ON secret_nonce_reservations
WHEN NOT (
  NEW.operation_id IS OLD.operation_id
  AND NEW.idempotency_key IS OLD.idempotency_key
  AND NEW.request_digest IS OLD.request_digest
  AND NEW.key_id IS OLD.key_id
  AND NEW.key_generation IS OLD.key_generation
  AND NEW.nonce_base64url IS OLD.nonce_base64url
  AND NEW.aad_hash IS OLD.aad_hash
  AND NEW.keyed_plaintext_commitment IS OLD.keyed_plaintext_commitment
  AND NEW.owner_kind IS OLD.owner_kind
  AND NEW.owner_id IS OLD.owner_id
  AND NEW.owner_generation IS OLD.owner_generation
  AND NEW.rotation_id IS OLD.rotation_id
  AND NEW.created_at IS OLD.created_at
  AND NEW.updated_at >= OLD.updated_at
  AND (
    (OLD.state = 'prepared' AND NEW.state IN ('prepared', 'committed'))
    OR (OLD.state = 'committed' AND NEW.state IN ('committed', 'retired'))
    OR (OLD.state = 'retired' AND NEW.state = 'retired')
  )
  AND (
    NEW.ciphertext_id IS OLD.ciphertext_id
    OR (OLD.state = 'prepared' AND NEW.state = 'committed'
      AND OLD.ciphertext_id IS NULL AND NEW.ciphertext_id IS NOT NULL)
  )
) BEGIN
  SELECT RAISE(ABORT, 'INVALID_NONCE_RESERVATION_TRANSITION');
END;

CREATE TRIGGER secret_nonce_reservations_no_delete
BEFORE DELETE ON secret_nonce_reservations BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:secret_nonce_reservations');
END;

CREATE TABLE encrypted_contents (
  ciphertext_id TEXT PRIMARY KEY,
  envelope_version INTEGER NOT NULL CHECK (envelope_version = 1),
  algorithm TEXT NOT NULL CHECK (algorithm = 'AES-256-GCM'),
  key_id TEXT NOT NULL REFERENCES encryption_keys(key_id),
  key_generation INTEGER NOT NULL CHECK (key_generation > 0),
  nonce_base64url TEXT NOT NULL CHECK (length(nonce_base64url) = 16),
  tag_base64url TEXT NOT NULL CHECK (length(tag_base64url) = 22),
  aad_json TEXT NOT NULL CHECK (json_valid(aad_json)),
  aad_hash TEXT NOT NULL
    CHECK (length(aad_hash) = 71 AND aad_hash GLOB 'sha256:[0-9a-f]*'),
  keyed_plaintext_commitment TEXT NOT NULL
    CHECK (
      length(keyed_plaintext_commitment) = 55
      AND keyed_plaintext_commitment GLOB 'hmac-sha256:[A-Za-z0-9_-]*'
    ),
  storage_kind TEXT NOT NULL
    CHECK (storage_kind IN ('inline', 'external')),
  ciphertext BLOB,
  external_relative_path TEXT UNIQUE,
  ciphertext_hash TEXT NOT NULL
    CHECK (length(ciphertext_hash) = 71 AND ciphertext_hash GLOB 'sha256:[0-9a-f]*'),
  ciphertext_size_bytes INTEGER NOT NULL CHECK (ciphertext_size_bytes > 0),
  envelope_hash TEXT NOT NULL UNIQUE
    CHECK (length(envelope_hash) = 71 AND envelope_hash GLOB 'sha256:[0-9a-f]*'),
  media_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  retired_at TEXT,
  UNIQUE (key_id, nonce_base64url),
  CHECK (
    (storage_kind = 'inline' AND ciphertext IS NOT NULL
      AND external_relative_path IS NULL
      AND ciphertext_size_bytes = length(ciphertext))
    OR
    (storage_kind = 'external' AND ciphertext IS NULL
      AND external_relative_path IS NOT NULL)
  )
) STRICT;

CREATE INDEX encrypted_contents_key_state
  ON encrypted_contents (key_id, retired_at, ciphertext_id);

CREATE TRIGGER encrypted_contents_valid_retirement
BEFORE UPDATE ON encrypted_contents
WHEN NOT (
  NEW.ciphertext_id IS OLD.ciphertext_id
  AND NEW.envelope_version IS OLD.envelope_version
  AND NEW.algorithm IS OLD.algorithm
  AND NEW.key_id IS OLD.key_id
  AND NEW.key_generation IS OLD.key_generation
  AND NEW.nonce_base64url IS OLD.nonce_base64url
  AND NEW.tag_base64url IS OLD.tag_base64url
  AND NEW.aad_json IS OLD.aad_json
  AND NEW.aad_hash IS OLD.aad_hash
  AND NEW.keyed_plaintext_commitment IS OLD.keyed_plaintext_commitment
  AND NEW.storage_kind IS OLD.storage_kind
  AND NEW.ciphertext IS OLD.ciphertext
  AND NEW.external_relative_path IS OLD.external_relative_path
  AND NEW.ciphertext_hash IS OLD.ciphertext_hash
  AND NEW.ciphertext_size_bytes IS OLD.ciphertext_size_bytes
  AND NEW.envelope_hash IS OLD.envelope_hash
  AND NEW.media_type IS OLD.media_type
  AND NEW.created_at IS OLD.created_at
  AND (
    NEW.retired_at IS OLD.retired_at
    OR (OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL)
  )
) BEGIN
  SELECT RAISE(ABORT, 'INVALID_ENCRYPTED_CONTENT_TRANSITION');
END;

CREATE TABLE encrypted_content_owners (
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('evidence', 'memory_revision')),
  owner_id TEXT NOT NULL,
  owner_generation INTEGER NOT NULL CHECK (owner_generation > 0),
  ciphertext_id TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  bound_at TEXT NOT NULL,
  retired_at TEXT,
  PRIMARY KEY (owner_kind, owner_id, owner_generation),
  CHECK (
    (active = 1 AND retired_at IS NULL)
    OR (active = 0 AND retired_at IS NOT NULL)
  )
) STRICT;

CREATE UNIQUE INDEX encrypted_content_owners_one_active
  ON encrypted_content_owners (owner_kind, owner_id)
  WHERE active = 1;

CREATE TABLE key_rotations (
  rotation_id TEXT PRIMARY KEY,
  old_key_id TEXT NOT NULL REFERENCES encryption_keys(key_id),
  new_key_id TEXT NOT NULL UNIQUE REFERENCES encryption_keys(key_id),
  state TEXT NOT NULL CHECK (
    state IN ('prepared', 'in_progress', 'completed', 'aborted', 'blocked')
  ),
  total_items INTEGER NOT NULL CHECK (total_items >= 0),
  rewritten_items INTEGER NOT NULL CHECK (
    rewritten_items >= 0 AND rewritten_items <= total_items
  ),
  request_digest TEXT NOT NULL
    CHECK (length(request_digest) = 71 AND request_digest GLOB 'sha256:[0-9a-f]*'),
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  receipt_id TEXT,
  CHECK (old_key_id <> new_key_id),
  CHECK (
    (state = 'completed' AND completed_at IS NOT NULL AND receipt_id IS NOT NULL)
    OR (state <> 'completed' AND completed_at IS NULL AND receipt_id IS NULL)
  )
) STRICT;

CREATE UNIQUE INDEX key_rotations_one_active
  ON key_rotations ((1))
  WHERE state IN ('prepared', 'in_progress', 'blocked');

CREATE TABLE key_rotation_items (
  rotation_id TEXT NOT NULL REFERENCES key_rotations(rotation_id),
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  owner_generation INTEGER NOT NULL,
  old_ciphertext_id TEXT NOT NULL REFERENCES encrypted_contents(ciphertext_id),
  new_ciphertext_id TEXT REFERENCES encrypted_contents(ciphertext_id),
  state TEXT NOT NULL CHECK (state IN ('pending', 'rewritten')),
  rewritten_at TEXT,
  PRIMARY KEY (rotation_id, owner_kind, owner_id, owner_generation),
  CHECK (
    (state = 'pending' AND new_ciphertext_id IS NULL AND rewritten_at IS NULL)
    OR
    (state = 'rewritten' AND new_ciphertext_id IS NOT NULL AND rewritten_at IS NOT NULL)
  )
) STRICT;

CREATE TABLE encrypted_artifact_operations (
  operation_id TEXT PRIMARY KEY,
  ciphertext_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'committed', 'retired')),
  relative_path TEXT NOT NULL UNIQUE,
  temporary_relative_path TEXT,
  ciphertext_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER encrypted_artifact_operations_valid_transition
BEFORE UPDATE ON encrypted_artifact_operations
WHEN NOT (
  NEW.operation_id IS OLD.operation_id
  AND NEW.ciphertext_id IS OLD.ciphertext_id
  AND NEW.relative_path IS OLD.relative_path
  AND NEW.ciphertext_hash IS OLD.ciphertext_hash
  AND NEW.size_bytes IS OLD.size_bytes
  AND NEW.created_at IS OLD.created_at
  AND NEW.updated_at >= OLD.updated_at
  AND (
    (OLD.state = 'prepared' AND NEW.state IN ('prepared', 'committed', 'retired'))
    OR (OLD.state = 'committed' AND NEW.state IN ('committed', 'retired'))
    OR (OLD.state = 'retired' AND NEW.state = 'retired')
  )
  AND (
    NEW.temporary_relative_path IS OLD.temporary_relative_path
    OR (OLD.state = 'prepared' AND NEW.state IN ('committed', 'retired')
      AND NEW.temporary_relative_path IS NULL)
  )
) BEGIN
  SELECT RAISE(ABORT, 'INVALID_ENCRYPTED_ARTIFACT_TRANSITION');
END;

CREATE TRIGGER encrypted_artifact_operations_no_delete
BEFORE DELETE ON encrypted_artifact_operations BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:encrypted_artifact_operations');
END;

-- TRELLIS_MIGRATION_CHECKPOINT:encrypted_storage_schema

CREATE TABLE artifact_store_registry (
  store_id TEXT PRIMARY KEY,
  store_version INTEGER NOT NULL CHECK (store_version > 0),
  required_for_purge INTEGER NOT NULL CHECK (required_for_purge IN (0, 1)),
  registered_at TEXT NOT NULL
) STRICT;

INSERT INTO artifact_store_registry (
  store_id, store_version, required_for_purge, registered_at
) VALUES
  ('canonical_evidence', 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('canonical_memory', 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('fts', 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('context', 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('layered_projection', 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('graph_projection_disabled', 1, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('vector_projection_disabled', 1, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('learning', 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('blobs', 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('encrypted_content', 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('backups', 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('operational_artifacts', 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TRIGGER artifact_store_registry_no_update
BEFORE UPDATE ON artifact_store_registry BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:artifact_store_registry');
END;

CREATE TRIGGER artifact_store_registry_no_delete
BEFORE DELETE ON artifact_store_registry BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:artifact_store_registry');
END;

CREATE TABLE artifact_purge_frontiers (
  store_id TEXT PRIMARY KEY REFERENCES artifact_store_registry(store_id),
  tombstone_epoch INTEGER NOT NULL CHECK (tombstone_epoch >= 0),
  debt_count INTEGER NOT NULL CHECK (debt_count >= 0),
  frontier_hash TEXT NOT NULL
    CHECK (length(frontier_hash) = 71 AND frontier_hash GLOB 'sha256:[0-9a-f]*'),
  updated_at TEXT NOT NULL
) STRICT;

-- TRELLIS_MIGRATION_CHECKPOINT:purge_registry

CREATE TABLE operational_receipts (
  receipt_id TEXT PRIMARY KEY,
  operation_kind TEXT NOT NULL CHECK (
    operation_kind IN (
      'key_install',
      'key_rotation_begin',
      'key_rotation_item',
      'key_rotation_complete',
      'key_rotation_abort',
      'key_revoke',
      'secret_admit',
      'secret_use_authority',
      'secret_purge'
    )
  ),
  operation_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  receipt_hash TEXT NOT NULL UNIQUE,
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  created_at TEXT NOT NULL,
  UNIQUE (operation_kind, operation_id, request_digest)
) STRICT;

CREATE TRIGGER operational_receipts_no_update
BEFORE UPDATE ON operational_receipts BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:operational_receipts');
END;

CREATE TRIGGER operational_receipts_no_delete
BEFORE DELETE ON operational_receipts BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:operational_receipts');
END;

CREATE TABLE secret_authority_consumptions (
  authority_id TEXT PRIMARY KEY,
  authority_kind TEXT NOT NULL CHECK (authority_kind IN ('admission', 'use')),
  authority_hash TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL REFERENCES operational_receipts(receipt_id),
  consumed_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER secret_authority_consumptions_no_update
BEFORE UPDATE ON secret_authority_consumptions BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:secret_authority_consumptions');
END;

CREATE TRIGGER secret_authority_consumptions_no_delete
BEFORE DELETE ON secret_authority_consumptions BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:secret_authority_consumptions');
END;

-- TRELLIS_MIGRATION_CHECKPOINT:operational_authority

CREATE TABLE g6_release_controls (
  control_id TEXT PRIMARY KEY,
  runtime_identity_hash TEXT NOT NULL,
  tested_envelope_digest TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('GO', 'NO-GO')),
  secret_admission_allowed INTEGER NOT NULL
    CHECK (secret_admission_allowed IN (0, 1)),
  control_hash TEXT NOT NULL UNIQUE,
  control_json TEXT NOT NULL CHECK (json_valid(control_json)),
  installed_at TEXT NOT NULL,
  CHECK (
    (decision = 'GO' AND secret_admission_allowed = 1)
    OR (decision = 'NO-GO' AND secret_admission_allowed = 0)
  )
) STRICT;

CREATE UNIQUE INDEX g6_release_controls_one_current
  ON g6_release_controls ((1));

-- TRELLIS_MIGRATION_CHECKPOINT:release_control
