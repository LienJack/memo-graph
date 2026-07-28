import { z } from "zod";

import { canonicalSha256 } from "./canonical-json.js";
import type { AbstractionLevelSchema } from "./common.js";
import {
  AuthoritySchema,
  CanonicalHashSchema,
  ContentRefSchema,
  ContractVersionSchema,
  IdentifierSchema,
  LifecycleSchema,
  NonEmptyReasonSchema,
  ScopeSchema,
  SensitivitySchema,
  TransformRefSchema,
  UtcTimestampSchema,
  ValidityWindowSchema,
  scopeKey,
} from "./common.js";

export const ProjectionTypeSchema = z.enum([
  "topic",
  "scenario",
  "procedure",
  "relation",
  "core",
]);

const ProjectionKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .transform((value) =>
    value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ")
  );

const ProjectionTextSchema = z.string().trim().min(1).max(8_000);
const ProjectionTextListSchema = z.array(ProjectionTextSchema).max(100);

export const TopicProjectionPayloadSchema = z
  .object({
    kind: z.literal("topic"),
    key: ProjectionKeySchema,
    summary: ProjectionTextSchema,
    open_items: ProjectionTextListSchema,
  })
  .strict();

export const ScenarioProjectionPayloadSchema = z
  .object({
    kind: z.literal("scenario"),
    key: ProjectionKeySchema,
    trigger: ProjectionTextSchema,
    preconditions: ProjectionTextListSchema,
    outcomes: ProjectionTextListSchema,
  })
  .strict();

export const ProcedureProjectionPayloadSchema = z
  .object({
    kind: z.literal("procedure"),
    key: ProjectionKeySchema,
    goal: ProjectionTextSchema,
    preconditions: ProjectionTextListSchema,
    steps: z.array(ProjectionTextSchema).min(1).max(100),
    exceptions: ProjectionTextListSchema,
    failure_modes: ProjectionTextListSchema,
    recovery_steps: ProjectionTextListSchema,
  })
  .strict();

export const RelationTypeSchema = z.enum([
  "supports",
  "contradicts",
  "supersedes",
  "depends_on",
  "causes",
  "precedes",
  "belongs_to_topic",
  "applies_to_scenario",
  "references_entity",
]);

export const RelationProjectionPayloadSchema = z
  .object({
    kind: z.literal("relation"),
    source_revision_id: IdentifierSchema,
    target_revision_id: IdentifierSchema,
    relation_type: RelationTypeSchema,
    direction: z.enum(["directed", "undirected"]),
    description: ProjectionTextSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.source_revision_id === value.target_revision_id) {
      context.addIssue({
        code: "custom",
        path: ["target_revision_id"],
        message: "relation endpoints must be distinct revisions",
      });
    }
  });

export const CoreProjectionPayloadSchema = z
  .object({
    kind: z.literal("core"),
    statement: ProjectionTextSchema,
    applicability: z.array(ProjectionTextSchema).min(1).max(100),
    constraints: ProjectionTextListSchema,
    confidence: z.number().finite().min(0).max(1),
    promotion_basis: z.array(ProjectionTextSchema).min(1).max(100),
  })
  .strict();

export const ProjectionPayloadSchema = z.discriminatedUnion("kind", [
  TopicProjectionPayloadSchema,
  ScenarioProjectionPayloadSchema,
  ProcedureProjectionPayloadSchema,
  RelationProjectionPayloadSchema,
  CoreProjectionPayloadSchema,
]);

export const ProjectionSourceSchema = z
  .object({
    memory_id: IdentifierSchema,
    revision_id: IdentifierSchema,
    abstraction: z.enum([
      "l1_memory",
      "l2_topic",
      "l2_scenario",
      "l2_relation",
    ]),
    principal_id: IdentifierSchema,
    scope: ScopeSchema,
    authority: AuthoritySchema,
    sensitivity: SensitivitySchema,
    validity: ValidityWindowSchema,
    content_hash: CanonicalHashSchema,
    evidence_ids: z.array(IdentifierSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.evidence_ids).size !== value.evidence_ids.length) {
      context.addIssue({
        code: "custom",
        path: ["evidence_ids"],
        message: "projection source evidence ids must be unique",
      });
    }
  });

