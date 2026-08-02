import {
  ProjectionRevisionSchema,
  canonicalJson,
  canonicalSha256,
} from "@memo-graph/contracts";
import type Database from "better-sqlite3";

import { StorageError } from "./errors.js";
import type {
  GraphProjectionRepository,
} from "./graph-projection-repository.js";
import {
  ApplyProjectionBatchCommandSchema,
  ClaimProjectionJobsInputSchema,
  ClaimProjectionJobsResultSchema,
  CompleteProjectionJobCommandSchema,
  EnqueueProjectionJobCommandSchema,
  FailProjectionJobCommandSchema,
  InvalidateProjectionDescendantsCommandSchema,
  InvalidateProjectionDescendantsResultSchema,
  MAX_PROJECTION_ATTEMPTS,
  ProjectionBatchResultSchema,
  ProjectionJobMutationResultSchema,
  ProjectionOutboxJobSchema,
  ProjectionPageQuerySchema,
  ProjectionPageResultSchema,
  ProjectionQueryResultSchema,
  ProjectionQuerySchema,
  ProjectionRebuildReceiptSchema,
  ProjectionScopeFrontierInputSchema,
  ProjectionScopeStorageFrontierSchema,
  ProjectionStorageFrontierSchema,
  RecordProjectionRebuildResultSchema,
  type ClaimProjectionJobsResult,
  type InvalidateProjectionDescendantsResult,
  type ParsedApplyProjectionBatchCommand,
  type ParsedProjectionPageQuery,
  type ProjectionBatchResult,
  type ProjectionJobMutationResult,
  type ProjectionPageResult,
  type ProjectionQueryResult,
  type ProjectionScopeStorageFrontier,
  type ProjectionStorageFrontier,
  type RecordProjectionRebuildResult,
} from "./protocol.js";

type ProjectionStateRow = {
  status: "ready" | "pending" | "rebuilding" | "unavailable";
  ledger_epoch: number;
  tombstone_epoch: number;
  projection_epoch: number;
  source_frontier_hash: string | null;
  projection_frontier_hash: string | null;
  transform_versions_json: string;
};

type ExistingBatchRow = {
  request_hash: string;
  result_json: string;
};

type MemorySourceRow = {
  memory_id: string;
  revision_id: string;
  abstraction: "l1_memory";
  principal_id: string;
  scope_kind: string;
  scope_id: string;
  authority: string;
  sensitivity: string;
  valid_from: string;
  valid_to: string | null;
  recorded_at: string;
  content_hash: string;
};

type ProjectionSourceRow = {
  projection_id: string;
  projection_revision_id: string;
  abstraction: string;
  principal_id: string;
  scope_kind: string;
  scope_id: string;
  authority: string;
  sensitivity: string;
  valid_from: string;
  valid_to: string | null;
  recorded_at: string;
  content_hash: string;
  evidence_ids_json: string;
};

type ProjectionObjectRow = {
  projection_type: string;
  abstraction: string;
  principal_id: string;
  scope_kind: string;
  scope_id: string;
  lifecycle: string;
  current_revision_id: string | null;
};

type CurrentProjectionRevisionRow = {
  projection_revision_id: string;
  revision: number;
};

type ProjectionJsonRow = {
  revision_json: string;
};

type ProjectionOutboxRow = {
  job_id: string;
  kind: "refresh" | "invalidate" | "rebuild";
  aggregate_id: string;
  principal_id: string;
  scope_kind:
    | "thread"
    | "topic"
    | "scenario"
    | "user"
    | "workspace"
    | "agent";
  scope_id: string;
  source_revision_ids_json: string;
  status: "pending" | "processing" | "processed" | "failed";
  attempts: number;
  available_at: string;
  claimed_by: string | null;
  lease_expires_at: string | null;
  created_at: string;
  processed_at: string | null;
  last_error_code: string | null;
};

function count(
  database: Database.Database,
  table: string,
  where = "",
): number {
  return Number(
    (
      database
        .prepare(`SELECT count(*) AS count FROM ${table} ${where}`)
        .get() as { count: number }
    ).count,
  );
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const normalizedLeft = uniqueSorted(left);
  const normalizedRight = uniqueSorted(right);
  return (
    left.length === normalizedLeft.length &&
    right.length === normalizedRight.length &&
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every(
      (value, index) => value === normalizedRight[index],
    )
  );
}

export class ProjectionRepository {
  readonly #database: Database.Database;
  readonly #graph: GraphProjectionRepository;

  constructor(
    database: Database.Database,
    graph: GraphProjectionRepository,
  ) {
    this.#database = database;
    this.#graph = graph;
  }

  state(): ProjectionStateRow {
    const available = this.#database
      .prepare(
        `SELECT 1 FROM sqlite_schema
         WHERE type = 'table' AND name = 'layered_projection_state'`,
      )
      .get();
    if (available === undefined) {
      const ledgerEpoch = (
        this.#database
          .prepare(
            "SELECT ledger_epoch FROM ledger_state WHERE singleton = 1",
          )
          .get() as { ledger_epoch: number }
      ).ledger_epoch;
      const tombstoneEpoch = (
        this.#database
          .prepare(
            "SELECT tombstone_epoch FROM tombstone_state WHERE singleton = 1",
          )
          .get() as { tombstone_epoch: number }
      ).tombstone_epoch;
      return {
        status: "ready",
        ledger_epoch: ledgerEpoch,
        tombstone_epoch: tombstoneEpoch,
        projection_epoch: 0,
        source_frontier_hash: null,
        projection_frontier_hash: null,
        transform_versions_json: "[]",
      };
    }
    return this.#database
      .prepare(
        `SELECT status, ledger_epoch, tombstone_epoch, projection_epoch,
                source_frontier_hash, projection_frontier_hash,
                transform_versions_json
         FROM layered_projection_state WHERE singleton = 1`,
      )
      .get() as ProjectionStateRow;
  }

