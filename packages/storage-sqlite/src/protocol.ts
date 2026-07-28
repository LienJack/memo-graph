import { z } from "zod";

import {
  AuthoritySchema,
  ApprovalBindingSchema,
  ApprovalGrantSchema,
  CanonicalHashSchema,
  EpisodeSchema,
  EvidenceRecordSchema,
  GovernedSearchItemSchema,
  IdentifierSchema,
  ContextSliceSchema,
  MemoryCandidateSchema,
  MemoryKindSchema,
  MemoryProposeInputSchema,
  MemoryPinInputSchema,
  MemoryDemoteInputSchema,
  MemoryDeleteInputSchema,
  MemoryUsageSetInputSchema,
  MemoryRevokeInputSchema,
  MutationReceiptSchema,
  PurgeReceiptSchema,
  ProjectionFrontierSchema,
  ProjectionRevisionSchema,
  ProjectionSourceSchema,
  ProjectionTypeSchema,
  RecallRequestSchema,
  ReceiptSchema,
  RelationTypeSchema,
  RetrievalReceiptSchema,
  ScopeSchema,
  SensitivitySchema,
  TransformRefSchema,
  UtcTimestampSchema,
  canonicalSha256,
  scopeKey,
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
    projection_objects: z.number().int().nonnegative(),
    projection_revisions: z.number().int().nonnegative(),
    projection_sources: z.number().int().nonnegative(),
    relation_objects: z.number().int().nonnegative(),
    relation_revisions: z.number().int().nonnegative(),
    projection_outbox_pending: z.number().int().nonnegative(),
    projection_rebuild_receipts: z.number().int().nonnegative(),
    ...GovernanceCountsSchema.shape,
    ...PurgeCountsSchema.shape,
  })
  .strict();

export const ProjectionStorageFrontierSchema = z
  .object({
    schema_version: z.literal("1.0.0"),
    ledger_epoch: z.number().int().nonnegative(),
    tombstone_epoch: z.number().int().nonnegative(),
    projection_epoch: z.number().int().nonnegative(),
    source_frontier_hash: CanonicalHashSchema.nullable(),
    projection_frontier_hash: CanonicalHashSchema.nullable(),
    transform_versions: z.array(TransformRefSchema),
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
        message: "projection frontier transforms must be unique",
      });
    }
  });

export const ProjectionScopeStorageFrontierSchema = z
  .object({
    schema_version: z.literal("1.0.0"),
    principal_id: IdentifierSchema,
    scope: ScopeSchema,
    status: z.enum(["ready", "pending", "rebuilding", "unavailable"]),
    ledger_epoch: z.number().int().nonnegative(),
    tombstone_epoch: z.number().int().nonnegative(),
    projection_epoch: z.number().int().nonnegative(),
    source_frontier_hash: CanonicalHashSchema.nullable(),
    projection_frontier_hash: CanonicalHashSchema.nullable(),
    transform_versions: z.array(TransformRefSchema),
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
        message: "scope projection frontier transforms must be unique",
      });
    }
    if (
      value.status === "ready" &&
      (value.source_frontier_hash === null ||
        value.projection_frontier_hash === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "a ready scope projection frontier requires both hashes",
      });
    }
  });

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
    layered_projection_state: z.enum([
      "ready",
      "pending",
      "rebuilding",
      "unavailable",
    ]),
    projection_frontier: ProjectionStorageFrontierSchema,
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

export const VerifiedApprovalCommandSchema = z
  .object({
    grant: ApprovalGrantSchema,
    registry_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    verified_at: UtcTimestampSchema,
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
    dry_run: z.boolean().default(false),
    request_hash: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
    approval_binding: ApprovalBindingSchema.optional(),
    approval: VerifiedApprovalCommandSchema.optional(),
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
    const approvalFields = [
      value.request_hash,
      value.approval_binding,
      value.approval,
    ].filter((item) => item !== undefined);
    if (approvalFields.length !== 0 && approvalFields.length !== 3) {
      context.addIssue({
        code: "custom",
        path: ["approval"],
        message:
          "authorized revisions require request hash, binding, and verified approval",
      });
    }
    if (value.dry_run && approvalFields.length !== 0) {
      context.addIssue({
        code: "custom",
        path: ["approval"],
        message: "dry-run revisions cannot carry approval authority",
      });
    }
  });

export const MemoryCorrectionBasisInputSchema = z
  .object({
    memory_id: IdentifierSchema,
    principal_id: IdentifierSchema,
    scope: ScopeSchema,
    expected_revision_id: IdentifierSchema,
  })
  .strict();

