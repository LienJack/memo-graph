CREATE TABLE memory_candidates (
  candidate_id TEXT PRIMARY KEY,
  logical_key TEXT NOT NULL,
  logical_key_hash TEXT NOT NULL
    CHECK (length(logical_key_hash) = 71 AND logical_key_hash GLOB 'sha256:[0-9a-f]*'),
  principal_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL
    CHECK (scope_kind IN ('thread', 'topic', 'scenario', 'user', 'workspace', 'agent')),
  scope_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('episodic', 'semantic', 'procedural')),
  sensitivity TEXT NOT NULL
    CHECK (sensitivity IN ('public', 'internal', 'personal', 'sensitive', 'secret')),
  inferred INTEGER NOT NULL CHECK (inferred IN (0, 1)),
  content_storage TEXT NOT NULL CHECK (content_storage IN ('inline', 'blob', 'redacted')),
  content_inline TEXT,
  content_blob_hash TEXT REFERENCES artifacts(content_hash),
  media_type TEXT NOT NULL,
  content_hash TEXT NOT NULL
    CHECK (length(content_hash) = 71 AND content_hash GLOB 'sha256:[0-9a-f]*'),
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  recorded_at TEXT NOT NULL,
  injection_risk TEXT NOT NULL
    CHECK (injection_risk IN ('none', 'suspected', 'confirmed')),
  requires_user_confirmation INTEGER NOT NULL
    CHECK (requires_user_confirmation IN (0, 1)),
  transform_name TEXT NOT NULL,
  transform_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  purged_at TEXT,
  CHECK (
    (content_storage = 'inline' AND content_inline IS NOT NULL
      AND content_blob_hash IS NULL AND purged_at IS NULL)
    OR
    (content_storage = 'blob' AND content_inline IS NULL
      AND content_blob_hash IS NOT NULL AND purged_at IS NULL)
    OR
    (content_storage = 'redacted' AND content_inline IS NULL
      AND content_blob_hash IS NULL AND purged_at IS NOT NULL)
  )
) STRICT;

CREATE INDEX memory_candidates_scope_logical_key
  ON memory_candidates (
    principal_id, scope_kind, scope_id, logical_key_hash, candidate_id
  );
CREATE INDEX memory_candidates_content_hash
  ON memory_candidates (content_hash, candidate_id);

CREATE TABLE memory_candidate_evidence (
  candidate_id TEXT NOT NULL REFERENCES memory_candidates(candidate_id),
  evidence_id TEXT NOT NULL REFERENCES evidence_events(evidence_id),
  PRIMARY KEY (candidate_id, evidence_id)
) STRICT;

CREATE TABLE memory_objects (
  memory_id TEXT PRIMARY KEY,
  logical_key_hash TEXT NOT NULL
    CHECK (length(logical_key_hash) = 71 AND logical_key_hash GLOB 'sha256:[0-9a-f]*'),
  principal_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL
    CHECK (scope_kind IN ('thread', 'topic', 'scenario', 'user', 'workspace', 'agent')),
  scope_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('episodic', 'semantic', 'procedural')),
  lifecycle TEXT NOT NULL
    CHECK (lifecycle IN ('working', 'candidate', 'active', 'superseded', 'revoked', 'quarantined', 'purged')),
  current_revision_id TEXT
    REFERENCES memory_revisions(revision_id) DEFERRABLE INITIALLY DEFERRED,
  pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
  context_eligible INTEGER NOT NULL CHECK (context_eligible IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (
    principal_id, scope_kind, scope_id, kind, logical_key_hash
  ),
  CHECK (
    lifecycle NOT IN ('candidate', 'superseded', 'revoked', 'quarantined', 'purged')
    OR context_eligible = 0
  ),
  CHECK (context_eligible = 0 OR lifecycle = 'active'),
  CHECK (lifecycle <> 'active' OR current_revision_id IS NOT NULL),
  CHECK (lifecycle <> 'purged' OR current_revision_id IS NULL)
) STRICT;

CREATE INDEX memory_objects_scope_lifecycle
  ON memory_objects (
    principal_id, scope_kind, scope_id, lifecycle, memory_id
  );

