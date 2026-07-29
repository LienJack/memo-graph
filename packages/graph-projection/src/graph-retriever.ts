import { performance } from "node:perf_hooks";

import {
  GraphQueryModeSchema,
  GraphQuerySchema,
  RelationTypeSchema,
  ScopeSchema,
  canonicalJson,
  canonicalSha256,
  scopeKey,
  type BoundedWorkTelemetry,
  type GraphPathEvidence,
  type ProjectionRevision,
  type RecallLane,
} from "@memo-graph/contracts";
import type {
  ProjectionScopeStorageFrontier,
  ProjectionStorageFrontier,
  SqliteStorageClient,
} from "@memo-graph/storage-sqlite";
import { z } from "zod";

import type { GraphStore } from "./graph-store.js";
import { GraphStoreError } from "./graph-store.js";

const GraphRecallPolicySchema = z
  .object({
    mode: GraphQueryModeSchema,
    relation_pattern: z.array(RelationTypeSchema).min(1).max(4),
    direction: z.literal("outbound"),
  })
  .strict();

const GraphLaneRetrieverRequestSchema = z
  .object({
    lane: z.literal("relation_graph"),
    principal_id: z.string().trim().min(1),
    scope: ScopeSchema,
    query: z.string().trim().min(1).max(4_000),
    as_of: z.iso.datetime({ offset: true }),
    include_sensitive: z.boolean(),
    limit: z.number().int().min(1).max(1_000),
    projection_scan_limit: z.number().int().min(1).max(100_000),
    relation_max_depth: z.number().int().min(0).max(4),
    relation_max_fanout: z.number().int().min(1).max(100),
    relation_max_starts: z.number().int().min(1).max(100),
    relation_max_paths: z.number().int().min(1).max(1_000),
    graph_max_relation_allowlist: z
      .number()
      .int()
      .min(1)
      .max(100_000),
    graph_query_timeout_ms: z.number().int().min(1).max(60_000),
    graph_max_response_bytes: z
      .number()
      .int()
      .min(1_024)
      .max(16 * 1_024 * 1_024),
    start_revision_ids: z.array(z.string().trim().min(1)),
  })
  .strict();

export type GraphRecallPolicy = z.input<typeof GraphRecallPolicySchema>;
export type GraphLaneRetrieverRequest = z.input<
  typeof GraphLaneRetrieverRequestSchema
>;

export type GraphLaneRetrievalResult = {
  candidates: Array<{
    kind: "projection";
    lane: "relation_graph";
    projection: ProjectionRevision;
    rank: number;
    graph_path: GraphPathEvidence;
  }>;
  exclusions: Array<{
    memory_id: string;
    revision_id: string;
    lane: RecallLane;
    reason_code: string;
    score: number | null;
    graph_path: GraphPathEvidence;
  }>;
  projection_frontier: ProjectionStorageFrontier | null;
  truncated: boolean;
  reason_codes: string[];
  bounded_work?: BoundedWorkTelemetry[];
  duration_ms?: number;
  query_hashes?: string[];
};

type ParsedRequest = z.output<typeof GraphLaneRetrieverRequestSchema>;

function scalarFrontier(
  frontier: ProjectionScopeStorageFrontier,
): ProjectionStorageFrontier {
  if (
    frontier.status !== "ready" ||
    frontier.source_frontier_hash === null ||
    frontier.projection_frontier_hash === null
  ) {
    throw new Error("ready projection scope frontier required");
  }
  return {
    schema_version: frontier.schema_version,
    ledger_epoch: frontier.ledger_epoch,
    tombstone_epoch: frontier.tombstone_epoch,
    projection_epoch: frontier.projection_epoch,
    source_frontier_hash: frontier.source_frontier_hash,
    projection_frontier_hash: frontier.projection_frontier_hash,
    transform_versions: frontier.transform_versions,
  };
}

