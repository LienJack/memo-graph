import { z } from "zod";

import {
  CanonicalHashSchema,
  ContractVersionSchema,
  IdentifierSchema,
  UtcTimestampSchema,
} from "./common.js";

export const ContentFreeOperatorScalarSchema = z.union([
  z.string().trim().min(1).max(512),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const ContentFreeOperatorResultSchema = z
  .record(
    z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    ContentFreeOperatorScalarSchema,
  )
  .superRefine((value, context) => {
    const forbiddenKey =
      /(?:raw_?path|data_?root|content|plaintext|ciphertext|secret|query|token|key_?material)/iu;
    for (const [key, scalar] of Object.entries(value)) {
      if (
        forbiddenKey.test(key) ||
        (typeof scalar === "string" &&
          (scalar.startsWith("/") || scalar.includes("\0")))
      ) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "operator action result must be content-free",
        });
      }
    }
  });

export const BackupInspectionResultSchema = z
  .object({
    schema_version: ContractVersionSchema,
    status: z.literal("bundle_verified"),
    freshness: z.literal("external_head_not_checked"),
    backup_id: IdentifierSchema,
    manifest_hash: CanonicalHashSchema,
    database_logical_hash: CanonicalHashSchema,
    artifact_count: z.number().int().nonnegative(),
    required_key_count: z.number().int().nonnegative(),
    frontier_digest: CanonicalHashSchema,
  })
  .strict();

export const RestoreDryRunResultSchema = z
  .object({
    schema_version: ContractVersionSchema,
    status: z.literal("operator_action_required"),
    publication: z.literal("confirmation_required"),
    backup_id: IdentifierSchema,
    manifest_hash: CanonicalHashSchema,
    intent_digest: CanonicalHashSchema,
  })
  .strict();

export const KeyRotationDryRunResultSchema = z
  .object({
    operation: z.literal("key.rotate"),
    status: z.literal("disabled"),
    reason_code: z.literal("ENCRYPTION_REQUIRED"),
  })
  .strict();

export const ProjectionRebuildDryRunResultSchema = z
  .object({
    schema_version: ContractVersionSchema,
    operation: z.literal("projection.rebuild"),
    status: z.literal("operator_action_required"),
    source: z.literal("canonical_sqlite"),
    repair_kind: z.enum(["fts", "layered_projection", "sqlite_relations"]),
    publication: z.literal("confirmation_required"),
    parameters_digest: CanonicalHashSchema,
  })
  .strict();

export const LearningRollbackVerificationResultSchema = z
  .object({
    schema_version: ContractVersionSchema,
    operation: z.literal("learning.rollback"),
    status: z.literal("operator_action_required"),
    publication: z.literal("confirmation_required"),
    release_ref: IdentifierSchema,
    parameters_digest: CanonicalHashSchema,
  })
  .strict();

export const G6HardRuleSchema = z.enum([
  "integrity",
  "privacy",
  "deletion",
  "encryption",
  "restore",
  "rollback",
  "supply_chain",
  "binding",
]);

export const G6VerificationReportSchema = z
  .object({
    schema_version: ContractVersionSchema,
    gate: z.literal("G6"),
    state: z.enum(["pass", "fail", "blocked"]),
    eligible: z.boolean(),
    first_non_pass: G6HardRuleSchema.nullable(),
    decision_recorded: z.boolean(),
    current_control_verified: z.boolean(),
    evidence_bundle_hash: CanonicalHashSchema,
    runtime_identity_hash: CanonicalHashSchema,
    tested_implementation_digest: CanonicalHashSchema,
    hard_rules: z.record(
      G6HardRuleSchema,
      z.union([z.boolean(), z.literal("blocked")]),
    ),
    report_states: z.record(
      z.string().min(1),
      z.enum(["pass", "fail", "blocked"]),
    ),
    exact_environment: z.record(z.string().min(1), z.unknown()),
    topology: z.string().min(1),
    source_bindings: z.array(z.unknown()).min(1),
    verified_at: UtcTimestampSchema.optional(),
  })
  .strict();

export const G6CandidateVerificationResultSchema = z
  .object({
    schema_version: ContractVersionSchema,
    operation: z.literal("g6.verify"),
    status: z.enum(["verified", "blocked"]),
    evidence_ref: z.string().trim().min(1),
    evidence_bundle_hash: CanonicalHashSchema,
    runtime_identity_hash: CanonicalHashSchema,
    tested_implementation_digest: CanonicalHashSchema,
    eligible: z.boolean(),
    first_non_pass: G6HardRuleSchema.nullable(),
    decision_recorded: z.boolean(),
    current_control_verified: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.eligible &&
        (value.status !== "verified" || value.first_non_pass !== null)) ||
      (!value.eligible &&
        (value.status !== "blocked" || value.first_non_pass === null)) ||
      value.current_control_verified !== value.decision_recorded
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "G6 candidate verification result is inconsistent",
      });
    }
  });

export type BackupInspectionResult = z.infer<
  typeof BackupInspectionResultSchema
>;
export type ContentFreeOperatorResult = z.infer<
  typeof ContentFreeOperatorResultSchema
>;
export type G6CandidateVerificationResult = z.infer<
  typeof G6CandidateVerificationResultSchema
>;
export type G6VerificationReport = z.infer<
  typeof G6VerificationReportSchema
>;
export type KeyRotationDryRunResult = z.infer<
  typeof KeyRotationDryRunResultSchema
>;
export type LearningRollbackVerificationResult = z.infer<
  typeof LearningRollbackVerificationResultSchema
>;
export type ProjectionRebuildDryRunResult = z.infer<
  typeof ProjectionRebuildDryRunResultSchema
>;
export type RestoreDryRunResult = z.infer<
  typeof RestoreDryRunResultSchema
>;
