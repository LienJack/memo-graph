import { describe, expect, it } from "vitest";

import {
  ContextConflictSetSchema,
  LaneTelemetrySchema,
  ProjectionRevisionSchema,
  buildContextFrontierV2,
  canonicalJson,
  canonicalSha256,
  canonicalSha256Omitting,
  computeEffectiveLaneConfiguration,
  receiptHashIsValid,
} from "../../packages/contracts/src/index.js";
import {
  CompileLayeredContextInputSchema,
  compileLayeredContext,
} from "../../packages/context-compiler/src/index.js";

const NOW = "2026-07-28T12:00:00.000Z";
const AS_OF = "2026-07-28T12:30:00.000Z";
const SCOPE = {
  kind: "workspace",
  id: "workspace_local",
} as const;
const SCOPE_B = {
  kind: "workspace",
  id: "workspace_secondary",
} as const;
const TRANSFORM = {
  name: "deterministic-layered-consolidation",
  version: "1.0.0",
} as const;
const SOURCE_FRONTIER_HASH = canonicalSha256([
  { revision_id: "revision_a", content_hash: `sha256:${"a".repeat(64)}` },
  { revision_id: "revision_b", content_hash: `sha256:${"b".repeat(64)}` },
  { revision_id: "revision_c", content_hash: `sha256:${"c".repeat(64)}` },
]);
const PROJECTION_FRONTIER_HASH = canonicalSha256([
  "projection_core",
  "projection_procedure",
  "projection_topic",
]);
const PROJECTION_FRONTIER = {
  schema_version: "1.0.0",
  ledger_epoch: 9,
  tombstone_epoch: 1,
  projection_epoch: 3,
  transform: TRANSFORM,
  source_frontier_hash: SOURCE_FRONTIER_HASH,
  projection_frontier_hash: PROJECTION_FRONTIER_HASH,
} as const;
const CONTEXT_FRONTIER = {
  schema_version: "1.0.0",
  ledger_epoch: PROJECTION_FRONTIER.ledger_epoch,
  tombstone_epoch: PROJECTION_FRONTIER.tombstone_epoch,
  projection_epoch: PROJECTION_FRONTIER.projection_epoch,
  source_frontier_hash: PROJECTION_FRONTIER.source_frontier_hash,
  projection_frontier_hash:
    PROJECTION_FRONTIER.projection_frontier_hash,
  transform_versions: [TRANSFORM],
} as const;

function memory(
  suffix: "a" | "b" | "c",
  text: string,
) {
  const content = {
    storage: "inline",
    text,
    media_type: "text/plain",
  } as const;
  return {
    abstraction: "l1_memory",
    memory_id: `memory_${suffix}`,
    revision_id: `revision_${suffix}`,
    lifecycle: "active",
    kind: suffix === "c" ? "procedural" : "semantic",
    scope: SCOPE,
    authority: "user_stated",
    sensitivity: "personal",
    validity: {
      valid_from: NOW,
      valid_to: null,
      recorded_at: NOW,
    },
    content,
    content_hash: canonicalSha256(content),
    evidence_ids: [`evidence_${suffix}`],
    transform: {
      name: "memory-proposal",
      version: "1.0.0",
    },
    reason_codes: ["CANONICAL_CURRENT", "ACTIVATED"],
  } as const;
}

const MEMORY_A = memory("a", "Agent memory stays governed.");
const MEMORY_B = memory("b", "Agent memory remains governed.");
const MEMORY_C = memory(
  "c",
  "Revalidate exact source revisions before Context use.",
);

function source(item: ReturnType<typeof memory>) {
  return {
    memory_id: item.memory_id,
    revision_id: item.revision_id,
    abstraction: "l1_memory",
    principal_id: "user_local",
    scope: item.scope,
    authority: item.authority,
    sensitivity: item.sensitivity,
    validity: item.validity,
    content_hash: item.content_hash,
    evidence_ids: item.evidence_ids,
  } as const;
}

