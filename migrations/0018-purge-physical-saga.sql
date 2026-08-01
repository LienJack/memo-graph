CREATE TABLE purge_blob_deletion_intents (
  purge_job_id TEXT NOT NULL REFERENCES purge_jobs(purge_job_id),
  content_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (purge_job_id, content_hash),
  CHECK (
    (state = 'pending' AND completed_at IS NULL)
    OR
    (state = 'completed' AND completed_at IS NOT NULL)
  )
) STRICT;

CREATE INDEX evidence_events_payload_blob_hash
  ON evidence_events (payload_blob_hash)
  WHERE payload_blob_hash IS NOT NULL;

CREATE INDEX memory_candidates_content_blob_hash
  ON memory_candidates (content_blob_hash)
  WHERE content_blob_hash IS NOT NULL;

CREATE INDEX memory_revisions_content_blob_hash
  ON memory_revisions (content_blob_hash)
  WHERE content_blob_hash IS NOT NULL;

CREATE INDEX purge_blob_deletion_intents_state
  ON purge_blob_deletion_intents (
    purge_job_id, state, content_hash
  );

CREATE TRIGGER artifacts_block_pending_purge_intent
BEFORE INSERT ON artifacts
WHEN EXISTS (
  SELECT 1
  FROM purge_blob_deletion_intents AS intent
  WHERE intent.content_hash = NEW.content_hash
    AND intent.state = 'pending'
) BEGIN
  SELECT RAISE(ABORT, 'PENDING_PURGE_BLOB_INTENT');
END;

CREATE TRIGGER purge_blob_deletion_intents_valid_transition
BEFORE UPDATE ON purge_blob_deletion_intents
WHEN NOT (
  NEW.purge_job_id IS OLD.purge_job_id
  AND NEW.content_hash IS OLD.content_hash
  AND NEW.created_at IS OLD.created_at
  AND OLD.state = 'pending'
  AND NEW.state = 'completed'
  AND OLD.completed_at IS NULL
  AND NEW.completed_at IS NOT NULL
) BEGIN
  SELECT RAISE(ABORT, 'INVALID_PURGE_BLOB_INTENT_TRANSITION');
END;

CREATE TRIGGER purge_blob_deletion_intents_no_delete
BEFORE DELETE ON purge_blob_deletion_intents BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:purge_blob_deletion_intents');
END;

CREATE TABLE purge_physical_maintenance (
  purge_job_id TEXT NOT NULL REFERENCES purge_jobs(purge_job_id),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
  outcomes_hash TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (purge_job_id, attempt),
  CHECK (
    (state = 'pending' AND completed_at IS NULL)
    OR
    (state = 'completed' AND completed_at IS NOT NULL)
  )
) STRICT;

CREATE UNIQUE INDEX purge_physical_maintenance_one_pending
  ON purge_physical_maintenance (purge_job_id)
  WHERE state = 'pending';

CREATE TRIGGER purge_physical_maintenance_valid_transition
BEFORE UPDATE ON purge_physical_maintenance
WHEN NOT (
  NEW.purge_job_id IS OLD.purge_job_id
  AND NEW.attempt IS OLD.attempt
  AND NEW.outcomes_hash IS OLD.outcomes_hash
  AND NEW.requested_at IS OLD.requested_at
  AND OLD.state = 'pending'
  AND NEW.state = 'completed'
  AND OLD.completed_at IS NULL
  AND NEW.completed_at IS NOT NULL
) BEGIN
  SELECT RAISE(ABORT, 'INVALID_PURGE_MAINTENANCE_TRANSITION');
END;

CREATE TRIGGER purge_physical_maintenance_no_delete
BEFORE DELETE ON purge_physical_maintenance BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:purge_physical_maintenance');
END;

-- Schema 0017 published a completed purge receipt before VACUUM and WAL
-- truncation. A process exit in that window is indistinguishable from a
-- fully maintained purge, so every completed 0017 job is conservatively
-- carried forward as physical-cleanup debt. The historical receipt remains
-- immutable and is the binding for the one idempotent cleanup obligation.
CREATE TABLE purge_legacy_physical_maintenance (
  purge_job_id TEXT PRIMARY KEY REFERENCES purge_jobs(purge_job_id),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  receipt_id TEXT NOT NULL UNIQUE REFERENCES purge_receipts(receipt_id),
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

INSERT INTO purge_legacy_physical_maintenance (
  purge_job_id, attempt, receipt_id, receipt_hash, state, requested_at,
  completed_at
)
SELECT
  job.purge_job_id,
  job.attempts,
  (
    SELECT receipt.receipt_id
    FROM purge_receipts AS receipt
    WHERE receipt.purge_job_id = job.purge_job_id
      AND receipt.state = 'purged'
    ORDER BY receipt.created_at DESC, receipt.receipt_id DESC
    LIMIT 1
  ),
  (
    SELECT receipt.receipt_hash
    FROM purge_receipts AS receipt
    WHERE receipt.purge_job_id = job.purge_job_id
      AND receipt.state = 'purged'
    ORDER BY receipt.created_at DESC, receipt.receipt_id DESC
    LIMIT 1
  ),
  'pending',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  NULL
FROM purge_jobs AS job
WHERE job.status = 'completed';

CREATE INDEX purge_legacy_physical_maintenance_state
  ON purge_legacy_physical_maintenance (state, purge_job_id);

CREATE TRIGGER purge_legacy_physical_maintenance_valid_transition
BEFORE UPDATE ON purge_legacy_physical_maintenance
WHEN NOT (
  NEW.purge_job_id IS OLD.purge_job_id
  AND NEW.attempt IS OLD.attempt
  AND NEW.receipt_id IS OLD.receipt_id
  AND NEW.receipt_hash IS OLD.receipt_hash
  AND NEW.requested_at IS OLD.requested_at
  AND OLD.state = 'pending'
  AND NEW.state = 'completed'
  AND OLD.completed_at IS NULL
  AND NEW.completed_at IS NOT NULL
) BEGIN
  SELECT RAISE(ABORT, 'INVALID_LEGACY_PURGE_MAINTENANCE_TRANSITION');
END;

CREATE TRIGGER purge_legacy_physical_maintenance_no_delete
BEFORE DELETE ON purge_legacy_physical_maintenance BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:purge_legacy_physical_maintenance');
END;

-- A legacy receipt may already be bound to its historical operator attempt.
-- Cleanup is a new physical obligation, so bind its confirmation separately
-- without weakening the immutable one-receipt rule in the 0017 table.
CREATE TABLE operator_legacy_purge_cleanup_attempts (
  operation_id TEXT PRIMARY KEY,
  purge_job_id TEXT NOT NULL UNIQUE REFERENCES purge_jobs(purge_job_id),
  expected_prior_receipt_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL UNIQUE REFERENCES purge_receipts(receipt_id),
  created_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER operator_legacy_purge_cleanup_attempts_no_update
BEFORE UPDATE ON operator_legacy_purge_cleanup_attempts BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:operator_legacy_purge_cleanup_attempts');
END;

CREATE TRIGGER operator_legacy_purge_cleanup_attempts_no_delete
BEFORE DELETE ON operator_legacy_purge_cleanup_attempts BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:operator_legacy_purge_cleanup_attempts');
END;
