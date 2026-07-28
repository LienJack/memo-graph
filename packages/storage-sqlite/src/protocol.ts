import { z } from "zod";

import {
  AuthoritySchema,
  EpisodeSchema,
  EvidenceRecordSchema,
  IdentifierSchema,
  ContextSliceSchema,
  MemoryCandidateSchema,
  MemoryProposeInputSchema,
  MutationReceiptSchema,
  RecallRequestSchema,
  ReceiptSchema,
  RetrievalReceiptSchema,
  ScopeSchema,
  UtcTimestampSchema,
} from "@memo-graph/contracts";

import { STORAGE_ERROR_CODES } from "./errors.js";

export const BlobWriteSchema = z
  .object({
    content_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    media_type: z.string().trim().min(1).max(160),
    bytes: z.instanceof(Uint8Array),
  })
  .strict();

export const CommitEpisodeCommandSchema = z
  .object({
    idempotencyKey: z.string().trim().min(8).max(200),
    episode: EpisodeSchema,
    evidence: z.array(EvidenceRecordSchema).min(1),
    blobs: z.array(BlobWriteSchema),
  })
  .strict();

export const SearchEvidenceQuerySchema = z
  .object({
    query: z.string().trim().min(1).max(500),
    principal_id: IdentifierSchema,
    scope: ScopeSchema,
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();

export const MigrationEvidenceSchema = z
  .object({
    version: z.string().regex(/^\d{4}$/),
    name: z.string().min(1),
    hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    applied_at: z.string(),
  })
  .strict();

export const GovernanceCountsSchema = z
  .object({
    memory_candidates: z.number().int().nonnegative(),
    memory_objects: z.number().int().nonnegative(),
    memory_revisions: z.number().int().nonnegative(),
    admission_decisions: z.number().int().nonnegative(),
    conflict_groups: z.number().int().nonnegative(),
    status_events: z.number().int().nonnegative(),
    pin_events: z.number().int().nonnegative(),
    usage_rules: z.number().int().nonnegative(),
  })
  .strict();

export const PurgeCountsSchema = z
  .object({
    memory_tombstones: z.number().int().nonnegative(),
    purge_jobs: z.number().int().nonnegative(),
    purge_store_outcomes: z.number().int().nonnegative(),
    purge_receipts: z.number().int().nonnegative(),
    approval_consumptions: z.number().int().nonnegative(),
  })
  .strict();

export const StorageCountsSchema = z
  .object({
    evidence_events: z.number().int().nonnegative(),
    episodes: z.number().int().nonnegative(),
    mutation_receipts: z.number().int().nonnegative(),
    idempotency_keys: z.number().int().nonnegative(),
    outbox_pending: z.number().int().nonnegative(),
    fts_rows: z.number().int().nonnegative(),
    backup_manifests: z.number().int().nonnegative(),
    recall_requests: z.number().int().nonnegative(),
    retrieval_receipts: z.number().int().nonnegative(),
    context_slices: z.number().int().nonnegative(),
    receipt_access_scopes: z.number().int().nonnegative(),
    ...GovernanceCountsSchema.shape,
    ...PurgeCountsSchema.shape,
  })
  .strict();

export const StorageHealthSchema = z
  .object({
    schema_version: z.string().regex(/^\d{4}$/),
    ledger_epoch: z.number().int().nonnegative(),
    tombstone_epoch: z.number().int().nonnegative(),
    latest_receipt_hash: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .nullable(),
    sqlite_version: z.string().min(1),
    journal_mode: z.literal("wal"),
    foreign_keys: z.literal(true),
    secure_delete: z.literal(true),
    projection_state: z.enum([
      "ready",
      "pending",
      "rebuilding",
      "unavailable",
    ]),
    filesystem_type: z.number().int(),
    migrations: z.array(MigrationEvidenceSchema),
    counts: StorageCountsSchema,
  })
  .strict();

export const GovernanceStorageStatusSchema = z
  .object({
    tombstone_epoch: z.number().int().nonnegative(),
    governance: GovernanceCountsSchema,
    purge: PurgeCountsSchema,
  })
  .strict();

export const ContentReferenceCountsInputSchema = z
  .object({
    content_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();

export const ContentReferenceCountsSchema = z
  .object({
    content_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    evidence_events: z.number().int().nonnegative(),
    memory_candidates: z.number().int().nonnegative(),
    memory_revisions: z.number().int().nonnegative(),
    live_revision_links: z.number().int().nonnegative(),
    artifacts: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .strict();

export const AdmissionEvaluationSchema = z
  .object({
    decision: z.enum(["activate", "candidate_only", "quarantine"]),
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const AdmitMemoryCommandSchema = z
  .object({
    request: MemoryProposeInputSchema,
    evaluation: AdmissionEvaluationSchema,
  })
  .strict();

export const MemoryRevisionCommandSchema = z
  .object({
    idempotency_key: z.string().trim().min(8).max(200),
    principal_id: IdentifierSchema,
    actor_authority: AuthoritySchema,
    scope: ScopeSchema,
    requested_at: UtcTimestampSchema,
    memory_id: IdentifierSchema,
    expected_revision_id: IdentifierSchema,
    candidate: MemoryCandidateSchema,
    evaluation: AdmissionEvaluationSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.scope.kind !== value.candidate.scope.kind ||
      value.scope.id !== value.candidate.scope.id
    ) {
      context.addIssue({
        code: "custom",
        path: ["candidate", "scope"],
        message: "revision candidate scope must match the command scope",
      });
    }
  });

export const GovernanceMutationResultSchema = z
  .object({
    receipt: MutationReceiptSchema,
    replayed: z.boolean(),
    outcome: z.enum(["CREATED", "REUSED", "CONFLICT", "REVISED"]),
    candidate_id: IdentifierSchema,
    memory_id: IdentifierSchema,
    current_revision_id: IdentifierSchema,
    conflict_group_id: IdentifierSchema.nullable(),
    lifecycle: z.enum(["active", "candidate", "quarantined"]),
    decision: z
      .enum(["activate", "candidate_only", "quarantine"])
      .nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.outcome === "CONFLICT") !==
      (value.conflict_group_id !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["conflict_group_id"],
        message: "only a conflict outcome names a conflict group",
      });
    }
    if (
      (value.outcome === "CONFLICT") !== (value.decision === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["decision"],
        message: "conflicts do not advance an admission decision",
      });
    }
  });

export const GovernanceReplayInputSchema = z
  .object({
    idempotency_key: z.string().trim().min(8).max(200),
    request_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();

export const GovernanceReplayResultSchema =
  GovernanceMutationResultSchema.nullable();

export const DrainFtsResultSchema = z
  .object({
    processed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
    projection_state: z.enum(["ready", "pending", "unavailable"]),
  })
  .strict();

export const SearchEvidenceItemSchema = z
  .object({
    evidence_id: z.string().min(1),
    scope_kind: z.string().min(1),
    scope_id: z.string().min(1),
    source: z.string().min(1),
    occurred_at: z.string().min(1),
    text: z.string(),
    rank: z.number().finite(),
  })
  .strict();

const SearchBaseSchema = {
  items: z.array(SearchEvidenceItemSchema),
};

export const SearchEvidenceResultSchema = z.discriminatedUnion("status", [
  z.object({ ...SearchBaseSchema, status: z.literal("OK") }).strict(),
  z
    .object({
      ...SearchBaseSchema,
      status: z.literal("NO_MATCH"),
    })
    .strict(),
  z
    .object({
      ...SearchBaseSchema,
      status: z.literal("DEGRADED"),
      reason_code: z.enum([
        "FTS_PENDING",
        "FTS_REBUILDING",
        "FTS_UNAVAILABLE",
      ]),
    })
    .strict(),
]);

export const RebuildFtsResultSchema = z
  .object({
    indexed: z.number().int().nonnegative(),
    ledger_epoch: z.number().int().nonnegative(),
  })
  .strict();

export const CheckpointResultSchema = z
  .object({
    busy: z.number().int().nonnegative(),
    log: z.number().int().nonnegative(),
    checkpointed: z.number().int().nonnegative(),
  })
  .strict();

export const BackupResultSchema = z
  .object({
    backup_id: z.string().min(1),
    directory: z.string().min(1),
    path: z.string().min(1),
    ledger_epoch: z.number().int().nonnegative(),
    tombstone_epoch: z.number().int().nonnegative(),
    latest_receipt_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
    blob_hashes: z.array(z.string().regex(/^sha256:[a-f0-9]{64}$/)),
    integrity_check: z.literal("ok"),
    size_bytes: z.number().int().nonnegative(),
  })
  .strict();

export const VerifyArtifactsResultSchema = z
  .object({
    verified: z.number().int().nonnegative(),
  })
  .strict();

export const EvidenceLookupInputSchema = z
  .object({
    evidence_id: z.string().min(1).max(160),
    principal_id: IdentifierSchema,
    scope: ScopeSchema,
  })
  .strict();

export const EvidenceLookupResultSchema = EvidenceRecordSchema.nullable();

export const EvidenceExplanationSchema = z
  .object({
    evidence: EvidenceRecordSchema,
    episodes: z.array(EpisodeSchema),
  })
  .strict();

export const EvidenceExplanationResultSchema =
  EvidenceExplanationSchema.nullable();

export const ReceiptLookupInputSchema = z
  .object({
    receipt_id: z.string().min(1).max(160),
    principal_id: IdentifierSchema,
    scopes: z.array(ScopeSchema).min(1),
  })
  .strict();

export const ReceiptLookupResultSchema = ReceiptSchema.nullable();

export const RecordRecallCommandSchema = z
  .object({
    principal_id: IdentifierSchema,
    request: RecallRequestSchema,
    receipt: RetrievalReceiptSchema,
    context_slice: ContextSliceSchema.optional(),
  })
  .strict();

export const RecordRecallResultSchema = z
  .object({
    receipt: RetrievalReceiptSchema,
    context_slice: ContextSliceSchema.nullable(),
    replayed: z.boolean(),
  })
  .strict();

export const BlockWorkerResultSchema = z
  .object({
    blocked_ms: z.number().int().min(1).max(2_000),
  })
  .strict();

export const WorkerOperationSchema = z.enum([
  "health",
  "governance_status",
  "count_content_references",
  "admit_memory",
  "apply_memory_revision",
  "governance_replay",
  "commit_episode",
  "drain_fts",
  "search_evidence",
  "rebuild_fts",
  "checkpoint",
  "backup",
  "verify_artifacts",
  "get_evidence",
  "explain_evidence",
  "get_receipt",
  "record_recall",
  "test_block",
  "test_hold_write_lock",
  "close",
]);

export const WorkerRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    operation: WorkerOperationSchema,
    payload: z.unknown(),
  })
  .strict();

export const SerializedErrorSchema = z
  .object({
    code: z.enum(STORAGE_ERROR_CODES),
    message: z.string(),
    retryable: z.boolean(),
  })
  .strict();

export const WorkerResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      requestId: z.string().uuid(),
      ok: z.literal(true),
      result: z.unknown(),
    })
    .strict(),
  z
    .object({
      requestId: z.string().uuid(),
      ok: z.literal(false),
      error: SerializedErrorSchema,
    })
    .strict(),
]);

