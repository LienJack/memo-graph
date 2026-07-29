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

import { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import {
  VectorScopeProjector,
  vectorGenerationLayout,
} from "../../packages/vector-retrieval/src/index.js";
import {
  InMemoryVectorRuntimeFactory,
} from "../helpers/in-memory-vector-runtime.js";
import { seedProjectionSources } from "../helpers/projection-examples.js";
import {
  VECTOR_LATER,
  VECTOR_NOW,
  VECTOR_SCOPE,
  qualifiedVectorEpoch,
  vectorProjectionReceipt,
} from "../helpers/vector-examples.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

async function storage() {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "memo-graph-vector-state-"),
  );
  roots.push(root);
  return SqliteStorageClient.open({ dataRoot: root });
}

describe("vector projection canonical delivery state", () => {
  it("keeps disabled mutations quiet, then registers, rebuilds, leases, and publishes", async () => {
    const client = await storage();
    try {
      expect((await client.health()).schema_version).toBe("0013");
      await seedProjectionSources(client);
      expect(await client.vectorProjectionStatus()).toMatchObject({
        mode: "disabled",
        outbox_pending: 0,
      });

      const epoch = qualifiedVectorEpoch();
      await expect(
        client.registerVectorEmbeddingEpoch({
          epoch,
          registered_at: VECTOR_NOW,
        }),
      ).resolves.toMatchObject({ epoch, replayed: false });
      await expect(
        client.registerVectorEmbeddingEpoch({
          epoch,
          registered_at: VECTOR_NOW,
        }),
      ).resolves.toMatchObject({ epoch, replayed: true });

      const configured = await client.configureVectorProjection({
        mode: "evaluating",
        epoch_id: epoch.epoch_id,
        configured_at: VECTOR_NOW,
      });
      expect(configured.job_ids).toHaveLength(1);
      const pending = await client.vectorProjectionCheckpoint({
        principal_id: "user_local",
        scope: VECTOR_SCOPE,
      });
      expect(pending).toMatchObject({
        desired_epoch_id: epoch.epoch_id,
        active_epoch_id: null,
        state: "pending",
      });

      const claimed = await client.claimVectorProjectionJobs({
        worker_id: "vector_worker_1",
        claimed_at: VECTOR_NOW,
        lease_expires_at: VECTOR_LATER,
        limit: 10,
      });
      expect(claimed.jobs).toHaveLength(1);
      const job = claimed.jobs[0];
      if (job === undefined || job.lease_id === null) {
        throw new Error("vector job must carry an exact lease");
      }
      const receipt = vectorProjectionReceipt({
        receiptId: "vector_receipt_publish_1",
        job,
      });
      const applied = await client.applyVectorProjectionJob({
        job_id: job.job_id,
        worker_id: "vector_worker_1",
        lease_token: job.lease_id,
        receipt,
      });
      expect(applied).toMatchObject({
        replayed: false,
        checkpoint: {
          state: "published",
          active_epoch_id: epoch.epoch_id,
          active_generation_id: job.desired_generation_id,
          logical_digest: receipt.logical_digest,
        },
      });
      await expect(
        client.applyVectorProjectionJob({
          job_id: job.job_id,
          worker_id: "vector_worker_1",
          lease_token: job.lease_id,
          receipt,
        }),
      ).resolves.toMatchObject({ replayed: true });
    } finally {
      await client.close();
    }
  });

  it("builds one exact scope in quarantine and publishes only content-free vector state", async () => {
    const root = await mkdtemp(
      join(await realpath(tmpdir()), "memo-graph-vector-projector-"),
    );
    roots.push(root);
    const client = await SqliteStorageClient.open({ dataRoot: root });
    try {
      const sources = await seedProjectionSources(client);
      const epoch = qualifiedVectorEpoch();
      await client.registerVectorEmbeddingEpoch({
        epoch,
        registered_at: VECTOR_NOW,
      });
      await client.configureVectorProjection({
        mode: "evaluating",
        epoch_id: epoch.epoch_id,
        configured_at: VECTOR_NOW,
      });
      const runtime = new InMemoryVectorRuntimeFactory();
      const projector = new VectorScopeProjector({
        storage: client,
        dataRoot: root,
        modelRoot: join(root, "models"),
        epoch,
        runtimeFactory: runtime.runtimeFactory(),
        batchSize: 1,
      });
      const drained = await projector.drain({
        worker_id: "vector_projector_1",
        claimed_at: "2026-07-29T06:00:01.000Z",
        lease_expires_at: "2026-07-29T06:01:00.000Z",
        completed_at: "2026-07-29T06:00:05.000Z",
        retry_at: "2026-07-29T06:01:05.000Z",
      });
      expect(drained).toMatchObject({
        claimed: 1,
        published: 1,
        stale: 0,
        failed: 0,
      });
      const checkpoint = await client.vectorProjectionCheckpoint({
        principal_id: "user_local",
        scope: VECTOR_SCOPE,
      });
      expect(checkpoint).toMatchObject({
        state: "published",
        active_epoch_id: epoch.epoch_id,
        active_generation_id: checkpoint.desired_generation_id,
      });
      const layout = await vectorGenerationLayout({
        dataRoot: root,
        principalId: "user_local",
        scope: VECTOR_SCOPE,
        epochId: epoch.epoch_id,
        generationId: checkpoint.desired_generation_id,
      });
      await expect(access(layout.activeRoot)).resolves.toBeUndefined();
      await expect(access(layout.quarantineRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
      const stored = await readFile(
        join(layout.activeRoot, "vector.snapshot.json"),
        "utf8",
      );
      for (const forbidden of [
        "SQLite is the canonical memory authority.",
        "Derived views must revalidate exact source revisions.",
      ]) {
        expect(stored).not.toContain(forbidden);
      }
      expect(
        JSON.parse(stored).records.map(
          (record: { revision_id: string }) => record.revision_id,
        ),
      ).toEqual(
        sources.map((source) => source.revision_id).sort(),
      );
    } finally {
      await client.close();
    }
  });
});
