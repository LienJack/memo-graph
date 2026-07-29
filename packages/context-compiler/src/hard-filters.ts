import {
  canonicalJson,
  scopeKey,
  type ContextFrontier,
  type GraphPathEvidence,
  type ProjectionLineageRef,
  type ProjectionPayload,
  type ProjectionRevision,
  type RecallLane,
  type Scope,
  type GovernedSearchItemSchema,
} from "@memo-graph/contracts";

type GovernedSearchItem = ReturnType<
  typeof GovernedSearchItemSchema.parse
>;

export type LayeredMemoryCandidate = {
  kind: "memory";
  abstraction: "l1_memory";
  lane: "recent_l1";
  scope: Scope;
  rank: number;
  canonical_revalidated: boolean;
  memory: GovernedSearchItem;
};

export type LayeredProjectionCandidate = {
  kind: "projection";
  abstraction:
    | "l2_topic"
    | "l2_scenario"
    | "l2_relation"
    | "l3_core";
  lane: Exclude<RecallLane, "recent_l1">;
  scope: Scope;
  rank: number;
  canonical_revalidated: boolean;
  projection: ProjectionRevision;
  graph_path?: GraphPathEvidence;
};

export type LayeredCompilerCandidate =
  | LayeredMemoryCandidate
  | LayeredProjectionCandidate;

export type PreparedLayeredCandidate = {
  candidate: LayeredCompilerCandidate;
  memory_id: string;
  revision_id: string;
  abstraction: LayeredCompilerCandidate["abstraction"];
  lane: RecallLane;
  scope: Scope;
  lifecycle: "active";
  authority: GovernedSearchItem["authority"];
  sensitivity: GovernedSearchItem["sensitivity"];
  recorded_at: string;
  content: GovernedSearchItem["content"];
  evidence_ids: string[];
  rank: number;
  projection: ProjectionLineageRef | null;
  graph_path: GraphPathEvidence | null;
  projection_payload: ProjectionPayload | null;
  conflict_group_id: string | null;
  decision_reason_codes: string[];
};

export type LayeredCandidateExclusion = {
  candidate: LayeredCompilerCandidate;
  memory_id: string;
  revision_id: string;
  lane: RecallLane;
  reason_code: string;
  score: number | null;
  graph_path?: GraphPathEvidence;
};

const LANE_BY_ABSTRACTION = {
  l2_topic: "topic",
  l2_scenario: "scenario_procedure",
  l3_core: "core",
} as const;

function laneMatchesAbstraction(
  lane: RecallLane,
  abstraction: LayeredProjectionCandidate["abstraction"],
): boolean {
  if (abstraction === "l2_relation") {
    return lane === "relation_sqlite" || lane === "relation_graph";
  }
  return lane === LANE_BY_ABSTRACTION[abstraction];
}

function projectionLineage(
  projection: ProjectionRevision,
): ProjectionLineageRef {
  return {
    projection_id: projection.projection_id,
    projection_revision_id: projection.projection_revision_id,
    source_revision_ids: projection.source_revisions.map(
      (source) => source.revision_id,
    ),
    source_content_hashes: projection.source_revisions.map(
      (source) => source.content_hash,
    ),
    transform: projection.transform,
    frontier: projection.frontier,
  };
}

function sameProjectionFrontier(
  projection: ProjectionRevision,
  frontier: ContextFrontier,
): boolean {
  if ("scope_frontiers" in frontier) {
    const scoped = frontier.scope_frontiers.find(
      (candidate) => scopeKey(candidate.scope) === scopeKey(projection.scope),
    );
    return (
      scoped !== undefined &&
      projection.frontier.ledger_epoch === frontier.ledger_epoch &&
      projection.frontier.tombstone_epoch === frontier.tombstone_epoch &&
      projection.frontier.projection_epoch === scoped.projection_epoch &&
      projection.frontier.source_frontier_hash ===
        scoped.source_frontier_hash &&
      projection.frontier.projection_frontier_hash ===
        scoped.projection_frontier_hash &&
      scoped.transform_versions.some(
        (transform) =>
          transform.name === projection.transform.name &&
          transform.version === projection.transform.version,
      )
    );
  }
  return (
    projection.frontier.ledger_epoch === frontier.ledger_epoch &&
    projection.frontier.tombstone_epoch === frontier.tombstone_epoch &&
    projection.frontier.projection_epoch === frontier.projection_epoch &&
    projection.frontier.source_frontier_hash ===
      frontier.source_frontier_hash &&
    projection.frontier.projection_frontier_hash ===
      frontier.projection_frontier_hash &&
    frontier.transform_versions.some(
      (transform) =>
        transform.name === projection.transform.name &&
        transform.version === projection.transform.version,
    )
  );
}

function exclusion(
  candidate: LayeredCompilerCandidate,
  reasonCode: string,
): LayeredCandidateExclusion {
  return {
    candidate,
    memory_id:
      candidate.kind === "memory"
        ? candidate.memory.memory_id
        : candidate.projection.projection_id,
    revision_id:
      candidate.kind === "memory"
        ? candidate.memory.revision_id
        : candidate.projection.projection_revision_id,
    lane: candidate.lane,
    reason_code: reasonCode,
    score: candidate.rank,
    ...(candidate.kind === "projection" &&
        candidate.graph_path !== undefined
      ? { graph_path: candidate.graph_path }
      : {}),
  };
}