function scopeFrontierMatches(
  graphFrontier: {
    ledger_epoch: number;
    tombstone_epoch: number;
    projection_epoch: number;
    source_frontier_hash: string;
    projection_frontier_hash: string;
    transform: { name: string; version: string };
  },
  scopeFrontier: ProjectionScopeStorageFrontier,
): boolean {
  return (
    scopeFrontier.status === "ready" &&
    graphFrontier.ledger_epoch === scopeFrontier.ledger_epoch &&
    graphFrontier.tombstone_epoch === scopeFrontier.tombstone_epoch &&
    graphFrontier.projection_epoch === scopeFrontier.projection_epoch &&
    graphFrontier.source_frontier_hash ===
      scopeFrontier.source_frontier_hash &&
    graphFrontier.projection_frontier_hash ===
      scopeFrontier.projection_frontier_hash &&
    scopeFrontier.transform_versions.some(
      (transform) =>
        transform.name === graphFrontier.transform.name &&
        transform.version === graphFrontier.transform.version,
    )
  );
}

function validAt(
  validity: { valid_from: string; valid_to: string | null },
  asOf: string,
): boolean {
  return (
    Date.parse(validity.valid_from) <= Date.parse(asOf) &&
    (validity.valid_to === null ||
      Date.parse(validity.valid_to) > Date.parse(asOf))
  );
}

function startWork(
  observed: number,
  retained: number,
  limit: number,
): BoundedWorkTelemetry {
  const complete = observed === retained;
  return {
    boundary: "relation_starts",
    configured_limit: limit,
    observed_count: observed,
    retained_count: retained,
    truncated_count: observed - retained,
    complete,
    ...(complete ? {} : { reason_code: "RELATION_START_LIMIT" }),
  };
}

function unavailable(
  options: {
    request: ParsedRequest;
    startedAt: number;
    frontier: ProjectionScopeStorageFrontier | null;
    reason: string;
    work?: BoundedWorkTelemetry[];
  },
): GraphLaneRetrievalResult {
  return {
    candidates: [],
    exclusions: [],
    projection_frontier:
      options.frontier === null ||
        options.frontier.status !== "ready"
        ? null
        : scalarFrontier(options.frontier),
    truncated: true,
    reason_codes: [options.reason],
    ...(options.work === undefined ? {} : { bounded_work: options.work }),
    duration_ms: performance.now() - options.startedAt,
  };
}

function projectionMatchesEdge(
  projection: ProjectionRevision,
  edge: {
    relation_revision_id: string;
    source_revision_id: string;
    target_revision_id: string;
    relation_type: string;
    direction: "directed" | "undirected";
    content_hash: string;
    evidence_ids: string[];
    lineage_revision_ids: string[];
  },
): boolean {
  const payload = projection.payload;
  return (
    payload?.kind === "relation" &&
    projection.projection_revision_id === edge.relation_revision_id &&
    payload.source_revision_id === edge.source_revision_id &&
    payload.target_revision_id === edge.target_revision_id &&
    payload.relation_type === edge.relation_type &&
    payload.direction === edge.direction &&
    projection.content_hash === edge.content_hash &&
    canonicalJson([...projection.evidence_ids].sort()) ===
      canonicalJson([...edge.evidence_ids].sort()) &&
    canonicalJson(
      projection.source_revisions
        .map((source) => source.revision_id)
        .sort(),
    ) === canonicalJson([...edge.lineage_revision_ids].sort())
  );
}

export class GraphRecallRetriever {
  readonly #storage: SqliteStorageClient;
  #store: GraphStore | null;
  readonly #storeFactory: (() => Promise<GraphStore>) | null;
  #storePromise: Promise<GraphStore> | null = null;
  #storeFactoryFailed = false;
  readonly #policy: z.output<typeof GraphRecallPolicySchema>;
  #unavailableReason: string;

  constructor(options: {
    storage: SqliteStorageClient;
    store?: GraphStore;
    storeFactory?: () => Promise<GraphStore>;
    policy: GraphRecallPolicy;
    unavailableReason?: string;
  }) {
    if (options.store !== undefined && options.storeFactory !== undefined) {
      throw new Error("graph retriever accepts one store source");
    }
    this.#storage = options.storage;
    this.#store = options.store ?? null;
    this.#storeFactory = options.storeFactory ?? null;
    this.#policy = GraphRecallPolicySchema.parse(options.policy);
    this.#unavailableReason =
      options.unavailableReason ?? "GRAPH_OPTIONAL_DEPENDENCY_MISSING";
  }

