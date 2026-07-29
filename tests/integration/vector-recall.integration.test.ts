import {
  access,
  mkdtemp,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  LayeredLaneRetrievers,
  RecallOrchestrator,
} from "../../packages/memory-kernel/src/index.js";
import {
  VectorQueryResultSchema,
} from "../../packages/contracts/src/index.js";
import {
  SemanticVectorRetriever,
  VectorScopeProjector,
  vectorGenerationLayout,
  type SemanticVectorRuntimeFactory,
} from "../../packages/vector-retrieval/src/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";

import {
  InMemoryVectorRuntimeFactory,
} from "../helpers/in-memory-vector-runtime.js";
import {
  seedProjectionSources,
} from "../helpers/projection-examples.js";
import {
  VECTOR_SCOPE,
  qualifiedVectorEpoch,
} from "../helpers/vector-examples.js";

const roots: string[] = [];
const AS_OF = "2026-07-29T06:30:00.000Z";

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

function policy(
  lanes: Array<"recent_l1" | "semantic_vector">,
  maxCandidates = 20,
) {
  return {
    allowed_lanes: lanes,
    limits: {
      max_candidates_per_lane: maxCandidates,
      relation_max_depth: 2,
      relation_max_fanout: 5,
      max_concurrent_lanes: 2,
      vector_top_k: 7,
      vector_query_timeout_ms: 50,
      vector_max_response_bytes: 65_536,
    },
  } as const;
}

async function projectedHarness(options: {
  queryFactory?: (
    base: SemanticVectorRuntimeFactory,
  ) => SemanticVectorRuntimeFactory;
} = {}) {
  const root = await mkdtemp(
    join(
      await realpath(tmpdir()),
      "memo-graph-vector-recall-",
    ),
  );
  roots.push(root);
  const storage = await SqliteStorageClient.open({ dataRoot: root });
  const sources = await seedProjectionSources(storage);
  const epoch = qualifiedVectorEpoch();
  await storage.registerVectorEmbeddingEpoch({
    epoch,
    registered_at: "2026-07-29T06:00:00.000Z",
  });
  await storage.configureVectorProjection({
    mode: "evaluating",
    epoch_id: epoch.epoch_id,
    configured_at: "2026-07-29T06:00:01.000Z",
  });
  const vectorRuntime = new InMemoryVectorRuntimeFactory();
  const projector = new VectorScopeProjector({
    storage,
    dataRoot: root,
    modelRoot: join(root, "models"),
    epoch,
    runtimeFactory: vectorRuntime.runtimeFactory(),
  });
  await projector.drain({
    worker_id: "vector_recall_projector",
    claimed_at: "2026-07-29T06:00:02.000Z",
    lease_expires_at: "2026-07-29T06:01:00.000Z",
    completed_at: "2026-07-29T06:00:05.000Z",
    retry_at: "2026-07-29T06:01:05.000Z",
  });
  const baseQueryFactory = vectorRuntime.queryRuntimeFactory();
  const retriever = new SemanticVectorRetriever({
    storage,
    dataRoot: root,
    modelRoot: join(root, "models"),
    epoch,
    runtimeFactory:
      options.queryFactory?.(baseQueryFactory) ?? baseQueryFactory,
    allowEvaluating: true,
  });
  const orchestrator = new RecallOrchestrator({
    storage,
    retriever: new LayeredLaneRetrievers(storage, {
      vectorRetriever: retriever,
    }),
  });
  return {
    root,
    storage,
    sources,
    epoch,
    vectorRuntime,
    orchestrator,
  };
}

function recall(
  orchestrator: RecallOrchestrator,
  lanes: Array<"recent_l1" | "semantic_vector">,
  maxCandidates = 20,
) {
  return orchestrator.recall({
    principal_id: "user_local",
    scope: VECTOR_SCOPE,
    query: "canonical memory authority",
    as_of: AS_OF,
    include_sensitive: false,
    lane_policy: policy(lanes, maxCandidates),
  });
}