export const MemoryCorrectionBasisSchema = z
  .object({
    current_revision_id: IdentifierSchema,
    logical_key: z.string().trim().min(1).max(500),
    kind: MemoryKindSchema,
    scope: ScopeSchema,
    sensitivity: SensitivitySchema,
    inferred: z.boolean(),
    injection_risk: z.enum(["none", "suspected", "confirmed"]),
    requires_user_confirmation: z.boolean(),
    transform: TransformRefSchema,
  })
  .strict();

export const MemoryCorrectionBasisResultSchema =
  MemoryCorrectionBasisSchema.nullable();

export const GovernanceMutationResultSchema = z
  .object({
    receipt: MutationReceiptSchema,
    replayed: z.boolean(),
    outcome: z.enum([
      "CREATED",
      "REUSED",
      "CONFLICT",
      "REVISED",
      "DRY_RUN",
    ]),
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

export const MemoryControlRequestSchema = z.union([
  MemoryPinInputSchema,
  MemoryDemoteInputSchema,
  MemoryUsageSetInputSchema,
  MemoryRevokeInputSchema,
]);

export const MemoryControlCommandSchema = z
  .object({
    request: MemoryControlRequestSchema,
    approval: VerifiedApprovalCommandSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.request.envelope.dry_run !== (value.approval === null)) {
      context.addIssue({
        code: "custom",
        path: ["approval"],
        message:
          "dry runs omit approval; effect-bearing controls require verified approval",
      });
    }
  });

export const MemoryControlResultSchema = z
  .object({
    receipt: MutationReceiptSchema,
    replayed: z.boolean(),
    outcome: z.enum([
      "DRY_RUN",
      "PINNED",
      "UNPINNED",
      "DEMOTED",
      "USAGE_ALLOWED",
      "USAGE_BLOCKED",
      "REVOKED",
    ]),
    memory_id: IdentifierSchema,
    current_revision_id: IdentifierSchema,
    lifecycle: z.enum([
      "working",
      "candidate",
      "active",
      "superseded",
      "revoked",
      "quarantined",
      "purged",
    ]),
    pinned: z.boolean(),
    usage_rule_id: IdentifierSchema.nullable(),
  })
  .strict();

export const MemoryControlReplayResultSchema =
  MemoryControlResultSchema.nullable();

export const MemoryDeleteCommandSchema = z
  .object({
    request: MemoryDeleteInputSchema,
    approval: VerifiedApprovalCommandSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.request.envelope.dry_run !== (value.approval === null)) {
      context.addIssue({
        code: "custom",
        path: ["approval"],
        message:
          "delete dry runs omit approval; effect-bearing deletion requires verified approval",
      });
    }
  });

export const MemoryDeleteResultSchema = z
  .object({
    receipt: MutationReceiptSchema,
    replayed: z.boolean(),
    outcome: z.enum(["DRY_RUN", "TOMBSTONED"]),
    memory_id: IdentifierSchema,
    revision_id: IdentifierSchema,
    tombstone_epoch: z.number().int().positive().nullable(),
    purge_job_id: IdentifierSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const hasEffect =
      value.tombstone_epoch !== null && value.purge_job_id !== null;
    if (
      (value.outcome === "TOMBSTONED") !== hasEffect ||
      (value.outcome === "DRY_RUN" &&
        (value.receipt.affected_memory_ids.length > 0 ||
          value.receipt.affected_revision_ids.length > 0))
    ) {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message:
          "only a tombstone result may name a tombstone epoch and purge job",
      });
    }
  });

export const MemoryDeleteReplayResultSchema =
  MemoryDeleteResultSchema.nullable();

export const PurgeRunInputSchema = z
  .object({
    purge_job_id: IdentifierSchema,
  })
  .strict();

export const PurgeRunResultSchema = PurgeReceiptSchema;

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

export const EligibilityReasonCodeSchema = z.enum([
  "NOT_FOUND",
  "WRONG_PRINCIPAL",
  "WRONG_SCOPE",
  "SUPERSEDED",
  "CANDIDATE_ONLY",
  "QUARANTINED",
  "REVOKED",
  "TOMBSTONED",
  "NO_LIVE_EVIDENCE",
  "NO_ACTIVATION",
  "NOT_YET_VALID",
  "EXPIRED",
  "OPEN_CONFLICT",
  "USAGE_BLOCKED",
  "SENSITIVE_EXCLUDED",
  "SECRET_EXCLUDED",
  "CONTENT_NOT_INLINE",
  "CORRUPT_LINEAGE",
]);

