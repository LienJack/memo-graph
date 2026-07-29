CREATE TABLE learning_write_guard (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  operation TEXT NOT NULL,
  opened_at TEXT NOT NULL
) STRICT;

CREATE TABLE learning_traces (
  trace_id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
  trace_hash TEXT NOT NULL UNIQUE
    CHECK (
      length(trace_hash) = 71
      AND substr(trace_hash, 1, 7) = 'sha256:'
      AND substr(trace_hash, 8) NOT GLOB '*[^0-9a-f]*'
    ),
  control_epoch INTEGER NOT NULL CHECK (control_epoch >= 0),
  artifact_json TEXT NOT NULL CHECK (json_valid(artifact_json)),
  captured_at TEXT NOT NULL
) STRICT;

CREATE INDEX learning_traces_principal_scopes
  ON learning_traces (principal_id, scopes_json, captured_at, trace_id);

CREATE TABLE learning_trace_evidence_refs (
  trace_id TEXT NOT NULL REFERENCES learning_traces(trace_id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  step_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  media_type TEXT NOT NULL,
  PRIMARY KEY (trace_id, ordinal),
  UNIQUE (trace_id, step_id),
  UNIQUE (trace_id, evidence_id)
) STRICT;

CREATE TABLE learning_candidates (
  candidate_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
  candidate_type TEXT NOT NULL
    CHECK (
      candidate_type IN (
        'memory', 'procedure', 'retrieval_policy', 'prompt',
        'core_projection', 'scenario_pattern'
      )
    ),
  release_capability TEXT NOT NULL
    CHECK (release_capability IN ('release_capable', 'evaluation_only')),
  release_slot_hash TEXT,
  target_kind TEXT NOT NULL
    CHECK (
      target_kind IN (
        'memory', 'procedure', 'retrieval_policy', 'evaluation_only'
      )
    ),
  target_memory_id TEXT REFERENCES memory_objects(memory_id),
  target_revision_id TEXT REFERENCES memory_revisions(revision_id),
  target_content_hash TEXT,
  candidate_hash TEXT NOT NULL UNIQUE,
  artifact_json TEXT NOT NULL CHECK (json_valid(artifact_json)),
  proposed_at TEXT NOT NULL,
  CHECK (
    (
      target_kind IN ('memory', 'procedure')
      AND target_memory_id IS NOT NULL
      AND target_revision_id IS NOT NULL
      AND target_content_hash IS NOT NULL
    )
    OR
    (
      target_kind NOT IN ('memory', 'procedure')
      AND target_memory_id IS NULL
      AND target_revision_id IS NULL
      AND target_content_hash IS NULL
    )
  )
) STRICT;

CREATE INDEX learning_candidates_principal_scopes
  ON learning_candidates (
    principal_id, scopes_json, candidate_type, proposed_at, candidate_id
  );
CREATE INDEX learning_candidates_release_slot
  ON learning_candidates (release_slot_hash, proposed_at, candidate_id);
CREATE INDEX learning_candidates_target_memory
  ON learning_candidates (
    target_memory_id, target_revision_id, proposed_at, candidate_id
  );

CREATE TABLE learning_candidate_traces (
  candidate_id TEXT NOT NULL REFERENCES learning_candidates(candidate_id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  trace_id TEXT NOT NULL REFERENCES learning_traces(trace_id),
  PRIMARY KEY (candidate_id, ordinal),
  UNIQUE (candidate_id, trace_id)
) STRICT;

CREATE TABLE learning_candidate_evidence (
  candidate_id TEXT NOT NULL REFERENCES learning_candidates(candidate_id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  evidence_id TEXT NOT NULL,
  PRIMARY KEY (candidate_id, ordinal),
  UNIQUE (candidate_id, evidence_id)
) STRICT;

CREATE TABLE learning_candidate_transitions (
  transition_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES learning_candidates(candidate_id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  from_state TEXT NOT NULL
    CHECK (
      from_state IN (
        'proposed', 'quarantined', 'evaluating', 'approved_for_canary',
        'canary', 'rejected', 'released', 'rolled_back'
      )
    ),
  to_state TEXT NOT NULL
    CHECK (
      to_state IN (
        'proposed', 'quarantined', 'evaluating', 'approved_for_canary',
        'canary', 'rejected', 'released', 'rolled_back'
      )
    ),
  expected_previous_transition_hash TEXT,
  transition_hash TEXT NOT NULL UNIQUE,
  artifact_json TEXT NOT NULL CHECK (json_valid(artifact_json)),
  transitioned_at TEXT NOT NULL,
  UNIQUE (candidate_id, sequence)
) STRICT;

CREATE INDEX learning_candidate_transitions_current
  ON learning_candidate_transitions (candidate_id, sequence DESC);

CREATE TABLE learning_partition_seals (
  seal_id TEXT PRIMARY KEY,
  partition TEXT NOT NULL
    CHECK (partition IN ('calibration', 'holdout', 'transfer')),
  manifest_hash TEXT NOT NULL,
  case_hashes_json TEXT NOT NULL CHECK (json_valid(case_hashes_json)),
  oracle_hashes_json TEXT NOT NULL CHECK (json_valid(oracle_hashes_json)),
  sealed_at TEXT NOT NULL,
  UNIQUE (partition, manifest_hash)
) STRICT;

CREATE TABLE learning_evaluation_runs (
  run_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES learning_candidates(candidate_id),
  principal_id TEXT NOT NULL,
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
  common_identity_hash TEXT NOT NULL UNIQUE,
  identity_json TEXT NOT NULL CHECK (json_valid(identity_json)),
  started_at TEXT NOT NULL
) STRICT;

CREATE TABLE learning_evaluation_result_sets (
  result_set_hash TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES learning_evaluation_runs(run_id),
  case_id TEXT NOT NULL,
  partition TEXT NOT NULL
    CHECK (partition IN ('calibration', 'holdout', 'transfer')),
  common_identity_hash TEXT NOT NULL,
  artifact_json TEXT NOT NULL CHECK (json_valid(artifact_json)),
  UNIQUE (run_id, case_id, partition)
) STRICT;

CREATE TABLE learning_evaluation_results (
  eval_result_id TEXT PRIMARY KEY,
  result_set_hash TEXT NOT NULL
    REFERENCES learning_evaluation_result_sets(result_set_hash),
  run_id TEXT NOT NULL REFERENCES learning_evaluation_runs(run_id),
  case_id TEXT NOT NULL,
  partition TEXT NOT NULL,
  arm TEXT NOT NULL
    CHECK (arm IN ('no_candidate', 'current', 'candidate')),
  result_hash TEXT NOT NULL UNIQUE,
  artifact_json TEXT NOT NULL CHECK (json_valid(artifact_json)),
  UNIQUE (run_id, case_id, partition, arm)
) STRICT;

CREATE TABLE learning_contamination_events (
  contamination_event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES learning_evaluation_runs(run_id),
  partition TEXT NOT NULL
    CHECK (partition IN ('calibration', 'holdout', 'transfer')),
  case_id TEXT,
  code TEXT NOT NULL,
  event_hash TEXT NOT NULL UNIQUE,
  artifact_json TEXT NOT NULL CHECK (json_valid(artifact_json)),
  detected_at TEXT NOT NULL
) STRICT;

CREATE TABLE learning_canary_authorizations (
  authorization_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES learning_candidates(candidate_id),
  authorization_hash TEXT NOT NULL UNIQUE,
  artifact_json TEXT NOT NULL CHECK (json_valid(artifact_json)),
  issued_at TEXT NOT NULL
) STRICT;

CREATE TABLE learning_canary_runs (
  canary_run_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES learning_candidates(candidate_id),
  authorization_id TEXT NOT NULL
    REFERENCES learning_canary_authorizations(authorization_id),
  run_hash TEXT NOT NULL UNIQUE,
  artifact_json TEXT NOT NULL CHECK (json_valid(artifact_json)),
  started_at TEXT NOT NULL
) STRICT;

CREATE TABLE learning_release_versions (
  release_id TEXT PRIMARY KEY,
  release_slot_hash TEXT NOT NULL,
  candidate_id TEXT NOT NULL REFERENCES learning_candidates(candidate_id),
  action TEXT NOT NULL CHECK (action IN ('release', 'rollback')),
  previous_release_id TEXT REFERENCES learning_release_versions(release_id),
  restored_release_id TEXT REFERENCES learning_release_versions(release_id),
  release_hash TEXT NOT NULL UNIQUE,
  artifact_json TEXT NOT NULL CHECK (json_valid(artifact_json)),
  activated_at TEXT NOT NULL
) STRICT;

CREATE INDEX learning_release_versions_slot
  ON learning_release_versions (
    release_slot_hash, activated_at, release_id
  );

CREATE TABLE learning_release_pointers (
  release_slot_hash TEXT PRIMARY KEY,
  active_release_id TEXT REFERENCES learning_release_versions(release_id),
  pointer_revision INTEGER NOT NULL CHECK (pointer_revision >= 0),
  pointer_hash TEXT NOT NULL UNIQUE,
  artifact_json TEXT NOT NULL CHECK (json_valid(artifact_json)),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE learning_monitor_results (
  monitor_id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES learning_release_versions(release_id),
  monitor_hash TEXT NOT NULL UNIQUE,
  artifact_json TEXT NOT NULL CHECK (json_valid(artifact_json)),
  monitored_at TEXT NOT NULL
) STRICT;

CREATE TABLE learning_control_state (
  principal_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused')),
  control_epoch INTEGER NOT NULL CHECK (control_epoch >= 0),
  frontier_hash TEXT NOT NULL,
  runtime_identity_hash TEXT NOT NULL,
  configuration_hash TEXT NOT NULL,
  corpus_hash TEXT NOT NULL,
  artifact_json TEXT NOT NULL CHECK (json_valid(artifact_json)),
  changed_at TEXT NOT NULL
) STRICT;

CREATE TABLE learning_receipt_links (
  receipt_id TEXT PRIMARY KEY REFERENCES mutation_receipts(receipt_id),
  aggregate_kind TEXT NOT NULL
    CHECK (
      aggregate_kind IN (
        'trace', 'stop', 'candidate', 'transition', 'evaluation', 'canary',
        'release', 'monitor', 'control', 'rollback'
      )
    ),
  aggregate_id TEXT NOT NULL,
  receipt_kind TEXT NOT NULL,
  receipt_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX learning_receipt_links_aggregate
  ON learning_receipt_links (
    aggregate_kind, aggregate_id, created_at, receipt_id
  );

CREATE TABLE learning_idempotency_results (
  idempotency_key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  receipt_id TEXT REFERENCES mutation_receipts(receipt_id),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE learning_target_invalidations (
  invalidation_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES learning_candidates(candidate_id),
  memory_id TEXT NOT NULL REFERENCES memory_objects(memory_id),
  revision_id TEXT NOT NULL REFERENCES memory_revisions(revision_id),
  reason TEXT NOT NULL
    CHECK (reason IN ('revoked', 'tombstoned', 'purged')),
  tombstone_epoch INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (candidate_id, reason, tombstone_epoch)
) STRICT;

CREATE INDEX learning_target_invalidations_target
  ON learning_target_invalidations (
    memory_id, revision_id, created_at, candidate_id
  );

ALTER TABLE backup_manifests
  ADD COLUMN learning_control_epoch INTEGER NOT NULL DEFAULT 0
  CHECK (learning_control_epoch >= 0);
ALTER TABLE backup_manifests
  ADD COLUMN learning_release_revision INTEGER NOT NULL DEFAULT 0
  CHECK (learning_release_revision >= 0);

CREATE TRIGGER learning_release_pointers_guarded_insert
BEFORE INSERT ON learning_release_pointers
WHEN NOT EXISTS (
  SELECT 1 FROM learning_write_guard WHERE singleton = 1
)
BEGIN
  SELECT RAISE(ABORT, 'LEARNING_TRANSACTION_REQUIRED');
END;
CREATE TRIGGER learning_release_pointers_guarded_update
BEFORE UPDATE ON learning_release_pointers
WHEN NOT EXISTS (
  SELECT 1 FROM learning_write_guard WHERE singleton = 1
)
OR NEW.release_slot_hash <> OLD.release_slot_hash
OR NEW.pointer_revision <> OLD.pointer_revision + 1
BEGIN
  SELECT RAISE(ABORT, 'LEARNING_POINTER_CAS');
END;
CREATE TRIGGER learning_release_pointers_no_delete
BEFORE DELETE ON learning_release_pointers BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:learning_release_pointers');
END;

CREATE TRIGGER learning_control_state_guarded_insert
BEFORE INSERT ON learning_control_state
WHEN NOT EXISTS (
  SELECT 1 FROM learning_write_guard WHERE singleton = 1
)
BEGIN
  SELECT RAISE(ABORT, 'LEARNING_TRANSACTION_REQUIRED');
END;
CREATE TRIGGER learning_control_state_guarded_update
BEFORE UPDATE ON learning_control_state
WHEN NOT EXISTS (
  SELECT 1 FROM learning_write_guard WHERE singleton = 1
)
OR NEW.principal_id <> OLD.principal_id
OR NEW.control_epoch <> OLD.control_epoch + 1
BEGIN
  SELECT RAISE(ABORT, 'LEARNING_CONTROL_CAS');
END;
CREATE TRIGGER learning_control_state_no_delete
BEFORE DELETE ON learning_control_state BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:learning_control_state');
END;

CREATE TRIGGER learning_traces_no_update
BEFORE UPDATE ON learning_traces BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:learning_traces');
END;
CREATE TRIGGER learning_traces_no_delete
BEFORE DELETE ON learning_traces BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:learning_traces');
END;
CREATE TRIGGER learning_trace_evidence_refs_no_update
BEFORE UPDATE ON learning_trace_evidence_refs BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:learning_trace_evidence_refs');
END;
CREATE TRIGGER learning_trace_evidence_refs_no_delete
BEFORE DELETE ON learning_trace_evidence_refs BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:learning_trace_evidence_refs');
END;
CREATE TRIGGER learning_candidates_no_update
BEFORE UPDATE ON learning_candidates BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:learning_candidates');
END;
CREATE TRIGGER learning_candidates_no_delete
BEFORE DELETE ON learning_candidates BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:learning_candidates');
END;
CREATE TRIGGER learning_candidate_traces_no_update
BEFORE UPDATE ON learning_candidate_traces BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:learning_candidate_traces');
END;
CREATE TRIGGER learning_candidate_traces_no_delete
BEFORE DELETE ON learning_candidate_traces BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:learning_candidate_traces');
END;
CREATE TRIGGER learning_candidate_evidence_no_update
BEFORE UPDATE ON learning_candidate_evidence BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:learning_candidate_evidence');
END;
CREATE TRIGGER learning_candidate_evidence_no_delete
BEFORE DELETE ON learning_candidate_evidence BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:learning_candidate_evidence');
END;
CREATE TRIGGER learning_candidate_transitions_no_update
BEFORE UPDATE ON learning_candidate_transitions BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:learning_candidate_transitions');
END;
CREATE TRIGGER learning_candidate_transitions_no_delete
BEFORE DELETE ON learning_candidate_transitions BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:learning_candidate_transitions');
END;
CREATE TRIGGER learning_partition_seals_no_update
BEFORE UPDATE ON learning_partition_seals BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:learning_partition_seals');
END;
CREATE TRIGGER learning_partition_seals_no_delete
BEFORE DELETE ON learning_partition_seals BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:learning_partition_seals');
END;
CREATE TRIGGER learning_evaluation_runs_no_update
BEFORE UPDATE ON learning_evaluation_runs BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:learning_evaluation_runs');
END;
CREATE TRIGGER learning_evaluation_runs_no_delete
BEFORE DELETE ON learning_evaluation_runs BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:learning_evaluation_runs');
END;
CREATE TRIGGER learning_evaluation_result_sets_no_update
BEFORE UPDATE ON learning_evaluation_result_sets BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:learning_evaluation_result_sets');
END;
CREATE TRIGGER learning_evaluation_result_sets_no_delete
BEFORE DELETE ON learning_evaluation_result_sets BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:learning_evaluation_result_sets');
END;
CREATE TRIGGER learning_evaluation_results_no_update
BEFORE UPDATE ON learning_evaluation_results BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:learning_evaluation_results');
END;
CREATE TRIGGER learning_evaluation_results_no_delete
BEFORE DELETE ON learning_evaluation_results BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:learning_evaluation_results');
END;
CREATE TRIGGER learning_contamination_events_no_update
BEFORE UPDATE ON learning_contamination_events BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:learning_contamination_events');
END;
CREATE TRIGGER learning_contamination_events_no_delete
BEFORE DELETE ON learning_contamination_events BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:learning_contamination_events');
END;
CREATE TRIGGER learning_canary_authorizations_no_update
BEFORE UPDATE ON learning_canary_authorizations BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:learning_canary_authorizations');
END;
CREATE TRIGGER learning_canary_authorizations_no_delete
BEFORE DELETE ON learning_canary_authorizations BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:learning_canary_authorizations');
END;
CREATE TRIGGER learning_canary_runs_no_update
BEFORE UPDATE ON learning_canary_runs BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:learning_canary_runs');
END;
CREATE TRIGGER learning_canary_runs_no_delete
BEFORE DELETE ON learning_canary_runs BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:learning_canary_runs');
END;
CREATE TRIGGER learning_release_versions_no_update
BEFORE UPDATE ON learning_release_versions BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:learning_release_versions');
END;
CREATE TRIGGER learning_release_versions_no_delete
BEFORE DELETE ON learning_release_versions BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:learning_release_versions');
END;
CREATE TRIGGER learning_monitor_results_no_update
BEFORE UPDATE ON learning_monitor_results BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:learning_monitor_results');
END;
CREATE TRIGGER learning_monitor_results_no_delete
BEFORE DELETE ON learning_monitor_results BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:learning_monitor_results');
END;
CREATE TRIGGER learning_receipt_links_no_update
BEFORE UPDATE ON learning_receipt_links BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:learning_receipt_links');
END;
CREATE TRIGGER learning_receipt_links_no_delete
BEFORE DELETE ON learning_receipt_links BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:learning_receipt_links');
END;
CREATE TRIGGER learning_idempotency_results_no_update
BEFORE UPDATE ON learning_idempotency_results BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:learning_idempotency_results');
END;
CREATE TRIGGER learning_idempotency_results_no_delete
BEFORE DELETE ON learning_idempotency_results BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:learning_idempotency_results');
END;
CREATE TRIGGER learning_target_invalidations_no_update
BEFORE UPDATE ON learning_target_invalidations BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:learning_target_invalidations');
END;
CREATE TRIGGER learning_target_invalidations_no_delete
BEFORE DELETE ON learning_target_invalidations BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:learning_target_invalidations');
END;
