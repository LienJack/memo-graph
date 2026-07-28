import { describe, expect, it } from "vitest";

import {
  ContextFrontierSchema,
  ContextSliceSchema,
  G3OverlayCaseSchema,
  G3OverlayManifestSchema,
  LaneTelemetrySchema,
  ProjectionRevisionSchema,
  computeEffectiveLaneConfiguration,
  deriveProjectionIdentity,
} from "../../packages/contracts/src/index.js";
import {
  HASH_A,
  HASH_B,
  LATER,
  NOW,
  USER_SCOPE,
} from "../helpers/examples.js";

const TRANSFORM = {
  name: "deterministic-g3-projection",
  version: "1.0.0",
} as const;

const FRONTIER = {
  schema_version: "1.0.0",
  ledger_epoch: 10,
  tombstone_epoch: 2,
  projection_epoch: 4,
  transform: TRANSFORM,
  source_frontier_hash: HASH_A,
  projection_frontier_hash: HASH_B,
} as const;

const SOURCE_A = {
  memory_id: "memory_source_a",
  revision_id: "revision_source_a",
  abstraction: "l1_memory",
  principal_id: "user_local",
  scope: USER_SCOPE,
  authority: "user_stated",
  sensitivity: "personal",
  validity: {
    valid_from: NOW,
    valid_to: LATER,
    recorded_at: NOW,
  },
  content_hash: HASH_A,
  evidence_ids: ["evidence_a"],
} as const;

const SOURCE_B = {
  memory_id: "memory_source_b",
  revision_id: "revision_source_b",
  abstraction: "l1_memory",
  principal_id: "user_local",
  scope: USER_SCOPE,
  authority: "observed",
  sensitivity: "internal",
  validity: {
    valid_from: NOW,
    valid_to: LATER,
    recorded_at: NOW,
  },
  content_hash: HASH_B,
  evidence_ids: ["evidence_b"],
} as const;

const PAYLOADS = {
  topic: {
    kind: "topic",
    key: "agent_memory_runtime",
    summary: "M3 keeps layered memory derived from the canonical ledger.",
    open_items: ["Measure G3 context utility."],
  },
  scenario: {
    kind: "scenario",
    key: "stale_projection_recall",
    trigger: "A canonical source changes before projection cleanup.",
    preconditions: ["A derived row still exists."],
    outcomes: ["Canonical revalidation excludes the row."],
  },
  procedure: {
    kind: "procedure",
    key: "projection_rebuild",
    goal: "Rebuild derived state without resurrection.",
    preconditions: ["Canonical sources are readable."],
    steps: ["Read eligible sources.", "Write one deterministic batch."],
    exceptions: ["A source becomes ineligible before apply."],
    failure_modes: ["Transform failure."],
    recovery_steps: ["Retry the idempotent outbox job."],
  },
  relation: {
    kind: "relation",
    source_revision_id: SOURCE_A.revision_id,
    target_revision_id: SOURCE_B.revision_id,
    relation_type: "supports",
    direction: "directed",
    description: "The two revisions support the same governed conclusion.",
  },
  core: {
    kind: "core",
    statement: "SQLite remains the sole memory authority.",
    applicability: ["local memory runtime"],
    constraints: ["Derived lanes cannot authorize content."],
    confidence: 1,
    promotion_basis: ["Repeated governed evidence."],
  },
} as const;

const ABSTRACTIONS = {
  topic: "l2_topic",
  scenario: "l2_scenario",
  procedure: "l2_scenario",
  relation: "l2_relation",
  core: "l3_core",
} as const;

function validProjection(
  projectionType: keyof typeof PAYLOADS = "topic",
) {
  return {
    schema_version: "1.0.0",
    projection_id: `projection_${projectionType}`,
    projection_revision_id: `projection_revision_${projectionType}_1`,
    revision: 1,
    projection_type: projectionType,
    abstraction: ABSTRACTIONS[projectionType],
    principal_id: "user_local",
    scope: USER_SCOPE,
    lifecycle: "active",
    authority: "derived",
    sensitivity: "personal",
    validity: {
      valid_from: NOW,
      valid_to: LATER,
      recorded_at: NOW,
    },
    payload: PAYLOADS[projectionType],
    content: {
      storage: "inline",
      text: `Rendered ${projectionType} projection.`,
      media_type: "text/plain",
    },
    content_hash: HASH_A,
    source_revisions: [SOURCE_A, SOURCE_B],
    evidence_ids: ["evidence_a", "evidence_b"],
    supersedes_projection_revision_id: null,
    transform: TRANSFORM,
    frontier: FRONTIER,
    created_at: NOW,
    invalidated_at: null,
    invalidation_reason: null,
  } as const;
}

