DROP TRIGGER projection_revisions_no_update;

CREATE TRIGGER projection_revisions_no_update
BEFORE UPDATE ON projection_revisions
WHEN NOT (
  EXISTS (
    WITH RECURSIVE ancestry(source_revision_id, source_memory_id) AS (
      SELECT source_revision_id, source_memory_id
      FROM projection_revision_sources
      WHERE projection_revision_id = OLD.projection_revision_id
      UNION ALL
      SELECT source.source_revision_id, source.source_memory_id
      FROM projection_revision_sources AS source
      JOIN ancestry
        ON source.projection_revision_id = ancestry.source_revision_id
    )
    SELECT 1
    FROM ancestry
    JOIN purge_redaction_guard AS guard
      ON guard.memory_id = ancestry.source_memory_id
    JOIN purge_jobs AS job
      ON job.purge_job_id = guard.purge_job_id
     AND job.status = 'running'
    LIMIT 1
  )
  AND NEW.projection_revision_id IS OLD.projection_revision_id
  AND NEW.projection_id IS OLD.projection_id
  AND NEW.revision IS OLD.revision
  AND NEW.projection_type IS OLD.projection_type
  AND NEW.abstraction IS OLD.abstraction
  AND NEW.principal_id IS OLD.principal_id
  AND NEW.scope_kind IS OLD.scope_kind
  AND NEW.scope_id IS OLD.scope_id
  AND NEW.authority IS OLD.authority
  AND NEW.sensitivity IS OLD.sensitivity
  AND NEW.valid_from IS OLD.valid_from
  AND NEW.valid_to IS OLD.valid_to
  AND NEW.recorded_at IS OLD.recorded_at
  AND NEW.content_hash IS OLD.content_hash
  AND NEW.evidence_ids_json IS OLD.evidence_ids_json
  AND NEW.supersedes_projection_revision_id
      IS OLD.supersedes_projection_revision_id
  AND NEW.transform_name IS OLD.transform_name
  AND NEW.transform_version IS OLD.transform_version
  AND NEW.ledger_epoch IS OLD.ledger_epoch
  AND NEW.tombstone_epoch IS OLD.tombstone_epoch
  AND NEW.projection_epoch IS OLD.projection_epoch
  AND NEW.source_frontier_hash IS OLD.source_frontier_hash
  AND NEW.projection_frontier_hash IS OLD.projection_frontier_hash
  AND NEW.created_at IS OLD.created_at
  AND NEW.lifecycle = 'purged'
  AND NEW.payload_json IS NULL
  AND NEW.content_json IS NULL
  AND NEW.purged_at IS NOT NULL
  AND json_valid(NEW.revision_json)
  AND json(
    json_remove(
      NEW.revision_json,
      '$.lifecycle',
      '$.payload',
      '$.content',
      '$.invalidated_at',
      '$.invalidation_reason'
    )
  ) = json(
    json_remove(
      OLD.revision_json,
      '$.lifecycle',
      '$.payload',
      '$.content',
      '$.invalidated_at',
      '$.invalidation_reason'
    )
  )
  AND json_extract(NEW.revision_json, '$.lifecycle') = 'purged'
  AND json_type(NEW.revision_json, '$.payload') = 'null'
  AND json_type(NEW.revision_json, '$.content') = 'null'
  AND json_type(NEW.revision_json, '$.invalidated_at') = 'text'
  AND json_type(NEW.revision_json, '$.invalidation_reason') = 'text'
)
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:projection_revisions');
END;

DROP TRIGGER relation_revisions_no_update;

CREATE TRIGGER relation_revisions_no_update
BEFORE UPDATE ON relation_revisions
WHEN NOT (
  EXISTS (
    WITH RECURSIVE ancestry(source_revision_id, source_memory_id) AS (
      SELECT source_revision_id, source_memory_id
      FROM projection_revision_sources
      WHERE projection_revision_id = OLD.projection_revision_id
      UNION ALL
      SELECT source.source_revision_id, source.source_memory_id
      FROM projection_revision_sources AS source
      JOIN ancestry
        ON source.projection_revision_id = ancestry.source_revision_id
    )
    SELECT 1
    FROM ancestry
    JOIN purge_redaction_guard AS guard
      ON guard.memory_id = ancestry.source_memory_id
    JOIN purge_jobs AS job
      ON job.purge_job_id = guard.purge_job_id
     AND job.status = 'running'
    LIMIT 1
  )
  AND NEW.relation_revision_id IS OLD.relation_revision_id
  AND NEW.relation_id IS OLD.relation_id
  AND NEW.projection_revision_id IS OLD.projection_revision_id
  AND NEW.revision IS OLD.revision
  AND NEW.source_revision_id IS OLD.source_revision_id
  AND NEW.target_revision_id IS OLD.target_revision_id
  AND NEW.relation_type IS OLD.relation_type
  AND NEW.direction IS OLD.direction
  AND NEW.principal_id IS OLD.principal_id
  AND NEW.scope_kind IS OLD.scope_kind
  AND NEW.scope_id IS OLD.scope_id
  AND NEW.valid_from IS OLD.valid_from
  AND NEW.valid_to IS OLD.valid_to
  AND NEW.projection_epoch IS OLD.projection_epoch
  AND NEW.created_at IS OLD.created_at
  AND NEW.lifecycle = 'purged'
  AND NEW.description IS NULL
  AND json_valid(NEW.relation_json)
  AND json(
    json_remove(NEW.relation_json, '$.description')
  ) = json(
    json_remove(OLD.relation_json, '$.description')
  )
  AND json_type(NEW.relation_json, '$.description') = 'null'
)
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:relation_revisions');
END;