export const ProjectionFrontierSchema = z
  .object({
    schema_version: ContractVersionSchema,
    ledger_epoch: z.number().int().nonnegative(),
    tombstone_epoch: z.number().int().nonnegative(),
    projection_epoch: z.number().int().nonnegative(),
    transform: TransformRefSchema,
    source_frontier_hash: CanonicalHashSchema,
    projection_frontier_hash: CanonicalHashSchema,
  })
  .strict();

export const ContextFrontierSchema = z
  .object({
    schema_version: ContractVersionSchema,
    ledger_epoch: z.number().int().nonnegative(),
    tombstone_epoch: z.number().int().nonnegative(),
    projection_epoch: z.number().int().nonnegative(),
    source_frontier_hash: CanonicalHashSchema,
    projection_frontier_hash: CanonicalHashSchema,
    transform_versions: z.array(TransformRefSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const identities = value.transform_versions.map(
      (transform) => `${transform.name}:${transform.version}`,
    );
    if (new Set(identities).size !== identities.length) {
      context.addIssue({
        code: "custom",
        path: ["transform_versions"],
        message: "Context transform versions must be unique",
      });
    }
  });

const PROJECTION_ABSTRACTION = {
  topic: "l2_topic",
  scenario: "l2_scenario",
  procedure: "l2_scenario",
  relation: "l2_relation",
  core: "l3_core",
} as const;

const ABSTRACTION_RANK: Record<
  z.infer<typeof AbstractionLevelSchema>,
  number
> = {
  l0_evidence: 0,
  l1_memory: 1,
  l2_topic: 2,
  l2_scenario: 2,
  l2_relation: 2,
  l3_core: 3,
};

const SENSITIVITY_RANK: Record<
  z.infer<typeof SensitivitySchema>,
  number
> = {
  public: 0,
  internal: 1,
  personal: 2,
  sensitive: 3,
  secret: 4,
};

function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const leftSet = [...new Set(left)].sort();
  const rightSet = [...new Set(right)].sort();
  return (
    left.length === leftSet.length &&
    leftSet.length === rightSet.length &&
    leftSet.every((value, index) => value === rightSet[index])
  );
}