export function hardFilterLayeredCandidates(options: {
  candidates: LayeredCompilerCandidate[];
  allowed_scopes: Scope[];
  as_of: string;
  include_sensitive: boolean;
  frontier: ContextFrontier;
}): {
  eligible: PreparedLayeredCandidate[];
  exclusions: LayeredCandidateExclusion[];
} {
  const allowedScopes = new Set(options.allowed_scopes.map(scopeKey));
  const eligible: PreparedLayeredCandidate[] = [];
  const exclusions: LayeredCandidateExclusion[] = [];

  for (const candidate of options.candidates) {
    if (!candidate.canonical_revalidated) {
      exclusions.push(
        exclusion(candidate, "CANONICAL_REVALIDATION_REQUIRED"),
      );
      continue;
    }
    if (!allowedScopes.has(scopeKey(candidate.scope))) {
      exclusions.push(exclusion(candidate, "SCOPE_EXCLUDED"));
      continue;
    }
    if (candidate.kind === "memory") {
      const memory = candidate.memory;
      if (
        scopeKey(memory.scope) !== scopeKey(candidate.scope) ||
        memory.lifecycle !== "active"
      ) {
        exclusions.push(exclusion(candidate, "CANONICAL_SOURCE_CHANGED"));
        continue;
      }
      if (
        Date.parse(memory.validity.valid_from) > Date.parse(options.as_of) ||
        (memory.validity.valid_to !== null &&
          Date.parse(memory.validity.valid_to) <=
            Date.parse(options.as_of))
      ) {
        exclusions.push(exclusion(candidate, "OUTSIDE_VALIDITY"));
        continue;
      }
      if (
        memory.sensitivity === "secret" ||
        (memory.sensitivity === "sensitive" &&
          !options.include_sensitive)
      ) {
        exclusions.push(exclusion(candidate, "SENSITIVITY_EXCLUDED"));
        continue;
      }
      if (memory.content.storage !== "inline") {
        exclusions.push(exclusion(candidate, "CONTENT_NOT_INLINE"));
        continue;
      }
      eligible.push({
        candidate,
        memory_id: memory.memory_id,
        revision_id: memory.revision_id,
        abstraction: "l1_memory",
        lane: "recent_l1",
        scope: memory.scope,
        lifecycle: "active",
        authority: memory.authority,
        sensitivity: memory.sensitivity,
        recorded_at: memory.validity.recorded_at,
        content: memory.content,
        evidence_ids: [...memory.evidence_ids],
        rank: candidate.rank,
        projection: null,
        graph_path: null,
        projection_payload: null,
        conflict_group_id: null,
        decision_reason_codes: [
          "CANONICAL_REVALIDATED",
          ...memory.reason_codes,
        ],
      });
      continue;
    }

    const projection = candidate.projection;
    if (
      projection.principal_id.length === 0 ||
      scopeKey(projection.scope) !== scopeKey(candidate.scope) ||
      projection.lifecycle !== "active" ||
      projection.payload === null ||
      projection.content?.storage !== "inline"
    ) {
      exclusions.push(exclusion(candidate, "PROJECTION_INELIGIBLE"));
      continue;
    }
    if (
      !laneMatchesAbstraction(candidate.lane, projection.abstraction) ||
      candidate.abstraction !== projection.abstraction
    ) {
      exclusions.push(exclusion(candidate, "PROJECTION_LANE_MISMATCH"));
      continue;
    }
    if (!sameProjectionFrontier(projection, options.frontier)) {
      exclusions.push(exclusion(candidate, "PROJECTION_STALE_FRONTIER"));
      continue;
    }
    if (
      projection.sensitivity === "secret" ||
      (projection.sensitivity === "sensitive" &&
        !options.include_sensitive)
    ) {
      exclusions.push(exclusion(candidate, "SENSITIVITY_EXCLUDED"));
      continue;
    }
    if (
      Date.parse(projection.validity.valid_from) >
        Date.parse(options.as_of) ||
      (projection.validity.valid_to !== null &&
        Date.parse(projection.validity.valid_to) <=
          Date.parse(options.as_of))
    ) {
      exclusions.push(exclusion(candidate, "OUTSIDE_VALIDITY"));
      continue;
    }
    eligible.push({
      candidate,
      memory_id: projection.projection_id,
      revision_id: projection.projection_revision_id,
      abstraction: projection.abstraction,
      lane: candidate.lane,
      scope: projection.scope,
      lifecycle: "active",
      authority: projection.authority,
      sensitivity: projection.sensitivity,
      recorded_at: projection.validity.recorded_at,
      content: projection.content,
      evidence_ids: [...projection.evidence_ids],
      rank: candidate.rank,
      projection: projectionLineage(projection),
      graph_path: candidate.graph_path ?? null,
      projection_payload: projection.payload,
      conflict_group_id: null,
      decision_reason_codes: [
        "CANONICAL_REVALIDATED",
        "EXACT_PROJECTION_LINEAGE",
        `TRANSFORM:${projection.transform.name}:${projection.transform.version}`,
      ],
    });
  }

  return {
    eligible: eligible.sort(
      (left, right) =>
        left.lane.localeCompare(right.lane) ||
        left.revision_id.localeCompare(right.revision_id),
    ),
    exclusions: exclusions.sort(
      (left, right) =>
        left.lane.localeCompare(right.lane) ||
        left.reason_code.localeCompare(right.reason_code) ||
        left.revision_id.localeCompare(right.revision_id),
    ),
  };
}

export function preparedCandidateDigest(
  candidate: PreparedLayeredCandidate,
): string {
  return canonicalJson({
    memory_id: candidate.memory_id,
    revision_id: candidate.revision_id,
    lane: candidate.lane,
    projection: candidate.projection,
  });
}
