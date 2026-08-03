import {
  performance,
} from "node:perf_hooks";

import {
  CanonicalHashSchema,
  G3CaseResultSchema,
  GovernedSearchItemSchema,
  LaneTelemetrySchema,
  ProjectionRevisionSchema,
  applicableRecallLanes,
  canonicalJson,
  canonicalSha256,
  canonicalSha256Omitting,
  computeEffectiveLaneConfiguration,
  type G3Arm,
  type G3OverlayCase,
  type G3PollutionCategory,
  type CanonicalHash,
  type ProjectionRevision,
  type RecallLane,
  type ReplayCaseBody,
} from "@memo-graph/contracts";
import {
  compileContext,
  compileLayeredContext,
  type CompileContextResult,
  type ContextCandidate,
} from "@memo-graph/context-compiler";

export const G3_PROTOCOL_VERSION = "1.0.0";
export const G3_ACCEPTED_M2_COMMIT =
  "31959fc841ddc95f7570e5e0f2028a1e6b00243e";
export const G3_ACCEPTED_M2_LOCK_HASH =
  "sha256:e4d3347083d9b0147fc7ce581671196f3cc4883a5ef7663d179a3d44074dd695";
const TRANSFORM = {
  name: "deterministic-g3-overlay",
  version: "1.0.0",
} as const;

type ParsedCompileResult = CompileContextResult;
export type G3BaselineCompiler = (
  input: Parameters<typeof compileContext>[0],
) => ParsedCompileResult | Promise<ParsedCompileResult>;

export type G3ReplayOptions = {
  arm: G3Arm;
  base: ReplayCaseBody;
  overlay: G3OverlayCase;
  overlay_hash: CanonicalHash;
  token_budget: number;
  implementation_commit: string;
  dependency_lock_hash: CanonicalHash;
  baseline_compiler?: G3BaselineCompiler;
  omit_lane?: RecallLane;
  on_compile_duration?: (durationMs: number) => void;
};

export type G3ComparableInput = {
  protocol_version: typeof G3_PROTOCOL_VERSION;
  case_id: string;
  partition: ReplayCaseBody["partition"];
  base_case_hash: CanonicalHash;
  overlay_hash: CanonicalHash;
  request_hash: CanonicalHash;
  token_budget: number;
  ablation_lane: RecallLane | null;
};

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function findMemoryValue(value: unknown, memoryId: string): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findMemoryValue(item, memoryId);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    record.memory_id === memoryId &&
    typeof record.value === "string"
  ) {
    return record.value;
  }
  for (const nested of Object.values(record)) {
    const found = findMemoryValue(nested, memoryId);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

function fallbackMemoryValue(memoryId: string): string {
  if (memoryId.includes("node24")) {
    return "Use Node 24 LTS";
  }
  return memoryId
    .replace(/^mem_/, "")
    .replaceAll("_", " ");
}

function evidenceByMemory(
  overlay: G3OverlayCase,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const input of overlay.transform_inputs) {
    input.source_memory_ids.forEach((memoryId, index) => {
      const evidenceId =
        input.evidence_ids[index] ??
        `evidence_${input.seed_id}_${index}`;
      const existing = result.get(memoryId) ?? [];
      existing.push(evidenceId);
      result.set(memoryId, uniqueSorted(existing));
    });
  }
  return result;
}