CREATE TABLE memory_revisions (
  revision_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memory_objects(memory_id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  abstraction TEXT NOT NULL CHECK (abstraction = 'l1_memory'),
  lifecycle TEXT NOT NULL
    CHECK (lifecycle IN ('working', 'candidate', 'active', 'superseded', 'revoked', 'quarantined', 'purged')),
  kind TEXT NOT NULL CHECK (kind IN ('episodic', 'semantic', 'procedural')),
  scope_kind TEXT NOT NULL
    CHECK (scope_kind IN ('thread', 'topic', 'scenario', 'user', 'workspace', 'agent')),
  scope_id TEXT NOT NULL,
  authority TEXT NOT NULL
    CHECK (authority IN ('user_stated', 'observed', 'tool_result', 'inferred', 'derived', 'imported')),
  sensitivity TEXT NOT NULL
    CHECK (sensitivity IN ('public', 'internal', 'personal', 'sensitive', 'secret')),
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  recorded_at TEXT NOT NULL,
  inferred INTEGER NOT NULL CHECK (inferred IN (0, 1)),
  content_storage TEXT NOT NULL CHECK (content_storage IN ('inline', 'blob', 'redacted')),
  content_inline TEXT,
  content_blob_hash TEXT REFERENCES artifacts(content_hash),
  media_type TEXT NOT NULL,
  content_hash TEXT NOT NULL
    CHECK (length(content_hash) = 71 AND content_hash GLOB 'sha256:[0-9a-f]*'),
  supersedes_revision_id TEXT REFERENCES memory_revisions(revision_id),
  transform_name TEXT NOT NULL,
  transform_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  purged_at TEXT,
  UNIQUE (memory_id, revision),
  CHECK (
    (revision = 1 AND supersedes_revision_id IS NULL)
    OR
    (revision > 1 AND supersedes_revision_id IS NOT NULL)
  ),
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CHECK (
    (content_storage = 'inline' AND content_inline IS NOT NULL
      AND content_blob_hash IS NULL AND purged_at IS NULL)
    OR
    (content_storage = 'blob' AND content_inline IS NULL
      AND content_blob_hash IS NOT NULL AND purged_at IS NULL)
    OR
    (content_storage = 'redacted' AND content_inline IS NULL
      AND content_blob_hash IS NULL AND purged_at IS NOT NULL)
  ),
  CHECK (
    (lifecycle = 'purged' AND content_storage = 'redacted')
    OR
    (lifecycle <> 'purged' AND content_storage <> 'redacted')
  )
) STRICT;

CREATE INDEX memory_revisions_memory_revision
  ON memory_revisions (memory_id, revision DESC);
CREATE INDEX memory_revisions_scope_lifecycle
  ON memory_revisions (
    scope_kind, scope_id, lifecycle, valid_from, revision_id
  );
CREATE INDEX memory_revisions_content_hash
  ON memory_revisions (content_hash, revision_id);

CREATE TABLE memory_revision_evidence (
  revision_id TEXT NOT NULL REFERENCES memory_revisions(revision_id),
  evidence_id TEXT NOT NULL REFERENCES evidence_events(evidence_id),
  PRIMARY KEY (revision_id, evidence_id)
) STRICT;

CREATE TABLE memory_candidate_links (
  candidate_id TEXT PRIMARY KEY REFERENCES memory_candidates(candidate_id),
  memory_id TEXT NOT NULL REFERENCES memory_objects(memory_id),
  revision_id TEXT NOT NULL REFERENCES memory_revisions(revision_id),
  linked_at TEXT NOT NULL,
  UNIQUE (memory_id, revision_id)
) STRICT;

CREATE TABLE memory_conflict_groups (
  conflict_group_id TEXT PRIMARY KEY,
  logical_key_hash TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  resolved_revision_id TEXT REFERENCES memory_revisions(revision_id),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  CHECK (
    (status = 'open' AND resolved_revision_id IS NULL AND resolved_at IS NULL)
    OR
    (status = 'resolved' AND resolved_revision_id IS NOT NULL AND resolved_at IS NOT NULL)
  )
) STRICT;

CREATE INDEX memory_conflict_groups_scope_logical_key
  ON memory_conflict_groups (
    principal_id, scope_kind, scope_id, logical_key_hash, status
  );

CREATE TABLE memory_conflict_candidates (
  conflict_group_id TEXT NOT NULL
    REFERENCES memory_conflict_groups(conflict_group_id),
  candidate_id TEXT NOT NULL REFERENCES memory_candidates(candidate_id),
  PRIMARY KEY (conflict_group_id, candidate_id)
) STRICT;

CREATE TABLE admission_decisions (
  decision_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memory_objects(memory_id),
  revision_id TEXT NOT NULL REFERENCES memory_revisions(revision_id),
  decision TEXT NOT NULL
    CHECK (decision IN ('activate', 'candidate_only', 'quarantine', 'reject')),
  principal_id TEXT NOT NULL,
  actor_authority TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  conflict_group_id TEXT REFERENCES memory_conflict_groups(conflict_group_id),
  requires_user_confirmation INTEGER NOT NULL
    CHECK (requires_user_confirmation IN (0, 1)),
  decision_json TEXT NOT NULL CHECK (json_valid(decision_json))
) STRICT;

CREATE INDEX admission_decisions_revision_decided_at
  ON admission_decisions (revision_id, decided_at DESC, decision_id);

CREATE TABLE memory_status_events (
  status_event_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memory_objects(memory_id),
  revision_id TEXT NOT NULL REFERENCES memory_revisions(revision_id),
  action TEXT NOT NULL
    CHECK (action IN ('activate', 'demote', 'suppress', 'revoke', 'tombstone', 'purge_redact')),
  lifecycle TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  actor_authority TEXT NOT NULL,
  reason TEXT NOT NULL,
  tombstone_epoch INTEGER,
  occurred_at TEXT NOT NULL
) STRICT;

CREATE INDEX memory_status_events_memory_occurred_at
  ON memory_status_events (memory_id, occurred_at DESC, status_event_id);

CREATE TABLE memory_pin_events (
  pin_event_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memory_objects(memory_id),
  revision_id TEXT NOT NULL REFERENCES memory_revisions(revision_id),
  pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
  principal_id TEXT NOT NULL,
  actor_authority TEXT NOT NULL,
  reason TEXT NOT NULL,
  occurred_at TEXT NOT NULL
) STRICT;

CREATE TABLE memory_usage_rules (
  usage_rule_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memory_objects(memory_id),
  revision_id TEXT NOT NULL REFERENCES memory_revisions(revision_id),
  effect TEXT NOT NULL CHECK (effect IN ('allow', 'block')),
  context_scope_kind TEXT,
  context_scope_id TEXT,
  principal_id TEXT NOT NULL,
  actor_authority TEXT NOT NULL,
  reason TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  CHECK (
    (context_scope_kind IS NULL AND context_scope_id IS NULL)
    OR
    (context_scope_kind IN ('thread', 'topic', 'scenario', 'user', 'workspace', 'agent')
      AND context_scope_id IS NOT NULL)
  )
) STRICT;

CREATE INDEX memory_usage_rules_memory_occurred_at
  ON memory_usage_rules (memory_id, occurred_at DESC, usage_rule_id);

CREATE TABLE governance_write_guard (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  operation TEXT NOT NULL,
  opened_at TEXT NOT NULL
) STRICT;

CREATE VIRTUAL TABLE memory_fts USING fts5(
  memory_id UNINDEXED,
  revision_id UNINDEXED,
  principal_id UNINDEXED,
  scope_kind UNINDEXED,
  scope_id UNINDEXED,
  kind UNINDEXED,
  valid_from UNINDEXED,
  searchable_text,
  tokenize = 'unicode61 remove_diacritics 2'
);

INSERT INTO projection_state (
  projection_name, status, last_epoch, updated_at, error_code
) VALUES (
  'memory_fts', 'ready', 0,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL
);

CREATE TRIGGER memory_candidates_no_update
BEFORE UPDATE ON memory_candidates BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:memory_candidates');
END;
CREATE TRIGGER memory_candidates_no_delete
BEFORE DELETE ON memory_candidates BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:memory_candidates');
END;
CREATE TRIGGER memory_candidate_evidence_no_update
BEFORE UPDATE ON memory_candidate_evidence BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:memory_candidate_evidence');
END;
CREATE TRIGGER memory_candidate_evidence_no_delete
BEFORE DELETE ON memory_candidate_evidence BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:memory_candidate_evidence');
END;
CREATE TRIGGER memory_objects_no_delete
BEFORE DELETE ON memory_objects BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:memory_objects');
END;
CREATE TRIGGER memory_objects_governed_update
BEFORE UPDATE ON memory_objects
WHEN NOT EXISTS (
  SELECT 1 FROM governance_write_guard WHERE singleton = 1
)
BEGIN
  SELECT RAISE(ABORT, 'GOVERNANCE_TRANSACTION_REQUIRED:memory_objects');
END;
CREATE TRIGGER memory_objects_identity_immutable
BEFORE UPDATE ON memory_objects
WHEN NEW.memory_id IS NOT OLD.memory_id
  OR NEW.logical_key_hash IS NOT OLD.logical_key_hash
  OR NEW.principal_id IS NOT OLD.principal_id
  OR NEW.scope_kind IS NOT OLD.scope_kind
  OR NEW.scope_id IS NOT OLD.scope_id
  OR NEW.kind IS NOT OLD.kind
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_IDENTITY:memory_objects');
END;
CREATE TRIGGER memory_objects_revision_ownership
BEFORE UPDATE OF current_revision_id ON memory_objects
WHEN NEW.current_revision_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM memory_revisions AS r
    WHERE r.revision_id = NEW.current_revision_id
      AND r.memory_id = OLD.memory_id
  )
