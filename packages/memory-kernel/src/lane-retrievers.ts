import {
  canonicalJson,
  type ProjectionRevision,
  type RecallLane,
  type Scope,
} from "@memo-graph/contracts";
import type {
  GovernedMemorySearchResult,
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
  relation_max_depth: number;
  relation_max_fanout: number;
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
};

export type LaneRetrievalResult = {
  candidates: RawLaneCandidate[];
  exclusions: RawLaneExclusion[];
  projection_frontier: ProjectionStorageFrontier | null;
  truncated: boolean;
  reason_codes: string[];
};

export interface RecallLaneRetriever {
  retrieve(request: LaneRetrieverRequest): Promise<LaneRetrievalResult>;
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

export class LayeredLaneRetrievers implements RecallLaneRetriever {
  readonly #storage: SqliteStorageClient;

  constructor(storage: SqliteStorageClient) {
    this.#storage = storage;
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
      request.lane === "relation_sqlite"
    ) {
      throw new Error("projection retriever received an invalid lane");
    }
    const lane = request.lane;
    const result = await this.#storage.queryProjections({
      principal_id: request.principal_id,
      scope: request.scope,
      projection_types: [...PROJECTION_TYPES_BY_LANE[lane]],
      as_of: request.as_of,
      limit: request.limit + 1,
    });
    const terms = queryTerms(request.query);
    const matched = result.items.filter((projection) =>
      matchesQuery(projection, terms)
    );
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
      projection_frontier: result.frontier,
      truncated: matched.length > request.limit,
      reason_codes:
        matched.length > request.limit ? ["LANE_CANDIDATE_LIMIT"] : [],
    };
  }

  async #relations(
    request: LaneRetrieverRequest,
  ): Promise<LaneRetrievalResult> {
    if (request.start_revision_ids.length === 0) {
      return {
        candidates: [],
        exclusions: [],
        projection_frontier: null,
        truncated: false,
        reason_codes: ["RELATION_START_EMPTY"],
      };
    }
    const starts = [...new Set(request.start_revision_ids)]
      .sort()
      .slice(0, 100);
    const traversal = await this.#storage.traverseRelations({
      principal_id: request.principal_id,
      scope: request.scope,
      start_revision_ids: starts,
      direction: "both",
      max_depth: request.relation_max_depth,
      max_fanout: request.relation_max_fanout,
      as_of: request.as_of,
    });
    const query = await this.#storage.queryProjections({
      principal_id: request.principal_id,
      scope: request.scope,
      projection_types: ["relation"],
      as_of: request.as_of,
      limit: Math.min(1_000, request.limit * 10),
    });
    const hitDepth = new Map(
      traversal.hits.map((hit) => [hit.relation_revision_id, hit.depth]),
    );
    const relations = query.items
      .filter((projection) =>
        hitDepth.has(projection.projection_revision_id)
      )
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
    const truncated =
      traversal.truncated || relations.length > request.limit;
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
      projection_frontier: query.frontier,
      truncated,
      reason_codes: truncated ? ["RELATION_TRUNCATED"] : [],
    };
  }
}