export const ProjectionRevisionSchema = z
  .object({
    schema_version: ContractVersionSchema,
    projection_id: IdentifierSchema,
    projection_revision_id: IdentifierSchema,
    revision: z.number().int().positive(),
    projection_type: ProjectionTypeSchema,
    abstraction: z.enum([
      "l2_topic",
      "l2_scenario",
      "l2_relation",
      "l3_core",
    ]),
    principal_id: IdentifierSchema,
    scope: ScopeSchema,
    lifecycle: LifecycleSchema,
    authority: z.literal("derived"),
    sensitivity: SensitivitySchema,
    validity: ValidityWindowSchema,
    payload: ProjectionPayloadSchema.nullable(),
    content: ContentRefSchema.nullable(),
    content_hash: CanonicalHashSchema,
    source_revisions: z.array(ProjectionSourceSchema).min(1),
    evidence_ids: z.array(IdentifierSchema).min(1),
    supersedes_projection_revision_id: IdentifierSchema.nullable(),
    transform: TransformRefSchema,
    frontier: ProjectionFrontierSchema,
    created_at: UtcTimestampSchema,
    invalidated_at: UtcTimestampSchema.nullable(),
    invalidation_reason: NonEmptyReasonSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (PROJECTION_ABSTRACTION[value.projection_type] !== value.abstraction) {
      context.addIssue({
        code: "custom",
        path: ["abstraction"],
        message: "projection type and abstraction level must agree",
      });
    }
    if (value.payload !== null && value.payload.kind !== value.projection_type) {
      context.addIssue({
        code: "custom",
        path: ["payload", "kind"],
        message: "projection type and payload kind must agree",
      });
    }

    const sourceRevisionIds = value.source_revisions.map(
      (source) => source.revision_id,
    );
    if (
      new Set(sourceRevisionIds).size !== value.source_revisions.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["source_revisions"],
        message: "projection source revisions must be unique",
      });
    }

    const sourceEvidenceIds = value.source_revisions.flatMap(
      (source) => source.evidence_ids,
    );
    if (!sameStringSet(value.evidence_ids, sourceEvidenceIds)) {
      context.addIssue({
        code: "custom",
        path: ["evidence_ids"],
        message:
          "projection evidence ids must exactly match source evidence lineage",
      });
    }

    const projectionRank = ABSTRACTION_RANK[value.abstraction];
    for (const [index, source] of value.source_revisions.entries()) {
      if (
        source.principal_id !== value.principal_id ||
        scopeKey(source.scope) !== scopeKey(value.scope)
      ) {
        context.addIssue({
          code: "custom",
          path: ["source_revisions", index, "scope"],
          message:
            "projection sources must share the exact principal and scope",
        });
      }
      if (ABSTRACTION_RANK[source.abstraction] >= projectionRank) {
        context.addIssue({
          code: "custom",
          path: ["source_revisions", index, "abstraction"],
          message: "projection sources must be from a lower abstraction",
        });
      }
      if (
        SENSITIVITY_RANK[value.sensitivity] <
        SENSITIVITY_RANK[source.sensitivity]
      ) {
        context.addIssue({
          code: "custom",
          path: ["sensitivity"],
          message: "projection sensitivity cannot be lower than its sources",
        });
      }
      if (
        Date.parse(value.validity.valid_from) <
          Date.parse(source.validity.valid_from) ||
        Date.parse(value.validity.recorded_at) <
          Date.parse(source.validity.recorded_at) ||
        (source.validity.valid_to !== null &&
          (value.validity.valid_to === null ||
            Date.parse(value.validity.valid_to) >
              Date.parse(source.validity.valid_to)))
      ) {
        context.addIssue({
          code: "custom",
          path: ["validity"],
          message:
            "projection validity must stay inside every source validity window",
        });
      }
    }

    if (
      value.transform.name !== value.frontier.transform.name ||
      value.transform.version !== value.frontier.transform.version
    ) {
      context.addIssue({
        code: "custom",
        path: ["frontier", "transform"],
        message: "projection frontier must name the applied transform",
      });
    }

    const isPurged = value.lifecycle === "purged";
    if (
      (isPurged && (value.payload !== null || value.content !== null)) ||
      (!isPurged && (value.payload === null || value.content === null))
    ) {
      context.addIssue({
        code: "custom",
        path: ["payload"],
        message:
          "only purged projections may redact payload and rendered content",
      });
    }

    const isInvalidated = [
      "superseded",
      "revoked",
      "quarantined",
      "purged",
    ].includes(value.lifecycle);
    if (
      isInvalidated !==
      (value.invalidated_at !== null && value.invalidation_reason !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["invalidated_at"],
        message:
          "invalid projection lifecycle requires time and reason evidence",
      });
    }
    if (
      value.revision === 1 &&
      value.supersedes_projection_revision_id !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["supersedes_projection_revision_id"],
        message: "the first projection revision cannot supersede another",
      });
    }
    if (
      value.revision > 1 &&
      value.supersedes_projection_revision_id === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["supersedes_projection_revision_id"],
        message: "later projection revisions must identify their predecessor",
      });
    }

    if (value.payload?.kind === "relation") {
      const sourceIds = new Set(sourceRevisionIds);
      if (
        !sourceIds.has(value.payload.source_revision_id) ||
        !sourceIds.has(value.payload.target_revision_id)
      ) {
        context.addIssue({
          code: "custom",
          path: ["payload"],
          message: "relation endpoints must be exact projection sources",
        });
      }
    }
  });

const ProjectionIdentityInputSchema = z.object({
  projection_type: ProjectionTypeSchema,
  principal_id: IdentifierSchema,
  scope: ScopeSchema,
  source_revisions: z.array(
    z.object({ revision_id: IdentifierSchema }).passthrough(),
  ).min(1),
  transform: TransformRefSchema,
  content_hash: CanonicalHashSchema,
});

export function deriveProjectionIdentity(input: unknown): string {
  const value = ProjectionIdentityInputSchema.parse(input);
  return `projection:${canonicalSha256({
    projection_type: value.projection_type,
    principal_id: value.principal_id,
    scope: value.scope,
    source_revision_ids: value.source_revisions
      .map((source) => source.revision_id)
      .sort(),
    transform: value.transform,
    normalized_output_hash: value.content_hash,
  }).slice("sha256:".length)}`;
}