export const MemoryEligibilityInputSchema = z
  .object({
    memory_id: IdentifierSchema,
    revision_id: IdentifierSchema,
    principal_id: IdentifierSchema,
    scope: ScopeSchema,
    as_of: UtcTimestampSchema,
    include_sensitive: z.boolean().default(false),
    context_scope: ScopeSchema.nullable().default(null),
  })
  .strict();

export const GovernedMemoryLookupInputSchema = z
  .object({
    memory_id: IdentifierSchema,
    principal_id: IdentifierSchema,
    scope: ScopeSchema,
    as_of: UtcTimestampSchema,
    include_sensitive: z.boolean().default(false),
    context_scope: ScopeSchema.nullable().default(null),
  })
  .strict();

export const MemoryEligibilityResultSchema = z.discriminatedUnion(
  "eligible",
  [
    z
      .object({
        eligible: z.literal(true),
        item: GovernedSearchItemSchema,
      })
      .strict(),
    z
      .object({
        eligible: z.literal(false),
        memory_id: IdentifierSchema,
        revision_id: IdentifierSchema,
        reason_code: EligibilityReasonCodeSchema,
      })
      .strict(),
  ],
);

export const GovernedMemoryLookupResultSchema =
  MemoryEligibilityResultSchema.nullable();

export const GovernedMemorySearchQuerySchema = z
  .object({
    query: z.string().trim().min(1).max(500),
    principal_id: IdentifierSchema,
    scope: ScopeSchema,
    as_of: UtcTimestampSchema,
    include_sensitive: z.boolean().default(false),
    context_scope: ScopeSchema.nullable().default(null),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();

export const GovernedRankedItemSchema = z
  .object({
    item: GovernedSearchItemSchema,
    rank: z.number().finite(),
    lane: z.enum(["memory_fts", "sqlite_canonical"]),
  })
  .strict();

export const GovernedMemoryExclusionSchema = z
  .object({
    memory_id: IdentifierSchema,
    revision_id: IdentifierSchema,
    reason_code: EligibilityReasonCodeSchema,
    lane: z.enum([
      "memory_fts",
      "sqlite_canonical",
      "canonical_eligibility",
    ]),
    score: z.number().finite().nullable(),
  })
  .strict();

const GovernedSearchBaseSchema = {
  items: z.array(GovernedRankedItemSchema),
  exclusions: z.array(GovernedMemoryExclusionSchema),
  degraded_lanes: z.array(z.string().trim().min(1)),
};

export const GovernedMemorySearchResultSchema = z.discriminatedUnion(
  "status",
  [
    z.object({ ...GovernedSearchBaseSchema, status: z.literal("OK") }).strict(),
    z
      .object({
        ...GovernedSearchBaseSchema,
        status: z.literal("NO_MATCH"),
      })
      .strict(),
    z
      .object({
        ...GovernedSearchBaseSchema,
        status: z.literal("POLICY_EXCLUDED"),
      })
      .strict(),
    z
      .object({
        ...GovernedSearchBaseSchema,
        status: z.literal("DEGRADED"),
      })
      .strict(),
  ],
);

export const ProjectionSourceListInputSchema = z
  .object({
    principal_id: IdentifierSchema,
    scope: ScopeSchema,
    as_of: UtcTimestampSchema,
    include_sensitive: z.boolean().default(false),
    context_scope: ScopeSchema.nullable().default(null),
    limit: z.number().int().min(1).max(100_000).default(1_000),
  })
  .strict();

export const ProjectionSourceListResultSchema = z
  .object({
    ledger_epoch: z.number().int().nonnegative(),
    tombstone_epoch: z.number().int().nonnegative(),
    items: z.array(GovernedSearchItemSchema),
  })
  .strict();

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

export const RestoreVerificationResultSchema = z
  .object({
    integrity_check: z.literal("ok"),
    foreign_key_violations: z.literal(0),
    verified_artifacts: z.number().int().nonnegative(),
    active_memories_verified: z.number().int().nonnegative(),
    active_projections_verified: z.number().int().nonnegative(),
    active_relations_verified: z.number().int().nonnegative(),
    projection_rebuild_required: z.boolean(),
    context_slices_verified: z.number().int().nonnegative(),
    receipts_verified: z.number().int().nonnegative(),
    purge_jobs_verified: z.number().int().nonnegative(),
    incomplete_purge_jobs: z.number().int().nonnegative(),
    residual_hashes: z.array(
      z.string().regex(/^sha256:[a-f0-9]{64}$/),
    ),
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

export const ApplyProjectionBatchCommandSchema = z
  .object({
    principal_id: IdentifierSchema,
    scope: ScopeSchema,
    idempotency_key: z.string().trim().min(8).max(200),
    expected_projection_epoch: z.number().int().nonnegative(),
    projections: z.array(ProjectionRevisionSchema).max(100_000),
    frontier: ProjectionFrontierSchema.optional(),
    retire_projection_revision_ids: z
      .array(IdentifierSchema)
      .max(100_000)
      .optional(),
    applied_at: UtcTimestampSchema,
    claimed_job: z
      .object({
        job_id: IdentifierSchema,
        worker_id: IdentifierSchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.projections.length === 0 && value.frontier === undefined) {
      context.addIssue({
        code: "custom",
        path: ["frontier"],
        message: "an empty projection batch must declare its frontier",
      });
    }
    if (
      value.frontier !== undefined &&
      value.frontier.projection_epoch !==
        value.expected_projection_epoch + 1
    ) {
      context.addIssue({
        code: "custom",
        path: ["frontier", "projection_epoch"],
        message: "declared batch frontier must advance exactly once",
      });
    }
    const revisionIds = value.projections.map(
      (projection) => projection.projection_revision_id,
    );
    if (new Set(revisionIds).size !== revisionIds.length) {
      context.addIssue({
        code: "custom",
        path: ["projections"],
        message: "projection batch revision ids must be unique",
      });
    }
    if (
      value.retire_projection_revision_ids !== undefined &&
      new Set(value.retire_projection_revision_ids).size !==
        value.retire_projection_revision_ids.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["retire_projection_revision_ids"],
        message: "retired projection revision ids must be unique",
      });
    }
    for (const [index, projection] of value.projections.entries()) {
      if (
        projection.principal_id !== value.principal_id ||
        scopeKey(projection.scope) !== scopeKey(value.scope)
      ) {
        context.addIssue({
          code: "custom",
          path: ["projections", index, "scope"],
          message:
            "projection batches must bind the declared principal and exact scope",
        });
      }
      if (projection.lifecycle !== "active") {
        context.addIssue({
          code: "custom",
          path: ["projections", index, "lifecycle"],
          message: "projection batches may install only active revisions",
        });
      }
      if (
        projection.frontier.projection_epoch !==
        value.expected_projection_epoch + 1
      ) {
        context.addIssue({
          code: "custom",
          path: ["projections", index, "frontier", "projection_epoch"],
          message: "projection batch must advance the frontier exactly once",
        });
      }
      const first = value.projections[0];
      if (
        first !== undefined &&
        (projection.frontier.ledger_epoch !== first.frontier.ledger_epoch ||
          projection.frontier.tombstone_epoch !==
            first.frontier.tombstone_epoch ||
          projection.frontier.source_frontier_hash !==
            first.frontier.source_frontier_hash ||
          projection.frontier.projection_frontier_hash !==
            first.frontier.projection_frontier_hash)
      ) {
        context.addIssue({
          code: "custom",
          path: ["projections", index, "frontier"],
          message: "one projection batch must bind one exact frontier",
        });
      }
      if (
        value.frontier !== undefined &&
        canonicalSha256(value.frontier) !==
          canonicalSha256(projection.frontier)
      ) {
        context.addIssue({
          code: "custom",
          path: ["projections", index, "frontier"],
          message: "projection rows must match the declared batch frontier",
        });
      }
    }
  });

export const ProjectionBatchResultSchema = z
  .object({
    replayed: z.boolean(),
    projection_epoch: z.number().int().positive(),
    projection_revision_ids: z.array(IdentifierSchema),
    relation_revision_ids: z.array(IdentifierSchema),
    frontier: ProjectionStorageFrontierSchema,
  })
  .strict();

export const ProjectionQuerySchema = z
  .object({
    principal_id: IdentifierSchema,
    scope: ScopeSchema,
    projection_types: z.array(ProjectionTypeSchema).min(1).optional(),
    include_inactive: z.boolean().default(false),
    as_of: UtcTimestampSchema,
    limit: z.number().int().min(1).max(100_000).default(100),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.projection_types !== undefined &&
      new Set(value.projection_types).size !== value.projection_types.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["projection_types"],
        message: "projection query types must be unique",
      });
    }
  });

