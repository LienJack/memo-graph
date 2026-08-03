import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ExactScopeGraphProjector,
  GraphRecallRetriever,
  GraphStoreError,
  queryGraphSnapshotReference,
  type GraphStore,
} from "../../packages/graph-projection/src/index.js";
import {
  GraphBackendIdentitySchema,
  GraphProcessHealthSchema,
  GraphQueryResultSchema,
  buildContextFrontierV2,
  canonicalSha256,
  type GraphQuery,
  type GraphScopeSnapshot,
} from "../../packages/contracts/src/index.js";
import {
  compileLayeredContext,
} from "../../packages/context-compiler/src/index.js";
import {
  LayeredLaneRetrievers,
  RecallOrchestrator,
  type LayeredRecallInput,
} from "../../packages/memory-kernel/src/index.js";
import {
  SqliteStorageClient,
} from "@memo-graph/storage-sqlite";

import {
  applyCompleteGraphProjectionFixture,
} from "../helpers/graph-runtime-examples.js";
import {
  projectionFrontier,
} from "../helpers/projection-examples.js";

const roots: string[] = [];
const stores: FixtureGraphStore[] = [];
const identity = GraphBackendIdentitySchema.parse({
  schema_version: "1.0.0",
  backend: "ladybugdb",
  package_name: "@ladybugdb/core",
  package_version: "0.18.3",
  storage_version: "42",
  platform: process.platform,
  architecture: process.arch,
  native_binary_hash: `sha256:${"1".repeat(64)}`,
  dependency_lock_hash: `sha256:${"2".repeat(64)}`,
});

class FixtureGraphStore implements GraphStore {
  snapshot: GraphScopeSnapshot | null = null;
  queryCount = 0;
  beforeQuery: ((query: GraphQuery) => Promise<void>) | null = null;
  degrade = false;
  unavailable = false;

  async health() {
    return GraphProcessHealthSchema.parse({
      schema_version: "1.0.0",
      status: "ready",
      backend_identity: identity,
      process_generation: 1,
      restart_count: 0,
      queue_depth: 0,
      active_requests: 0,
      database_path_hash: `sha256:${"3".repeat(64)}`,
      circuit_open_until: null,
      last_failure: null,
    });
  }

  async replaceScope(input: unknown) {
    const snapshot = input as GraphScopeSnapshot;
    this.snapshot = snapshot;
    return snapshot;
  }

  async deleteScope() {
    this.snapshot = null;
  }

  async readScopeSnapshot() {
    return this.snapshot;
  }

  async queryPaths(input: unknown) {
    if (this.snapshot === null) {
      throw new Error("fixture graph snapshot missing");
    }
    const query = input as GraphQuery;
    this.queryCount += 1;
    const result = queryGraphSnapshotReference({
      snapshot: this.snapshot,
      query,
      elapsedMs: 1,
    });
    await this.beforeQuery?.(query);
    if (this.unavailable) {
      return GraphQueryResultSchema.parse({
        schema_version: "1.0.0",
        query_id: query.query_id,
        status: "unavailable",
        query_hash: canonicalSha256(query),
        frontier: query.frontier,
        paths: [],
        elapsed_ms: 1,
        complete: false,
        reason_codes: ["GRAPH_CHILD_EXITED"],
        process_outcome: "child_exited",
      });
    }
    if (!this.degrade) {
      return result;
    }
    return GraphQueryResultSchema.parse({
      ...result,
      status: "degraded",
      complete: false,
      reason_codes: ["GRAPH_RESULT_LIMIT"],
      bounded_work: (result.bounded_work ?? []).map((item) =>
        item.boundary === "graph_results"
          ? {
              ...item,
              observed_count: Math.max(2, item.observed_count),
              retained_count: 1,
              truncated_count: 1,
              complete: false,
              reason_code: "GRAPH_RESULT_LIMIT",
            }
          : item
      ),
    });
  }

  async close() {
    this.snapshot = null;
  }
}

function temporaryRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "memo-graph-u5-recall-")),
  );
  roots.push(root);
  return root;
}

