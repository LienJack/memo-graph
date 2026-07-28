import {
  ProjectionRevisionSchema,
  canonicalJson,
  canonicalSha256,
  type ProjectionRevision,
  type Scope,
} from "@memo-graph/contracts";
import type {
  ProjectionOutboxJob,
  SqliteStorageClient,
} from "@memo-graph/storage-sqlite";

import {
  buildDeterministicProjections,
  emptyProjectionFrontier,
  projectionStructuralDigest,
  type ProjectionPolicyInput,
} from "./projection-policy.js";

type Projector = (input: ProjectionPolicyInput) => ProjectionRevision[];

export type ProjectionDrainResult = {
  claimed: number;
  processed: number;
  failed: number;
  remaining: number;
};

export type ProjectionRebuildResult = {
  applied: boolean;
  frontier: {
    ledger_epoch: number;
    tombstone_epoch: number;
    projection_epoch: number;
  };
  projections: ProjectionRevision[];
  structural_digest: `sha256:${string}`;
};

type ReconcileResult = {
  applied: boolean;
  projections: ProjectionRevision[];
};

function scopeKey(scope: Scope): string {
  return `${scope.kind}:${scope.id}`;
}

function logicalStructure(projections: ProjectionRevision[]): string {
  return canonicalJson(
    [...projections]
      .map((projection) => ({
        projection_id: projection.projection_id,
        projection_type: projection.projection_type,
        content_hash: projection.content_hash,
        source_revision_ids: projection.source_revisions
          .map((source) => source.revision_id)
          .sort(),
        relation:
          projection.payload?.kind === "relation"
            ? projection.payload
            : null,
      }))
      .sort((left, right) =>
        left.projection_id.localeCompare(right.projection_id)
      ),
  );
}

export class ConsolidationService {
  readonly #storage: SqliteStorageClient;
  readonly #projector: Projector;

  constructor(options: {
    storage: SqliteStorageClient;
    projector?: Projector;
  }) {
    this.#storage = options.storage;
    this.#projector = options.projector ?? buildDeterministicProjections;
  }