function projection(
  kind: "topic" | "core" | "procedure",
) {
  const sources =
    kind === "procedure"
      ? [source(MEMORY_C)]
      : [source(MEMORY_A), source(MEMORY_B)];
  const payload =
    kind === "topic"
      ? {
          kind: "topic" as const,
          key: "agent-memory",
          summary: "Agent memory stays governed.",
          open_items: [],
        }
      : kind === "core"
        ? {
            kind: "core" as const,
            statement: "Agent memory stays governed.",
            applicability: ["workspace:workspace_local"],
            constraints: ["Never bypass canonical source revalidation."],
            confidence: 1,
            promotion_basis: ["Two governed sources agree."],
          }
        : {
            kind: "procedure" as const,
            key: "revalidate-context",
            goal: "Revalidate exact source revisions before Context use.",
            preconditions: ["Canonical SQLite is available."],
            steps: ["Load exact source revisions.", "Check the frontier."],
            exceptions: ["Projection lane is unavailable."],
            failure_modes: ["A source changes after candidate generation."],
            recovery_steps: ["Exclude the stale projection."],
          };
  const content = {
    storage: "inline",
    text: canonicalJson(payload),
    media_type: "application/json",
  } as const;
  return ProjectionRevisionSchema.parse({
    schema_version: "1.0.0",
    projection_id: `projection_${kind}`,
    projection_revision_id: `projection_revision_${kind}_1`,
    revision: 1,
    projection_type: kind,
    abstraction:
      kind === "topic"
        ? "l2_topic"
        : kind === "core"
          ? "l3_core"
          : "l2_scenario",
    principal_id: "user_local",
    scope: SCOPE,
    lifecycle: "active",
    authority: "derived",
    sensitivity: "personal",
    validity: {
      valid_from: NOW,
      valid_to: null,
      recorded_at: NOW,
    },
    payload,
    content,
    content_hash: canonicalSha256(content),
    source_revisions: sources,
    evidence_ids: sources.flatMap((item) => item.evidence_ids),
    supersedes_projection_revision_id: null,
    transform: TRANSFORM,
    frontier: PROJECTION_FRONTIER,
    created_at: NOW,
    invalidated_at: null,
    invalidation_reason: null,
  });
}

function projectionInSecondScope() {
  const base = projection("topic");
  const sourceRevisions = base.source_revisions.map((item) => ({
    ...item,
    memory_id: `${item.memory_id}_scope_b`,
    revision_id: `${item.revision_id}_scope_b`,
    scope: SCOPE_B,
    evidence_ids: item.evidence_ids.map((id) => `${id}_scope_b`),
  }));
  const frontier = {
    ...base.frontier,
    projection_epoch: base.frontier.projection_epoch + 4,
    source_frontier_hash: canonicalSha256(sourceRevisions),
    projection_frontier_hash: canonicalSha256([
      "projection_topic_scope_b",
    ]),
  };
  return ProjectionRevisionSchema.parse({
    ...base,
    projection_id: "projection_topic_scope_b",
    projection_revision_id: "projection_revision_topic_scope_b_1",
    scope: SCOPE_B,
    frontier,
    source_revisions: sourceRevisions,
    evidence_ids: sourceRevisions.flatMap((item) => item.evidence_ids),
  });
}

function telemetry() {
  return [
    {
      lane: "recent_l1",
      status: "eligible",
      candidate_count: 3,
      eligible_count: 3,
      selected_count: 3,
    },
    {
      lane: "topic",
      status: "eligible",
      candidate_count: 1,
      eligible_count: 1,
      selected_count: 1,
    },
    {
      lane: "scenario_procedure",
      status: "eligible",
      candidate_count: 1,
      eligible_count: 1,
      selected_count: 1,
    },
    {
      lane: "core",
      status: "eligible",
      candidate_count: 1,
      eligible_count: 1,
      selected_count: 1,
    },
    {
      lane: "relation_sqlite",
      status: "empty",
      candidate_count: 0,
      eligible_count: 0,
      selected_count: 0,
    },
  ].map((item) =>
    LaneTelemetrySchema.parse({
      ...item,
      duration_ms: 0,
      exclusion_counts: {},
      reason_codes: [],
    })
  );
}

