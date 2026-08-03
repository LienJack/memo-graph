import {
  access,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildVectorEmbeddingEpoch,
} from "../../packages/contracts/src/index.js";
import {
  VectorFullRebuilder,
  VectorRuntimeError,
  VectorScopeProjector,
  vectorGenerationLayout,
} from "../../packages/vector-retrieval/src/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import {
  memoryCandidate,
  revisionCommand,
} from "../helpers/governance-examples.js";
import {
  InMemoryVectorRuntimeFactory,
} from "../helpers/in-memory-vector-runtime.js";
import { seedProjectionSources } from "../helpers/projection-examples.js";
import {
  VECTOR_NOW,
  VECTOR_SCOPE,
  qualifiedVectorEpoch,
  vectorHash,
} from "../helpers/vector-examples.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

async function fixture() {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "memo-graph-vector-rebuild-"),
  );
  roots.push(root);
  const storage = await SqliteStorageClient.open({ dataRoot: root });
  const sources = await seedProjectionSources(storage);
  const epoch = qualifiedVectorEpoch();
  await storage.registerVectorEmbeddingEpoch({
    epoch,
    registered_at: VECTOR_NOW,
  });
  await storage.configureVectorProjection({
    mode: "evaluating",
    epoch_id: epoch.epoch_id,
    configured_at: VECTOR_NOW,
  });
  const runtime = new InMemoryVectorRuntimeFactory();
  const projector = new VectorScopeProjector({
    storage,
    dataRoot: root,
    modelRoot: join(root, "models"),
    epoch,
    runtimeFactory: runtime.runtimeFactory(),
  });
  return { root, storage, sources, epoch, runtime, projector };
}

