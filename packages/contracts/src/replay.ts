import { z } from "zod";

import {
  CanonicalHashSchema,
  ContractVersionSchema,
  IdentifierSchema,
  NonEmptyReasonSchema,
  ScopeSchema,
  UtcTimestampSchema,
} from "./common.js";
import { EvaluationPartitionSchema } from "./learning.js";
import { RecallStatusSchema } from "./mcp.js";
import {
  GraphPathEvidenceSchema,
  GraphQueryModeSchema,
} from "./graph.js";
import {
  LanePolicySchema,
  LaneRequestOverridesSchema,
  ProjectionRevisionSchema,
  ProjectionTypeSchema,
  RecallLaneSchema,
  RelationTypeSchema,
} from "./projections.js";

export const ReplayRiskFamilySchema = z.enum([
  "normal",
  "conflict",
  "correction",
  "deletion",
  "privacy",
  "prompt_injection",
  "temporal",
  "multi_hop",
  "failure",
  "negative_transfer",
]);

export const ReplayExpectedOutcomeSchema = z
  .object({
    status: RecallStatusSchema,
    included_memory_ids: z.array(IdentifierSchema),
    excluded_reason_codes: z.array(z.string().trim().min(1)),
    must_explain: z.array(z.string().trim().min(1)),
  })
  .strict();

export const ReplayCaseBodySchema = z
  .object({
    fixture_schema_version: ContractVersionSchema,
    case_id: IdentifierSchema,
    partition: EvaluationPartitionSchema,
    risk_family: ReplayRiskFamilySchema,
    description: NonEmptyReasonSchema,
    scopes: z.array(ScopeSchema).min(1),
    as_of: UtcTimestampSchema,
    input: z.record(z.string(), z.json()),
    expected: ReplayExpectedOutcomeSchema,
    prohibited_outcomes: z.array(z.string().trim().min(1)).min(1),
  })
  .strict();

export const ReplayCaseDescriptorSchema = z
  .object({
    case_id: IdentifierSchema,
    partition: EvaluationPartitionSchema,
    risk_family: ReplayRiskFamilySchema,
    requirement_anchors: z.array(z.string().regex(/^(R\d+|AE\d+)$/)).min(1),
    body_file: z
      .string()
      .regex(/^(calibration|holdout|transfer)\/[A-Za-z0-9._-]+\.json$/),
    content_hash: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.body_file.startsWith(`${value.partition}/`)) {
      context.addIssue({
        code: "custom",
        path: ["body_file"],
        message: "fixture path must remain inside its declared partition",
      });
    }
  });

export const ReplayManifestSchema = z
  .object({
    corpus_version: ContractVersionSchema,
    fixture_schema_version: ContractVersionSchema,
    frozen_at: UtcTimestampSchema,
    hash_algorithm: z.literal("sha256-canonical-json-v1"),
    cases: z.array(ReplayCaseDescriptorSchema).min(10),
  })
  .strict()
  .superRefine((value, context) => {
    const caseIds = value.cases.map((entry) => entry.case_id);
    if (new Set(caseIds).size !== caseIds.length) {
      context.addIssue({
        code: "custom",
        path: ["cases"],
        message: "case identifiers must be unique",
      });
    }

    const coveredFamilies = new Set(
      value.cases.map((entry) => entry.risk_family),
    );
    for (const riskFamily of ReplayRiskFamilySchema.options) {
      if (!coveredFamilies.has(riskFamily)) {
        context.addIssue({
          code: "custom",
          path: ["cases"],
          message: `missing replay risk family ${riskFamily}`,
        });
      }
    }

    const coveredPartitions = new Set(
      value.cases.map((entry) => entry.partition),
    );
    for (const partition of EvaluationPartitionSchema.options) {
      if (!coveredPartitions.has(partition)) {
        context.addIssue({
          code: "custom",
          path: ["cases"],
          message: `missing replay partition ${partition}`,
        });
      }
    }
  });

export const G3ArmSchema = z.enum([
  "accepted_m2",
  "m3_no_projection",
  "m3_layered",
]);