export const ProjectionQueryResultSchema = z
  .object({
    frontier: ProjectionStorageFrontierSchema,
    items: z.array(ProjectionRevisionSchema),
  })
  .strict();

export const ProjectionPageCursorSchema = z
  .object({
    schema_version: z.literal("1.0.0"),
    projection_type: ProjectionTypeSchema,
    projection_id: IdentifierSchema,
    query_hash: CanonicalHashSchema,
    scope_frontier_hash: CanonicalHashSchema,
  })
  .strict();

export const ProjectionPageQuerySchema = z
  .object({
    principal_id: IdentifierSchema,
    scope: ScopeSchema,
    projection_types: z.array(ProjectionTypeSchema).min(1).optional(),
    projection_revision_ids: z
      .array(IdentifierSchema)
      .min(1)
      .max(100_000)
      .optional(),
    include_inactive: z.boolean().default(false),
    as_of: UtcTimestampSchema,
    limit: z.number().int().min(1).max(100_000).default(100),
    cursor: ProjectionPageCursorSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.projection_types !== undefined &&
      new Set(value.projection_types).size !== value.projection_types.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["projection_types"],
        message: "projection page types must be unique",
      });
    }
    if (
      value.projection_revision_ids !== undefined &&
      new Set(value.projection_revision_ids).size !==
        value.projection_revision_ids.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["projection_revision_ids"],
        message: "projection page revision ids must be unique",
      });
    }
  });

