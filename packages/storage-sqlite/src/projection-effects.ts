import {
  canonicalJson,
  canonicalSha256,
} from "@memo-graph/contracts";
import type Database from "better-sqlite3";

import { StorageError } from "./errors.js";

type ProjectionEffect = {
  causeId: string;
  memoryId: string;
  revisionId: string;
  principalId: string;
  scope: { kind: string; id: string };
  occurredAt: string;
};

function stableJobId(
  kind: "refresh" | "invalidate",
  effect: ProjectionEffect,
): string {
  return `projection-job:${canonicalSha256({
    kind,
    memory_id: effect.memoryId,
    revision_id: effect.revisionId,
    cause_id: effect.causeId,
    occurred_at: effect.occurredAt,
  }).slice("sha256:".length, 48)}`;
}

function enqueue(
  database: Database.Database,
  kind: "refresh" | "invalidate",
  effect: ProjectionEffect,
): string {
  const jobId = stableJobId(kind, effect);
  database
    .prepare(
      `INSERT INTO projection_outbox_jobs (
         job_id, kind, aggregate_id, principal_id, scope_kind, scope_id,
         source_revision_ids_json, status, attempts, available_at,
         claimed_by, lease_expires_at, created_at, processed_at,
         last_error_code
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, ?,
                 NULL, NULL)`,
    )
    .run(
      jobId,
      kind,
      effect.memoryId,
      effect.principalId,
      effect.scope.kind,
      effect.scope.id,
      canonicalJson([effect.revisionId]),
      effect.occurredAt,
      effect.occurredAt,
    );
  return jobId;
}

function openGuard(
  database: Database.Database,
  operation: string,
  occurredAt: string,
): void {
  database
    .prepare(
      `INSERT INTO projection_write_guard (
         singleton, operation, opened_at
       ) VALUES (1, ?, ?)`,
    )
    .run(operation, occurredAt);
}

function closeGuard(database: Database.Database): void {
  database
    .prepare("DELETE FROM projection_write_guard WHERE singleton = 1")
    .run();
}

export function enqueueProjectionRefresh(
  database: Database.Database,
  effect: ProjectionEffect,
): string {
  const jobId = enqueue(database, "refresh", effect);
  openGuard(database, "canonical-refresh", effect.occurredAt);
  try {
    database
      .prepare(
        `UPDATE layered_projection_state
         SET status = 'pending', updated_at = ?, error_code = NULL
         WHERE singleton = 1`,
      )
      .run(effect.occurredAt);
  } finally {
    closeGuard(database);
  }
  return jobId;
}

export function suppressProjectionDescendants(
  database: Database.Database,
  effect: ProjectionEffect,
): string {
  const rows = database
    .prepare(
      `WITH RECURSIVE descendants(
         projection_id, projection_revision_id
       ) AS (
         SELECT r.projection_id, s.projection_revision_id
         FROM projection_revision_sources AS s
         JOIN projection_revisions AS r
           ON r.projection_revision_id = s.projection_revision_id
         WHERE s.source_revision_id = ?
         UNION
         SELECT r.projection_id, s.projection_revision_id
         FROM projection_revision_sources AS s
         JOIN projection_revisions AS r
           ON r.projection_revision_id = s.projection_revision_id
         JOIN descendants AS d
           ON d.projection_revision_id = s.source_revision_id
       )
       SELECT DISTINCT projection_id, projection_revision_id
       FROM descendants
       ORDER BY projection_id, projection_revision_id`,
    )
    .all(effect.revisionId) as Array<{
    projection_id: string;
    projection_revision_id: string;
  }>;

  openGuard(database, "canonical-invalidate", effect.occurredAt);
  try {
    const insertInvalidation = database.prepare(
      `INSERT OR IGNORE INTO projection_invalidations (
         invalidation_id, projection_id, projection_revision_id,
         source_revision_id, reason, invalidated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const updateProjection = database.prepare(
      `UPDATE projection_objects
       SET lifecycle = 'superseded', updated_at = ?
       WHERE projection_id = ? AND current_revision_id = ?`,
    );
    const updateRelation = database.prepare(
      `UPDATE relation_objects
       SET lifecycle = 'superseded', updated_at = ?
       WHERE relation_id = ? AND current_relation_revision_id = ?`,
    );
    for (const row of rows) {
      insertInvalidation.run(
        `projection-invalidation:${canonicalSha256({
          projection_revision_id: row.projection_revision_id,
          source_revision_id: effect.revisionId,
        }).slice("sha256:".length, 42)}`,
        row.projection_id,
        row.projection_revision_id,
        effect.revisionId,
        "CANONICAL_SOURCE_CHANGED",
        effect.occurredAt,
      );
      updateProjection.run(
        effect.occurredAt,
        row.projection_id,
        row.projection_revision_id,
      );
      updateRelation.run(
        effect.occurredAt,
        row.projection_id,
        row.projection_revision_id,
      );
    }
    database
      .prepare(
        `UPDATE layered_projection_state
         SET status = 'pending', updated_at = ?, error_code = NULL
         WHERE singleton = 1`,
      )
      .run(effect.occurredAt);
  } finally {
    closeGuard(database);
  }

  const jobId = enqueue(database, "invalidate", effect);
  if (jobId.length > 160) {
    throw new StorageError("CORRUPTION");
  }
  return jobId;
}
