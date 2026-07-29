import {
  canonicalJson,
  type BoundedWorkTelemetry,
  type GraphPathEvidence,
  type ProjectionRevision,
  type RecallLane,
  type Scope,
} from "@memo-graph/contracts";
import type {
  GovernedMemorySearchResult,
  ProjectionPageCursor,
  ProjectionScopeStorageFrontier,
  ProjectionStorageFrontier,
  SqliteStorageClient,
} from "@memo-graph/storage-sqlite";

export type LaneRetrieverRequest = {
  lane: RecallLane;
  principal_id: string;
  scope: Scope;
  query: string;
  as_of: string;
  include_sensitive: boolean;
  limit: number;
  projection_scan_limit: number;
  relation_max_depth: number;
  relation_max_fanout: number;
  relation_max_starts: number;
  relation_max_paths: number;
  graph_max_relation_allowlist: number;
  graph_query_timeout_ms: number;
  graph_max_response_bytes: number;
  start_revision_ids: string[];
};

export type RawMemoryLaneCandidate = {
  kind: "memory";
  lane: "recent_l1";
  memory: GovernedMemorySearchResult["items"][number]["item"];
  rank: number;
};

export type RawProjectionLaneCandidate = {
  kind: "projection";
  lane: Exclude<RecallLane, "recent_l1">;
  projection: ProjectionRevision;
  rank: number;
  graph_path?: GraphPathEvidence;
};

export type RawLaneCandidate =
  | RawMemoryLaneCandidate
  | RawProjectionLaneCandidate;

export type RawLaneExclusion = {
  memory_id: string;
  revision_id: string;
  lane: RecallLane;
  reason_code: string;
  score: number | null;
  graph_path?: GraphPathEvidence;
};

export type LaneRetrievalResult = {
  candidates: RawLaneCandidate[];
  exclusions: RawLaneExclusion[];
  projection_frontier: ProjectionStorageFrontier | null;
  truncated: boolean;
  reason_codes: string[];
  bounded_work?: BoundedWorkTelemetry[];
  duration_ms?: number;
  query_hashes?: string[];
};

export interface RecallLaneRetriever {
  retrieve(request: LaneRetrieverRequest): Promise<LaneRetrievalResult>;
}

export interface GraphLaneRetriever {
  retrieve(
    request: LaneRetrieverRequest & { lane: "relation_graph" },
  ): Promise<LaneRetrievalResult>;
}

function queryTerms(query: string): string[] {
  return (
    query.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ??
    []
  ).slice(0, 32);
}

function matchesQuery(
  projection: ProjectionRevision,
  terms: string[],
): boolean {
  if (projection.content?.storage !== "inline") {
    return false;
  }
  const searchable = projection.content.text
    .normalize("NFKC")
    .toLocaleLowerCase();
  return terms.every((term) => searchable.includes(term));
}

const PROJECTION_TYPES_BY_LANE = {
  topic: ["topic"],
  scenario_procedure: ["scenario", "procedure"],
  core: ["core"],
} as const;