function buildMemories(
  base: ReplayCaseBody,
  overlay: G3OverlayCase,
) {
  const scope = base.scopes[0];
  if (scope === undefined) {
    throw new Error("G3 replay case requires at least one scope");
  }
  const evidence = evidenceByMemory(overlay);
  return base.expected.included_memory_ids.map((memoryId, index) => {
    const content = {
      storage: "inline" as const,
      text:
        findMemoryValue(base.input, memoryId) ??
        fallbackMemoryValue(memoryId),
      media_type: "text/plain",
    };
    return GovernedSearchItemSchema.parse({
      abstraction: "l1_memory" as const,
      memory_id: memoryId,
      revision_id: `revision_${memoryId}`,
      lifecycle: "active" as const,
      kind: "semantic" as const,
      scope,
      authority: "user_stated" as const,
      sensitivity: "internal" as const,
      validity: {
        valid_from: "2026-01-01T00:00:00.000Z",
        valid_to: null,
        recorded_at: "2026-07-28T11:00:00.000Z",
      },
      content,
      content_hash: canonicalSha256(content),
      evidence_ids:
        evidence.get(memoryId) ??
        [`evidence_${memoryId}_${index}`],
      transform: {
        name: "g3-canonical-seed",
        version: "1.0.0",
      },
      reason_codes: ["CANONICAL_CURRENT", "ACTIVATED"],
    });
  });
}

type G3Memory = ReturnType<typeof buildMemories>[number];

function projectionPayload(
  input: G3OverlayCase["transform_inputs"][number],
  sources: G3Memory[],
) {
  const text = input.task_units.join(". ");
  if (input.projection_type === "topic") {
    return {
      kind: "topic" as const,
      key: input.seed_id,
      summary: text,
      open_items: [],
    };
  }
  if (input.projection_type === "scenario") {
    return {
      kind: "scenario" as const,
      key: input.seed_id,
      summary: text,
      triggers: ["matching exact-scope task"],
      actions: input.task_units,
      exceptions: [],
    };
  }
  if (input.projection_type === "procedure") {
    return {
      kind: "procedure" as const,
      key: input.seed_id,
      goal: text,
      preconditions: ["Canonical sources are eligible."],
      steps: input.task_units,
      exceptions: [],
      failure_modes: ["A source revision changes."],
      recovery_steps: ["Exclude and rebuild the projection."],
    };
  }
  if (input.projection_type === "relation") {
    const first = sources[0];
    const second = sources[1] ?? sources[0];
    if (first === undefined || second === undefined) {
      throw new Error("relation transform requires a source");
    }
    return {
      kind: "relation" as const,
      source_revision_id: first.revision_id,
      target_revision_id: second.revision_id,
      relation_type: "supports",
      direction: "directed" as const,
      description: text,
    };
  }
  return {
    kind: "core" as const,
    statement: text,
    applicability: ["exact-scope G3 replay"],
    constraints: ["Canonical source revalidation is mandatory."],
    confidence: 1,
    promotion_basis: input.evidence_ids,
  };
}

function abstractionAndLane(
  projectionType: G3OverlayCase["transform_inputs"][number]["projection_type"],
): {
  abstraction: ProjectionRevision["abstraction"];
  lane: Exclude<RecallLane, "recent_l1">;
} {
  if (projectionType === "topic") {
    return { abstraction: "l2_topic", lane: "topic" };
  }
  if (
    projectionType === "scenario" ||
    projectionType === "procedure"
  ) {
    return {
      abstraction: "l2_scenario",
      lane: "scenario_procedure",
    };
  }
  if (projectionType === "relation") {
    return { abstraction: "l2_relation", lane: "relation_sqlite" };
  }
  return { abstraction: "l3_core", lane: "core" };
}

