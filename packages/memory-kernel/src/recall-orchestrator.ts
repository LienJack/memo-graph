import {
  BASE_RECALL_LANES,
  DEFAULT_BOUNDED_RECALL_LIMITS,
  EffectiveLaneConfigurationSchema,
  GraphPathEvidenceSchema,
  GovernedSearchItemSchema,
  LanePolicySchema,
  LaneRequestOverridesSchema,
  LaneTelemetrySchema,
  ProjectionRevisionSchema,
  RecallLaneSchema,
  ScopeSchema,
  canonicalJson,
  computeEffectiveLaneConfiguration,
  scopeKey,
  type ProjectionSource,
  type ProjectionRevision,
  type RecallLane,
} from "@memo-graph/contracts";
import {
  ProjectionScopeStorageFrontierSchema,
  ProjectionStorageFrontierSchema,
  StorageError,
  type MemoryEligibilityResult,
  type ProjectionScopeStorageFrontier,
  type ProjectionSourceBatchItem,
  type SqliteStorageClient,
} from "@memo-graph/storage-sqlite";
import { z } from "zod";

import {
  LayeredLaneRetrievers,
  type LaneRetrievalResult,
  type LaneRetrieverRequest,
  type RawLaneCandidate,
  type RecallLaneRetriever,
} from "./lane-retrievers.js";

export const LayeredRecallInputSchema = z
  .object({
    principal_id: z.string().trim().min(1),
    scope: ScopeSchema,
    query: z.string().trim().min(1).max(4_000),
    as_of: z.iso.datetime({ offset: true }),
    include_sensitive: z.boolean().default(false),
    lane_policy: LanePolicySchema,
    lane_overrides: LaneRequestOverridesSchema.optional(),
  })
  .strict();

const RevalidatedMemoryCandidateSchema = z
  .object({
    kind: z.literal("memory"),
    abstraction: z.literal("l1_memory"),
    lane: z.literal("recent_l1"),
    scope: ScopeSchema,
    rank: z.number().finite(),
    canonical_revalidated: z.literal(true),
    memory: GovernedSearchItemSchema,
  })
  .strict();

const RevalidatedProjectionCandidateSchema = z
  .object({
    kind: z.literal("projection"),
    abstraction: z.enum([
      "l2_topic",
      "l2_scenario",
      "l2_relation",
      "l3_core",
    ]),
    lane: z.enum([
      "topic",
      "scenario_procedure",
      "core",
      "relation_sqlite",
      "relation_graph",
    ]),
    scope: ScopeSchema,
    rank: z.number().finite(),
    canonical_revalidated: z.literal(true),
    projection: ProjectionRevisionSchema,
    graph_path: GraphPathEvidenceSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.lane === "relation_graph") !==
      (value.graph_path !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["graph_path"],
        message:
          "relation_graph candidates require graph proof and other lanes cannot carry it",
      });
    }
  });

export const RevalidatedRecallCandidateSchema = z.discriminatedUnion(
  "kind",
  [
    RevalidatedMemoryCandidateSchema,
    RevalidatedProjectionCandidateSchema,
  ],
);

export const LayeredRecallExclusionSchema = z
  .object({
    memory_id: z.string().trim().min(1),
    revision_id: z.string().trim().min(1),
    lane: RecallLaneSchema,
    reason_code: z.string().trim().min(1).max(200),
    score: z.number().finite().nullable(),
    graph_path: GraphPathEvidenceSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.lane === "relation_graph") !==
      (value.graph_path !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["graph_path"],
        message:
          "relation_graph exclusions require graph path evidence",
      });
    }
  });

export const LayeredRecallResultSchema = z
  .object({
    status: z.enum(["OK", "NO_MATCH", "POLICY_EXCLUDED", "DEGRADED"]),
    effective_configuration: EffectiveLaneConfigurationSchema,
    projection_frontier: ProjectionStorageFrontierSchema,
    projection_scope_frontier: ProjectionScopeStorageFrontierSchema,
    candidates: z.array(RevalidatedRecallCandidateSchema),
    exclusions: z.array(LayeredRecallExclusionSchema),
    telemetry: z.array(LaneTelemetrySchema),
    degraded_lanes: z.array(RecallLaneSchema),
  })
  .strict()
  .superRefine((value, context) => {
    const lanes = value.telemetry.map((item) => item.lane);
    const expectedLanes = value.effective_configuration.requested_lanes
      .includes("relation_graph")
      ? RecallLaneSchema.options
      : BASE_RECALL_LANES;
    if (
      lanes.length !== expectedLanes.length ||
      new Set(lanes).size !== lanes.length ||
      expectedLanes.some((lane) => !lanes.includes(lane))
    ) {
      context.addIssue({
        code: "custom",
        path: ["telemetry"],
        message:
          "layered recall must report every applicable lane exactly once",
      });
    }
  });

