import { z } from "zod";

import {
  AuthoritySchema,
  CanonicalHashSchema,
  ContractVersionSchema,
  IdentifierSchema,
  NonEmptyReasonSchema,
  ScopeSchema,
  SensitivitySchema,
  UtcTimestampSchema,
} from "./common.js";

export const LearningTraceSchema = z
  .object({
    schema_version: ContractVersionSchema,
    trace_id: IdentifierSchema,
    episode_id: IdentifierSchema,
    captured_at: UtcTimestampSchema,
    scopes: z.array(ScopeSchema).min(1),
    outcome: z.enum(["succeeded", "failed", "partial"]),
    feedback_evidence_ids: z.array(IdentifierSchema),
    error_codes: z.array(z.string().trim().min(1)),
    knowledge_gaps: z.array(z.string().trim().min(1)),
    learning_enabled: z.boolean(),
    trace_hash: CanonicalHashSchema,
  })
  .strict();

export const CandidateChangeSchema = z
  .object({
    schema_version: ContractVersionSchema,
    candidate_id: IdentifierSchema,
    candidate_type: z.enum([
      "memory",
      "procedure",
      "prompt",
      "retrieval_policy",
      "core_projection",
    ]),
    status: z.enum([
      "proposed",
      "quarantined",
      "evaluating",
      "approved",
      "rejected",
      "released",
      "rolled_back",
    ]),
    scope: ScopeSchema,
    authority: AuthoritySchema,
    sensitivity: SensitivitySchema,
    impact: z.enum(["low", "medium", "high"]),
    confidence: z.number().min(0).max(1),
    evidence_ids: z.array(IdentifierSchema).min(1),
    proposed_at: UtcTimestampSchema,
    proposed_change_hash: CanonicalHashSchema,
    requires_user_confirmation: z.boolean(),
    authorization_receipt_id: IdentifierSchema.nullable(),
    reason: NonEmptyReasonSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const confirmationRequired =
      value.impact === "high" ||
      value.confidence < 0.8 ||
      ["sensitive", "secret"].includes(value.sensitivity) ||
      value.candidate_type === "core_projection";

    if (confirmationRequired && !value.requires_user_confirmation) {
      context.addIssue({
        code: "custom",
        path: ["requires_user_confirmation"],
        message:
          "high-impact, low-confidence, sensitive, and core candidates require user confirmation",
      });
    }
    if (
      value.status === "released" &&
      value.requires_user_confirmation &&
      value.authorization_receipt_id === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["authorization_receipt_id"],
        message:
          "a receipt-bearing approval transition is required before release",
      });
    }
  });

export const EvaluationPartitionSchema = z.enum([
  "calibration",
  "holdout",
  "transfer",
]);

export const EvaluationArmSchema = z.enum([
  "transcript_baseline",
  "fts_baseline",
  "candidate",
]);

export const EvalResultSchema = z
  .object({
    schema_version: ContractVersionSchema,
    eval_result_id: IdentifierSchema,
    run_id: IdentifierSchema,
    case_id: IdentifierSchema,
    partition: EvaluationPartitionSchema,
    arm: EvaluationArmSchema,
    passed: z.boolean(),
    metrics: z.record(z.string(), z.number().finite()),
    failure_codes: z.array(z.string().trim().min(1)),
    evaluated_at: UtcTimestampSchema,
    result_hash: CanonicalHashSchema,
  })
  .strict();

export const ReleasePointerSchema = z
  .object({
    schema_version: ContractVersionSchema,
    release_id: IdentifierSchema,
    candidate_id: IdentifierSchema,
    previous_release_id: IdentifierSchema.nullable(),
    evaluation_receipt_id: IdentifierSchema,
    configuration_hash: CanonicalHashSchema,
    activated_at: UtcTimestampSchema,
    active: z.boolean(),
  })
  .strict();

export type CandidateChange = z.infer<typeof CandidateChangeSchema>;
export type EvalResult = z.infer<typeof EvalResultSchema>;
export type EvaluationArm = z.infer<typeof EvaluationArmSchema>;
export type EvaluationPartition = z.infer<typeof EvaluationPartitionSchema>;
export type LearningTrace = z.infer<typeof LearningTraceSchema>;
export type ReleasePointer = z.infer<typeof ReleasePointerSchema>;