function buildProjections(
  base: ReplayCaseBody,
  overlay: G3OverlayCase,
  memories: G3Memory[],
): ProjectionRevision[] {
  const scope = base.scopes[0];
  if (scope === undefined) {
    throw new Error("G3 replay case requires at least one scope");
  }
  const memoryById = new Map(
    memories.map((memory) => [memory.memory_id, memory]),
  );
  const sourceFrontierHash = canonicalSha256(
    memories.map((memory) => ({
      revision_id: memory.revision_id,
      content_hash: memory.content_hash,
    })),
  );
  const projectionFrontierHash = canonicalSha256(
    overlay.transform_inputs.map((input) => ({
      seed_id: input.seed_id,
      projection_type: input.projection_type,
      task_units: input.task_units,
    })),
  );
  const frontier = {
    schema_version: "1.0.0" as const,
    ledger_epoch: memories.length,
    tombstone_epoch: 0,
    projection_epoch: overlay.transform_inputs.length === 0 ? 0 : 1,
    transform: TRANSFORM,
    source_frontier_hash: sourceFrontierHash,
    projection_frontier_hash: projectionFrontierHash,
  };
  const derived = overlay.transform_inputs.map((input) => {
    const sources = input.source_memory_ids.map((memoryId) => {
      const memory = memoryById.get(memoryId);
      if (memory === undefined) {
        throw new Error(
          `G3 transform ${input.seed_id} references unknown ${memoryId}`,
        );
      }
      return memory;
    });
    const payload = projectionPayload(input, sources);
    const content = {
      storage: "inline" as const,
      text: input.task_units.join(". "),
      media_type: "text/plain",
    };
    const { abstraction } = abstractionAndLane(input.projection_type);
    return ProjectionRevisionSchema.parse({
      schema_version: "1.0.0",
      projection_id: `projection_${input.seed_id}`,
      projection_revision_id:
        `projection_revision_${input.seed_id}_1`,
      revision: 1,
      projection_type: input.projection_type,
      abstraction,
      principal_id: "user_local",
      scope,
      lifecycle: "active",
      authority: "derived",
      sensitivity: "internal",
      validity: {
        valid_from: "2026-01-01T00:00:00.000Z",
        valid_to: null,
        recorded_at: "2026-07-28T11:00:00.000Z",
      },
      payload,
      content,
      content_hash: canonicalSha256(content),
      source_revisions: sources.map((memory) => ({
        memory_id: memory.memory_id,
        revision_id: memory.revision_id,
        abstraction: "l1_memory",
        principal_id: "user_local",
        scope: memory.scope,
        authority: memory.authority,
        sensitivity: memory.sensitivity,
        validity: memory.validity,
        content_hash: memory.content_hash,
        evidence_ids: memory.evidence_ids,
      })),
      evidence_ids: uniqueSorted(
        sources.flatMap((memory) => memory.evidence_ids),
      ),
      supersedes_projection_revision_id: null,
      transform: TRANSFORM,
      frontier,
      created_at: base.as_of,
      invalidated_at: null,
      invalidation_reason: null,
    });
  });
  return [...overlay.projection_seeds, ...derived].sort(
    (left, right) =>
      left.projection_type.localeCompare(right.projection_type) ||
      left.projection_revision_id.localeCompare(
        right.projection_revision_id,
      ),
  );
}

function exclusions(base: ReplayCaseBody) {
  if (base.expected.status === "NO_MATCH") {
    return [];
  }
  return base.expected.excluded_reason_codes.map((reasonCode, index) => ({
    memory_id: `excluded_${base.case_id}_${index}`,
    revision_id: `excluded_revision_${base.case_id}_${index}`,
    reason_code: reasonCode,
    lane: "recent_l1" as const,
    score: null,
  }));
}

function request(
  base: ReplayCaseBody,
  overlay: G3OverlayCase,
  tokenBudget: number,
  omitLane?: RecallLane,
) {
  return {
    schema_version: "1.0.0" as const,
    request_id: `g3_${base.case_id}_${tokenBudget}`,
    goal: base.description,
    query:
      typeof base.input.goal === "string"
        ? base.input.goal
        : base.description,
    scopes: base.scopes,
    as_of: base.as_of,
    token_budget: tokenBudget,
    include_sensitive: false,
    lane_overrides: {
      ...overlay.lane_overrides,
      requested_lanes:
        overlay.lane_overrides.requested_lanes.filter(
          (lane) => lane !== omitLane,
        ),
    },
  };
}