export const G3PollutionCategorySchema = z.enum([
  "unrelated_scenario",
  "stale_projection",
  "cross_scope",
  "policy_denied",
  "invalid_lineage",
  "conflict_hidden",
  "unsupported_inference",
]);

export const G3RubricSchema = z
  .object({
    required_task_units: z.array(NonEmptyReasonSchema).min(1),
    required_evidence_units: z.array(IdentifierSchema).min(1),
    prohibited_pollution: z.array(G3PollutionCategorySchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [field, entries] of Object.entries(value)) {
      if (new Set(entries).size !== entries.length) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: "G3 rubric entries must be unique",
        });
      }
    }
  });

export const G3ProjectionTransformInputSchema = z
  .object({
    seed_id: IdentifierSchema,
    projection_type: ProjectionTypeSchema,
    source_memory_ids: z.array(IdentifierSchema).min(1),
    evidence_ids: z.array(IdentifierSchema).min(1),
    task_units: z.array(NonEmptyReasonSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [field, entries] of [
      ["source_memory_ids", value.source_memory_ids],
      ["evidence_ids", value.evidence_ids],
      ["task_units", value.task_units],
    ] as const) {
      if (new Set(entries).size !== entries.length) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: "G3 transform input entries must be unique",
        });
      }
    }
  });

export const G3OverlayCaseSchema = z
  .object({
    overlay_schema_version: ContractVersionSchema,
    case_id: IdentifierSchema,
    base_case_hash: CanonicalHashSchema,
    partition: EvaluationPartitionSchema,
    projection_seeds: z.array(ProjectionRevisionSchema),
    transform_inputs: z.array(G3ProjectionTransformInputSchema).default([]),
    rubric: G3RubricSchema,
    lane_policy: LanePolicySchema,
    lane_overrides: LaneRequestOverridesSchema,
    token_budgets: z.array(z.number().int().positive().max(32_000)).min(1),
    failure_lane: RecallLaneSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const projectionRevisionIds = value.projection_seeds.map(
      (projection) => projection.projection_revision_id,
    );
    if (
      new Set(projectionRevisionIds).size !== projectionRevisionIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["projection_seeds"],
        message: "G3 projection seeds must be unique",
      });
    }
    if (new Set(value.token_budgets).size !== value.token_budgets.length) {
      context.addIssue({
        code: "custom",
        path: ["token_budgets"],
        message: "G3 token budgets must be unique",
      });
    }
  });

export const G3OverlayDescriptorSchema = z
  .object({
    case_id: IdentifierSchema,
    partition: EvaluationPartitionSchema,
    base_case_hash: CanonicalHashSchema,
    overlay_file: z
      .string()
      .regex(
        /^overlays\/(calibration|holdout|transfer)\/[A-Za-z0-9._-]+\.json$/,
      ),
    content_hash: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.overlay_file.startsWith(`overlays/${value.partition}/`)) {
      context.addIssue({
        code: "custom",
        path: ["overlay_file"],
        message: "G3 overlay path must remain inside its declared partition",
      });
    }
  });

export const G3OverlayManifestSchema = z
  .object({
    overlay_version: ContractVersionSchema,
    base_corpus_version: ContractVersionSchema,
    base_manifest_hash: CanonicalHashSchema,
    frozen_at: UtcTimestampSchema,
    arms: z.array(G3ArmSchema),
    cases: z.array(G3OverlayDescriptorSchema).min(3),
  })
  .strict()
  .superRefine((value, context) => {
    const expectedArms = [...G3ArmSchema.options].sort();
    const arms = [...new Set(value.arms)].sort();
    if (
      value.arms.length !== expectedArms.length ||
      arms.length !== expectedArms.length ||
      arms.some((arm, index) => arm !== expectedArms[index])
    ) {
      context.addIssue({
        code: "custom",
        path: ["arms"],
        message: "G3 manifest must declare the exact three evaluation arms",
      });
    }

    const caseIds = value.cases.map((entry) => entry.case_id);
    if (new Set(caseIds).size !== caseIds.length) {
      context.addIssue({
        code: "custom",
        path: ["cases"],
        message: "G3 overlay case identifiers must be unique",
      });
    }

    const partitions = new Set(
      value.cases.map((entry) => entry.partition),
    );
    for (const partition of EvaluationPartitionSchema.options) {
      if (!partitions.has(partition)) {
        context.addIssue({
          code: "custom",
          path: ["cases"],
          message: `missing G3 overlay partition ${partition}`,
        });
      }
    }
  });