  frontier(): ProjectionStorageFrontier {
    const state = this.state();
    return ProjectionStorageFrontierSchema.parse({
      schema_version: "1.0.0",
      ledger_epoch: state.ledger_epoch,
      tombstone_epoch: state.tombstone_epoch,
      projection_epoch: state.projection_epoch,
      source_frontier_hash: state.source_frontier_hash,
      projection_frontier_hash: state.projection_frontier_hash,
      transform_versions: JSON.parse(state.transform_versions_json),
    });
  }

  scopeFrontier(input: unknown): ProjectionScopeStorageFrontier {
    const query = ProjectionScopeFrontierInputSchema.parse(input);
    const tableAvailable = this.#database
      .prepare(
        `SELECT 1 FROM sqlite_schema
         WHERE type = 'table'
           AND name = 'layered_projection_scope_state'`,
      )
      .get();
    const row =
      tableAvailable === undefined
        ? undefined
        : (this.#database
            .prepare(
              `SELECT status, ledger_epoch, tombstone_epoch,
                      projection_epoch, source_frontier_hash,
                      projection_frontier_hash, transform_versions_json
               FROM layered_projection_scope_state
               WHERE principal_id = ?
                 AND scope_kind = ?
                 AND scope_id = ?`,
            )
            .get(
              query.principal_id,
              query.scope.kind,
              query.scope.id,
            ) as ProjectionStateRow | undefined);
    const state = row ?? this.state();
    return ProjectionScopeStorageFrontierSchema.parse({
      schema_version: "1.0.0",
      principal_id: query.principal_id,
      scope: query.scope,
      status: row?.status ?? "pending",
      ledger_epoch: state.ledger_epoch,
      tombstone_epoch: state.tombstone_epoch,
      projection_epoch: row?.projection_epoch ?? 0,
      source_frontier_hash: row?.source_frontier_hash ?? null,
      projection_frontier_hash:
        row?.projection_frontier_hash ?? null,
      transform_versions:
        row === undefined
          ? []
          : JSON.parse(row.transform_versions_json),
    });
  }

