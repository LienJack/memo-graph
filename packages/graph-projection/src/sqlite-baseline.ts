import {
  GraphQueryResultSchema,
  GraphQuerySchema,
  GraphScopeSnapshotSchema,
  buildGraphPathEvidence,
  canonicalJson,
  canonicalSha256,
  type GraphEdge,
  type GraphPathEvidence,
  type GraphQueryResult,
} from "@memo-graph/contracts";

import { GraphStoreError } from "./graph-store.js";

type TraversalState = {
  node_revision_ids: string[];
  relation_revision_ids: string[];
  relation_types: GraphEdge["relation_type"][];
  used_edges: Set<string>;
};

export function queryGraphSnapshotReference(options: {
  snapshot: unknown;
  query: unknown;
  elapsedMs?: number;
}): GraphQueryResult {
  const snapshot = GraphScopeSnapshotSchema.parse(options.snapshot);
  const query = GraphQuerySchema.parse(options.query);
  if (
    query.backend !== snapshot.backend ||
    query.principal_id !== snapshot.principal_id ||
    canonicalJson(query.scope) !== canonicalJson(snapshot.scope) ||
    canonicalJson(query.frontier) !== canonicalJson(snapshot.frontier)
  ) {
    throw new GraphStoreError("GRAPH_SCOPE_STALE");
  }

  const nodes = new Set(snapshot.nodes.map((node) => node.revision_id));
  const allowedEdges = new Set(query.allowed_relation_revision_ids);
  const adjacency = new Map<string, GraphEdge[]>();
  for (const edge of snapshot.edges) {
    if (!allowedEdges.has(edge.relation_revision_id)) {
      continue;
    }
    const edges = adjacency.get(edge.source_revision_id) ?? [];
    edges.push(edge);
    adjacency.set(edge.source_revision_id, edges);
  }
  for (const edges of adjacency.values()) {
    edges.sort((left, right) =>
      canonicalJson([
        left.relation_type,
        left.relation_revision_id,
        left.graph_edge_id,
      ]).localeCompare(
        canonicalJson([
          right.relation_type,
          right.relation_revision_id,
          right.graph_edge_id,
        ]),
      )
    );
  }

  const nativePathLimit = Math.min(
    query.max_paths + 1,
    query.max_results + 1,
    query.max_fanout * query.start_revision_ids.length + 1,
  );
  const paths: GraphPathEvidence[] = [];
  const walk = (state: TraversalState): void => {
    if (paths.length >= nativePathLimit) {
      return;
    }
    const depth = state.relation_revision_ids.length;
    if (depth > 0) {
      paths.push(buildGraphPathEvidence({
        node_revision_ids: state.node_revision_ids,
        relation_revision_ids: state.relation_revision_ids,
        relation_types: state.relation_types,
        depth,
      }));
    }
    if (
      depth >= query.max_depth ||
      depth >= query.relation_pattern.length
    ) {
      return;
    }
    const current = state.node_revision_ids.at(-1);
    if (current === undefined) {
      return;
    }
    const expectedType = query.relation_pattern[depth];
    for (const edge of adjacency.get(current) ?? []) {
      if (
        paths.length >= nativePathLimit ||
        edge.relation_type !== expectedType ||
        state.used_edges.has(edge.relation_revision_id) ||
        !nodes.has(edge.target_revision_id)
      ) {
        continue;
      }
      walk({
        node_revision_ids: [
          ...state.node_revision_ids,
          edge.target_revision_id,
        ],
        relation_revision_ids: [
          ...state.relation_revision_ids,
          edge.relation_revision_id,
        ],
        relation_types: [...state.relation_types, edge.relation_type],
        used_edges: new Set([
          ...state.used_edges,
          edge.relation_revision_id,
        ]),
      });
    }
  };
  for (const start of query.start_revision_ids) {
    if (nodes.has(start)) {
      walk({
        node_revision_ids: [start],
        relation_revision_ids: [],
        relation_types: [],
        used_edges: new Set(),
      });
    }
  }

  let ordered = [...new Map(
    paths.map((path) => [path.path_hash, path]),
  ).values()].sort(
    (left, right) =>
      left.depth - right.depth ||
      left.path_hash.localeCompare(right.path_hash),
  );
  if (query.mode === "shortest_path" && ordered[0] !== undefined) {
    const shortest = ordered[0].depth;
    ordered = ordered.filter((path) => path.depth === shortest);
  }
  const observedCount = ordered.length;
  const retainedLimit = Math.min(query.max_paths, query.max_results);
  const truncated =
    paths.length >= nativePathLimit || observedCount > retainedLimit;
  ordered = ordered.slice(0, retainedLimit);
  const elapsedMs = Math.max(0, options.elapsedMs ?? 0);
  return GraphQueryResultSchema.parse({
    schema_version: "1.0.0",
    query_id: query.query_id,
    status: truncated ? "degraded" : "complete",
    query_hash: canonicalSha256(query),
    frontier: query.frontier,
    paths: ordered,
    elapsed_ms: elapsedMs,
    complete: !truncated,
    reason_codes: truncated ? ["GRAPH_RESULT_LIMIT"] : [],
    process_outcome: "completed",
    bounded_work: [
      {
        boundary: "graph_results",
        configured_limit: retainedLimit,
        observed_count: Math.max(observedCount, paths.length),
        retained_count: ordered.length,
        truncated_count: Math.max(
          0,
          Math.max(observedCount, paths.length) - ordered.length,
        ),
        complete: !truncated,
        ...(truncated ? { reason_code: "GRAPH_RESULT_LIMIT" } : {}),
      },
      {
        boundary: "graph_wall_clock",
        configured_limit: query.parent_deadline_ms,
        observed_count: Math.ceil(elapsedMs),
        retained_count: Math.min(
          Math.ceil(elapsedMs),
          query.parent_deadline_ms,
        ),
        truncated_count: Math.max(
          0,
          Math.ceil(elapsedMs) - query.parent_deadline_ms,
        ),
        complete: elapsedMs <= query.parent_deadline_ms,
        ...(elapsedMs > query.parent_deadline_ms
          ? { reason_code: "GRAPH_DEADLINE_EXCEEDED" }
          : {}),
      },
    ],
  });
}