export type LayeredRecallInput = z.input<typeof LayeredRecallInputSchema>;
export type LayeredRecallResult = z.infer<
  typeof LayeredRecallResultSchema
>;
export type RevalidatedRecallCandidate = z.infer<
  typeof RevalidatedRecallCandidateSchema
>;
export type LayeredRecallExclusion = z.infer<
  typeof LayeredRecallExclusionSchema
>;

type LaneState = {
  result: LaneRetrievalResult | null;
  failure_reason: string | null;
};

function sameStrings(left: readonly string[], right: readonly string[]) {
  return canonicalJson([...left].sort()) === canonicalJson([...right].sort());
}

function exactMemoryMatch(
  left: Extract<
    MemoryEligibilityResult,
    { eligible: true }
  >["item"],
  right: Extract<
    MemoryEligibilityResult,
    { eligible: true }
  >["item"],
): boolean {
  return (
    left.memory_id === right.memory_id &&
    left.revision_id === right.revision_id &&
    left.authority === right.authority &&
    left.sensitivity === right.sensitivity &&
    left.content_hash === right.content_hash &&
    scopeKey(left.scope) === scopeKey(right.scope) &&
    canonicalJson(left.validity) === canonicalJson(right.validity) &&
    sameStrings(left.evidence_ids, right.evidence_ids)
  );
}

function exactProjectionSourceMatch(
  source: ProjectionRevision["source_revisions"][number],
  canonical: ProjectionSource,
): boolean {
  return (
    source.memory_id === canonical.memory_id &&
    source.revision_id === canonical.revision_id &&
    source.abstraction === canonical.abstraction &&
    source.principal_id === canonical.principal_id &&
    source.authority === canonical.authority &&
    source.sensitivity === canonical.sensitivity &&
    source.content_hash === canonical.content_hash &&
    scopeKey(source.scope) === scopeKey(canonical.scope) &&
    canonicalJson(source.validity) === canonicalJson(canonical.validity) &&
    sameStrings(source.evidence_ids, canonical.evidence_ids)
  );
}

function exclusionCounts(
  exclusions: LayeredRecallExclusion[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const exclusion of exclusions) {
    counts[exclusion.reason_code] =
      (counts[exclusion.reason_code] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) =>
      left.localeCompare(right)
    ),
  );
}

export class RecallOrchestrator {
  readonly #storage: SqliteStorageClient;
  readonly #retriever: RecallLaneRetriever;

  constructor(options: {
    storage: SqliteStorageClient;
    retriever?: RecallLaneRetriever;
  }) {
    this.#storage = options.storage;
    this.#retriever =
      options.retriever ?? new LayeredLaneRetrievers(options.storage);
  }

  async recall(input: LayeredRecallInput): Promise<LayeredRecallResult> {
    const request = LayeredRecallInputSchema.parse(input);
    const effective = computeEffectiveLaneConfiguration(
      request.lane_policy,
      request.lane_overrides,
    );
    const laneStates = new Map<RecallLane, LaneState>();
    const nonRelation = effective.enabled_lanes.filter(
      (lane) =>
        lane !== "relation_sqlite" && lane !== "relation_graph",
    );
    const concurrency = effective.limits.max_concurrent_lanes;
    for (let offset = 0; offset < nonRelation.length; offset += concurrency) {
      const chunk = nonRelation.slice(offset, offset + concurrency);
      await Promise.all(
        chunk.map(async (lane) => {
          laneStates.set(
            lane,
            await this.#retrieveSafely(
              this.#laneRequest(request, effective.limits, lane, []),
            ),
          );
        }),
      );
    }

