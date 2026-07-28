import { z } from "zod";

import { canonicalSha256Omitting } from "./canonical-json.js";
import {
  CanonicalHashSchema,
  ContractVersionSchema,
  IdentifierSchema,
  NonEmptyReasonSchema,
  UtcTimestampSchema,
} from "./common.js";

export const ReceiptStateSchema = z.enum([
  "durable",
  "projection_pending",
  "projected",
  "partial",
  "failed",
  "rolled_back",
  "purged",
]);

const ReceiptBaseShape = {
  schema_version: ContractVersionSchema,
  receipt_id: IdentifierSchema,
  created_at: UtcTimestampSchema,
  state: ReceiptStateSchema,
  request_hash: CanonicalHashSchema,
  receipt_hash: CanonicalHashSchema,
};

export const RetrievalReceiptItemSchema = z
  .object({
    memory_id: IdentifierSchema,
    revision_id: IdentifierSchema,
    decision: z.enum(["included", "excluded"]),
    reason_codes: z.array(z.string().trim().min(1)).min(1),
    lane: z.string().trim().min(1).max(120),
    score: z.number().finite().nullable(),
  })
  .strict();

export const RetrievalReceiptSchema = z
  .object({
    ...ReceiptBaseShape,
    kind: z.literal("retrieval"),
    context_slice_id: IdentifierSchema.nullable(),
    compiler_version: ContractVersionSchema,
    policy_version: ContractVersionSchema,
    items: z.array(RetrievalReceiptItemSchema),
  })
  .strict();

export const MutationReceiptSchema = z
  .object({
    ...ReceiptBaseShape,
    kind: z.literal("mutation"),
    idempotency_key: z.string().trim().min(8).max(200),
    affected_memory_ids: z.array(IdentifierSchema),
    affected_revision_ids: z.array(IdentifierSchema),
    resulting_epoch: z.number().int().nonnegative(),
    projection_jobs: z.array(IdentifierSchema),
    warnings: z.array(z.string().trim().min(1)),
  })
  .strict();

export const EvalReceiptSchema = z
  .object({
    ...ReceiptBaseShape,
    kind: z.literal("evaluation"),
    candidate_id: IdentifierSchema,
    evaluation_version: ContractVersionSchema,
    fixture_manifest_hash: CanonicalHashSchema,
    baseline_release_id: IdentifierSchema.nullable(),
    passed: z.boolean(),
    failed_case_ids: z.array(IdentifierSchema),
    quarantined_case_ids: z.array(IdentifierSchema),
  })
  .strict();

export const ReleaseReceiptSchema = z
  .object({
    ...ReceiptBaseShape,
    kind: z.literal("release"),
    release_id: IdentifierSchema,
    candidate_id: IdentifierSchema,
    previous_release_id: IdentifierSchema.nullable(),
    evaluation_receipt_id: IdentifierSchema,
    canary_receipt_id: IdentifierSchema,
    authorized_by: IdentifierSchema,
    retrieval_configuration_hash: CanonicalHashSchema,
  })
  .strict();

export const RollbackReceiptSchema = z
  .object({
    ...ReceiptBaseShape,
    kind: z.literal("rollback"),
    release_id: IdentifierSchema,
    restored_release_id: IdentifierSchema.nullable(),
    restored_configuration_hash: CanonicalHashSchema,
    reason: NonEmptyReasonSchema,
  })
  .strict();

export const PurgeReceiptSchema = z
  .object({
    ...ReceiptBaseShape,
    kind: z.literal("purge"),
    purge_job_id: IdentifierSchema,
    target_memory_ids: z.array(IdentifierSchema).min(1),
    tombstone_epoch: z.number().int().nonnegative(),
    stores_checked: z.array(z.string().trim().min(1)).min(1),
    residual_hashes: z.array(CanonicalHashSchema),
    completed: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.completed && value.residual_hashes.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["residual_hashes"],
        message: "a completed purge cannot report residual content hashes",
      });
    }
  });

export const ReceiptSchema = z.discriminatedUnion("kind", [
  RetrievalReceiptSchema,
  MutationReceiptSchema,
  EvalReceiptSchema,
  ReleaseReceiptSchema,
  RollbackReceiptSchema,
  PurgeReceiptSchema,
]);

export function sealReceipt<T extends Record<string, unknown>>(
  receipt: T,
): T & { receipt_hash: `sha256:${string}` } {
  return {
    ...receipt,
    receipt_hash: canonicalSha256Omitting(receipt, ["receipt_hash"]),
  };
}

export function receiptHashIsValid(receipt: z.infer<typeof ReceiptSchema>): boolean {
  return (
    receipt.receipt_hash ===
    canonicalSha256Omitting(receipt, ["receipt_hash"])
  );
}

export type EvalReceipt = z.infer<typeof EvalReceiptSchema>;
export type MutationReceipt = z.infer<typeof MutationReceiptSchema>;
export type PurgeReceipt = z.infer<typeof PurgeReceiptSchema>;
export type Receipt = z.infer<typeof ReceiptSchema>;
export type ReleaseReceipt = z.infer<typeof ReleaseReceiptSchema>;
export type RetrievalReceipt = z.infer<typeof RetrievalReceiptSchema>;
export type RollbackReceipt = z.infer<typeof RollbackReceiptSchema>;
