import {
  mkdtemp,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import {
  memoryCandidate,
  revisionCommand,
} from "../helpers/governance-examples.js";
import { seedProjectionSources } from "../helpers/projection-examples.js";
import {
  VECTOR_NOW,
  qualifiedVectorEpoch,
} from "../helpers/vector-examples.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

describe("vector correction coupling", () => {
  it("commits canonical correction and vector invalidation in one observable state", async () => {
    const root = await mkdtemp(
      join(await realpath(tmpdir()), "memo-graph-vector-correction-"),
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
      const source = sources[0];
      const corrected = memoryCandidate({
        candidateId: "candidate_vector_corrected",
        logicalKey: "projection.source.a",
        scope: { kind: "workspace", id: "workspace_local" },
        text: "SQLite remains authority after correction.",
        evidenceIds: ["evidence_projection_a"],
      });
      const correction = await client.applyMemoryRevision(
        revisionCommand({
          memoryId: source.memory_id,
          expectedRevisionId: source.revision_id,
          candidate: corrected,
          idempotencyKey: "vector-correction-0001",
        }),
      );
      expect(await client.vectorProjectionStatus()).toMatchObject({
        mode: "evaluating",
        outbox_pending: 1,
      });
      await expect(
        client.vectorProjectionCheckpoint({
          principal_id: "user_local",
          scope: { kind: "workspace", id: "workspace_local" },
        }),
      ).resolves.toMatchObject({
        state: "pending",
        active_epoch_id: null,
        frontier: {
          ledger_epoch: correction.receipt.resulting_epoch,
        },
      });
    } finally {
      await client.close();
    }
  });
});
