import {
  GraphDeliveryReceiptSchema,
  GraphNodeSchema,
  GraphScopeCheckpointSchema,
  ProjectionRevisionSchema,
  buildGraphScopeSnapshot,
  canonicalJson,
  canonicalSha256,
  type GraphDeliveryReceipt,
  type GraphScopeCheckpoint,
  type GraphScopeSnapshot,
  type ProjectionFrontier,
} from "@memo-graph/contracts";
import type Database from "better-sqlite3";

import { StorageError } from "./errors.js";
import {
  ApplyGraphProjectionJobCommandSchema,
  ClaimGraphProjectionJobsInputSchema,
  ClaimGraphProjectionJobsResultSchema,
  FailGraphProjectionJobCommandSchema,
  GraphProjectionJobResultSchema,
  GraphProjectionSnapshotListInputSchema,
  GraphProjectionSnapshotListResultSchema,
  GraphProjectionOutboxJobSchema,
  GraphProjectionStatusSchema,
  GraphScopeInputSchema,
  GraphScopeSnapshotResultSchema,
  MarkGraphRestoreUnavailableInputSchema,
  MarkGraphRestoreUnavailableResultSchema,
  MAX_GRAPH_PROJECTION_ATTEMPTS,
  ResetGraphProjectionScopesInputSchema,
  ResetGraphProjectionScopesResultSchema,
  type ClaimGraphProjectionJobsResult,
  type GraphProjectionJobResult,
  type GraphProjectionSnapshotListResult,
  type GraphProjectionOutboxJob,
  type GraphProjectionStatus,
  type GraphScopeSnapshotResult,
  type ResetGraphProjectionScopesResult,
} from "./protocol.js";

type ExactScope = {
  principal_id: string;
  scope: {
    kind: "thread" | "topic" | "scenario" | "user" | "workspace" | "agent";
    id: string;
  };
};

export type CanonicalGraphProjectionEffect = ExactScope & {
  cause_id: string;
  revision_id: string;
  occurred_at: string;
};

type ScopeStateRow = {
  backend: "ladybugdb";
  principal_id: string;
  scope_kind: ExactScope["scope"]["kind"];
  scope_id: string;
  status: GraphScopeCheckpoint["status"];
  ledger_epoch: number;
  tombstone_epoch: number;
  projection_epoch: number;
  graph_projection_epoch: number;
  frontier_json: string | null;
  logical_digest: string | null;
  backend_identity_json: string | null;
  updated_at: string;
  last_failure: string | null;
};

type JobRow = {
  job_id: string;
  operation: "scope_replace" | "full_rebuild";
  backend: "ladybugdb";
  principal_id: string;
  scope_kind: ExactScope["scope"]["kind"];
  scope_id: string;
  target_frontier_json: string | null;
  expected_logical_digest: string | null;
  status: GraphProjectionOutboxJob["status"];
  attempts: number;
  available_at: string;
  claimed_by: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  created_at: string;
  completed_at: string | null;
  last_failure: string | null;
};

type MemoryNodeRow = {
  memory_id: string;
  revision_id: string;
  valid_from: string;
  valid_to: string | null;
  recorded_at: string;
  content_hash: string;
};

