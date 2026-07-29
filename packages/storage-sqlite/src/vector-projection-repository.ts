import {
  VectorEmbeddingEpochSchema,
  VectorProjectionReceiptSchema,
  VectorScopeCheckpointSchema,
  canonicalJson,
  canonicalSha256,
  scopeKey,
  type Scope,
  type VectorEmbeddingEpoch,
  type VectorFailureCategory,
  type VectorProjectionReceipt,
  type VectorScopeCheckpoint,
} from "@memo-graph/contracts";
import type Database from "better-sqlite3";

import { StorageError } from "./errors.js";
import {
  ApplyVectorProjectionJobCommandSchema,
  ClaimVectorProjectionJobsInputSchema,
  ClaimVectorProjectionJobsResultSchema,
  ConfigureVectorProjectionCommandSchema,
  ConfigureVectorProjectionResultSchema,
  FailVectorProjectionJobCommandSchema,
  MarkVectorRestoreDegradedInputSchema,
  MarkVectorRestoreDegradedResultSchema,
  RegisterVectorEmbeddingEpochCommandSchema,
  RegisterVectorEmbeddingEpochResultSchema,
  RunVectorTemporalSweepInputSchema,
  RunVectorTemporalSweepResultSchema,
  StaleVectorProjectionJobCommandSchema,
  VectorProjectionJobResultSchema,
  VectorProjectionOutboxJobSchema,
  VectorProjectionScopeInputSchema,
  VectorProjectionStatusSchema,
  type ClaimVectorProjectionJobsResult,
  type ConfigureVectorProjectionResult,
  type MarkVectorRestoreDegradedResult,
  type RegisterVectorEmbeddingEpochResult,
  type RunVectorTemporalSweepResult,
  type VectorProjectionJobResult,
  type VectorProjectionOutboxJob,
  type VectorProjectionStatus,
} from "./protocol.js";

type ExactScope = {
  principal_id: string;
  scope: Scope;
};

export type CanonicalVectorProjectionEffect = ExactScope & {
  cause_id: string;
  revision_id: string;
  occurred_at: string;
  reason?:
    | "canonical_change"
    | "purge"
    | "recovery"
    | "rebuild";
};

type ConfigurationRow = {
  mode: "disabled" | "evaluating" | "enabled";
  desired_epoch_id: string | null;
  configured_at: string;
};

type ScopeRow = {
  principal_id: string;
  scope_kind: Scope["kind"];
  scope_id: string;
  desired_epoch_id: string;
  active_epoch_id: string | null;
  desired_generation_id: string;
  active_generation_id: string | null;
  state:
    | "disabled"
    | "pending"
    | "building"
    | "quarantined"
    | "published"
    | "degraded";
  ledger_epoch: number;
  tombstone_epoch: number;
  source_frontier_hash: string;
  next_validity_transition_at: string | null;
  logical_digest: string | null;
  last_job_id: string | null;
  failure_category: VectorFailureCategory | null;
  updated_at: string;
};

type JobRow = {
  job_id: string;
  principal_id: string;
  scope_kind: Scope["kind"];
  scope_id: string;
  reason: VectorProjectionOutboxJob["reason"];
  desired_epoch_id: string;
  desired_generation_id: string;
  source_frontier_hash: string;
  status: VectorProjectionOutboxJob["status"];
  attempts: number;
  available_at: string;
  claimed_by: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  created_at: string;
  completed_at: string | null;
  failure_category: VectorFailureCategory | null;
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
  return `${prefix}:${canonicalSha256(input).slice(
    "sha256:".length,
    55,
  )}`;
}

function exactScope(row: {
  principal_id: string;
  scope_kind: Scope["kind"];
  scope_id: string;
}): ExactScope {
  return VectorProjectionScopeInputSchema.parse({
    principal_id: row.principal_id,
    scope: {
      kind: row.scope_kind,
      id: row.scope_id,
    },
  });
}

