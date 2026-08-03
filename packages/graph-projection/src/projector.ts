import { performance } from "node:perf_hooks";

import {
  GraphDeliveryReceiptSchema,
  canonicalJson,
  canonicalSha256,
  type GraphDeliveryReceipt,
  type GraphFailureCode,
  type GraphScopeSnapshot,
} from "@memo-graph/contracts";
import {
  StorageError,
  type GraphProjectionJobResult,
  type GraphProjectionOutboxJob,
  type SqliteStorageClient,
} from "@memo-graph/storage-sqlite";
import { z } from "zod";

import {
  GraphStoreError,
  type GraphStore,
} from "./graph-store.js";

const ProjectorOptionsSchema = z
  .object({
    worker_id: z.string().trim().min(1).max(200),
    lease_ms: z.number().int().min(1_000).max(15 * 60_000),
    retry_delay_ms: z.number().int().min(0).max(15 * 60_000),
    claim_limit: z.number().int().min(1).max(100),
    max_jobs_per_drain: z.number().int().min(1).max(1_000),
  })
  .strict();

const GraphProjectionDrainResultSchema = z
  .object({
    claimed: z.number().int().nonnegative(),
    applied: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    stale: z.number().int().nonnegative(),
    abandoned: z.number().int().nonnegative(),
    job_ids: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.applied + value.failed + value.stale + value.abandoned !==
      value.claimed
    ) {
      context.addIssue({
        code: "custom",
        path: ["claimed"],
        message: "graph projector outcomes must partition claimed work",
      });
    }
  });

export type GraphProjectionDrainResult = z.infer<
  typeof GraphProjectionDrainResultSchema
>;

export type PreparedGraphProjection = {
  job: GraphProjectionOutboxJob & {
    target_frontier: NonNullable<
      GraphProjectionOutboxJob["target_frontier"]
    >;
    expected_logical_digest: string;
    lease_token: string;
  };
  snapshot: GraphScopeSnapshot;
  receipt: GraphDeliveryReceipt;
  worker_id: string;
};

export type GraphProjectorStorage = Pick<
  SqliteStorageClient,
  | "claimGraphProjectionJobs"
  | "graphProjectionCheckpoint"
  | "graphScopeSnapshot"
  | "applyGraphProjectionJob"
  | "failGraphProjectionJob"
>;

function asUtcTimestamp(date: Date): string {
  return date.toISOString();
}

function failureCode(error: unknown): GraphFailureCode {
  if (error instanceof GraphStoreError) {
    return error.code;
  }
  if (
    error instanceof StorageError &&
    (error.code === "STALE_PROJECTION_FRONTIER" ||
      error.code === "CONFLICT")
  ) {
    return "GRAPH_SCOPE_STALE";
  }
  return "GRAPH_UNKNOWN_WORK";
}

function exactJob(
  input: GraphProjectionOutboxJob,
): PreparedGraphProjection["job"] {
  if (
    input.target_frontier === null ||
    input.expected_logical_digest === null ||
    input.lease_token === null
  ) {
    throw new GraphStoreError("GRAPH_SCOPE_STALE", {
      retryable: true,
    });
  }
  return {
    ...input,
    target_frontier: input.target_frontier,
    expected_logical_digest: input.expected_logical_digest,
    lease_token: input.lease_token,
  };
}

function receiptId(options: {
  job: GraphProjectionOutboxJob;
  status: GraphDeliveryReceipt["status"];
}): string {
  return `graph-receipt:${canonicalSha256({
    job_id: options.job.job_id,
    attempt: options.job.attempts,
    status: options.status,
  }).slice("sha256:".length, 55)}`;
}

export class ExactScopeGraphProjector {
  readonly #storage: GraphProjectorStorage;
  readonly #store: GraphStore;
  readonly #options: z.infer<typeof ProjectorOptionsSchema>;
  readonly #clock: () => Date;

