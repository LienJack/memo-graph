import {
  ContextSliceSchema,
  MutationReceiptSchema,
  ProjectionRevisionSchema,
  PurgeReceiptSchema,
  PurgeStoreOutcomeSchema,
  PurgeStoreSchema,
  approvalGrantMatches,
  canonicalJson,
  canonicalSha256,
  canonicalSha256Omitting,
  receiptHashIsValid,
  scopeKey,
  sealReceipt,
  type PurgeReceipt,
  type PurgeStore,
  type PurgeStoreOutcome,
} from "@memo-graph/contracts";
import type Database from "better-sqlite3";

import type { BlobStore } from "./blob-store.js";
import { StorageError } from "./errors.js";
import { invalidateLearningTargets } from "./learning-repository.js";
import { suppressProjectionDescendants } from "./projection-effects.js";
import {
  MemoryDeleteResultSchema,
  type MemoryDeleteResult,
  type ParsedMemoryDeleteCommand,
  type PurgeCounts,
} from "./protocol.js";

type DeleteMemoryRow = {
  memory_id: string;
  principal_id: string;
  scope_kind:
    | "thread"
    | "topic"
    | "scenario"
    | "user"
    | "workspace"
    | "agent";
  scope_id: string;
  lifecycle:
    | "working"
    | "candidate"
    | "active"
    | "superseded"
    | "revoked"
    | "quarantined"
    | "purged";
  current_revision_id: string | null;
};

type ExistingDeleteMutation = {
  request_hash: string;
  receipt_json: string;
  result_json: string | null;
};

type PurgeJobRow = {
  purge_job_id: string;
  memory_id: string;
  tombstone_epoch: number;
  status: "pending" | "running" | "partial" | "completed" | "failed";
  attempts: number;
  principal_id: string;
  scope_kind: DeleteMemoryRow["scope_kind"];
  scope_id: string;
  revision_id: string;
  actor_authority: string;
  reason: string;
};

type ContextRow = {
  context_slice_id: string;
  slice_json: string;
};

type ContextItemRow = {
  context_slice_id: string;
  ordinal: number;
  item_json: string;
};

type ProjectionRevisionRow = {
  projection_revision_id: string;
  projection_id: string;
  projection_type: string;
  revision_json: string;
};

const PURGE_STORES = PurgeStoreSchema.options;
const REDACTED_MEDIA_TYPE = "application/x.memo-graph-redacted";

function count(database: Database.Database, table: string): number {
  return Number(
    (
      database
        .prepare(`SELECT count(*) AS count FROM ${table}`)
        .get() as { count: number }
    ).count,
  );
}

function stableIdentifier(prefix: string, value: unknown): string {
  return `${prefix}:${canonicalSha256(value).slice("sha256:".length, 55)}`;
}

function uniqueHashes(hashes: readonly string[]): Array<`sha256:${string}`> {
  return [...new Set(hashes)].sort() as Array<`sha256:${string}`>;
}

export class PurgeRepository {
  readonly #database: Database.Database;
  readonly #blobStore: BlobStore;

  constructor(database: Database.Database, blobStore: BlobStore) {
    this.#database = database;
    this.#blobStore = blobStore;
  }

  tombstoneEpoch(): number {
    return Number(
      (
        this.#database
          .prepare(
            `SELECT tombstone_epoch
             FROM tombstone_state WHERE singleton = 1`,
          )
          .get() as { tombstone_epoch: number }
      ).tombstone_epoch,
    );
  }

