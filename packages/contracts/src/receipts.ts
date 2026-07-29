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
import { CandidateStateSchema } from "./learning.js";
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
    active_learning_release_id: IdentifierSchema.optional(),
    active_learning_release_hash: CanonicalHashSchema.optional(),
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
    if (
      (value.active_learning_release_id === undefined) !==
      (value.active_learning_release_hash === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["active_learning_release_id"],
        message:
          "retrieval learning release identity and hash must appear together",
      });
    }
    if (
      value.active_learning_release_id !==
        value.effective_lane_configuration?.active_learning_release_id ||
      value.active_learning_release_hash !==
        value.effective_lane_configuration?.active_learning_release_hash
    ) {
      context.addIssue({
        code: "custom",
        path: ["effective_lane_configuration"],
        message:
          "retrieval receipt and effective lane configuration must bind the same active learning release",
      });
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

export const LearningStopReceiptSchema = z
  .object({
    ...ReceiptBaseShape,
    kind: z.literal("learning_stop"),
    principal_id: IdentifierSchema,
    trace_id: IdentifierSchema.nullable(),
    candidate_id: IdentifierSchema.nullable(),
    control_epoch: z.number().int().nonnegative(),
    reason_code: z.string().trim().min(1).max(200),
  })
  .strict();

export const CandidateTransitionReceiptSchema = z
  .object({
    ...ReceiptBaseShape,
    kind: z.literal("learning_transition"),
    candidate_id: IdentifierSchema,
    transition_id: IdentifierSchema,
    sequence: z.number().int().positive(),
    from_state: CandidateStateSchema,
    to_state: CandidateStateSchema,
    authority_id: IdentifierSchema.nullable(),
    evidence_receipt_ids: z.array(IdentifierSchema).min(1),
    control_epoch: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.evidence_receipt_ids).size !==
      value.evidence_receipt_ids.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["evidence_receipt_ids"],
        message: "transition evidence receipts must be unique",
      });
    }
  });

export const EvalReceiptSchema = z
  .object({
    ...ReceiptBaseShape,
    kind: z.literal("evaluation"),
    candidate_id: IdentifierSchema,
    run_id: IdentifierSchema,
    evaluation_version: ContractVersionSchema,
    fixture_manifest_hash: CanonicalHashSchema,
    thresholds_hash: CanonicalHashSchema,
    common_identity_hash: CanonicalHashSchema,
    baseline_release_id: IdentifierSchema.nullable(),
    result_set_hashes: z.array(CanonicalHashSchema).min(1),
    passed: z.boolean(),
    invalidated: z.boolean(),
    failed_case_ids: z.array(IdentifierSchema),
    quarantined_case_ids: z.array(IdentifierSchema),
    contamination_event_ids: z.array(IdentifierSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.passed && value.invalidated) {
      context.addIssue({
        code: "custom",
        path: ["passed"],
        message: "an invalidated evaluation cannot pass",
      });
    }
  });

export const CanaryReceiptSchema = z
  .object({
    ...ReceiptBaseShape,
    kind: z.literal("learning_canary"),
    candidate_id: IdentifierSchema,
    authorization_id: IdentifierSchema,
    authorization_hash: CanonicalHashSchema,
    evaluation_receipt_id: IdentifierSchema,
    canary_manifest_hash: CanonicalHashSchema,
    exposures: z.number().int().min(0).max(3),
    passed: z.boolean(),
    failure_codes: z.array(z.string().trim().min(1).max(200)),
    control_epoch: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.passed && value.exposures !== 3) {
      context.addIssue({
        code: "custom",
        path: ["exposures"],
        message: "a passing canary requires exactly three exposures",
      });
    }
    if (value.passed && value.failure_codes.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["failure_codes"],
        message: "a passing canary cannot report failure codes",
      });
    }
  });

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
    release_slot_hash: CanonicalHashSchema,
    candidate_id: IdentifierSchema,
    previous_release_id: IdentifierSchema.nullable(),
    evaluation_receipt_id: IdentifierSchema,
    canary_receipt_id: IdentifierSchema,
    approval_id: IdentifierSchema,
    approval_hash: CanonicalHashSchema,
    resulting_pointer_revision: z.number().int().positive(),
    control_epoch: z.number().int().nonnegative(),
    retrieval_configuration_hash: CanonicalHashSchema,
  })
  .strict();