export const ProjectionPageResultSchema = z
  .object({
    scope_frontier: ProjectionScopeStorageFrontierSchema,
    items: z.array(ProjectionRevisionSchema),
    examined_count: z.number().int().nonnegative(),
    total_count: z.number().int().nonnegative(),
    next_cursor: ProjectionPageCursorSchema.nullable(),
    exhausted: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.scope_frontier.status !== "ready") {
      context.addIssue({
        code: "custom",
        path: ["scope_frontier", "status"],
        message: "projection pages require a ready exact-scope frontier",
      });
    }
    if (
      value.examined_count !== value.items.length ||
      value.examined_count > value.total_count
    ) {
      context.addIssue({
        code: "custom",
        path: ["examined_count"],
        message: "projection page counts must match returned rows",
      });
    }
    if (value.exhausted !== (value.next_cursor === null)) {
      context.addIssue({
        code: "custom",
        path: ["exhausted"],
        message: "projection page exhaustion and next cursor must agree",
      });
    }
    if (
      value.next_cursor !== null &&
      value.next_cursor.scope_frontier_hash !==
        canonicalSha256(value.scope_frontier)
    ) {
      context.addIssue({
        code: "custom",
        path: ["next_cursor", "scope_frontier_hash"],
        message: "projection cursor must bind the exact scope frontier",
      });
    }
  });

export const ProjectionSourceEligibilityReasonSchema = z.enum([
  "SOURCE_MISSING",
  "SOURCE_SUPERSEDED",
  "SOURCE_INACTIVE",
  "SOURCE_USAGE_BLOCKED",
  "SOURCE_REVOKED",
  "SOURCE_TOMBSTONED",
  "SOURCE_PURGED",
  "SOURCE_INVALIDATED",
  "SOURCE_NOT_YET_VALID",
  "SOURCE_EXPIRED",
  "SOURCE_SCOPE_MISMATCH",
  "SOURCE_PRINCIPAL_MISMATCH",
  "SOURCE_SENSITIVE_EXCLUDED",
  "SOURCE_SECRET_EXCLUDED",
  "SOURCE_CONFLICT",
  "SOURCE_NO_LIVE_EVIDENCE",
  "SOURCE_NO_ACTIVATION",
]);

export const ProjectionSourceBatchQuerySchema = z
  .object({
    principal_id: IdentifierSchema,
    scope: ScopeSchema,
    as_of: UtcTimestampSchema,
    include_sensitive: z.boolean().default(false),
    context_scope: ScopeSchema.nullable().default(null),
    revision_ids: z.array(IdentifierSchema).min(1).max(100_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.revision_ids).size !== value.revision_ids.length) {
      context.addIssue({
        code: "custom",
        path: ["revision_ids"],
        message: "exact projection source revision ids must be unique",
      });
    }
  });

const EligibleProjectionSourceBatchItemSchema = z
  .object({
    revision_id: IdentifierSchema,
    status: z.literal("eligible"),
    source: ProjectionSourceSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.revision_id !== value.source.revision_id) {
      context.addIssue({
        code: "custom",
        path: ["source", "revision_id"],
        message: "eligible exact source identity must match the requested id",
      });
    }
  });

const IneligibleProjectionSourceBatchItemSchema = z
  .object({
    revision_id: IdentifierSchema,
    status: z.literal("ineligible"),
    reason_code: ProjectionSourceEligibilityReasonSchema,
  })
  .strict();

export const ProjectionSourceBatchItemSchema = z.discriminatedUnion(
  "status",
  [
    EligibleProjectionSourceBatchItemSchema,
    IneligibleProjectionSourceBatchItemSchema,
  ],
);