  counts(): {
    projection_objects: number;
    projection_revisions: number;
    projection_sources: number;
    relation_objects: number;
    relation_revisions: number;
    projection_outbox_pending: number;
    projection_outbox_retrying: number;
    projection_outbox_terminal: number;
    projection_rebuild_receipts: number;
  } {
    const available = this.#database
      .prepare(
        `SELECT 1 FROM sqlite_schema
         WHERE type = 'table' AND name = 'projection_objects'`,
      )
      .get();
    if (available === undefined) {
      return {
        projection_objects: 0,
        projection_revisions: 0,
        projection_sources: 0,
        relation_objects: 0,
        relation_revisions: 0,
        projection_outbox_pending: 0,
        projection_outbox_retrying: 0,
        projection_outbox_terminal: 0,
        projection_rebuild_receipts: 0,
      };
    }
    return {
      projection_objects: count(this.#database, "projection_objects"),
      projection_revisions: count(this.#database, "projection_revisions"),
      projection_sources: count(
        this.#database,
        "projection_revision_sources",
      ),
      relation_objects: count(this.#database, "relation_objects"),
      relation_revisions: count(this.#database, "relation_revisions"),
      projection_outbox_pending: count(
        this.#database,
        "projection_outbox_jobs",
        "WHERE status IN ('pending', 'processing', 'failed')",
      ),
      projection_outbox_retrying: count(
        this.#database,
        "projection_outbox_jobs",
        `WHERE status IN ('pending', 'processing')
           OR (status = 'failed' AND attempts < ${MAX_PROJECTION_ATTEMPTS})`,
      ),
      projection_outbox_terminal: count(
        this.#database,
        "projection_outbox_jobs",
        `WHERE status = 'failed'
           AND attempts >= ${MAX_PROJECTION_ATTEMPTS}`,
      ),
      projection_rebuild_receipts: count(
        this.#database,
        "projection_rebuild_receipts",
      ),
    };
  }

  applyBatch(input: unknown): ProjectionBatchResult {
    const command = ApplyProjectionBatchCommandSchema.parse(input);
    const requestHash = canonicalSha256(command);
    const existing = this.#database
      .prepare(
        `SELECT request_hash, result_json
         FROM projection_batches WHERE idempotency_key = ?`,
      )
      .get(command.idempotency_key) as ExistingBatchRow | undefined;
    if (existing !== undefined) {
      if (existing.request_hash !== requestHash) {
        throw new StorageError("CONFLICT");
      }
      return ProjectionBatchResultSchema.parse({
        ...JSON.parse(existing.result_json),
        replayed: true,
      });
    }

    const result = this.#database
      .transaction(() => this.#applyBatch(command, requestHash))
      .immediate();
    return ProjectionBatchResultSchema.parse(result);
  }

  query(input: unknown): ProjectionQueryResult {
    const query = ProjectionQuerySchema.parse(input);
    const typeClause =
      query.projection_types === undefined
        ? ""
        : `AND o.projection_type IN (${query.projection_types
            .map(() => "?")
            .join(", ")})`;
    const lifecycleClause = query.include_inactive
      ? ""
      : `AND o.lifecycle = 'active'
         AND r.lifecycle = 'active'
         AND r.valid_from <= ?
         AND (r.valid_to IS NULL OR r.valid_to > ?)
         AND NOT EXISTS (
           SELECT 1 FROM projection_invalidations AS i
           WHERE i.projection_revision_id = r.projection_revision_id
         )`;
    const parameters = [
      query.principal_id,
      query.scope.kind,
      query.scope.id,
      ...(query.include_inactive ? [] : [query.as_of, query.as_of]),
      ...(query.projection_types ?? []),
      query.limit,
    ];
    const rows = this.#database
      .prepare(
        `SELECT r.revision_json
         FROM projection_objects AS o
         JOIN projection_revisions AS r
           ON r.projection_revision_id = o.current_revision_id
         WHERE o.principal_id = ?
           AND o.scope_kind = ?
           AND o.scope_id = ?
           AND r.purged_at IS NULL
           ${lifecycleClause}
           ${typeClause}
         ORDER BY o.projection_type, o.projection_id,
                  r.revision DESC, r.projection_revision_id
         LIMIT ?`,
      )
      .all(...parameters) as ProjectionJsonRow[];
    return ProjectionQueryResultSchema.parse({
      frontier: this.frontier(),
      items: rows.map((row) =>
        ProjectionRevisionSchema.parse(JSON.parse(row.revision_json))
      ),
    });
  }

  page(input: unknown): ProjectionPageResult {
    const query = ProjectionPageQuerySchema.parse(input);
    const queryHash = canonicalSha256({
      principal_id: query.principal_id,
      scope: query.scope,
      projection_types:
        query.projection_types === undefined
          ? null
          : [...query.projection_types].sort(),
      projection_revision_ids:
        query.projection_revision_ids === undefined
          ? null
          : [...query.projection_revision_ids].sort(),
      include_inactive: query.include_inactive,
      as_of: query.as_of,
    });
    if (
      query.cursor !== undefined &&
      query.cursor.query_hash !== queryHash
    ) {
      throw new StorageError("INVALID_INPUT");
    }
    return this.#database
      .transaction(() => this.#page(query, queryHash))
      .deferred();
  }

  enqueue(input: unknown): ProjectionJobMutationResult {
    const command = EnqueueProjectionJobCommandSchema.parse(input);
    const existing = this.#readJob(command.job_id);
    if (existing !== undefined) {
      const expected = this.#jobFromRow(existing);
      const same =
        expected.kind === command.kind &&
        expected.aggregate_id === command.aggregate_id &&
        expected.principal_id === command.principal_id &&
        canonicalJson(expected.scope) === canonicalJson(command.scope) &&
        sameStrings(
          expected.source_revision_ids,
          command.source_revision_ids,
        ) &&
        expected.available_at === command.available_at &&
        expected.created_at === command.created_at;
      if (!same) {
        throw new StorageError("CONFLICT");
      }
      return ProjectionJobMutationResultSchema.parse({
        job: expected,
        replayed: true,
      });
    }

    this.#database
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
        command.job_id,
        command.kind,
        command.aggregate_id,
        command.principal_id,
        command.scope.kind,
        command.scope.id,
        canonicalJson(uniqueSorted(command.source_revision_ids)),
        command.available_at,
        command.created_at,
      );
    const inserted = this.#readJob(command.job_id);
    if (inserted === undefined) {
      throw new StorageError("CORRUPTION");
    }
    return ProjectionJobMutationResultSchema.parse({
      job: this.#jobFromRow(inserted),
      replayed: false,
    });
  }

  claim(input: unknown): ClaimProjectionJobsResult {
    const request = ClaimProjectionJobsInputSchema.parse(input);
    const jobs = this.#database
      .transaction(() => {
        this.#openGuard("claim");
        try {
          this.#database
            .prepare(
              `UPDATE projection_outbox_jobs
               SET status = 'failed',
                   claimed_by = NULL,
                   lease_expires_at = NULL,
                   last_error_code = 'LEASE_EXPIRED'
               WHERE status = 'processing'
                 AND lease_expires_at <= ?`,
            )
            .run(request.claimed_at);
          const rows = this.#database
            .prepare(
              `SELECT job_id
               FROM projection_outbox_jobs
              WHERE status IN ('pending', 'failed')
                 AND attempts < ?
                 AND available_at <= ?
               ORDER BY available_at, job_id
               LIMIT ?`,
            )
            .all(
              MAX_PROJECTION_ATTEMPTS,
              request.claimed_at,
              request.limit,
            ) as Array<{
            job_id: string;
          }>;
          const update = this.#database.prepare(
            `UPDATE projection_outbox_jobs
             SET status = 'processing',
                 attempts = attempts + 1,
                 claimed_by = ?,
                 lease_expires_at = ?,
                 processed_at = NULL,
                 last_error_code = NULL
             WHERE job_id = ?
               AND status IN ('pending', 'failed')`,
          );
          for (const row of rows) {
            update.run(
              request.worker_id,
              request.lease_expires_at,
              row.job_id,
            );
          }
          return rows.map((row) => {
            const claimed = this.#readJob(row.job_id);
            if (claimed === undefined) {
              throw new StorageError("CORRUPTION");
            }
            return this.#jobFromRow(claimed);
          });
        } finally {
          this.#closeGuard();
        }
      })
      .immediate();
    return ClaimProjectionJobsResultSchema.parse({ jobs });
  }

  fail(input: unknown): ProjectionJobMutationResult {
    const command = FailProjectionJobCommandSchema.parse(input);
    const result = this.#database
      .transaction(() => {
        const row = this.#readJob(command.job_id);
        if (
          row === undefined ||
          row.status !== "processing" ||
          row.claimed_by !== command.worker_id
        ) {
          throw new StorageError("CONFLICT");
        }
        this.#openGuard("fail");
        try {
          this.#database
            .prepare(
              `UPDATE projection_outbox_jobs
               SET status = 'failed',
                   available_at = ?,
                   claimed_by = NULL,
                   lease_expires_at = NULL,
                   processed_at = NULL,
                   last_error_code = ?
               WHERE job_id = ?`,
            )
            .run(
              command.retry_at,
              command.error_code,
              command.job_id,
            );
        } finally {
          this.#closeGuard();
        }
        const failed = this.#readJob(command.job_id);
        if (failed === undefined) {
          throw new StorageError("CORRUPTION");
        }
        return {
          job: this.#jobFromRow(failed),
          replayed: false,
        };
      })
      .immediate();
    return ProjectionJobMutationResultSchema.parse(result);
  }

  complete(input: unknown): ProjectionJobMutationResult {
    const command = CompleteProjectionJobCommandSchema.parse(input);
    const result = this.#database
      .transaction(() => {
        const row = this.#readJob(command.job_id);
        if (row === undefined) {
          throw new StorageError("INVALID_INPUT");
        }
        if (row.status === "processed") {
          return {
            job: this.#jobFromRow(row),
            replayed: true,
          };
        }
        if (
          row.status !== "processing" ||
          row.claimed_by !== command.worker_id
        ) {
          throw new StorageError("CONFLICT");
        }
        this.#openGuard("complete");
        try {
          this.#database
            .prepare(
              `UPDATE projection_outbox_jobs
               SET status = 'processed',
                   claimed_by = NULL,
                   lease_expires_at = NULL,
                   processed_at = ?,
                   last_error_code = NULL
               WHERE job_id = ?`,
            )
            .run(command.completed_at, command.job_id);
        } finally {
          this.#closeGuard();
        }
        const completed = this.#readJob(command.job_id);
        if (completed === undefined) {
          throw new StorageError("CORRUPTION");
        }
        return {
          job: this.#jobFromRow(completed),
          replayed: false,
        };
      })
      .immediate();
    return ProjectionJobMutationResultSchema.parse(result);
  }

  invalidateDescendants(
    input: unknown,
  ): InvalidateProjectionDescendantsResult {
    const command =
      InvalidateProjectionDescendantsCommandSchema.parse(input);
    const result = this.#database
      .transaction(() => {
        const placeholders = command.source_revision_ids
          .map(() => "?")
          .join(", ");
        const rows = this.#database
          .prepare(
            `WITH RECURSIVE descendants(
               projection_id, projection_revision_id, source_revision_id
             ) AS (
               SELECT r.projection_id, s.projection_revision_id,
                      s.source_revision_id
               FROM projection_revision_sources AS s
               JOIN projection_revisions AS r
                 ON r.projection_revision_id = s.projection_revision_id
               WHERE s.source_revision_id IN (${placeholders})
               UNION
               SELECT r.projection_id, s.projection_revision_id,
                      s.source_revision_id
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
          .all(...command.source_revision_ids) as Array<{
          projection_id: string;
          projection_revision_id: string;
        }>;
        this.#openGuard("invalidate");
        try {
          const insert = this.#database.prepare(
            `INSERT OR IGNORE INTO projection_invalidations (
               invalidation_id, projection_id, projection_revision_id,
               source_revision_id, reason, invalidated_at
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          );
          const update = this.#database.prepare(
            `UPDATE projection_objects
             SET lifecycle = 'superseded', updated_at = ?
             WHERE projection_id = ?
               AND current_revision_id = ?`,
          );
          for (const row of rows) {
            const sourceRevisionId =
              command.source_revision_ids.find((source) =>
                this.#descendsFrom(
                  row.projection_revision_id,
                  source,
                )
              ) ?? command.source_revision_ids[0];
            if (sourceRevisionId === undefined) {
              throw new StorageError("CORRUPTION");
            }
            insert.run(
              `projection_invalidation:${canonicalSha256({
                projection_revision_id: row.projection_revision_id,
                source_revision_id: sourceRevisionId,
                reason: command.reason,
              }).slice("sha256:".length, 57)}`,
              row.projection_id,
              row.projection_revision_id,
              sourceRevisionId,
              command.reason,
              command.invalidated_at,
            );
            update.run(
              command.invalidated_at,
              row.projection_id,
              row.projection_revision_id,
            );
          }
        } finally {
          this.#closeGuard();
        }
        return {
          projection_ids: uniqueSorted(
            rows.map((row) => row.projection_id),
          ),
          projection_revision_ids: uniqueSorted(
            rows.map((row) => row.projection_revision_id),
          ),
        };
      })
      .immediate();
    return InvalidateProjectionDescendantsResultSchema.parse(result);
  }

  recordRebuild(input: unknown): RecordProjectionRebuildResult {
    const receipt = ProjectionRebuildReceiptSchema.parse(input);
    const existing = this.#database
      .prepare(
        `SELECT receipt_json FROM projection_rebuild_receipts
         WHERE rebuild_receipt_id = ?`,
      )
      .get(receipt.rebuild_receipt_id) as
      | { receipt_json: string }
      | undefined;
    if (existing !== undefined) {
      const stored = ProjectionRebuildReceiptSchema.parse(
        JSON.parse(existing.receipt_json),
      );
      if (canonicalJson(stored) !== canonicalJson(receipt)) {
        throw new StorageError("CONFLICT");
      }
      return RecordProjectionRebuildResultSchema.parse({
        receipt: stored,
        replayed: true,
      });
    }
    this.#database
      .prepare(
        `INSERT INTO projection_rebuild_receipts (
           rebuild_receipt_id, mode, projection_epoch, structural_digest,
           projection_count, relation_count, receipt_json, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.rebuild_receipt_id,
        receipt.mode,
        receipt.projection_epoch,
        receipt.structural_digest,
        receipt.projection_count,
        receipt.relation_count,
        canonicalJson(receipt),
        receipt.completed_at,
      );
    return RecordProjectionRebuildResultSchema.parse({
      receipt,
      replayed: false,
    });
  }

  #applyBatch(
    command: ParsedApplyProjectionBatchCommand,
    requestHash: string,
  ): ProjectionBatchResult {
    const state = this.state();
    if (state.projection_epoch !== command.expected_projection_epoch) {
      throw new StorageError("CONFLICT");
    }
    const ledgerEpoch = (
      this.#database
        .prepare(
          "SELECT ledger_epoch FROM ledger_state WHERE singleton = 1",
        )
        .get() as { ledger_epoch: number }
    ).ledger_epoch;
    const tombstoneEpoch = (
      this.#database
        .prepare(
          "SELECT tombstone_epoch FROM tombstone_state WHERE singleton = 1",
        )
        .get() as { tombstone_epoch: number }
    ).tombstone_epoch;
    const first = command.projections[0];
    const batchFrontier = command.frontier ?? first?.frontier;
    if (
      batchFrontier === undefined ||
      batchFrontier.ledger_epoch !== ledgerEpoch ||
      batchFrontier.tombstone_epoch !== tombstoneEpoch
    ) {
      throw new StorageError("CONFLICT");
    }

    if (command.claimed_job !== undefined) {
      const job = this.#readJob(command.claimed_job.job_id);
      if (
        job === undefined ||
        job.status !== "processing" ||
        job.claimed_by !== command.claimed_job.worker_id ||
        job.principal_id !== command.principal_id ||
        job.scope_kind !== command.scope.kind ||
        job.scope_id !== command.scope.id
      ) {
        throw new StorageError("CONFLICT");
      }
    }

    this.#assertRetirements(
      command.retire_projection_revision_ids ?? [],
      command.principal_id,
      command.scope,
    );
    for (const projection of command.projections) {
      this.#assertSources(projection);
    }

    this.#openGuard("apply");
    try {
      for (const projectionRevisionId of
        command.retire_projection_revision_ids ?? []) {
        this.#retireProjection(
          projectionRevisionId,
          command.principal_id,
          command.scope,
          command.applied_at,
        );
      }
      for (const projection of command.projections) {
        this.#insertProjection(projection);
      }
      const transforms = command.projections
        .map((projection) => projection.transform)
        .filter(
          (transform, index, values) =>
            values.findIndex(
              (candidate) =>
                candidate.name === transform.name &&
                candidate.version === transform.version,
            ) === index,
        )
        .concat(command.projections.length === 0
          ? [batchFrontier.transform]
          : [])
        .sort((left, right) =>
          `${left.name}:${left.version}`.localeCompare(
            `${right.name}:${right.version}`,
          )
        );
      this.#database
        .prepare(
          `UPDATE layered_projection_state
           SET status = 'ready',
               ledger_epoch = ?,
               tombstone_epoch = ?,
               projection_epoch = ?,
               source_frontier_hash = ?,
               projection_frontier_hash = ?,
               transform_versions_json = ?,
               updated_at = ?,
               error_code = NULL
           WHERE singleton = 1`,
        )
        .run(
          batchFrontier.ledger_epoch,
          batchFrontier.tombstone_epoch,
          batchFrontier.projection_epoch,
          batchFrontier.source_frontier_hash,
          batchFrontier.projection_frontier_hash,
          canonicalJson(transforms),
          command.applied_at,
        );
      this.#database
        .prepare(
          `INSERT INTO layered_projection_scope_state (
             principal_id, scope_kind, scope_id, status, ledger_epoch,
             tombstone_epoch, projection_epoch, source_frontier_hash,
             projection_frontier_hash, transform_versions_json, updated_at,
             error_code
           ) VALUES (?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, NULL)
           ON CONFLICT (principal_id, scope_kind, scope_id) DO UPDATE SET
             status = excluded.status,
             ledger_epoch = excluded.ledger_epoch,
             tombstone_epoch = excluded.tombstone_epoch,
             projection_epoch = excluded.projection_epoch,
             source_frontier_hash = excluded.source_frontier_hash,
             projection_frontier_hash =
               excluded.projection_frontier_hash,
             transform_versions_json =
               excluded.transform_versions_json,
             updated_at = excluded.updated_at,
             error_code = NULL`,
        )
        .run(
          command.principal_id,
          command.scope.kind,
          command.scope.id,
          batchFrontier.ledger_epoch,
          batchFrontier.tombstone_epoch,
          batchFrontier.projection_epoch,
          batchFrontier.source_frontier_hash,
          batchFrontier.projection_frontier_hash,
          canonicalJson(transforms),
          command.applied_at,
        );
      this.#graph.enqueueReadyScope({
        principal_id: command.principal_id,
        scope: command.scope,
        frontier: batchFrontier,
        available_at: command.applied_at,
      });
      if (command.claimed_job !== undefined) {
        this.#database
          .prepare(
            `UPDATE projection_outbox_jobs
             SET status = 'processed',
                 claimed_by = NULL,
                 lease_expires_at = NULL,
                 processed_at = ?,
                 last_error_code = NULL
             WHERE job_id = ?`,
          )
          .run(command.applied_at, command.claimed_job.job_id);
      }
    } finally {
      this.#closeGuard();
    }

    const result = ProjectionBatchResultSchema.parse({
      replayed: false,
      projection_epoch: batchFrontier.projection_epoch,
      projection_revision_ids: command.projections
        .map((projection) => projection.projection_revision_id)
        .sort(),
      relation_revision_ids: command.projections
        .filter((projection) => projection.projection_type === "relation")
        .map((projection) => projection.projection_revision_id)
        .sort(),
      frontier: this.frontier(),
    });
    this.#database
      .prepare(
        `INSERT INTO projection_batches (
           idempotency_key, request_hash, projection_epoch, frontier_json,
           result_json, applied_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        command.idempotency_key,
        requestHash,
        result.projection_epoch,
        canonicalJson(result.frontier),
        canonicalJson(result),
        command.applied_at,
      );
    return result;
  }

  #page(
    query: ParsedProjectionPageQuery,
    queryHash: `sha256:${string}`,
  ): ProjectionPageResult {
    const scopeFrontier = this.scopeFrontier({
      principal_id: query.principal_id,
      scope: query.scope,
    });
    if (scopeFrontier.status !== "ready") {
      throw new StorageError("STORAGE_UNAVAILABLE", {
        retryable: true,
      });
    }
    const scopeFrontierHash = canonicalSha256(scopeFrontier);
    if (
      query.cursor !== undefined &&
      query.cursor.scope_frontier_hash !== scopeFrontierHash
    ) {
      throw new StorageError("STALE_PROJECTION_FRONTIER", {
        retryable: true,
      });
    }

    const lifecycleClause = query.include_inactive
      ? ""
      : `AND o.lifecycle = 'active'
         AND r.lifecycle = 'active'
         AND r.valid_from <= ?
         AND (r.valid_to IS NULL OR r.valid_to > ?)
         AND NOT EXISTS (
           SELECT 1 FROM projection_invalidations AS i
           WHERE i.projection_revision_id = r.projection_revision_id
         )`;
    const typeClause =
      query.projection_types === undefined
        ? ""
        : `AND o.projection_type IN (${query.projection_types
            .map(() => "?")
            .join(", ")})`;
    const revisionClause =
      query.projection_revision_ids === undefined
        ? ""
        : `AND r.projection_revision_id IN (${query.projection_revision_ids
            .map(() => "?")
            .join(", ")})`;
    const cursorClause =
      query.cursor === undefined
        ? ""
        : `AND (
           o.projection_type > ?
           OR (
             o.projection_type = ?
             AND o.projection_id > ?
           )
         )`;
    const baseParameters = [
      query.principal_id,
      query.scope.kind,
      query.scope.id,
      ...(query.include_inactive ? [] : [query.as_of, query.as_of]),
      ...(query.projection_types ?? []),
      ...(query.projection_revision_ids ?? []),
    ];
    const fromAndWhere = `
      FROM projection_objects AS o
      JOIN projection_revisions AS r
        ON r.projection_revision_id = o.current_revision_id
      WHERE o.principal_id = ?
        AND o.scope_kind = ?
        AND o.scope_id = ?
        AND r.purged_at IS NULL
        ${lifecycleClause}
        ${typeClause}
        ${revisionClause}`;
    const totalCount = Number(
      (
        this.#database
          .prepare(`SELECT count(*) AS count ${fromAndWhere}`)
          .get(...baseParameters) as { count: number }
      ).count,
    );
    const cursorParameters =
      query.cursor === undefined
        ? []
        : [
            query.cursor.projection_type,
            query.cursor.projection_type,
            query.cursor.projection_id,
          ];
    const rows = this.#database
      .prepare(
        `SELECT r.revision_json
         ${fromAndWhere}
         ${cursorClause}
         ORDER BY o.projection_type, o.projection_id
         LIMIT ?`,
      )
      .all(
        ...baseParameters,
        ...cursorParameters,
        query.limit + 1,
      ) as ProjectionJsonRow[];
    const hasMore = rows.length > query.limit;
    const items = rows.slice(0, query.limit).map((row) =>
      ProjectionRevisionSchema.parse(JSON.parse(row.revision_json))
    );
    const last = items.at(-1);
    return ProjectionPageResultSchema.parse({
      scope_frontier: scopeFrontier,
      items,
      examined_count: items.length,
      total_count: totalCount,
      next_cursor:
        hasMore && last !== undefined
          ? {
              schema_version: "1.0.0",
              projection_type: last.projection_type,
              projection_id: last.projection_id,
              query_hash: queryHash,
              scope_frontier_hash: scopeFrontierHash,
            }
          : null,
      exhausted: !hasMore,
    });
  }

  #assertRetirements(
    projectionRevisionIds: readonly string[],
    principalId: string,
    scope: { kind: string; id: string },
  ): void {
    const read = this.#database.prepare(
      `SELECT 1
       FROM projection_revisions AS r
       JOIN projection_objects AS o
         ON o.projection_id = r.projection_id
        AND o.current_revision_id = r.projection_revision_id
       WHERE r.projection_revision_id = ?
         AND o.principal_id = ?
         AND o.scope_kind = ?
         AND o.scope_id = ?`,
    );
    for (const projectionRevisionId of projectionRevisionIds) {
      if (
        read.get(
          projectionRevisionId,
          principalId,
          scope.kind,
          scope.id,
        ) === undefined
      ) {
        throw new StorageError("CONFLICT");
      }
    }
  }