export type BackupResult = z.infer<typeof BackupResultSchema>;
export type AdmitMemoryCommand = z.input<typeof AdmitMemoryCommandSchema>;
export type ParsedAdmitMemoryCommand = z.output<
  typeof AdmitMemoryCommandSchema
>;
export type AdmissionEvaluation = z.infer<
  typeof AdmissionEvaluationSchema
>;
export type BlockWorkerResult = z.infer<typeof BlockWorkerResultSchema>;
export type CheckpointResult = z.infer<typeof CheckpointResultSchema>;
export type ContentReferenceCounts = z.infer<
  typeof ContentReferenceCountsSchema
>;
export type CommitEpisodeCommand = z.input<typeof CommitEpisodeCommandSchema>;
export type ParsedCommitEpisodeCommand = z.output<
  typeof CommitEpisodeCommandSchema
>;
export type DrainFtsResult = z.infer<typeof DrainFtsResultSchema>;
export type GovernanceCounts = z.infer<typeof GovernanceCountsSchema>;
export type GovernanceMutationResult = z.infer<
  typeof GovernanceMutationResultSchema
>;
export type GovernanceReplayInput = z.input<
  typeof GovernanceReplayInputSchema
>;
export type GovernanceStorageStatus = z.infer<
  typeof GovernanceStorageStatusSchema