export const G3ProtocolIdentitySchema = z
  .object({
    protocol_version: z.literal("1.0.0"),
    arm: G3ArmSchema,
    case_id: IdentifierSchema,
    partition: EvaluationPartitionSchema,
    base_case_hash: CanonicalHashSchema,
    overlay_hash: CanonicalHashSchema,
    request_hash: CanonicalHashSchema,
    token_budget: z.number().int().positive().max(32_000),
    ablation_lane: RecallLaneSchema.nullable(),
    implementation_commit: z.string().regex(/^[a-f0-9]{40}$/),
    dependency_lock_hash: CanonicalHashSchema,
  })
  .strict();

export const G3CaseMetricsSchema = z
  .object({
    status: RecallStatusSchema,
    task_units_required: z.number().int().nonnegative(),
    task_units_included: z.number().int().nonnegative(),
    evidence_units_required: z.number().int().nonnegative(),
    evidence_units_included: z.number().int().nonnegative(),
    pollution_categories: z.array(G3PollutionCategorySchema),
    governance_violations: z.array(z.string().trim().min(1)),
    budget_overflow: z.boolean(),
    abstention_correct: z.boolean(),
    conflict_explanations: z.number().int().nonnegative(),
    rebuild_equal: z.boolean(),
    degraded_lanes: z.array(RecallLaneSchema),
    included_source_memory_ids: z.array(IdentifierSchema),
    excluded_reason_codes: z.array(z.string().trim().min(1)),
  })
  .strict();

export const G3CaseResultSchema = z
  .object({
    identity: G3ProtocolIdentitySchema,
    metrics: G3CaseMetricsSchema,
    context_frozen_hash: CanonicalHashSchema.nullable(),
    receipt_hash: CanonicalHashSchema,
    result_hash: CanonicalHashSchema,
  })
  .strict();

export const G4AArmSchema = z.enum([
  "accepted_g3r",
  "m4a_graph_disabled_reference",
  "m4a_graph_enabled",
]);

export const G4ACaseFamilySchema = z.enum([
  "typed_explanatory_path",
  "temporal_conflict",
  "scenario_migration",
  "shortest_valid_proof",
  "cycle_fanout_pressure",
  "mid_path_correction",
]);

export const G4AQueryIntentSchema = z
  .object({
    mode: GraphQueryModeSchema,
    start_revision_ids: z.array(IdentifierSchema).min(1).max(100),
    relation_pattern: z.array(RelationTypeSchema).min(1).max(4),
    max_depth: z.number().int().min(1).max(4),
    max_fanout: z.number().int().min(1).max(100),
    max_paths: z.number().int().min(1).max(1_000),
    max_results: z.number().int().min(1).max(1_000),
    max_relation_allowlist: z.number().int().min(1).max(100_000),
    parent_deadline_ms: z.number().int().min(1).max(60_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.start_revision_ids).size !== value.start_revision_ids.length) {
      context.addIssue({
        code: "custom",
        path: ["start_revision_ids"],
        message: "G4A query starts must be unique",
      });
    }
    if (value.relation_pattern.length > value.max_depth) {
      context.addIssue({
        code: "custom",
        path: ["relation_pattern"],
        message: "G4A relation pattern cannot exceed maximum depth",
      });
    }
    if (value.max_results > value.max_paths) {
      context.addIssue({
        code: "custom",
        path: ["max_results"],
        message: "G4A result limit cannot exceed path limit",
      });
    }
  });

