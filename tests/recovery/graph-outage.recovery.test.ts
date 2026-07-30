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
  GraphStoreError,
  graphFailureDisposition,
} from "../../packages/graph-projection/src/index.js";
import {
  GraphFailureCodeSchema,
} from "../../packages/contracts/src/index.js";
import {
  SqliteStorageClient,
} from "@memo-graph/storage-sqlite";

import {
  applyCompleteGraphProjectionFixture,
} from "../helpers/graph-runtime-examples.js";
import {
  InMemoryGraphStore,
  projectAllReady,
} from "../helpers/in-memory-graph-store.js";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "memo-graph-u6-outage-")),
  );
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("graph outage recovery", () => {
  it("has a stable, exhaustive, content-free failure disposition", () => {
    const dispositions = GraphFailureCodeSchema.options.map((code) => ({
      code,
      ...graphFailureDisposition(code),
    }));
    expect(dispositions).toHaveLength(GraphFailureCodeSchema.options.length);
    expect(new Set(dispositions.map((item) => item.code)).size).toBe(
      GraphFailureCodeSchema.options.length,
    );
    expect(dispositions.every((item) => item.runtime === "sqlite_fallback"))
      .toBe(true);
    expect(JSON.stringify(dispositions)).not.toContain("memory content");
  });

  it("treats a missing ready graph scope as digest mismatch instead of clean no-match", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot(),
    });
    const store = new InMemoryGraphStore();
    try {
      const fixture = await applyCompleteGraphProjectionFixture(storage);
      await projectAllReady({
        storage,
        store,
        workerId: "graph_u6_missing_database",
      });
      store.snapshots.clear();
      const retriever = new GraphRecallRetriever({
        storage,
        store,
        policy: {
          mode: "typed_path",
          relation_pattern: ["supports"],
          direction: "outbound",
        },
      });
      const result = await retriever.retrieve({
        lane: "relation_graph",
        principal_id: "user_local",
        scope: { kind: "workspace", id: "workspace_local" },
        query: "authority",
        as_of: "2026-07-29T10:05:00.000Z",
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
        start_revision_ids: [fixture.sources[0].revision_id],
      });
      expect(result).toMatchObject({
        candidates: [],
        truncated: true,
        reason_codes: ["GRAPH_DIGEST_MISMATCH"],
      });
      expect(store.queryCount).toBe(0);
      await expect(storage.health()).resolves.toMatchObject({
        schema_version: "0017",
        journal_mode: "wal",
      });
    } finally {
      await store.close();
      await storage.close();
    }
  });

  for (const failure of [
    "GRAPH_STORE_LOCKED",
    "GRAPH_STORE_CORRUPT",
    "GRAPH_CHILD_EXITED",
  ] as const) {
    it(`${failure} returns typed degradation while SQLite remains responsive`, async () => {
      const storage = await SqliteStorageClient.open({
        dataRoot: temporaryRoot(),
      });
      const store = new InMemoryGraphStore();
      try {
        const fixture = await applyCompleteGraphProjectionFixture(storage);
        await projectAllReady({
          storage,
          store,
          workerId: `graph_u6_${failure.toLowerCase()}`,
        });
        let starts = 0;
        const retriever = new GraphRecallRetriever({
          storage,
          storeFactory: async () => {
            starts += 1;
            throw new GraphStoreError(failure, { retryable: true });
          },
          policy: {
            mode: "typed_path",
            relation_pattern: ["supports"],
            direction: "outbound",
          },
          unavailableReason: failure,
        });
        const result = await retriever.retrieve({
          lane: "relation_graph",
          principal_id: "user_local",
          scope: { kind: "workspace", id: "workspace_local" },
          query: "authority",
          as_of: "2026-07-29T10:05:00.000Z",
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
          start_revision_ids: [fixture.sources[0].revision_id],
        });
        expect(result).toMatchObject({
          candidates: [],
          truncated: true,
          reason_codes: [failure],
        });
        expect(starts).toBe(1);
        await expect(storage.health()).resolves.toMatchObject({
          schema_version: "0017",
          journal_mode: "wal",
          foreign_keys: true,
        });
        await retriever.close();
      } finally {
        await store.close();
        await storage.close();
      }
    });
  }
});