export const ProjectionSourceBatchResultSchema = z
  .object({
    ledger_epoch: z.number().int().nonnegative(),
    tombstone_epoch: z.number().int().nonnegative(),
    requested_revision_ids: z.array(IdentifierSchema).min(1).max(100_000),
    requested_count: z.number().int().positive(),
    complete: z.literal(true),
    results: z.array(ProjectionSourceBatchItemSchema).min(1).max(100_000),
  })
  .strict()
  .superRefine((value, context) => {
    const resultIds = value.results.map((result) => result.revision_id);
    if (
      value.requested_count !== value.requested_revision_ids.length ||
      value.results.length !== value.requested_revision_ids.length ||
      resultIds.some(
        (revisionId, index) =>
          revisionId !== value.requested_revision_ids[index],
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["results"],
        message:
          "exact projection source batch must return one ordered result per request id",
      });
    }
    if (
      new Set(value.requested_revision_ids).size !==
        value.requested_revision_ids.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["requested_revision_ids"],
        message: "exact projection source result ids must be unique",
      });
    }
  });

export const RelationTraversalInputSchema = z
  .object({
    principal_id: IdentifierSchema,
    scope: ScopeSchema,
    start_revision_ids: z.array(IdentifierSchema).min(1).max(100),
    direction: z.enum(["outbound", "inbound", "both"]),
    relation_types: z.array(RelationTypeSchema).min(1).optional(),
    max_depth: z.number().int().min(0).max(4),
    max_fanout: z.number().int().min(1).max(100),
    as_of: UtcTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.start_revision_ids).size !==
      value.start_revision_ids.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["start_revision_ids"],
        message: "relation traversal starts must be unique",
      });
    }
    if (
      value.relation_types !== undefined &&
      new Set(value.relation_types).size !== value.relation_types.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["relation_types"],
        message: "relation traversal types must be unique",
      });
    }
  });

export const RelationTraversalHitSchema = z
  .object({
    depth: z.number().int().positive().max(4),
    from_revision_id: IdentifierSchema,
    to_revision_id: IdentifierSchema,
    relation_id: IdentifierSchema,
    relation_revision_id: IdentifierSchema,
    relation_type: RelationTypeSchema,
    direction: z.enum(["outbound", "inbound"]),
  })
  .strict();

export const RelationTraversalResultSchema = z
  .object({
    hits: z.array(RelationTraversalHitSchema),
    truncated: z.boolean(),
  })
  .strict();

export const ProjectionOutboxJobSchema = z
  .object({
    job_id: IdentifierSchema,
    kind: z.enum(["refresh", "invalidate", "rebuild"]),
    aggregate_id: IdentifierSchema,
    principal_id: IdentifierSchema,
    scope: ScopeSchema,
    source_revision_ids: z.array(IdentifierSchema),
    status: z.enum(["pending", "processing", "processed", "failed"]),
    attempts: z.number().int().nonnegative(),
    available_at: UtcTimestampSchema,
    claimed_by: IdentifierSchema.nullable(),
    lease_expires_at: UtcTimestampSchema.nullable(),
    created_at: UtcTimestampSchema,
    processed_at: UtcTimestampSchema.nullable(),
    last_error_code: z.string().trim().min(1).nullable(),
  })
  .strict();

export const EnqueueProjectionJobCommandSchema = z
  .object({
    job_id: IdentifierSchema,
    kind: z.enum(["refresh", "invalidate", "rebuild"]),
    aggregate_id: IdentifierSchema,
    principal_id: IdentifierSchema,
    scope: ScopeSchema,
    source_revision_ids: z.array(IdentifierSchema),
    available_at: UtcTimestampSchema,
    created_at: UtcTimestampSchema,
  })
  .strict();

export const ClaimProjectionJobsInputSchema = z
  .object({
    worker_id: IdentifierSchema,
    claimed_at: UtcTimestampSchema,
    lease_expires_at: UtcTimestampSchema,
    limit: z.number().int().min(1).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      Date.parse(value.lease_expires_at) <= Date.parse(value.claimed_at)
    ) {
      context.addIssue({
        code: "custom",
        path: ["lease_expires_at"],
        message: "projection job lease must expire after claim time",
      });
    }
  });

export const ClaimProjectionJobsResultSchema = z
  .object({
    jobs: z.array(ProjectionOutboxJobSchema),
  })
  .strict();

export const FailProjectionJobCommandSchema = z
  .object({
    job_id: IdentifierSchema,
    worker_id: IdentifierSchema,
    error_code: z.string().trim().min(1).max(200),
    retry_at: UtcTimestampSchema,
    failed_at: UtcTimestampSchema,
  })
  .strict();