export const G4AExpectedOutcomeSchema = z
  .object({
    status: z.enum(["complete", "degraded"]),
    revision_ids: z.array(IdentifierSchema),
    ordered_paths: z.array(GraphPathEvidenceSchema),
    evidence_ids: z.array(IdentifierSchema),
    complete: z.boolean(),
    abstain: z.boolean(),
    reason_codes: z.array(z.string().trim().min(1).max(200)),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [field, entries] of [
      ["revision_ids", value.revision_ids],
      ["evidence_ids", value.evidence_ids],
    ] as const) {
      if (new Set(entries).size !== entries.length) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `G4A ${field} must be unique`,
        });
      }
    }
    if (value.complete !== (value.status === "complete")) {
      context.addIssue({
        code: "custom",
        path: ["complete"],
        message: "G4A expected status and completeness must agree",
      });
    }
    if (!value.complete && value.reason_codes.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["reason_codes"],
        message: "incomplete G4A expectation requires a stable reason code",
      });
    }
  });

export const G4ACaseBodySchema = z
  .object({
    schema_version: ContractVersionSchema,
    case_id: IdentifierSchema,
    partition: EvaluationPartitionSchema,
    family: G4ACaseFamilySchema,
    description: NonEmptyReasonSchema,
    principal_id: IdentifierSchema,
    scope: ScopeSchema,
    as_of: UtcTimestampSchema,
    input_revision_ids: z.array(IdentifierSchema).min(2).max(1_000),
    input_relation_revision_ids: z
      .array(IdentifierSchema)
      .min(1)
      .max(100_000),
    prohibited_revision_ids: z.array(IdentifierSchema),
    query: G4AQueryIntentSchema,
    expected: G4AExpectedOutcomeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    for (const [field, entries] of [
      ["input_revision_ids", value.input_revision_ids],
      ["input_relation_revision_ids", value.input_relation_revision_ids],
      ["prohibited_revision_ids", value.prohibited_revision_ids],
    ] as const) {
      if (new Set(entries).size !== entries.length) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `G4A ${field} must be unique`,
        });
      }
    }
    const inputRevisionIds = new Set(value.input_revision_ids);
    const inputRelationRevisionIds = new Set(
      value.input_relation_revision_ids,
    );
    if (
      value.query.start_revision_ids.some(
        (revisionId) => !inputRevisionIds.has(revisionId),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["query", "start_revision_ids"],
        message: "G4A starts must resolve in the case input",
      });
    }
    if (
      value.expected.revision_ids.some(
        (revisionId) => !inputRevisionIds.has(revisionId),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["expected", "revision_ids"],
        message: "G4A expected revisions must resolve in the case input",
      });
    }
    if (
      value.prohibited_revision_ids.some((revisionId) =>
        value.expected.revision_ids.includes(revisionId)
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["expected", "revision_ids"],
        message: "G4A prohibited revisions cannot be expected",
      });
    }
    const expectedPathRevisionIds = new Set(
      value.expected.ordered_paths.flatMap(
        (path) => path.node_revision_ids,
      ),
    );
    if (
      value.expected.ordered_paths.some((path) =>
        path.node_revision_ids.some(
          (revisionId) => !inputRevisionIds.has(revisionId),
        ) ||
        path.relation_revision_ids.some(
          (relationRevisionId) =>
            !inputRelationRevisionIds.has(relationRevisionId),
        ) ||
        path.relation_types.some(
          (relationType, index) =>
            relationType !== value.query.relation_pattern[index],
        )
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["expected", "ordered_paths"],
        message:
          "G4A expected paths must resolve in the frozen input and match the query relation pattern",
      });
    }
    const expectedRevisionIds = new Set(value.expected.revision_ids);
    if (
      expectedRevisionIds.size !== expectedPathRevisionIds.size ||
      [...expectedRevisionIds].some(
        (revisionId) => !expectedPathRevisionIds.has(revisionId),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["expected", "revision_ids"],
        message:
          "G4A expected revision set must exactly match ordered proof path revisions",
      });
    }
    const emptyExpected =
      value.expected.revision_ids.length === 0 &&
      value.expected.ordered_paths.length === 0 &&
      value.expected.evidence_ids.length === 0;
    if (value.expected.abstain !== emptyExpected) {
      context.addIssue({
        code: "custom",
        path: ["expected", "abstain"],
        message:
          "G4A abstention requires empty revisions, paths, and evidence, and only abstention may be empty",
      });
    }
  });