async function readyRuntime() {
  const storage = await SqliteStorageClient.open({
    dataRoot: temporaryRoot(),
  });
  const fixture = await applyCompleteGraphProjectionFixture(storage);
  const store = new FixtureGraphStore();
  stores.push(store);
  const projector = new ExactScopeGraphProjector({
    storage,
    store,
    workerId: "graph_u5_projector",
    clock: () => new Date("2026-07-29T09:00:00.000Z"),
  });
  await expect(projector.drain()).resolves.toMatchObject({
    claimed: 1,
    applied: 1,
  });
  const graphRetriever = new GraphRecallRetriever({
    storage,
    store,
    policy: {
      mode: "typed_path",
      relation_pattern: ["supports"],
      direction: "outbound",
    },
  });
  const retriever = new LayeredLaneRetrievers(storage, {
    graphRetriever,
  });
  return { storage, store, fixture, retriever };
}

const lanePolicy = {
  allowed_lanes: [
    "recent_l1",
    "relation_sqlite",
    "relation_graph",
  ],
  limits: {
    max_candidates_per_lane: 20,
    relation_max_depth: 1,
    relation_max_fanout: 10,
    max_concurrent_lanes: 2,
    relation_max_starts: 10,
    relation_max_paths: 10,
    graph_max_relation_allowlist: 100,
    graph_query_timeout_ms: 75,
    graph_max_response_bytes: 1_048_576,
  },
} satisfies LayeredRecallInput["lane_policy"];

async function recall(
  storage: SqliteStorageClient,
  retriever: LayeredLaneRetrievers,
) {
  return new RecallOrchestrator({
    storage,
    retriever,
  }).recall({
    principal_id: "user_local",
    scope: { kind: "workspace", id: "workspace_local" },
    query: "SQLite",
    as_of: "2026-07-29T09:05:00.000Z",
    include_sensitive: false,
    lane_policy: lanePolicy,
    lane_overrides: {
      requested_lanes: [
        "recent_l1",
        "relation_sqlite",
        "relation_graph",
      ],
      limits: {},
    },
  });
}

