CREATE TABLE automatic_memory_projects (
  project_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  identity_kind TEXT NOT NULL CHECK (
    identity_kind IN ('git_common_dir', 'canonical_root')
  ),
  identity_hash TEXT NOT NULL CHECK (
    length(identity_hash) = 71 AND identity_hash GLOB 'sha256:[0-9a-f]*'
  ),
  scope_kind TEXT NOT NULL CHECK (scope_kind = 'workspace'),
  scope_id TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  schema_version TEXT NOT NULL CHECK (schema_version = '1.0.0'),
  UNIQUE (principal_id, identity_hash),
  UNIQUE (principal_id, scope_kind, scope_id)
) STRICT;

CREATE TRIGGER automatic_memory_projects_no_update
BEFORE UPDATE ON automatic_memory_projects BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:automatic_memory_projects');
END;

CREATE TRIGGER automatic_memory_projects_no_delete
BEFORE DELETE ON automatic_memory_projects BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:automatic_memory_projects');
END;

CREATE TABLE automatic_memory_events (
  capture_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 71 AND request_hash GLOB 'sha256:[0-9a-f]*'
  ),
  principal_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES automatic_memory_projects(project_id),
  session_id TEXT NOT NULL,
  turn_id TEXT,
  event_kind TEXT NOT NULL CHECK (
    event_kind IN (
      'session_start', 'user_prompt_submit', 'assistant_stop', 'session_end'
    )
  ),
  generation INTEGER CHECK (generation IS NULL OR generation > 0),
  evidence_id TEXT REFERENCES evidence_events(evidence_id),
  payload_hash TEXT NOT NULL CHECK (
    length(payload_hash) = 71 AND payload_hash GLOB 'sha256:[0-9a-f]*'
  ),
  source TEXT NOT NULL CHECK (source IN ('direct', 'spool')),
  occurred_at TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  schema_version TEXT NOT NULL CHECK (schema_version = '1.0.0'),
  UNIQUE (
    principal_id, project_id, session_id, turn_id, event_kind, generation
  ),
  CHECK (
    (event_kind IN ('user_prompt_submit', 'assistant_stop')
      AND turn_id IS NOT NULL AND generation IS NOT NULL
      AND evidence_id IS NOT NULL)
    OR
    (event_kind IN ('session_start', 'session_end')
      AND turn_id IS NULL AND generation IS NULL AND evidence_id IS NULL)
  )
) STRICT;

CREATE INDEX automatic_memory_events_turn
ON automatic_memory_events(project_id, session_id, turn_id, generation);

CREATE TRIGGER automatic_memory_events_no_update
BEFORE UPDATE ON automatic_memory_events BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:automatic_memory_events');
END;

CREATE TRIGGER automatic_memory_events_no_delete
BEFORE DELETE ON automatic_memory_events BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:automatic_memory_events');
END;

CREATE TABLE automatic_memory_turns (
  turn_key TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES automatic_memory_projects(project_id),
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  user_event_id TEXT UNIQUE REFERENCES automatic_memory_events(event_id),
  user_evidence_id TEXT REFERENCES evidence_events(evidence_id),
  assistant_event_id TEXT UNIQUE REFERENCES automatic_memory_events(event_id),
  assistant_evidence_id TEXT REFERENCES evidence_events(evidence_id),
  active_generation INTEGER NOT NULL CHECK (active_generation >= 0),
  state TEXT NOT NULL CHECK (
    state IN ('open', 'stabilizing', 'ready', 'completed', 'quarantined')
  ),
  stabilization_due_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (principal_id, project_id, session_id, turn_id),
  CHECK (
    (assistant_event_id IS NULL AND assistant_evidence_id IS NULL)
    OR
    (assistant_event_id IS NOT NULL AND assistant_evidence_id IS NOT NULL)
  ),
  CHECK (
    (user_event_id IS NULL AND user_evidence_id IS NULL)
    OR
    (user_event_id IS NOT NULL AND user_evidence_id IS NOT NULL)
  )
) STRICT;