  counts(): PurgeCounts {
    return {
      memory_tombstones: count(this.#database, "memory_tombstones"),
      purge_jobs: count(this.#database, "purge_jobs"),
      purge_store_outcomes: count(this.#database, "purge_store_outcomes"),
      purge_receipts: count(this.#database, "purge_receipts"),
      approval_consumptions: count(
        this.#database,
        "approval_consumptions",
      ),
    };
  }

  replayDelete(
    idempotencyKey: string,
    requestHash: string,
  ): MemoryDeleteResult | null {
    const existing = this.#readDeleteMutation(idempotencyKey);
    return existing === undefined
      ? null
      : this.#parseDeleteMutation(existing, requestHash);
  }

  deleteMemory(
    command: ParsedMemoryDeleteCommand,
  ): MemoryDeleteResult {
    const requestHash = canonicalSha256(command.request);
    const idempotencyKey = command.request.envelope.idempotency_key;
    const existing = this.#readDeleteMutation(idempotencyKey);
    if (existing !== undefined) {
      return this.#parseDeleteMutation(existing, requestHash);
    }
    return this.#governedWrite("delete_memory", () => {
      const repeated = this.#readDeleteMutation(idempotencyKey);
      if (repeated !== undefined) {
        return this.#parseDeleteMutation(repeated, requestHash);
      }
      const memory = this.#readMemory(command.request.memory_id);
      this.#validateDeleteTarget(command, memory);
      const revisionId = memory.current_revision_id;
      if (revisionId === null || memory.lifecycle === "purged") {
        throw new StorageError("STALE_REVISION");
      }
      if (command.request.envelope.dry_run) {
        return this.#sealDelete({
          command,
          requestHash,
          memory,
          revisionId,
          tombstoneEpoch: null,
          purgeJobId: null,
          projectionJobs: [],
        });
      }
      this.#validateDeleteApproval(command, requestHash);
      const occurredAt = command.request.envelope.requested_at;
      const tombstoneEpoch = this.tombstoneEpoch() + 1;
      const purgeJobId = stableIdentifier("purge-job", {
        memory_id: memory.memory_id,
        tombstone_epoch: tombstoneEpoch,
      });
      this.#database
        .prepare(
          `UPDATE tombstone_state
           SET tombstone_epoch = ?, updated_at = ?
           WHERE singleton = 1`,
        )
        .run(tombstoneEpoch, occurredAt);
      this.#database
        .prepare(
          `INSERT INTO purge_jobs (
             purge_job_id, memory_id, tombstone_epoch, status, attempts,
             created_at, updated_at, last_error_code
           ) VALUES (?, ?, ?, 'pending', 0, ?, ?, NULL)`,
        )
        .run(
          purgeJobId,
          memory.memory_id,
          tombstoneEpoch,
          occurredAt,
          occurredAt,
        );
      this.#database
        .prepare(
          `INSERT INTO memory_tombstones (
             memory_id, revision_id, tombstone_epoch, purge_job_id,
             principal_id, scope_kind, scope_id, reason, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          memory.memory_id,
          revisionId,
          tombstoneEpoch,
          purgeJobId,
          memory.principal_id,
          memory.scope_kind,
          memory.scope_id,
          command.request.envelope.reason,
          occurredAt,
        );
      const changed = this.#database
        .prepare(
          `UPDATE memory_objects
           SET lifecycle = 'purged', current_revision_id = NULL,
               context_eligible = 0, updated_at = ?
           WHERE memory_id = ? AND current_revision_id = ?`,
        )
        .run(occurredAt, memory.memory_id, revisionId);
      if (changed.changes !== 1) {
        throw new StorageError("STALE_REVISION");
      }
      invalidateLearningTargets(this.#database, {
        memoryId: memory.memory_id,
        revisionId,
        reason: "tombstoned",
        tombstoneEpoch,
        createdAt: occurredAt,
      });
      this.#database
        .prepare(
          `INSERT INTO memory_status_events (
             status_event_id, memory_id, revision_id, action, lifecycle,
             principal_id, actor_authority, reason, tombstone_epoch,
             occurred_at
           ) VALUES (?, ?, ?, 'tombstone', 'purged', ?, ?, ?, ?, ?)`,
        )
        .run(
          stableIdentifier("status", {
            idempotency_key: idempotencyKey,
            action: "tombstone",
          }),
          memory.memory_id,
          revisionId,
          memory.principal_id,
          command.request.envelope.actor_claim.authority,
          command.request.envelope.reason,
          tombstoneEpoch,
          occurredAt,
        );
      const projectionJob = this.#insertInvalidation(
        memory.memory_id,
        occurredAt,
      );
      const layeredProjectionJob = suppressProjectionDescendants(
        this.#database,
        {
          causeId: idempotencyKey,
          memoryId: memory.memory_id,
          revisionId,
          principalId: memory.principal_id,
          scope: {
            kind: memory.scope_kind,
            id: memory.scope_id,
          },
          occurredAt,
          vectorReason: "purge",
        },
      );
      const result = this.#sealDelete({
        command,
        requestHash,
        memory,
        revisionId,
        tombstoneEpoch,
        purgeJobId,
        projectionJobs: [projectionJob, layeredProjectionJob],
      });
      this.#consumeDeleteApproval(command, requestHash, result);
      return result;
    });
  }

  run(purgeJobId: string): PurgeReceipt {
    const initial = this.#readPurgeJob(purgeJobId);
    if (initial.status === "completed") {
      return this.#latestPurgeReceipt(purgeJobId);
    }
    const job = this.#claim(initial);
    if (job.status === "completed") {
      return this.#latestPurgeReceipt(job.purge_job_id);
    }
    const outcomes: PurgeStoreOutcome[] = [];
    let failed = false;
    for (const store of PURGE_STORES) {
      if (failed) {
        outcomes.push(
          this.#recordOutcome(job, store, "failed", [], "SKIPPED_AFTER_FAILURE"),
        );
        continue;
      }
      try {
        const residuals = this.#runStore(job, store);
        outcomes.push(
          this.#recordOutcome(
            job,
            store,
            residuals.length === 0 ? "verified" : "residual",
            residuals,
            null,
          ),
        );
      } catch {
        failed = true;
        outcomes.push(
          this.#recordOutcome(job, store, "failed", [], "PURGE_STORE_FAILURE"),
        );
      }
    }
    return this.#finalize(job, outcomes);
  }

  #claim(job: PurgeJobRow): PurgeJobRow {
    return this.#database
      .transaction(() => {
        const current = this.#readPurgeJob(job.purge_job_id);
        if (current.status === "completed") {
          return current;
        }
        this.#database
          .prepare(
            `DELETE FROM purge_redaction_guard
             WHERE purge_job_id = ? AND memory_id = ?`,
          )
          .run(current.purge_job_id, current.memory_id);
        const updatedAt = new Date().toISOString();
        this.#database
          .prepare(
            `UPDATE purge_jobs
             SET status = 'running', attempts = attempts + 1,
                 updated_at = ?, last_error_code = NULL
             WHERE purge_job_id = ?`,
          )
          .run(updatedAt, current.purge_job_id);
        this.#database
          .prepare(
            `INSERT INTO purge_redaction_guard (
               singleton, purge_job_id, memory_id, opened_at
             ) VALUES (1, ?, ?, ?)`,
          )
          .run(current.purge_job_id, current.memory_id, updatedAt);
        return this.#readPurgeJob(current.purge_job_id);
      })
      .immediate();
  }

  #runStore(job: PurgeJobRow, store: PurgeStore): Array<`sha256:${string}`> {
    if (store === "projections") {
      return this.#purgeProjections(job);
    }
    return this.#database
      .transaction(() => {
        switch (store) {
          case "memory_revisions":
            return this.#purgeRevisionsAndEvidence(job);
          case "candidates":
            return this.#purgeCandidates(job);
          case "conflicts":
            return this.#verifyConflicts(job);
          case "fts":
            return this.#purgeFts(job);
          case "context":
            return this.#purgeContext(job);
          case "exports":
            return this.#purgeExports(job);
          case "blobs":
            return this.#purgeBlobs(job);
          case "backups":
            return this.#verifyBackups(job);
        }
      })
      .immediate();
  }

  #purgeRevisionsAndEvidence(
    job: PurgeJobRow,
  ): Array<`sha256:${string}`> {
    const sharedHashes = (
      this.#database
        .prepare(
          `SELECT DISTINCT e.content_hash
           FROM memory_revisions AS target_r
           JOIN memory_revision_evidence AS target_re
             ON target_re.revision_id = target_r.revision_id
           JOIN evidence_events AS e
             ON e.evidence_id = target_re.evidence_id
           WHERE target_r.memory_id = ?
             AND EXISTS (
               SELECT 1
               FROM memory_revision_evidence AS other_re
               JOIN memory_revisions AS other_r
                 ON other_r.revision_id = other_re.revision_id
               JOIN memory_objects AS other_m
                 ON other_m.memory_id = other_r.memory_id
               WHERE other_re.evidence_id = e.evidence_id
                 AND other_m.memory_id <> ?
                 AND other_m.lifecycle <> 'purged'
             )
           ORDER BY e.content_hash`,
        )
        .all(job.memory_id, job.memory_id) as Array<{
        content_hash: `sha256:${string}`;
      }>
    ).map((row) => row.content_hash);
    this.#database
      .prepare(
        `UPDATE evidence_events
         SET payload_storage = 'inline', payload_inline = '[PURGED]',
             payload_blob_hash = NULL, media_type = ?,
             purged_at = COALESCE(purged_at, ?)
         WHERE evidence_id IN (
           SELECT re.evidence_id
           FROM memory_revisions AS r
           JOIN memory_revision_evidence AS re
             ON re.revision_id = r.revision_id
           WHERE r.memory_id = ?
         )
           AND purged_at IS NULL
           AND NOT EXISTS (
             SELECT 1
             FROM memory_revision_evidence AS other_re
             JOIN memory_revisions AS other_r
               ON other_r.revision_id = other_re.revision_id
             JOIN memory_objects AS other_m
               ON other_m.memory_id = other_r.memory_id
             WHERE other_re.evidence_id = evidence_events.evidence_id
               AND other_m.memory_id <> ?
               AND other_m.lifecycle <> 'purged'
           )`,
      )
      .run(
        REDACTED_MEDIA_TYPE,
        new Date().toISOString(),
        job.memory_id,
        job.memory_id,
      );
    this.#database
      .prepare(
        `UPDATE memory_revisions
         SET lifecycle = 'purged', content_storage = 'redacted',
             content_inline = NULL, content_blob_hash = NULL,
             media_type = ?, purged_at = COALESCE(purged_at, ?)
         WHERE memory_id = ? AND purged_at IS NULL`,
      )
      .run(REDACTED_MEDIA_TYPE, new Date().toISOString(), job.memory_id);
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO memory_status_events (
           status_event_id, memory_id, revision_id, action, lifecycle,
           principal_id, actor_authority, reason, tombstone_epoch,
           occurred_at
         ) VALUES (?, ?, ?, 'purge_redact', 'purged', ?, ?, ?, ?, ?)`,
      )
      .run(
        stableIdentifier("status", {
          purge_job_id: job.purge_job_id,
          action: "purge_redact",
        }),
        job.memory_id,
        job.revision_id,
        job.principal_id,
        job.actor_authority,
        job.reason,
        job.tombstone_epoch,
        new Date().toISOString(),
      );
    return uniqueHashes(sharedHashes);
  }

  #purgeCandidates(job: PurgeJobRow): Array<`sha256:${string}`> {
    this.#database
      .prepare(
        `UPDATE memory_candidates
         SET content_storage = 'redacted', content_inline = NULL,
             content_blob_hash = NULL, media_type = ?,
             purged_at = COALESCE(purged_at, ?)
         WHERE candidate_id IN (
           SELECT candidate_id FROM memory_candidate_links
           WHERE memory_id = ?
         )
           AND purged_at IS NULL`,
      )
      .run(REDACTED_MEDIA_TYPE, new Date().toISOString(), job.memory_id);
    return [];
  }

  #verifyConflicts(job: PurgeJobRow): Array<`sha256:${string}`> {
    const residual = this.#database
      .prepare(
        `SELECT c.content_hash
         FROM memory_conflict_candidates AS cc
         JOIN memory_candidates AS c ON c.candidate_id = cc.candidate_id
         JOIN memory_candidate_links AS l ON l.candidate_id = c.candidate_id
         WHERE l.memory_id = ?
           AND c.content_storage <> 'redacted'
         ORDER BY c.content_hash`,
      )
      .all(job.memory_id) as Array<{
      content_hash: `sha256:${string}`;
    }>;
    return uniqueHashes(residual.map((row) => row.content_hash));
  }

