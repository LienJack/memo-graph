DROP TRIGGER memory_candidate_links_no_update;
DROP TRIGGER memory_candidate_links_no_delete;
DROP TRIGGER memory_candidates_no_update;
ALTER TABLE memory_candidate_links RENAME TO memory_candidate_links_legacy;

CREATE TABLE memory_candidate_links (
  candidate_id TEXT PRIMARY KEY REFERENCES memory_candidates(candidate_id),
  memory_id TEXT NOT NULL REFERENCES memory_objects(memory_id),
  revision_id TEXT REFERENCES memory_revisions(revision_id),
  linked_at TEXT NOT NULL
) STRICT;

INSERT INTO memory_candidate_links (
  candidate_id, memory_id, revision_id, linked_at
)
SELECT candidate_id, memory_id, revision_id, linked_at
FROM memory_candidate_links_legacy;

DROP TABLE memory_candidate_links_legacy;

CREATE INDEX memory_candidate_links_memory_revision
  ON memory_candidate_links (memory_id, revision_id, candidate_id);

CREATE TRIGGER memory_candidate_links_no_update
BEFORE UPDATE ON memory_candidate_links BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:memory_candidate_links');
END;
CREATE TRIGGER memory_candidate_links_no_delete
BEFORE DELETE ON memory_candidate_links BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:memory_candidate_links');
END;

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

CREATE TABLE governance_mutation_results (
  receipt_id TEXT PRIMARY KEY REFERENCES mutation_receipts(receipt_id),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER governance_mutation_results_no_update
BEFORE UPDATE ON governance_mutation_results BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:governance_mutation_results');
END;
CREATE TRIGGER governance_mutation_results_no_delete
BEFORE DELETE ON governance_mutation_results BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:governance_mutation_results');
END;