CREATE TRIGGER automatic_memory_turns_valid_update
BEFORE UPDATE ON automatic_memory_turns
WHEN NOT (
  NEW.turn_key IS OLD.turn_key
  AND NEW.principal_id IS OLD.principal_id
  AND NEW.project_id IS OLD.project_id
  AND NEW.session_id IS OLD.session_id
  AND NEW.turn_id IS OLD.turn_id
  AND NEW.created_at IS OLD.created_at
  AND NEW.updated_at >= OLD.updated_at
  AND NEW.active_generation >= OLD.active_generation
  AND (
    NEW.user_event_id IS OLD.user_event_id
    OR (OLD.user_event_id IS NULL AND NEW.user_event_id IS NOT NULL)
  )
  AND (
    NEW.user_evidence_id IS OLD.user_evidence_id
    OR (OLD.user_evidence_id IS NULL AND NEW.user_evidence_id IS NOT NULL)
  )
) BEGIN
  SELECT RAISE(ABORT, 'INVALID_AUTOMATIC_MEMORY_TURN_TRANSITION');
END;

CREATE TRIGGER automatic_memory_turns_no_delete
BEFORE DELETE ON automatic_memory_turns BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:automatic_memory_turns');
END;

CREATE TABLE automatic_memory_formation_jobs (
  job_id TEXT PRIMARY KEY,
  turn_key TEXT NOT NULL UNIQUE REFERENCES automatic_memory_turns(turn_key),
  generation INTEGER NOT NULL CHECK (generation > 0),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'processing', 'completed', 'quarantined')
  ),
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  available_at TEXT NOT NULL,
  claimed_by TEXT,
  lease_expires_at TEXT,
  result_hash TEXT CHECK (
    result_hash IS NULL OR (
      length(result_hash) = 71 AND result_hash GLOB 'sha256:[0-9a-f]*'
    )
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (
    (status = 'processing' AND claimed_by IS NOT NULL
      AND lease_expires_at IS NOT NULL AND completed_at IS NULL)
    OR
    (status = 'completed' AND claimed_by IS NULL
      AND lease_expires_at IS NULL AND completed_at IS NOT NULL
      AND result_hash IS NOT NULL)
    OR
    (status IN ('pending', 'quarantined') AND claimed_by IS NULL
      AND lease_expires_at IS NULL AND completed_at IS NULL)
  )
) STRICT;

CREATE INDEX automatic_memory_formation_jobs_claim
ON automatic_memory_formation_jobs(status, available_at, lease_expires_at, job_id);

CREATE TRIGGER automatic_memory_formation_jobs_valid_update
BEFORE UPDATE ON automatic_memory_formation_jobs
WHEN NOT (
  NEW.job_id IS OLD.job_id
  AND NEW.turn_key IS OLD.turn_key
  AND NEW.created_at IS OLD.created_at
  AND NEW.updated_at >= OLD.updated_at
  AND NEW.generation >= OLD.generation
  AND (
    NEW.attempts >= OLD.attempts OR NEW.generation > OLD.generation
  )
) BEGIN
  SELECT RAISE(ABORT, 'INVALID_AUTOMATIC_MEMORY_JOB_TRANSITION');
END;

CREATE TRIGGER automatic_memory_formation_jobs_no_delete
BEFORE DELETE ON automatic_memory_formation_jobs BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:automatic_memory_formation_jobs');
END;

CREATE TABLE automatic_memory_provider_attempts (
  attempt_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES automatic_memory_formation_jobs(job_id),
  generation INTEGER NOT NULL CHECK (generation > 0),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  schema_revision TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_hash TEXT,
  redaction_json TEXT NOT NULL CHECK (json_valid(redaction_json)),
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0),
  cost_microusd INTEGER CHECK (cost_microusd IS NULL OR cost_microusd >= 0),
  state TEXT NOT NULL CHECK (state IN ('started', 'succeeded', 'failed')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (job_id, generation, attempt)
) STRICT;

