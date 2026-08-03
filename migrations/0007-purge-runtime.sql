DROP TRIGGER context_slice_items_no_update;

CREATE TRIGGER context_slice_items_no_update
BEFORE UPDATE ON context_slice_items
WHEN NOT (
  EXISTS (
    SELECT 1
    FROM purge_redaction_guard AS g
    JOIN purge_jobs AS p
      ON p.purge_job_id = g.purge_job_id
     AND p.status = 'running'
    WHERE OLD.memory_id = g.memory_id
       OR EXISTS (
         SELECT 1
         FROM context_slice_item_evidence AS cie
         JOIN memory_revisions AS r ON r.memory_id = g.memory_id
         JOIN memory_revision_evidence AS re
           ON re.revision_id = r.revision_id
          AND re.evidence_id = cie.evidence_id
         WHERE cie.context_slice_id = OLD.context_slice_id
           AND cie.ordinal = OLD.ordinal
       )
  )
  AND NEW.context_slice_id IS OLD.context_slice_id
  AND NEW.ordinal IS OLD.ordinal
  AND NEW.memory_id IS OLD.memory_id
  AND NEW.revision_id IS OLD.revision_id
  AND json_valid(NEW.item_json)
  AND json(
    json_remove(NEW.item_json, '$.content')
  ) = json(
    json_remove(OLD.item_json, '$.content')
  )
  AND json_extract(NEW.item_json, '$.content.storage') = 'inline'
  AND json_extract(NEW.item_json, '$.content.text') = '[PURGED]'
  AND json_extract(NEW.item_json, '$.content.media_type')
    = 'application/x.memo-graph-redacted'
  AND (
    SELECT count(*) FROM json_each(
      json_extract(NEW.item_json, '$.content')
    )
  ) = 3
)
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:context_slice_items');
END;

DROP TRIGGER context_slices_no_update;

CREATE TRIGGER context_slices_no_update
BEFORE UPDATE ON context_slices
WHEN NOT (
  EXISTS (
    SELECT 1
    FROM purge_redaction_guard AS g
    JOIN purge_jobs AS p
      ON p.purge_job_id = g.purge_job_id
     AND p.status = 'running'
    JOIN context_slice_items AS i
      ON i.context_slice_id = OLD.context_slice_id
     AND (
       i.memory_id = g.memory_id
       OR EXISTS (
         SELECT 1
         FROM context_slice_item_evidence AS cie
         JOIN memory_revisions AS r ON r.memory_id = g.memory_id
         JOIN memory_revision_evidence AS re
           ON re.revision_id = r.revision_id
          AND re.evidence_id = cie.evidence_id
         WHERE cie.context_slice_id = i.context_slice_id
           AND cie.ordinal = i.ordinal
       )
     )
  )
  AND NEW.context_slice_id IS OLD.context_slice_id
  AND NEW.request_id IS OLD.request_id
  AND NEW.compiler_version IS OLD.compiler_version
  AND NEW.token_budget IS OLD.token_budget
  AND NEW.token_used IS OLD.token_used
  AND NEW.created_at IS OLD.created_at
  AND json_valid(NEW.slice_json)
  AND NEW.frozen_hash = json_extract(NEW.slice_json, '$.frozen_hash')
)
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY:context_slices');
END;