type ProjectionJsonRow = {
  revision_json: string;
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

function stableIdentifier(prefix: string, input: unknown): string {
  return `${prefix}:${canonicalSha256(input).slice("sha256:".length, 54)}`;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export class GraphProjectionRepository {
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  checkpoint(input: unknown): GraphScopeCheckpoint {
    const request = GraphScopeInputSchema.parse(input);
    const row = this.#readScope(request);
    if (row === undefined) {
      return GraphScopeCheckpointSchema.parse({
        schema_version: "1.0.0",
        backend: request.backend,
        principal_id: request.principal_id,
        scope: request.scope,
        status: "disabled",
        frontier: null,
        graph_projection_epoch: 0,
        logical_digest: null,
        backend_identity: null,
        updated_at: "1970-01-01T00:00:00.000Z",
        last_failure: null,
      });
    }
    return this.#checkpointFromRow(row);
  }

  scopeSnapshot(input: unknown): GraphScopeSnapshotResult {
    const request = GraphScopeInputSchema.parse(input);
    const state = this.#readScope(request);
    if (state?.frontier_json === null || state === undefined) {
      throw new StorageError("STALE_PROJECTION_FRONTIER", {
        retryable: true,
      });
    }
    return GraphScopeSnapshotResultSchema.parse({
      snapshot: this.#buildSnapshot(
        request,
        JSON.parse(state.frontier_json) as unknown,
      ),
    });
  }

  listSnapshots(input: unknown): GraphProjectionSnapshotListResult {
    const request = GraphProjectionSnapshotListInputSchema.parse(input);
    const scopes = this.#database
      .prepare(
        `SELECT principal_id, scope_kind, scope_id
         FROM layered_projection_scope_state
         WHERE status = 'ready'
         ORDER BY principal_id, scope_kind, scope_id`,
      )
      .all() as Array<{
        principal_id: string;
        scope_kind: ExactScope["scope"]["kind"];
        scope_id: string;
      }>;
    return GraphProjectionSnapshotListResultSchema.parse({
      snapshots: scopes.map((scope) => {
        const exactScope = {
          backend: request.backend,
          principal_id: scope.principal_id,
          scope: { kind: scope.scope_kind, id: scope.scope_id },
        };
        return this.#buildSnapshot(
          exactScope,
          this.#readyProjectionFrontier(exactScope),
        );
      }),
    });
  }

  enqueueCanonicalEffect(effect: CanonicalGraphProjectionEffect): string {
    const epochs = this.#currentEpochs(effect);
    const jobId = stableIdentifier("graph-job", {
      operation: "scope_replace",
      backend: "ladybugdb",
      principal_id: effect.principal_id,
      scope: effect.scope,
      cause_id: effect.cause_id,
      revision_id: effect.revision_id,
      occurred_at: effect.occurred_at,
    });
    this.#openGuard("canonical-pending", effect.occurred_at);
    try {
      this.#upsertPendingScope({
        backend: "ladybugdb",
        ...effect,
        ...epochs,
        frontier: null,
        logicalDigest: null,
        status: "pending",
      });
      this.#insertJob({
        jobId,
        operation: "scope_replace",
        scope: { backend: "ladybugdb", ...effect },
        targetFrontier: null,
        expectedLogicalDigest: null,
        availableAt: effect.occurred_at,
        createdAt: effect.occurred_at,
      });
    } finally {
      this.#closeGuard();
    }
    return jobId;
  }

  enqueueReadyScope(input: {
    principal_id: string;
    scope: ExactScope["scope"];
    frontier: ProjectionFrontier;
    available_at: string;
  }): {
    job_id: string;
    snapshot: GraphScopeSnapshot;
  } {
    const request = {
      backend: "ladybugdb" as const,
      principal_id: input.principal_id,
      scope: input.scope,
    };
    const snapshot = this.#buildSnapshot(request, input.frontier);
    const jobId = stableIdentifier("graph-job", {
      operation: "scope_replace",
      backend: "ladybugdb",
      principal_id: input.principal_id,
      scope: input.scope,
      frontier: input.frontier,
      logical_digest: snapshot.logical_digest,
    });
    this.#openGuard("projection-ready", input.available_at);
    try {
      this.#database
        .prepare(
          `UPDATE graph_projection_outbox_jobs
           SET status = 'stale',
               claimed_by = NULL,
               lease_token = NULL,
               lease_expires_at = NULL,
               completed_at = ?,
               last_failure = 'GRAPH_SCOPE_STALE'
           WHERE backend = 'ladybugdb'
             AND principal_id = ?
             AND scope_kind = ?
             AND scope_id = ?
             AND status IN ('pending', 'processing', 'failed')`,
        )
        .run(
          input.available_at,
          input.principal_id,
          input.scope.kind,
          input.scope.id,
        );
      this.#upsertPendingScope({
        ...request,
        ledger_epoch: input.frontier.ledger_epoch,
        tombstone_epoch: input.frontier.tombstone_epoch,
        projection_epoch: input.frontier.projection_epoch,
        frontier: input.frontier,
        logicalDigest: snapshot.logical_digest,
        status: "pending",
        occurred_at: input.available_at,
      });
      this.#insertJob({
        jobId,
        operation: "scope_replace",
        scope: request,
        targetFrontier: input.frontier,
        expectedLogicalDigest: snapshot.logical_digest,
        availableAt: input.available_at,
        createdAt: input.available_at,
      });
    } finally {
      this.#closeGuard();
    }
    return { job_id: jobId, snapshot };
  }

  claim(input: unknown): ClaimGraphProjectionJobsResult {
    const request = ClaimGraphProjectionJobsInputSchema.parse(input);
    const jobs = this.#database
      .transaction(() => {
        this.#openGuard("claim", request.claimed_at);
        try {
          this.#database
            .prepare(
              `UPDATE graph_projection_outbox_jobs
               SET status = 'failed',
                   claimed_by = NULL,
                   lease_token = NULL,
                   lease_expires_at = NULL,
                   last_failure = 'GRAPH_CHILD_EXITED'
               WHERE backend = ?
                 AND status = 'processing'
                 AND lease_expires_at <= ?`,
            )
            .run(request.backend, request.claimed_at);
          const rows = this.#database
            .prepare(
              `SELECT job_id, attempts
               FROM graph_projection_outbox_jobs
               WHERE backend = ?
                 AND status IN ('pending', 'failed')
                 AND attempts < ?
                 AND operation IN (?, ?)
                 AND available_at <= ?
                 AND (
                   target_frontier_json IS NOT NULL
                   OR operation = 'full_rebuild'
                 )
               ORDER BY available_at, job_id
               LIMIT ?`,
            )
            .all(
              request.backend,
              MAX_GRAPH_PROJECTION_ATTEMPTS,
              request.operations[0],
              request.operations[1] ?? request.operations[0],
              request.claimed_at,
              request.limit,
            ) as Array<{ job_id: string; attempts: number }>;
          const update = this.#database.prepare(
            `UPDATE graph_projection_outbox_jobs
             SET status = 'processing',
                 attempts = attempts + 1,
                 claimed_by = ?,
                 lease_token = ?,
                 lease_expires_at = ?,
                 completed_at = NULL,
                 last_failure = NULL
             WHERE job_id = ?
               AND status IN ('pending', 'failed')`,
          );
          for (const row of rows) {
            const leaseToken = stableIdentifier("graph-lease", {
              job_id: row.job_id,
              worker_id: request.worker_id,
              attempt: row.attempts + 1,
              claimed_at: request.claimed_at,
              lease_expires_at: request.lease_expires_at,
            });
            update.run(
              request.worker_id,
              leaseToken,
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
    return ClaimGraphProjectionJobsResultSchema.parse({ jobs });
  }

  apply(input: unknown): GraphProjectionJobResult {
    const command = ApplyGraphProjectionJobCommandSchema.parse(input);
    const receipt = command.receipt;
    if (receipt.job_id !== command.job_id) {
      throw new StorageError("CONFLICT");
    }
    const existing = this.#readReceipt(receipt.receipt_id);
    if (existing !== undefined) {
      if (!sameJson(existing, receipt)) {
        throw new StorageError("CONFLICT");
      }
      const job = this.#readJob(command.job_id);
      if (job === undefined) {
        throw new StorageError("CORRUPTION");
      }
      this.#assertReceiptIdentity(job, receipt);
      return GraphProjectionJobResultSchema.parse({
        job: this.#jobFromRow(job),
        checkpoint: this.checkpoint({
          backend: job.backend,
          principal_id: job.principal_id,
          scope: { kind: job.scope_kind, id: job.scope_id },
        }),
        receipt: existing,
        replayed: true,
      });
    }
    if (receipt.status !== "applied") {
      throw new StorageError("INVALID_INPUT");
    }

    return GraphProjectionJobResultSchema.parse(
      this.#database
        .transaction(() => {
          const job = this.#requireLease(command);
          if (
            job.target_frontier_json === null ||
            job.expected_logical_digest === null ||
            receipt.job_id !== job.job_id ||
            receipt.operation !== job.operation ||
            receipt.backend !== job.backend ||
            receipt.principal_id !== job.principal_id ||
            receipt.scope.kind !== job.scope_kind ||
            receipt.scope.id !== job.scope_id ||
            !sameJson(
              receipt.resulting_frontier,
              JSON.parse(job.target_frontier_json),
            ) ||
            receipt.logical_digest !== job.expected_logical_digest
          ) {
            throw new StorageError("CONFLICT");
          }
          const currentScope = this.#readScope({
            backend: job.backend,
            principal_id: job.principal_id,
            scope: { kind: job.scope_kind, id: job.scope_id },
          });
          if (
            currentScope?.frontier_json === null ||
            currentScope === undefined ||
            (
              currentScope.status === "rebuilding" &&
              job.operation !== "full_rebuild"
            ) ||
            currentScope.logical_digest !==
              job.expected_logical_digest ||
            !sameJson(
              JSON.parse(currentScope.frontier_json),
              JSON.parse(job.target_frontier_json),
            )
          ) {
            throw new StorageError("STALE_PROJECTION_FRONTIER", {
              retryable: true,
            });
          }
          const snapshot = this.#buildSnapshot(
            {
              backend: job.backend,
              principal_id: job.principal_id,
              scope: { kind: job.scope_kind, id: job.scope_id },
            },
            JSON.parse(job.target_frontier_json),
          );
          if (
            snapshot.logical_digest !== job.expected_logical_digest ||
            receipt.node_count !== snapshot.nodes.length ||
            receipt.edge_count !== snapshot.edges.length
          ) {
            throw new StorageError("STALE_PROJECTION_FRONTIER", {
              retryable: true,
            });
          }

          this.#openGuard("apply", receipt.completed_at);
          try {
            this.#database
              .prepare(
                `UPDATE graph_projection_scope_state
                 SET status = 'ready',
                     ledger_epoch = ?,
                     tombstone_epoch = ?,
                     projection_epoch = ?,
                     graph_projection_epoch = ?,
                     frontier_json = ?,
                     logical_digest = ?,
                     backend_identity_json = ?,
                     updated_at = ?,
                     last_failure = NULL
                 WHERE backend = ?
                   AND principal_id = ?
                   AND scope_kind = ?
                   AND scope_id = ?
                   AND frontier_json IS ?
                   AND logical_digest IS ?`,
              )
              .run(
                snapshot.frontier.ledger_epoch,
                snapshot.frontier.tombstone_epoch,
                snapshot.frontier.projection_epoch,
                snapshot.frontier.projection_epoch,
                canonicalJson(snapshot.frontier),
                snapshot.logical_digest,
                canonicalJson(receipt.backend_identity),
                receipt.completed_at,
                job.backend,
                job.principal_id,
                job.scope_kind,
                job.scope_id,
                job.target_frontier_json,
                job.expected_logical_digest,
              );
            this.#database
              .prepare(
                `UPDATE graph_projection_outbox_jobs
                 SET status = 'applied',
                     claimed_by = NULL,
                     lease_token = NULL,
                     lease_expires_at = NULL,
                     completed_at = ?,
                     last_failure = NULL
                 WHERE job_id = ?`,
              )
              .run(receipt.completed_at, job.job_id);
            this.#insertReceipt(receipt);
          } finally {
            this.#closeGuard();
          }
          const updated = this.#readJob(job.job_id);
          if (updated === undefined) {
            throw new StorageError("CORRUPTION");
          }
          return {
            job: this.#jobFromRow(updated),
            checkpoint: this.checkpoint({
              backend: updated.backend,
              principal_id: updated.principal_id,
              scope: {
                kind: updated.scope_kind,
                id: updated.scope_id,
              },
            }),
            receipt,
            replayed: false,
          };
        })
        .immediate(),
    );
  }

  fail(input: unknown): GraphProjectionJobResult {
    const command = FailGraphProjectionJobCommandSchema.parse(input);
    const receipt = command.receipt;
    if (receipt.job_id !== command.job_id) {
      throw new StorageError("CONFLICT");
    }
    if (receipt.status === "applied") {
      throw new StorageError("INVALID_INPUT");
    }
    const existing = this.#readReceipt(receipt.receipt_id);
    if (existing !== undefined) {
      if (!sameJson(existing, receipt)) {
        throw new StorageError("CONFLICT");
      }
      const job = this.#readJob(command.job_id);
      if (job === undefined) {
        throw new StorageError("CORRUPTION");
      }
      this.#assertReceiptIdentity(job, receipt);
      return GraphProjectionJobResultSchema.parse({
        job: this.#jobFromRow(job),
        checkpoint: this.checkpoint({
          backend: job.backend,
          principal_id: job.principal_id,
          scope: { kind: job.scope_kind, id: job.scope_id },
        }),
        receipt: existing,
        replayed: true,
      });
    }
    return GraphProjectionJobResultSchema.parse(
      this.#database
        .transaction(() => {
          const job = this.#requireLease(command);
          if (
            receipt.job_id !== job.job_id ||
            receipt.operation !== job.operation ||
            receipt.backend !== job.backend ||
            receipt.principal_id !== job.principal_id ||
            receipt.scope.kind !== job.scope_kind ||
            receipt.scope.id !== job.scope_id
          ) {
            throw new StorageError("CONFLICT");
          }
          const terminal =
            receipt.status === "stale" || receipt.status === "skipped";
          this.#openGuard("fail", receipt.completed_at);
          try {
            this.#database
              .prepare(
                `UPDATE graph_projection_outbox_jobs
                 SET status = ?,
                     available_at = ?,
                     claimed_by = NULL,
                     lease_token = NULL,
                     lease_expires_at = NULL,
                     completed_at = ?,
                     last_failure = ?
                 WHERE job_id = ?`,
              )
              .run(
                terminal ? receipt.status : "failed",
                command.retry_at,
                terminal ? receipt.completed_at : null,
                receipt.failure_code,
                job.job_id,
              );
            this.#database
              .prepare(
                `UPDATE graph_projection_scope_state
                 SET status = 'unavailable',
                     frontier_json = NULL,
                     logical_digest = NULL,
                     backend_identity_json = NULL,
                     updated_at = ?,
                     last_failure = ?
                 WHERE backend = ?
                   AND principal_id = ?
                   AND scope_kind = ?
                   AND scope_id = ?
                   AND frontier_json IS ?
                   AND logical_digest IS ?
                   AND status <> 'rebuilding'`,
              )
              .run(
                receipt.completed_at,
                receipt.failure_code,
                job.backend,
                job.principal_id,
                job.scope_kind,
                job.scope_id,
                job.target_frontier_json,
                job.expected_logical_digest,
              );
            this.#insertReceipt(receipt);
          } finally {
            this.#closeGuard();
          }
          const updated = this.#readJob(job.job_id);
          if (updated === undefined) {
            throw new StorageError("CORRUPTION");
          }
          return {
            job: this.#jobFromRow(updated),
            checkpoint: this.checkpoint({
              backend: updated.backend,
              principal_id: updated.principal_id,
              scope: {
                kind: updated.scope_kind,
                id: updated.scope_id,
              },
            }),
            receipt,
            replayed: false,
          };
        })
        .immediate(),
    );
  }

  reset(input: unknown): ResetGraphProjectionScopesResult {
    const request = ResetGraphProjectionScopesInputSchema.parse(input);
    return ResetGraphProjectionScopesResultSchema.parse(
      this.#database
        .transaction(() => {
          const checkpoints: GraphScopeCheckpoint[] = [];
          const jobIds: string[] = [];
          this.#openGuard("reset", request.reset_at);
          try {
            for (const scope of request.scopes) {
              const epochs = this.#currentEpochs(scope);
              const rebuildSnapshot =
                request.mode === "rebuilding"
                  ? this.#buildSnapshot(
                      { backend: request.backend, ...scope },
                      this.#readyProjectionFrontier({
                        backend: request.backend,
                        ...scope,
                      }),
                    )
                  : null;
              const targetEpochs = rebuildSnapshot?.frontier ?? epochs;
              const jobId = stableIdentifier("graph-job", {
                operation:
                  request.mode === "rebuilding"
                    ? "full_rebuild"
                    : "scope_replace",
                backend: request.backend,
                scope,
                reset_at: request.reset_at,
              });
              this.#database
                .prepare(
                  `UPDATE graph_projection_outbox_jobs
                   SET status = 'stale',
                       claimed_by = NULL,
                       lease_token = NULL,
                       lease_expires_at = NULL,
                       completed_at = ?,
                       last_failure = 'GRAPH_SCOPE_STALE'
                   WHERE backend = ?
                     AND principal_id = ?
                     AND scope_kind = ?
                     AND scope_id = ?
                     AND job_id <> ?
                     AND (
                       status IN ('pending', 'failed')
                       OR (
                         status = 'processing'
                         AND operation = 'full_rebuild'
                       )
                     )`,
                )
                .run(
                  request.reset_at,
                  request.backend,
                  scope.principal_id,
                  scope.scope.kind,
                  scope.scope.id,
                  jobId,
                );
              this.#upsertPendingScope({
                backend: request.backend,
                ...scope,
                ledger_epoch: targetEpochs.ledger_epoch,
                tombstone_epoch: targetEpochs.tombstone_epoch,
                projection_epoch: targetEpochs.projection_epoch,
                frontier: rebuildSnapshot?.frontier ?? null,
                logicalDigest:
                  rebuildSnapshot?.logical_digest ?? null,
                status: request.mode,
                occurred_at: request.reset_at,
              });
              this.#insertJob({
                jobId,
                operation:
                  request.mode === "rebuilding"
                    ? "full_rebuild"
                    : "scope_replace",
                scope: {
                  backend: request.backend,
                  ...scope,
                },
                targetFrontier: rebuildSnapshot?.frontier ?? null,
                expectedLogicalDigest:
                  rebuildSnapshot?.logical_digest ?? null,
                availableAt: request.reset_at,
                createdAt: request.reset_at,
              });
              jobIds.push(jobId);
              checkpoints.push(this.checkpoint({
                backend: request.backend,
                ...scope,
              }));
            }
          } finally {
            this.#closeGuard();
          }
          return {
            checkpoints,
            job_ids: jobIds.sort(),
          };
        })
        .immediate(),
    );
  }

  markRestoreUnavailable(input: unknown) {
    const request = MarkGraphRestoreUnavailableInputSchema.parse(input);
    return MarkGraphRestoreUnavailableResultSchema.parse(this.#database
      .transaction(() => {
        this.#openGuard("restore", request.restored_at);
        try {
          this.#database
            .prepare(
              `UPDATE graph_projection_scope_state
               SET status = 'unavailable',
                   frontier_json = NULL,
                   logical_digest = NULL,
                   backend_identity_json = NULL,
                   updated_at = ?,
                   last_failure = 'GRAPH_SCOPE_STALE'`,
            )
            .run(request.restored_at);
          this.#database
            .prepare(
              `UPDATE graph_projection_outbox_jobs
               SET status = 'stale',
                   claimed_by = NULL,
                   lease_token = NULL,
                   lease_expires_at = NULL,
                   completed_at = ?,
                   last_failure = 'GRAPH_SCOPE_STALE'
               WHERE status IN ('pending', 'processing', 'failed')`,
            )
            .run(request.restored_at);
        } finally {
          this.#closeGuard();
        }
        return {
          updated_scopes: count(
            this.#database,
            "graph_projection_scope_state",
            "WHERE status = 'unavailable'",
          ),
        };
      })
      .immediate());
  }

  status(): GraphProjectionStatus {
    return GraphProjectionStatusSchema.parse({
      scope_states: count(this.#database, "graph_projection_scope_state"),
      ready_scopes: count(
        this.#database,
        "graph_projection_scope_state",
        "WHERE status = 'ready'",
      ),
      pending_scopes: count(
        this.#database,
        "graph_projection_scope_state",
        "WHERE status IN ('pending', 'rebuilding')",
      ),
      unavailable_scopes: count(
        this.#database,
        "graph_projection_scope_state",
        "WHERE status = 'unavailable'",
      ),
      outbox_pending: count(
        this.#database,
        "graph_projection_outbox_jobs",
        "WHERE status IN ('pending', 'processing', 'failed')",
      ),
      receipts: count(this.#database, "graph_projection_receipts"),
    });
  }

  #buildSnapshot(
    scope: ExactScope & { backend: "ladybugdb" },
    frontierInput: unknown,
  ): GraphScopeSnapshot {
    const frontier = ProjectionRevisionSchema.shape.frontier.parse(
      frontierInput,
    );
    const memoryRows = this.#database
      .prepare(
        `SELECT o.memory_id, r.revision_id, r.valid_from, r.valid_to,
                r.recorded_at, r.content_hash
         FROM memory_objects AS o
         JOIN memory_revisions AS r
           ON r.revision_id = o.current_revision_id
         WHERE o.principal_id = ?
           AND o.scope_kind = ?
           AND o.scope_id = ?
           AND o.lifecycle = 'active'
           AND o.context_eligible = 1
           AND r.lifecycle = 'active'
           AND r.purged_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM memory_tombstones AS t
             WHERE t.memory_id = o.memory_id
           )
           AND COALESCE(
             (
               SELECT u.effect
               FROM memory_usage_rules AS u
               WHERE u.memory_id = o.memory_id
                 AND u.revision_id = r.revision_id
                 AND u.principal_id = o.principal_id
                 AND (
                   (
                     u.context_scope_kind IS NULL
                     AND u.context_scope_id IS NULL
                   )
                   OR
                   (
                     u.context_scope_kind = o.scope_kind
                     AND u.context_scope_id = o.scope_id
                   )
                 )
               ORDER BY
                 CASE
                   WHEN u.context_scope_kind IS NULL THEN 0
                   ELSE 1
                 END DESC,
                 u.occurred_at DESC,
                 u.usage_rule_id DESC
               LIMIT 1
             ),
             'allow'
           ) <> 'block'
         ORDER BY r.revision_id`,
      )
      .all(
        scope.principal_id,
        scope.scope.kind,
        scope.scope.id,
      ) as MemoryNodeRow[];
    const evidenceForMemory = this.#database.prepare(
      `SELECT evidence_id FROM memory_revision_evidence
       WHERE revision_id = ? ORDER BY evidence_id`,
    );
    const nodes = memoryRows.map((row) => {
      const evidenceIds = (
        evidenceForMemory.all(row.revision_id) as Array<{
          evidence_id: string;
        }>
      ).map((entry) => entry.evidence_id);
      return GraphNodeSchema.parse({
        schema_version: "1.0.0",
        graph_node_id: stableIdentifier("graph-node", {
          principal_id: scope.principal_id,
          scope: scope.scope,
          revision_id: row.revision_id,
        }),
        revision_id: row.revision_id,
        projection_revision_id: null,
        principal_id: scope.principal_id,
        scope: scope.scope,
        abstraction: "l1_memory" as const,
        projection_type: null,
        lifecycle: "active" as const,
        validity: {
          valid_from: row.valid_from,
          valid_to: row.valid_to,
          recorded_at: row.recorded_at,
        },
        ledger_epoch: frontier.ledger_epoch,
        tombstone_epoch: frontier.tombstone_epoch,
        projection_epoch: frontier.projection_epoch,
        content_hash: row.content_hash,
        payload_hash: canonicalSha256({
          memory_id: row.memory_id,
          revision_id: row.revision_id,
          content_hash: row.content_hash,
        }),
        transform: frontier.transform,
        evidence_ids: evidenceIds,
        lineage_revision_ids: [row.revision_id],
      });
    });

    const projectionRows = this.#database
      .prepare(
        `SELECT r.revision_json
         FROM projection_objects AS o
         JOIN projection_revisions AS r
           ON r.projection_revision_id = o.current_revision_id
         WHERE o.principal_id = ?
           AND o.scope_kind = ?
           AND o.scope_id = ?
           AND o.lifecycle = 'active'
           AND r.lifecycle = 'active'
           AND r.purged_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM projection_invalidations AS i
             WHERE i.projection_revision_id = r.projection_revision_id
           )
         ORDER BY r.projection_revision_id`,
      )
      .all(
        scope.principal_id,
        scope.scope.kind,
        scope.scope.id,
      ) as ProjectionJsonRow[];
    const projections = projectionRows.map((row) =>
      ProjectionRevisionSchema.parse(JSON.parse(row.revision_json))
    );
    for (const projection of projections) {
      const lineage = projection.source_revisions
        .map((source) => source.revision_id)
        .sort();
      nodes.push(GraphNodeSchema.parse({
        schema_version: "1.0.0",
        graph_node_id: stableIdentifier("graph-node", {
          principal_id: scope.principal_id,
          scope: scope.scope,
          revision_id: projection.projection_revision_id,
        }),
        revision_id: projection.projection_revision_id,
        projection_revision_id: projection.projection_revision_id,
        principal_id: scope.principal_id,
        scope: scope.scope,
        abstraction: projection.abstraction,
        projection_type: projection.projection_type,
        lifecycle: "active",
        validity: projection.validity,
        ledger_epoch: frontier.ledger_epoch,
        tombstone_epoch: frontier.tombstone_epoch,
        projection_epoch: frontier.projection_epoch,
        content_hash: projection.content_hash,
        payload_hash: canonicalSha256({
          projection_type: projection.projection_type,
          payload: projection.payload,
          content_hash: projection.content_hash,
        }),
        transform: frontier.transform,
        evidence_ids: [...projection.evidence_ids].sort(),
        lineage_revision_ids: lineage,
      }));
    }
    const edges = projections
      .filter((projection) => projection.payload?.kind === "relation")
      .map((projection) => {
        const payload = projection.payload;
        if (payload?.kind !== "relation") {
          throw new StorageError("CORRUPTION");
        }
        return {
          schema_version: "1.0.0",
          graph_edge_id: stableIdentifier("graph-edge", {
            relation_id: projection.projection_id,
            relation_revision_id: projection.projection_revision_id,
          }),
          relation_id: projection.projection_id,
          relation_revision_id: projection.projection_revision_id,
          projection_revision_id: projection.projection_revision_id,
          source_revision_id: payload.source_revision_id,
          target_revision_id: payload.target_revision_id,
          relation_type: payload.relation_type,
          direction: payload.direction,
          principal_id: scope.principal_id,
          scope: scope.scope,
          validity: projection.validity,
          ledger_epoch: frontier.ledger_epoch,
          tombstone_epoch: frontier.tombstone_epoch,
          projection_epoch: frontier.projection_epoch,
          content_hash: projection.content_hash,
          payload_hash: canonicalSha256(payload),
          transform: frontier.transform,
          evidence_ids: [...projection.evidence_ids].sort(),
          lineage_revision_ids: projection.source_revisions
            .map((source) => source.revision_id)
            .sort(),
        };
      });
    try {
      return buildGraphScopeSnapshot({
        schema_version: "1.0.0",
        backend: scope.backend,
        principal_id: scope.principal_id,
        scope: scope.scope,
        frontier,
        nodes,
        edges,
      });
    } catch {
      throw new StorageError("CORRUPTION");
    }
  }

  #currentEpochs(scope: ExactScope): {
    ledger_epoch: number;
    tombstone_epoch: number;
    projection_epoch: number;
  } {
    return this.#database
      .prepare(
        `SELECT
           (SELECT ledger_epoch FROM ledger_state WHERE singleton = 1)
             AS ledger_epoch,
           (SELECT tombstone_epoch FROM tombstone_state WHERE singleton = 1)
             AS tombstone_epoch,
           COALESCE(
             (
               SELECT projection_epoch
               FROM layered_projection_scope_state
               WHERE principal_id = ?
                 AND scope_kind = ?
                 AND scope_id = ?
             ),
             (
               SELECT projection_epoch FROM layered_projection_state
               WHERE singleton = 1
             ),
             0
           ) AS projection_epoch`,
      )
      .get(
        scope.principal_id,
        scope.scope.kind,
        scope.scope.id,
      ) as {
      ledger_epoch: number;
      tombstone_epoch: number;
      projection_epoch: number;
    };
  }

  #readyProjectionFrontier(
    scope: ExactScope & { backend: "ladybugdb" },
  ): ProjectionFrontier {
    const row = this.#database
      .prepare(
        `SELECT status, ledger_epoch, tombstone_epoch, projection_epoch,
                source_frontier_hash, projection_frontier_hash,
                transform_versions_json
         FROM layered_projection_scope_state
         WHERE principal_id = ?
           AND scope_kind = ?
           AND scope_id = ?`,
      )
      .get(
        scope.principal_id,
        scope.scope.kind,
        scope.scope.id,
      ) as {
        status: string;
        ledger_epoch: number;
        tombstone_epoch: number;
        projection_epoch: number;
        source_frontier_hash: string | null;
        projection_frontier_hash: string | null;
        transform_versions_json: string;
      } | undefined;
    const transforms = row === undefined
      ? []
      : JSON.parse(row.transform_versions_json) as unknown[];
    if (
      row === undefined ||
      row.status !== "ready" ||
      row.source_frontier_hash === null ||
      row.projection_frontier_hash === null ||
      transforms.length !== 1
    ) {
      throw new StorageError("STALE_PROJECTION_FRONTIER", {
        retryable: true,
      });
    }
    return ProjectionRevisionSchema.shape.frontier.parse({
      schema_version: "1.0.0",
      ledger_epoch: row.ledger_epoch,
      tombstone_epoch: row.tombstone_epoch,
      projection_epoch: row.projection_epoch,
      transform: transforms[0],
      source_frontier_hash: row.source_frontier_hash,
      projection_frontier_hash: row.projection_frontier_hash,
    });
  }

  #upsertPendingScope(input: ExactScope & {
    backend: "ladybugdb";
    ledger_epoch: number;
    tombstone_epoch: number;
    projection_epoch: number;
    frontier: ProjectionFrontier | null;
    logicalDigest: string | null;
    status: "pending" | "rebuilding";
    occurred_at: string;
  }): void {
    this.#database
      .prepare(
        `INSERT INTO graph_projection_scope_state (
           backend, principal_id, scope_kind, scope_id, status, ledger_epoch,
           tombstone_epoch, projection_epoch, graph_projection_epoch,
           frontier_json, logical_digest, backend_identity_json, updated_at,
           last_failure
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)
         ON CONFLICT (backend, principal_id, scope_kind, scope_id)
         DO UPDATE SET
           status = excluded.status,
           ledger_epoch = excluded.ledger_epoch,
           tombstone_epoch = excluded.tombstone_epoch,
           projection_epoch = excluded.projection_epoch,
           graph_projection_epoch = excluded.graph_projection_epoch,
           frontier_json = excluded.frontier_json,
           logical_digest = excluded.logical_digest,
           backend_identity_json = NULL,
           updated_at = excluded.updated_at,
           last_failure = NULL`,
      )
      .run(
        input.backend,
        input.principal_id,
        input.scope.kind,
        input.scope.id,
        input.status,
        input.ledger_epoch,
        input.tombstone_epoch,
        input.projection_epoch,
        input.projection_epoch,
        input.frontier === null ? null : canonicalJson(input.frontier),
        input.logicalDigest,
        input.occurred_at,
      );
  }

  #insertJob(input: {
    jobId: string;
    operation: "scope_replace" | "full_rebuild";
    scope: ExactScope & { backend: "ladybugdb" };
    targetFrontier: ProjectionFrontier | null;
    expectedLogicalDigest: string | null;
    availableAt: string;
    createdAt: string;
  }): void {
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO graph_projection_outbox_jobs (
           job_id, operation, backend, principal_id, scope_kind, scope_id,
           target_frontier_json, expected_logical_digest, status, attempts,
           available_at, claimed_by, lease_token, lease_expires_at,
           created_at, completed_at, last_failure
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL,
                   NULL, ?, NULL, NULL)`,
      )
      .run(
        input.jobId,
        input.operation,
        input.scope.backend,
        input.scope.principal_id,
        input.scope.scope.kind,
        input.scope.scope.id,
        input.targetFrontier === null
          ? null
          : canonicalJson(input.targetFrontier),
        input.expectedLogicalDigest,
        input.availableAt,
        input.createdAt,
      );
  }

  #requireLease(input: {
    job_id: string;
    worker_id: string;
    lease_token: string;
    receipt: GraphDeliveryReceipt;
  }): JobRow {
    const job = this.#readJob(input.job_id);
    if (
      job === undefined ||
      job.status !== "processing" ||
      job.claimed_by !== input.worker_id ||
      job.lease_token !== input.lease_token ||
      job.lease_expires_at === null ||
      Date.parse(job.lease_expires_at) <
        Date.parse(input.receipt.completed_at)
    ) {
      throw new StorageError("CONFLICT");
    }
    return job;
  }

  #assertReceiptIdentity(
    job: JobRow,
    receipt: GraphDeliveryReceipt,
  ): void {
    if (
      receipt.job_id !== job.job_id ||
      receipt.operation !== job.operation ||
      receipt.backend !== job.backend ||
      receipt.principal_id !== job.principal_id ||
      receipt.scope.kind !== job.scope_kind ||
      receipt.scope.id !== job.scope_id
    ) {
      throw new StorageError("CONFLICT");
    }
  }

  #insertReceipt(receipt: GraphDeliveryReceipt): void {
    this.#database
      .prepare(
        `INSERT INTO graph_projection_receipts (
           receipt_id, job_id, backend, principal_id, scope_kind, scope_id,
           status, logical_digest, receipt_json, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.receipt_id,
        receipt.job_id,
        receipt.backend,
        receipt.principal_id,
        receipt.scope.kind,
        receipt.scope.id,
        receipt.status,
        receipt.logical_digest,
        canonicalJson(receipt),
        receipt.completed_at,
      );
  }

  #readReceipt(receiptId: string): GraphDeliveryReceipt | undefined {
    const row = this.#database
      .prepare(
        `SELECT receipt_json FROM graph_projection_receipts
         WHERE receipt_id = ?`,
      )
      .get(receiptId) as { receipt_json: string } | undefined;
    return row === undefined
      ? undefined
      : GraphDeliveryReceiptSchema.parse(JSON.parse(row.receipt_json));
  }

  #readScope(input: ExactScope & {
    backend: "ladybugdb";
  }): ScopeStateRow | undefined {
    return this.#database
      .prepare(
        `SELECT backend, principal_id, scope_kind, scope_id, status,
                ledger_epoch, tombstone_epoch, projection_epoch,
                graph_projection_epoch, frontier_json, logical_digest,
                backend_identity_json, updated_at, last_failure
         FROM graph_projection_scope_state
         WHERE backend = ?
           AND principal_id = ?
           AND scope_kind = ?
           AND scope_id = ?`,
      )
      .get(
        input.backend,
        input.principal_id,
        input.scope.kind,
        input.scope.id,
      ) as ScopeStateRow | undefined;
  }

  #checkpointFromRow(row: ScopeStateRow): GraphScopeCheckpoint {
    return GraphScopeCheckpointSchema.parse({
      schema_version: "1.0.0",
      backend: row.backend,
      principal_id: row.principal_id,
      scope: { kind: row.scope_kind, id: row.scope_id },
      status: row.status,
      frontier:
        row.frontier_json === null
          ? null
          : JSON.parse(row.frontier_json),
      graph_projection_epoch: row.graph_projection_epoch,
      logical_digest: row.logical_digest,
      backend_identity:
        row.backend_identity_json === null
          ? null
          : JSON.parse(row.backend_identity_json),
      updated_at: row.updated_at,
      last_failure: row.last_failure,
    });
  }

  #readJob(jobId: string): JobRow | undefined {
    return this.#database
      .prepare(
        `SELECT job_id, operation, backend, principal_id, scope_kind,
                scope_id, target_frontier_json, expected_logical_digest,
                status, attempts, available_at, claimed_by, lease_token,
                lease_expires_at, created_at, completed_at, last_failure
         FROM graph_projection_outbox_jobs WHERE job_id = ?`,
      )
      .get(jobId) as JobRow | undefined;
  }

  #jobFromRow(row: JobRow): GraphProjectionOutboxJob {
    return GraphProjectionOutboxJobSchema.parse({
      job_id: row.job_id,
      operation: row.operation,
      backend: row.backend,
      principal_id: row.principal_id,
      scope: { kind: row.scope_kind, id: row.scope_id },
      target_frontier:
        row.target_frontier_json === null
          ? null
          : JSON.parse(row.target_frontier_json),
      expected_logical_digest: row.expected_logical_digest,
      status: row.status,
      attempts: row.attempts,
      available_at: row.available_at,
      claimed_by: row.claimed_by,
      lease_token: row.lease_token,
      lease_expires_at: row.lease_expires_at,
      created_at: row.created_at,
      completed_at: row.completed_at,
      last_failure: row.last_failure,
    });
  }

  #openGuard(operation: string, openedAt: string): void {
    this.#database
      .prepare(
        `INSERT INTO graph_projection_write_guard (
           singleton, operation, opened_at
         ) VALUES (1, ?, ?)`,
      )
      .run(operation, openedAt);
  }

  #closeGuard(): void {
    this.#database
      .prepare(
        "DELETE FROM graph_projection_write_guard WHERE singleton = 1",
      )
      .run();
  }
}

export function enqueueGraphProjectionEffect(
  database: Database.Database,
  effect: CanonicalGraphProjectionEffect,
): string {
  return new GraphProjectionRepository(database)
    .enqueueCanonicalEffect(effect);
}