export const ProjectionLineageRefSchema = z
  .object({
    projection_id: IdentifierSchema,
    projection_revision_id: IdentifierSchema,
    source_revision_ids: z.array(IdentifierSchema).min(1),
    source_content_hashes: z.array(CanonicalHashSchema).min(1),
    transform: TransformRefSchema,
    frontier: ProjectionFrontierSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.source_revision_ids).size !==
      value.source_revision_ids.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["source_revision_ids"],
        message: "projection lineage revision ids must be unique",
      });
    }
    if (
      value.source_revision_ids.length !== value.source_content_hashes.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["source_content_hashes"],
        message: "projection source ids and hashes must have equal length",
      });
    }
    if (
      value.transform.name !== value.frontier.transform.name ||
      value.transform.version !== value.frontier.transform.version
    ) {
      context.addIssue({
        code: "custom",
        path: ["frontier", "transform"],
        message: "lineage frontier must name the same transform",
      });
    }
  });

export const RecallLaneSchema = z.enum([
  "recent_l1",
  "topic",
  "scenario_procedure",
  "core",
  "relation_sqlite",
]);

export const LaneLimitsSchema = z
  .object({
    max_candidates_per_lane: z.number().int().min(1).max(1_000),
    relation_max_depth: z.number().int().min(0).max(4),
    relation_max_fanout: z.number().int().min(1).max(100),
    max_concurrent_lanes: z.number().int().min(1).max(
      RecallLaneSchema.options.length,
    ),
  })
  .strict();

export const LaneLimitOverridesSchema = LaneLimitsSchema.partial();

function addDuplicateLaneIssue(
  lanes: readonly string[],
  context: z.RefinementCtx,
  path: PropertyKey[],
): void {
  if (new Set(lanes).size !== lanes.length) {
    context.addIssue({
      code: "custom",
      path,
      message: "lane identifiers must be unique",
    });
  }
}

export const LanePolicySchema = z
  .object({
    allowed_lanes: z.array(RecallLaneSchema),
    limits: LaneLimitsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateLaneIssue(value.allowed_lanes, context, ["allowed_lanes"]);
  });

export const LaneRequestOverridesSchema = z
  .object({
    requested_lanes: z.array(RecallLaneSchema),
    limits: LaneLimitOverridesSchema,
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateLaneIssue(
      value.requested_lanes,
      context,
      ["requested_lanes"],
    );
  });

export const EffectiveLaneConfigurationSchema = z
  .object({
    policy_hash: CanonicalHashSchema,
    requested_lanes: z.array(RecallLaneSchema),
    enabled_lanes: z.array(RecallLaneSchema),
    limits: LaneLimitsSchema,
    reason_codes: z.array(z.string().trim().min(1).max(200)),
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateLaneIssue(
      value.requested_lanes,
      context,
      ["requested_lanes"],
    );
    addDuplicateLaneIssue(value.enabled_lanes, context, ["enabled_lanes"]);
    const requested = new Set(value.requested_lanes);
    if (value.enabled_lanes.some((lane) => !requested.has(lane))) {
      context.addIssue({
        code: "custom",
        path: ["enabled_lanes"],
        message: "effective lanes must be requested lanes",
      });
    }
  });

const LIMIT_KEYS = [
  "max_candidates_per_lane",
  "max_concurrent_lanes",
  "relation_max_depth",
  "relation_max_fanout",
] as const;

export function computeEffectiveLaneConfiguration(
  policyInput: unknown,
  overridesInput?: unknown,
): z.infer<typeof EffectiveLaneConfigurationSchema> {
  const policy = LanePolicySchema.parse(policyInput);
  const overrides =
    overridesInput === undefined
      ? {
          requested_lanes: [...policy.allowed_lanes],
          limits: {},
        }
      : LaneRequestOverridesSchema.parse(overridesInput);
  const requested = RecallLaneSchema.options.filter((lane) =>
    overrides.requested_lanes.includes(lane)
  );
  const allowed = new Set(policy.allowed_lanes);
  const enabled = requested.filter((lane) => allowed.has(lane));
  const reasonCodes = requested
    .filter((lane) => !allowed.has(lane))
    .map((lane) => `LANE_DENIED_BY_POLICY:${lane}`);

  const limits = { ...policy.limits };
  for (const key of LIMIT_KEYS) {
    const requestedLimit = overrides.limits[key];
    if (requestedLimit === undefined) {
      continue;
    }
    if (requestedLimit > policy.limits[key]) {
      reasonCodes.push(`LIMIT_CLAMPED_BY_POLICY:${key}`);
      continue;
    }
    limits[key] = requestedLimit;
  }

  return EffectiveLaneConfigurationSchema.parse({
    policy_hash: canonicalSha256(policy),
    requested_lanes: requested,
    enabled_lanes: enabled,
    limits,
    reason_codes: reasonCodes.sort(),
  });
}