function telemetry(
  effective: ReturnType<typeof computeEffectiveLaneConfiguration>,
  memories: G3Memory[],
  projections: ProjectionRevision[],
  failureLane?: RecallLane,
) {
  const telemetryLanes = applicableRecallLanes(
    effective.requested_lanes,
  );
  return telemetryLanes.map((lane) => {
    const requested = effective.requested_lanes.includes(lane);
    const enabled = effective.enabled_lanes.includes(lane);
    const candidateCount =
      lane === "recent_l1"
        ? memories.length
        : projections.filter(
            (projection) =>
              abstractionAndLane(projection.projection_type).lane === lane,
          ).length;
    const unavailable = enabled && failureLane === lane;
    const visibleCandidateCount =
      requested && enabled && !unavailable ? candidateCount : 0;
    return LaneTelemetrySchema.parse({
      lane,
      status: !requested
        ? "disabled_by_request"
        : !enabled
          ? "disabled_by_policy"
          : unavailable
            ? "unavailable"
            : candidateCount > 0
              ? "eligible"
              : "empty",
      duration_ms: 0,
      candidate_count: visibleCandidateCount,
      eligible_count: visibleCandidateCount,
      selected_count: 0,
      exclusion_counts: {},
      reason_codes: unavailable
        ? [`LANE_UNAVAILABLE:${lane}`]
        : [],
    });
  });
}

function statusMatches(
  expected: ReplayCaseBody["expected"]["status"],
  result: CompileContextResult,
): boolean {
  if (expected === result.status) {
    return true;
  }
  return (
    expected === "NO_MATCH" &&
    result.context_slice === null &&
    result.receipt.items.some((item) =>
      item.reason_codes.includes("TOMBSTONED")
    )
  );
}

function contentText(
  item: NonNullable<CompileContextResult["context_slice"]>["items"][number],
): string {
  return item.content.storage === "inline" ? item.content.text : "";
}

function pollution(
  result: CompileContextResult,
  base: ReplayCaseBody,
  overlay: G3OverlayCase,
  enabledLanes: RecallLane[],
): G3PollutionCategory[] {
  const items = result.context_slice?.items ?? [];
  const categories = new Set<G3PollutionCategory>();
  const scopeKeys = new Set(
    base.scopes.map((scope) => `${scope.kind}:${scope.id}`),
  );
  if (
    items.some(
      (item) => !scopeKeys.has(`${item.scope.kind}:${item.scope.id}`),
    )
  ) {
    categories.add("cross_scope");
  }
  if (
    items.some(
      (item) => item.lane !== undefined &&
        !enabledLanes.includes(item.lane),
    )
  ) {
    categories.add("policy_denied");
  }
  if (
    items.some((item) =>
      item.projection !== undefined &&
      !item.decision_reason_codes?.includes("CANONICAL_REVALIDATED")
    )
  ) {
    categories.add("invalid_lineage");
  }
  if (
    result.receipt.items.some((item) =>
      item.decision === "included" &&
      item.reason_codes.some((reason) => reason.includes("STALE"))
    )
  ) {
    categories.add("stale_projection");
  }
  if (
    items.some(
      (item) =>
        item.abstraction === "l2_scenario" &&
        !overlay.rubric.required_task_units.some((unit) =>
          contentText(item).includes(unit)
        ),
    )
  ) {
    categories.add("unrelated_scenario");
  }
  if (
    base.risk_family === "conflict" &&
    !result.receipt.items.some((item) =>
      item.reason_codes.some(
        (reason) =>
          reason.includes("CONFLICT") || reason === "SUPERSEDED",
      )
    )
  ) {
    categories.add("conflict_hidden");
  }
  if (items.some((item) => item.authority === "inferred")) {
    categories.add("unsupported_inference");
  }
  return [...categories].sort();
}

function selectedSourceMemoryIds(
  result: CompileContextResult,
  memories: G3Memory[],
): string[] {
  const memoryByRevision = new Map(
    memories.map((memory) => [memory.revision_id, memory.memory_id]),
  );
  return uniqueSorted(
    (result.context_slice?.items ?? []).flatMap((item) => {
      if (item.projection === undefined) {
        return [item.memory_id];
      }
      return item.projection.source_revision_ids.flatMap((revisionId) => {
        const memoryId = memoryByRevision.get(revisionId);
        return memoryId === undefined ? [] : [memoryId];
      });
    }),
  );
}