describe("vector projection rebuild and stale publication", () => {
  it("rejects a quarantine build when canonical truth changes before publication", async () => {
    const current = await fixture();
    try {
      const source = current.sources[0];
      current.runtime.onReplace = async () => {
        current.runtime.onReplace = undefined;
        await current.storage.applyMemoryRevision(
          revisionCommand({
            memoryId: source.memory_id,
            expectedRevisionId: source.revision_id,
            candidate: memoryCandidate({
              candidateId: "candidate_vector_concurrent",
              logicalKey: "projection.source.a",
              scope: VECTOR_SCOPE,
              text: "Canonical truth changed during vector build.",
              evidenceIds: ["evidence_projection_a"],
            }),
            idempotencyKey: "vector-concurrent-correction-0001",
          }),
        );
      };
      const result = await current.projector.drain({
        worker_id: "vector_stale_worker",
        claimed_at: "2026-07-29T06:00:01.000Z",
        lease_expires_at: "2026-07-29T06:01:00.000Z",
        completed_at: "2026-07-29T06:00:05.000Z",
        retry_at: "2026-07-29T06:01:05.000Z",
      });
      expect(result).toMatchObject({
        claimed: 1,
        published: 0,
        stale: 1,
        failed: 0,
      });
      const outcome = result.outcomes[0];
      if (outcome === undefined) {
        throw new Error("stale build outcome is missing");
      }
      const oldLayout = await vectorGenerationLayout({
        dataRoot: current.root,
        principalId: "user_local",
        scope: VECTOR_SCOPE,
        epochId: current.epoch.epoch_id,
        generationId: outcome.generation_id,
      });
      await expect(access(oldLayout.activeRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        current.storage.vectorProjectionCheckpoint({
          principal_id: "user_local",
          scope: VECTOR_SCOPE,
        }),
      ).resolves.toMatchObject({
        state: "pending",
        active_generation_id: null,
      });
    } finally {
      await current.storage.close();
    }
  });

  it("rebuilds a deleted active generation to the same logical snapshot", async () => {
    const current = await fixture();
    try {
      await current.projector.drain({
        worker_id: "vector_initial_worker",
        claimed_at: "2026-07-29T06:00:01.000Z",
        lease_expires_at: "2026-07-29T06:01:00.000Z",
        completed_at: "2026-07-29T06:00:05.000Z",
        retry_at: "2026-07-29T06:01:05.000Z",
      });
      const first = await current.storage.vectorProjectionCheckpoint({
        principal_id: "user_local",
        scope: VECTOR_SCOPE,
      });
      const layout = await vectorGenerationLayout({
        dataRoot: current.root,
        principalId: "user_local",
        scope: VECTOR_SCOPE,
        epochId: current.epoch.epoch_id,
        generationId: first.desired_generation_id,
      });
      const firstSnapshot = JSON.parse(
        await readFile(
          join(layout.activeRoot, "vector.snapshot.json"),
          "utf8",
        ),
      );
      await rm(layout.activeRoot, { recursive: true, force: true });
      await current.storage.markVectorRestoreDegraded({
        restored_at: "2026-07-29T06:02:00.000Z",
      });
      const rebuilt = await current.projector.drain({
        worker_id: "vector_rebuild_worker",
        claimed_at: "2026-07-29T06:02:01.000Z",
        lease_expires_at: "2026-07-29T06:03:00.000Z",
        completed_at: "2026-07-29T06:02:05.000Z",
        retry_at: "2026-07-29T06:03:05.000Z",
      });
      expect(rebuilt).toMatchObject({
        claimed: 1,
        published: 1,
        stale: 0,
        failed: 0,
      });
      const secondSnapshot = JSON.parse(
        await readFile(
          join(layout.activeRoot, "vector.snapshot.json"),
          "utf8",
        ),
      );
      expect(secondSnapshot.logical_digest).toBe(
        firstSnapshot.logical_digest,
      );
      expect(secondSnapshot.records).toEqual(firstSnapshot.records);
    } finally {
      await current.storage.close();
    }
  });

  it("activates an epoch only after the complete scope manifest publishes", async () => {
    const current = await fixture();
    try {
      const rebuilder = new VectorFullRebuilder({
        storage: current.storage,
        dataRoot: current.root,
        modelRoot: join(current.root, "models"),
        epoch: current.epoch,
        runtimeFactory: current.runtime.runtimeFactory(),
      });
      const rebuilt = await rebuilder.rebuild({
        worker_id: "vector_full_rebuild_worker",
        started_at: VECTOR_NOW,
        activate: true,
      });
      expect(rebuilt).toMatchObject({
        status: "complete",
        activated: true,
        configured_scopes: 1,
        published_scopes: 1,
        published_jobs: 1,
        stale_jobs: 0,
        failed_jobs: 0,
      });
      await expect(
        current.storage.vectorProjectionStatus(),
      ).resolves.toMatchObject({
        mode: "enabled",
        pending_scopes: 0,
        degraded_scopes: 0,
        outbox_pending: 0,
      });
    } finally {
      await current.storage.close();
    }
  });

  it("keeps one complete old epoch after interrupted migration and atomically replaces it on resume", async () => {
    const current = await fixture();
    try {
      const initial = await new VectorFullRebuilder({
        storage: current.storage,
        dataRoot: current.root,
        modelRoot: join(current.root, "models"),
        epoch: current.epoch,
        runtimeFactory: current.runtime.runtimeFactory(),
      }).rebuild({
        worker_id: "vector_epoch_initial",
        started_at: VECTOR_NOW,
        activate: true,
      });
      expect(initial).toMatchObject({
        status: "complete",
        activated: true,
      });
      const oldCheckpoint =
        await current.storage.vectorProjectionCheckpoint({
          principal_id: "user_local",
          scope: VECTOR_SCOPE,
        });
      const oldLayout = await vectorGenerationLayout({
        dataRoot: current.root,
        principalId: "user_local",
        scope: VECTOR_SCOPE,
        epochId: current.epoch.epoch_id,
        generationId: oldCheckpoint.active_generation_id ?? "",
      });
      const epochInput = {
        schema_version: current.epoch.schema_version,
        runtime: current.epoch.runtime,
        sqlite_binding: current.epoch.sqlite_binding,
        model: current.epoch.model,
        index: current.epoch.index,
        projection_schema_version:
          current.epoch.projection_schema_version,
        dependency_lock_hash:
          current.epoch.dependency_lock_hash,
      };
      const nextEpoch = buildVectorEmbeddingEpoch({
        ...epochInput,
        dependency_lock_hash: vectorHash("f"),
      });
      const workingFactory = current.runtime.runtimeFactory();
      const interrupted = await new VectorFullRebuilder({
        storage: current.storage,
        dataRoot: current.root,
        modelRoot: join(current.root, "models"),
        epoch: nextEpoch,
        runtimeFactory: {
          open: async (input) => {
            const runtime = await workingFactory.open(input);
            return {
              ...runtime,
              replaceScope: async () => {
                throw new VectorRuntimeError("PROCESS_EXIT", {
                  retryable: true,
                });
              },
            };
          },
        },
      }).rebuild({
        worker_id: "vector_epoch_interrupted",
        started_at: "2026-07-29T08:00:00.000Z",
        activate: true,
        max_rounds: 1,
      });
      expect(interrupted).toMatchObject({
        status: "degraded",
        activated: false,
        failed_jobs: 1,
      });
      const degraded =
        await current.storage.vectorProjectionCheckpoint({
          principal_id: "user_local",
          scope: VECTOR_SCOPE,
        });
      expect(degraded).toMatchObject({
        desired_epoch_id: nextEpoch.epoch_id,
        active_epoch_id: current.epoch.epoch_id,
        active_generation_id: oldCheckpoint.active_generation_id,
        state: "degraded",
        failure_category: "PROCESS_EXIT",
      });
      await expect(access(oldLayout.activeRoot)).resolves.toBeUndefined();
      const failedLayout = await vectorGenerationLayout({
        dataRoot: current.root,
        principalId: "user_local",
        scope: VECTOR_SCOPE,
        epochId: nextEpoch.epoch_id,
        generationId: degraded.desired_generation_id,
      });
      await expect(access(failedLayout.activeRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });

      const resumed = await new VectorFullRebuilder({
        storage: current.storage,
        dataRoot: current.root,
        modelRoot: join(current.root, "models"),
        epoch: nextEpoch,
        runtimeFactory: workingFactory,
      }).rebuild({
        worker_id: "vector_epoch_resumed",
        started_at: "2026-07-29T08:10:00.000Z",
        activate: true,
      });
      expect(resumed, JSON.stringify(resumed)).toMatchObject({
        status: "complete",
        activated: true,
        failed_jobs: 0,
      });
      await expect(
        current.storage.vectorProjectionCheckpoint({
          principal_id: "user_local",
          scope: VECTOR_SCOPE,
        }),
      ).resolves.toMatchObject({
        desired_epoch_id: nextEpoch.epoch_id,
        active_epoch_id: nextEpoch.epoch_id,
        state: "published",
        failure_category: null,
      });
      await expect(access(oldLayout.generationRoot))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(failedLayout.activeRoot))
        .resolves.toBeUndefined();
    } finally {
      await current.storage.close();
    }
  });

  it("rebuilds when an epoch cycles from A to B and back to A", async () => {
    const current = await fixture();
    try {
      const epochInput = {
        schema_version: current.epoch.schema_version,
        runtime: current.epoch.runtime,
        sqlite_binding: current.epoch.sqlite_binding,
        model: current.epoch.model,
        index: current.epoch.index,
        projection_schema_version:
          current.epoch.projection_schema_version,
        dependency_lock_hash:
          current.epoch.dependency_lock_hash,
      };
      const nextEpoch = buildVectorEmbeddingEpoch({
        ...epochInput,
        dependency_lock_hash: vectorHash("f"),
      });
      const rebuild = async (
        epoch: typeof current.epoch,
        workerId: string,
        startedAt: string,
      ) =>
        new VectorFullRebuilder({
          storage: current.storage,
          dataRoot: current.root,
          modelRoot: join(current.root, "models"),
          epoch,
          runtimeFactory: current.runtime.runtimeFactory(),
        }).rebuild({
          worker_id: workerId,
          started_at: startedAt,
          activate: true,
        });

      await expect(
        rebuild(
          current.epoch,
          "vector_epoch_cycle_a1",
          "2026-07-29T09:00:00.000Z",
        ),
      ).resolves.toMatchObject({
        status: "complete",
        activated: true,
        published_jobs: 1,
      });
      await expect(
        rebuild(
          nextEpoch,
          "vector_epoch_cycle_b",
          "2026-07-29T10:00:00.000Z",
        ),
      ).resolves.toMatchObject({
        status: "complete",
        activated: true,
        published_jobs: 1,
      });
      await expect(
        rebuild(
          current.epoch,
          "vector_epoch_cycle_a2",
          "2026-07-29T11:00:00.000Z",
        ),
      ).resolves.toMatchObject({
        status: "complete",
        activated: true,
        published_jobs: 1,
      });
      await expect(
        current.storage.vectorProjectionCheckpoint({
          principal_id: "user_local",
          scope: VECTOR_SCOPE,
        }),
      ).resolves.toMatchObject({
        desired_epoch_id: current.epoch.epoch_id,
        active_epoch_id: current.epoch.epoch_id,
        state: "published",
      });
    } finally {
      await current.storage.close();
    }
  });

  it("preserves a committed active generation when the apply acknowledgement is lost", async () => {
    const current = await fixture();
    try {
      const storage = current.storage;
      const projector = new VectorScopeProjector({
        storage: {
          claimVectorProjectionJobs: (input) =>
            storage.claimVectorProjectionJobs(input),
          vectorProjectionCheckpoint: (input) =>
            storage.vectorProjectionCheckpoint(input),
          listProjectionSources: (input) =>
            storage.listProjectionSources(input),
          applyVectorProjectionJob: async (input) => {
            await storage.applyVectorProjectionJob(input);
            throw new Error("simulated acknowledgement loss");
          },
          staleVectorProjectionJob: (input) =>
            storage.staleVectorProjectionJob(input),
          failVectorProjectionJob: (input) =>
            storage.failVectorProjectionJob(input),
        },
        dataRoot: current.root,
        modelRoot: join(current.root, "models"),
        epoch: current.epoch,
        runtimeFactory: current.runtime.runtimeFactory(),
      });

      const result = await projector.drain({
        worker_id: "vector_ack_loss_worker",
        claimed_at: "2026-07-29T06:00:01.000Z",
        lease_expires_at: "2026-07-29T06:01:00.000Z",
        completed_at: "2026-07-29T06:00:05.000Z",
        retry_at: "2026-07-29T06:01:05.000Z",
      });
      expect(result).toMatchObject({
        claimed: 1,
        published: 1,
        stale: 0,
        failed: 0,
      });
      const checkpoint =
        await current.storage.vectorProjectionCheckpoint({
          principal_id: "user_local",
          scope: VECTOR_SCOPE,
        });
      expect(checkpoint).toMatchObject({
        state: "published",
        active_epoch_id: current.epoch.epoch_id,
        logical_digest: result.outcomes[0]?.logical_digest,
      });
      const layout = await vectorGenerationLayout({
        dataRoot: current.root,
        principalId: "user_local",
        scope: VECTOR_SCOPE,
        epochId: current.epoch.epoch_id,
        generationId: checkpoint.active_generation_id ?? "",
      });
      await expect(access(layout.activeRoot)).resolves.toBeUndefined();
    } finally {
      await current.storage.close();
    }
  });

  it("keeps a failed quarantine inactive and publishes only a later clean retry", async () => {
    const current = await fixture();
    try {
      const workingFactory = current.runtime.runtimeFactory();
      const failingProjector = new VectorScopeProjector({
        storage: current.storage,
        dataRoot: current.root,
        modelRoot: join(current.root, "models"),
        epoch: current.epoch,
        runtimeFactory: {
          open: async (input) => {
            const runtime = await workingFactory.open(input);
            return {
              ...runtime,
              replaceScope: async () => {
                throw new VectorRuntimeError("PROCESS_EXIT", {
                  retryable: true,
                });
              },
            };
          },
        },
      });
      const failed = await failingProjector.drain({
        worker_id: "vector_crash_worker",
        claimed_at: "2026-07-29T06:00:01.000Z",
        lease_expires_at: "2026-07-29T06:01:00.000Z",
        completed_at: "2026-07-29T06:00:05.000Z",
        retry_at: "2026-07-29T06:02:00.000Z",
      });
      expect(failed).toMatchObject({
        claimed: 1,
        published: 0,
        stale: 0,
        failed: 1,
      });
      const degraded = await current.storage.vectorProjectionCheckpoint({
        principal_id: "user_local",
        scope: VECTOR_SCOPE,
      });
      const layout = await vectorGenerationLayout({
        dataRoot: current.root,
        principalId: "user_local",
        scope: VECTOR_SCOPE,
        epochId: current.epoch.epoch_id,
        generationId: degraded.desired_generation_id,
      });
      await expect(access(layout.activeRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(access(layout.quarantineRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(degraded).toMatchObject({
        state: "degraded",
        failure_category: "PROCESS_EXIT",
      });

      const recovered = await current.projector.drain({
        worker_id: "vector_recovery_worker",
        claimed_at: "2026-07-29T06:02:01.000Z",
        lease_expires_at: "2026-07-29T06:03:00.000Z",
        completed_at: "2026-07-29T06:02:05.000Z",
        retry_at: "2026-07-29T06:03:05.000Z",
      });
      expect(recovered).toMatchObject({
        claimed: 1,
        published: 1,
        stale: 0,
        failed: 0,
      });
      await expect(access(layout.activeRoot)).resolves.toBeUndefined();
      await expect(
        current.storage.vectorProjectionCheckpoint({
          principal_id: "user_local",
          scope: VECTOR_SCOPE,
        }),
      ).resolves.toMatchObject({
        state: "published",
        failure_category: null,
      });
    } finally {
      await current.storage.close();
    }
  });
});
