import {
  VectorEmbeddingEpochSchema,
  canonicalSha256,
  type VectorEmbeddingEpoch,
} from "@memo-graph/contracts";
import { z } from "zod";

import {
  VectorScopeProjector,
  type VectorProjectionDrainResult,
  type VectorProjectionRuntimeFactory,
  type VectorProjectionStorage,
} from "./projector.js";

type VectorRebuildStorage = VectorProjectionStorage & {
  registerVectorEmbeddingEpoch(input: {
    epoch: VectorEmbeddingEpoch;
    registered_at: string;
  }): Promise<unknown>;
  configureVectorProjection(input: {
    mode: "evaluating" | "enabled";
    epoch_id: string;
    configured_at: string;
  }): Promise<{
    checkpoints: unknown[];
    job_ids: string[];
  }>;
  vectorProjectionStatus(): Promise<{
    mode: "disabled" | "evaluating" | "enabled";
    epoch_id: string | null;
    scope_states: number;
    published_scopes: number;
    pending_scopes: number;
    degraded_scopes: number;
    outbox_pending: number;
  }>;
};

export type VectorFullRebuildResult = {
  status: "complete" | "degraded";
  embedding_epoch_id: string;
  activated: boolean;
  configured_scopes: number;
  published_scopes: number;
  rounds: number;
  published_jobs: number;
  stale_jobs: number;
  failed_jobs: number;
  manifest_hash: string;
};

function timestamp(base: string, offsetMs: number): string {
  const value = Date.parse(base);
  if (!Number.isFinite(value)) {
    throw new Error("vector rebuild timestamp is invalid");
  }
  return new Date(value + offsetMs).toISOString();
}

export class VectorFullRebuilder {
  readonly #storage: VectorRebuildStorage;
  readonly #projector: VectorScopeProjector;
  readonly #epoch: VectorEmbeddingEpoch;

  constructor(input: {
    storage: VectorRebuildStorage;
    dataRoot: string;
    modelRoot: string;
    epoch: VectorEmbeddingEpoch;
    runtimeFactory?: VectorProjectionRuntimeFactory;
    batchSize?: number;
  }) {
    this.#storage = input.storage;
    this.#epoch = VectorEmbeddingEpochSchema.parse(input.epoch);
    this.#projector = new VectorScopeProjector({
      storage: input.storage,
      dataRoot: input.dataRoot,
      modelRoot: input.modelRoot,
      epoch: this.#epoch,
      ...(input.runtimeFactory === undefined
        ? {}
        : { runtimeFactory: input.runtimeFactory }),
      ...(input.batchSize === undefined
        ? {}
        : { batchSize: input.batchSize }),
    });
  }

  async rebuild(input: {
    worker_id: string;
    started_at: string;
    activate: boolean;
    max_rounds?: number;
    limit_per_round?: number;
  }): Promise<VectorFullRebuildResult> {
    const workerId = z.string().trim().min(1).max(200)
      .parse(input.worker_id);
    const maxRounds = z.number().int().min(1).max(1_000)
      .parse(input.max_rounds ?? 100);
    const limit = z.number().int().min(1).max(100)
      .parse(input.limit_per_round ?? 10);
    await this.#storage.registerVectorEmbeddingEpoch({
      epoch: this.#epoch,
      registered_at: input.started_at,
    });
    const configured = await this.#storage.configureVectorProjection({
      mode: "evaluating",
      epoch_id: this.#epoch.epoch_id,
      configured_at: input.started_at,
    });
    const drains: VectorProjectionDrainResult[] = [];
    for (let round = 0; round < maxRounds; round += 1) {
      const roundBase = timestamp(
        input.started_at,
        (round + 1) * 120_000,
      );
      const drained = await this.#projector.drain({
        worker_id: workerId,
        claimed_at: roundBase,
        lease_expires_at: timestamp(roundBase, 60_000),
        completed_at: timestamp(roundBase, 5_000),
        retry_at: timestamp(roundBase, 90_000),
        limit,
      });
      if (drained.claimed === 0) {
        break;
      }
      drains.push(drained);
      if (drained.failed > 0) {
        break;
      }
    }
    let state = await this.#storage.vectorProjectionStatus();
    const complete =
      state.epoch_id === this.#epoch.epoch_id &&
      state.pending_scopes === 0 &&
      state.degraded_scopes === 0 &&
      state.outbox_pending === 0 &&
      state.published_scopes === state.scope_states;
    if (complete && input.activate) {
      await this.#storage.configureVectorProjection({
        mode: "enabled",
        epoch_id: this.#epoch.epoch_id,
        configured_at: timestamp(
          input.started_at,
          (drains.length + 2) * 120_000,
        ),
      });
      state = await this.#storage.vectorProjectionStatus();
    }
    const resultWithoutHash = {
      status: complete ? "complete" as const : "degraded" as const,
      embedding_epoch_id: this.#epoch.epoch_id,
      activated: complete && input.activate && state.mode === "enabled",
      configured_scopes: configured.checkpoints.length,
      published_scopes: state.published_scopes,
      rounds: drains.length,
      published_jobs: drains.reduce(
        (sum, drain) => sum + drain.published,
        0,
      ),
      stale_jobs: drains.reduce(
        (sum, drain) => sum + drain.stale,
        0,
      ),
      failed_jobs: drains.reduce(
        (sum, drain) => sum + drain.failed,
        0,
      ),
    };
    return {
      ...resultWithoutHash,
      manifest_hash: canonicalSha256(resultWithoutHash),
    };
  }
}