    const relationStarts = [...laneStates.values()].flatMap((state) =>
      state.result?.candidates.flatMap((candidate) =>
        candidate.kind === "memory"
          ? [candidate.memory.revision_id]
          : candidate.projection.source_revisions.map(
              (source) => source.revision_id,
            )
      ) ?? []
    );
    if (effective.enabled_lanes.includes("relation_sqlite")) {
      laneStates.set(
        "relation_sqlite",
        await this.#retrieveSafely(
          this.#laneRequest(
            request,
            effective.limits,
            "relation_sqlite",
            relationStarts,
          ),
        ),
      );
    }
    if (effective.enabled_lanes.includes("relation_graph")) {
      laneStates.set(
        "relation_graph",
        await this.#retrieveSafely(
          this.#laneRequest(
            request,
            effective.limits,
            "relation_graph",
            relationStarts,
          ),
        ),
      );
    }

    const rawMemoryCandidates = [...laneStates.values()].flatMap((state) =>
      state.result?.candidates.filter(
        (candidate) => candidate.kind === "memory",
      ) ?? []
    );
    const canonicalMemoryResults = await Promise.all(
      rawMemoryCandidates.map((candidate) =>
        this.#storage.checkMemoryEligibility({
          memory_id: candidate.memory.memory_id,
          revision_id: candidate.memory.revision_id,
          principal_id: request.principal_id,
          scope: request.scope,
          as_of: request.as_of,
          include_sensitive: request.include_sensitive,
          context_scope: request.scope,
        })
      ),
    );
    const canonicalMemoryByRevision = new Map(
      canonicalMemoryResults.flatMap((result) =>
        result.eligible
          ? [[result.item.revision_id, result.item] as const]
          : []
      ),
    );
    const projectionSourceIdsByLane = new Map<RecallLane, string[]>();
    for (const lane of effective.enabled_lanes) {
      const state = laneStates.get(lane);
      const revisionIds = [
        ...new Set(
          state?.result?.candidates.flatMap((candidate) =>
            candidate.kind === "projection"
              ? candidate.projection.source_revisions.map(
                  (source) => source.revision_id,
                )
              : []
          ) ?? [],
        ),
      ].sort();
      if (revisionIds.length > 0) {
        projectionSourceIdsByLane.set(lane, revisionIds);
      }
    }
    const projectionSourceIds = [
      ...new Set([...projectionSourceIdsByLane.values()].flat()),
    ].sort();
    const sourceBatchLimit =
      effective.limits.max_source_revisions_per_batch ??
      DEFAULT_BOUNDED_RECALL_LIMITS.max_source_revisions_per_batch;
    const lineageBatchLimited =
      projectionSourceIds.length > sourceBatchLimit;
    const exactSourceBatch =
      projectionSourceIds.length === 0 || lineageBatchLimited
        ? null
        : await this.#storage.validateProjectionSources({
            principal_id: request.principal_id,
            scope: request.scope,
            as_of: request.as_of,
            include_sensitive: request.include_sensitive,
            context_scope: request.scope,
            revision_ids: projectionSourceIds,
          });
    const [health, scopeFrontier] = await Promise.all([
      this.#storage.health(),
      this.#storage.projectionScopeFrontier({
        principal_id: request.principal_id,
        scope: request.scope,
      }),
    ]);
    const sourceSnapshotMismatch =
      exactSourceBatch !== null &&
      scopeFrontier.status === "ready" &&
      (exactSourceBatch.ledger_epoch !== scopeFrontier.ledger_epoch ||
        exactSourceBatch.tombstone_epoch !==
          scopeFrontier.tombstone_epoch);
    for (const [lane, revisionIds] of projectionSourceIdsByLane) {
      const state = laneStates.get(lane);
      if (state?.result === null || state?.result === undefined) {
        continue;
      }
      const incomplete = lineageBatchLimited || sourceSnapshotMismatch;
      const reasonCode = lineageBatchLimited
        ? "SOURCE_LINEAGE_BATCH_LIMIT"
        : sourceSnapshotMismatch
          ? "SOURCE_FRONTIER_EPOCH_MISMATCH"
          : null;
      laneStates.set(lane, {
        ...state,
        result: {
          ...state.result,
          truncated: state.result.truncated || incomplete,
          reason_codes: [
            ...new Set([
              ...state.result.reason_codes,
              ...(reasonCode === null ? [] : [reasonCode]),
            ]),
          ].sort(),
          bounded_work: [
            ...(state.result.bounded_work ?? []),
            {
              boundary: "source_lineage_batch",
              configured_limit: sourceBatchLimit,
              observed_count: revisionIds.length,
              retained_count: incomplete ? 0 : revisionIds.length,
              truncated_count: incomplete ? revisionIds.length : 0,
              complete: !incomplete,
              ...(reasonCode === null
                ? {}
                : { reason_code: reasonCode }),
            },
          ],
        },
      });
    }
    if (
      health.layered_projection_state === "rebuilding" ||
      health.layered_projection_state === "unavailable"
    ) {
      for (const lane of effective.enabled_lanes) {
        if (lane === "recent_l1") {
          continue;
        }
        laneStates.set(lane, {
          result: null,
          failure_reason:
            `PROJECTION_STATE_${health.layered_projection_state.toUpperCase()}`,
        });
      }
    }
    const exactSourceByRevision = new Map(
      exactSourceBatch?.results.map((result) => [
        result.revision_id,
        result,
      ]) ?? [],
    );
    const candidates: RevalidatedRecallCandidate[] = [];
    const exclusions: LayeredRecallExclusion[] = [];
    const byLaneCandidates = new Map<RecallLane, number>();
    const byLaneEligible = new Map<RecallLane, number>();

    for (const lane of effective.enabled_lanes) {
      const state = laneStates.get(lane);
      const result = state?.result;
      if (result === undefined || result === null) {
        continue;
      }
      exclusions.push(
        ...result.exclusions.map((item) =>
          LayeredRecallExclusionSchema.parse(item)
        ),
      );
      byLaneCandidates.set(
        lane,
        result.candidates.length + result.exclusions.length,
      );
      let eligible = 0;
      for (const raw of result.candidates) {
        const revalidated = this.#revalidate({
          raw,
          request,
          canonicalMemoryByRevision,
          exactSourceByRevision,
          scopeFrontier,
          lineageBatchLimited,
          sourceSnapshotMismatch,
        });
        if ("reason_code" in revalidated) {
          exclusions.push(revalidated);
          continue;
        }
        candidates.push(revalidated);
        eligible += 1;
      }
      byLaneEligible.set(lane, eligible);
    }

    const degradedLanes = effective.enabled_lanes
      .filter((lane) => {
        const state = laneStates.get(lane);
        return (
          state?.failure_reason !== null &&
          state?.failure_reason !== undefined
        ) || state?.result?.truncated === true ||
          (state?.result?.reason_codes.some((reason) =>
            reason.startsWith("LOWER_LANE_DEGRADED:")
          ) ?? false);
      })
      .sort();
    const telemetryLanes = effective.requested_lanes.includes(
      "relation_graph",
    )
      ? RecallLaneSchema.options
      : BASE_RECALL_LANES;
    const telemetry = telemetryLanes.map((lane) => {
      const requested = effective.requested_lanes.includes(lane);
      const enabled = effective.enabled_lanes.includes(lane);
      if (!requested) {
        return LaneTelemetrySchema.parse({
          lane,
          status: "disabled_by_request",
          duration_ms: 0,
          candidate_count: 0,
          eligible_count: 0,
          selected_count: 0,
          exclusion_counts: {},
          reason_codes: ["LANE_NOT_REQUESTED"],
        });
      }
      if (!enabled) {
        return LaneTelemetrySchema.parse({
          lane,
          status: "disabled_by_policy",
          duration_ms: 0,
          candidate_count: 0,
          eligible_count: 0,
          selected_count: 0,
          exclusion_counts: {},
          reason_codes: [`LANE_DENIED_BY_POLICY:${lane}`],
        });
      }
      const state = laneStates.get(lane);
      if (state?.failure_reason !== null &&
          state?.failure_reason !== undefined) {
        return LaneTelemetrySchema.parse({
          lane,
          status: "unavailable",
          duration_ms: 0,
          candidate_count: 0,
          eligible_count: 0,
          selected_count: 0,
          exclusion_counts: {},
          reason_codes: [state.failure_reason],
        });
      }
      const laneExclusions = exclusions.filter(
        (exclusion) => exclusion.lane === lane,
      );
      const candidateCount = byLaneCandidates.get(lane) ?? 0;
      const eligibleCount = byLaneEligible.get(lane) ?? 0;
      const reasonCodes = [
        ...new Set([
          ...(state?.result?.reason_codes ?? []),
          ...laneExclusions.map(
            (exclusion) => exclusion.reason_code,
          ),
        ]),
      ].sort();
      const stale =
        eligibleCount === 0 &&
        (laneExclusions.some((exclusion) =>
          exclusion.reason_code.startsWith("PROJECTION_")
        ) ||
          reasonCodes.some((reason) =>
            reason.startsWith("PROJECTION_SCOPE_") ||
            reason.startsWith("GRAPH_SCOPE_")
          ));
      const degraded = state?.result?.truncated === true ||
        reasonCodes.some((reason) =>
          reason.startsWith("LOWER_LANE_DEGRADED:")
        );
      return LaneTelemetrySchema.parse({
        lane,
        status: stale
          ? "stale"
          : degraded
            ? "degraded"
            : eligibleCount > 0
              ? "eligible"
              : "empty",
        duration_ms: state?.result?.duration_ms ?? 0,
        candidate_count: candidateCount,
        eligible_count: eligibleCount,
        selected_count: eligibleCount,
        exclusion_counts: exclusionCounts(laneExclusions),
        reason_codes: reasonCodes,
        ...(state?.result?.bounded_work === undefined
          ? {}
          : { bounded_work: state.result.bounded_work }),
        ...(state?.result?.query_hashes === undefined
          ? {}
          : { query_hashes: state.result.query_hashes }),
      });
    });
    const orderedCandidates = candidates
      .sort(
        (left, right) =>
          RecallLaneSchema.options.indexOf(left.lane) -
            RecallLaneSchema.options.indexOf(right.lane) ||
          left.rank - right.rank ||
          (left.kind === "memory"
            ? left.memory.revision_id
            : left.projection.projection_revision_id
          ).localeCompare(
            right.kind === "memory"
              ? right.memory.revision_id
              : right.projection.projection_revision_id,
          ),
      );
    const orderedExclusions = exclusions.sort(
      (left, right) =>
        RecallLaneSchema.options.indexOf(left.lane) -
          RecallLaneSchema.options.indexOf(right.lane) ||
        left.reason_code.localeCompare(right.reason_code) ||
        left.revision_id.localeCompare(right.revision_id),
    );
    const status =
      degradedLanes.length > 0
        ? "DEGRADED"
        : orderedCandidates.length > 0
          ? "OK"
          : orderedExclusions.length > 0 ||
              telemetry.some((item) =>
                item.reason_codes.some((reason) =>
                  reason.startsWith("PROJECTION_SCOPE_")
                )
              )
            ? "POLICY_EXCLUDED"
            : "NO_MATCH";
    return LayeredRecallResultSchema.parse({
      status,
      effective_configuration: effective,
      projection_frontier: health.projection_frontier,
      projection_scope_frontier: scopeFrontier,
      candidates: orderedCandidates,
      exclusions: orderedExclusions,
      telemetry,
      degraded_lanes: degradedLanes,
    });
  }

  #laneRequest(
    request: z.output<typeof LayeredRecallInputSchema>,
    limits: z.infer<typeof EffectiveLaneConfigurationSchema>["limits"],
    lane: RecallLane,
    startRevisionIds: string[],
  ): LaneRetrieverRequest {
    return {
      lane,
      principal_id: request.principal_id,
      scope: request.scope,
      query: request.query,
      as_of: request.as_of,
      include_sensitive: request.include_sensitive,
      limit: limits.max_candidates_per_lane,
      projection_scan_limit:
        limits.max_projection_scan_per_lane ??
        DEFAULT_BOUNDED_RECALL_LIMITS.max_projection_scan_per_lane,
      relation_max_depth: limits.relation_max_depth,
      relation_max_fanout: limits.relation_max_fanout,
      relation_max_starts:
        limits.relation_max_starts ??
        DEFAULT_BOUNDED_RECALL_LIMITS.relation_max_starts,
      relation_max_paths:
        limits.relation_max_paths ??
        DEFAULT_BOUNDED_RECALL_LIMITS.relation_max_paths,
      graph_max_relation_allowlist:
        limits.graph_max_relation_allowlist ??
        DEFAULT_BOUNDED_RECALL_LIMITS.graph_max_relation_allowlist,
      graph_query_timeout_ms:
        limits.graph_query_timeout_ms ??
        DEFAULT_BOUNDED_RECALL_LIMITS.graph_query_timeout_ms,
      graph_max_response_bytes:
        limits.graph_max_response_bytes ??
        DEFAULT_BOUNDED_RECALL_LIMITS.graph_max_response_bytes,
      start_revision_ids: startRevisionIds,
    };
  }

  async #retrieveSafely(
    request: LaneRetrieverRequest,
  ): Promise<LaneState> {
    try {
      return {
        result: await this.#retriever.retrieve(request),
        failure_reason: null,
      };
    } catch (error) {
      return {
        result: null,
        failure_reason:
          error instanceof StorageError &&
            error.code === "STALE_PROJECTION_FRONTIER"
            ? "PROJECTION_FRONTIER_CHANGED"
            : `LANE_UNAVAILABLE:${request.lane}`,
      };
    }
  }

  #revalidate(options: {
    raw: RawLaneCandidate;
    request: z.output<typeof LayeredRecallInputSchema>;
    canonicalMemoryByRevision: Map<
      string,
      Extract<
        MemoryEligibilityResult,
        { eligible: true }
      >["item"]
    >;
    exactSourceByRevision: Map<string, ProjectionSourceBatchItem>;
    scopeFrontier: ProjectionScopeStorageFrontier;
    lineageBatchLimited: boolean;
    sourceSnapshotMismatch: boolean;
  }): RevalidatedRecallCandidate | LayeredRecallExclusion {
    const { raw, request } = options;
    if (raw.kind === "memory") {
      const canonical = options.canonicalMemoryByRevision.get(
        raw.memory.revision_id,
      );
      if (
        canonical === undefined ||
        !exactMemoryMatch(raw.memory, canonical)
      ) {
        return LayeredRecallExclusionSchema.parse({
          memory_id: raw.memory.memory_id,
          revision_id: raw.memory.revision_id,
          lane: raw.lane,
          reason_code: "CANONICAL_SOURCE_CHANGED",
          score: raw.rank,
        });
      }
      return RevalidatedRecallCandidateSchema.parse({
        kind: "memory",
        abstraction: "l1_memory",
        lane: raw.lane,
        scope: raw.memory.scope,
        rank: raw.rank,
        canonical_revalidated: true,
        memory: canonical,
      });
    }

    const projection = raw.projection;
    const exclusion = (reasonCode: string) =>
      LayeredRecallExclusionSchema.parse({
        memory_id: projection.projection_id,
        revision_id: projection.projection_revision_id,
        lane: raw.lane,
        reason_code: reasonCode,
        score: raw.rank,
        ...(raw.graph_path === undefined
          ? {}
          : { graph_path: raw.graph_path }),
      });
    if (options.lineageBatchLimited) {
      return exclusion("SOURCE_LINEAGE_BATCH_LIMIT");
    }
    if (options.sourceSnapshotMismatch) {
      return exclusion("SOURCE_FRONTIER_EPOCH_MISMATCH");
    }
    if (
      projection.principal_id !== request.principal_id ||
      scopeKey(projection.scope) !== scopeKey(request.scope)
    ) {
      return exclusion("PROJECTION_SCOPE_MISMATCH");
    }
    if (
      options.scopeFrontier.status !== "ready" ||
      projection.frontier.ledger_epoch !==
        options.scopeFrontier.ledger_epoch ||
      projection.frontier.tombstone_epoch !==
        options.scopeFrontier.tombstone_epoch ||
      projection.frontier.projection_epoch !==
        options.scopeFrontier.projection_epoch ||
      projection.frontier.source_frontier_hash !==
        options.scopeFrontier.source_frontier_hash ||
      projection.frontier.projection_frontier_hash !==
        options.scopeFrontier.projection_frontier_hash ||
      !options.scopeFrontier.transform_versions.some(
        (transform) =>
          transform.name === projection.transform.name &&
          transform.version === projection.transform.version,
      )
    ) {
      return exclusion("PROJECTION_STALE_FRONTIER");
    }
    for (const source of projection.source_revisions) {
      const canonical = options.exactSourceByRevision.get(
        source.revision_id,
      );
      if (canonical === undefined) {
        return exclusion("SOURCE_MISSING");
      }
      if (canonical.status === "ineligible") {
        return exclusion(canonical.reason_code);
      }
      if (!exactProjectionSourceMatch(source, canonical.source)) {
        return exclusion("PROJECTION_SOURCE_MISMATCH");
      }
    }
    if (
      projection.lifecycle !== "active" ||
      projection.payload === null ||
      projection.content?.storage !== "inline"
    ) {
      return exclusion("PROJECTION_CONTENT_INELIGIBLE");
    }
    return RevalidatedRecallCandidateSchema.parse({
      kind: "projection",
      abstraction: projection.abstraction,
      lane: raw.lane,
      scope: projection.scope,
      rank: raw.rank,
      canonical_revalidated: true,
      projection,
      ...(raw.graph_path === undefined
        ? {}
        : { graph_path: raw.graph_path }),
    });
  }
}