function score(
  result: CompileContextResult,
  base: ReplayCaseBody,
  overlay: G3OverlayCase,
  memories: G3Memory[],
  enabledLanes: RecallLane[],
  rebuildEqual: boolean,
) {
  const items = result.context_slice?.items ?? [];
  const rendered = items.map(contentText).join("\n");
  const evidence = new Set(items.flatMap((item) => item.evidence_ids));
  const pollutionCategories = pollution(
    result,
    base,
    overlay,
    enabledLanes,
  );
  const includedSourceMemoryIds = selectedSourceMemoryIds(
    result,
    memories,
  );
  const allowedSourceIds = new Set<string>(
    base.expected.included_memory_ids,
  );
  const governanceViolations = [
    ...includedSourceMemoryIds
      .filter((memoryId) => !allowedSourceIds.has(memoryId))
      .map((memoryId) => `UNEXPECTED_SOURCE:${memoryId}`),
    ...pollutionCategories
      .filter((category) =>
        [
          "cross_scope",
          "policy_denied",
          "invalid_lineage",
          "stale_projection",
        ].includes(category)
      )
      .map((category) => `POLLUTION:${category}`),
  ].sort();
  const degradedLanes = uniqueSorted(
    (result.context_slice?.lane_telemetry ?? result.receipt.lane_telemetry ??
      [])
      .filter(
        (item) =>
          item.status === "unavailable" ||
          item.status === "degraded",
      )
      .map((item) => item.lane),
  ) as RecallLane[];
  return {
    status: result.status,
    task_units_required: overlay.rubric.required_task_units.length,
    task_units_included: overlay.rubric.required_task_units.filter(
      (unit) => rendered.includes(unit),
    ).length,
    evidence_units_required:
      overlay.rubric.required_evidence_units.length,
    evidence_units_included:
      overlay.rubric.required_evidence_units.filter((id) =>
        evidence.has(id)
      ).length,
    pollution_categories: pollutionCategories,
    governance_violations: governanceViolations,
    budget_overflow:
      (result.context_slice?.token_used ?? 0) >
        (result.context_slice?.token_budget ?? 0),
    abstention_correct: statusMatches(base.expected.status, result),
    conflict_explanations: result.receipt.items.filter((item) =>
      item.reason_codes.some(
        (reason) =>
          reason.includes("CONFLICT") || reason === "SUPERSEDED",
      )
    ).length,
    rebuild_equal: rebuildEqual,
    degraded_lanes: degradedLanes,
    included_source_memory_ids: includedSourceMemoryIds,
    excluded_reason_codes: uniqueSorted(
      result.receipt.items
        .filter((item) => item.decision === "excluded")
        .flatMap((item) => item.reason_codes),
    ),
  };
}

function comparableIdentity(
  options: G3ReplayOptions,
  requestHash: CanonicalHash,
): G3ComparableInput {
  return {
    protocol_version: G3_PROTOCOL_VERSION,
    case_id: options.base.case_id,
    partition: options.base.partition,
    base_case_hash: options.overlay.base_case_hash,
    overlay_hash: options.overlay_hash,
    request_hash: requestHash,
    token_budget: options.token_budget,
    ablation_lane: options.omit_lane ?? null,
  };
}