  #purgeFts(job: PurgeJobRow): Array<`sha256:${string}`> {
    this.#database
      .prepare("DELETE FROM memory_fts WHERE memory_id = ?")
      .run(job.memory_id);
    this.#database
      .prepare(
        `DELETE FROM evidence_fts
         WHERE evidence_id IN (
           SELECT e.evidence_id
           FROM evidence_events AS e
           JOIN memory_revision_evidence AS re
             ON re.evidence_id = e.evidence_id
           JOIN memory_revisions AS r ON r.revision_id = re.revision_id
           WHERE r.memory_id = ? AND e.purged_at IS NOT NULL
         )`,
      )
      .run(job.memory_id);
    return [];
  }

  #purgeContext(job: PurgeJobRow): Array<`sha256:${string}`> {
    const sharedEvidence = new Set(
      this.#purgeRevisionsAndEvidence(job),
    );
    const items = this.#database
      .prepare(
        `SELECT DISTINCT i.context_slice_id, i.ordinal, i.item_json
         FROM context_slice_items AS i
         LEFT JOIN context_slice_item_evidence AS cie
           ON cie.context_slice_id = i.context_slice_id
          AND cie.ordinal = i.ordinal
         LEFT JOIN evidence_events AS e ON e.evidence_id = cie.evidence_id
         WHERE i.memory_id = ?
            OR (
              cie.evidence_id IN (
                SELECT re.evidence_id
                FROM memory_revisions AS r
                JOIN memory_revision_evidence AS re
                  ON re.revision_id = r.revision_id
                WHERE r.memory_id = ?
              )
              AND e.purged_at IS NOT NULL
            )
            OR EXISTS (
              WITH RECURSIVE ancestry(
                source_revision_id,
                source_memory_id
              ) AS (
                SELECT source.source_revision_id,
                       source.source_memory_id
                FROM projection_revision_sources AS source
                WHERE source.projection_revision_id = json_extract(
                  i.item_json,
                  '$.projection.projection_revision_id'
                )
                UNION ALL
                SELECT source.source_revision_id,
                       source.source_memory_id
                FROM projection_revision_sources AS source
                JOIN ancestry
                  ON source.projection_revision_id =
                    ancestry.source_revision_id
              )
              SELECT 1
              FROM ancestry
              WHERE ancestry.source_memory_id = ?
              LIMIT 1
            )
         ORDER BY i.context_slice_id, i.ordinal`,
      )
      .all(job.memory_id, job.memory_id, job.memory_id) as ContextItemRow[];
    const bySlice = new Map<string, Set<number>>();
    for (const item of items) {
      const parsed = JSON.parse(item.item_json) as Record<string, unknown>;
      const redacted = {
        ...parsed,
        content: {
          storage: "inline",
          text: "[PURGED]",
          media_type: REDACTED_MEDIA_TYPE,
        },
      };
      this.#database
        .prepare(
          `UPDATE context_slice_items SET item_json = ?
           WHERE context_slice_id = ? AND ordinal = ?`,
        )
        .run(
          canonicalJson(redacted),
          item.context_slice_id,
          item.ordinal,
        );
      const ordinals = bySlice.get(item.context_slice_id) ?? new Set<number>();
      ordinals.add(item.ordinal);
      bySlice.set(item.context_slice_id, ordinals);
    }
    for (const [sliceId, ordinals] of bySlice) {
      const row = this.#database
        .prepare(
          `SELECT context_slice_id, slice_json FROM context_slices
           WHERE context_slice_id = ?`,
        )
        .get(sliceId) as ContextRow;
      const slice = ContextSliceSchema.parse(
        JSON.parse(row.slice_json) as unknown,
      );
      const unsealed = {
        ...slice,
        items: slice.items.map((item, ordinal) =>
          ordinals.has(ordinal)
            ? {
                ...item,
                content: {
                  storage: "inline" as const,
                  text: "[PURGED]",
                  media_type: REDACTED_MEDIA_TYPE,
                },
              }
            : item,
        ),
        frozen_hash: `sha256:${"0".repeat(64)}`,
      };
      const frozenHash = canonicalSha256Omitting(unsealed, ["frozen_hash"]);
      const redacted = ContextSliceSchema.parse({
        ...unsealed,
        frozen_hash: frozenHash,
      });
      this.#database
        .prepare(
          `UPDATE context_slices
           SET frozen_hash = ?, slice_json = ?
           WHERE context_slice_id = ?`,
        )
        .run(frozenHash, canonicalJson(redacted), sliceId);
    }
    return uniqueHashes([...sharedEvidence]);
  }

  #purgeExports(job: PurgeJobRow): Array<`sha256:${string}`> {
    this.#database
      .prepare(
        `UPDATE export_cache_inventory
         SET status = 'purged', updated_at = ?
         WHERE memory_id = ? AND status = 'live'`,
      )
      .run(new Date().toISOString(), job.memory_id);
    const residual = this.#database
      .prepare(
        `SELECT content_hash FROM export_cache_inventory
         WHERE memory_id = ? AND status = 'residual'
         ORDER BY content_hash`,
      )
      .all(job.memory_id) as Array<{
      content_hash: `sha256:${string}`;
    }>;
    return uniqueHashes(residual.map((row) => row.content_hash));
  }

  #purgeBlobs(job: PurgeJobRow): Array<`sha256:${string}`> {
    const hashes = this.#database
      .prepare(
        `SELECT DISTINCT a.content_hash
         FROM artifacts AS a
         WHERE a.content_hash IN (
           SELECT content_hash FROM memory_revisions WHERE memory_id = ?
           UNION
           SELECT c.content_hash
           FROM memory_candidates AS c
           JOIN memory_candidate_links AS l
             ON l.candidate_id = c.candidate_id
           WHERE l.memory_id = ?
           UNION
           SELECT e.content_hash
           FROM evidence_events AS e
           JOIN memory_revision_evidence AS re
             ON re.evidence_id = e.evidence_id
           JOIN memory_revisions AS r ON r.revision_id = re.revision_id
           WHERE r.memory_id = ?
         )
         ORDER BY a.content_hash`,
      )
      .all(job.memory_id, job.memory_id, job.memory_id) as Array<{
      content_hash: `sha256:${string}`;
    }>;
    const residuals: Array<`sha256:${string}`> = [];
    for (const { content_hash: contentHash } of hashes) {
      const references = Number(
        (
          this.#database
            .prepare(
              `SELECT
                 (SELECT count(*) FROM evidence_events
                  WHERE payload_blob_hash = ?) +
                 (SELECT count(*) FROM memory_candidates
                  WHERE content_blob_hash = ?) +
                 (SELECT count(*) FROM memory_revisions
                  WHERE content_blob_hash = ?) AS count`,
            )
            .get(contentHash, contentHash, contentHash) as { count: number }
        ).count,
      );
      if (references > 0) {
        residuals.push(contentHash);
        continue;
      }
      this.#blobStore.purge(contentHash);
      this.#database
        .prepare("DELETE FROM artifacts WHERE content_hash = ?")
        .run(contentHash);
    }
    return uniqueHashes(residuals);
  }

  #verifyBackups(job: PurgeJobRow): Array<`sha256:${string}`> {
    const stale = this.#database
      .prepare(
        `SELECT backup_id, ledger_epoch, tombstone_epoch
         FROM backup_manifests
         WHERE tombstone_epoch < ?
         ORDER BY backup_id`,
      )
      .all(job.tombstone_epoch) as Array<{
      backup_id: string;
      ledger_epoch: number;
      tombstone_epoch: number;
    }>;
    return stale.map((backup) =>
      canonicalSha256({
        kind: "stale_backup",
        ...backup,
      }),
    );
  }

  #purgeProjections(job: PurgeJobRow): Array<`sha256:${string}`> {
    const checkedAt = new Date().toISOString();
    const epoch = Number(
      (
        this.#database
          .prepare(
            "SELECT ledger_epoch FROM ledger_state WHERE singleton = 1",
          )
          .get() as { ledger_epoch: number }
      ).ledger_epoch,
    );
    this.#database
      .transaction(() => {
        const projectionRows = this.#database
          .prepare(
            `WITH RECURSIVE descendants(projection_revision_id) AS (
               SELECT projection_revision_id
               FROM projection_revision_sources
               WHERE source_memory_id = ?
               UNION
               SELECT source.projection_revision_id
               FROM projection_revision_sources AS source
               JOIN descendants
                 ON source.source_revision_id =
                    descendants.projection_revision_id
             )
             SELECT revision.projection_revision_id,
                    revision.projection_id,
                    revision.projection_type,
                    revision.revision_json
             FROM projection_revisions AS revision
             JOIN descendants
               ON descendants.projection_revision_id =
                  revision.projection_revision_id
             WHERE revision.purged_at IS NULL
             ORDER BY revision.projection_revision_id`,
          )
          .all(job.memory_id) as ProjectionRevisionRow[];
        if (projectionRows.length > 0) {
          this.#database
            .prepare(
              `INSERT INTO projection_write_guard (
                 singleton, operation, opened_at
               ) VALUES (1, 'purge-redaction', ?)`,
            )
            .run(checkedAt);
          try {
            const updateProjection = this.#database.prepare(
              `UPDATE projection_revisions
               SET lifecycle = 'purged',
                   payload_json = NULL,
                   content_json = NULL,
                   revision_json = ?,
                   purged_at = ?
               WHERE projection_revision_id = ?`,
            );
            const updateRelation = this.#database.prepare(
              `UPDATE relation_revisions
               SET lifecycle = 'purged',
                   description = NULL,
                   relation_json = ?
               WHERE projection_revision_id = ?`,
            );
            for (const row of projectionRows) {
              const revision = ProjectionRevisionSchema.parse(
                JSON.parse(row.revision_json) as unknown,
              );
              const redacted = ProjectionRevisionSchema.parse({
                ...revision,
                lifecycle: "purged",
                payload: null,
                content: null,
                invalidated_at: checkedAt,
                invalidation_reason:
                  "A canonical source memory was purged.",
              });
              updateProjection.run(
                canonicalJson(redacted),
                checkedAt,
                row.projection_revision_id,
              );
              if (row.projection_type === "relation") {
                const relation = this.#database
                  .prepare(
                    `SELECT relation_json
                     FROM relation_revisions
                     WHERE projection_revision_id = ?`,
                  )
                  .get(row.projection_revision_id) as
                  | { relation_json: string }
                  | undefined;
                if (relation !== undefined) {
                  updateRelation.run(
                    canonicalJson({
                      ...(JSON.parse(relation.relation_json) as Record<
                        string,
                        unknown
                      >),
                      description: null,
                    }),
                    row.projection_revision_id,
                  );
                }
              }
            }
            this.#database
              .prepare(
                `UPDATE projection_objects
                 SET lifecycle = 'purged',
                     current_revision_id = NULL,
                     updated_at = ?
                 WHERE current_revision_id IN (
                   SELECT value FROM json_each(?)
                 )`,
              )
              .run(
                checkedAt,
                canonicalJson(
                  projectionRows.map(
                    (row) => row.projection_revision_id,
                  ),
                ),
              );
            this.#database
              .prepare(
                `UPDATE relation_objects
                 SET lifecycle = 'purged',
                     current_relation_revision_id = NULL,
                     updated_at = ?
                 WHERE current_relation_revision_id IN (
                   SELECT value FROM json_each(?)
                 )`,
              )
              .run(
                checkedAt,
                canonicalJson(
                  projectionRows.map(
                    (row) => row.projection_revision_id,
                  ),
                ),
              );
          } finally {
            this.#database
              .prepare(
                "DELETE FROM projection_write_guard WHERE singleton = 1",
              )
              .run();
          }
        }
        this.#database
          .prepare(
            `UPDATE outbox_jobs
             SET status = 'processed', attempts = attempts + 1,
                 processed_at = ?, last_error_code = NULL
             WHERE (
               (
                 aggregate_id = ?
                 AND kind IN ('fts_memory_delete', 'fts_memory_invalidate')
               )
               OR (
                 kind = 'fts_evidence_upsert'
                 AND aggregate_id IN (
                   SELECT re.evidence_id
                   FROM memory_revisions AS r
                   JOIN memory_revision_evidence AS re
                     ON re.revision_id = r.revision_id
                   JOIN evidence_events AS e
                     ON e.evidence_id = re.evidence_id
                   WHERE r.memory_id = ? AND e.purged_at IS NOT NULL
                 )
               )
             )
               AND status IN ('pending', 'failed')`,
          )
          .run(checkedAt, job.memory_id, job.memory_id);
        const pending = Number(
          (
            this.#database
              .prepare(
                `SELECT count(*) AS count
                 FROM outbox_jobs
                 WHERE kind IN (
                   'fts_evidence_upsert',
                   'fts_memory_upsert',
                   'fts_memory_delete',
                   'fts_memory_invalidate'
                 )
                   AND status IN ('pending', 'failed')`,
              )
              .get() as { count: number }
          ).count,
        );
        if (pending === 0) {
          this.#database
            .prepare(
              `UPDATE projection_state
               SET status = 'ready', last_epoch = ?, updated_at = ?,
                   error_code = NULL
               WHERE projection_name IN ('fts', 'memory_fts')`,
            )
            .run(epoch, checkedAt);
        }
      })
      .immediate();
    return [];
  }

  #recordOutcome(
    job: PurgeJobRow,
    store: PurgeStore,
    status: PurgeStoreOutcome["status"],
    residualHashes: Array<`sha256:${string}`>,
    errorCode: string | null,
  ): PurgeStoreOutcome {
    const outcome = PurgeStoreOutcomeSchema.parse({
      store,
      status,
      residual_hashes: uniqueHashes(residualHashes),
      error_code: errorCode,
      checked_at: new Date().toISOString(),
    });
    this.#database
      .prepare(
        `INSERT INTO purge_store_outcomes (
           purge_job_id, store, attempt, status, residual_hashes_json,
           error_code, checked_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        job.purge_job_id,
        store,
        job.attempts,
        outcome.status,
        canonicalJson(outcome.residual_hashes),
        outcome.error_code,
        outcome.checked_at,
      );
    return outcome;
  }

  #finalize(
    job: PurgeJobRow,
    outcomes: PurgeStoreOutcome[],
  ): PurgeReceipt {
    const hasFailure = outcomes.some((outcome) => outcome.status === "failed");
    const residualHashes = uniqueHashes(
      outcomes.flatMap((outcome) => outcome.residual_hashes),
    );
    const completed = !hasFailure && residualHashes.length === 0;
    const state = completed ? "purged" : hasFailure ? "failed" : "partial";
    const createdAt = new Date().toISOString();
    const requestHash = canonicalSha256({
      purge_job_id: job.purge_job_id,
      tombstone_epoch: job.tombstone_epoch,
      attempt: job.attempts,
    });
    const receipt = PurgeReceiptSchema.parse(
      sealReceipt({
        schema_version: "1.0.0",
        receipt_id: stableIdentifier("purge-receipt", {
          purge_job_id: job.purge_job_id,
          attempt: job.attempts,
          outcomes,
        }),
        created_at: createdAt,
        state,
        request_hash: requestHash,
        receipt_hash: `sha256:${"0".repeat(64)}`,
        kind: "purge",
        purge_job_id: job.purge_job_id,
        target_memory_ids: [job.memory_id],
        tombstone_epoch: job.tombstone_epoch,
        stores_checked: [...PURGE_STORES],
        store_outcomes: outcomes,
        residual_hashes: residualHashes,
        completed,
      }),
    );
    this.#database
      .transaction(() => {
        this.#database
          .prepare(
            `INSERT INTO purge_receipts (
               receipt_id, purge_job_id, request_hash, receipt_hash, state,
               receipt_json, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            receipt.receipt_id,
            job.purge_job_id,
            receipt.request_hash,
            receipt.receipt_hash,
            receipt.state,
            canonicalJson(receipt),
            receipt.created_at,
          );
        this.#database
          .prepare(
            `INSERT INTO receipt_access_scopes (
               receipt_id, receipt_kind, principal_id, scope_kind, scope_id,
               created_at
             ) VALUES (?, 'purge', ?, ?, ?, ?)`,
          )
          .run(
            receipt.receipt_id,
            job.principal_id,
            job.scope_kind,
            job.scope_id,
            receipt.created_at,
          );
        this.#database
          .prepare(
            `DELETE FROM purge_redaction_guard
             WHERE purge_job_id = ? AND memory_id = ?`,
          )
          .run(job.purge_job_id, job.memory_id);
        this.#database
          .prepare(
            `UPDATE purge_jobs
             SET status = ?, updated_at = ?, last_error_code = ?
             WHERE purge_job_id = ?`,
          )
          .run(
            completed ? "completed" : hasFailure ? "failed" : "partial",
            receipt.created_at,
            hasFailure ? "PURGE_STORE_FAILURE" : null,
            job.purge_job_id,
          );
      })
      .immediate();
    return receipt;
  }

  #latestPurgeReceipt(purgeJobId: string): PurgeReceipt {
    const row = this.#database
      .prepare(
        `SELECT receipt_json FROM purge_receipts
         WHERE purge_job_id = ?
         ORDER BY created_at DESC, receipt_id DESC LIMIT 1`,
      )
      .get(purgeJobId) as { receipt_json: string } | undefined;
    if (row === undefined) {
      throw new StorageError("CORRUPTION");
    }
    const receipt = PurgeReceiptSchema.parse(
      JSON.parse(row.receipt_json) as unknown,
    );
    if (!receiptHashIsValid(receipt)) {
      throw new StorageError("CORRUPTION");
    }
    return receipt;
  }

  #readPurgeJob(purgeJobId: string): PurgeJobRow {
    const job = this.#database
      .prepare(
        `SELECT p.purge_job_id, p.memory_id, p.tombstone_epoch, p.status,
                p.attempts, t.principal_id, t.scope_kind, t.scope_id,
                t.revision_id, t.reason,
                (
                  SELECT s.actor_authority
                  FROM memory_status_events AS s
                  WHERE s.memory_id = p.memory_id
                    AND s.revision_id = t.revision_id
                    AND s.action = 'tombstone'
                    AND s.tombstone_epoch = p.tombstone_epoch
                  ORDER BY s.occurred_at DESC, s.status_event_id DESC
                  LIMIT 1
                ) AS actor_authority
         FROM purge_jobs AS p
         JOIN memory_tombstones AS t ON t.purge_job_id = p.purge_job_id
         WHERE p.purge_job_id = ?`,
      )
      .get(purgeJobId) as PurgeJobRow | undefined;
    if (job === undefined) {
      throw new StorageError("INVALID_INPUT");
    }
    return job;
  }

  #readMemory(memoryId: string): DeleteMemoryRow {
    const memory = this.#database
      .prepare(
        `SELECT memory_id, principal_id, scope_kind, scope_id, lifecycle,
                current_revision_id
         FROM memory_objects WHERE memory_id = ?`,
      )
      .get(memoryId) as DeleteMemoryRow | undefined;
    if (memory === undefined) {
      throw new StorageError("INVALID_INPUT");
    }
    return memory;
  }

  #validateDeleteTarget(
    command: ParsedMemoryDeleteCommand,
    memory: DeleteMemoryRow,
  ): void {
    const envelope = command.request.envelope;
    if (
      memory.principal_id !== envelope.actor_claim.principal_id ||
      !envelope.scopes.some(
        (scope) =>
          scopeKey(scope) === `${memory.scope_kind}:${memory.scope_id}`,
      )
    ) {
      throw new StorageError("INVALID_INPUT");
    }
    if (memory.current_revision_id !== envelope.expected_revision_id) {
      throw new StorageError("STALE_REVISION");
    }
  }

  #validateDeleteApproval(
    command: ParsedMemoryDeleteCommand,
    requestHash: string,
  ): void {
    const approval = command.approval;
    const approvalId = command.request.envelope.approval_id;
    if (
      approval === null ||
      approvalId === null ||
      !approvalGrantMatches(
        {
          approval_id: approvalId,
          principal_id:
            command.request.envelope.actor_claim.principal_id,
          tool: "memory_delete",
          safety_class: "destructive",
          scopes: command.request.envelope.scopes,
          request_hash: requestHash,
        },
        approval.grant,
        approval.verified_at,
      ) ||
      this.#database
        .prepare(
          "SELECT 1 FROM approval_consumptions WHERE approval_id = ?",
        )
        .get(approvalId) !== undefined
    ) {
      throw new StorageError("APPROVAL_INVALID");
    }
  }

  #consumeDeleteApproval(
    command: ParsedMemoryDeleteCommand,
    requestHash: string,
    result: MemoryDeleteResult,
  ): void {
    const approval = command.approval;
    if (approval === null) {
      throw new StorageError("APPROVAL_INVALID");
    }
    try {
      this.#database
        .prepare(
          `INSERT INTO approval_consumptions (
             approval_id, idempotency_key, request_hash, manifest_hash,
             principal_id, tool, scopes_json, consumed_at, receipt_id
           ) VALUES (?, ?, ?, ?, ?, 'memory_delete', ?, ?, ?)`,
        )
        .run(
          approval.grant.approval_id,
          command.request.envelope.idempotency_key,
          requestHash,
          approval.grant.manifest_hash,
          command.request.envelope.actor_claim.principal_id,
          canonicalJson(
            [...command.request.envelope.scopes].sort((left, right) =>
              scopeKey(left).localeCompare(scopeKey(right)),
            ),
          ),
          approval.verified_at,
          result.receipt.receipt_id,
        );
    } catch {
      throw new StorageError("APPROVAL_INVALID");
    }
  }

  #sealDelete(options: {
    command: ParsedMemoryDeleteCommand;
    requestHash: string;
    memory: DeleteMemoryRow;
    revisionId: string;
    tombstoneEpoch: number | null;
    purgeJobId: string | null;
    projectionJobs: string[];
  }): MemoryDeleteResult {
    const request = options.command.request;
    const hasEffect = options.tombstoneEpoch !== null;
    if (hasEffect) {
      this.#database
        .prepare(
          `UPDATE ledger_state
           SET ledger_epoch = ledger_epoch + 1, updated_at = ?
           WHERE singleton = 1`,
        )
        .run(request.envelope.requested_at);
    }
    const epoch = Number(
      (
        this.#database
          .prepare(
            "SELECT ledger_epoch FROM ledger_state WHERE singleton = 1",
          )
          .get() as { ledger_epoch: number }
      ).ledger_epoch,
    );
    const receipt = MutationReceiptSchema.parse(
      sealReceipt({
        schema_version: "1.0.0",
        receipt_id: stableIdentifier("receipt", {
          idempotency_key: request.envelope.idempotency_key,
          request_hash: options.requestHash,
        }),
        created_at: request.envelope.requested_at,
        state:
          options.projectionJobs.length > 0
            ? "projection_pending"
            : "durable",
        request_hash: options.requestHash,
        receipt_hash: `sha256:${"0".repeat(64)}`,
        kind: "mutation",
        idempotency_key: request.envelope.idempotency_key,
        affected_memory_ids: hasEffect ? [options.memory.memory_id] : [],
        affected_revision_ids: hasEffect ? [options.revisionId] : [],
        resulting_epoch: epoch,
        projection_jobs: options.projectionJobs,
        warnings: hasEffect ? [] : ["DRY_RUN"],
      }),
    );
    const result = MemoryDeleteResultSchema.parse({
      receipt,
      replayed: false,
      outcome: hasEffect ? "TOMBSTONED" : "DRY_RUN",
      memory_id: options.memory.memory_id,
      revision_id: options.revisionId,
      tombstone_epoch: options.tombstoneEpoch,
      purge_job_id: options.purgeJobId,
    });
    if (hasEffect) {
      this.#database
        .prepare(
          `INSERT INTO mutation_receipts (
             receipt_id, idempotency_key, request_hash, receipt_hash, state,
             resulting_epoch, receipt_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          receipt.receipt_id,
          receipt.idempotency_key,
          receipt.request_hash,
          receipt.receipt_hash,
          receipt.state,
          receipt.resulting_epoch,
          canonicalJson(receipt),
          receipt.created_at,
        );
      this.#database
        .prepare(
          `INSERT INTO idempotency_keys (
             idempotency_key, request_hash, receipt_id, created_at
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(
          receipt.idempotency_key,
          receipt.request_hash,
          receipt.receipt_id,
          receipt.created_at,
        );
      this.#database
        .prepare(
          `INSERT INTO receipt_access_scopes (
             receipt_id, receipt_kind, principal_id, scope_kind, scope_id,
             created_at
           ) VALUES (?, 'mutation', ?, ?, ?, ?)`,
        )
        .run(
          receipt.receipt_id,
          options.memory.principal_id,
          options.memory.scope_kind,
          options.memory.scope_id,
          receipt.created_at,
        );
      this.#database
        .prepare(
          `INSERT INTO governance_mutation_results (
             receipt_id, result_json, created_at
           ) VALUES (?, ?, ?)`,
        )
        .run(
          receipt.receipt_id,
          canonicalJson(result),
          receipt.created_at,
        );
    }
    return result;
  }

  #readDeleteMutation(
    idempotencyKey: string,
  ): ExistingDeleteMutation | undefined {
    return this.#database
      .prepare(
        `SELECT i.request_hash, r.receipt_json, g.result_json
         FROM idempotency_keys AS i
         JOIN mutation_receipts AS r ON r.receipt_id = i.receipt_id
         LEFT JOIN governance_mutation_results AS g
           ON g.receipt_id = r.receipt_id
         WHERE i.idempotency_key = ?`,
      )
      .get(idempotencyKey) as ExistingDeleteMutation | undefined;
  }

  #parseDeleteMutation(
    existing: ExistingDeleteMutation,
    requestHash: string,
  ): MemoryDeleteResult {
    if (
      existing.request_hash !== requestHash ||
      existing.result_json === null
    ) {
      throw new StorageError("CONFLICT");
    }
    const receipt = MutationReceiptSchema.parse(
      JSON.parse(existing.receipt_json) as unknown,
    );
    const result = MemoryDeleteResultSchema.parse(
      JSON.parse(existing.result_json) as unknown,
    );
    if (
      !receiptHashIsValid(receipt) ||
      result.receipt.receipt_hash !== receipt.receipt_hash
    ) {
      throw new StorageError("CORRUPTION");
    }
    return { ...result, replayed: true };
  }

  #insertInvalidation(memoryId: string, createdAt: string): string {
    const jobId = stableIdentifier("job", {
      kind: "fts_memory_invalidate",
      memory_id: memoryId,
      created_at: createdAt,
    });
    this.#database
      .prepare(
        `INSERT INTO outbox_jobs (
           job_id, kind, aggregate_id, status, attempts, available_at,
           created_at
         ) VALUES (?, 'fts_memory_invalidate', ?, 'pending', 0, ?, ?)`,
      )
      .run(jobId, memoryId, createdAt, createdAt);
    this.#database
      .prepare(
        `UPDATE projection_state
         SET status = 'pending', updated_at = ?, error_code = NULL
         WHERE projection_name = 'memory_fts'`,
      )
      .run(createdAt);
    return jobId;
  }

  #governedWrite<T>(operation: string, effect: () => T): T {
    return this.#database
      .transaction(() => {
        this.#database
          .prepare(
            `INSERT INTO governance_write_guard (
               singleton, operation, opened_at
             ) VALUES (1, ?, ?)`,
          )
          .run(operation, new Date().toISOString());
        try {
          return effect();
        } finally {
          this.#database
            .prepare(
              "DELETE FROM governance_write_guard WHERE singleton = 1",
            )
            .run();
        }
      })
      .immediate();
  }
}