export const MonitorReceiptSchema = z
  .object({
    ...ReceiptBaseShape,
    kind: z.literal("learning_monitor"),
    release_id: IdentifierSchema,
    pointer_revision: z.number().int().positive(),
    canary_receipt_id: IdentifierSchema,
    monitor_contract_hash: CanonicalHashSchema,
    replayed_case_ids: z.array(IdentifierSchema).length(3),
    passed: z.boolean(),
    failure_codes: z.array(z.string().trim().min(1).max(200)),
    rollback_required: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.replayed_case_ids).size !==
      value.replayed_case_ids.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["replayed_case_ids"],
        message: "monitor replay cases must be unique",
      });
    }
    if (value.passed === value.rollback_required) {
      context.addIssue({
        code: "custom",
        path: ["rollback_required"],
        message:
          "a failed monitor requires rollback and a passing monitor does not",
      });
    }
  });

export const LearningControlReceiptSchema = z
  .object({
    ...ReceiptBaseShape,
    kind: z.literal("learning_control"),
    principal_id: IdentifierSchema,
    action: z.enum(["pause", "resume"]),
    previous_epoch: z.number().int().nonnegative(),
    resulting_epoch: z.number().int().positive(),
    previous_frontier_hash: CanonicalHashSchema,
    frontier_hash: CanonicalHashSchema,
    runtime_identity_hash: CanonicalHashSchema,
    configuration_hash: CanonicalHashSchema,
    corpus_hash: CanonicalHashSchema,
    reason_code: z.string().trim().min(1).max(200),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.resulting_epoch !== value.previous_epoch + 1) {
      context.addIssue({
        code: "custom",
        path: ["resulting_epoch"],
        message: "learning control must advance exactly one epoch",
      });
    }
  });

export const RollbackReceiptSchema = z
  .object({
    ...ReceiptBaseShape,
    kind: z.literal("rollback"),
    release_id: IdentifierSchema,
    rolled_back_release_id: IdentifierSchema,
    restored_release_id: IdentifierSchema.nullable(),
    approval_id: IdentifierSchema,
    approval_hash: CanonicalHashSchema,
    monitor_receipt_id: IdentifierSchema.nullable(),
    resulting_pointer_revision: z.number().int().positive(),
    control_epoch: z.number().int().nonnegative(),
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
  LearningStopReceiptSchema,
  CandidateTransitionReceiptSchema,
  EvalReceiptSchema,
  CanaryReceiptSchema,
  ReleaseReceiptSchema,
  MonitorReceiptSchema,
  LearningControlReceiptSchema,
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
export type CanaryReceipt = z.infer<typeof CanaryReceiptSchema>;
export type CandidateTransitionReceipt = z.infer<
  typeof CandidateTransitionReceiptSchema
>;
export type LearningControlReceipt = z.infer<
  typeof LearningControlReceiptSchema
>;
export type LearningStopReceipt = z.infer<typeof LearningStopReceiptSchema>;
export type MonitorReceipt = z.infer<typeof MonitorReceiptSchema>;
export type MutationReceipt = z.infer<typeof MutationReceiptSchema>;
export type PurgeReceipt = z.infer<typeof PurgeReceiptSchema>;
export type PurgeStore = z.infer<typeof PurgeStoreSchema>;
export type PurgeStoreOutcome = z.infer<typeof PurgeStoreOutcomeSchema>;
export type Receipt = z.infer<typeof ReceiptSchema>;
export type ReleaseReceipt = z.infer<typeof ReleaseReceiptSchema>;
export type RetrievalReceipt = z.infer<typeof RetrievalReceiptSchema>;
export type RollbackReceipt = z.infer<typeof RollbackReceiptSchema>;
