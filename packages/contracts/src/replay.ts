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

export type ReplayCaseBody = z.infer<typeof ReplayCaseBodySchema>;
export type ReplayCaseDescriptor = z.infer<typeof ReplayCaseDescriptorSchema>;
export type ReplayManifest = z.infer<typeof ReplayManifestSchema>;
export type ReplayRiskFamily = z.infer<typeof ReplayRiskFamilySchema>;
