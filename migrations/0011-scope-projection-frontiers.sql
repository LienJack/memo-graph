CREATE TABLE layered_projection_scope_state (
  principal_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL
    CHECK (
      scope_kind IN (
        'thread', 'topic', 'scenario', 'user', 'workspace', 'agent'
      )
    ),
  scope_id TEXT NOT NULL,
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
  error_code TEXT,
  PRIMARY KEY (principal_id, scope_kind, scope_id),
  CHECK (
    status <> 'ready'
    OR (
      source_frontier_hash IS NOT NULL
      AND projection_frontier_hash IS NOT NULL
    )
  )
) STRICT;

CREATE INDEX layered_projection_scope_state_status
  ON layered_projection_scope_state (
    status,
    principal_id,
    scope_kind,
    scope_id
  );

CREATE TRIGGER layered_projection_scope_state_guarded_insert
BEFORE INSERT ON layered_projection_scope_state
WHEN NOT EXISTS (
  SELECT 1 FROM projection_write_guard WHERE singleton = 1
)
BEGIN
  SELECT RAISE(ABORT, 'PROJECTION_TRANSACTION_REQUIRED');
END;

CREATE TRIGGER layered_projection_scope_state_guarded_update
BEFORE UPDATE ON layered_projection_scope_state
WHEN NOT EXISTS (
  SELECT 1 FROM projection_write_guard WHERE singleton = 1
)
OR NEW.principal_id <> OLD.principal_id
OR NEW.scope_kind <> OLD.scope_kind
OR NEW.scope_id <> OLD.scope_id
OR NEW.ledger_epoch < OLD.ledger_epoch
OR NEW.tombstone_epoch < OLD.tombstone_epoch
OR NEW.projection_epoch < OLD.projection_epoch
BEGIN
  SELECT RAISE(ABORT, 'PROJECTION_TRANSACTION_REQUIRED');
END;

CREATE TRIGGER layered_projection_scope_state_no_delete
BEFORE DELETE ON layered_projection_scope_state BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:layered_projection_scope_state');
END;