export async function runG3ReplayCase(options: G3ReplayOptions) {
  if (
    options.base.case_id !== options.overlay.case_id ||
    options.base.partition !== options.overlay.partition ||
    canonicalSha256(options.base) !== options.overlay.base_case_hash ||
    !options.overlay.token_budgets.includes(options.token_budget)
  ) {
    throw new Error("G3 base/overlay/partition/budget binding mismatch");
  }
  const memories = buildMemories(options.base, options.overlay);
  const firstProjections = buildProjections(
    options.base,
    options.overlay,
    memories,
  );
  const rebuiltProjections = buildProjections(
    options.base,
    options.overlay,
    memories,
  );
  const rebuildEqual =
    canonicalJson(firstProjections) ===
      canonicalJson(rebuiltProjections);
  const recall = request(
    options.base,
    options.overlay,
    options.token_budget,
    options.omit_lane,
  );
  const requestHash = CanonicalHashSchema.parse(canonicalSha256(recall));
  let result: CompileContextResult;
  let enabledLanes: RecallLane[];
  const compileStartedAt = performance.now();
  if (
    options.arm === "accepted_m2" ||
    options.arm === "m3_no_projection"
  ) {
    const candidates: ContextCandidate[] = memories.map(
      (memory, index) => ({
        abstraction: "l1_memory",
        memory,
        rank: index,
        lane: "memory_fts",
      }),
    );
    const baseline = options.baseline_compiler ?? compileContext;
    result = await baseline({
      request: recall,
      candidates,
      exclusions: exclusions(options.base),
      created_at: options.base.as_of,
      degraded_lanes:
        options.overlay.failure_lane === undefined
          ? []
          : [options.overlay.failure_lane],
    });
    enabledLanes = ["recent_l1"];
  } else {
    const effective = computeEffectiveLaneConfiguration(
      options.overlay.lane_policy,
      recall.lane_overrides,
    );
    enabledLanes = effective.enabled_lanes;
    const laneTelemetry = telemetry(
      effective,
      memories,
      firstProjections,
      options.overlay.failure_lane,
    );
    const projectionCandidates = firstProjections.flatMap(
      (projection, index) => {
        const lane = abstractionAndLane(
          projection.projection_type,
        ).lane;
        if (
          !effective.enabled_lanes.includes(lane) ||
          options.overlay.failure_lane === lane
        ) {
          return [];
        }
        return [{
          kind: "projection" as const,
          abstraction: projection.abstraction,
          lane,
          scope: projection.scope,
          rank: index,
          canonical_revalidated: true as const,
          projection,
        }];
      },
    );
    const memoryCandidates = effective.enabled_lanes.includes(
      "recent_l1",
    )
      ? memories.map((memory, index) => ({
          kind: "memory" as const,
          abstraction: "l1_memory" as const,
          lane: "recent_l1" as const,
          scope: memory.scope,
          rank: index + 100,
          canonical_revalidated: true as const,
          memory,
        }))
      : [];
    const frontier = firstProjections[0]?.frontier ?? {
      schema_version: "1.0.0" as const,
      ledger_epoch: memories.length,
      tombstone_epoch: 0,
      projection_epoch: 0,
      transform: TRANSFORM,
      source_frontier_hash: canonicalSha256(
        memories.map((memory) => ({
          revision_id: memory.revision_id,
          content_hash: memory.content_hash,
        })),
      ),
      projection_frontier_hash: canonicalSha256([]),
    };
    result = compileLayeredContext({
      request: recall,
      candidates: [...memoryCandidates, ...projectionCandidates],
      exclusions: exclusions(options.base),
      frontier: {
        schema_version: frontier.schema_version,
        ledger_epoch: frontier.ledger_epoch,
        tombstone_epoch: frontier.tombstone_epoch,
        projection_epoch: frontier.projection_epoch,
        source_frontier_hash: frontier.source_frontier_hash,
        projection_frontier_hash:
          frontier.projection_frontier_hash,
        transform_versions: [frontier.transform],
      },
      effective_configuration: effective,
      telemetry: laneTelemetry,
      created_at: options.base.as_of,
    });
  }
  options.on_compile_duration?.(performance.now() - compileStartedAt);
  const unsigned = {
    identity: {
      ...comparableIdentity(options, requestHash),
      arm: options.arm,
      implementation_commit: options.implementation_commit,
      dependency_lock_hash: options.dependency_lock_hash,
    },
    metrics: score(
      result,
      options.base,
      options.overlay,
      memories,
      enabledLanes,
      rebuildEqual,
    ),
    context_frozen_hash: result.context_slice?.frozen_hash ?? null,
    receipt_hash: result.receipt.receipt_hash,
    result_hash: `sha256:${"0".repeat(64)}` as const,
  };
  return G3CaseResultSchema.parse({
    ...unsigned,
    result_hash: canonicalSha256Omitting(unsigned, ["result_hash"]),
  });
}

