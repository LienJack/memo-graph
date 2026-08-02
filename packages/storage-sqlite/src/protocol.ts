import { z } from "zod";

import {
  AuthoritySchema,
  ApprovalBindingSchema,
  ApprovalGrantSchema,
  ArtifactPurgeAuditSchema,
  CanonicalHashSchema,
  CandidateChangeSchema,
  CandidateStateSchema,
  CandidateTransitionSchema,
  CandidateTransitionReceiptSchema,
  CanaryAuthorizationSchema,
  CanaryReceiptSchema,
  CanaryRunSchema,
  EvalReceiptSchema,
  EvaluationCaseResultSetSchema,
  EvaluationCommonIdentitySchema,
  EvaluationPartitionSchema,
  EpisodeSchema,
  EncryptionKeyInventorySchema,
  EncryptionReceiptSchema,
  EvidenceRecordSchema,
  GovernedSearchItemSchema,
  GraphDeliveryReceiptSchema,
  GraphFailureCodeSchema,
  GraphScopeCheckpointSchema,
  GraphScopeSnapshotSchema,
  IdentifierSchema,
  ContextSliceSchema,
  CompleteBackupManifestSchema,
  MemoryCandidateSchema,
  MemoryKindSchema,
  MemoryProposeInputSchema,
  MemoryPinInputSchema,
  MemoryDemoteInputSchema,
  MemoryDeleteInputSchema,
  MemoryUsageSetInputSchema,
  MemoryRevokeInputSchema,
  MutationReceiptSchema,
  LearningControlReceiptSchema,
  LearningControlSchema,
  KeyRotationProgressSchema,
  LearningReleaseVersionSchema,
  LearningStopReceiptSchema,
  LearningTraceSchema,
  MonitorReceiptSchema,
  MonitorResultSchema,
  PostCanaryApprovalSchema,
  PurgeReceiptSchema,
  ProjectionFrontierSchema,
  ProjectionRevisionSchema,
  ProjectionSourceSchema,
  ProjectionTypeSchema,
  RecallRequestSchema,
  ReceiptSchema,
  ReleasePointerSchema,
  ReleaseReceiptSchema,
  RelationTypeSchema,
  RecoveryAnchorSchema,
  RecoveryMinimumsSchema,
  RecoveryPendingAuthorizationSchema,
  RecoveryPendingReservationSchema,
  RollbackReceiptSchema,
  RetrievalReceiptSchema,
  ScopeSchema,
  SensitivitySchema,
  SecretContentOwnerSchema,
  SecretAdmissionApprovalSchema,
  G6ReleaseControlSchema,
  SecretEncryptedPayloadSchema,
  SecretEnvelopeMetadataSchema,
  SecretUseAuthoritySchema,
  TransformRefSchema,
  UtcTimestampSchema,
  VectorEmbeddingEpochSchema,
  VectorFailureCategorySchema,
  VectorProjectionJobSchema,
  VectorProjectionReceiptSchema,
  VectorScopeCheckpointSchema,
  WorkbenchCorrectionImpactSchema,
  WorkbenchCorrectionImpactSealSchema,
  type WorkbenchMemoryCandidateSetSchema,
  WorkbenchMemoryDetailRequestSchema,
  type WorkbenchMemoryDetailResultSchema,
  WorkbenchMemoryListRequestSchema,
  WorkbenchMemoryMemberSchema,
  type WorkbenchMemorySummaryBatchResultSchema,
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

export const InstallEncryptionKeyCommandSchema = z
  .object({
    operation_id: IdentifierSchema,
    request_digest: CanonicalHashSchema,
    key_id: IdentifierSchema,
    key_generation: z.number().int().positive(),
    verification_tag: z
      .string()
      .regex(/^hmac-sha256:[A-Za-z0-9_-]{43}$/),
    authority_key_id: IdentifierSchema,
    authority_public_key_base64url: z
      .string()
      .regex(/^[A-Za-z0-9_-]{59}$/),
    commitment_key_id: IdentifierSchema,
    commitment_verification_tag: z
      .string()
      .regex(/^hmac-sha256:[A-Za-z0-9_-]{43}$/),
    created_at: UtcTimestampSchema,
  })
  .strict();

export const VerifyEncryptionKeyCommandSchema = z
  .object({
    key_id: IdentifierSchema,
    key_generation: z.number().int().positive(),
    verification_tag: z
      .string()
      .regex(/^hmac-sha256:[A-Za-z0-9_-]{43}$/),
    forbidden_authority_public_keys: z
      .array(z.string().regex(/^[A-Za-z0-9_-]{59}$/))
      .max(8)
      .optional(),
  })
  .strict();

export const ReserveSecretNonceCommandSchema = z
  .object({
    operation_id: IdentifierSchema,
    idempotency_key: z.string().trim().min(8).max(200),
    request_digest: CanonicalHashSchema,
    owner: SecretContentOwnerSchema,
    scope: ScopeSchema,
    content_identity: IdentifierSchema,
    media_type: z.string().trim().min(1).max(160),
    keyed_plaintext_commitment: z
      .string()
      .regex(/^hmac-sha256:[A-Za-z0-9_-]{43}$/),
    commitment_key_id: IdentifierSchema,
    commitment_verification_tag: z
      .string()
      .regex(/^hmac-sha256:[A-Za-z0-9_-]{43}$/),
  })
  .strict();

export const ReserveSecretNonceResultSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("prepared"),
      operation_id: IdentifierSchema,
      metadata: SecretEnvelopeMetadataSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal("committed"),
      operation_id: IdentifierSchema,
      receipt: EncryptionReceiptSchema,
    })
    .strict(),
]);

export const CommitEncryptedSecretCommandSchema = z
  .object({
    operation_id: IdentifierSchema,
    request_digest: CanonicalHashSchema,
    payload: SecretEncryptedPayloadSchema,
    approval: SecretAdmissionApprovalSchema,
    release_control: G6ReleaseControlSchema.nullable(),
    validated_at: UtcTimestampSchema,
  })
  .strict();

export const BeginKeyRotationCommandSchema = z
  .object({
    rotation_id: IdentifierSchema,
    request_digest: CanonicalHashSchema,
    new_key_id: IdentifierSchema,
    new_key_generation: z.number().int().positive(),
    new_verification_tag: z
      .string()
      .regex(/^hmac-sha256:[A-Za-z0-9_-]{43}$/),
    new_authority_key_id: IdentifierSchema,
    new_authority_public_key_base64url: z
      .string()
      .regex(/^[A-Za-z0-9_-]{59}$/),
    new_commitment_key_id: IdentifierSchema,
    new_commitment_verification_tag: z
      .string()
      .regex(/^hmac-sha256:[A-Za-z0-9_-]{43}$/),
    started_at: UtcTimestampSchema,
  })
  .strict();

export const BeginKeyRotationResultSchema = z
  .object({
    progress: KeyRotationProgressSchema,
    receipt: EncryptionReceiptSchema,
  })
  .strict();

export const KeyRotationInputSchema = z
  .object({ rotation_id: IdentifierSchema })
  .strict();

export const KeyRotationItemSchema = z
  .object({
    rotation_id: IdentifierSchema,
    old_ciphertext_id: IdentifierSchema,
    owner: SecretContentOwnerSchema,
    old_metadata: SecretEnvelopeMetadataSchema,
  })
  .strict();

