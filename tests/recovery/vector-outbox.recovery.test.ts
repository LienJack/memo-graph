import {
  mkdtemp,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import { seedProjectionSources } from "../helpers/projection-examples.js";
import {
  VECTOR_NOW,
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

describe("vector outbox recovery", () => {
  it("recovers an expired lease and preserves attempt identity", async () => {
    const root = await mkdtemp(
      join(await realpath(tmpdir()), "memo-graph-vector-outbox-"),
    );
    roots.push(root);
    const client = await SqliteStorageClient.open({ dataRoot: root });
    try {
      await seedProjectionSources(client);
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
      const first = await client.claimVectorProjectionJobs({
        worker_id: "vector_worker_old",
        claimed_at: "2026-07-29T06:00:01.000Z",
        lease_expires_at: "2026-07-29T06:00:02.000Z",
        limit: 1,
      });
      const old = first.jobs[0];
      expect(old?.attempt).toBe(1);

      const second = await client.claimVectorProjectionJobs({
        worker_id: "vector_worker_new",
        claimed_at: "2026-07-29T06:00:03.000Z",
        lease_expires_at: "2026-07-29T06:00:04.000Z",
        limit: 1,
      });
      const recovered = second.jobs[0];
      expect(recovered).toMatchObject({
        job_id: old?.job_id,
        attempt: 2,
      });
      if (recovered === undefined || recovered.lease_id === null) {
        throw new Error("recovered vector job is missing its lease");
      }
      const receipt = vectorProjectionReceipt({
        receiptId: "vector_receipt_recovery_failure",
        job: recovered,
        outcome: "failed",
        logicalDigest: null,
        failureCategory: "PROCESS_EXIT",
        createdAt: "2026-07-29T06:00:03.500Z",
      });
      await expect(
        client.failVectorProjectionJob({
          job_id: recovered.job_id,
          worker_id: "vector_worker_new",
          lease_token: recovered.lease_id,
          retry_at: "2026-07-29T06:00:05.000Z",
          receipt,
        }),
      ).resolves.toMatchObject({
        checkpoint: {
          state: "degraded",
          failure_category: "PROCESS_EXIT",
        },
      });
    } finally {
      await client.close();
    }
  });
});