function scalarFrontier(
  frontier: ProjectionScopeStorageFrontier,
): ProjectionStorageFrontier {
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

export class LayeredLaneRetrievers implements RecallLaneRetriever {
  readonly #storage: SqliteStorageClient;
  readonly #graphRetriever: GraphLaneRetriever | null;

  constructor(
    storage: SqliteStorageClient,
    options: {
      graphRetriever?: GraphLaneRetriever;
    } = {},
  ) {
    this.#storage = storage;
    this.#graphRetriever = options.graphRetriever ?? null;
  }

  async retrieve(
    request: LaneRetrieverRequest,
  ): Promise<LaneRetrievalResult> {
    if (request.lane === "recent_l1") {
      return this.#recentL1(request);
    }
    if (request.lane === "relation_sqlite") {
      return this.#relations(request);
    }
    if (request.lane === "relation_graph") {
      if (this.#graphRetriever === null) {
        throw new Error("graph lane runtime is not configured");
      }
      return this.#graphRetriever.retrieve({
        ...request,
        lane: "relation_graph",
      });
    }
    return this.#projections(request);
  }

  async #recentL1(
    request: LaneRetrieverRequest,
  ): Promise<LaneRetrievalResult> {
    const result = await this.#storage.searchGovernedMemory({
      query: request.query,
      principal_id: request.principal_id,
      scope: request.scope,
      as_of: request.as_of,
      include_sensitive: request.include_sensitive,
      context_scope: request.scope,
      limit: request.limit,
    });
    return {
      candidates: result.items.slice(0, request.limit).map((item) => ({
        kind: "memory",
        lane: "recent_l1",
        memory: item.item,
        rank: item.rank,
      })),
      exclusions: result.exclusions.map((item) => ({
        memory_id: item.memory_id,
        revision_id: item.revision_id,
        lane: "recent_l1",
        reason_code: item.reason_code,
        score: item.score,
      })),
      projection_frontier: null,
      truncated: result.items.length > request.limit,
      reason_codes: result.degraded_lanes.map(
        (lane) => `LOWER_LANE_DEGRADED:${lane}`,
      ),
    };
  }

  async #projections(
    request: LaneRetrieverRequest,
  ): Promise<LaneRetrievalResult> {
    if (
      request.lane === "recent_l1" ||
      request.lane === "relation_sqlite" ||
      request.lane === "relation_graph"
    ) {
      throw new Error("projection retriever received an invalid lane");
    }
    const lane = request.lane;
    const scopeFrontier = await this.#storage.projectionScopeFrontier({
      principal_id: request.principal_id,
      scope: request.scope,
    });
    if (scopeFrontier.status === "pending") {
      return {
        candidates: [],
        exclusions: [],
        projection_frontier: scalarFrontier(scopeFrontier),
        truncated: false,
        reason_codes: ["PROJECTION_SCOPE_PENDING"],
      };
    }
    if (scopeFrontier.status !== "ready") {
      throw new Error(
        `projection scope is ${scopeFrontier.status}`,
      );
    }
    const terms = queryTerms(request.query);
    const matched: ProjectionRevision[] = [];
    let cursor: ProjectionPageCursor | undefined;
    let examined = 0;
    let total = 0;
    let exhausted = false;
    let frontier: ProjectionStorageFrontier | null = null;
    while (
      examined < request.projection_scan_limit &&
      matched.length <= request.limit &&
      !exhausted
    ) {
      const page = await this.#storage.queryProjectionPage({
        principal_id: request.principal_id,
        scope: request.scope,
        projection_types: [...PROJECTION_TYPES_BY_LANE[lane]],
        as_of: request.as_of,
        limit: Math.min(
          request.limit + 1,
          request.projection_scan_limit - examined,
        ),
        ...(cursor === undefined ? {} : { cursor }),
      });
      frontier = scalarFrontier(page.scope_frontier);
      total = page.total_count;
      examined += page.examined_count;
      matched.push(
        ...page.items.filter((projection) =>
          matchesQuery(projection, terms)
        ),
      );
      exhausted = page.exhausted;
      if (
        !page.exhausted &&
        page.next_cursor === null
      ) {
        throw new Error("incomplete projection page omitted its cursor");
      }
      cursor = page.next_cursor ?? undefined;
    }
    if (frontier === null) {
      throw new Error("projection scan produced no frontier");
    }
    const scanLimited =
      !exhausted &&
      matched.length <= request.limit &&
      examined >= request.projection_scan_limit;
    const returnLimited = matched.length > request.limit;
    const reasonCodes = [
      ...(scanLimited ? ["PROJECTION_SCAN_LIMIT"] : []),
      ...(returnLimited ? ["LANE_CANDIDATE_LIMIT"] : []),
    ];
    return {
      candidates: matched.slice(0, request.limit).map(
        (projection, index) => ({
          kind: "projection",
          lane,
          projection,
          rank: index,
        }),
      ),
      exclusions: [],
      projection_frontier: frontier,
      truncated: scanLimited || returnLimited,
      reason_codes: reasonCodes,
      bounded_work: [
        {
          boundary: "projection_scan",
          configured_limit: request.projection_scan_limit,
          observed_count: total,
          retained_count: examined,
          truncated_count: Math.max(0, total - examined),
          complete: !scanLimited,
          ...(scanLimited
            ? { reason_code: "PROJECTION_SCAN_LIMIT" }
            : {}),
        },
        {
          boundary: "projection_return",
          configured_limit: request.limit,
          observed_count: matched.length,
          retained_count: Math.min(matched.length, request.limit),
          truncated_count: Math.max(0, matched.length - request.limit),
          complete: !returnLimited,
          ...(returnLimited
            ? { reason_code: "LANE_CANDIDATE_LIMIT" }
            : {}),
        },
      ],
    };
  }

  async #relations(
    request: LaneRetrieverRequest,
  ): Promise<LaneRetrievalResult> {
    const distinctStarts = [...new Set(request.start_revision_ids)].sort();
    const starts = distinctStarts.slice(0, request.relation_max_starts);
    const startLimited = starts.length < distinctStarts.length;
    const startWork = {
      boundary: "relation_starts" as const,
      configured_limit: request.relation_max_starts,
      observed_count: distinctStarts.length,
      retained_count: starts.length,
      truncated_count: distinctStarts.length - starts.length,
      complete: !startLimited,
      ...(startLimited
        ? { reason_code: "RELATION_START_LIMIT" }
        : {}),
    };
    if (distinctStarts.length === 0) {
      return {
        candidates: [],
        exclusions: [],
        projection_frontier: null,
        truncated: false,
        reason_codes: ["RELATION_START_EMPTY"],
        bounded_work: [startWork],
      };
    }
    const scopeFrontier = await this.#storage.projectionScopeFrontier({
      principal_id: request.principal_id,
      scope: request.scope,
    });
    if (scopeFrontier.status === "pending") {
      return {
        candidates: [],
        exclusions: [],
        projection_frontier: scalarFrontier(scopeFrontier),
        truncated: startLimited,
        reason_codes: [
          "PROJECTION_SCOPE_PENDING",
          ...(startLimited ? ["RELATION_START_LIMIT"] : []),
        ].sort(),
        bounded_work: [startWork],
      };
    }
    if (scopeFrontier.status !== "ready") {
      throw new Error(
        `projection scope is ${scopeFrontier.status}`,
      );
    }
    const traversal = await this.#storage.traverseRelations({
      principal_id: request.principal_id,
      scope: request.scope,
      start_revision_ids: starts,
      direction: "both",
      max_depth: request.relation_max_depth,
      max_fanout: request.relation_max_fanout,
      as_of: request.as_of,
    });
    const hitDepth = new Map(
      traversal.hits.map((hit) => [hit.relation_revision_id, hit.depth]),
    );
    const relationRevisionIds = [...hitDepth.keys()].sort();
    if (relationRevisionIds.length > 100_000) {
      throw new Error("relation projection membership exceeds storage cap");
    }
    const page =
      relationRevisionIds.length === 0
        ? null
        : await this.#storage.queryProjectionPage({
            principal_id: request.principal_id,
            scope: request.scope,
            projection_types: ["relation"],
            projection_revision_ids: relationRevisionIds,
            as_of: request.as_of,
            limit: relationRevisionIds.length,
          });
    const relations = (page?.items ?? [])
      .sort(
        (left, right) =>
          (hitDepth.get(left.projection_revision_id) ?? 0) -
            (hitDepth.get(right.projection_revision_id) ?? 0) ||
          canonicalJson(left.payload).localeCompare(
            canonicalJson(right.payload),
          ) ||
          left.projection_revision_id.localeCompare(
            right.projection_revision_id,
          ),
      );
    const returnLimited = relations.length > request.limit;
    const fanoutLimited = traversal.fanout_truncated_count > 0;
    const truncated = startLimited || fanoutLimited || returnLimited;
    const reasonCodes = [
      ...(startLimited ? ["RELATION_START_LIMIT"] : []),
      ...(fanoutLimited ? ["RELATION_FANOUT_LIMIT"] : []),
      ...(returnLimited ? ["LANE_CANDIDATE_LIMIT"] : []),
    ].sort();
    return {
      candidates: relations.slice(0, request.limit).map(
        (projection, index) => ({
          kind: "projection",
          lane: "relation_sqlite",
          projection,
          rank: (hitDepth.get(projection.projection_revision_id) ?? 0) *
            1_000 +
            index,
        }),
      ),
      exclusions: [],
      projection_frontier:
        page === null
          ? scalarFrontier(scopeFrontier)
          : scalarFrontier(page.scope_frontier),
      truncated,
      reason_codes: reasonCodes,
      bounded_work: [
        startWork,
        {
          boundary: "relation_fanout",
          configured_limit: request.relation_max_fanout,
          observed_count: traversal.fanout_observed_count,
          retained_count: traversal.fanout_retained_count,
          truncated_count: traversal.fanout_truncated_count,
          complete: !fanoutLimited,
          ...(fanoutLimited
            ? { reason_code: "RELATION_FANOUT_LIMIT" }
            : {}),
        },
      ],
    };
  }
}