  #retireProjection(
    projectionRevisionId: string,
    principalId: string,
    scope: { kind: string; id: string },
    retiredAt: string,
  ): void {
    const row = this.#database
      .prepare(
        `SELECT r.projection_id
         FROM projection_revisions AS r
         JOIN projection_objects AS o
           ON o.projection_id = r.projection_id
          AND o.current_revision_id = r.projection_revision_id
         WHERE r.projection_revision_id = ?
           AND o.principal_id = ?
           AND o.scope_kind = ?
           AND o.scope_id = ?`,
      )
      .get(
        projectionRevisionId,
        principalId,
        scope.kind,
        scope.id,
      ) as { projection_id: string } | undefined;
    if (row === undefined) {
      throw new StorageError("CONFLICT");
    }
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO projection_invalidations (
           invalidation_id, projection_id, projection_revision_id,
           source_revision_id, reason, invalidated_at
         ) VALUES (?, ?, ?, ?, 'PROJECTION_BATCH_REPLACED', ?)`,
      )
      .run(
        `projection-invalidation:${canonicalSha256({
          projection_revision_id: projectionRevisionId,
          reason: "PROJECTION_BATCH_REPLACED",
        }).slice("sha256:".length, 42)}`,
        row.projection_id,
        projectionRevisionId,
        projectionRevisionId,
        retiredAt,
      );
    this.#database
      .prepare(
        `UPDATE projection_objects
         SET lifecycle = 'superseded', updated_at = ?
         WHERE projection_id = ? AND current_revision_id = ?`,
      )
      .run(retiredAt, row.projection_id, projectionRevisionId);
    this.#database
      .prepare(
        `UPDATE relation_objects
         SET lifecycle = 'superseded', updated_at = ?
         WHERE relation_id = ? AND current_relation_revision_id = ?`,
      )
      .run(retiredAt, row.projection_id, projectionRevisionId);
  }

  #insertProjection(
    projection: ReturnType<typeof ProjectionRevisionSchema.parse>,
  ): void {
    const existingObject = this.#database
      .prepare(
        `SELECT projection_type, abstraction, principal_id, scope_kind,
                scope_id, lifecycle, current_revision_id
         FROM projection_objects WHERE projection_id = ?`,
      )
      .get(projection.projection_id) as ProjectionObjectRow | undefined;
    if (existingObject === undefined) {
      this.#database
        .prepare(
          `INSERT INTO projection_objects (
             projection_id, projection_type, abstraction, principal_id,
             scope_kind, scope_id, lifecycle, current_revision_id,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          projection.projection_id,
          projection.projection_type,
          projection.abstraction,
          projection.principal_id,
          projection.scope.kind,
          projection.scope.id,
          "working",
          projection.created_at,
          projection.created_at,
        );
    } else {
      if (
        existingObject.projection_type !== projection.projection_type ||
        existingObject.abstraction !== projection.abstraction ||
        existingObject.principal_id !== projection.principal_id ||
        existingObject.scope_kind !== projection.scope.kind ||
        existingObject.scope_id !== projection.scope.id
      ) {
        throw new StorageError("CONFLICT");
      }
      const current =
        existingObject.current_revision_id === null
          ? undefined
          : (this.#database
              .prepare(
                `SELECT projection_revision_id, revision
                 FROM projection_revisions
                 WHERE projection_revision_id = ?`,
              )
              .get(existingObject.current_revision_id) as
              | CurrentProjectionRevisionRow
              | undefined);
      if (
        current === undefined ||
        projection.revision !== current.revision + 1 ||
        projection.supersedes_projection_revision_id !==
          current.projection_revision_id
      ) {
        throw new StorageError("CONFLICT");
      }
    }

    this.#database
      .prepare(
        `INSERT INTO projection_revisions (
           projection_revision_id, projection_id, revision, projection_type,
           abstraction, principal_id, scope_kind, scope_id, lifecycle,
           authority, sensitivity, valid_from, valid_to, recorded_at,
           content_hash, payload_json, content_json, evidence_ids_json,
           supersedes_projection_revision_id, transform_name,
           transform_version, ledger_epoch, tombstone_epoch,
           projection_epoch, source_frontier_hash,
           projection_frontier_hash, revision_json, created_at, purged_at
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?, ?, ?, NULL
         )`,
      )
      .run(
        projection.projection_revision_id,
        projection.projection_id,
        projection.revision,
        projection.projection_type,
        projection.abstraction,
        projection.principal_id,
        projection.scope.kind,
        projection.scope.id,
        projection.lifecycle,
        projection.authority,
        projection.sensitivity,
        projection.validity.valid_from,
        projection.validity.valid_to,
        projection.validity.recorded_at,
        projection.content_hash,
        projection.payload === null
          ? null
          : canonicalJson(projection.payload),
        projection.content === null
          ? null
          : canonicalJson(projection.content),
        canonicalJson(projection.evidence_ids),
        projection.supersedes_projection_revision_id,
        projection.transform.name,
        projection.transform.version,
        projection.frontier.ledger_epoch,
        projection.frontier.tombstone_epoch,
        projection.frontier.projection_epoch,
        projection.frontier.source_frontier_hash,
        projection.frontier.projection_frontier_hash,
        canonicalJson(projection),
        projection.created_at,
      );

    const insertSource = this.#database.prepare(
      `INSERT INTO projection_revision_sources (
         projection_revision_id, ordinal, source_kind, source_revision_id,
         source_memory_id, source_projection_id, source_abstraction,
         source_content_hash, source_principal_id, source_scope_kind,
         source_scope_id, source_authority, source_sensitivity,
         source_valid_from, source_valid_to, source_recorded_at,
         evidence_ids_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [index, source] of projection.source_revisions.entries()) {
      const isMemory = source.abstraction === "l1_memory";
      const sourceProjectionId = isMemory
        ? null
        : (this.#database
            .prepare(
              `SELECT projection_id FROM projection_revisions
               WHERE projection_revision_id = ?`,
            )
            .get(source.revision_id) as
            | { projection_id: string }
            | undefined)?.projection_id ?? null;
      insertSource.run(
        projection.projection_revision_id,
        index,
        isMemory ? "memory_revision" : "projection_revision",
        source.revision_id,
        isMemory ? source.memory_id : null,
        sourceProjectionId,
        source.abstraction,
        source.content_hash,
        source.principal_id,
        source.scope.kind,
        source.scope.id,
        source.authority,
        source.sensitivity,
        source.validity.valid_from,
        source.validity.valid_to,
        source.validity.recorded_at,
        canonicalJson(source.evidence_ids),
      );
    }

    if (projection.payload?.kind === "relation") {
      this.#insertRelation(projection);
    }
    this.#database
      .prepare(
        `UPDATE projection_objects
         SET lifecycle = ?, current_revision_id = ?, updated_at = ?
         WHERE projection_id = ?`,
      )
      .run(
        projection.lifecycle,
        projection.projection_revision_id,
        projection.created_at,
        projection.projection_id,
      );
  }

  #insertRelation(
    projection: ReturnType<typeof ProjectionRevisionSchema.parse>,
  ): void {
    const payload = projection.payload;
    if (payload?.kind !== "relation") {
      throw new StorageError("CORRUPTION");
    }
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO relation_objects (
           relation_id, principal_id, scope_kind, scope_id, lifecycle,
           current_relation_revision_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        projection.projection_id,
        projection.principal_id,
        projection.scope.kind,
        projection.scope.id,
        "working",
        projection.created_at,
        projection.created_at,
      );
    this.#database
      .prepare(
        `INSERT INTO relation_revisions (
           relation_revision_id, relation_id, projection_revision_id,
           revision, source_revision_id, target_revision_id, relation_type,
           direction, description, principal_id, scope_kind, scope_id,
           lifecycle, valid_from, valid_to, projection_epoch,
           relation_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        projection.projection_revision_id,
        projection.projection_id,
        projection.projection_revision_id,
        projection.revision,
        payload.source_revision_id,
        payload.target_revision_id,
        payload.relation_type,
        payload.direction,
        payload.description,
        projection.principal_id,
        projection.scope.kind,
        projection.scope.id,
        projection.lifecycle,
        projection.validity.valid_from,
        projection.validity.valid_to,
        projection.frontier.projection_epoch,
        canonicalJson(payload),
        projection.created_at,
      );
    this.#database
      .prepare(
        `UPDATE relation_objects
         SET lifecycle = ?, current_relation_revision_id = ?, updated_at = ?
         WHERE relation_id = ?`,
      )
      .run(
        projection.lifecycle,
        projection.projection_revision_id,
        projection.created_at,
        projection.projection_id,
      );
  }

  #assertSources(
    projection: ReturnType<typeof ProjectionRevisionSchema.parse>,
  ): void {
    for (const source of projection.source_revisions) {
      if (source.abstraction === "l1_memory") {
        const row = this.#database
          .prepare(
            `SELECT r.memory_id, r.revision_id, r.abstraction,
                    o.principal_id, r.scope_kind, r.scope_id, r.authority,
                    r.sensitivity, r.valid_from, r.valid_to, r.recorded_at,
                    r.content_hash
             FROM memory_revisions AS r
             JOIN memory_objects AS o
               ON o.memory_id = r.memory_id
              AND o.current_revision_id = r.revision_id
             WHERE r.revision_id = ?
               AND r.memory_id = ?
               AND o.lifecycle = 'active'
               AND o.context_eligible = 1
               AND r.lifecycle = 'active'
               AND r.purged_at IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM memory_tombstones AS t
                 WHERE t.memory_id = r.memory_id
               )`,
          )
          .get(source.revision_id, source.memory_id) as
          | MemorySourceRow
          | undefined;
        if (row === undefined || !this.#sourceMatches(source, row)) {
          throw new StorageError("INVALID_INPUT");
        }
        const evidence = (
          this.#database
            .prepare(
              `SELECT evidence_id
               FROM memory_revision_evidence
               WHERE revision_id = ?
               ORDER BY evidence_id`,
            )
            .all(source.revision_id) as Array<{ evidence_id: string }>
        ).map((entry) => entry.evidence_id);
        if (!sameStrings(source.evidence_ids, evidence)) {
          throw new StorageError("INVALID_INPUT");
        }
        continue;
      }

      const row = this.#database
        .prepare(
          `SELECT r.projection_id, r.projection_revision_id, r.abstraction,
                  r.principal_id, r.scope_kind, r.scope_id, r.authority,
                  r.sensitivity, r.valid_from, r.valid_to, r.recorded_at,
                  r.content_hash, r.evidence_ids_json
           FROM projection_revisions AS r
           JOIN projection_objects AS o
             ON o.projection_id = r.projection_id
            AND o.current_revision_id = r.projection_revision_id
           WHERE r.projection_revision_id = ?
             AND o.lifecycle = 'active'
             AND r.lifecycle = 'active'
             AND r.purged_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM projection_invalidations AS i
               WHERE i.projection_revision_id = r.projection_revision_id
             )`,
        )
        .get(source.revision_id) as ProjectionSourceRow | undefined;
      if (
        row === undefined ||
        row.projection_id !== source.memory_id ||
        !this.#sourceMatches(source, row) ||
        !sameStrings(
          source.evidence_ids,
          JSON.parse(row.evidence_ids_json),
        )
      ) {
        throw new StorageError("INVALID_INPUT");
      }
    }
  }

  #sourceMatches(
    source: {
      revision_id: string;
      abstraction: string;
      principal_id: string;
      scope: { kind: string; id: string };
      authority: string;
      sensitivity: string;
      validity: {
        valid_from: string;
        valid_to: string | null;
        recorded_at: string;
      };
      content_hash: string;
    },
    row: {
      revision_id?: string;
      projection_revision_id?: string;
      abstraction: string;
      principal_id: string;
      scope_kind: string;
      scope_id: string;
      authority: string;
      sensitivity: string;
      valid_from: string;
      valid_to: string | null;
      recorded_at: string;
      content_hash: string;
    },
  ): boolean {
    return (
      (row.revision_id ?? row.projection_revision_id) ===
        source.revision_id &&
      row.abstraction === source.abstraction &&
      row.principal_id === source.principal_id &&
      row.scope_kind === source.scope.kind &&
      row.scope_id === source.scope.id &&
      row.authority === source.authority &&
      row.sensitivity === source.sensitivity &&
      row.valid_from === source.validity.valid_from &&
      row.valid_to === source.validity.valid_to &&
      row.recorded_at === source.validity.recorded_at &&
      row.content_hash === source.content_hash
    );
  }

  #readJob(jobId: string): ProjectionOutboxRow | undefined {
    return this.#database
      .prepare(
        `SELECT job_id, kind, aggregate_id, principal_id, scope_kind,
                scope_id, source_revision_ids_json, status, attempts,
                available_at, claimed_by, lease_expires_at, created_at,
                processed_at, last_error_code
         FROM projection_outbox_jobs WHERE job_id = ?`,
      )
      .get(jobId) as ProjectionOutboxRow | undefined;
  }

  #jobFromRow(row: ProjectionOutboxRow) {
    return ProjectionOutboxJobSchema.parse({
      job_id: row.job_id,
      kind: row.kind,
      aggregate_id: row.aggregate_id,
      principal_id: row.principal_id,
      scope: { kind: row.scope_kind, id: row.scope_id },
      source_revision_ids: JSON.parse(row.source_revision_ids_json),
      status: row.status,
      attempts: row.attempts,
      available_at: row.available_at,
      claimed_by: row.claimed_by,
      lease_expires_at: row.lease_expires_at,
      created_at: row.created_at,
      processed_at: row.processed_at,
      last_error_code: row.last_error_code,
    });
  }

  #descendsFrom(
    projectionRevisionId: string,
    sourceRevisionId: string,
  ): boolean {
    return (
      this.#database
        .prepare(
          `WITH RECURSIVE ancestors(revision_id) AS (
             SELECT source_revision_id
             FROM projection_revision_sources
             WHERE projection_revision_id = ?
             UNION
             SELECT s.source_revision_id
             FROM projection_revision_sources AS s
             JOIN ancestors AS a
               ON s.projection_revision_id = a.revision_id
           )
           SELECT 1 AS found FROM ancestors
           WHERE revision_id = ? LIMIT 1`,
        )
        .get(projectionRevisionId, sourceRevisionId) !== undefined
    );
  }

  #openGuard(operation: string): void {
    this.#database
      .prepare(
        `INSERT INTO projection_write_guard (
           singleton, operation, opened_at
         ) VALUES (1, ?, ?)`,
      )
      .run(operation, new Date().toISOString());
  }

  #closeGuard(): void {
    this.#database
      .prepare("DELETE FROM projection_write_guard WHERE singleton = 1")
      .run();
  }
}