afterEach(async () => {
  await Promise.allSettled(stores.splice(0).map((store) => store.close()));
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("governed relation_graph recall", () => {
  it("does not start the optional graph process before an exact checkpoint is ready", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot(),
    });
    await applyCompleteGraphProjectionFixture(storage);
    let starts = 0;
    const retriever = new GraphRecallRetriever({
      storage,
      storeFactory: async () => {
        starts += 1;
        return new FixtureGraphStore();
      },
      policy: {
        mode: "typed_path",
        relation_pattern: ["supports"],
        direction: "outbound",
      },
    });
    try {
      const result = await retriever.retrieve({
        lane: "relation_graph",
        principal_id: "user_local",
        scope: { kind: "workspace", id: "workspace_local" },
        query: "SQLite",
        as_of: "2026-07-29T09:05:00.000Z",
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
        start_revision_ids: ["revision_start"],
      });
      expect(result).toMatchObject({
        truncated: true,
        reason_codes: ["GRAPH_SCOPE_PENDING"],
      });
      expect(starts).toBe(0);
      await expect(
        retriever.retrieve({
          lane: "relation_graph",
          principal_id: "user_local",
          scope: { kind: "workspace", id: "workspace_local" },
          query: "SQLite",
          as_of: "2026-07-29T09:05:00.000Z",
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
          start_revision_ids: ["revision_start"],
          raw_query: "MATCH (n) RETURN n",
        } as never),
      ).rejects.toThrow();
      expect(starts).toBe(0);
    } finally {
      await retriever.close();
      await storage.close();
    }
  });

  it("cannot enable relation_graph when operator policy denies it", async () => {
    const { storage, store, retriever } = await readyRuntime();
    try {
      const recalled = await new RecallOrchestrator({
        storage,
        retriever,
      }).recall({
        principal_id: "user_local",
        scope: { kind: "workspace", id: "workspace_local" },
        query: "SQLite",
        as_of: "2026-07-29T09:05:00.000Z",
        include_sensitive: false,
        lane_policy: {
          allowed_lanes: ["recent_l1"],
          limits: {
            max_candidates_per_lane: 20,
            relation_max_depth: 1,
            relation_max_fanout: 10,
            max_concurrent_lanes: 2,
          },
        },
        lane_overrides: {
          requested_lanes: ["recent_l1", "relation_graph"],
          limits: {},
        },
      });
      expect(store.queryCount).toBe(0);
      expect(
        recalled.telemetry.find(
          (row) => row.lane === "relation_graph",
        ),
      ).toMatchObject({
        status: "disabled_by_policy",
        reason_codes: ["LANE_DENIED_BY_POLICY:relation_graph"],
      });
    } finally {
      await storage.close();
    }
  });

  it("caches optional dependency startup failure and keeps serving SQLite fallback", async () => {
    const { storage } = await readyRuntime();
    let attempts = 0;
    const retriever = new LayeredLaneRetrievers(storage, {
      graphRetriever: new GraphRecallRetriever({
        storage,
        storeFactory: async () => {
          attempts += 1;
          throw new GraphStoreError(
            "GRAPH_OPTIONAL_DEPENDENCY_MISSING",
          );
        },
        policy: {
          mode: "typed_path",
          relation_pattern: ["supports"],
          direction: "outbound",
        },
      }),
    });
    try {
      const first = await recall(storage, retriever);
      const second = await recall(storage, retriever);
      expect(attempts).toBe(1);
      for (const result of [first, second]) {
        expect(result.status).toBe("DEGRADED");
        expect(
          result.telemetry.find(
            (row) => row.lane === "relation_graph",
          )?.reason_codes,
        ).toContain("GRAPH_OPTIONAL_DEPENDENCY_MISSING");
        expect(
          result.candidates.some(
            (candidate) => candidate.lane === "recent_l1",
          ),
        ).toBe(true);
      }
    } finally {
      await storage.close();
    }
  });

  it("uses an exact SQLite allowlist and seals proof-only graph evidence into Context and receipt", async () => {
    const { storage, store, retriever } = await readyRuntime();
    try {
      const recalled = await recall(storage, retriever);
      const graphCandidate = recalled.candidates.find(
        (candidate) => candidate.lane === "relation_graph",
      );
      expect(graphCandidate).toMatchObject({
        kind: "projection",
        abstraction: "l2_relation",
        canonical_revalidated: true,
      });
      expect(
        graphCandidate?.kind === "projection"
          ? graphCandidate.graph_path
          : undefined,
      ).toMatchObject({
        relation_types: ["supports"],
        depth: 1,
      });
      const graphTelemetry = recalled.telemetry.find(
        (row) => row.lane === "relation_graph",
      );
      expect(graphTelemetry).toMatchObject({
        status: "eligible",
        candidate_count: 1,
        eligible_count: 1,
      });
      expect(graphTelemetry?.query_hashes).toHaveLength(1);
      expect(
        graphTelemetry?.bounded_work?.map((item) => item.boundary),
      ).toEqual(
        expect.arrayContaining([
          "relation_starts",
          "relation_fanout",
          "relation_allowlist",
          "graph_results",
          "graph_wall_clock",
          "graph_response_bytes",
        ]),
      );

      const scopeFrontier = recalled.projection_scope_frontier;
      if (scopeFrontier.status !== "ready") {
        throw new Error("fixture projection frontier must be ready");
      }
      const compiled = compileLayeredContext({
        request: {
          schema_version: "1.0.0",
          request_id: "graph_context_compile_1",
          goal: "explain governed memory authority",
          query: "SQLite",
          scopes: [{ kind: "workspace", id: "workspace_local" }],
          as_of: "2026-07-29T09:05:00.000Z",
          token_budget: 32_000,
          include_sensitive: false,
          lane_overrides: {
            requested_lanes: [
              "recent_l1",
              "relation_sqlite",
              "relation_graph",
            ],
            limits: {},
          },
        },
        candidates: recalled.candidates,
        exclusions: recalled.exclusions,
        frontier: buildContextFrontierV2({
          ledger_epoch: scopeFrontier.ledger_epoch,
          tombstone_epoch: scopeFrontier.tombstone_epoch,
          scope_frontiers: [{
            scope: scopeFrontier.scope,
            projection_epoch: scopeFrontier.projection_epoch,
            source_frontier_hash: scopeFrontier.source_frontier_hash,
            projection_frontier_hash:
              scopeFrontier.projection_frontier_hash,
            transform_versions: scopeFrontier.transform_versions,
          }],
        }),
        effective_configuration: recalled.effective_configuration,
        telemetry: recalled.telemetry,
        created_at: "2026-07-29T09:05:00.000Z",
      });
      expect(
        compiled.context_slice?.items.some(
          (item) =>
            item.lane === "relation_graph" &&
            item.graph_path !== undefined,
        ),
      ).toBe(true);
      expect(
        compiled.receipt.items.some(
          (item) =>
            item.lane === "relation_graph" &&
            item.graph_path !== undefined,
        ),
      ).toBe(true);
      expect(JSON.stringify(compiled.receipt)).not.toContain(
        "SQLite remains authoritative.",
      );
      expect(store.queryCount).toBe(1);
    } finally {
      await storage.close();
    }
  });

  it("executes the operator-frozen shortest-path mode with the same governed proof", async () => {
    const { storage, store } = await readyRuntime();
    const shortestRetriever = new LayeredLaneRetrievers(storage, {
      graphRetriever: new GraphRecallRetriever({
        storage,
        store,
        policy: {
          mode: "shortest_path",
          relation_pattern: ["supports"],
          direction: "outbound",
        },
      }),
    });
    try {
      const recalled = await recall(storage, shortestRetriever);
      const graphCandidate = recalled.candidates.find(
        (candidate) =>
          candidate.kind === "projection" &&
          candidate.lane === "relation_graph",
      );
      expect(
        graphCandidate?.kind === "projection"
          ? graphCandidate.graph_path
          : undefined,
      ).toMatchObject({
        relation_types: ["supports"],
        depth: 1,
      });
      expect(store.queryCount).toBe(1);
    } finally {
      await storage.close();
    }
  });

  it("reports start truncation separately from graph result bounds", async () => {
    const { storage, store, fixture } = await readyRuntime();
    const retriever = new GraphRecallRetriever({
      storage,
      store,
      policy: {
        mode: "typed_path",
        relation_pattern: ["supports"],
        direction: "outbound",
      },
    });
    try {
      const result = await retriever.retrieve({
        lane: "relation_graph",
        principal_id: "user_local",
        scope: { kind: "workspace", id: "workspace_local" },
        query: "SQLite",
        as_of: "2026-07-29T09:05:00.000Z",
        include_sensitive: false,
        limit: 20,
        projection_scan_limit: 100,
        relation_max_depth: 1,
        relation_max_fanout: 10,
        relation_max_starts: 1,
        relation_max_paths: 10,
        graph_max_relation_allowlist: 100,
        graph_query_timeout_ms: 75,
        graph_max_response_bytes: 1_048_576,
        start_revision_ids: [
          fixture.sources[0].revision_id,
          "zzzz_truncated_start",
        ],
      });
      expect(result.truncated).toBe(true);
      expect(result.reason_codes).toContain("RELATION_START_LIMIT");
      expect(
        result.bounded_work?.find(
          (item) => item.boundary === "relation_starts",
        ),
      ).toMatchObject({
        observed_count: 2,
        retained_count: 1,
        truncated_count: 1,
        complete: false,
      });
      expect(
        result.bounded_work?.find(
          (item) => item.boundary === "graph_results",
        ),
      ).toMatchObject({
        complete: true,
      });
    } finally {
      await storage.close();
    }
  });

  it("does not dispatch a pending graph scope and keeps SQLite lanes active", async () => {
    const { storage, store, fixture, retriever } = await readyRuntime();
    try {
      const health = await storage.health();
      const nextFrontier = projectionFrontier({
        ledgerEpoch: health.ledger_epoch,
        tombstoneEpoch: health.tombstone_epoch,
        projectionEpoch: health.projection_frontier.projection_epoch + 1,
      });
      const relation = fixture.projections.find(
        (projection) => projection.projection_type === "relation",
      );
      if (relation === undefined) {
        throw new Error("fixture relation missing");
      }
      await storage.applyProjectionBatch({
        principal_id: "user_local",
        scope: { kind: "workspace", id: "workspace_local" },
        idempotency_key: "graph-u5-pending-scope-0001",
        expected_projection_epoch:
          health.projection_frontier.projection_epoch,
        frontier: nextFrontier,
        projections: [],
        retire_projection_revision_ids: [
          relation.projection_revision_id,
        ],
        applied_at: "2026-07-29T09:06:00.000Z",
      });
      const recalled = await recall(storage, retriever);
      expect(store.queryCount).toBe(0);
      expect(recalled.degraded_lanes).toContain("relation_graph");
      expect(
        recalled.telemetry.find(
          (row) => row.lane === "relation_graph",
        ),
      ).toMatchObject({
        status: "stale",
        reason_codes: expect.arrayContaining(["GRAPH_SCOPE_PENDING"]),
      });
      expect(
        recalled.candidates.some(
          (candidate) => candidate.lane === "recent_l1",
        ),
      ).toBe(true);
    } finally {
      await storage.close();
    }
  });

  it("rejects a whole path when SQLite changes between graph response and postvalidation", async () => {
    const { storage, store, fixture, retriever } = await readyRuntime();
    const relation = fixture.projections.find(
      (projection) => projection.projection_type === "relation",
    );
    if (relation === undefined) {
      throw new Error("fixture relation missing");
    }
    store.beforeQuery = async () => {
      const health = await storage.health();
      const nextFrontier = projectionFrontier({
        ledgerEpoch: health.ledger_epoch,
        tombstoneEpoch: health.tombstone_epoch,
        projectionEpoch: health.projection_frontier.projection_epoch + 1,
      });
      await storage.applyProjectionBatch({
        principal_id: "user_local",
        scope: { kind: "workspace", id: "workspace_local" },
        idempotency_key: "graph-u5-mid-query-correction-0001",
        expected_projection_epoch:
          health.projection_frontier.projection_epoch,
        frontier: nextFrontier,
        projections: [],
        retire_projection_revision_ids: [
          relation.projection_revision_id,
        ],
        applied_at: "2026-07-29T09:07:00.000Z",
      });
    };
    try {
      const recalled = await recall(storage, retriever);
      expect(
        recalled.candidates.some(
          (candidate) => candidate.lane === "relation_graph",
        ),
      ).toBe(false);
      expect(
        recalled.exclusions.some(
          (item) =>
            item.lane === "relation_graph" &&
            item.reason_code === "GRAPH_POSTVALIDATION_FAILED" &&
            item.graph_path !== undefined,
        ),
      ).toBe(true);
      expect(recalled.degraded_lanes).toContain("relation_graph");
    } finally {
      await storage.close();
    }
  });

  it("marks incomplete native work degraded instead of returning a clean no-match", async () => {
    const { storage, store, retriever } = await readyRuntime();
    store.degrade = true;
    try {
      const recalled = await recall(storage, retriever);
      expect(recalled.status).toBe("DEGRADED");
      expect(recalled.degraded_lanes).toContain("relation_graph");
      expect(
        recalled.telemetry.find(
          (row) => row.lane === "relation_graph",
        ),
      ).toMatchObject({
        status: "degraded",
        reason_codes: expect.arrayContaining(["GRAPH_RESULT_LIMIT"]),
      });
      expect(
        recalled.candidates.some(
          (candidate) => candidate.lane === "recent_l1",
        ),
      ).toBe(true);
    } finally {
      await storage.close();
    }
  });

  it("turns a graph child exit into typed degradation while SQLite recall remains available", async () => {
    const { storage, store, retriever } = await readyRuntime();
    store.unavailable = true;
    try {
      const recalled = await recall(storage, retriever);
      expect(recalled.status).toBe("DEGRADED");
      expect(
        recalled.telemetry.find(
          (row) => row.lane === "relation_graph",
        ),
      ).toMatchObject({
        status: "degraded",
        reason_codes: expect.arrayContaining(["GRAPH_CHILD_EXITED"]),
      });
      expect(
        recalled.candidates.some(
          (candidate) => candidate.lane === "recent_l1",
        ),
      ).toBe(true);
    } finally {
      await storage.close();
    }
  });
});