const LANE_POLICY = {
  allowed_lanes: ["recent_l1", "topic"],
  limits: {
    max_candidates_per_lane: 50,
    relation_max_depth: 2,
    relation_max_fanout: 10,
    max_concurrent_lanes: 2,
  },
} as const;

describe("layered projection contracts", () => {
  it.each(
    Object.keys(PAYLOADS) as Array<keyof typeof PAYLOADS>,
  )("accepts a typed %s projection with exact governed lineage", (kind) => {
    expect(ProjectionRevisionSchema.parse(validProjection(kind))).toMatchObject({
      projection_type: kind,
      abstraction: ABSTRACTIONS[kind],
      authority: "derived",
      source_revisions: [
        { revision_id: SOURCE_A.revision_id },
        { revision_id: SOURCE_B.revision_id },
      ],
    });
  });

  it("derives one stable identity from reordered source revisions", () => {
    const original = validProjection();
    const reversed = {
      ...original,
      source_revisions: [...original.source_revisions].reverse(),
    };

    expect(deriveProjectionIdentity(original)).toBe(
      deriveProjectionIdentity(reversed),
    );
    expect(
      ProjectionRevisionSchema.parse(reversed).source_revisions.map(
        (source) => source.revision_id,
      ),
    ).toEqual([SOURCE_B.revision_id, SOURCE_A.revision_id]);
  });

  it("rejects duplicate, foreign-scope, and privilege-amplifying lineage", () => {
    expect(
      ProjectionRevisionSchema.safeParse({
        ...validProjection(),
        source_revisions: [SOURCE_A, SOURCE_A],
      }).success,
    ).toBe(false);
    expect(
      ProjectionRevisionSchema.safeParse({
        ...validProjection(),
        source_revisions: [
          SOURCE_A,
          {
            ...SOURCE_B,
            scope: { kind: "workspace", id: "other_workspace" },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      ProjectionRevisionSchema.safeParse({
        ...validProjection(),
        authority: "user_stated",
      }).success,
    ).toBe(false);
    expect(
      ProjectionRevisionSchema.safeParse({
        ...validProjection(),
        sensitivity: "internal",
      }).success,
    ).toBe(false);
  });

  it("rejects widened validity, incomplete evidence, and invalid relation endpoints", () => {
    expect(
      ProjectionRevisionSchema.safeParse({
        ...validProjection(),
        validity: {
          valid_from: NOW,
          valid_to: null,
          recorded_at: NOW,
        },
      }).success,
    ).toBe(false);
    expect(
      ProjectionRevisionSchema.safeParse({
        ...validProjection(),
        evidence_ids: ["evidence_a"],
      }).success,
    ).toBe(false);
    expect(
      ProjectionRevisionSchema.safeParse({
        ...validProjection("relation"),
        payload: {
          ...PAYLOADS.relation,
          target_revision_id: "revision_not_in_lineage",
        },
      }).success,
    ).toBe(false);
  });

  it("requires payload redaction and invalidation evidence for purged projections", () => {
    expect(
      ProjectionRevisionSchema.safeParse({
        ...validProjection(),
        lifecycle: "purged",
      }).success,
    ).toBe(false);
    expect(
      ProjectionRevisionSchema.safeParse({
        ...validProjection(),
        lifecycle: "purged",
        payload: null,
        content: null,
        invalidated_at: LATER,
        invalidation_reason: "The source was purged.",
      }).success,
    ).toBe(true);
  });
});

describe("lane and frontier contracts", () => {
  it("intersects request overrides with operator-owned lane policy", () => {
    const effective = computeEffectiveLaneConfiguration(LANE_POLICY, {
      requested_lanes: ["topic", "core"],
      limits: {
        max_candidates_per_lane: 100,
        relation_max_depth: 4,
        relation_max_fanout: 20,
        max_concurrent_lanes: 4,
      },
    });

    expect(effective.enabled_lanes).toEqual(["topic"]);
    expect(effective.limits).toEqual(LANE_POLICY.limits);
    expect(effective.reason_codes).toEqual([
      "LANE_DENIED_BY_POLICY:core",
      "LIMIT_CLAMPED_BY_POLICY:max_candidates_per_lane",
      "LIMIT_CLAMPED_BY_POLICY:max_concurrent_lanes",
      "LIMIT_CLAMPED_BY_POLICY:relation_max_depth",
      "LIMIT_CLAMPED_BY_POLICY:relation_max_fanout",
    ]);
  });

  it("rejects impossible lane counts and duplicate transforms", () => {
    expect(
      LaneTelemetrySchema.safeParse({
        lane: "topic",
        status: "eligible",
        duration_ms: 1,
        candidate_count: 1,
        eligible_count: 2,
        selected_count: 2,
        exclusion_counts: {},
        reason_codes: [],
      }).success,
    ).toBe(false);
    expect(
      ContextFrontierSchema.safeParse({
        schema_version: FRONTIER.schema_version,
        ledger_epoch: FRONTIER.ledger_epoch,
        tombstone_epoch: FRONTIER.tombstone_epoch,
        projection_epoch: FRONTIER.projection_epoch,
        source_frontier_hash: FRONTIER.source_frontier_hash,
        projection_frontier_hash: FRONTIER.projection_frontier_hash,
        transform_versions: [TRANSFORM, TRANSFORM],
      }).success,
    ).toBe(false);
  });
});

describe("layered Context and G3 overlay contracts", () => {
  it("requires complete frontier, lane, score, and lineage data for projection items", () => {
    const projection = validProjection();
    expect(
      ContextSliceSchema.safeParse({
        schema_version: "1.0.0",
        context_slice_id: "context_layered_1",
        request_id: "request_layered_1",
        compiler_version: "2.0.0",
        created_at: NOW,
        token_budget: 128,
        token_used: 32,
        items: [
          {
            memory_id: projection.projection_id,
            revision_id: projection.projection_revision_id,
            abstraction: projection.abstraction,
            lifecycle: projection.lifecycle,
            authority: projection.authority,
            sensitivity: projection.sensitivity,
            scope: projection.scope,
            content: projection.content,
            evidence_ids: projection.evidence_ids,
            selection_reason: "Selected by the topic lane.",
            uncertainty: null,
            token_estimate: 32,
          },
        ],
        frozen_hash: HASH_A,
      }).success,
    ).toBe(false);
  });

  it("accepts a strict hash-bound G3 overlay and rejects an incomplete arm set", () => {
    const overlay = {
      overlay_schema_version: "1.0.0",
      case_id: "case_normal_01",
      base_case_hash: HASH_A,
      partition: "calibration",
      projection_seeds: [validProjection()],
      rubric: {
        required_task_units: ["Identify the governed authority."],
        required_evidence_units: ["evidence_a"],
        prohibited_pollution: ["unrelated_scenario"],
      },
      lane_policy: LANE_POLICY,
      lane_overrides: {
        requested_lanes: ["recent_l1", "topic"],
        limits: {},
      },
      token_budgets: [128],
    } as const;
    expect(G3OverlayCaseSchema.parse(overlay).case_id).toBe(
      "case_normal_01",
    );

    const descriptors = (
      ["calibration", "holdout", "transfer"] as const
    ).map((partition, index) => ({
      case_id: `case_${partition}`,
      partition,
      base_case_hash: HASH_A,
      overlay_file: `overlays/${partition}/case_${index}.json`,
      content_hash: HASH_B,
    }));
    const manifest = {
      overlay_version: "1.0.0",
      base_corpus_version: "1.0.0",
      base_manifest_hash: HASH_A,
      frozen_at: NOW,
      arms: ["accepted_m2", "m3_no_projection", "m3_layered"],
      cases: descriptors,
    } as const;

    expect(G3OverlayManifestSchema.safeParse(manifest).success).toBe(true);
    expect(
      G3OverlayManifestSchema.safeParse({
        ...manifest,
        arms: ["accepted_m2", "m3_layered"],
      }).success,
    ).toBe(false);
  });
});