export const G4ACaseDescriptorSchema = z
  .object({
    case_id: IdentifierSchema,
    partition: EvaluationPartitionSchema,
    family: G4ACaseFamilySchema,
    requirement_anchors: z
      .array(z.enum(["R8", "R12", "R14", "R19", "R20"]))
      .min(1),
    body_file: z
      .string()
      .regex(
        /^cases\/(calibration|holdout|transfer)\/[A-Za-z0-9._-]+\.json$/,
      ),
    content_hash: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.body_file.startsWith(`cases/${value.partition}/`)) {
      context.addIssue({
        code: "custom",
        path: ["body_file"],
        message: "G4A body path must remain inside its declared partition",
      });
    }
    if (new Set(value.requirement_anchors).size !== value.requirement_anchors.length) {
      context.addIssue({
        code: "custom",
        path: ["requirement_anchors"],
        message: "G4A requirement anchors must be unique",
      });
    }
  });

export const G4AThresholdsSchema = z
  .object({
    strict_case_gains: z.number().int().positive().max(6),
    minimum_holdout_gains: z.number().int().nonnegative().max(2),
    minimum_transfer_gains: z.number().int().nonnegative().max(2),
    critical_regression_tolerance: z.literal(0),
    host_graph_deadline_ms: z.number().int().positive(),
    fallback_p95_ms: z.number().int().positive(),
    governed_recall_p50_ms: z.number().int().positive(),
    governed_recall_p95_ms: z.number().int().positive(),
    replacement_ready_ms: z.number().int().positive(),
    expected_rebuild_ms: z.number().int().positive(),
    graph_database_wal_bytes: z.number().int().positive(),
    install_delta_bytes: z.number().int().positive(),
    idle_rss_delta_bytes: z.number().int().positive(),
    peak_rss_delta_bytes: z.number().int().positive(),
    warmup_samples: z.number().int().nonnegative(),
    measured_samples: z.number().int().positive(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.governed_recall_p50_ms > value.governed_recall_p95_ms) {
      context.addIssue({
        code: "custom",
        path: ["governed_recall_p50_ms"],
        message: "G4A p50 threshold cannot exceed p95",
      });
    }
    if (value.host_graph_deadline_ms > value.fallback_p95_ms) {
      context.addIssue({
        code: "custom",
        path: ["host_graph_deadline_ms"],
        message: "G4A host deadline must fit inside fallback p95",
      });
    }
  });

export const G4AOverlayManifestSchema = z
  .object({
    schema_version: ContractVersionSchema,
    frozen_at: UtcTimestampSchema,
    baseline_commit: z.string().regex(/^[a-f0-9]{40}$/),
    candidate: z
      .object({
        package_name: z.literal("@ladybugdb/core"),
        package_version: z
          .string()
          .regex(/^(0|[1-9]\d*)\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/),
        platform: z.string().trim().min(1).max(80),
        architecture: z.string().trim().min(1).max(80),
      })
      .strict(),
    arms: z.array(G4AArmSchema),
    thresholds: G4AThresholdsSchema,
    expected_profile: z
      .object({
        active_l1_memories: z.number().int().positive(),
        l2_l3_projections: z.number().int().positive(),
        relations: z.number().int().positive(),
      })
      .strict(),
    strict_gain_rule: NonEmptyReasonSchema,
    cases: z.array(G4ACaseDescriptorSchema).length(6),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.arms.length !== G4AArmSchema.options.length ||
      value.arms.some(
        (arm, index) => arm !== G4AArmSchema.options[index],
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["arms"],
        message: "G4A manifest must declare the exact ordered three arms",
      });
    }
    const caseIds = value.cases.map((entry) => entry.case_id);
    if (new Set(caseIds).size !== caseIds.length) {
      context.addIssue({
        code: "custom",
        path: ["cases"],
        message: "G4A case identities must be unique",
      });
    }
    const families = value.cases.map((entry) => entry.family);
    if (
      new Set(families).size !== G4ACaseFamilySchema.options.length ||
      G4ACaseFamilySchema.options.some(
        (family) => !families.includes(family),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["cases"],
        message: "G4A manifest must contain every structural family once",
      });
    }
    for (const partition of EvaluationPartitionSchema.options) {
      if (
        value.cases.filter((entry) => entry.partition === partition).length !==
        2
      ) {
        context.addIssue({
          code: "custom",
          path: ["cases"],
          message: `G4A manifest requires exactly two ${partition} cases`,
        });
      }
    }
  });

