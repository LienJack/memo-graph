ALTER TABLE artifact_purge_frontiers
  ADD COLUMN source_purge_job_id TEXT REFERENCES purge_jobs(purge_job_id);

CREATE TABLE operational_purge_audits (
  audit_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL UNIQUE,
  tombstone_epoch INTEGER NOT NULL CHECK (tombstone_epoch >= 0),
  audit_hash TEXT NOT NULL UNIQUE,
  audit_json TEXT NOT NULL CHECK (json_valid(audit_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER operational_purge_audits_no_update
BEFORE UPDATE ON operational_purge_audits BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:operational_purge_audits');
END;

CREATE TRIGGER operational_purge_audits_no_delete
BEFORE DELETE ON operational_purge_audits BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:operational_purge_audits');
END;

CREATE TABLE operator_action_receipts (
  receipt_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  command TEXT NOT NULL,
  intent_hash TEXT NOT NULL UNIQUE,
  confirmation_id TEXT NOT NULL UNIQUE,
  receipt_hash TEXT NOT NULL UNIQUE,
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER operator_action_receipts_no_update
BEFORE UPDATE ON operator_action_receipts BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:operator_action_receipts');
END;

CREATE TRIGGER operator_action_receipts_no_delete
BEFORE DELETE ON operator_action_receipts BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:operator_action_receipts');
END;

CREATE TABLE operator_confirmation_bindings (
  confirmation_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  intent_hash TEXT NOT NULL UNIQUE,
  command TEXT NOT NULL,
  parameters_digest TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER operator_confirmation_bindings_no_update
BEFORE UPDATE ON operator_confirmation_bindings BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:operator_confirmation_bindings');
END;

CREATE TRIGGER operator_confirmation_bindings_no_delete
BEFORE DELETE ON operator_confirmation_bindings BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:operator_confirmation_bindings');
END;

CREATE TABLE operator_purge_attempts (
  operation_id TEXT PRIMARY KEY,
  purge_job_id TEXT NOT NULL REFERENCES purge_jobs(purge_job_id),
  expected_prior_receipt_id TEXT,
  receipt_id TEXT NOT NULL UNIQUE REFERENCES purge_receipts(receipt_id),
  created_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER operator_purge_attempts_no_update
BEFORE UPDATE ON operator_purge_attempts BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:operator_purge_attempts');
END;

CREATE TRIGGER operator_purge_attempts_no_delete
BEFORE DELETE ON operator_purge_attempts BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:operator_purge_attempts');
END;

CREATE TABLE operational_repair_jobs (
  operation_id TEXT PRIMARY KEY,
  repair_kind TEXT NOT NULL CHECK (
    repair_kind IN ('fts', 'layered_projection', 'sqlite_relations')
  ),
  request_hash TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (
    state IN ('rebuilding', 'completed', 'blocked')
  ),
  source_frontier_hash TEXT NOT NULL,
  artifact_count INTEGER CHECK (
    artifact_count IS NULL OR artifact_count >= 0
  ),
  relation_count INTEGER CHECK (
    relation_count IS NULL OR relation_count >= 0
  ),
  ledger_epoch INTEGER CHECK (
    ledger_epoch IS NULL OR ledger_epoch >= 0
  ),
  result_hash TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (
    (state = 'rebuilding'
      AND artifact_count IS NULL
      AND relation_count IS NULL
      AND ledger_epoch IS NULL
      AND result_hash IS NULL
      AND completed_at IS NULL)
    OR
    (state IN ('completed', 'blocked')
      AND artifact_count IS NOT NULL
      AND relation_count IS NOT NULL
      AND ledger_epoch IS NOT NULL
      AND result_hash IS NOT NULL AND completed_at IS NOT NULL)
  )
) STRICT;

CREATE TRIGGER operational_repair_jobs_valid_transition
BEFORE UPDATE ON operational_repair_jobs
WHEN NOT (
  NEW.operation_id IS OLD.operation_id
  AND NEW.repair_kind IS OLD.repair_kind
  AND NEW.request_hash IS OLD.request_hash
  AND NEW.source_frontier_hash IS OLD.source_frontier_hash
  AND NEW.started_at IS OLD.started_at
  AND OLD.state = 'rebuilding'
  AND NEW.state IN ('completed', 'blocked')
  AND OLD.artifact_count IS NULL
  AND NEW.artifact_count IS NOT NULL
  AND OLD.relation_count IS NULL
  AND NEW.relation_count IS NOT NULL
  AND OLD.ledger_epoch IS NULL
  AND NEW.ledger_epoch IS NOT NULL
  AND OLD.result_hash IS NULL
  AND NEW.result_hash IS NOT NULL
  AND OLD.completed_at IS NULL
  AND NEW.completed_at IS NOT NULL
) BEGIN
  SELECT RAISE(ABORT, 'INVALID_OPERATIONAL_REPAIR_TRANSITION');
END;

CREATE TRIGGER operational_repair_jobs_no_delete
BEFORE DELETE ON operational_repair_jobs BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:operational_repair_jobs');
END;