CREATE TABLE automatic_memory_policy_decisions (
  decision_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES automatic_memory_formation_jobs(job_id),
  generation INTEGER NOT NULL CHECK (generation > 0),
  proposal_id TEXT NOT NULL,
  decision_hash TEXT NOT NULL,
  decision_json TEXT NOT NULL CHECK (json_valid(decision_json)),
  disposition TEXT NOT NULL CHECK (
    disposition IN ('activate', 'candidate_only', 'review_required', 'reject')
  ),
  decided_at TEXT NOT NULL,
  UNIQUE (job_id, generation, proposal_id)
) STRICT;

CREATE TABLE automatic_memory_admission_links (
  link_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL UNIQUE
    REFERENCES automatic_memory_policy_decisions(decision_id),
  candidate_id TEXT,
  memory_id TEXT,
  revision_id TEXT,
  admission_receipt_id TEXT,
  linked_at TEXT NOT NULL
) STRICT;

CREATE TABLE automatic_memory_recall_uses (
  recall_use_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES automatic_memory_projects(project_id),
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  retrieval_receipt_id TEXT,
  context_slice_id TEXT,
  memory_count INTEGER NOT NULL CHECK (memory_count >= 0),
  token_count INTEGER NOT NULL CHECK (token_count >= 0),
  used_at TEXT NOT NULL,
  UNIQUE (project_id, session_id, turn_id, request_hash)
) STRICT;

CREATE TABLE automatic_memory_failures (
  failure_id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES automatic_memory_formation_jobs(job_id),
  event_id TEXT REFERENCES automatic_memory_events(event_id),
  generation INTEGER CHECK (generation IS NULL OR generation > 0),
  stage TEXT NOT NULL CHECK (
    stage IN ('capture', 'formation', 'policy', 'admission', 'recall')
  ),
  error_code TEXT NOT NULL,
  retryable INTEGER NOT NULL CHECK (retryable IN (0, 1)),
  recorded_at TEXT NOT NULL,
  CHECK (job_id IS NOT NULL OR event_id IS NOT NULL)
) STRICT;

CREATE TRIGGER automatic_memory_provider_attempts_no_update
BEFORE UPDATE ON automatic_memory_provider_attempts BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:automatic_memory_provider_attempts');
END;
CREATE TRIGGER automatic_memory_provider_attempts_no_delete
BEFORE DELETE ON automatic_memory_provider_attempts BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:automatic_memory_provider_attempts');
END;
CREATE TRIGGER automatic_memory_policy_decisions_no_update
BEFORE UPDATE ON automatic_memory_policy_decisions BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:automatic_memory_policy_decisions');
END;
CREATE TRIGGER automatic_memory_policy_decisions_no_delete
BEFORE DELETE ON automatic_memory_policy_decisions BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:automatic_memory_policy_decisions');
END;
CREATE TRIGGER automatic_memory_admission_links_no_update
BEFORE UPDATE ON automatic_memory_admission_links BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:automatic_memory_admission_links');
END;
CREATE TRIGGER automatic_memory_admission_links_no_delete
BEFORE DELETE ON automatic_memory_admission_links BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:automatic_memory_admission_links');
END;
CREATE TRIGGER automatic_memory_recall_uses_no_update
BEFORE UPDATE ON automatic_memory_recall_uses BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:automatic_memory_recall_uses');
END;
CREATE TRIGGER automatic_memory_recall_uses_no_delete
BEFORE DELETE ON automatic_memory_recall_uses BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:automatic_memory_recall_uses');
END;
CREATE TRIGGER automatic_memory_failures_no_update
BEFORE UPDATE ON automatic_memory_failures BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:automatic_memory_failures');
END;
CREATE TRIGGER automatic_memory_failures_no_delete
BEFORE DELETE ON automatic_memory_failures BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:automatic_memory_failures');
END;