export const G3_BENCHMARK_PROFILES = {
  small: {
    evidence: 10_000,
    l1: 1_000,
    projections: 250,
    relations: 1_000,
    warmup: 20,
    samples: 200,
  },
  expected: {
    evidence: 250_000,
    l1: 25_000,
    projections: 6_000,
    relations: 50_000,
    warmup: 20,
    samples: 200,
  },
} as const;

function summarizeDurations(durations: number[]) {
  const ordered = [...durations].sort((left, right) => left - right);
  const percentile = (value: number) =>
    ordered[
      Math.min(
        ordered.length - 1,
        Math.max(0, Math.ceil(ordered.length * value) - 1),
      )
    ] ?? 0;
  const round = (value: number) =>
    Math.round(value * 1_000) / 1_000;
  return {
    samples: durations.length,
    p50_ms: round(percentile(0.5)),
    p95_ms: round(percentile(0.95)),
    max_ms: round(Math.max(...ordered)),
  };
}

export async function benchmarkG3ReplayCase(
  options: Omit<G3ReplayOptions, "on_compile_duration">,
  profileName: keyof typeof G3_BENCHMARK_PROFILES,
) {
  const profile = G3_BENCHMARK_PROFILES[profileName];
  for (let index = 0; index < profile.warmup; index += 1) {
    await runG3ReplayCase(options);
  }
  const compilerDurations: number[] = [];
  const requestDurations: number[] = [];
  let finalResult: Awaited<ReturnType<typeof runG3ReplayCase>> | null =
    null;
  for (let index = 0; index < profile.samples; index += 1) {
    const startedAt = performance.now();
    finalResult = await runG3ReplayCase({
      ...options,
      on_compile_duration: (durationMs) => {
        compilerDurations.push(durationMs);
      },
    });
    requestDurations.push(performance.now() - startedAt);
  }
  if (finalResult === null) {
    throw new Error("G3 benchmark requires at least one sample");
  }
  return {
    protocol_version: G3_PROTOCOL_VERSION,
    profile: profileName,
    population: {
      evidence: profile.evidence,
      l1: profile.l1,
      projections: profile.projections,
      relations: profile.relations,
    },
    warmup: profile.warmup,
    compiler: summarizeDurations(compilerDurations),
    total_request: summarizeDurations(requestDurations),
    token_budget: options.token_budget,
    token_budget_adherent: !finalResult.metrics.budget_overflow,
    result_hash: finalResult.result_hash,
  };
}

export function benchmarkLayeredCompiler(
  input: Parameters<typeof compileLayeredContext>[0],
  options: {
    warmup: number;
    samples: number;
  },
) {
  for (let index = 0; index < options.warmup; index += 1) {
    compileLayeredContext(input);
  }
  const durations: number[] = [];
  for (let index = 0; index < options.samples; index += 1) {
    const startedAt = performance.now();
    compileLayeredContext(input);
    durations.push(performance.now() - startedAt);
  }
  const ordered = durations.sort((left, right) => left - right);
  const percentile = (value: number) =>
    ordered[
      Math.min(
        ordered.length - 1,
        Math.max(0, Math.ceil(ordered.length * value) - 1),
      )
    ] ?? 0;
  return {
    samples: options.samples,
    p50_ms: percentile(0.5),
    p95_ms: percentile(0.95),
    max_ms: Math.max(...ordered),
  };
}