function layeredInput(tokenBudget = 32_000) {
  const policy = {
    allowed_lanes: [
      "recent_l1",
      "topic",
      "scenario_procedure",
      "core",
    ],
    limits: {
      max_candidates_per_lane: 20,
      relation_max_depth: 2,
      relation_max_fanout: 5,
      max_concurrent_lanes: 2,
    },
  } as const;
  const candidates = [
    {
      kind: "memory",
      abstraction: "l1_memory",
      lane: "recent_l1",
      scope: SCOPE,
      rank: 1,
      canonical_revalidated: true,
      memory: MEMORY_A,
    },
    {
      kind: "memory",
      abstraction: "l1_memory",
      lane: "recent_l1",
      scope: SCOPE,
      rank: 2,
      canonical_revalidated: true,
      memory: MEMORY_B,
    },
    {
      kind: "memory",
      abstraction: "l1_memory",
      lane: "recent_l1",
      scope: SCOPE,
      rank: 3,
      canonical_revalidated: true,
      memory: MEMORY_C,
    },
    {
      kind: "projection",
      abstraction: "l2_topic",
      lane: "topic",
      scope: SCOPE,
      rank: 0,
      canonical_revalidated: true,
      projection: projection("topic"),
    },
    {
      kind: "projection",
      abstraction: "l3_core",
      lane: "core",
      scope: SCOPE,
      rank: 0,
      canonical_revalidated: true,
      projection: projection("core"),
    },
    {
      kind: "projection",
      abstraction: "l2_scenario",
      lane: "scenario_procedure",
      scope: SCOPE,
      rank: 0,
      canonical_revalidated: true,
      projection: projection("procedure"),
    },
  ] as const;
  return {
    request: {
      schema_version: "1.0.0",
      request_id: `layered_compile_${tokenBudget}`,
      goal: "Continue the governed agent memory task.",
      query: "agent memory canonical revalidation",
      scopes: [SCOPE],
      as_of: AS_OF,
      token_budget: tokenBudget,
      include_sensitive: false,
    },
    candidates,
    exclusions: [],
    frontier: CONTEXT_FRONTIER,
    effective_configuration: computeEffectiveLaneConfiguration(policy),
    telemetry: telemetry(),
    conflict_sets: [],
    created_at: AS_OF,
  };
}

