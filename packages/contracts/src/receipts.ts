import { z } from "zod";

import { canonicalSha256Omitting } from "./canonical-json.js";
import {
  CanonicalHashSchema,
  ContractVersionSchema,
  IdentifierSchema,
  NonEmptyReasonSchema,
  UtcTimestampSchema,
} from "./common.js";
import { GraphPathEvidenceSchema } from "./graph.js";
import {
  ContextFrontierSchema,
  ContextScoreComponentsSchema,
  EffectiveLaneConfigurationSchema,
  LaneTelemetrySchema,
  ProjectionLineageRefSchema,
  RecallLaneSchema,
} from "./projections.js";
import { VectorSelectionEvidenceSchema } from "./vector.js";

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
    score_components: ContextScoreComponentsSchema.optional(),
    token_estimate: z.number().int().nonnegative().optional(),
    projection: ProjectionLineageRefSchema.optional(),
    graph_path: GraphPathEvidenceSchema.optional(),
    vector: VectorSelectionEvidenceSchema.optional(),
    conflict_group_id: IdentifierSchema.nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.lane === "semantic_vector") !==
      (value.vector !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["vector"],
        message:
          "semantic_vector receipt items require vector selection evidence and other lanes cannot carry it",
      });
    }
    if (
      value.projection !== undefined &&
      (!RecallLaneSchema.safeParse(value.lane).success ||
        value.score_components === undefined ||
        value.token_estimate === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["projection"],
        message:
          "projection receipt items require a governed lane, score components, and token estimate",
      });
    }
    if (
      (value.lane === "relation_graph") !==
      (value.graph_path !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["graph_path"],
        message:
          "relation_graph receipt items require graph path evidence and other lanes cannot carry it",
      });
    }
    if (
      value.lane === "relation_graph" &&
      (value.projection === undefined ||
        value.score_components === undefined ||
        value.token_estimate === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["projection"],
        message:
          "relation_graph receipt items require canonical projection lineage, score, and token evidence",
      });
    }
  });

export const RetrievalReceiptSchema = z
  .object({
    ...ReceiptBaseShape,
    kind: z.literal("retrieval"),
    context_slice_id: IdentifierSchema.nullable(),
    compiler_version: ContractVersionSchema,
    policy_version: ContractVersionSchema,
    frontier: ContextFrontierSchema.optional(),
    effective_lane_configuration:
      EffectiveLaneConfigurationSchema.optional(),
    lane_telemetry: z.array(LaneTelemetrySchema).optional(),
    items: z.array(RetrievalReceiptItemSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.items.some((item) => item.projection !== undefined) &&
      (value.frontier === undefined ||
        value.effective_lane_configuration === undefined ||
        value.lane_telemetry === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["frontier"],
        message:
          "layered retrieval receipts require frontier, lane configuration, and telemetry",
      });
    }

    if (value.lane_telemetry !== undefined) {
      const lanes = value.lane_telemetry.map((item) => item.lane);
      if (new Set(lanes).size !== lanes.length) {
        context.addIssue({
          code: "custom",
          path: ["lane_telemetry"],
          message: "retrieval telemetry must contain one row per lane",
        });
      }
    }
  });

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

export const PurgeStoreSchema = z.enum([
  "memory_revisions",
  "candidates",
  "conflicts",
  "fts",
  "context",
  "exports",
  "blobs",
  "backups",
  "projections",
]);

export const PurgeStoreOutcomeSchema = z
  .object({
    store: PurgeStoreSchema,
    status: z.enum(["verified", "residual", "failed"]),
    residual_hashes: z.array(CanonicalHashSchema),
    error_code: z.string().trim().min(1).nullable(),
    checked_at: UtcTimestampSchema,
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
    stores_checked: z.array(PurgeStoreSchema).min(1),
    store_outcomes: z.array(PurgeStoreOutcomeSchema).min(1),
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
    const outcomeStores = value.store_outcomes.map((item) => item.store);
    if (new Set(outcomeStores).size !== outcomeStores.length) {
      context.addIssue({
        code: "custom",
        path: ["store_outcomes"],
        message: "purge store outcomes must be unique",
      });
    }
    const checked = [...new Set(value.stores_checked)].sort();
    const outcomes = [...new Set(outcomeStores)].sort();
    if (
      checked.length !== outcomes.length ||
      checked.some((store, index) => store !== outcomes[index])
    ) {
      context.addIssue({
        code: "custom",
        path: ["stores_checked"],
        message: "checked stores must exactly match recorded outcomes",
      });
    }
    for (const [index, outcome] of value.store_outcomes.entries()) {
      if (
        (outcome.status === "verified" &&
          (outcome.residual_hashes.length > 0 ||
            outcome.error_code !== null)) ||
        (outcome.status === "residual" &&
          (outcome.residual_hashes.length === 0 ||
            outcome.error_code !== null)) ||
        (outcome.status === "failed" && outcome.error_code === null)
      ) {
        context.addIssue({
          code: "custom",
          path: ["store_outcomes", index],
          message: "purge outcome status and evidence must agree",
        });
      }
    }
    const residuals = [
      ...new Set(
        value.store_outcomes.flatMap((outcome) => outcome.residual_hashes),
      ),
    ].sort();
    const declaredResiduals = [...new Set(value.residual_hashes)].sort();
    if (
      residuals.length !== declaredResiduals.length ||
      residuals.some(
        (hash, index) => hash !== declaredResiduals[index],
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["residual_hashes"],
        message: "purge residual summary must match store outcomes",
      });
    }
    if (
      value.completed &&
      (value.state !== "purged" ||
        value.store_outcomes.some(
          (outcome) => outcome.status !== "verified",
        ))
    ) {
      context.addIssue({
        code: "custom",
        path: ["completed"],
        message: "completed purge requires verified outcomes and purged state",
      });
    }
    if (!value.completed && value.state === "purged") {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "an incomplete purge cannot use the purged state",
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
export type PurgeStore = z.infer<typeof PurgeStoreSchema>;
export type PurgeStoreOutcome = z.infer<typeof PurgeStoreOutcomeSchema>;
export type Receipt = z.infer<typeof ReceiptSchema>;
export type ReleaseReceipt = z.infer<typeof ReleaseReceiptSchema>;
export type RetrievalReceipt = z.infer<typeof RetrievalReceiptSchema>;
export type RollbackReceipt = z.infer<typeof RollbackReceiptSchema>;