  constructor(options: {
    storage: GraphProjectorStorage;
    store: GraphStore;
    workerId: string;
    leaseMs?: number;
    retryDelayMs?: number;
    claimLimit?: number;
    maxJobsPerDrain?: number;
    clock?: () => Date;
  }) {
    this.#storage = options.storage;
    this.#store = options.store;
    this.#options = ProjectorOptionsSchema.parse({
      worker_id: options.workerId,
      lease_ms: options.leaseMs ?? 5 * 60_000,
      retry_delay_ms: options.retryDelayMs ?? 1_000,
      claim_limit: options.claimLimit ?? 10,
      max_jobs_per_drain: options.maxJobsPerDrain ?? 100,
    });
    this.#clock = options.clock ?? (() => new Date());
  }

  async claim(
    operations: Array<"scope_replace" | "full_rebuild"> = [
      "scope_replace",
    ],
  ): Promise<GraphProjectionOutboxJob[]> {
    const claimedAt = this.#clock();
    return (
      await this.#storage.claimGraphProjectionJobs({
        worker_id: this.#options.worker_id,
        claimed_at: asUtcTimestamp(claimedAt),
        lease_expires_at: asUtcTimestamp(
          new Date(claimedAt.getTime() + this.#options.lease_ms),
        ),
        operations,
        limit: this.#options.claim_limit,
      })
    ).jobs;
  }

  async prepare(
    input: GraphProjectionOutboxJob,
  ): Promise<PreparedGraphProjection> {
    const job = exactJob(input);
    const startedAt = performance.now();
    const checkpoint = await this.#storage.graphProjectionCheckpoint({
      backend: job.backend,
      principal_id: job.principal_id,
      scope: job.scope,
    });
    if (
      checkpoint.frontier === null ||
      checkpoint.logical_digest !== job.expected_logical_digest ||
      canonicalJson(checkpoint.frontier) !==
        canonicalJson(job.target_frontier)
    ) {
      throw new GraphStoreError("GRAPH_SCOPE_STALE", {
        retryable: true,
      });
    }
    const { snapshot } = await this.#storage.graphScopeSnapshot({
      backend: job.backend,
      principal_id: job.principal_id,
      scope: job.scope,
    });
    if (
      snapshot.logical_digest !== job.expected_logical_digest ||
      canonicalJson(snapshot.frontier) !==
        canonicalJson(job.target_frontier)
    ) {
      throw new GraphStoreError("GRAPH_SCOPE_STALE", {
        retryable: true,
      });
    }

    const written = await this.#store.replaceScope(snapshot);
    const readBack = await this.#store.readScopeSnapshot({
      principal_id: job.principal_id,
      scope: job.scope,
    });
    if (
      written.logical_digest !== snapshot.logical_digest ||
      readBack?.logical_digest !== snapshot.logical_digest ||
      canonicalJson(readBack) !== canonicalJson(snapshot)
    ) {
      throw new GraphStoreError("GRAPH_DIGEST_MISMATCH");
    }
    const health = await this.#store.health();
    if (
      health.status !== "ready" ||
      health.backend_identity === null
    ) {
      throw new GraphStoreError(
        health.last_failure ?? "GRAPH_PROCESS_START_FAILED",
        { retryable: true },
      );
    }
    const completedAt = asUtcTimestamp(this.#clock());
    return {
      job,
      snapshot,
      worker_id: this.#options.worker_id,
      receipt: GraphDeliveryReceiptSchema.parse({
        schema_version: "1.0.0",
        receipt_id: receiptId({ job, status: "applied" }),
        job_id: job.job_id,
        operation: job.operation,
        backend: job.backend,
        principal_id: job.principal_id,
        scope: job.scope,
        status: "applied",
        previous_frontier: null,
        resulting_frontier: job.target_frontier,
        logical_digest: job.expected_logical_digest,
        backend_identity: health.backend_identity,
        node_count: snapshot.nodes.length,
        edge_count: snapshot.edges.length,
        duration_ms: Math.max(0, performance.now() - startedAt),
        completed_at: completedAt,
        failure_code: null,
      }),
    };
  }

  async commit(
    prepared: PreparedGraphProjection,
  ): Promise<GraphProjectionJobResult> {
    return this.#storage.applyGraphProjectionJob({
      job_id: prepared.job.job_id,
      worker_id: prepared.worker_id,
      lease_token: prepared.job.lease_token,
      receipt: prepared.receipt,
    });
  }

  async project(
    job: GraphProjectionOutboxJob,
  ): Promise<
    | { outcome: "applied"; result: GraphProjectionJobResult }
    | { outcome: "failed" | "stale" | "abandoned"; code: GraphFailureCode }
  > {
    const startedAt = performance.now();
    try {
      return {
        outcome: "applied",
        result: await this.commit(await this.prepare(job)),
      };
    } catch (error) {
      const code = failureCode(error);
      const exact = (() => {
        try {
          return exactJob(job);
        } catch {
          return null;
        }
      })();
      if (exact === null) {
        return { outcome: "abandoned", code };
      }
      const completedAt = this.#clock();
      const status = code === "GRAPH_SCOPE_STALE" ? "stale" : "failed";
      const receipt = GraphDeliveryReceiptSchema.parse({
        schema_version: "1.0.0",
        receipt_id: receiptId({ job, status }),
        job_id: job.job_id,
        operation: job.operation,
        backend: job.backend,
        principal_id: job.principal_id,
        scope: job.scope,
        status,
        previous_frontier: job.target_frontier,
        resulting_frontier: null,
        logical_digest: null,
        backend_identity: null,
        node_count: 0,
        edge_count: 0,
        duration_ms: Math.max(0, performance.now() - startedAt),
        completed_at: asUtcTimestamp(completedAt),
        failure_code: code,
      });
      try {
        await this.#storage.failGraphProjectionJob({
          job_id: job.job_id,
          worker_id: this.#options.worker_id,
          lease_token: exact.lease_token,
          retry_at: asUtcTimestamp(
            new Date(
              completedAt.getTime() + this.#options.retry_delay_ms,
            ),
          ),
          receipt,
        });
        return { outcome: status, code };
      } catch (failureError) {
        if (
          failureError instanceof StorageError &&
          (failureError.code === "CONFLICT" ||
            failureError.code === "STALE_PROJECTION_FRONTIER")
        ) {
          return { outcome: "abandoned", code: "GRAPH_SCOPE_STALE" };
        }
        throw failureError;
      }
    }
  }

  async drain(): Promise<GraphProjectionDrainResult> {
    const outcomes: GraphProjectionDrainResult = {
      claimed: 0,
      applied: 0,
      failed: 0,
      stale: 0,
      abandoned: 0,
      job_ids: [],
    };
    while (outcomes.claimed < this.#options.max_jobs_per_drain) {
      const jobs = await this.claim(["scope_replace"]);
      if (jobs.length === 0) {
        break;
      }
      for (const job of jobs) {
        if (outcomes.claimed >= this.#options.max_jobs_per_drain) {
          break;
        }
        outcomes.claimed += 1;
        outcomes.job_ids.push(job.job_id);
        const result = await this.project(job);
        outcomes[result.outcome] += 1;
      }
    }
    outcomes.job_ids.sort();
    return GraphProjectionDrainResultSchema.parse(outcomes);
  }
}