export const CompleteProjectionJobCommandSchema = z
  .object({
    job_id: IdentifierSchema,
    worker_id: IdentifierSchema,
    completed_at: UtcTimestampSchema,
  })
  .strict();

export const ProjectionJobMutationResultSchema = z
  .object({
    job: ProjectionOutboxJobSchema,
    replayed: z.boolean(),
  })
  .strict();

export const InvalidateProjectionDescendantsCommandSchema = z
  .object({
    source_revision_ids: z.array(IdentifierSchema).min(1).max(1_000),
    reason: z.string().trim().min(1).max(2_000),
    invalidated_at: UtcTimestampSchema,
  })
  .strict();

export const InvalidateProjectionDescendantsResultSchema = z
  .object({
    projection_ids: z.array(IdentifierSchema),
    projection_revision_ids: z.array(IdentifierSchema),
  })
  .strict();

export const ProjectionRebuildReceiptSchema = z
  .object({
    rebuild_receipt_id: IdentifierSchema,
    mode: z.enum(["incremental", "full"]),
    projection_epoch: z.number().int().nonnegative(),
    structural_digest: CanonicalHashSchema,
    projection_count: z.number().int().nonnegative(),
    relation_count: z.number().int().nonnegative(),
    completed_at: UtcTimestampSchema,
  })
  .strict();