  async drain(options: {
    worker_id: string;
    claimed_at: string;
    lease_expires_at: string;
    limit?: number;
    include_sensitive?: boolean;
  }): Promise<ProjectionDrainResult> {
    const claim = await this.#storage.claimProjectionJobs({
      worker_id: options.worker_id,
      claimed_at: options.claimed_at,
      lease_expires_at: options.lease_expires_at,
      limit: options.limit ?? 100,
    });
    const refreshGroups = new Map<string, ProjectionOutboxJob[]>();
    for (const job of claim.jobs) {
      const key = `${job.principal_id}:${scopeKey(job.scope)}`;
      refreshGroups.set(key, [...(refreshGroups.get(key) ?? []), job]);
    }

    let processed = 0;
    let failed = 0;
    const retryAt = new Date(
      Date.parse(options.claimed_at) + 1_000,
    ).toISOString();

    for (const jobs of refreshGroups.values()) {
      const ordered = [...jobs].sort((left, right) =>
        left.job_id.localeCompare(right.job_id)
      );
      const primary = ordered[0];
      if (primary === undefined) {
        continue;
      }
      try {
        const reconciled = await this.#reconcile({
          principal_id: primary.principal_id,
          scope: primary.scope,
          as_of: options.claimed_at,
          include_sensitive: options.include_sensitive ?? false,
          idempotency_key: `projection-batch:${canonicalSha256({
            jobs: ordered.map((job) => job.job_id),
            claimed_at: options.claimed_at,
          }).slice("sha256:".length, 48)}`,
          claimed_job: {
            job_id: primary.job_id,
            worker_id: options.worker_id,
          },
        });
        if (!reconciled.applied) {
          await this.#storage.completeProjectionJob({
            job_id: primary.job_id,
            worker_id: options.worker_id,
            completed_at: options.claimed_at,
          });
        }
        processed += 1;
        for (const job of ordered.slice(1)) {
          await this.#storage.completeProjectionJob({
            job_id: job.job_id,
            worker_id: options.worker_id,
            completed_at: options.claimed_at,
          });
          processed += 1;
        }
      } catch {
        for (const job of ordered) {
          try {
            await this.#storage.failProjectionJob({
              job_id: job.job_id,
              worker_id: options.worker_id,
              error_code: "PROJECTION_RECONCILE_FAILED",
              retry_at: retryAt,
              failed_at: options.claimed_at,
            });
          } catch {
            // A successfully applied primary job is already durable.
          }
          failed += 1;
        }
      }
    }

    return {
      claimed: claim.jobs.length,
      processed,
      failed,
      remaining: (await this.#storage.health()).counts
        .projection_outbox_pending,
    };
  }

  async rebuild(options: {
    principal_id: string;
    scope: Scope;
    as_of: string;
    include_sensitive?: boolean;
    idempotency_key: string;
    rebuild_receipt_id: string;
  }): Promise<ProjectionRebuildResult> {
    const reconciled = await this.#reconcile({
      principal_id: options.principal_id,
      scope: options.scope,
      as_of: options.as_of,
      include_sensitive: options.include_sensitive ?? false,
      idempotency_key: options.idempotency_key,
    });
    const query = await this.#storage.queryProjections({
      principal_id: options.principal_id,
      scope: options.scope,
      as_of: options.as_of,
      limit: 1_000,
    });
    const digest = projectionStructuralDigest(query.items);
    await this.#storage.recordProjectionRebuild({
      rebuild_receipt_id: options.rebuild_receipt_id,
      mode: "full",
      projection_epoch: query.frontier.projection_epoch,
      structural_digest: digest,
      projection_count: query.items.length,
      relation_count: query.items.filter(
        (projection) => projection.projection_type === "relation",
      ).length,
      completed_at: options.as_of,
    });
    return {
      applied: reconciled.applied,
      frontier: {
        ledger_epoch: query.frontier.ledger_epoch,
        tombstone_epoch: query.frontier.tombstone_epoch,
        projection_epoch: query.frontier.projection_epoch,
      },
      projections: query.items,
      structural_digest: digest,
    };
  }

  async #reconcile(options: {
    principal_id: string;
    scope: Scope;
    as_of: string;
    include_sensitive: boolean;
    idempotency_key: string;
    claimed_job?: { job_id: string; worker_id: string };
  }): Promise<ReconcileResult> {
    const sources = await this.#storage.listProjectionSources({
      principal_id: options.principal_id,
      scope: options.scope,
      as_of: options.as_of,
      include_sensitive: options.include_sensitive,
      context_scope: options.scope,
      limit: 1_000,
    });
    const health = await this.#storage.health();
    const projectionEpoch =
      health.projection_frontier.projection_epoch + 1;
    const desired = this.#projector({
      principal_id: options.principal_id,
      scope: options.scope,
      ledger_epoch: sources.ledger_epoch,
      tombstone_epoch: sources.tombstone_epoch,
      projection_epoch: projectionEpoch,
      sources: sources.items,
    });
    const current = await this.#storage.queryProjections({
      principal_id: options.principal_id,
      scope: options.scope,
      include_inactive: true,
      as_of: options.as_of,
      limit: 1_000,
    });
    const active = await this.#storage.queryProjections({
      principal_id: options.principal_id,
      scope: options.scope,
      as_of: options.as_of,
      limit: 1_000,
    });
    const currentAtCanonicalFrontier =
      health.layered_projection_state === "ready" &&
      health.projection_frontier.ledger_epoch === sources.ledger_epoch &&
      health.projection_frontier.tombstone_epoch ===
        sources.tombstone_epoch &&
      active.items.every(
        (projection) =>
          projection.frontier.ledger_epoch === sources.ledger_epoch &&
          projection.frontier.tombstone_epoch ===
            sources.tombstone_epoch,
      ) &&
      logicalStructure(active.items) === logicalStructure(desired);
    if (currentAtCanonicalFrontier) {
      return { applied: false, projections: active.items };
    }

    const currentByProjectionId = new Map(
      current.items.map((projection) => [
        projection.projection_id,
        projection,
      ]),
    );
    const revisions = desired.map((projection) => {
      const predecessor = currentByProjectionId.get(
        projection.projection_id,
      );
      if (predecessor === undefined) {
        return projection;
      }
      return ProjectionRevisionSchema.parse({
        ...projection,
        revision: predecessor.revision + 1,
        supersedes_projection_revision_id:
          predecessor.projection_revision_id,
      });
    });
    const frontier =
      revisions[0]?.frontier ??
      emptyProjectionFrontier({
        ledger_epoch: sources.ledger_epoch,
        tombstone_epoch: sources.tombstone_epoch,
        projection_epoch: projectionEpoch,
      });

    if (revisions.length === 0 && active.items.length > 0) {
      await this.#storage.invalidateProjectionDescendants({
        source_revision_ids: [
          ...new Set(
            active.items.flatMap((projection) =>
              projection.source_revisions.map(
                (source) => source.revision_id,
              )
            ),
          ),
        ],
        reason: "No canonical source remains eligible for the projection.",
        invalidated_at: options.as_of,
      });
    }

    await this.#storage.applyProjectionBatch({
      idempotency_key: options.idempotency_key,
      expected_projection_epoch:
        health.projection_frontier.projection_epoch,
      frontier,
      projections: revisions,
      retire_projection_revision_ids:
        revisions.length === 0
          ? []
          : current.items.map(
              (projection) => projection.projection_revision_id,
            ),
      applied_at: options.as_of,
      ...(options.claimed_job === undefined
        ? {}
        : { claimed_job: options.claimed_job }),
    });
    return {
      applied: true,
      projections: (
        await this.#storage.queryProjections({
          principal_id: options.principal_id,
          scope: options.scope,
          as_of: options.as_of,
          limit: 1_000,
        })
      ).items,
    };
  }
}