>;
export type MigrationEvidence = z.infer<typeof MigrationEvidenceSchema>;
export type MemoryRevisionCommand = z.input<
  typeof MemoryRevisionCommandSchema
>;
export type ParsedMemoryRevisionCommand = z.output<
  typeof MemoryRevisionCommandSchema
>;
export type EvidenceExplanation = z.infer<typeof EvidenceExplanationSchema>;
export type EvidenceLookupInput = z.input<typeof EvidenceLookupInputSchema>;
export type ParsedEvidenceLookupInput = z.output<
  typeof EvidenceLookupInputSchema
>;
export type ReceiptLookupInput = z.input<typeof ReceiptLookupInputSchema>;
export type ParsedReceiptLookupInput = z.output<
  typeof ReceiptLookupInputSchema
>;
export type RecordRecallCommand = z.input<typeof RecordRecallCommandSchema>;
export type ParsedRecordRecallCommand = z.output<
  typeof RecordRecallCommandSchema
>;
export type RecordRecallResult = z.infer<typeof RecordRecallResultSchema>;
export type RebuildFtsResult = z.infer<typeof RebuildFtsResultSchema>;
export type PurgeCounts = z.infer<typeof PurgeCountsSchema>;
export type SearchEvidenceQuery = z.input<typeof SearchEvidenceQuerySchema>;
export type ParsedSearchEvidenceQuery = z.output<
  typeof SearchEvidenceQuerySchema
>;
export type SearchEvidenceResult = z.infer<typeof SearchEvidenceResultSchema>;
export type StorageHealth = z.infer<typeof StorageHealthSchema>;
export type VerifyArtifactsResult = z.infer<typeof VerifyArtifactsResultSchema>;
export type WorkerOperation = z.infer<typeof WorkerOperationSchema>;
export type WorkerResponse = z.infer<typeof WorkerResponseSchema>;
export type DurableEpisodeReceipt = z.infer<typeof MutationReceiptSchema>;