export class VectorProjectionRepository {
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  registerEpoch(input: unknown): RegisterVectorEmbeddingEpochResult {
    const command =
      RegisterVectorEmbeddingEpochCommandSchema.parse(input);
    const epoch = VectorEmbeddingEpochSchema.parse(command.epoch);
    const existing = this.#database
      .prepare(
        `SELECT epoch_json FROM vector_embedding_epochs
         WHERE epoch_id = ?`,
      )
      .get(epoch.epoch_id) as { epoch_json: string } | undefined;
    if (existing !== undefined) {
      const recorded = VectorEmbeddingEpochSchema.parse(
        JSON.parse(existing.epoch_json) as unknown,
      );
      if (canonicalJson(recorded) !== canonicalJson(epoch)) {
        throw new StorageError("CONFLICT");
      }
      return RegisterVectorEmbeddingEpochResultSchema.parse({
        epoch: recorded,
        replayed: true,
      });
    }
    this.#database
      .prepare(
        `INSERT INTO vector_embedding_epochs (
           epoch_id, epoch_json, registered_at
         ) VALUES (?, ?, ?)`,
      )
      .run(
        epoch.epoch_id,
        canonicalJson(epoch),
        command.registered_at,
      );
    return RegisterVectorEmbeddingEpochResultSchema.parse({
      epoch,
      replayed: false,
    });
  }