export const G4AEvaluationPhaseSchema = z.enum([
  "calibration_tuning",
  "gate_evaluation",
]);

export function assertG4APartitionAccess(
  phaseInput: unknown,
  partitionInput: unknown,
): void {
  const phase = G4AEvaluationPhaseSchema.parse(phaseInput);
  const partition = EvaluationPartitionSchema.parse(partitionInput);
  if (phase === "calibration_tuning" && partition !== "calibration") {
    throw new Error(
      `G4A partition ${partition} is unavailable during calibration tuning`,
    );
  }
}

export const G4AProtocolIdentitySchema = z
  .object({
    protocol_version: z.literal("1.0.0"),
    arm: G4AArmSchema,
    case_id: IdentifierSchema,
    partition: EvaluationPartitionSchema,
    candidate_commit: z.string().regex(/^[a-f0-9]{40}$/),
    dependency_lock_hash: CanonicalHashSchema,
    native_binary_hash: CanonicalHashSchema.nullable(),
    manifest_hash: CanonicalHashSchema,
    case_hash: CanonicalHashSchema,
    query_hash: CanonicalHashSchema,
    policy_hash: CanonicalHashSchema,
    frontier_hash: CanonicalHashSchema,
    thresholds_hash: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.arm === "m4a_graph_enabled") !==
      (value.native_binary_hash !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["native_binary_hash"],
        message: "only the enabled graph arm binds a native binary",
      });
    }
  });

export const G4ACaseResultSchema = z
  .object({
    identity: G4AProtocolIdentitySchema,
    status: z.enum(["passed", "failed", "degraded", "invalid"]),
    actual: G4AExpectedOutcomeSchema,
    strict_gain: z.boolean(),
    governance_violations: z.array(z.string().trim().min(1).max(200)),
    result_hash: CanonicalHashSchema,
  })
  .strict();

export type G3Arm = z.infer<typeof G3ArmSchema>;
export type G3OverlayCase = z.infer<typeof G3OverlayCaseSchema>;
export type G3OverlayDescriptor = z.infer<
  typeof G3OverlayDescriptorSchema
>;
export type G3OverlayManifest = z.infer<typeof G3OverlayManifestSchema>;
export type G3PollutionCategory = z.infer<
  typeof G3PollutionCategorySchema
>;
export type G3Rubric = z.infer<typeof G3RubricSchema>;
export type G3ProjectionTransformInput = z.infer<
  typeof G3ProjectionTransformInputSchema
>;
export type G3ProtocolIdentity = z.infer<
  typeof G3ProtocolIdentitySchema
>;
export type G3CaseMetrics = z.infer<typeof G3CaseMetricsSchema>;
export type G3CaseResult = z.infer<typeof G3CaseResultSchema>;
export type G4AArm = z.infer<typeof G4AArmSchema>;
export type G4ACaseBody = z.infer<typeof G4ACaseBodySchema>;
export type G4ACaseDescriptor = z.infer<typeof G4ACaseDescriptorSchema>;
export type G4ACaseFamily = z.infer<typeof G4ACaseFamilySchema>;
export type G4ACaseResult = z.infer<typeof G4ACaseResultSchema>;
export type G4AOverlayManifest = z.infer<
  typeof G4AOverlayManifestSchema
>;
export type G4AProtocolIdentity = z.infer<
  typeof G4AProtocolIdentitySchema
>;
export type G4AThresholds = z.infer<typeof G4AThresholdsSchema>;
export type ReplayCaseBody = z.infer<typeof ReplayCaseBodySchema>;
export type ReplayCaseDescriptor = z.infer<typeof ReplayCaseDescriptorSchema>;
export type ReplayManifest = z.infer<typeof ReplayManifestSchema>;
export type ReplayRiskFamily = z.infer<typeof ReplayRiskFamilySchema>;