export const KeyRotationNextResultSchema = z
  .object({
    progress: KeyRotationProgressSchema,
    item: KeyRotationItemSchema.nullable(),
  })
  .strict();

export const ConsumeSecretUseAuthorityCommandSchema =
  SecretUseAuthoritySchema;

export const AuthorizedSecretUseResultSchema = z
  .object({
    receipt: EncryptionReceiptSchema,
    payload: SecretEncryptedPayloadSchema,
  })
  .strict();

export const SecretPurgeTargetInputSchema = z
  .object({ owner: SecretContentOwnerSchema })
  .strict();

export const SecretPurgeTargetSchema = z
  .object({
    owner: SecretContentOwnerSchema,
    ciphertext_id: IdentifierSchema,
    metadata: SecretEnvelopeMetadataSchema,
    envelope_hash: CanonicalHashSchema,
  })
  .strict();

export const ReplaySecretPurgeCommandSchema = z
  .object({
    operation_id: IdentifierSchema,
    request_digest: CanonicalHashSchema,
  })
  .strict();

export const ReplaySecretPurgeResultSchema =
  EncryptionReceiptSchema.nullable();

export const PurgeEncryptedSecretCommandSchema = z
  .object({
    operation_id: IdentifierSchema,
    request_digest: CanonicalHashSchema,
    authority: SecretUseAuthoritySchema,
  })
  .strict();

export const ReserveRotationNonceCommandSchema =
  ReserveSecretNonceCommandSchema.extend({
    rotation_id: IdentifierSchema,
  }).strict();

export const CommitRotatedSecretCommandSchema = z
  .object({
    rotation_id: IdentifierSchema,
    old_ciphertext_id: IdentifierSchema,
    operation_id: IdentifierSchema,
    request_digest: CanonicalHashSchema,
    payload: SecretEncryptedPayloadSchema,
  })
  .strict();

export const CompleteKeyRotationResultSchema = z
  .object({
    progress: KeyRotationProgressSchema,
    receipt: EncryptionReceiptSchema,
  })
  .strict();

export const AbortKeyRotationResultSchema = z
  .object({
    progress: KeyRotationProgressSchema,
    receipt: EncryptionReceiptSchema,
  })
  .strict();

export const RevokeEncryptionKeyCommandSchema = z
  .object({
    operation_id: IdentifierSchema,
    request_digest: CanonicalHashSchema,
    key_id: IdentifierSchema,
    changed_at: UtcTimestampSchema,
  })
  .strict();

export const RevokeEncryptionKeyResultSchema = z
  .object({
    inventory: EncryptionKeyInventorySchema,
    receipt: EncryptionReceiptSchema,
  })
  .strict();

export const VerifiedApprovalCommandSchema = z
  .object({
    grant: ApprovalGrantSchema,
    registry_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    verified_at: UtcTimestampSchema,
  })
  .strict();

const LearningWriteBaseShape = {
  idempotency_key: z.string().trim().min(8).max(200),
  idempotency_hash: CanonicalHashSchema.optional(),
  request_hash: CanonicalHashSchema,
};