  configure(input: unknown): ConfigureVectorProjectionResult {
    const command =
      ConfigureVectorProjectionCommandSchema.parse(input);
    const previousConfiguration = this.#configuration();
    if (
      command.epoch_id !== null &&
      this.#readEpoch(command.epoch_id) === undefined
    ) {
      throw new StorageError("INVALID_INPUT");
    }
    return ConfigureVectorProjectionResultSchema.parse(
      this.#database
        .transaction(() => {
          this.#openGuard("configure", command.configured_at);
          try {
            this.#database
              .prepare(
                `UPDATE vector_runtime_configuration
                 SET mode = ?, desired_epoch_id = ?, configured_at = ?
                 WHERE singleton = 1`,
              )
              .run(
                command.mode,
                command.epoch_id,
                command.configured_at,
              );
            if (command.mode === "disabled") {
              this.#database
                .prepare(
                  `UPDATE vector_projection_outbox_jobs
                   SET status = 'disabled',
                       claimed_by = NULL,
                       lease_token = NULL,
                       lease_expires_at = NULL,
                       completed_at = ?,
                       failure_category = NULL
                   WHERE status IN ('pending', 'processing', 'failed')`,
                )
                .run(command.configured_at);
              this.#database
                .prepare(
                  `UPDATE vector_projection_scope_state
                   SET state = 'disabled',
                       active_epoch_id = NULL,
                       active_generation_id = NULL,
                       logical_digest = NULL,
                       failure_category = NULL,
                       updated_at = ?
                   WHERE state <> 'disabled'`,
                )
                .run(command.configured_at);
              return {
                mode: command.mode,
                epoch_id: null,
                checkpoints: [],
                job_ids: [],
              };
            }

            const epochId = command.epoch_id;
            if (epochId === null) {
              throw new StorageError("INVALID_INPUT");
            }
            const scopes = this.#database
              .prepare(
                `SELECT DISTINCT
                   o.principal_id, o.scope_kind, o.scope_id
                 FROM memory_objects AS o
                 WHERE o.lifecycle = 'active'
                   AND o.current_revision_id IS NOT NULL
                 ORDER BY o.principal_id, o.scope_kind, o.scope_id`,
              )
              .all() as Array<{
                principal_id: string;
                scope_kind: Scope["kind"];
                scope_id: string;
              }>;
            const jobIds: string[] = [];
            const checkpoints: VectorScopeCheckpoint[] = [];
            for (const row of scopes) {
              const scope = exactScope(row);
              const existing = this.#readScope(scope);
              if (
                previousConfiguration.desired_epoch_id === epochId &&
                existing !== undefined &&
                existing.desired_epoch_id === epochId &&
                existing.state !== "degraded" &&
                existing.state !== "disabled"
              ) {
                checkpoints.push(this.checkpoint(scope));
                continue;
              }
              const reason =
                existing === undefined ? "enable" : "epoch_change";
              jobIds.push(
                this.#enqueueScope({
                  ...scope,
                  epochId,
                  occurredAt: command.configured_at,
                  reason,
                }),
              );
              checkpoints.push(this.checkpoint(scope));
            }
            return {
              mode: command.mode,
              epoch_id: epochId,
              checkpoints,
              job_ids: jobIds,
            };
          } finally {
            this.#closeGuard();
          }
        })
        .immediate(),
    );
  }

  checkpoint(input: unknown): VectorScopeCheckpoint {
    const request = VectorProjectionScopeInputSchema.parse(input);
    const row = this.#readScope(request);
    if (row === undefined) {
      throw new StorageError("INVALID_INPUT");
    }
    return this.#checkpointFromRow(row);
  }

  enqueueCanonicalEffect(
    effect: CanonicalVectorProjectionEffect,
  ): string | null {
    const configuration = this.#configuration();
    if (
      configuration.mode === "disabled" ||
      configuration.desired_epoch_id === null
    ) {
      return null;
    }
    this.#openGuard("canonical-effect", effect.occurred_at);
    try {
      return this.#enqueueScope({
        principal_id: effect.principal_id,
        scope: effect.scope,
        epochId: configuration.desired_epoch_id,
        occurredAt: effect.occurred_at,
        reason: effect.reason ?? "canonical_change",
        causeId: effect.cause_id,
        revisionId: effect.revision_id,
        ledgerEpochOffset: 1,
      });
    } finally {
      this.#closeGuard();
    }
  }

  claim(input: unknown): ClaimVectorProjectionJobsResult {
    const request =
      ClaimVectorProjectionJobsInputSchema.parse(input);
    const jobs = this.#database
      .transaction(() => {
        this.#openGuard("claim", request.claimed_at);
        try {
          this.#database
            .prepare(
              `UPDATE vector_projection_outbox_jobs
               SET status = 'failed',
                   claimed_by = NULL,
                   lease_token = NULL,
                   lease_expires_at = NULL,
                   failure_category = 'PROCESS_EXIT'
               WHERE status = 'processing'
                 AND lease_expires_at <= ?`,
            )
            .run(request.claimed_at);
          const rows = this.#database
            .prepare(
              `SELECT job_id, attempts
               FROM vector_projection_outbox_jobs
               WHERE status IN ('pending', 'failed')
                 AND attempts < 32
                 AND available_at <= ?
               ORDER BY available_at, job_id
               LIMIT ?`,
            )
            .all(
              request.claimed_at,
              request.limit,
            ) as Array<{ job_id: string; attempts: number }>;
          const update = this.#database.prepare(
            `UPDATE vector_projection_outbox_jobs
             SET status = 'processing',
                 attempts = attempts + 1,
                 claimed_by = ?,
                 lease_token = ?,
                 lease_expires_at = ?,
                 completed_at = NULL,
                 failure_category = NULL
             WHERE job_id = ?
               AND status IN ('pending', 'failed')`,
          );
          const markBuilding = this.#database.prepare(
            `UPDATE vector_projection_scope_state
             SET state = 'building',
                 last_job_id = ?,
                 failure_category = NULL,
                 updated_at = ?
             WHERE principal_id = (
                     SELECT principal_id
                     FROM vector_projection_outbox_jobs
                     WHERE job_id = ?
                   )
               AND scope_kind = (
                     SELECT scope_kind
                     FROM vector_projection_outbox_jobs
                     WHERE job_id = ?
                   )
               AND scope_id = (
                     SELECT scope_id
                     FROM vector_projection_outbox_jobs
                     WHERE job_id = ?
                   )`,
          );
          for (const row of rows) {
            const token = stableIdentifier("vector-lease", {
              job_id: row.job_id,
              worker_id: request.worker_id,
              attempt: row.attempts + 1,
              claimed_at: request.claimed_at,
              lease_expires_at: request.lease_expires_at,
            });
            update.run(
              request.worker_id,
              token,
              request.lease_expires_at,
              row.job_id,
            );
            markBuilding.run(
              row.job_id,
              request.claimed_at,
              row.job_id,
              row.job_id,
              row.job_id,
            );
          }
          return rows.map((row) => {
            const job = this.#readJob(row.job_id);
            if (job === undefined) {
              throw new StorageError("CORRUPTION");
            }
            return this.#jobFromRow(job);
          });
        } finally {
          this.#closeGuard();
        }
      })
      .immediate();
    return ClaimVectorProjectionJobsResultSchema.parse({ jobs });
  }

  apply(input: unknown): VectorProjectionJobResult {
    const command =
      ApplyVectorProjectionJobCommandSchema.parse(input);
    return this.#complete(command, "published");
  }

  fail(input: unknown): VectorProjectionJobResult {
    const command =
      FailVectorProjectionJobCommandSchema.parse(input);
    const receipt = command.receipt;
    if (receipt.outcome !== "failed") {
      throw new StorageError("INVALID_INPUT");
    }
    const replay = this.#replayedResult(command);
    if (replay !== null) {
      return replay;
    }
    return VectorProjectionJobResultSchema.parse(
      this.#database
        .transaction(() => {
          const job = this.#requireLease(command);
          this.#assertReceiptIdentity(job, receipt);
          this.#openGuard("fail", receipt.created_at);
          try {
            this.#insertReceipt(receipt);
            this.#database
              .prepare(
                `UPDATE vector_projection_outbox_jobs
                 SET status = 'failed',
                     available_at = ?,
                     claimed_by = NULL,
                     lease_token = NULL,
                     lease_expires_at = NULL,
                     completed_at = ?,
                     failure_category = ?
                 WHERE job_id = ?`,
              )
              .run(
                command.retry_at,
                receipt.created_at,
                receipt.failure_category,
                job.job_id,
              );
            this.#database
              .prepare(
                `UPDATE vector_projection_scope_state
                 SET state = 'degraded',
                     failure_category = ?,
                     last_job_id = ?,
                     updated_at = ?
                 WHERE principal_id = ?
                   AND scope_kind = ?
                   AND scope_id = ?`,
              )
              .run(
                receipt.failure_category,
                job.job_id,
                receipt.created_at,
                job.principal_id,
                job.scope_kind,
                job.scope_id,
              );
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
              principal_id: job.principal_id,
              scope: { kind: job.scope_kind, id: job.scope_id },
            }),
            receipt,
            replayed: false,
          };
        })
        .immediate(),
    );
  }

  stale(input: unknown): VectorProjectionJobResult {
    const command =
      StaleVectorProjectionJobCommandSchema.parse(input);
    const receipt = command.receipt;
    if (
      receipt.outcome !== "stale" ||
      receipt.logical_digest !== null
    ) {
      throw new StorageError("INVALID_INPUT");
    }
    const replay = this.#replayedResult(command);
    if (replay !== null) {
      return replay;
    }
    const configuration = this.#configuration();
    if (
      configuration.mode === "disabled" ||
      configuration.desired_epoch_id === null
    ) {
      throw new StorageError("CONFLICT");
    }
    const epochId = configuration.desired_epoch_id;
    return VectorProjectionJobResultSchema.parse(
      this.#database
        .transaction(() => {
          const current = this.#readJob(command.job_id);
          if (current === undefined) {
            throw new StorageError("CONFLICT");
          }
          const job = current.status === "stale"
            ? current
            : this.#requireLease(command);
          this.#assertReceiptIdentity(job, receipt);
          this.#openGuard("stale", receipt.created_at);
          try {
            this.#insertReceipt(receipt);
            if (current.status !== "stale") {
              this.#enqueueScope({
                ...exactScope(job),
                epochId,
                occurredAt: receipt.created_at,
                reason: "rebuild",
                causeId: job.job_id,
              });
            }
          } finally {
            this.#closeGuard();
          }
          const updated = this.#readJob(job.job_id);
          if (updated === undefined) {
            throw new StorageError("CORRUPTION");
          }
          return {
            job: this.#jobFromRow(updated),
            checkpoint: this.checkpoint(exactScope(job)),
            receipt,
            replayed: false,
          };
        })
        .immediate(),
    );
  }

  markRestoreDegraded(
    input: unknown,
  ): MarkVectorRestoreDegradedResult {
    const request =
      MarkVectorRestoreDegradedInputSchema.parse(input);
    const configuration = this.#configuration();
    if (
      configuration.mode === "disabled" ||
      configuration.desired_epoch_id === null
    ) {
      return MarkVectorRestoreDegradedResultSchema.parse({
        updated_scopes: 0,
        job_ids: [],
      });
    }
    return MarkVectorRestoreDegradedResultSchema.parse(
      this.#database
        .transaction(() => {
          const scopes = this.#database
            .prepare(
              `SELECT principal_id, scope_kind, scope_id
               FROM vector_projection_scope_state
               ORDER BY principal_id, scope_kind, scope_id`,
            )
            .all() as Array<{
              principal_id: string;
              scope_kind: Scope["kind"];
              scope_id: string;
            }>;
          this.#openGuard("restore", request.restored_at);
          try {
            const jobIds = scopes.map((row) =>
              this.#enqueueScope({
                ...exactScope(row),
                epochId: configuration.desired_epoch_id as string,
                occurredAt: request.restored_at,
                reason: "recovery",
              })
            );
            return {
              updated_scopes: scopes.length,
              job_ids: jobIds,
            };
          } finally {
            this.#closeGuard();
          }
        })
        .immediate(),
    );
  }

  temporalSweep(input: unknown): RunVectorTemporalSweepResult {
    const request =
      RunVectorTemporalSweepInputSchema.parse(input);
    const configuration = this.#configuration();
    if (
      configuration.mode === "disabled" ||
      configuration.desired_epoch_id === null
    ) {
      return RunVectorTemporalSweepResultSchema.parse({
        checkpoints: [],
        job_ids: [],
        truncated: false,
      });
    }
    return RunVectorTemporalSweepResultSchema.parse(
      this.#database
        .transaction(() => {
          const rows = this.#database
            .prepare(
              `SELECT principal_id, scope_kind, scope_id
               FROM vector_projection_scope_state
               WHERE next_validity_transition_at IS NOT NULL
                 AND next_validity_transition_at <= ?
                 AND state <> 'disabled'
               ORDER BY next_validity_transition_at,
                        principal_id, scope_kind, scope_id
               LIMIT ?`,
            )
            .all(
              request.as_of,
              request.limit + 1,
            ) as Array<{
              principal_id: string;
              scope_kind: Scope["kind"];
              scope_id: string;
            }>;
          const selected = rows.slice(0, request.limit);
          this.#openGuard("temporal-sweep", request.as_of);
          try {
            const jobIds = selected.map((row) =>
              this.#enqueueScope({
                ...exactScope(row),
                epochId: configuration.desired_epoch_id as string,
                occurredAt: request.as_of,
                reason: "temporal_transition",
              })
            );
            return {
              checkpoints: selected.map((row) =>
                this.checkpoint(exactScope(row))
              ),
              job_ids: jobIds,
              truncated: rows.length > request.limit,
            };
          } finally {
            this.#closeGuard();
          }
        })
        .immediate(),
    );
  }

  status(): VectorProjectionStatus {
    const configuration = this.#configuration();
    return VectorProjectionStatusSchema.parse({
      mode: configuration.mode,
      epoch_id: configuration.desired_epoch_id,
      registered_epochs: count(
        this.#database,
        "vector_embedding_epochs",
      ),
      scope_states: count(
        this.#database,
        "vector_projection_scope_state",
      ),
      published_scopes: count(
        this.#database,
        "vector_projection_scope_state",
        "WHERE state = 'published'",
      ),
      pending_scopes: count(
        this.#database,
        "vector_projection_scope_state",
        "WHERE state IN ('pending', 'building')",
      ),
      degraded_scopes: count(
        this.#database,
        "vector_projection_scope_state",
        "WHERE state = 'degraded'",
      ),
      outbox_pending: count(
        this.#database,
        "vector_projection_outbox_jobs",
        "WHERE status IN ('pending', 'processing', 'failed')",
      ),
      receipts: count(
        this.#database,
        "vector_projection_receipts",
      ),
    });
  }

  #complete(
    command: {
      job_id: string;
      worker_id: string;
      lease_token: string;
      receipt: VectorProjectionReceipt;
    },
    expectedOutcome: "published",
  ): VectorProjectionJobResult {
    const receipt = VectorProjectionReceiptSchema.parse(
      command.receipt,
    );
    if (receipt.outcome !== expectedOutcome) {
      throw new StorageError("INVALID_INPUT");
    }
    const replay = this.#replayedResult(command);
    if (replay !== null) {
      return replay;
    }
    return VectorProjectionJobResultSchema.parse(
      this.#database
        .transaction(() => {
          const job = this.#requireLease(command);
          this.#assertReceiptIdentity(job, receipt);
          const scope = this.#readScope(exactScope(job));
          if (
            scope === undefined ||
            scope.desired_epoch_id !== job.desired_epoch_id ||
            scope.desired_generation_id !==
              job.desired_generation_id ||
            scope.source_frontier_hash !== job.source_frontier_hash ||
            receipt.logical_digest === null
          ) {
            throw new StorageError("CONFLICT");
          }
          this.#openGuard("apply", receipt.created_at);
          try {
            this.#insertReceipt(receipt);
            this.#database
              .prepare(
                `UPDATE vector_projection_outbox_jobs
                 SET status = 'applied',
                     claimed_by = NULL,
                     lease_token = NULL,
                     lease_expires_at = NULL,
                     completed_at = ?,
                     failure_category = NULL
                 WHERE job_id = ?`,
              )
              .run(receipt.created_at, job.job_id);
            this.#database
              .prepare(
                `UPDATE vector_projection_scope_state
                 SET state = 'published',
                     active_epoch_id = desired_epoch_id,
                     active_generation_id = desired_generation_id,
                     logical_digest = ?,
                     last_job_id = ?,
                     failure_category = NULL,
                     updated_at = ?
                 WHERE principal_id = ?
                   AND scope_kind = ?
                   AND scope_id = ?`,
              )
              .run(
                receipt.logical_digest,
                job.job_id,
                receipt.created_at,
                job.principal_id,
                job.scope_kind,
                job.scope_id,
              );
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
              principal_id: job.principal_id,
              scope: { kind: job.scope_kind, id: job.scope_id },
            }),
            receipt,
            replayed: false,
          };
        })
        .immediate(),
    );
  }

  #replayedResult(input: {
    job_id: string;
    receipt: VectorProjectionReceipt;
  }): VectorProjectionJobResult | null {
    const existing = this.#readReceipt(input.receipt.receipt_id);
    if (existing === undefined) {
      return null;
    }
    if (canonicalJson(existing) !== canonicalJson(input.receipt)) {
      throw new StorageError("CONFLICT");
    }
    const job = this.#readJob(input.job_id);
    if (job === undefined) {
      throw new StorageError("CORRUPTION");
    }
    this.#assertReceiptIdentity(job, existing);
    return VectorProjectionJobResultSchema.parse({
      job: this.#jobFromRow(job),
      checkpoint: this.checkpoint({
        principal_id: job.principal_id,
        scope: { kind: job.scope_kind, id: job.scope_id },
      }),
      receipt: existing,
      replayed: true,
    });
  }

  #enqueueScope(input: ExactScope & {
    epochId: string;
    occurredAt: string;
    reason: VectorProjectionOutboxJob["reason"];
    causeId?: string;
    revisionId?: string;
    ledgerEpochOffset?: 0 | 1;
  }): string {
    const frontier = this.#sourceFrontier(
      input,
      input.occurredAt,
      input.ledgerEpochOffset ?? 0,
    );
    const generationId = stableIdentifier("vector-generation", {
      principal_id: input.principal_id,
      scope: input.scope,
      epoch_id: input.epochId,
      frontier,
    });
    const jobId = stableIdentifier("vector-job", {
      principal_id: input.principal_id,
      scope: input.scope,
      epoch_id: input.epochId,
      generation_id: generationId,
      reason: input.reason,
      cause_id: input.causeId ?? null,
      revision_id: input.revisionId ?? null,
    });
    this.#database
      .prepare(
        `UPDATE vector_projection_outbox_jobs
         SET status = 'stale',
             claimed_by = NULL,
             lease_token = NULL,
             lease_expires_at = NULL,
             completed_at = ?,
             failure_category = 'FRONTIER_STALE'
         WHERE principal_id = ?
           AND scope_kind = ?
           AND scope_id = ?
           AND job_id <> ?
           AND status IN ('pending', 'processing', 'failed')`,
      )
      .run(
        input.occurredAt,
        input.principal_id,
        input.scope.kind,
        input.scope.id,
        jobId,
      );
    this.#database
      .prepare(
        `INSERT INTO vector_projection_scope_state (
           principal_id, scope_kind, scope_id,
           desired_epoch_id, active_epoch_id,
           desired_generation_id, active_generation_id,
           state, ledger_epoch, tombstone_epoch,
           source_frontier_hash, next_validity_transition_at,
           logical_digest, last_job_id, failure_category, updated_at
         ) VALUES (?, ?, ?, ?, NULL, ?, NULL, 'pending', ?, ?, ?, ?,
                   NULL, ?, NULL, ?)
         ON CONFLICT (principal_id, scope_kind, scope_id)
         DO UPDATE SET
           desired_epoch_id = excluded.desired_epoch_id,
           desired_generation_id = excluded.desired_generation_id,
           state = 'pending',
           ledger_epoch = excluded.ledger_epoch,
           tombstone_epoch = excluded.tombstone_epoch,
           source_frontier_hash = excluded.source_frontier_hash,
           next_validity_transition_at =
             excluded.next_validity_transition_at,
           logical_digest = NULL,
           last_job_id = excluded.last_job_id,
           failure_category = NULL,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.principal_id,
        input.scope.kind,
        input.scope.id,
        input.epochId,
        generationId,
        frontier.ledger_epoch,
        frontier.tombstone_epoch,
        frontier.source_frontier_hash,
        frontier.next_validity_transition_at,
        jobId,
        input.occurredAt,
      );
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO vector_projection_outbox_jobs (
           job_id, principal_id, scope_kind, scope_id, reason,
           desired_epoch_id, desired_generation_id, source_frontier_hash,
           status, attempts, available_at, claimed_by, lease_token,
           lease_expires_at, created_at, completed_at, failure_category
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL,
                   NULL, ?, NULL, NULL)`,
      )
      .run(
        jobId,
        input.principal_id,
        input.scope.kind,
        input.scope.id,
        input.reason,
        input.epochId,
        generationId,
        frontier.source_frontier_hash,
        input.occurredAt,
        input.occurredAt,
      );
    return jobId;
  }

  #sourceFrontier(
    scope: ExactScope,
    asOf: string,
    ledgerEpochOffset: 0 | 1,
  ): {
    ledger_epoch: number;
    tombstone_epoch: number;
    source_frontier_hash: string;
    next_validity_transition_at: string | null;
  } {
    const epochs = this.#database
      .prepare(
        `SELECT
           (SELECT ledger_epoch FROM ledger_state WHERE singleton = 1)
             AS ledger_epoch,
           (SELECT tombstone_epoch FROM tombstone_state WHERE singleton = 1)
             AS tombstone_epoch`,
      )
      .get() as {
      ledger_epoch: number;
      tombstone_epoch: number;
    };
    const transition = this.#database
      .prepare(
        `SELECT min(transition_at) AS transition_at
         FROM (
           SELECT r.valid_from AS transition_at
           FROM memory_objects AS o
           JOIN memory_revisions AS r
             ON r.revision_id = o.current_revision_id
           WHERE o.principal_id = ?
             AND o.scope_kind = ?
             AND o.scope_id = ?
             AND o.lifecycle = 'active'
             AND o.context_eligible = 1
             AND r.sensitivity NOT IN ('sensitive', 'secret')
             AND r.valid_from > ?
           UNION ALL
           SELECT r.valid_to AS transition_at
           FROM memory_objects AS o
           JOIN memory_revisions AS r
             ON r.revision_id = o.current_revision_id
           WHERE o.principal_id = ?
             AND o.scope_kind = ?
             AND o.scope_id = ?
             AND o.lifecycle = 'active'
             AND o.context_eligible = 1
             AND r.sensitivity NOT IN ('sensitive', 'secret')
             AND r.valid_to IS NOT NULL
             AND r.valid_to > ?
         )`,
      )
      .get(
        scope.principal_id,
        scope.scope.kind,
        scope.scope.id,
        asOf,
        scope.principal_id,
        scope.scope.kind,
        scope.scope.id,
        asOf,
      ) as { transition_at: string | null };
    const body = {
      schema_version: "1.0.0",
      ledger_epoch: epochs.ledger_epoch + ledgerEpochOffset,
      tombstone_epoch: epochs.tombstone_epoch,
      principal_id: scope.principal_id,
      scope_key: scopeKey(scope.scope),
      next_validity_transition_at: transition.transition_at,
    };
    return {
      ledger_epoch: epochs.ledger_epoch + ledgerEpochOffset,
      tombstone_epoch: epochs.tombstone_epoch,
      source_frontier_hash: canonicalSha256(body),
      next_validity_transition_at: transition.transition_at,
    };
  }

  #configuration(): ConfigurationRow {
    const row = this.#database
      .prepare(
        `SELECT mode, desired_epoch_id, configured_at
         FROM vector_runtime_configuration WHERE singleton = 1`,
      )
      .get() as ConfigurationRow | undefined;
    if (row === undefined) {
      throw new StorageError("CORRUPTION");
    }
    return row;
  }

  #readEpoch(epochId: string): VectorEmbeddingEpoch | undefined {
    const row = this.#database
      .prepare(
        `SELECT epoch_json FROM vector_embedding_epochs
         WHERE epoch_id = ?`,
      )
      .get(epochId) as { epoch_json: string } | undefined;
    return row === undefined
      ? undefined
      : VectorEmbeddingEpochSchema.parse(
          JSON.parse(row.epoch_json) as unknown,
        );
  }

  #readScope(input: ExactScope): ScopeRow | undefined {
    return this.#database
      .prepare(
        `SELECT principal_id, scope_kind, scope_id,
                desired_epoch_id, active_epoch_id,
                desired_generation_id, active_generation_id,
                state, ledger_epoch, tombstone_epoch,
                source_frontier_hash, next_validity_transition_at,
                logical_digest, last_job_id, failure_category, updated_at
         FROM vector_projection_scope_state
         WHERE principal_id = ?
           AND scope_kind = ?
           AND scope_id = ?`,
      )
      .get(
        input.principal_id,
        input.scope.kind,
        input.scope.id,
      ) as ScopeRow | undefined;
  }

  #checkpointFromRow(row: ScopeRow): VectorScopeCheckpoint {
    return VectorScopeCheckpointSchema.parse({
      schema_version: "1.0.0",
      principal_id: row.principal_id,
      scope: { kind: row.scope_kind, id: row.scope_id },
      desired_epoch_id: row.desired_epoch_id,
      active_epoch_id: row.active_epoch_id,
      desired_generation_id: row.desired_generation_id,
      active_generation_id: row.active_generation_id,
      frontier: {
        ledger_epoch: row.ledger_epoch,
        tombstone_epoch: row.tombstone_epoch,
        source_frontier_hash: row.source_frontier_hash,
        next_validity_transition_at:
          row.next_validity_transition_at,
      },
      logical_digest: row.logical_digest,
      state: row.state,
      last_job_id: row.last_job_id,
      failure_category: row.failure_category,
    });
  }

  #readJob(jobId: string): JobRow | undefined {
    return this.#database
      .prepare(
        `SELECT job_id, principal_id, scope_kind, scope_id, reason,
                desired_epoch_id, desired_generation_id,
                source_frontier_hash, status, attempts, available_at,
                claimed_by, lease_token, lease_expires_at,
                created_at, completed_at, failure_category
         FROM vector_projection_outbox_jobs WHERE job_id = ?`,
      )
      .get(jobId) as JobRow | undefined;
  }

  #jobFromRow(row: JobRow): VectorProjectionOutboxJob {
    return VectorProjectionOutboxJobSchema.parse({
      schema_version: "1.0.0",
      job_id: row.job_id,
      principal_id: row.principal_id,
      scope: { kind: row.scope_kind, id: row.scope_id },
      reason: row.reason,
      desired_epoch_id: row.desired_epoch_id,
      desired_generation_id: row.desired_generation_id,
      source_frontier_hash: row.source_frontier_hash,
      attempt: row.attempts,
      lease_id: row.lease_token,
      lease_expires_at: row.lease_expires_at,
      status: row.status,
      available_at: row.available_at,
      created_at: row.created_at,
      completed_at: row.completed_at,
      failure_category: row.failure_category,
    });
  }

  #requireLease(input: {
    job_id: string;
    worker_id: string;
    lease_token: string;
    receipt: VectorProjectionReceipt;
  }): JobRow {
    const job = this.#readJob(input.job_id);
    if (
      job === undefined ||
      job.status !== "processing" ||
      job.claimed_by !== input.worker_id ||
      job.lease_token !== input.lease_token ||
      job.lease_expires_at === null ||
      Date.parse(job.lease_expires_at) <
        Date.parse(input.receipt.created_at)
    ) {
      throw new StorageError("CONFLICT");
    }
    return job;
  }

  #assertReceiptIdentity(
    job: JobRow,
    receipt: VectorProjectionReceipt,
  ): void {
    if (
      receipt.job_id !== job.job_id ||
      receipt.principal_id !== job.principal_id ||
      receipt.scope.kind !== job.scope_kind ||
      receipt.scope.id !== job.scope_id ||
      receipt.embedding_epoch_id !== job.desired_epoch_id ||
      receipt.generation_id !== job.desired_generation_id ||
      receipt.source_frontier_hash !== job.source_frontier_hash
    ) {
      throw new StorageError("CONFLICT");
    }
  }

  #insertReceipt(receipt: VectorProjectionReceipt): void {
    this.#database
      .prepare(
        `INSERT INTO vector_projection_receipts (
           receipt_id, job_id, principal_id, scope_kind, scope_id,
           outcome, receipt_json, receipt_hash, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.receipt_id,
        receipt.job_id,
        receipt.principal_id,
        receipt.scope.kind,
        receipt.scope.id,
        receipt.outcome,
        canonicalJson(receipt),
        receipt.receipt_hash,
        receipt.created_at,
      );
  }

  #readReceipt(
    receiptId: string,
  ): VectorProjectionReceipt | undefined {
    const row = this.#database
      .prepare(
        `SELECT receipt_json FROM vector_projection_receipts
         WHERE receipt_id = ?`,
      )
      .get(receiptId) as { receipt_json: string } | undefined;
    return row === undefined
      ? undefined
      : VectorProjectionReceiptSchema.parse(
          JSON.parse(row.receipt_json) as unknown,
        );
  }

  #openGuard(operation: string, openedAt: string): void {
    this.#database
      .prepare(
        `INSERT INTO vector_projection_write_guard (
           singleton, operation, opened_at
         ) VALUES (1, ?, ?)`,
      )
      .run(operation, openedAt);
  }

  #closeGuard(): void {
    this.#database
      .prepare(
        "DELETE FROM vector_projection_write_guard WHERE singleton = 1",
      )
      .run();
  }
}

export function enqueueVectorProjectionEffect(
  database: Database.Database,
  effect: CanonicalVectorProjectionEffect,
): string | null {
  return new VectorProjectionRepository(database)
    .enqueueCanonicalEffect(effect);
}