  async retrieve(input: GraphLaneRetrieverRequest): Promise<
    GraphLaneRetrievalResult
  > {
    const request = GraphLaneRetrieverRequestSchema.parse(input);
    const startedAt = performance.now();
    const distinctStarts = [...new Set(request.start_revision_ids)].sort();
    const starts = distinctStarts.slice(0, request.relation_max_starts);
    const boundedWork: BoundedWorkTelemetry[] = [
      startWork(
        distinctStarts.length,
        starts.length,
        request.relation_max_starts,
      ),
    ];
    if (starts.length === 0 || request.relation_max_depth === 0) {
      return {
        candidates: [],
        exclusions: [],
        projection_frontier: null,
        truncated: distinctStarts.length > starts.length,
        reason_codes: [
          starts.length === 0
            ? "RELATION_START_EMPTY"
            : "RELATION_DEPTH_ZERO",
          ...(distinctStarts.length > starts.length
            ? ["RELATION_START_LIMIT"]
            : []),
        ].sort(),
        bounded_work: boundedWork,
        duration_ms: performance.now() - startedAt,
      };
    }
    const scopeFrontier = await this.#storage.projectionScopeFrontier({
      principal_id: request.principal_id,
      scope: request.scope,
    });
    const checkpoint = await this.#storage.graphProjectionCheckpoint({
      backend: "ladybugdb",
      principal_id: request.principal_id,
      scope: request.scope,
    });
    if (
      scopeFrontier.status !== "ready" ||
      checkpoint.status !== "ready" ||
      checkpoint.frontier === null ||
      checkpoint.logical_digest === null ||
      checkpoint.backend_identity === null ||
      !scopeFrontierMatches(checkpoint.frontier, scopeFrontier)
    ) {
      return unavailable({
        request,
        startedAt,
        frontier: scopeFrontier,
        reason:
          checkpoint.status === "pending"
            ? "GRAPH_SCOPE_PENDING"
            : checkpoint.status === "rebuilding"
              ? "GRAPH_SCOPE_REBUILDING"
              : checkpoint.status === "ready"
                ? "GRAPH_SCOPE_STALE"
                : "GRAPH_SCOPE_UNAVAILABLE",
        work: boundedWork,
      });
    }
    const store = await this.#storeForQuery();
    if (store === null) {
      return unavailable({
        request,
        startedAt,
        frontier: scopeFrontier,
        reason: this.#unavailableReason,
        work: boundedWork,
      });
    }
    let health;
    try {
      health = await store.health();
    } catch (error) {
      return unavailable({
        request,
        startedAt,
        frontier: scopeFrontier,
        reason:
          error instanceof GraphStoreError
            ? error.code
            : "GRAPH_CHILD_EXITED",
        work: boundedWork,
      });
    }
    if (
      health.status === "circuit_open" ||
      (health.status === "ready" &&
        (health.backend_identity === null ||
          canonicalJson(health.backend_identity) !==
            canonicalJson(checkpoint.backend_identity)))
    ) {
      return unavailable({
        request,
        startedAt,
        frontier: scopeFrontier,
        reason:
          health.status === "circuit_open"
            ? "GRAPH_CIRCUIT_OPEN"
            : "GRAPH_IDENTITY_MISMATCH",
        work: boundedWork,
      });
    }

    const relationPattern = this.#policy.relation_pattern.slice(
      0,
      request.relation_max_depth,
    );
    const traversal = await this.#storage.traverseRelations({
      principal_id: request.principal_id,
      scope: request.scope,
      start_revision_ids: starts,
      direction: this.#policy.direction,
      relation_types: [...new Set(relationPattern)],
      max_depth: request.relation_max_depth,
      max_fanout: request.relation_max_fanout,
      as_of: request.as_of,
    });
    const fanoutLimited = traversal.fanout_truncated_count > 0;
    boundedWork.push({
      boundary: "relation_fanout",
      configured_limit: request.relation_max_fanout,
      observed_count: traversal.fanout_observed_count,
      retained_count: traversal.fanout_retained_count,
      truncated_count: traversal.fanout_truncated_count,
      complete: !fanoutLimited,
      ...(fanoutLimited
        ? { reason_code: "RELATION_FANOUT_LIMIT" }
        : {}),
    });
    const observedAllowlist = [
      ...new Set(
        traversal.hits.map((hit) => hit.relation_revision_id),
      ),
    ].sort();
    const allowedRelationIds = observedAllowlist.slice(
      0,
      request.graph_max_relation_allowlist,
    );
    const allowlistLimited =
      allowedRelationIds.length < observedAllowlist.length;
    boundedWork.push({
      boundary: "relation_allowlist",
      configured_limit: request.graph_max_relation_allowlist,
      observed_count: observedAllowlist.length,
      retained_count: allowedRelationIds.length,
      truncated_count:
        observedAllowlist.length - allowedRelationIds.length,
      complete: !allowlistLimited,
      ...(allowlistLimited
        ? { reason_code: "GRAPH_RELATION_ALLOWLIST_LIMIT" }
        : {}),
    });
    const prefilterIncomplete =
      distinctStarts.length > starts.length ||
      fanoutLimited ||
      allowlistLimited;
    if (allowedRelationIds.length === 0) {
      return {
        candidates: [],
        exclusions: [],
        projection_frontier: scalarFrontier(scopeFrontier),
        truncated: prefilterIncomplete,
        reason_codes: [
          "GRAPH_ALLOWLIST_EMPTY",
          ...(distinctStarts.length > starts.length
            ? ["RELATION_START_LIMIT"]
            : []),
          ...(fanoutLimited ? ["RELATION_FANOUT_LIMIT"] : []),
          ...(allowlistLimited
            ? ["GRAPH_RELATION_ALLOWLIST_LIMIT"]
            : []),
        ].sort(),
        bounded_work: boundedWork,
        duration_ms: performance.now() - startedAt,
      };
    }

    const beforeSnapshot = (
      await this.#storage.graphScopeSnapshot({
        backend: "ladybugdb",
        principal_id: request.principal_id,
        scope: request.scope,
      })
    ).snapshot;
    if (beforeSnapshot.logical_digest !== checkpoint.logical_digest) {
      return unavailable({
        request,
        startedAt,
        frontier: scopeFrontier,
        reason: "GRAPH_DIGEST_MISMATCH",
        work: boundedWork,
      });
    }
    let projectedSnapshot;
    try {
      projectedSnapshot = await store.readScopeSnapshot({
        principal_id: request.principal_id,
        scope: request.scope,
      });
    } catch (error) {
      return unavailable({
        request,
        startedAt,
        frontier: scopeFrontier,
        reason:
          error instanceof GraphStoreError
            ? error.code
            : "GRAPH_CHILD_EXITED",
        work: boundedWork,
      });
    }
    if (
      projectedSnapshot === null ||
      projectedSnapshot.logical_digest !== checkpoint.logical_digest ||
      canonicalJson(projectedSnapshot) !== canonicalJson(beforeSnapshot)
    ) {
      return unavailable({
        request,
        startedAt,
        frontier: scopeFrontier,
        reason: "GRAPH_DIGEST_MISMATCH",
        work: boundedWork,
      });
    }
    const query = GraphQuerySchema.parse({
      schema_version: "1.0.0",
      query_id: `graph-query:${canonicalSha256({
        principal_id: request.principal_id,
        scope: request.scope,
        as_of: request.as_of,
        starts,
        allowed_relation_ids: allowedRelationIds,
        relation_pattern: relationPattern,
        mode: this.#policy.mode,
      }).slice("sha256:".length, 58)}`,
      backend: "ladybugdb",
      principal_id: request.principal_id,
      scope: request.scope,
      as_of: request.as_of,
      frontier: checkpoint.frontier,
      mode: this.#policy.mode,
      start_revision_ids: starts,
      allowed_relation_revision_ids: allowedRelationIds,
      relation_pattern: relationPattern,
      max_depth: Math.min(
        request.relation_max_depth,
        relationPattern.length,
      ),
      max_fanout: request.relation_max_fanout,
      max_paths: request.relation_max_paths,
      max_results: Math.min(request.limit, request.relation_max_paths),
      max_relation_allowlist: request.graph_max_relation_allowlist,
      parent_deadline_ms: request.graph_query_timeout_ms,
    });
    const graphResult = await store.queryPaths(query);
    const postQueryHealth = await store.health().catch(() => null);
    const queryHashes = [canonicalSha256(query)];
    const responseBytes = Buffer.byteLength(
      canonicalJson(graphResult),
      "utf8",
    );
    const responseLimited =
      responseBytes > request.graph_max_response_bytes;
    boundedWork.push(...(graphResult.bounded_work ?? []), {
      boundary: "graph_response_bytes",
      configured_limit: request.graph_max_response_bytes,
      observed_count: responseBytes,
      retained_count: responseLimited ? 0 : responseBytes,
      truncated_count: responseLimited ? responseBytes : 0,
      complete: !responseLimited,
      ...(responseLimited
        ? { reason_code: "GRAPH_RESPONSE_BYTES_LIMIT" }
        : {}),
    });
    if (
      responseLimited ||
      graphResult.query_hash !== queryHashes[0] ||
      !scopeFrontierMatches(graphResult.frontier, scopeFrontier) ||
      (graphResult.complete &&
        (postQueryHealth?.status !== "ready" ||
          postQueryHealth.backend_identity === null ||
          canonicalJson(postQueryHealth.backend_identity) !==
            canonicalJson(checkpoint.backend_identity)))
    ) {
      return {
        candidates: [],
        exclusions: [],
        projection_frontier: scalarFrontier(scopeFrontier),
        truncated: true,
        reason_codes: [
          responseLimited
            ? "GRAPH_RESPONSE_BYTES_LIMIT"
            : "GRAPH_PROTOCOL_INVALID",
        ],
        bounded_work: boundedWork,
        duration_ms: performance.now() - startedAt,
        query_hashes: queryHashes,
      };
    }

    const [afterCheckpoint, afterSnapshot] = await Promise.all([
      this.#storage.graphProjectionCheckpoint({
        backend: "ladybugdb",
        principal_id: request.principal_id,
        scope: request.scope,
      }),
      this.#storage.graphScopeSnapshot({
        backend: "ladybugdb",
        principal_id: request.principal_id,
        scope: request.scope,
      }).catch(() => null),
    ]);
    if (
      afterSnapshot === null ||
      canonicalJson(afterCheckpoint) !== canonicalJson(checkpoint) ||
      afterSnapshot.snapshot.logical_digest !== checkpoint.logical_digest
    ) {
      return {
        candidates: [],
        exclusions: graphResult.paths.map((path) => ({
          memory_id: `graph-path:${path.path_hash.slice("sha256:".length, 54)}`,
          revision_id:
            `graph-proof:${path.path_hash.slice("sha256:".length, 54)}`,
          lane: "relation_graph",
          reason_code: "GRAPH_POSTVALIDATION_FAILED",
          score: path.depth,
          graph_path: path,
        })),
        projection_frontier: scalarFrontier(scopeFrontier),
        truncated: true,
        reason_codes: ["GRAPH_POSTVALIDATION_FAILED"],
        bounded_work: boundedWork,
        duration_ms: performance.now() - startedAt,
        query_hashes: queryHashes,
      };
    }

    const currentSnapshot = afterSnapshot.snapshot;
    const nodes = new Map(
      currentSnapshot.nodes.map((node) => [node.revision_id, node]),
    );
    const edges = new Map(
      currentSnapshot.edges.map((edge) => [
        edge.relation_revision_id,
        edge,
      ]),
    );
    const page = await this.#storage.queryProjectionPage({
      principal_id: request.principal_id,
      scope: request.scope,
      projection_types: ["relation"],
      projection_revision_ids: allowedRelationIds,
      as_of: request.as_of,
      limit: allowedRelationIds.length,
    });
    const projections = new Map(
      page.items.map((projection) => [
        projection.projection_revision_id,
        projection,
      ]),
    );
    const eligiblePaths: Array<{
      path: GraphPathEvidence;
      projection: ProjectionRevision;
    }> = [];
    const exclusions: GraphLaneRetrievalResult["exclusions"] = [];
    for (const path of graphResult.paths) {
      let projection: ProjectionRevision | undefined;
      let valid =
        path.depth <= request.relation_max_depth &&
        path.relation_types.every(
          (type, index) => type === relationPattern[index],
        ) &&
        path.relation_revision_ids.every((id) =>
          allowedRelationIds.includes(id)
        );
      for (const [index, relationId] of
        path.relation_revision_ids.entries()) {
        const edge = edges.get(relationId);
        const currentProjection = projections.get(relationId);
        const source = path.node_revision_ids[index];
        const target = path.node_revision_ids[index + 1];
        if (
          edge === undefined ||
          currentProjection === undefined ||
          source === undefined ||
          target === undefined ||
          edge.source_revision_id !== source ||
          edge.target_revision_id !== target ||
          !validAt(edge.validity, request.as_of) ||
          !projectionMatchesEdge(currentProjection, edge) ||
          !scopeFrontierMatches(
            currentProjection.frontier,
            scopeFrontier,
          )
        ) {
          valid = false;
          break;
        }
        projection = currentProjection;
      }
      for (const nodeId of path.node_revision_ids) {
        const node = nodes.get(nodeId);
        if (
          node === undefined ||
          node.lifecycle !== "active" ||
          node.principal_id !== request.principal_id ||
          scopeKey(node.scope) !== scopeKey(request.scope) ||
          !validAt(node.validity, request.as_of) ||
          !scopeFrontierMatches(
            {
              ledger_epoch: node.ledger_epoch,
              tombstone_epoch: node.tombstone_epoch,
              projection_epoch: node.projection_epoch,
              source_frontier_hash:
                currentSnapshot.frontier.source_frontier_hash,
              projection_frontier_hash:
                currentSnapshot.frontier.projection_frontier_hash,
              transform: node.transform,
            },
            scopeFrontier,
          )
        ) {
          valid = false;
          break;
        }
      }
      if (!valid || projection === undefined) {
        exclusions.push({
          memory_id: `graph-path:${path.path_hash.slice("sha256:".length, 54)}`,
          revision_id:
            `graph-proof:${path.path_hash.slice("sha256:".length, 54)}`,
          lane: "relation_graph",
          reason_code: "GRAPH_POSTVALIDATION_FAILED",
          score: path.depth,
          graph_path: path,
        });
        continue;
      }
      eligiblePaths.push({ path, projection });
    }

    const incomplete =
      prefilterIncomplete ||
      !graphResult.complete ||
      exclusions.length > 0;
    const reasonCodes = [
      ...(distinctStarts.length > starts.length
        ? ["RELATION_START_LIMIT"]
        : []),
      ...(fanoutLimited ? ["RELATION_FANOUT_LIMIT"] : []),
      ...(allowlistLimited
        ? ["GRAPH_RELATION_ALLOWLIST_LIMIT"]
        : []),
      ...graphResult.reason_codes,
      ...(exclusions.length > 0
        ? ["GRAPH_POSTVALIDATION_FAILED"]
        : []),
    ];
    return {
      candidates: eligiblePaths.map(({ path, projection }, index) => ({
        kind: "projection",
        lane: "relation_graph",
        projection,
        rank: path.depth * 1_000 + index,
        graph_path: path,
      })),
      exclusions,
      projection_frontier: scalarFrontier(scopeFrontier),
      truncated: incomplete,
      reason_codes: [...new Set(reasonCodes)].sort(),
      bounded_work: boundedWork,
      duration_ms: performance.now() - startedAt,
      query_hashes: queryHashes,
    };
  }

  async close(): Promise<void> {
    const pending = this.#storePromise;
    const store =
      this.#store ??
      (pending === null
        ? null
        : await pending.catch(() => null));
    this.#store = null;
    this.#storePromise = null;
    this.#storeFactoryFailed = true;
    if (store !== null) {
      await store.close();
    }
  }

  async #storeForQuery(): Promise<GraphStore | null> {
    if (this.#store !== null) {
      return this.#store;
    }
    if (this.#storeFactory === null || this.#storeFactoryFailed) {
      return null;
    }
    if (this.#storePromise === null) {
      this.#storePromise = this.#storeFactory();
    }
    try {
      this.#store = await this.#storePromise;
      return this.#store;
    } catch (error) {
      this.#storePromise = null;
      this.#storeFactoryFailed = true;
      this.#unavailableReason =
        error instanceof GraphStoreError
          ? error.code
          : "GRAPH_PROCESS_START_FAILED";
      return null;
    }
  }
}