describe("governed semantic vector recall", () => {
  it("queries only the published exact scope, materializes canonically, and retains vector evidence", async () => {
    const harness = await projectedHarness();
    try {
      const result = await recall(
        harness.orchestrator,
        ["semantic_vector"],
        1,
      );

      expect(result.status).toBe("OK");
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]).toMatchObject({
        kind: "memory",
        lane: "semantic_vector",
        canonical_revalidated: true,
        vector: {
          embedding_epoch_id: harness.epoch.epoch_id,
          canonical_revalidated: true,
        },
      });
      expect(harness.vectorRuntime.queries).toHaveLength(1);
      expect(harness.vectorRuntime.queries[0]).toMatchObject({
        principal_id: "user_local",
        scope: VECTOR_SCOPE,
        top_k: 1,
        max_response_bytes: 65_536,
      });
      expect(
        harness.vectorRuntime.queries[0]?.parent_deadline_ms,
      ).toBeGreaterThan(0);
      expect(
        harness.vectorRuntime.queries[0]?.parent_deadline_ms,
      ).toBeLessThanOrEqual(50);
      expect(
        JSON.stringify(result.telemetry),
      ).not.toContain("SQLite is the canonical memory authority.");
      expect(
        result.telemetry.find(
          (item) => item.lane === "semantic_vector",
        ),
      ).toMatchObject({
        status: "eligible",
        candidate_count: 1,
        eligible_count: 1,
      });
    } finally {
      await harness.storage.close();
    }
  });

  it("degrades when every backend hit fails canonical postvalidation", async () => {
    const harness = await projectedHarness({
      queryFactory: (base) => ({
        open: async (input) => {
          const runtime = await base.open(input);
          return {
            query: async (queryInput) => {
              const result = await runtime.query(queryInput);
              return VectorQueryResultSchema.parse({
                ...result,
                hits: result.hits.map((hit) => ({
                  ...hit,
                  source_content_hash: `sha256:${"0".repeat(64)}`,
                })),
              });
            },
            close: () => runtime.close(),
          };
        },
      }),
    });
    try {
      const result = await recall(
        harness.orchestrator,
        ["semantic_vector"],
      );

      expect(result.status).toBe("DEGRADED");
      expect(result.candidates).toEqual([]);
      expect(result.degraded_lanes).toEqual(["semantic_vector"]);
      expect(result.exclusions).toHaveLength(2);
      expect(
        result.exclusions.every(
          (item) =>
            item.reason_code === "VECTOR_CANONICAL_MISMATCH" &&
            item.vector !== undefined,
        ),
      ).toBe(true);
      expect(
        result.telemetry.find(
          (item) => item.lane === "semantic_vector",
        ),
      ).toMatchObject({
        status: "degraded",
        reason_codes: [
          "VECTOR_ALL_HITS_STALE",
          "VECTOR_CANONICAL_MISMATCH",
          "VECTOR_POSTVALIDATION_REJECTED",
        ],
      });
    } finally {
      await harness.storage.close();
    }
  });

  it("returns clean NO_MATCH only for a complete empty vector response", async () => {
    const harness = await projectedHarness({
      queryFactory: (base) => ({
        open: async (input) => {
          const runtime = await base.open(input);
          return {
            query: async (queryInput) => {
              const result = await runtime.query(queryInput);
              return {
                ...result,
                status: "no_match",
                hits: [],
                complete: true,
              };
            },
            close: () => runtime.close(),
          };
        },
      }),
    });
    try {
      const result = await recall(
        harness.orchestrator,
        ["semantic_vector"],
      );

      expect(result.status).toBe("NO_MATCH");
      expect(result.candidates).toEqual([]);
      expect(result.exclusions).toEqual([]);
      expect(
        result.telemetry.find(
          (item) => item.lane === "semantic_vector",
        ),
      ).toMatchObject({
        status: "empty",
        reason_codes: ["VECTOR_COMPLETE_NO_MATCH"],
      });
    } finally {
      await harness.storage.close();
    }
  });

  it("keeps the base lane result identical when vector is disabled", async () => {
    const harness = await projectedHarness();
    try {
      const baseline = await recall(
        harness.orchestrator,
        ["recent_l1"],
      );
      await harness.storage.configureVectorProjection({
        mode: "disabled",
        epoch_id: null,
        configured_at: "2026-07-29T06:10:00.000Z",
      });
      const composed = await recall(
        harness.orchestrator,
        ["recent_l1", "semantic_vector"],
      );

      expect(composed.status).toBe("DEGRADED");
      expect(composed.candidates).toEqual(baseline.candidates);
      expect(composed.degraded_lanes).toEqual(["semantic_vector"]);
      expect(
        composed.telemetry.find(
          (item) => item.lane === "semantic_vector",
        ),
      ).toMatchObject({
        status: "degraded",
        reason_codes: ["VECTOR_DISABLED"],
      });
    } finally {
      await harness.storage.close();
    }
  });

  it("degrades without recreating a missing published active generation", async () => {
    const harness = await projectedHarness();
    try {
      const checkpoint =
        await harness.storage.vectorProjectionCheckpoint({
          principal_id: "user_local",
          scope: VECTOR_SCOPE,
        });
      if (
        checkpoint.active_epoch_id === null ||
        checkpoint.active_generation_id === null
      ) {
        throw new Error("vector checkpoint was not published");
      }
      const layout = await vectorGenerationLayout({
        dataRoot: harness.root,
        principalId: "user_local",
        scope: VECTOR_SCOPE,
        epochId: checkpoint.active_epoch_id,
        generationId: checkpoint.active_generation_id,
      });
      await rm(layout.activeRoot, {
        recursive: true,
        force: true,
      });

      const result = await recall(
        harness.orchestrator,
        ["semantic_vector"],
      );

      expect(result.status).toBe("DEGRADED");
      expect(result.candidates).toEqual([]);
      expect(result.degraded_lanes).toEqual(["semantic_vector"]);
      expect(
        result.telemetry.find(
          (item) => item.lane === "semantic_vector",
        ),
      ).toMatchObject({
        status: "degraded",
        reason_codes: ["VECTOR_INDEX_MISSING"],
      });
      await expect(access(layout.activeRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await harness.storage.close();
    }
  });

  it("enforces the parent deadline across runtime startup and closes a late runtime", async () => {
    let releaseOpen: () => void = () => {};
    let markOpenStarted: () => void = () => {};
    let markLateClosed: () => void = () => {};
    const openStarted = new Promise<void>((resolve) => {
      markOpenStarted = resolve;
    });
    const lateClosed = new Promise<void>((resolve) => {
      markLateClosed = resolve;
    });
    const openBarrier = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const harness = await projectedHarness({
      queryFactory: (base) => ({
        open: async (input) => {
          markOpenStarted();
          await openBarrier;
          const runtime = await base.open(input);
          return {
            query: (queryInput) => runtime.query(queryInput),
            close: async () => {
              await runtime.close();
              markLateClosed();
            },
          };
        },
      }),
    });
    try {
      const startedAt = performance.now();
      const pending = recall(
        harness.orchestrator,
        ["semantic_vector"],
      );
      await openStarted;
      const result = await pending;

      expect(performance.now() - startedAt).toBeLessThan(200);
      expect(result.status).toBe("DEGRADED");
      expect(result.candidates).toEqual([]);
      expect(result.degraded_lanes).toEqual(["semantic_vector"]);
      expect(
        result.telemetry.find(
          (item) => item.lane === "semantic_vector",
        ),
      ).toMatchObject({
        status: "degraded",
        reason_codes: ["VECTOR_PROCESS_TIMEOUT"],
      });
      expect(harness.vectorRuntime.queries).toEqual([]);

      releaseOpen();
      await lateClosed;
    } finally {
      releaseOpen();
      await harness.storage.close();
    }
  });
});
