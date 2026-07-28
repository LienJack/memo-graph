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
  LanePolicySchema,
  LaneRequestOverridesSchema,
  ProjectionRevisionSchema,
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

export const G3OverlayCaseSchema = z
  .object({
    overlay_schema_version: ContractVersionSchema,
    case_id: IdentifierSchema,
    base_case_hash: CanonicalHashSchema,
    partition: EvaluationPartitionSchema,
    projection_seeds: z.array(ProjectionRevisionSchema),
    rubric: G3RubricSchema,
    lane_policy: LanePolicySchema,
    lane_overrides: LaneRequestOverridesSchema,
    token_budgets: z.array(z.number().int().positive().max(32_000)).min(1),
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
export type ReplayCaseBody = z.infer<typeof ReplayCaseBodySchema>;
export type ReplayCaseDescriptor = z.infer<typeof ReplayCaseDescriptorSchema>;
export type ReplayManifest = z.infer<typeof ReplayManifestSchema>;
export type ReplayRiskFamily = z.infer<typeof ReplayRiskFamilySchema>;
