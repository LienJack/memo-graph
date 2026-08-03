import { join } from "node:path";

import {
  LayeredLaneRetrievers,
  MemoryRuntime,
  RecallOrchestrator,
} from "../../packages/memory-kernel/src/index.js";
import {
  SemanticVectorRetriever,
  VectorScopeProjector,
  type SemanticVectorRuntimeFactory,
} from "../../packages/vector-retrieval/src/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";

import { TestApprovalRegistry } from "./approval.js";
import { InMemoryVectorRuntimeFactory } from "./in-memory-vector-runtime.js";
import { seedProjectionSources } from "./projection-examples.js";
import {
  VECTOR_NOW,
  VECTOR_SCOPE,
  qualifiedVectorEpoch,
} from "./vector-examples.js";

export const VECTOR_RECALL_AS_OF = "2026-07-29T06:30:00.000Z";
export const VECTOR_CONTROL_NOW = "2026-07-28T12:30:00.000Z";

export function vectorLanePolicy(
  lanes: Array<"recent_l1" | "semantic_vector"> = [
    "recent_l1",
    "semantic_vector",
  ],
) {
  return {
    allowed_lanes: lanes,
    limits: {
      max_candidates_per_lane: 20,
      relation_max_depth: 2,
      relation_max_fanout: 5,
      max_concurrent_lanes: 2,
      vector_top_k: 20,
      vector_query_timeout_ms: 50,
      vector_max_response_bytes: 65_536,
    },
  } as const;
}

export async function openGovernedVectorHarness(options: {
  dataRoot: string;
  queryFactory?: (
    base: SemanticVectorRuntimeFactory,
  ) => SemanticVectorRuntimeFactory;
  beforeVectorConfigure?: (input: {
    storage: SqliteStorageClient;
    sources: Awaited<ReturnType<typeof seedProjectionSources>>;
  }) => Promise<void>;
}) {
  const storage = await SqliteStorageClient.open({
    dataRoot: options.dataRoot,
  });
  const sources = await seedProjectionSources(storage);
  await options.beforeVectorConfigure?.({ storage, sources });
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
  const vectorRuntime = new InMemoryVectorRuntimeFactory();
  const projector = new VectorScopeProjector({
    storage,
    dataRoot: options.dataRoot,
    modelRoot: join(options.dataRoot, "models"),
    epoch,
    runtimeFactory: vectorRuntime.runtimeFactory(),
  });
  await projector.drain({
    worker_id: "governed_vector_harness_projector",
    claimed_at: "2026-07-29T06:00:01.000Z",
    lease_expires_at: "2026-07-29T06:01:00.000Z",
    completed_at: "2026-07-29T06:00:05.000Z",
    retry_at: "2026-07-29T06:01:05.000Z",
  });
  const baseQueryFactory = vectorRuntime.queryRuntimeFactory();
  const retriever = new SemanticVectorRetriever({
    storage,
    dataRoot: options.dataRoot,
    modelRoot: join(options.dataRoot, "models"),
    epoch,
    runtimeFactory:
      options.queryFactory?.(baseQueryFactory) ?? baseQueryFactory,
    allowEvaluating: true,
  });
  const laneRetriever = new LayeredLaneRetrievers(storage, {
    vectorRetriever: retriever,
  });
  const orchestrator = new RecallOrchestrator({
    storage,
    retriever: laneRetriever,
  });
  const approvals = new TestApprovalRegistry();
  const memoryRuntime = new MemoryRuntime({
    storage,
    approvalRegistry: approvals,
    clock: () => VECTOR_CONTROL_NOW,
    policy: {
      principal: {
        principal_id: "user_local",
        allowed_scopes: [VECTOR_SCOPE],
        allowed_authorities: ["user_stated"],
        destructive_tools_enabled: true,
      },
      default_token_budget: 1_800,
      lane_policy: vectorLanePolicy(),
    },
    laneRetriever,
  });
  const recall = (
    lanes: Array<"recent_l1" | "semantic_vector"> = [
      "semantic_vector",
    ],
  ) =>
    orchestrator.recall({
      principal_id: "user_local",
      scope: VECTOR_SCOPE,
      query: "canonical memory authority",
      as_of: VECTOR_RECALL_AS_OF,
      include_sensitive: false,
      lane_policy: vectorLanePolicy(lanes),
    });
  return {
    storage,
    sources,
    epoch,
    vectorRuntime,
    projector,
    retriever,
    laneRetriever,
    orchestrator,
    approvals,
    memoryRuntime,
    recall,
  };
}