describe("layered Context Compiler", () => {
  it("dedupes exact lineage, keeps constraints, and seals one decision set", () => {
    const input = layeredInput();
    const result = compileLayeredContext(input);
    const repeated = compileLayeredContext({
      ...input,
      candidates: [...input.candidates].reverse(),
    });

    expect(result).toEqual(repeated);
    expect(result.status).toBe("OK");
    expect(
      result.context_slice?.items.map((item) => item.revision_id),
    ).toEqual([
      "projection_revision_procedure_1",
      "projection_revision_core_1",
    ]);
    expect(
      result.receipt.items.filter(
        (item) =>
          item.reason_codes.includes("DEDUPED_BY_HIGHER_ABSTRACTION"),
      ).map((item) => item.revision_id).sort(),
    ).toEqual([
      "projection_revision_topic_1",
      "revision_a",
      "revision_b",
      "revision_c",
    ]);
    expect(
      result.context_slice?.items.every(
        (item) =>
          item.projection !== undefined &&
          item.score_components !== undefined &&
          item.decision_reason_codes?.includes(
            "CANONICAL_REVALIDATED",
          ),
      ),
    ).toBe(true);
    expect(result.context_slice?.frontier).toEqual(CONTEXT_FRONTIER);
    expect(result.receipt.frontier).toEqual(CONTEXT_FRONTIER);
    expect(result.context_slice?.frozen_hash).toBe(
      canonicalSha256Omitting(result.context_slice ?? {}, ["frozen_hash"]),
    );
    expect(receiptHashIsValid(result.receipt)).toBe(true);
    expect(result.context_slice?.token_used ?? 0).toBeLessThanOrEqual(
      input.request.token_budget,
    );
  });

  it("binds each projection to its own canonical V2 scope frontier", () => {
    const input = layeredInput();
    const scopeA = input.candidates.find(
      (candidate) =>
        candidate.kind === "projection" &&
        candidate.lane === "topic",
    );
    if (scopeA === undefined || scopeA.kind !== "projection") {
      throw new Error("scope A topic fixture is missing");
    }
    const scopeBProjection = projectionInSecondScope();
    const scopeB = {
      kind: "projection",
      abstraction: "l2_topic",
      lane: "topic",
      scope: SCOPE_B,
      rank: 0,
      canonical_revalidated: true,
      projection: scopeBProjection,
    } as const;
    const frontier = buildContextFrontierV2({
      ledger_epoch: PROJECTION_FRONTIER.ledger_epoch,
      tombstone_epoch: PROJECTION_FRONTIER.tombstone_epoch,
      scope_frontiers: [
        {
          scope: SCOPE_B,
          projection_epoch:
            scopeBProjection.frontier.projection_epoch,
          source_frontier_hash:
            scopeBProjection.frontier.source_frontier_hash,
          projection_frontier_hash:
            scopeBProjection.frontier.projection_frontier_hash,
          transform_versions: [scopeBProjection.transform],
        },
        {
          scope: SCOPE,
          projection_epoch: PROJECTION_FRONTIER.projection_epoch,
          source_frontier_hash:
            PROJECTION_FRONTIER.source_frontier_hash,
          projection_frontier_hash:
            PROJECTION_FRONTIER.projection_frontier_hash,
          transform_versions: [TRANSFORM],
        },
      ],
    });
    const compile = (reverse: boolean) =>
      compileLayeredContext({
        ...input,
        request: {
          ...input.request,
          request_id: "layered_compile_multi_scope",
          scopes: reverse ? [SCOPE_B, SCOPE] : [SCOPE, SCOPE_B],
        },
        candidates: reverse ? [scopeB, scopeA] : [scopeA, scopeB],
        frontier,
      });
    const first = compile(false);
    const permuted = compile(true);

    expect(first).toEqual(permuted);
    expect(
      first.context_slice?.items.map((item) => item.revision_id),
    ).toEqual([
      "projection_revision_topic_1",
      "projection_revision_topic_scope_b_1",
    ]);
    expect(first.context_slice?.frontier).toEqual(frontier);
    expect(first.receipt.frontier).toEqual(frontier);

    const missingScope = compileLayeredContext({
      ...input,
      request: {
        ...input.request,
        request_id: "layered_compile_missing_scope",
        scopes: [SCOPE, SCOPE_B],
      },
      candidates: [scopeB],
      frontier: buildContextFrontierV2({
        ledger_epoch: PROJECTION_FRONTIER.ledger_epoch,
        tombstone_epoch: PROJECTION_FRONTIER.tombstone_epoch,
        scope_frontiers: frontier.scope_frontiers.slice(0, 1),
      }),
    });
    expect(missingScope).toMatchObject({
      status: "POLICY_EXCLUDED",
      reason_codes: ["PROJECTION_STALE_FRONTIER"],
    });
    expect(() =>
      compileLayeredContext({
        ...input,
        candidates: [scopeA],
        frontier: {
          ...frontier,
          scope_frontiers: [
            frontier.scope_frontiers[0],
            frontier.scope_frontiers[0],
          ],
          aggregate_frontier_hash: canonicalSha256([
            frontier.scope_frontiers[0],
            frontier.scope_frontiers[0],
          ]),
        },
      }),
    ).toThrow(/unique/u);
  });

  it("preserves competing claims as an explicit conflict set", () => {
    const input = layeredInput();
    const conflictSet = ContextConflictSetSchema.parse({
      conflict_group_id: "conflict_agent_memory",
      member_revision_ids: ["revision_a", "revision_b"],
      current_revision_id: null,
      reason: "Two governed claims remain unresolved.",
    });
    const result = compileLayeredContext({
      ...input,
      request: {
        ...input.request,
        request_id: "layered_compile_conflict",
      },
      candidates: input.candidates.slice(0, 2),
      effective_configuration: computeEffectiveLaneConfiguration({
        allowed_lanes: ["recent_l1"],
        limits: {
          max_candidates_per_lane: 20,
          relation_max_depth: 2,
          relation_max_fanout: 5,
          max_concurrent_lanes: 1,
        },
      }),
      telemetry: telemetry().map((item) =>
        item.lane === "recent_l1"
          ? {
              ...item,
              candidate_count: 2,
              eligible_count: 2,
              selected_count: 2,
            }
          : {
              ...item,
              status: "disabled_by_request" as const,
              candidate_count: 0,
              eligible_count: 0,
              selected_count: 0,
              reason_codes: ["LANE_NOT_REQUESTED"],
            }
      ),
      conflict_sets: [conflictSet],
    });

    expect(result.context_slice?.items).toHaveLength(2);
    expect(
      result.context_slice?.items.map((item) => item.conflict_group_id),
    ).toEqual(["conflict_agent_memory", "conflict_agent_memory"]);
    expect(result.context_slice?.conflict_sets).toEqual([conflictSet]);
    expect(
      result.context_slice?.items.map((item) =>
        item.content.storage === "inline" ? item.content.text : ""
      ).sort(),
    ).toEqual([
      "Agent memory remains governed.",
      "Agent memory stays governed.",
    ]);
  });

  it("fails closed on unverified or stale high-scoring projections", () => {
    const input = layeredInput();
    const core = input.candidates.find(
      (candidate) => candidate.kind === "projection" &&
        candidate.lane === "core",
    );
    if (core === undefined || core.kind !== "projection") {
      throw new Error("core fixture is missing");
    }
    const unverified = compileLayeredContext({
      ...input,
      request: {
        ...input.request,
        request_id: "layered_compile_unverified",
      },
      candidates: [
        {
          ...core,
          rank: -1_000_000,
          canonical_revalidated: false,
        },
      ],
    });
    const stale = compileLayeredContext({
      ...input,
      request: {
        ...input.request,
        request_id: "layered_compile_stale",
      },
      candidates: [
        {
          ...core,
          rank: -1_000_000,
          projection: ProjectionRevisionSchema.parse({
            ...core.projection,
            frontier: {
              ...core.projection.frontier,
              ledger_epoch: core.projection.frontier.ledger_epoch - 1,
            },
          }),
        },
      ],
    });

    expect(unverified).toMatchObject({
      status: "POLICY_EXCLUDED",
      reason_codes: ["CANONICAL_REVALIDATION_REQUIRED"],
    });
    expect(stale).toMatchObject({
      status: "POLICY_EXCLUDED",
      reason_codes: ["PROJECTION_STALE_FRONTIER"],
    });
    expect(unverified.context_slice?.items).toEqual([]);
    expect(stale.context_slice?.items).toEqual([]);
  });

  it("returns a sealed empty Context for an empty eligible set", () => {
    const input = layeredInput();
    const result = compileLayeredContext({
      ...input,
      request: {
        ...input.request,
        request_id: "layered_compile_empty",
      },
      candidates: [],
      telemetry: telemetry().map((item) => ({
        ...item,
        status: item.lane === "relation_sqlite"
          ? item.status
          : "empty" as const,
        candidate_count: 0,
        eligible_count: 0,
        selected_count: 0,
      })),
    });

    expect(result.status).toBe("NO_MATCH");
    expect(result.context_slice).toMatchObject({
      token_used: 0,
      items: [],
    });
    expect(result.receipt.context_slice_id).toBe(
      result.context_slice?.context_slice_id,
    );
    expect(receiptHashIsValid(result.receipt)).toBe(true);
  });

  it("rejects disabled-lane injection before scoring", () => {
    const input = layeredInput();
    expect(() =>
      CompileLayeredContextInputSchema.parse({
        ...input,
        effective_configuration: computeEffectiveLaneConfiguration({
          allowed_lanes: ["recent_l1"],
          limits: {
            max_candidates_per_lane: 20,
            relation_max_depth: 2,
            relation_max_fanout: 5,
            max_concurrent_lanes: 1,
          },
        }),
      }),
    ).toThrow(/disabled lane/u);
  });
});