export const RecordProjectionRebuildResultSchema = z
  .object({
    receipt: ProjectionRebuildReceiptSchema,
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
  "get_memory_correction_basis",
  "governance_replay",
  "memory_control_replay",
  "apply_memory_control",
  "memory_delete_replay",
  "delete_memory",
  "run_purge",
  "check_memory_eligibility",
  "get_governed_memory",
  "search_governed_memory",
  "commit_episode",
  "drain_fts",
  "search_evidence",
  "rebuild_fts",
  "checkpoint",
  "backup",
  "verify_artifacts",
  "verify_restore_candidate",
  "get_evidence",
  "explain_evidence",
  "get_receipt",
  "record_recall",
  "apply_projection_batch",
  "query_projections",
  "list_projection_sources",
  "traverse_relations",
  "enqueue_projection_job",
  "claim_projection_jobs",
  "fail_projection_job",
  "complete_projection_job",
  "invalidate_projection_descendants",
  "record_projection_rebuild",
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
export type ApplyProjectionBatchCommand = z.input<
  typeof ApplyProjectionBatchCommandSchema
>;
export type ParsedApplyProjectionBatchCommand = z.output<
  typeof ApplyProjectionBatchCommandSchema
>;
export type ProjectionBatchResult = z.infer<
  typeof ProjectionBatchResultSchema
>;
export type ProjectionQuery = z.input<typeof ProjectionQuerySchema>;
export type ParsedProjectionQuery = z.output<typeof ProjectionQuerySchema>;
export type ProjectionQueryResult = z.infer<
  typeof ProjectionQueryResultSchema
>;
export type ProjectionPageCursor = z.infer<
  typeof ProjectionPageCursorSchema
>;
export type ProjectionPageQuery = z.input<
  typeof ProjectionPageQuerySchema
>;
export type ParsedProjectionPageQuery = z.output<
  typeof ProjectionPageQuerySchema
>;
export type ProjectionPageResult = z.infer<
  typeof ProjectionPageResultSchema
>;
export type ProjectionSourceBatchQuery = z.input<
  typeof ProjectionSourceBatchQuerySchema
>;
export type ParsedProjectionSourceBatchQuery = z.output<
  typeof ProjectionSourceBatchQuerySchema
>;
export type ProjectionSourceBatchItem = z.infer<
  typeof ProjectionSourceBatchItemSchema
>;
export type ProjectionSourceBatchResult = z.infer<
  typeof ProjectionSourceBatchResultSchema
>;
export type ProjectionSourceListInput = z.input<
  typeof ProjectionSourceListInputSchema
>;
export type ParsedProjectionSourceListInput = z.output<
  typeof ProjectionSourceListInputSchema
>;
export type ProjectionSourceListResult = z.infer<
  typeof ProjectionSourceListResultSchema
>;
export type ProjectionStorageFrontier = z.infer<
  typeof ProjectionStorageFrontierSchema
>;
export type ProjectionScopeStorageFrontier = z.infer<
  typeof ProjectionScopeStorageFrontierSchema
>;
export type RelationTraversalInput = z.input<
  typeof RelationTraversalInputSchema
>;
export type ParsedRelationTraversalInput = z.output<
  typeof RelationTraversalInputSchema
>;
export type RelationTraversalResult = z.infer<
  typeof RelationTraversalResultSchema
>;
export type EnqueueProjectionJobCommand = z.input<
  typeof EnqueueProjectionJobCommandSchema
>;
export type ClaimProjectionJobsInput = z.input<
  typeof ClaimProjectionJobsInputSchema
>;
export type ParsedClaimProjectionJobsInput = z.output<
  typeof ClaimProjectionJobsInputSchema
>;
export type ClaimProjectionJobsResult = z.infer<
  typeof ClaimProjectionJobsResultSchema
>;
export type FailProjectionJobCommand = z.input<
  typeof FailProjectionJobCommandSchema
>;
export type CompleteProjectionJobCommand = z.input<
  typeof CompleteProjectionJobCommandSchema
>;
export type ProjectionJobMutationResult = z.infer<
  typeof ProjectionJobMutationResultSchema
>;
export type ProjectionOutboxJob = z.infer<
  typeof ProjectionOutboxJobSchema
>;
export type InvalidateProjectionDescendantsCommand = z.input<
  typeof InvalidateProjectionDescendantsCommandSchema
>;
export type InvalidateProjectionDescendantsResult = z.infer<
  typeof InvalidateProjectionDescendantsResultSchema
>;
export type ProjectionRebuildReceipt = z.input<
  typeof ProjectionRebuildReceiptSchema
>;
export type RecordProjectionRebuildResult = z.infer<
  typeof RecordProjectionRebuildResultSchema
>;
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
export type MemoryControlCommand = z.input<
  typeof MemoryControlCommandSchema
>;
export type ParsedMemoryControlCommand = z.output<
  typeof MemoryControlCommandSchema
>;
export type MemoryControlResult = z.infer<
  typeof MemoryControlResultSchema
>;
export type MemoryDeleteCommand = z.input<
  typeof MemoryDeleteCommandSchema
>;
export type ParsedMemoryDeleteCommand = z.output<
  typeof MemoryDeleteCommandSchema
>;
export type MemoryDeleteResult = z.infer<
  typeof MemoryDeleteResultSchema
>;
export type PurgeRunInput = z.input<typeof PurgeRunInputSchema>;
export type PurgeRunResult = z.infer<typeof PurgeRunResultSchema>;
export type GovernanceStorageStatus = z.infer<
  typeof GovernanceStorageStatusSchema
>;
export type MigrationEvidence = z.infer<typeof MigrationEvidenceSchema>;
export type MemoryRevisionCommand = z.input<
  typeof MemoryRevisionCommandSchema
>;
export type MemoryCorrectionBasisInput = z.input<
  typeof MemoryCorrectionBasisInputSchema
>;
export type ParsedMemoryCorrectionBasisInput = z.output<
  typeof MemoryCorrectionBasisInputSchema
>;
export type MemoryCorrectionBasis = z.infer<
  typeof MemoryCorrectionBasisSchema
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
export type EligibilityReasonCode = z.infer<
  typeof EligibilityReasonCodeSchema
>;
export type MemoryEligibilityInput = z.input<
  typeof MemoryEligibilityInputSchema
>;
export type ParsedMemoryEligibilityInput = z.output<
  typeof MemoryEligibilityInputSchema
>;
export type MemoryEligibilityResult = z.infer<
  typeof MemoryEligibilityResultSchema
>;
export type GovernedMemoryLookupInput = z.input<
  typeof GovernedMemoryLookupInputSchema
>;
export type ParsedGovernedMemoryLookupInput = z.output<
  typeof GovernedMemoryLookupInputSchema
>;
export type GovernedMemoryLookupResult = z.infer<
  typeof GovernedMemoryLookupResultSchema
>;
export type GovernedMemorySearchQuery = z.input<
  typeof GovernedMemorySearchQuerySchema
>;
export type ParsedGovernedMemorySearchQuery = z.output<
  typeof GovernedMemorySearchQuerySchema
>;
export type GovernedMemorySearchResult = z.infer<
  typeof GovernedMemorySearchResultSchema
>;
export type StorageHealth = z.infer<typeof StorageHealthSchema>;
export type VerifyArtifactsResult = z.infer<typeof VerifyArtifactsResultSchema>;
export type RestoreVerificationResult = z.infer<
  typeof RestoreVerificationResultSchema
>;
export type WorkerOperation = z.infer<typeof WorkerOperationSchema>;
export type WorkerResponse = z.infer<typeof WorkerResponseSchema>;
export type DurableEpisodeReceipt = z.infer<typeof MutationReceiptSchema>;