export const LaneStatusSchema = z.enum([
  "disabled_by_policy",
  "disabled_by_request",
  "unavailable",
  "stale",
  "empty",
  "eligible",
  "degraded",
]);

export const LaneTelemetrySchema = z
  .object({
    lane: RecallLaneSchema,
    status: LaneStatusSchema,
    duration_ms: z.number().finite().nonnegative(),
    candidate_count: z.number().int().nonnegative(),
    eligible_count: z.number().int().nonnegative(),
    selected_count: z.number().int().nonnegative(),
    exclusion_counts: z.record(
      z.string().trim().min(1).max(200),
      z.number().int().nonnegative(),
    ),
    reason_codes: z.array(z.string().trim().min(1).max(200)),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.selected_count > value.eligible_count ||
      value.eligible_count > value.candidate_count
    ) {
      context.addIssue({
        code: "custom",
        path: ["selected_count"],
        message: "lane counts must satisfy selected <= eligible <= candidate",
      });
    }
    if (
      ["disabled_by_policy", "disabled_by_request"].includes(value.status) &&
      (value.candidate_count !== 0 ||
        value.eligible_count !== 0 ||
        value.selected_count !== 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "disabled lanes cannot report candidates or selections",
      });
    }
    if (
      ["unavailable", "stale", "degraded"].includes(value.status) &&
      value.reason_codes.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["reason_codes"],
        message: "failed or degraded lanes require a stable reason code",
      });
    }
  });

export const ContextScoreComponentsSchema = z
  .object({
    relevance: z.number().finite(),
    authority: z.number().finite(),
    freshness: z.number().finite(),
    evidence_diversity: z.number().finite(),
    conflict_cost: z.number().finite(),
    token_utility: z.number().finite(),
    lane_contribution: z.number().finite(),
  })
  .strict();

export const ContextConflictSetSchema = z
  .object({
    conflict_group_id: IdentifierSchema,
    member_revision_ids: z.array(IdentifierSchema).min(2),
    current_revision_id: IdentifierSchema.nullable(),
    reason: NonEmptyReasonSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.member_revision_ids).size !==
      value.member_revision_ids.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["member_revision_ids"],
        message: "conflict members must be unique",
      });
    }
    if (
      value.current_revision_id !== null &&
      !value.member_revision_ids.includes(value.current_revision_id)
    ) {
      context.addIssue({
        code: "custom",
        path: ["current_revision_id"],
        message: "current conflict revision must be a conflict member",
      });
    }
  });

export type ContextConflictSet = z.infer<typeof ContextConflictSetSchema>;
export type ContextFrontier = z.infer<typeof ContextFrontierSchema>;
export type ContextScoreComponents = z.infer<
  typeof ContextScoreComponentsSchema
>;
export type EffectiveLaneConfiguration = z.infer<
  typeof EffectiveLaneConfigurationSchema
>;
export type LaneLimits = z.infer<typeof LaneLimitsSchema>;
export type LanePolicy = z.infer<typeof LanePolicySchema>;
export type LaneRequestOverrides = z.infer<
  typeof LaneRequestOverridesSchema
>;
export type LaneStatus = z.infer<typeof LaneStatusSchema>;
export type LaneTelemetry = z.infer<typeof LaneTelemetrySchema>;
export type ProjectionFrontier = z.infer<typeof ProjectionFrontierSchema>;
export type ProjectionLineageRef = z.infer<
  typeof ProjectionLineageRefSchema
>;
export type ProjectionPayload = z.infer<typeof ProjectionPayloadSchema>;
export type ProjectionRevision = z.infer<typeof ProjectionRevisionSchema>;
export type ProjectionSource = z.infer<typeof ProjectionSourceSchema>;
export type ProjectionType = z.infer<typeof ProjectionTypeSchema>;
export type RecallLane = z.infer<typeof RecallLaneSchema>;