BEGIN
  SELECT RAISE(ABORT, 'INVALID_REVISION_POINTER:memory_objects');
END;
CREATE TRIGGER memory_revisions_no_update
BEFORE UPDATE ON memory_revisions BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:memory_revisions');
END;
CREATE TRIGGER memory_revisions_no_delete
BEFORE DELETE ON memory_revisions BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:memory_revisions');
END;
CREATE TRIGGER memory_revision_evidence_no_update
BEFORE UPDATE ON memory_revision_evidence BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:memory_revision_evidence');
END;
CREATE TRIGGER memory_revision_evidence_no_delete
BEFORE DELETE ON memory_revision_evidence BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:memory_revision_evidence');
END;
CREATE TRIGGER memory_candidate_links_no_update
BEFORE UPDATE ON memory_candidate_links BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:memory_candidate_links');
END;
CREATE TRIGGER memory_candidate_links_no_delete
BEFORE DELETE ON memory_candidate_links BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:memory_candidate_links');
END;
CREATE TRIGGER admission_decisions_no_update
BEFORE UPDATE ON admission_decisions BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:admission_decisions');
END;
CREATE TRIGGER admission_decisions_no_delete
BEFORE DELETE ON admission_decisions BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:admission_decisions');
END;
CREATE TRIGGER memory_conflict_candidates_no_update
BEFORE UPDATE ON memory_conflict_candidates BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:memory_conflict_candidates');
END;
CREATE TRIGGER memory_conflict_candidates_no_delete
BEFORE DELETE ON memory_conflict_candidates BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:memory_conflict_candidates');
END;
CREATE TRIGGER memory_status_events_no_update
BEFORE UPDATE ON memory_status_events BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:memory_status_events');
END;
CREATE TRIGGER memory_status_events_no_delete
BEFORE DELETE ON memory_status_events BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:memory_status_events');
END;
CREATE TRIGGER memory_pin_events_no_update
BEFORE UPDATE ON memory_pin_events BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:memory_pin_events');
END;
CREATE TRIGGER memory_pin_events_no_delete
BEFORE DELETE ON memory_pin_events BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:memory_pin_events');
END;
CREATE TRIGGER memory_usage_rules_no_update
BEFORE UPDATE ON memory_usage_rules BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:memory_usage_rules');
END;
CREATE TRIGGER memory_usage_rules_no_delete
BEFORE DELETE ON memory_usage_rules BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:memory_usage_rules');
END;