export const LearningPartitionSealSchema = z
  .object({
    seal_id: IdentifierSchema,
    partition: EvaluationPartitionSchema,
    manifest_hash: CanonicalHashSchema,
    case_hashes: z.array(CanonicalHashSchema).min(3),
    oracle_hashes: z.array(CanonicalHashSchema).min(3),
    sealed_at: UtcTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    for (const [field, values] of [
      ["case_hashes", value.case_hashes],
      ["oracle_hashes", value.oracle_hashes],
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} must be unique`,
        });
      }
    }
  });

export const LearningContaminationEventSchema = z
  .object({
    contamination_event_id: IdentifierSchema,
    run_id: IdentifierSchema,
    partition: EvaluationPartitionSchema,
    case_id: IdentifierSchema.nullable(),
    code: z.string().trim().min(1).max(200),
    detected_at: UtcTimestampSchema,
    event_hash: CanonicalHashSchema,
  })
  .strict();

const LearningTraceWriteCommandSchema = z
  .object({
    ...LearningWriteBaseShape,
    kind: z.literal("trace"),
    trace: LearningTraceSchema,
  })
  .strict();

const LearningStopWriteCommandSchema = z
  .object({
    ...LearningWriteBaseShape,
    kind: z.literal("stop"),
    principal_id: IdentifierSchema,
    scopes: z.array(ScopeSchema).min(1),
    receipt: LearningStopReceiptSchema,
  })
  .strict();

const LearningCandidateWriteCommandSchema = z
  .object({
    ...LearningWriteBaseShape,
    kind: z.literal("candidate"),
    candidate: CandidateChangeSchema,
  })
  .strict();

const LearningTransitionWriteCommandSchema = z
  .object({
    ...LearningWriteBaseShape,
    kind: z.literal("transition"),
    transition: CandidateTransitionSchema,
    receipt: CandidateTransitionReceiptSchema.optional(),
  })
  .strict();

const LearningEvaluationWriteCommandSchema = z
  .object({
    ...LearningWriteBaseShape,
    kind: z.literal("evaluation"),
    principal_id: IdentifierSchema,
    scopes: z.array(ScopeSchema).min(1),
    identity: EvaluationCommonIdentitySchema,
    partition_seals: z.array(LearningPartitionSealSchema).length(3),
    result_sets: z.array(EvaluationCaseResultSetSchema).min(1),
    contamination_events: z.array(LearningContaminationEventSchema),
    receipt: EvalReceiptSchema,
  })
  .strict();

const LearningCanaryWriteCommandSchema = z
  .object({
    ...LearningWriteBaseShape,
    kind: z.literal("canary"),
    principal_id: IdentifierSchema,
    scopes: z.array(ScopeSchema).min(1),
    authorization: CanaryAuthorizationSchema,
    transition: CandidateTransitionSchema,
    run: CanaryRunSchema,
    receipt: CanaryReceiptSchema,
    test_failure_point: z
      .enum([
        "after_guard",
        "after_transition",
        "after_authorization",
        "after_canary_run",
        "after_receipt",
        "after_idempotency",
      ])
      .optional(),
  })
  .strict();

const LearningMonitorWriteCommandSchema = z
  .object({
    ...LearningWriteBaseShape,
    kind: z.literal("monitor"),
    principal_id: IdentifierSchema,
    scopes: z.array(ScopeSchema).min(1),
    monitor: MonitorResultSchema,
    receipt: MonitorReceiptSchema,
  })
  .strict();

const LearningControlWriteCommandSchema = z
  .object({
    ...LearningWriteBaseShape,
    kind: z.literal("control"),
    expected_control_epoch: z.number().int().nonnegative(),
    expected_frontier_hash: CanonicalHashSchema,
    control: LearningControlSchema,
    receipt: LearningControlReceiptSchema,
    approval_binding: ApprovalBindingSchema,
    approval: VerifiedApprovalCommandSchema,
    test_failure_point: z
      .enum([
        "after_guard",
        "after_control",
        "after_receipt",
        "after_approval",
        "after_idempotency",
      ])
      .optional(),
  })
  .strict();

export const LearningReleaseEffectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("retrieval_policy") }).strict(),
  z
    .object({
      kind: z.literal("canonical_memory"),
      candidate_type: z.enum(["memory", "procedure"]),
      memory_id: IdentifierSchema,
      revision_id: IdentifierSchema,
      content_hash: CanonicalHashSchema,
    })
    .strict(),
]);

const LearningReleaseWriteCommandSchema = z
  .object({
    ...LearningWriteBaseShape,
    kind: z.enum(["release", "rollback"]),
    principal_id: IdentifierSchema,
    scopes: z.array(ScopeSchema).min(1),
    expected_control_epoch: z.number().int().nonnegative(),
    expected_pointer_revision: z.number().int().nonnegative(),
    approval_artifact: PostCanaryApprovalSchema,
    approval_binding: ApprovalBindingSchema,
    approval: VerifiedApprovalCommandSchema,
    effect: LearningReleaseEffectSchema.default({
      kind: "retrieval_policy",
    }),
    release: LearningReleaseVersionSchema,
    pointer: ReleasePointerSchema,
    transition: CandidateTransitionSchema,
    receipt: z.union([ReleaseReceiptSchema, RollbackReceiptSchema]),
    test_failure_point: z
      .enum([
        "after_guard",
        "after_canonical_effect",
        "after_release",
        "after_pointer",
        "after_transition",
        "after_receipt",
        "after_approval",
        "after_idempotency",
      ])
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const releaseMatches =
      value.kind === "release" &&
      value.release.action === "release" &&
      value.receipt.kind === "release";
    const rollbackMatches =
      value.kind === "rollback" &&
      value.release.action === "rollback" &&
      value.receipt.kind === "rollback";
    if (!releaseMatches && !rollbackMatches) {
      context.addIssue({
        code: "custom",
        path: ["kind"],
        message: "learning release command kind, version, and receipt must agree",
      });
    }
  });

export const LearningLedgerWriteCommandSchema = z.discriminatedUnion("kind", [
  LearningTraceWriteCommandSchema,
  LearningStopWriteCommandSchema,
  LearningCandidateWriteCommandSchema,
  LearningTransitionWriteCommandSchema,
  LearningEvaluationWriteCommandSchema,
  LearningCanaryWriteCommandSchema,
  LearningMonitorWriteCommandSchema,
  LearningControlWriteCommandSchema,
  LearningReleaseWriteCommandSchema,
]);

export const LearningLedgerWriteResultSchema = z
  .object({
    kind: z.enum([
      "trace",
      "stop",
      "candidate",
      "transition",
      "evaluation",
      "canary",
      "monitor",
      "control",
      "release",
      "rollback",
    ]),
    replayed: z.boolean(),
    ledger_epoch: z.number().int().nonnegative(),
    receipt: ReceiptSchema.nullable(),
  })
  .strict();

export const LearningLedgerReplayInputSchema = z
  .object({
    idempotency_key: z.string().trim().min(8).max(200),
    idempotency_hash: CanonicalHashSchema,
  })
  .strict();

export const LearningLedgerReplayResultSchema =
  LearningLedgerWriteResultSchema.nullable();

export const LearningLedgerReadInputSchema = z
  .object({
    principal_id: IdentifierSchema,
    scopes: z.array(ScopeSchema).min(1),
    trace_id: IdentifierSchema.optional(),
    candidate_id: IdentifierSchema.optional(),
    release_slot_hash: CanonicalHashSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const keys = value.scopes.map(scopeKey);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        path: ["scopes"],
        message: "learning read scopes must be unique",
      });
    }
  });

export const LearningCandidateStateSchema = z
  .object({
    candidate_id: IdentifierSchema,
    state: CandidateStateSchema,
    sequence: z.number().int().nonnegative(),
    transition_hash: CanonicalHashSchema.nullable(),
  })
  .strict();

export const LearningLedgerReadResultSchema = z
  .object({
    traces: z.array(LearningTraceSchema),
    candidates: z.array(CandidateChangeSchema),
    transitions: z.array(CandidateTransitionSchema),
    candidate_states: z.array(LearningCandidateStateSchema),
    evaluation_identities: z.array(EvaluationCommonIdentitySchema),
    evaluation_result_sets: z.array(EvaluationCaseResultSetSchema),
    contamination_events: z.array(LearningContaminationEventSchema),
    canary_authorizations: z.array(CanaryAuthorizationSchema),
    canary_runs: z.array(CanaryRunSchema),
    releases: z.array(LearningReleaseVersionSchema),
    pointers: z.array(ReleasePointerSchema),
    monitors: z.array(MonitorResultSchema),
    controls: z.array(LearningControlSchema),
    receipts: z.array(ReceiptSchema),
    invalid_candidate_ids: z.array(IdentifierSchema),
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
    learning_traces: z.number().int().nonnegative(),
    learning_candidates: z.number().int().nonnegative(),
    learning_transitions: z.number().int().nonnegative(),
    learning_evaluation_runs: z.number().int().nonnegative(),
    learning_canary_runs: z.number().int().nonnegative(),
    learning_release_versions: z.number().int().nonnegative(),
    learning_release_pointers: z.number().int().nonnegative(),
    learning_monitor_results: z.number().int().nonnegative(),
    learning_control_rows: z.number().int().nonnegative(),
    learning_receipts: z.number().int().nonnegative(),
    encryption_keys: z.number().int().nonnegative(),
    encrypted_contents: z.number().int().nonnegative(),
    secret_nonce_reservations: z.number().int().nonnegative(),
    key_rotations: z.number().int().nonnegative(),
    encrypted_artifact_operations: z.number().int().nonnegative(),
    operational_receipts: z.number().int().nonnegative(),
    artifact_store_registry: z.number().int().nonnegative(),
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

export const ProjectionScopeFrontierInputSchema = z
  .object({
    principal_id: IdentifierSchema,
    scope: ScopeSchema,
  })
  .strict();

export const LearningStorageFrontierSchema = z
  .object({
    control_epoch: z.number().int().nonnegative(),
    release_revision: z.number().int().nonnegative(),
    frontier_hash: CanonicalHashSchema,
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
    layered_projection_state: z.enum([
      "ready",
      "pending",
      "rebuilding",
      "unavailable",
    ]),
    projection_frontier: ProjectionStorageFrontierSchema,
    learning_frontier: LearningStorageFrontierSchema,
    encryption: EncryptionKeyInventorySchema,
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
    dry_run: z.boolean().default(false),
    request_hash: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
    approval_binding: ApprovalBindingSchema.optional(),
    approval: VerifiedApprovalCommandSchema.optional(),
    correction_evidence: EvidenceRecordSchema.optional(),
    expected_projection_impact:
      WorkbenchCorrectionImpactSealSchema.optional(),
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
    if (
      value.dry_run &&
      (value.correction_evidence !== undefined ||
        value.expected_projection_impact !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["correction_evidence"],
        message: "revision previews cannot carry correction effects",
      });
    }
    if (
      (value.correction_evidence === undefined) !==
      (value.expected_projection_impact === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["expected_projection_impact"],
        message:
          "atomic Workbench corrections require both feedback evidence and a projection impact seal",
      });
    }
  });

export const PreviewMemoryRevisionCommandSchema =
  MemoryRevisionCommandSchema.refine(
    (value) => value.dry_run === true,
    {
      path: ["dry_run"],
      message: "revision previews require dry_run=true",
    },
  );

export const EffectMemoryRevisionCommandSchema =
  MemoryRevisionCommandSchema.refine(
    (value) => value.dry_run === false,
    {
      path: ["dry_run"],
      message: "effect-bearing revisions require dry_run=false",
    },
  );

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

export const WorkbenchCorrectionStoragePreviewInputSchema = z
  .object({
    memory_id: IdentifierSchema,
    principal_id: IdentifierSchema,
    scope: ScopeSchema,
    expected_revision_id: IdentifierSchema,
    impact_limit: z.number().int().min(1).max(1_000),
    sample_limit: z.number().int().nonnegative().max(100),
  })
  .strict();

export const WorkbenchCorrectionStoragePreviewResultSchema = z
  .object({
    basis: MemoryCorrectionBasisSchema,
    impact: WorkbenchCorrectionImpactSchema,
  })
  .strict();

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

export const PreviewMemoryControlCommandSchema =
  MemoryControlCommandSchema.refine(
    (value) => value.request.envelope.dry_run === true,
    {
      path: ["request", "envelope", "dry_run"],
      message: "control previews require dry_run=true",
    },
  );

export const EffectMemoryControlCommandSchema =
  MemoryControlCommandSchema.refine(
    (value) => value.request.envelope.dry_run === false,
    {
      path: ["request", "envelope", "dry_run"],
      message: "effect-bearing controls require dry_run=false",
    },
  );

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

export const PreviewMemoryDeleteCommandSchema =
  MemoryDeleteCommandSchema.refine(
    (value) => value.request.envelope.dry_run === true,
    {
      path: ["request", "envelope", "dry_run"],
      message: "delete previews require dry_run=true",
    },
  );

export const EffectMemoryDeleteCommandSchema =
  MemoryDeleteCommandSchema.refine(
    (value) => value.request.envelope.dry_run === false,
    {
      path: ["request", "envelope", "dry_run"],
      message: "effect-bearing deletion requires dry_run=false",
    },
  );

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
    operator_action: z
      .object({
        operation_id: IdentifierSchema,
        expected_prior_receipt_id: IdentifierSchema.nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const PurgeRunResultSchema = PurgeReceiptSchema;

export const PurgePhysicalMaintenanceSchema = z
  .object({
    purge_job_id: IdentifierSchema,
    attempt: z.number().int().positive(),
    outcomes_hash: CanonicalHashSchema,
  })
  .strict();

export const PurgePreparationResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("receipt"),
      receipt: PurgeReceiptSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("maintenance"),
      maintenance: PurgePhysicalMaintenanceSchema,
    })
    .strict(),
]);

export const PurgeCompletionInputSchema = PurgeRunInputSchema.extend({
  maintenance: PurgePhysicalMaintenanceSchema,
}).strict();

export const InspectPurgeReceiptInputSchema = z
  .object({
    purge_job_id: IdentifierSchema,
    operator_operation_id: IdentifierSchema.optional(),
  })
  .strict();

export const InspectPurgeReceiptResultSchema = PurgeReceiptSchema.nullable();

export const AuditPurgeArtifactsInputSchema = z
  .object({
    audit_id: IdentifierSchema,
    expected_tombstone_epoch: z.number().int().nonnegative(),
    checked_at: UtcTimestampSchema,
  })
  .strict();

export const AuditPurgeArtifactsResultSchema = ArtifactPurgeAuditSchema;

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

const WorkbenchReadAccessFields = {
  principal_id: IdentifierSchema,
  allowed_scopes: z.array(ScopeSchema).min(1).max(100),
  as_of: UtcTimestampSchema,
  include_sensitive: z.boolean().default(false),
  context_scope: ScopeSchema.nullable().default(null),
};

export const WorkbenchMemoryListQuerySchema = z
  .object({
    ...WorkbenchReadAccessFields,
    max_snapshot_members: z.number().int().min(1).max(10_000),
    request: WorkbenchMemoryListRequestSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.request.cursor !== null) {
      context.addIssue({
        code: "custom",
        path: ["request", "cursor"],
        message: "storage creates snapshot membership only for first-page requests",
      });
    }
    const scopeKeys = value.allowed_scopes.map(scopeKey);
    if (new Set(scopeKeys).size !== scopeKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["allowed_scopes"],
        message: "allowed workbench scopes must be unique",
      });
    }
    if (
      value.request.scope !== null &&
      !scopeKeys.includes(scopeKey(value.request.scope))
    ) {
      context.addIssue({
        code: "custom",
        path: ["request", "scope"],
        message: "requested workbench scope must be allowed",
      });
    }
  });

export const WorkbenchMemorySummaryBatchQuerySchema = z
  .object({
    ...WorkbenchReadAccessFields,
    members: z.array(WorkbenchMemoryMemberSchema).min(1).max(100),
  })
  .strict();

export const WorkbenchMemoryDetailQuerySchema = z
  .object({
    ...WorkbenchReadAccessFields,
    max_history: z.number().int().min(1).max(1_000),
    max_provenance_nodes: z.number().int().min(1).max(500),
    request: WorkbenchMemoryDetailRequestSchema,
  })
  .strict();

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

export const OperationalRepairInputSchema = z
  .object({
    operation_id: IdentifierSchema,
    repair_kind: z.enum([
      "fts",
      "layered_projection",
      "sqlite_relations",
    ]),
    source: z.literal("canonical_sqlite"),
    principal_id: IdentifierSchema.nullable().default(null),
    scope: ScopeSchema.nullable().default(null),
    expected_frontier_hash: CanonicalHashSchema,
    started_at: UtcTimestampSchema,
    completed_at: UtcTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const scoped = value.repair_kind !== "fts";
    if (
      ((value.principal_id !== null) !== scoped ||
        (value.scope !== null) !== scoped)
    ) {
      context.addIssue({
        code: "custom",
        path: ["scope"],
        message: "canonical projection repairs require one exact scope",
      });
    }
  });

export const OperationalRepairResultSchema = z
  .object({
    schema_version: z.literal("1.0.0"),
    operation_id: IdentifierSchema,
    repair_kind: OperationalRepairInputSchema.shape.repair_kind,
    source: z.literal("canonical_sqlite"),
    principal_id: IdentifierSchema.nullable(),
    scope: ScopeSchema.nullable(),
    state: z.enum(["rebuilding", "completed", "blocked"]),
    source_frontier_hash: CanonicalHashSchema,
    artifact_count: z.number().int().nonnegative().nullable(),
    relation_count: z.number().int().nonnegative().nullable(),
    ledger_epoch: z.number().int().nonnegative().nullable(),
    result_hash: CanonicalHashSchema.nullable(),
    completed_at: UtcTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const scoped = value.repair_kind !== "fts";
    const legacyUnscoped =
      scoped &&
      value.state !== "rebuilding" &&
      value.principal_id === null &&
      value.scope === null;
    if (
      !legacyUnscoped &&
      ((value.principal_id !== null) !== scoped ||
        (value.scope !== null) !== scoped)
    ) {
      context.addIssue({
        code: "custom",
        path: ["scope"],
        message: "repair result scope does not match repair kind",
      });
    }
    const complete = value.state !== "rebuilding";
    if (
      (value.artifact_count !== null) !== complete ||
      (value.relation_count !== null) !== complete ||
      (value.ledger_epoch !== null) !== complete ||
      (value.result_hash !== null) !== complete ||
      (value.completed_at !== null) !== complete
    ) {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "operational repair result does not match state",
      });
    }
  });

export const InspectOperationalRepairInputSchema = z
  .object({ operation_id: IdentifierSchema })
  .strict();

export const InspectOperationalRepairResultSchema =
  OperationalRepairResultSchema.nullable();

export const OperatorConfirmationBindingSchema = z
  .object({
    confirmation_id: IdentifierSchema,
    operation_id: IdentifierSchema,
    intent_hash: CanonicalHashSchema,
    command: z.literal("key_rotate"),
    parameters_digest: CanonicalHashSchema,
    created_at: UtcTimestampSchema,
  })
  .strict();

export const CompleteOperationalRepairInputSchema = z
  .object({
    command: OperationalRepairInputSchema,
    artifact_count: z.number().int().nonnegative(),
    relation_count: z.number().int().nonnegative(),
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

export const BackupDraftResultSchema = z
  .object({
    backup_id: z.string().min(1),
    directory: z.string().min(1),
    path: z.string().min(1),
    ledger_epoch: z.number().int().nonnegative(),
    tombstone_epoch: z.number().int().nonnegative(),
    learning_control_epoch: z.number().int().nonnegative(),
    learning_release_revision: z.number().int().nonnegative(),
    learning_frontier_hash: CanonicalHashSchema,
    latest_receipt_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
    blob_hashes: z.array(z.string().regex(/^sha256:[a-f0-9]{64}$/)),
    integrity_check: z.literal("ok"),
    size_bytes: z.number().int().nonnegative(),
    manifest_path: z.string().min(1),
    manifest: CompleteBackupManifestSchema,
  })
  .strict();

export const BackupResultSchema = BackupDraftResultSchema.extend({
  recovery_anchor: RecoveryAnchorSchema,
}).strict();

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
    verified_encrypted_contents: z.number().int().nonnegative(),
    active_memories_verified: z.number().int().nonnegative(),
    active_projections_verified: z.number().int().nonnegative(),
    active_relations_verified: z.number().int().nonnegative(),
    projection_rebuild_required: z.boolean(),
    context_slices_verified: z.number().int().nonnegative(),
    receipts_verified: z.number().int().nonnegative(),
    purge_jobs_verified: z.number().int().nonnegative(),
    learning_traces_verified: z.number().int().nonnegative(),
    learning_candidates_verified: z.number().int().nonnegative(),
    learning_releases_verified: z.number().int().nonnegative(),
    learning_control_rows_verified: z.number().int().nonnegative(),
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
    fanout_observed_count: z.number().int().nonnegative(),
    fanout_retained_count: z.number().int().nonnegative(),
    fanout_truncated_count: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.fanout_retained_count + value.fanout_truncated_count !==
        value.fanout_observed_count
    ) {
      context.addIssue({
        code: "custom",
        path: ["fanout_truncated_count"],
        message: "relation fanout counts must exactly partition observations",
      });
    }
    if (value.truncated !== (value.fanout_truncated_count > 0)) {
      context.addIssue({
        code: "custom",
        path: ["truncated"],
        message: "relation truncation must match the exact fanout count",
      });
    }
  });

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

export const MAX_GRAPH_PROJECTION_ATTEMPTS = 32;
export const MAX_GRAPH_PROJECTION_LEASE_MS = 15 * 60_000;

export const GraphProjectionOutboxJobSchema = z
  .object({
    job_id: IdentifierSchema,
    operation: z.enum(["scope_replace", "full_rebuild"]),
    backend: z.literal("ladybugdb"),
    principal_id: IdentifierSchema,
    scope: ScopeSchema,
    target_frontier: ProjectionFrontierSchema.nullable(),
    expected_logical_digest: CanonicalHashSchema.nullable(),
    status: z.enum([
      "pending",
      "processing",
      "applied",
      "failed",
      "stale",
      "skipped",
    ]),
    attempts: z.number().int().min(0).max(
      MAX_GRAPH_PROJECTION_ATTEMPTS,
    ),
    available_at: UtcTimestampSchema,
    claimed_by: IdentifierSchema.nullable(),
    lease_token: IdentifierSchema.nullable(),
    lease_expires_at: UtcTimestampSchema.nullable(),
    created_at: UtcTimestampSchema,
    completed_at: UtcTimestampSchema.nullable(),
    last_failure: GraphFailureCodeSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.target_frontier === null) !==
        (value.expected_logical_digest === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["target_frontier"],
        message: "graph target frontier and digest must be present together",
      });
    }
    if (
      value.status === "processing" &&
      (value.claimed_by === null ||
        value.lease_token === null ||
        value.lease_expires_at === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "processing graph jobs require one exact lease",
      });
    }
  });

export const GraphScopeInputSchema = z
  .object({
    backend: z.literal("ladybugdb").default("ladybugdb"),
    principal_id: IdentifierSchema,
    scope: ScopeSchema,
  })
  .strict();

export const ClaimGraphProjectionJobsInputSchema = z
  .object({
    backend: z.literal("ladybugdb").default("ladybugdb"),
    worker_id: IdentifierSchema,
    claimed_at: UtcTimestampSchema,
    lease_expires_at: UtcTimestampSchema,
    operations: z.array(
      z.enum(["scope_replace", "full_rebuild"]),
    ).min(1).max(2).default(["scope_replace"]),
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
        message: "graph job lease must expire after claim time",
      });
    }
    if (
      Date.parse(value.lease_expires_at) - Date.parse(value.claimed_at) >
        MAX_GRAPH_PROJECTION_LEASE_MS
    ) {
      context.addIssue({
        code: "custom",
        path: ["lease_expires_at"],
        message: "graph job lease exceeds the bounded maximum",
      });
    }
    if (new Set(value.operations).size !== value.operations.length) {
      context.addIssue({
        code: "custom",
        path: ["operations"],
        message: "graph job operation filters must be unique",
      });
    }
  });

export const ClaimGraphProjectionJobsResultSchema = z
  .object({
    jobs: z.array(GraphProjectionOutboxJobSchema),
  })
  .strict();

export const ApplyGraphProjectionJobCommandSchema = z
  .object({
    job_id: IdentifierSchema,
    worker_id: IdentifierSchema,
    lease_token: IdentifierSchema,
    receipt: GraphDeliveryReceiptSchema,
  })
  .strict();

export const FailGraphProjectionJobCommandSchema = z
  .object({
    job_id: IdentifierSchema,
    worker_id: IdentifierSchema,
    lease_token: IdentifierSchema,
    retry_at: UtcTimestampSchema,
    receipt: GraphDeliveryReceiptSchema,
  })
  .strict();

export const GraphProjectionJobResultSchema = z
  .object({
    job: GraphProjectionOutboxJobSchema,
    checkpoint: GraphScopeCheckpointSchema,
    receipt: GraphDeliveryReceiptSchema.nullable(),
    replayed: z.boolean(),
  })
  .strict();

export const ResetGraphProjectionScopesInputSchema = z
  .object({
    backend: z.literal("ladybugdb").default("ladybugdb"),
    scopes: z.array(
      z.object({
        principal_id: IdentifierSchema,
        scope: ScopeSchema,
      }).strict(),
    ).min(1).max(10_000),
    mode: z.enum(["pending", "rebuilding"]),
    reset_at: UtcTimestampSchema,
  })
  .strict();

export const ResetGraphProjectionScopesResultSchema = z
  .object({
    checkpoints: z.array(GraphScopeCheckpointSchema),
    job_ids: z.array(IdentifierSchema),
  })
  .strict();

export const MarkGraphRestoreUnavailableInputSchema = z
  .object({
    restored_at: UtcTimestampSchema,
  })
  .strict();

export const MarkGraphRestoreUnavailableResultSchema = z
  .object({
    updated_scopes: z.number().int().nonnegative(),
  })
  .strict();

export const GraphProjectionStatusSchema = z
  .object({
    scope_states: z.number().int().nonnegative(),
    ready_scopes: z.number().int().nonnegative(),
    pending_scopes: z.number().int().nonnegative(),
    unavailable_scopes: z.number().int().nonnegative(),
    outbox_pending: z.number().int().nonnegative(),
    receipts: z.number().int().nonnegative(),
  })
  .strict();

export const GraphScopeSnapshotResultSchema = z
  .object({
    snapshot: GraphScopeSnapshotSchema,
  })
  .strict();

export const GraphProjectionSnapshotListInputSchema = z
  .object({
    backend: z.literal("ladybugdb").default("ladybugdb"),
  })
  .strict();

export const GraphProjectionSnapshotListResultSchema = z
  .object({
    snapshots: z.array(GraphScopeSnapshotSchema).max(10_000),
  })
  .strict();

export const RegisterVectorEmbeddingEpochCommandSchema = z
  .object({
    epoch: VectorEmbeddingEpochSchema,
    registered_at: UtcTimestampSchema,
  })
  .strict();

export const RegisterVectorEmbeddingEpochResultSchema = z
  .object({
    epoch: VectorEmbeddingEpochSchema,
    replayed: z.boolean(),
  })
  .strict();

export const VectorRuntimeModeSchema = z.enum([
  "disabled",
  "evaluating",
  "enabled",
]);

export const ConfigureVectorProjectionCommandSchema = z
  .object({
    mode: VectorRuntimeModeSchema,
    epoch_id: CanonicalHashSchema.nullable(),
    configured_at: UtcTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.mode === "disabled") !== (value.epoch_id === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["epoch_id"],
        message:
          "disabled vector mode must omit an epoch and active modes require one",
      });
    }
  });

export const ConfigureVectorProjectionResultSchema = z
  .object({
    mode: VectorRuntimeModeSchema,
    epoch_id: CanonicalHashSchema.nullable(),
    checkpoints: z.array(VectorScopeCheckpointSchema),
    job_ids: z.array(IdentifierSchema),
  })
  .strict();

export const VectorProjectionScopeInputSchema = z
  .object({
    principal_id: IdentifierSchema,
    scope: ScopeSchema,
  })
  .strict();

export const VectorProjectionOutboxJobSchema =
  VectorProjectionJobSchema.safeExtend({
    status: z.enum([
      "pending",
      "processing",
      "applied",
      "failed",
      "stale",
      "purged",
      "disabled",
    ]),
    available_at: UtcTimestampSchema,
    created_at: UtcTimestampSchema,
    completed_at: UtcTimestampSchema.nullable(),
    failure_category: VectorFailureCategorySchema.nullable(),
  });

export const ClaimVectorProjectionJobsInputSchema = z
  .object({
    worker_id: IdentifierSchema,
    claimed_at: UtcTimestampSchema,
    lease_expires_at: UtcTimestampSchema,
    limit: z.number().int().min(1).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    const duration =
      Date.parse(value.lease_expires_at) -
      Date.parse(value.claimed_at);
    if (duration <= 0 || duration > 15 * 60_000) {
      context.addIssue({
        code: "custom",
        path: ["lease_expires_at"],
        message: "vector lease duration is invalid",
      });
    }
  });

export const ClaimVectorProjectionJobsResultSchema = z
  .object({
    jobs: z.array(VectorProjectionOutboxJobSchema),
  })
  .strict();

export const ApplyVectorProjectionJobCommandSchema = z
  .object({
    job_id: IdentifierSchema,
    worker_id: IdentifierSchema,
    lease_token: IdentifierSchema,
    receipt: VectorProjectionReceiptSchema,
  })
  .strict();

export const FailVectorProjectionJobCommandSchema =
  ApplyVectorProjectionJobCommandSchema.safeExtend({
    retry_at: UtcTimestampSchema,
  });

export const StaleVectorProjectionJobCommandSchema =
  ApplyVectorProjectionJobCommandSchema;

export const VectorProjectionJobResultSchema = z
  .object({
    job: VectorProjectionOutboxJobSchema,
    checkpoint: VectorScopeCheckpointSchema,
    receipt: VectorProjectionReceiptSchema.nullable(),
    replayed: z.boolean(),
  })
  .strict();

export const VectorProjectionStatusSchema = z
  .object({
    mode: VectorRuntimeModeSchema,
    epoch_id: CanonicalHashSchema.nullable(),
    registered_epochs: z.number().int().nonnegative(),
    scope_states: z.number().int().nonnegative(),
    published_scopes: z.number().int().nonnegative(),
    pending_scopes: z.number().int().nonnegative(),
    degraded_scopes: z.number().int().nonnegative(),
    outbox_pending: z.number().int().nonnegative(),
    receipts: z.number().int().nonnegative(),
  })
  .strict();

export const MarkVectorRestoreDegradedInputSchema = z
  .object({
    restored_at: UtcTimestampSchema,
  })
  .strict();

export const MarkVectorRestoreDegradedResultSchema = z
  .object({
    updated_scopes: z.number().int().nonnegative(),
    job_ids: z.array(IdentifierSchema),
  })
  .strict();

export const RunVectorTemporalSweepInputSchema = z
  .object({
    as_of: UtcTimestampSchema,
    limit: z.number().int().min(1).max(10_000),
  })
  .strict();

export const RunVectorTemporalSweepResultSchema = z
  .object({
    checkpoints: z.array(VectorScopeCheckpointSchema),
    job_ids: z.array(IdentifierSchema),
    truncated: z.boolean(),
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
  "recovery_state",
  "recovery_effect",
  "install_recovery_checkpoint",
  "reconcile_recovery_effect",
  "health",
  "inspect_encryption_keys",
  "install_encryption_key",
  "verify_encryption_key",
  "reserve_secret_nonce",
  "commit_encrypted_secret",
  "begin_key_rotation",
  "get_key_rotation",
  "get_key_rotation_next",
  "consume_secret_use_authority",
  "replay_secret_purge",
  "get_secret_purge_target",
  "purge_encrypted_secret",
  "finalize_secret_purge",
  "finalize_purge_maintenance",
  "reserve_rotation_nonce",
  "commit_rotated_secret",
  "complete_key_rotation",
  "abort_key_rotation",
  "revoke_encryption_key",
  "governance_status",
  "count_content_references",
  "admit_memory",
  "apply_memory_revision",
  "preview_memory_revision",
  "get_memory_correction_basis",
  "preview_workbench_correction",
  "governance_replay",
  "memory_control_replay",
  "apply_memory_control",
  "preview_memory_control",
  "memory_delete_replay",
  "delete_memory",
  "preview_memory_delete",
  "inspect_purge_receipt",
  "run_purge",
  "complete_purge",
  "audit_purge_artifacts",
  "append_operator_action_receipt",
  "bind_operator_confirmation",
  "check_memory_eligibility",
  "get_governed_memory",
  "search_governed_memory",
  "list_workbench_memories",
  "get_workbench_memory_summaries",
  "get_workbench_memory_detail",
  "commit_episode",
  "drain_fts",
  "search_evidence",
  "prepare_operational_repair",
  "complete_operational_repair",
  "inspect_operational_repair",
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
  "get_projection_scope_frontier",
  "query_projections",
  "query_projection_page",
  "validate_projection_sources",
  "list_projection_sources",
  "traverse_relations",
  "enqueue_projection_job",
  "claim_projection_jobs",
  "fail_projection_job",
  "complete_projection_job",
  "invalidate_projection_descendants",
  "record_projection_rebuild",
  "get_graph_projection_checkpoint",
  "get_graph_scope_snapshot",
  "list_graph_projection_snapshots",
  "claim_graph_projection_jobs",
  "apply_graph_projection_job",
  "fail_graph_projection_job",
  "reset_graph_projection_scopes",
  "mark_graph_restore_unavailable",
  "graph_projection_status",
  "register_vector_embedding_epoch",
  "configure_vector_projection",
  "get_vector_projection_checkpoint",
  "claim_vector_projection_jobs",
  "apply_vector_projection_job",
  "fail_vector_projection_job",
  "stale_vector_projection_job",
  "mark_vector_restore_degraded",
  "run_vector_temporal_sweep",
  "vector_projection_status",
  "write_learning_ledger",
  "replay_learning_ledger",
  "read_learning_ledger",
  "test_block",
  "test_hold_write_lock",
  "close",
]);

export const RecoveryStorageStateSchema = z
  .object({
    root_id: IdentifierSchema,
    principal_id: IdentifierSchema,
    minimums: RecoveryMinimumsSchema,
    state_commitment_hash: CanonicalHashSchema,
  })
  .strict();

export const RecoveryProtectedEffectSchema =
  RecoveryPendingAuthorizationSchema;

export const ConfirmedKeyRotationWorkerOperationSchema = z.enum([
  "verify_encryption_key",
  "begin_key_rotation",
  "get_key_rotation_next",
  "reserve_rotation_nonce",
  "commit_rotated_secret",
  "complete_key_rotation",
]);
export const GovernedSecretAdmissionWorkerOperationSchema = z.enum([
  "verify_encryption_key",
  "reserve_secret_nonce",
  "commit_encrypted_secret",
]);

export const RecoveryEffectRecordSchema = z
  .object({
    pending_id: IdentifierSchema,
    operation: RecoveryPendingReservationSchema.shape.operation,
    idempotency_key: IdentifierSchema,
    request_hash: CanonicalHashSchema,
    prior_minimums_hash: CanonicalHashSchema,
    prior_state_commitment_hash: CanonicalHashSchema,
    prior_head_hash: CanonicalHashSchema.nullable(),
    committed_minimums: RecoveryMinimumsSchema,
    committed_state_commitment_hash: CanonicalHashSchema,
    root_id: IdentifierSchema,
    principal_id: IdentifierSchema,
    backup_manifest_hash: CanonicalHashSchema.nullable(),
    effect_receipt_hash: CanonicalHashSchema,
    state: z.enum(["effect_committed", "reconciled"]),
    anchor_hash: CanonicalHashSchema.nullable(),
  })
  .strict();

export const RecoveryEffectLookupSchema = z
  .object({ pending_id: IdentifierSchema })
  .strict();

export const WorkerRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    operation: WorkerOperationSchema,
    payload: z.unknown(),
    protected_effect: RecoveryProtectedEffectSchema.optional(),
    operator_authorization: z
      .enum([
        "confirmed_key_rotation",
        "governed_secret_admission",
      ])
      .optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.operator_authorization ===
        "confirmed_key_rotation" &&
      !ConfirmedKeyRotationWorkerOperationSchema.safeParse(
        request.operation,
      ).success
    ) {
      context.addIssue({
        code: "custom",
        path: ["operator_authorization"],
        message:
          "operator authorization is invalid for this worker operation",
      });
    }
    if (
      request.operator_authorization ===
        "governed_secret_admission" &&
      !GovernedSecretAdmissionWorkerOperationSchema.safeParse(
        request.operation,
      ).success
    ) {
      context.addIssue({
        code: "custom",
        path: ["operator_authorization"],
        message:
          "secret-admission authorization is invalid for this worker operation",
      });
    }
  });

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
export type BackupDraftResult = z.infer<typeof BackupDraftResultSchema>;
export type InstallEncryptionKeyCommand = z.input<
  typeof InstallEncryptionKeyCommandSchema
>;
export type VerifyEncryptionKeyCommand = z.input<
  typeof VerifyEncryptionKeyCommandSchema
>;
export type ReserveSecretNonceCommand = z.input<
  typeof ReserveSecretNonceCommandSchema
>;
export type ReserveSecretNonceResult = z.output<
  typeof ReserveSecretNonceResultSchema
>;
export type CommitEncryptedSecretCommand = z.input<
  typeof CommitEncryptedSecretCommandSchema
>;
export type BeginKeyRotationCommand = z.input<
  typeof BeginKeyRotationCommandSchema
>;
export type BeginKeyRotationResult = z.output<
  typeof BeginKeyRotationResultSchema
>;
export type KeyRotationNextResult = z.output<
  typeof KeyRotationNextResultSchema
>;
export type CommitRotatedSecretCommand = z.input<
  typeof CommitRotatedSecretCommandSchema
>;
export type CompleteKeyRotationResult = z.output<
  typeof CompleteKeyRotationResultSchema
>;
export type LearningContaminationEvent = z.infer<
  typeof LearningContaminationEventSchema
>;
export type LearningLedgerReadInput = z.input<
  typeof LearningLedgerReadInputSchema
>;
export type LearningLedgerReadResult = z.output<
  typeof LearningLedgerReadResultSchema
>;
export type LearningLedgerReplayInput = z.input<
  typeof LearningLedgerReplayInputSchema
>;
export type LearningLedgerReplayResult = z.output<
  typeof LearningLedgerReplayResultSchema
>;
export type LearningLedgerWriteCommand = z.input<
  typeof LearningLedgerWriteCommandSchema
>;
export type ParsedLearningLedgerWriteCommand = z.output<
  typeof LearningLedgerWriteCommandSchema
>;
export type LearningLedgerWriteResult = z.output<
  typeof LearningLedgerWriteResultSchema
>;
export type LearningPartitionSeal = z.infer<
  typeof LearningPartitionSealSchema
>;
export type LearningStorageFrontier = z.infer<
  typeof LearningStorageFrontierSchema
>;
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
export type ProjectionSourceEligibilityReason = z.infer<
  typeof ProjectionSourceEligibilityReasonSchema
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
export type ProjectionScopeFrontierInput = z.input<
  typeof ProjectionScopeFrontierInputSchema
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
export type GraphProjectionOutboxJob = z.infer<
  typeof GraphProjectionOutboxJobSchema
>;
export type GraphScopeInput = z.input<typeof GraphScopeInputSchema>;
export type ClaimGraphProjectionJobsInput = z.input<
  typeof ClaimGraphProjectionJobsInputSchema
>;
export type ClaimGraphProjectionJobsResult = z.infer<
  typeof ClaimGraphProjectionJobsResultSchema
>;
export type ApplyGraphProjectionJobCommand = z.input<
  typeof ApplyGraphProjectionJobCommandSchema
>;
export type FailGraphProjectionJobCommand = z.input<
  typeof FailGraphProjectionJobCommandSchema
>;
export type GraphProjectionJobResult = z.infer<
  typeof GraphProjectionJobResultSchema
>;
export type ResetGraphProjectionScopesInput = z.input<
  typeof ResetGraphProjectionScopesInputSchema
>;
export type ResetGraphProjectionScopesResult = z.infer<
  typeof ResetGraphProjectionScopesResultSchema
>;
export type MarkGraphRestoreUnavailableInput = z.input<
  typeof MarkGraphRestoreUnavailableInputSchema
>;
export type MarkGraphRestoreUnavailableResult = z.infer<
  typeof MarkGraphRestoreUnavailableResultSchema
>;
export type GraphProjectionStatus = z.infer<
  typeof GraphProjectionStatusSchema
>;
export type GraphScopeSnapshotResult = z.infer<
  typeof GraphScopeSnapshotResultSchema
>;
export type GraphProjectionSnapshotListInput = z.input<
  typeof GraphProjectionSnapshotListInputSchema
>;
export type GraphProjectionSnapshotListResult = z.infer<
  typeof GraphProjectionSnapshotListResultSchema
>;
export type RegisterVectorEmbeddingEpochCommand = z.input<
  typeof RegisterVectorEmbeddingEpochCommandSchema
>;
export type RegisterVectorEmbeddingEpochResult = z.infer<
  typeof RegisterVectorEmbeddingEpochResultSchema
>;
export type ConfigureVectorProjectionCommand = z.input<
  typeof ConfigureVectorProjectionCommandSchema
>;
export type ConfigureVectorProjectionResult = z.infer<
  typeof ConfigureVectorProjectionResultSchema
>;
export type VectorProjectionScopeInput = z.input<
  typeof VectorProjectionScopeInputSchema
>;
export type VectorProjectionOutboxJob = z.infer<
  typeof VectorProjectionOutboxJobSchema
>;
export type ClaimVectorProjectionJobsInput = z.input<
  typeof ClaimVectorProjectionJobsInputSchema
>;
export type ClaimVectorProjectionJobsResult = z.infer<
  typeof ClaimVectorProjectionJobsResultSchema
>;
export type ApplyVectorProjectionJobCommand = z.input<
  typeof ApplyVectorProjectionJobCommandSchema
>;
export type FailVectorProjectionJobCommand = z.input<
  typeof FailVectorProjectionJobCommandSchema
>;
export type StaleVectorProjectionJobCommand = z.input<
  typeof StaleVectorProjectionJobCommandSchema
>;
export type VectorProjectionJobResult = z.infer<
  typeof VectorProjectionJobResultSchema
>;
export type VectorProjectionStatus = z.infer<
  typeof VectorProjectionStatusSchema
>;
export type MarkVectorRestoreDegradedInput = z.input<
  typeof MarkVectorRestoreDegradedInputSchema
>;
export type MarkVectorRestoreDegradedResult = z.infer<
  typeof MarkVectorRestoreDegradedResultSchema
>;
export type RunVectorTemporalSweepInput = z.input<
  typeof RunVectorTemporalSweepInputSchema
>;
export type RunVectorTemporalSweepResult = z.infer<
  typeof RunVectorTemporalSweepResultSchema
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
export type PurgePhysicalMaintenance = z.infer<
  typeof PurgePhysicalMaintenanceSchema
>;
export type PurgePreparationResult = z.infer<
  typeof PurgePreparationResultSchema
>;
export type PurgeCompletionInput = z.infer<
  typeof PurgeCompletionInputSchema
>;
export type InspectPurgeReceiptInput = z.input<
  typeof InspectPurgeReceiptInputSchema
>;
export type InspectPurgeReceiptResult = z.infer<
  typeof InspectPurgeReceiptResultSchema
>;
export type AuditPurgeArtifactsInput = z.input<
  typeof AuditPurgeArtifactsInputSchema
>;
export type AuditPurgeArtifactsResult = z.infer<
  typeof AuditPurgeArtifactsResultSchema
>;
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
export type WorkbenchCorrectionStoragePreviewInput = z.input<
  typeof WorkbenchCorrectionStoragePreviewInputSchema
>;
export type ParsedWorkbenchCorrectionStoragePreviewInput = z.output<
  typeof WorkbenchCorrectionStoragePreviewInputSchema
>;
export type WorkbenchCorrectionStoragePreviewResult = z.infer<
  typeof WorkbenchCorrectionStoragePreviewResultSchema
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
export type OperationalRepairInput = z.input<
  typeof OperationalRepairInputSchema
>;
export type ParsedOperationalRepairInput = z.output<
  typeof OperationalRepairInputSchema
>;
export type OperationalRepairResult = z.infer<
  typeof OperationalRepairResultSchema
>;
export type InspectOperationalRepairInput = z.input<
  typeof InspectOperationalRepairInputSchema
>;
export type CompleteOperationalRepairInput = z.input<
  typeof CompleteOperationalRepairInputSchema
>;
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
export type WorkbenchMemoryListQuery = z.input<
  typeof WorkbenchMemoryListQuerySchema
>;
export type ParsedWorkbenchMemoryListQuery = z.output<
  typeof WorkbenchMemoryListQuerySchema
>;
export type WorkbenchMemoryCandidateSet = z.infer<
  typeof WorkbenchMemoryCandidateSetSchema
>;
export type WorkbenchMemorySummaryBatchQuery = z.input<
  typeof WorkbenchMemorySummaryBatchQuerySchema
>;
export type ParsedWorkbenchMemorySummaryBatchQuery = z.output<
  typeof WorkbenchMemorySummaryBatchQuerySchema
>;
export type WorkbenchMemorySummaryBatchResult = z.infer<
  typeof WorkbenchMemorySummaryBatchResultSchema
>;
export type WorkbenchMemoryDetailQuery = z.input<
  typeof WorkbenchMemoryDetailQuerySchema
>;
export type ParsedWorkbenchMemoryDetailQuery = z.output<
  typeof WorkbenchMemoryDetailQuerySchema
>;
export type WorkbenchMemoryDetailResult = z.infer<
  typeof WorkbenchMemoryDetailResultSchema
>;
export type StorageHealth = z.infer<typeof StorageHealthSchema>;
export type VerifyArtifactsResult = z.infer<typeof VerifyArtifactsResultSchema>;
export type RestoreVerificationResult = z.infer<
  typeof RestoreVerificationResultSchema
>;
export type RecoveryStorageState = z.infer<
  typeof RecoveryStorageStateSchema
>;
export type RecoveryProtectedEffect = z.infer<
  typeof RecoveryProtectedEffectSchema
>;
export type RecoveryEffectRecord = z.infer<
  typeof RecoveryEffectRecordSchema
>;
export type WorkerOperation = z.infer<typeof WorkerOperationSchema>;
export type WorkerResponse = z.infer<typeof WorkerResponseSchema>;
export type DurableEpisodeReceipt = z.infer<typeof MutationReceiptSchema>;
