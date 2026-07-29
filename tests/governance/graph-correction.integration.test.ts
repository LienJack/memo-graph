import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  GraphRecallRetriever,
} from "../../packages/graph-projection/src/index.js";
import {
  SqliteStorageClient,
} from "@memo-graph/storage-sqlite";

import {
  memoryCandidate,
  revisionCommand,
} from "../helpers/governance-examples.js";
import {
  applyCompleteGraphProjectionFixture,
} from "../helpers/graph-runtime-examples.js";
import {
  InMemoryGraphStore,
  projectAllReady,
} from "../helpers/in-memory-graph-store.js";
import {
  projectionFrontier,
} from "../helpers/projection-examples.js";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "memo-graph-u6-correction-")),
  );
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("graph correction propagation", () => {
  it("suppresses the affected graph scope synchronously and preserves another ready scope", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot(),
    });
    const store = new InMemoryGraphStore();
    try {
      const fixture = await applyCompleteGraphProjectionFixture(storage);
      const health = await storage.health();
      await storage.applyProjectionBatch({
        principal_id: "user_local",
        scope: { kind: "workspace", id: "workspace_other" },
        idempotency_key: "graph-u6-unaffected-scope-0001",
        expected_projection_epoch:
          health.projection_frontier.projection_epoch,
        frontier: projectionFrontier({
          ledgerEpoch: health.ledger_epoch,
          tombstoneEpoch: health.tombstone_epoch,
          projectionEpoch:
            health.projection_frontier.projection_epoch + 1,
        }),
        projections: [],
        applied_at: "2026-07-29T09:59:00.000Z",
      });
      await expect(
        projectAllReady({
          storage,
          store,
          workerId: "graph_u6_correction_initial",
        }),
      ).resolves.toMatchObject({ claimed: 2, applied: 2 });

      const unaffected = await storage.graphProjectionCheckpoint({
        principal_id: "user_local",
        scope: { kind: "workspace", id: "workspace_other" },
      });
      expect(unaffected.status).toBe("ready");
      const source = fixture.sources[0];
      const command = revisionCommand({
        memoryId: source.memory_id,
        expectedRevisionId: source.revision_id,
        candidate: memoryCandidate({
          candidateId: "candidate_graph_u6_correction",
          logicalKey: "projection.source.a",
          scope: source.scope,
          text: "Corrected authority statement.",
          evidenceIds: source.evidence_ids,
        }),
        idempotencyKey: "graph-u6-correction-0001",
      });
      await storage.applyMemoryRevision(command);

      await expect(
        storage.graphProjectionCheckpoint({
          principal_id: "user_local",
          scope: source.scope,
        }),
      ).resolves.toMatchObject({
        status: "pending",
        frontier: null,
        logical_digest: null,
        backend_identity: null,
      });
      await expect(
        storage.graphProjectionCheckpoint({
          principal_id: "user_local",
          scope: { kind: "workspace", id: "workspace_other" },
        }),
      ).resolves.toEqual(unaffected);

      const beforeQueries = store.queryCount;
      const result = await new GraphRecallRetriever({
        storage,
        store,
        policy: {
          mode: "typed_path",
          relation_pattern: ["supports"],
          direction: "outbound",
        },
      }).retrieve({
        lane: "relation_graph",
        principal_id: "user_local",
        scope: source.scope,
        query: "authority",
        as_of: "2026-07-29T10:01:00.000Z",
        include_sensitive: false,
        limit: 20,
        projection_scan_limit: 100,
        relation_max_depth: 1,
        relation_max_fanout: 10,
        relation_max_starts: 10,
        relation_max_paths: 10,
        graph_max_relation_allowlist: 100,
        graph_query_timeout_ms: 75,
        graph_max_response_bytes: 1_048_576,
        start_revision_ids: [source.revision_id],
      });
      expect(result).toMatchObject({
        candidates: [],
        truncated: true,
        reason_codes: ["GRAPH_SCOPE_PENDING"],
      });
      expect(store.queryCount).toBe(beforeQueries);

      const beforeReplay = await storage.graphProjectionStatus();
      await expect(storage.applyMemoryRevision(command)).resolves.toMatchObject({
        replayed: true,
      });
      expect(await storage.graphProjectionStatus()).toEqual(beforeReplay);
    } finally {
      await store.close();
      await storage.close();
    }
  });
});
