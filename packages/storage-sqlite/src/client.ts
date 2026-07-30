import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID, verify } from "node:crypto";
import { fstatSync, readSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";

import {
  ArtifactPurgeAuditSchema,
  CanonicalHashSchema,
  IdentifierSchema,
  EncryptionKeyInventorySchema,
  EncryptionReceiptSchema,
  KeyRotationProgressSchema,
  GraphScopeCheckpointSchema,
  MutationReceiptSchema,
  OperationIntentSchema,
  OperatorActionReceiptSchema,
  OperatorConfirmationSchema,
  RootLeaseSchema,
  VectorScopeCheckpointSchema,
  canonicalJson,
  canonicalSha256,
  verifyOperatorConfirmationBinding,
  type GraphScopeCheckpoint,
  type ArtifactPurgeAudit,
  type CanonicalHash,
  type EncryptionKeyInventory,
  type EncryptionReceipt,
  type KeyRotationProgress,
  type RecoveryAnchor,
  type RecoveryPendingReservation,
  type OperatorActionReceipt,
  type OperationIntent,
  type OperatorConfirmation,
  type OperatorConfirmationTrust,
  type VectorScopeCheckpoint,
} from "@memo-graph/contracts";
import { z } from "zod";

import {
  inspectDataRoot,
  prepareDataRoot,
} from "./data-root.js";
import {
  AdmissionController,
  AdmissionObservationSchema,
  AdmissionPolicySchema,
  MaintenanceOperationSchema,
  observeStorageCapacity,
  type AdmissionObservation,
  type AdmissionPolicy,
} from "./admission-control.js";
import type { RecoveryHeadProvider } from "./anchor-coordinator.js";
import { recoveryMinimumsFromManifest } from "./backup-manifest.js";
import {
  StorageError,
  deserializeStorageError,
} from "./errors.js";
import type { OperationalMigrationFailurePoint } from "./migrations.js";
import { recoveryContentHash } from "./recovery-hash.js";
import {
  ApplyProjectionBatchCommandSchema,
  ApplyGraphProjectionJobCommandSchema,
  ApplyVectorProjectionJobCommandSchema,
  AuditPurgeArtifactsInputSchema,
  AdmitMemoryCommandSchema,
  BeginKeyRotationCommandSchema,
  BeginKeyRotationResultSchema,
  AuthorizedSecretUseResultSchema,
  AbortKeyRotationResultSchema,
  BackupDraftResultSchema,
  BackupResultSchema,
  BlockWorkerResultSchema,
  CheckpointResultSchema,
  ClaimProjectionJobsInputSchema,
  ClaimProjectionJobsResultSchema,
  ClaimGraphProjectionJobsInputSchema,
  ClaimGraphProjectionJobsResultSchema,
  ClaimVectorProjectionJobsInputSchema,
  ClaimVectorProjectionJobsResultSchema,
  CompleteProjectionJobCommandSchema,
  CommitEpisodeCommandSchema,
  CommitEncryptedSecretCommandSchema,
  CommitRotatedSecretCommandSchema,
  ConsumeSecretUseAuthorityCommandSchema,
  ContentReferenceCountsInputSchema,
  ContentReferenceCountsSchema,
  DrainFtsResultSchema,
  EnqueueProjectionJobCommandSchema,
  EvidenceExplanationResultSchema,
  EvidenceLookupInputSchema,
  EvidenceLookupResultSchema,
  GovernanceStorageStatusSchema,
  GovernedMemoryLookupInputSchema,
  GovernedMemoryLookupResultSchema,
  GovernedMemorySearchQuerySchema,
  GovernedMemorySearchResultSchema,
  GovernanceMutationResultSchema,
  GovernanceReplayInputSchema,
  GovernanceReplayResultSchema,
  FailProjectionJobCommandSchema,
  FailGraphProjectionJobCommandSchema,
  FailVectorProjectionJobCommandSchema,
  InvalidateProjectionDescendantsCommandSchema,
  InvalidateProjectionDescendantsResultSchema,
  InspectPurgeReceiptInputSchema,
  InspectPurgeReceiptResultSchema,
  InspectOperationalRepairInputSchema,
  InspectOperationalRepairResultSchema,
  CompleteOperationalRepairInputSchema,
  ConfirmedKeyRotationWorkerOperationSchema,
  InstallEncryptionKeyCommandSchema,
  KeyRotationInputSchema,
  KeyRotationNextResultSchema,
  LearningLedgerReadInputSchema,
  LearningLedgerReadResultSchema,
  LearningLedgerReplayInputSchema,
  LearningLedgerReplayResultSchema,
  LearningLedgerWriteCommandSchema,
  LearningLedgerWriteResultSchema,
  MemoryRevisionCommandSchema,
  MemoryEligibilityInputSchema,
  MemoryEligibilityResultSchema,
  MemoryControlCommandSchema,
  MemoryControlReplayResultSchema,
  MemoryControlResultSchema,
  MemoryCorrectionBasisInputSchema,
  MemoryCorrectionBasisResultSchema,
  MemoryDeleteCommandSchema,
  MemoryDeleteReplayResultSchema,
  MemoryDeleteResultSchema,
  PurgeRunInputSchema,
  PurgeRunResultSchema,
  OperationalRepairInputSchema,
  OperationalRepairResultSchema,
  OperatorConfirmationBindingSchema,
  PurgeEncryptedSecretCommandSchema,
  ProjectionBatchResultSchema,
  ProjectionJobMutationResultSchema,
  ProjectionPageQuerySchema,
  ProjectionPageResultSchema,
  ProjectionQueryResultSchema,
  ProjectionQuerySchema,
  ProjectionScopeFrontierInputSchema,
  ProjectionScopeStorageFrontierSchema,
  GraphScopeInputSchema,
  GraphScopeSnapshotResultSchema,
  GraphProjectionSnapshotListInputSchema,
  GraphProjectionSnapshotListResultSchema,
  GraphProjectionJobResultSchema,
  GraphProjectionStatusSchema,
  ConfigureVectorProjectionCommandSchema,
  ConfigureVectorProjectionResultSchema,
  ProjectionSourceBatchQuerySchema,
  ProjectionSourceBatchResultSchema,
  ProjectionSourceListInputSchema,
  ProjectionSourceListResultSchema,
  ProjectionRebuildReceiptSchema,
  MarkGraphRestoreUnavailableInputSchema,
  MarkGraphRestoreUnavailableResultSchema,
  MarkVectorRestoreDegradedInputSchema,
  MarkVectorRestoreDegradedResultSchema,
  ResetGraphProjectionScopesInputSchema,
  ResetGraphProjectionScopesResultSchema,
  RecordRecallCommandSchema,
  RecordRecallResultSchema,
  RecordProjectionRebuildResultSchema,
  RecoveryEffectRecordSchema,
  RecoveryStorageStateSchema,
  ReserveSecretNonceCommandSchema,
  ReserveSecretNonceResultSchema,
  RevokeEncryptionKeyCommandSchema,
  RevokeEncryptionKeyResultSchema,
  ReserveRotationNonceCommandSchema,
  RegisterVectorEmbeddingEpochCommandSchema,
  RegisterVectorEmbeddingEpochResultSchema,
  RelationTraversalInputSchema,
  RelationTraversalResultSchema,
  RebuildFtsResultSchema,
  ReceiptLookupInputSchema,
  ReplaySecretPurgeCommandSchema,
  ReplaySecretPurgeResultSchema,
  ReceiptLookupResultSchema,
  SearchEvidenceQuerySchema,
  SearchEvidenceResultSchema,
  SecretPurgeTargetInputSchema,
  SecretPurgeTargetSchema,
  StorageHealthSchema,
  RestoreVerificationResultSchema,
  CompleteKeyRotationResultSchema,
  RunVectorTemporalSweepInputSchema,
  RunVectorTemporalSweepResultSchema,
  StaleVectorProjectionJobCommandSchema,
  VerifyArtifactsResultSchema,
  VerifyEncryptionKeyCommandSchema,
  VectorProjectionJobResultSchema,
  VectorProjectionScopeInputSchema,
  VectorProjectionStatusSchema,
  WorkerResponseSchema,
  type BackupResult,
  type AuditPurgeArtifactsInput,
  type ApplyProjectionBatchCommand,
  type ApplyVectorProjectionJobCommand,
  type AdmitMemoryCommand,
  type BlockWorkerResult,
  type CheckpointResult,
  type ClaimProjectionJobsInput,
  type ClaimProjectionJobsResult,
  type ClaimGraphProjectionJobsInput,
  type ClaimGraphProjectionJobsResult,
  type ClaimVectorProjectionJobsInput,
  type ClaimVectorProjectionJobsResult,
  type CompleteProjectionJobCommand,
  type ContentReferenceCounts,
  type DrainFtsResult,
  type EnqueueProjectionJobCommand,
  type DurableEpisodeReceipt,
  type EvidenceExplanation,
  type GovernanceStorageStatus,
  type GovernanceMutationResult,
  type GovernedMemorySearchQuery,
  type GovernedMemorySearchResult,
  type GovernedMemoryLookupInput,
  type GovernedMemoryLookupResult,
  type GovernanceReplayInput,
  type FailProjectionJobCommand,
  type FailGraphProjectionJobCommand,
  type FailVectorProjectionJobCommand,
  type InvalidateProjectionDescendantsCommand,
  type InvalidateProjectionDescendantsResult,
  type LearningLedgerReadInput,
  type LearningLedgerReadResult,
  type LearningLedgerReplayInput,
  type LearningLedgerReplayResult,
  type LearningLedgerWriteCommand,
  type LearningLedgerWriteResult,
  type MemoryRevisionCommand,
  type MemoryEligibilityInput,
  type MemoryEligibilityResult,
  type MemoryControlCommand,
  type MemoryControlResult,
  type MemoryCorrectionBasis,
  type MemoryCorrectionBasisInput,
  type MemoryDeleteCommand,
  type MemoryDeleteResult,
  type InspectPurgeReceiptInput,
  type InspectOperationalRepairInput,
  type CompleteOperationalRepairInput,
  type PurgeRunInput,
  type PurgeRunResult,
  type OperationalRepairInput,
  type OperationalRepairResult,
  type ProjectionBatchResult,
  type ApplyGraphProjectionJobCommand,
  type GraphProjectionJobResult,
  type GraphProjectionStatus,
  type ConfigureVectorProjectionCommand,
  type ConfigureVectorProjectionResult,
  type GraphScopeInput,
  type GraphScopeSnapshotResult,
  type GraphProjectionSnapshotListInput,
  type GraphProjectionSnapshotListResult,
  type ProjectionJobMutationResult,
  type ProjectionPageQuery,
  type ProjectionPageResult,
  type ProjectionQuery,
  type ProjectionQueryResult,
  type ProjectionScopeFrontierInput,
  type ProjectionScopeStorageFrontier,
  type ProjectionSourceBatchQuery,
  type ProjectionSourceBatchResult,
  type ProjectionSourceListInput,
  type ProjectionSourceListResult,
  type ProjectionRebuildReceipt,
  type MarkGraphRestoreUnavailableInput,
  type MarkGraphRestoreUnavailableResult,
  type MarkVectorRestoreDegradedInput,
  type MarkVectorRestoreDegradedResult,
  type ResetGraphProjectionScopesInput,
  type ResetGraphProjectionScopesResult,
  type RecordRecallResult,
  type RecordProjectionRebuildResult,
  type RegisterVectorEmbeddingEpochCommand,
  type RegisterVectorEmbeddingEpochResult,
  type RelationTraversalInput,
  type RelationTraversalResult,
  type RebuildFtsResult,
  type RecoveryEffectRecord,
  type RecoveryProtectedEffect,
  type SearchEvidenceResult,
  type RestoreVerificationResult,
  type RunVectorTemporalSweepInput,
  type RunVectorTemporalSweepResult,
  type StaleVectorProjectionJobCommand,
  type VerifyArtifactsResult,
  type VectorProjectionJobResult,
  type VectorProjectionScopeInput,
  type VectorProjectionStatus,
  type WorkerOperation,
} from "./protocol.js";
import { RootWriterLease } from "./root-lease.js";
import {
  createSecretIngressCoordinator,
  type DarkLaunchAdmitSecretInput,
  type DarkLaunchBeginKeyRotationInput,
  type DarkLaunchInstallEncryptionKeyInput,
  type DarkLaunchPurgeSecretInput,
  type DarkLaunchRevokeEncryptionKeyInput,
  type DarkLaunchResumeKeyRotationInput,
  type SecretIngress,
} from "./secret-ingress.js";
import {
  WriterQueue,
  WriterQueueMetricsSchema,
  type WriterQueueMetrics,
} from "./writer-queue.js";

export type StorageDiagnostic = {
  operation: WorkerOperation;
  duration_ms: number;
  queue: WriterQueueMetrics;
  outcome: "ok" | "error";
  error_code?: string;
};

export type OperatorKeyRotationCapability = {
  purpose: "confirmed_operator_key_rotation";
  begin: () => Promise<{
    progress: KeyRotationProgress;
    receipt: EncryptionReceipt;
  }>;
  resume: () => Promise<KeyRotationProgress>;
};

function privateDescriptorDigest(descriptor: number): `sha256:${string}` {
  const stat = fstatSync(descriptor);
  const expectedOwner = process.getuid?.();
  if (
    !stat.isFile() ||
    stat.size !== 32 ||
    (stat.mode & 0o077) !== 0 ||
    (expectedOwner !== undefined && stat.uid !== expectedOwner)
  ) {
    throw new StorageError("KEY_PROVIDER_INVALID");
  }
  const bytes = Buffer.alloc(32);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(
      descriptor,
      bytes,
      offset,
      bytes.length - offset,
      offset,
    );
    if (count === 0) {
      bytes.fill(0);
      throw new StorageError("KEY_PROVIDER_INVALID");
    }
    offset += count;
  }
  try {
    return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  } finally {
    bytes.fill(0);
  }
}

export function operatorKeyRotationParameters(input: {
  begin: DarkLaunchBeginKeyRotationInput;
  resume: Omit<DarkLaunchResumeKeyRotationInput, "rotation_id">;
}) {
  const maxItems = input.resume.max_items ?? 100;
  const newKeyDigest = privateDescriptorDigest(
    input.begin.new_key_descriptor,
  );
  if (
    newKeyDigest !==
    privateDescriptorDigest(input.resume.new_key_descriptor)
  ) {
    throw new StorageError("KEY_PROVIDER_INVALID");
  }
  return {
    rotation_id: input.begin.rotation_id,
    new_key_id: input.begin.new_key_id,
    new_key_generation: input.begin.new_key_generation,
    new_authority_key_id: input.begin.new_authority_key_id,
    new_commitment_key_id: input.begin.new_commitment_key_id,
    max_items: maxItems,
    old_key_material_digest: privateDescriptorDigest(
      input.resume.old_key_descriptor,
    ),
    new_key_material_digest: newKeyDigest,
    old_authority_material_digest: privateDescriptorDigest(
      input.resume.old_authority_descriptor,
    ),
    new_authority_material_digest: privateDescriptorDigest(
      input.begin.new_authority_descriptor,
    ),
    new_commitment_material_digest: privateDescriptorDigest(
      input.begin.new_commitment_descriptor,
    ),
  };
}

export type SqliteStorageClientOptions = {
  dataRoot: string;
  migrationsDir?: string;
  busyTimeoutMs?: number;
  testOperations?: boolean;
  secretPrincipalId?: string;
  testFaults?: {
    exitAfterCommitBeforeResponseOnce?: boolean;
    encryptedArtifactExitAt?:
      | "after_prepare"
      | "after_file_commit";
    operationalMigrationExitAt?: OperationalMigrationFailurePoint;
    operationalRepairExitAfterPrepareOnce?: boolean;
  };
  onDiagnostic?: (diagnostic: StorageDiagnostic) => void;
  admission?: {
    policy?: AdmissionPolicy;
    observe?: () => AdmissionObservation;
  };
  recoveryHeadProvider?: RecoveryHeadProvider | null;
};

export const RecoveryAuthorityHealthSchema = z
  .object({
    configured: z.boolean(),
    state: z.enum(["ready", "blocked"]),
    current_generation: z.number().int().positive().nullable(),
    unresolved_pending_count: z.number().int().nonnegative(),
  })
  .strict();

export const StorageClientHealthSchema = StorageHealthSchema.extend({
  writer_queue: WriterQueueMetricsSchema,
  admission_policy: AdmissionPolicySchema.nullable(),
  admission_observation: AdmissionObservationSchema.nullable(),
  admission_read_only: z.boolean(),
  pressure_reason: z.enum(["disk", "wal"]).nullable(),
  root_lease: RootLeaseSchema.nullable(),
  checkpoint_counters: CheckpointResultSchema.extend({
    attempts: z.number().int().nonnegative(),
  }).strict(),
  recovery: RecoveryAuthorityHealthSchema,
}).strict();

export type StorageClientHealth = z.infer<
  typeof StorageClientHealthSchema
>;

export type StorageInspectionClient = Pick<
  SqliteStorageClient,
  "close" | "health" | "inspectEncryptionKeys"
>;

type PendingRequest = {
  operation: WorkerOperation;
  schema: z.ZodType;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  startedAt: number;
};

const NullSchema = z.null();

export class SqliteStorageClient {
  readonly #options: {
    dataRoot: string;
    migrationsDir: string;
    busyTimeoutMs: number;
    testOperations: boolean;
    inspectionOnly: boolean;
    secretPrincipalId: string | null;
    databasePath: string;
    onDiagnostic: ((diagnostic: StorageDiagnostic) => void) | undefined;
  };
  readonly #writerQueue: WriterQueue;
  readonly #admission: AdmissionController | undefined;
  readonly #rootLease: RootWriterLease | undefined;
  readonly #secretIngress: SecretIngress;
  readonly #recoveryHeadProvider: RecoveryHeadProvider | null;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #protectedInFlight = new Map<
    string,
    {
      requestHash: CanonicalHash;
      promise: Promise<unknown>;
    }
  >();
  #worker: Worker | undefined;
  #closed = false;
  #closing = false;
  #faultOnNextWorker = false;
  #encryptedArtifactFaultOnNextWorker:
    | "after_prepare"
    | "after_file_commit"
    | null = null;
  #operationalMigrationFaultOnNextWorker:
    | OperationalMigrationFailurePoint
    | null = null;
  #operationalRepairFaultAfterPrepare = false;
  #checkpointCounters: CheckpointResult & { attempts: number } = {
    busy: 0,
    log: 0,
    checkpointed: 0,
    attempts: 0,
  };
  readonly #operatorKeyRotationCapabilities = new Map<
    string,
    {
      intentHash: string;
      capability: OperatorKeyRotationCapability;
    }
  >();
  readonly #operatorAuthorization =
    new AsyncLocalStorage<"confirmed_key_rotation">();

  private constructor(
    options: SqliteStorageClientOptions & { inspectionOnly?: boolean },
  ) {
    const inspectionOnly = options.inspectionOnly ?? false;
    const layout = inspectionOnly
      ? inspectDataRoot(options.dataRoot)
      : prepareDataRoot(options.dataRoot);
    this.#options = {
      dataRoot: layout.root,
      databasePath: layout.database,
      migrationsDir:
        options.migrationsDir ??
        fileURLToPath(new URL("../../../migrations", import.meta.url)),
      busyTimeoutMs: options.busyTimeoutMs ?? 5_000,
      testOperations: options.testOperations ?? false,
      inspectionOnly,
      secretPrincipalId:
        options.secretPrincipalId === undefined
          ? null
          : IdentifierSchema.parse(options.secretPrincipalId),
      onDiagnostic: options.onDiagnostic,
    };
    this.#admission = inspectionOnly
      ? undefined
      : new AdmissionController({
          ...(options.admission?.policy === undefined
            ? {}
            : { policy: options.admission.policy }),
          observe:
            options.admission?.observe ??
            (() =>
              ({
                ...observeStorageCapacity({
                  dataRoot: layout.root,
                  databasePath: layout.database,
                }),
                checkpoint_healthy:
                  this.#checkpointCounters.busy === 0,
              })),
        });
    this.#rootLease = inspectionOnly
      ? undefined
      : RootWriterLease.acquire(layout.root);
    this.#writerQueue = new WriterQueue({
      admit: (stage, metrics, operation) => {
        this.#rootLease?.heartbeat();
        this.#admission?.assert(
          stage,
          metrics,
          MaintenanceOperationSchema.parse(operation),
        );
      },
    });
    this.#secretIngress = createSecretIngressCoordinator({
      installKey: (input) => {
        const command = InstallEncryptionKeyCommandSchema.parse(input);
        return this.#protectedRequest({
          workerOperation: "install_encryption_key",
          payload: command,
          resultSchema: EncryptionReceiptSchema,
          operation: "key",
          idempotencyKey: `install:${command.operation_id}`,
          requestHash: command.request_digest,
        });
      },
      inspectKeys: () =>
        this.#request(
          "inspect_encryption_keys",
          null,
          EncryptionKeyInventorySchema,
        ),
      verifyKey: async (input) => {
        await this.#request(
          "verify_encryption_key",
          VerifyEncryptionKeyCommandSchema.parse(input),
          NullSchema,
        );
      },
      reserve: (input) => {
        const command = ReserveSecretNonceCommandSchema.parse(input);
        return this.#protectedRequest({
          workerOperation: "reserve_secret_nonce",
          payload: command,
          resultSchema: ReserveSecretNonceResultSchema,
          operation: "key",
          idempotencyKey:
            `reserve:${command.operation_id}:${randomUUID()}`,
          requestHash: command.request_digest,
        });
      },
      commit: (input) => {
        const command = CommitEncryptedSecretCommandSchema.parse(input);
        return this.#protectedRequest({
          workerOperation: "commit_encrypted_secret",
          payload: command,
          resultSchema: EncryptionReceiptSchema,
          operation: "canonical",
          idempotencyKey: `commit:${command.operation_id}`,
          requestHash: command.request_digest,
        });
      },
      rootFenceToken: () => {
        const lease = this.#rootLease;
        if (lease === undefined) {
          throw new StorageError("STALE_ROOT_LEASE");
        }
        return lease.snapshot.fence_token;
      },
      beginRotation: (input) => {
        const command = BeginKeyRotationCommandSchema.parse(input);
        return this.#protectedRequest({
          workerOperation: "begin_key_rotation",
          payload: command,
          resultSchema: BeginKeyRotationResultSchema,
          operation: "key",
          idempotencyKey: `begin:${command.rotation_id}`,
          requestHash: command.request_digest,
        });
      },
      rotation: (rotationId) =>
        this.#request(
          "get_key_rotation",
          KeyRotationInputSchema.parse({ rotation_id: rotationId }),
          KeyRotationProgressSchema,
        ),
      rotationNext: (rotationId) =>
        this.#request(
          "get_key_rotation_next",
          KeyRotationInputSchema.parse({ rotation_id: rotationId }),
          KeyRotationNextResultSchema,
        ),
      consumeUseAuthority: (authorityInput) => {
        const authority =
          ConsumeSecretUseAuthorityCommandSchema.parse(authorityInput);
        return this.#protectedRequest({
          workerOperation: "consume_secret_use_authority",
          payload: authority,
          resultSchema: AuthorizedSecretUseResultSchema,
          operation: "key",
          idempotencyKey: authority.authority_id,
          requestHash: authority.authority_hash,
        });
      },
      reserveRotation: (input) => {
        const command = ReserveRotationNonceCommandSchema.parse(input);
        return this.#protectedRequest({
          workerOperation: "reserve_rotation_nonce",
          payload: command,
          resultSchema: ReserveSecretNonceResultSchema,
          operation: "key",
          idempotencyKey: `rotation-reserve:${command.operation_id}`,
          requestHash: command.request_digest,
        });
      },
      commitRotation: (input) => {
        const command = CommitRotatedSecretCommandSchema.parse(input);
        return this.#protectedRequest({
          workerOperation: "commit_rotated_secret",
          payload: command,
          resultSchema: EncryptionReceiptSchema,
          operation: "key",
          idempotencyKey: `rotation-commit:${command.operation_id}`,
          requestHash: command.request_digest,
        });
      },
      completeRotation: (rotationId) => {
        const command = KeyRotationInputSchema.parse({
          rotation_id: rotationId,
        });
        return this.#protectedRequest({
          workerOperation: "complete_key_rotation",
          payload: command,
          resultSchema: CompleteKeyRotationResultSchema,
          operation: "key",
          idempotencyKey: `complete:${command.rotation_id}`,
          requestHash: CanonicalHashSchema.parse(canonicalSha256(command)),
        });
      },
      abortRotation: (rotationId) => {
        const command = KeyRotationInputSchema.parse({
          rotation_id: rotationId,
        });
        return this.#protectedRequest({
          workerOperation: "abort_key_rotation",
          payload: command,
          resultSchema: AbortKeyRotationResultSchema,
          operation: "key",
          idempotencyKey: `abort:${command.rotation_id}`,
          requestHash: CanonicalHashSchema.parse(canonicalSha256(command)),
        });
      },
      revokeKey: (input) => {
        const command = RevokeEncryptionKeyCommandSchema.parse(input);
        return this.#protectedRequest({
          workerOperation: "revoke_encryption_key",
          payload: command,
          resultSchema: RevokeEncryptionKeyResultSchema,
          operation: "key",
          idempotencyKey: `revoke:${command.operation_id}`,
          requestHash: command.request_digest,
        });
      },
      replayPurge: (input) =>
        this.#request(
          "replay_secret_purge",
          ReplaySecretPurgeCommandSchema.parse(input),
          ReplaySecretPurgeResultSchema,
        ),
      purgeTarget: (owner) =>
        this.#request(
          "get_secret_purge_target",
          SecretPurgeTargetInputSchema.parse({ owner }),
          SecretPurgeTargetSchema,
        ),
      purge: async (input) => {
        const command = PurgeEncryptedSecretCommandSchema.parse(input);
        const receipt = await this.#protectedRequest({
          workerOperation: "purge_encrypted_secret",
          payload: command,
          resultSchema: EncryptionReceiptSchema,
          operation: "purge",
          idempotencyKey: `purge:${command.operation_id}`,
          requestHash: command.request_digest,
        });
        await this.#request("finalize_secret_purge", null, NullSchema);
        return receipt;
      },
    }, this.#options.secretPrincipalId);
    this.#faultOnNextWorker =
      options.testFaults?.exitAfterCommitBeforeResponseOnce ?? false;
    this.#encryptedArtifactFaultOnNextWorker =
      options.testFaults?.encryptedArtifactExitAt ?? null;
    this.#operationalMigrationFaultOnNextWorker =
      options.testFaults?.operationalMigrationExitAt ?? null;
    this.#operationalRepairFaultAfterPrepare =
      options.testFaults?.operationalRepairExitAfterPrepareOnce ?? false;
    this.#recoveryHeadProvider = options.recoveryHeadProvider ?? null;
  }

  static async open(
    options: SqliteStorageClientOptions,
  ): Promise<SqliteStorageClient> {
    const client = new SqliteStorageClient(options);
    try {
      await client.health();
      await client.#initializeRecoveryAuthority();
      return client;
    } catch (error) {
      await client.#abort();
      throw error;
    }
  }

  static async inspect(
    options: Omit<SqliteStorageClientOptions, "testFaults" | "testOperations">,
  ): Promise<StorageInspectionClient> {
    const client = new SqliteStorageClient({
      ...options,
      inspectionOnly: true,
    });
    try {
      await client.health();
      return client;
    } catch (error) {
      await client.#abort();
      throw error;
    }
  }

  async health(): Promise<StorageClientHealth> {
    this.#admission?.refresh();
    const result = await this.#request("health", null, StorageHealthSchema);
    const recoveryStorageState =
      this.#recoveryHeadProvider === null
        ? null
        : await this.#request(
            "recovery_state",
            null,
            RecoveryStorageStateSchema,
          ).catch(() => null);
    const recovery = (() => {
      const provider = this.#recoveryHeadProvider;
      if (provider === null) {
        return {
          configured: false,
          state: "blocked" as const,
          current_generation: null,
          unresolved_pending_count: 0,
        };
      }
      try {
        const current = provider.readCurrent();
        const unresolvedPendingCount =
          provider.unresolvedPending().length;
        const stateMatches =
          current !== null &&
          recoveryStorageState !== null &&
          current.payload.root_id === recoveryStorageState.root_id &&
          current.payload.principal_id ===
            recoveryStorageState.principal_id &&
          current.payload.state_commitment_hash ===
            recoveryStorageState.state_commitment_hash &&
          canonicalJson(current.payload.minimums) ===
            canonicalJson(recoveryStorageState.minimums);
        return {
          configured: true,
          state:
            stateMatches && unresolvedPendingCount === 0
              ? ("ready" as const)
              : ("blocked" as const),
          current_generation: current?.payload.generation ?? null,
          unresolved_pending_count: unresolvedPendingCount,
        };
      } catch {
        return {
          configured: true,
          state: "blocked" as const,
          current_generation: null,
          unresolved_pending_count: 0,
        };
      }
    })();
    return StorageClientHealthSchema.parse({
      ...result,
      writer_queue: this.#writerQueue.metrics(),
      admission_policy: this.#admission?.policy ?? null,
      admission_observation: this.#admission?.observation ?? null,
      admission_read_only: this.#admission?.readOnly ?? false,
      pressure_reason: this.#admission?.pressureReason ?? null,
      root_lease: this.#rootLease?.snapshot ?? null,
      checkpoint_counters: this.#checkpointCounters,
      recovery,
    });
  }

  inspectEncryptionKeys(): Promise<EncryptionKeyInventory> {
    return this.#request(
      "inspect_encryption_keys",
      null,
      EncryptionKeyInventorySchema,
    );
  }

  get recoveryHeadProvider(): RecoveryHeadProvider {
    if (this.#recoveryHeadProvider === null) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    return this.#recoveryHeadProvider;
  }

  async authorizeOperatorKeyRotation(input: {
    intent: OperationIntent;
    confirmation: OperatorConfirmation;
    trust: OperatorConfirmationTrust;
    now: string;
    begin: DarkLaunchBeginKeyRotationInput;
    resume: Omit<DarkLaunchResumeKeyRotationInput, "rotation_id">;
  }): Promise<OperatorKeyRotationCapability> {
    const intent = OperationIntentSchema.parse(input.intent);
    const parameters = operatorKeyRotationParameters(input);
    if (
      intent.command !== "key_rotate" ||
      intent.source_ref !== input.begin.rotation_id ||
      intent.target_ref !== input.begin.new_key_id ||
      intent.parameters_digest !== canonicalSha256(parameters)
    ) {
      throw new StorageError("INVALID_INPUT");
    }
    const parsedConfirmation =
      OperatorConfirmationSchema.parse(input.confirmation);
    const existing = this.#operatorKeyRotationCapabilities.get(
      parsedConfirmation.confirmation_id,
    );
    if (existing !== undefined) {
      if (existing.intentHash !== intent.intent_hash) {
        throw new StorageError("AUTHORITY_REPLAY");
      }
      return existing.capability;
    }
    const confirmation = verifyOperatorConfirmationBinding({
      ...input,
      verifySignature: ({ payload, signature, publicKeySpki }) =>
        verify(
          null,
          Buffer.from(payload, "utf8"),
          {
            key: Buffer.from(publicKeySpki, "base64url"),
            type: "spki",
            format: "der",
          },
          Buffer.from(signature, "base64url"),
        ),
    });
    await this.#writerQueue.enqueue(
      () =>
        this.#request(
          "bind_operator_confirmation",
          OperatorConfirmationBindingSchema.parse({
            confirmation_id: confirmation.confirmation_id,
            operation_id: intent.operation_id,
            intent_hash: intent.intent_hash,
            command: "key_rotate",
            parameters_digest: intent.parameters_digest,
            created_at: confirmation.issued_at,
          }),
          OperatorConfirmationBindingSchema,
        ),
      "operator_action",
    );
    const resumeInput = {
      ...input.resume,
      rotation_id: input.begin.rotation_id,
      max_items: input.resume.max_items ?? 100,
    };
    const capability = Object.freeze({
      purpose: "confirmed_operator_key_rotation" as const,
      begin: () =>
        this.#writerQueue.enqueue(
          () =>
            this.#operatorAuthorization.run(
              "confirmed_key_rotation",
              () => this.#secretIngress.beginRotation(input.begin),
            ),
          "key_rotation",
        ),
      resume: () =>
        this.#writerQueue.enqueue(
          () =>
            this.#operatorAuthorization.run(
              "confirmed_key_rotation",
              () => this.#secretIngress.resumeRotation(resumeInput),
            ),
          "key_rotation",
        ),
    });
    this.#operatorKeyRotationCapabilities.set(
      confirmation.confirmation_id,
      { intentHash: intent.intent_hash, capability },
    );
    return capability;
  }

  darkLaunchInstallEncryptionKey(
    input: DarkLaunchInstallEncryptionKeyInput,
  ): Promise<EncryptionReceipt> {
    if (!this.#options.testOperations) {
      return Promise.reject(new StorageError("ENCRYPTION_REQUIRED"));
    }
    return this.#writerQueue.enqueue(
      () => this.#secretIngress.installKey(input),
      "key_rotation",
    );
  }

  darkLaunchAdmitSecret(
    input: DarkLaunchAdmitSecretInput,
  ): Promise<EncryptionReceipt> {
    if (!this.#options.testOperations) {
      return Promise.reject(new StorageError("ENCRYPTION_REQUIRED"));
    }
    return this.#coalesceProtected(
      `dark_launch_admit_secret:${input.idempotency_key}`,
      recoveryContentHash(input),
      () =>
        this.#writerQueue.enqueue(
          () => this.#secretIngress.admit(input),
          "secret_write",
        ),
    );
  }

  darkLaunchBeginKeyRotation(
    input: DarkLaunchBeginKeyRotationInput,
  ): Promise<{ progress: KeyRotationProgress; receipt: EncryptionReceipt }> {
    if (!this.#options.testOperations) {
      return Promise.reject(new StorageError("ENCRYPTION_REQUIRED"));
    }
    return this.#writerQueue.enqueue(
      () => this.#secretIngress.beginRotation(input),
      "key_rotation",
    );
  }

  darkLaunchResumeKeyRotation(
    input: DarkLaunchResumeKeyRotationInput,
  ): Promise<KeyRotationProgress> {
    if (!this.#options.testOperations) {
      return Promise.reject(new StorageError("ENCRYPTION_REQUIRED"));
    }
    return this.#writerQueue.enqueue(
      () => this.#secretIngress.resumeRotation(input),
      "key_rotation",
    );
  }


  darkLaunchAbortKeyRotation(
    rotationId: string,
  ): Promise<{
    progress: KeyRotationProgress;
    receipt: EncryptionReceipt;
  }> {
    if (!this.#options.testOperations) {
      return Promise.reject(new StorageError("ENCRYPTION_REQUIRED"));
    }
    return this.#writerQueue.enqueue(
      () => this.#secretIngress.abortRotation(rotationId),
      "key_rotation",
    );
  }

  darkLaunchRevokeEncryptionKey(
    input: DarkLaunchRevokeEncryptionKeyInput,
  ): Promise<{
    inventory: EncryptionKeyInventory;
    receipt: EncryptionReceipt;
  }> {
    if (!this.#options.testOperations) {
      return Promise.reject(new StorageError("ENCRYPTION_REQUIRED"));
    }
    return this.#writerQueue.enqueue(
      () => this.#secretIngress.revokeKey(input),
      "key_rotation",
    );
  }

  darkLaunchPurgeSecret(
    input: DarkLaunchPurgeSecretInput,
  ): Promise<EncryptionReceipt> {
    if (!this.#options.testOperations) {
      return Promise.reject(new StorageError("ENCRYPTION_REQUIRED"));
    }
    return this.#writerQueue.enqueue(
      () => this.#secretIngress.purge(input),
      "purge_retry",
    );
  }

  governanceStatus(): Promise<GovernanceStorageStatus> {
    return this.#request(
      "governance_status",
      null,
      GovernanceStorageStatusSchema,
    );
  }

  contentReferenceCounts(input: unknown): Promise<ContentReferenceCounts> {
    const query = ContentReferenceCountsInputSchema.parse(input);
    return this.#request(
      "count_content_references",
      query,
      ContentReferenceCountsSchema,
    );
  }

  applyProjectionBatch(
    input: ApplyProjectionBatchCommand,
  ): Promise<ProjectionBatchResult> {
    const command = ApplyProjectionBatchCommandSchema.parse(input);
    return this.#protectedMutation(
      "apply_projection_batch",
      command,
      ProjectionBatchResultSchema,
      "projection",
    );
  }

  projectionScopeFrontier(
    input: ProjectionScopeFrontierInput,
  ): Promise<ProjectionScopeStorageFrontier> {
    const query = ProjectionScopeFrontierInputSchema.parse(input);
    return this.#request(
      "get_projection_scope_frontier",
      query,
      ProjectionScopeStorageFrontierSchema,
    );
  }

  queryProjections(input: ProjectionQuery): Promise<ProjectionQueryResult> {
    const query = ProjectionQuerySchema.parse(input);
    return this.#request(
      "query_projections",
      query,
      ProjectionQueryResultSchema,
    );
  }

  queryProjectionPage(
    input: ProjectionPageQuery,
  ): Promise<ProjectionPageResult> {
    const query = ProjectionPageQuerySchema.parse(input);
    return this.#request(
      "query_projection_page",
      query,
      ProjectionPageResultSchema,
    );
  }

  validateProjectionSources(
    input: ProjectionSourceBatchQuery,
  ): Promise<ProjectionSourceBatchResult> {
    const query = ProjectionSourceBatchQuerySchema.parse(input);
    return this.#request(
      "validate_projection_sources",
      query,
      ProjectionSourceBatchResultSchema,
    );
  }

  listProjectionSources(
    input: ProjectionSourceListInput,
  ): Promise<ProjectionSourceListResult> {
    const query = ProjectionSourceListInputSchema.parse(input);
    return this.#request(
      "list_projection_sources",
      query,
      ProjectionSourceListResultSchema,
    );
  }

  traverseRelations(
    input: RelationTraversalInput,
  ): Promise<RelationTraversalResult> {
    const query = RelationTraversalInputSchema.parse(input);
    return this.#request(
      "traverse_relations",
      query,
      RelationTraversalResultSchema,
    );
  }

  enqueueProjectionJob(
    input: EnqueueProjectionJobCommand,
  ): Promise<ProjectionJobMutationResult> {
    const command = EnqueueProjectionJobCommandSchema.parse(input);
    return this.#protectedMutation(
      "enqueue_projection_job",
      command,
      ProjectionJobMutationResultSchema,
      "projection",
    );
  }

  claimProjectionJobs(
    input: ClaimProjectionJobsInput,
  ): Promise<ClaimProjectionJobsResult> {
    const request = ClaimProjectionJobsInputSchema.parse(input);
    return this.#protectedMutation(
      "claim_projection_jobs",
      request,
      ClaimProjectionJobsResultSchema,
      "projection",
    );
  }

  failProjectionJob(
    input: FailProjectionJobCommand,
  ): Promise<ProjectionJobMutationResult> {
    const command = FailProjectionJobCommandSchema.parse(input);
    return this.#protectedMutation(
      "fail_projection_job",
      command,
      ProjectionJobMutationResultSchema,
      "projection",
    );
  }

  completeProjectionJob(
    input: CompleteProjectionJobCommand,
  ): Promise<ProjectionJobMutationResult> {
    const command = CompleteProjectionJobCommandSchema.parse(input);
    return this.#protectedMutation(
      "complete_projection_job",
      command,
      ProjectionJobMutationResultSchema,
      "projection",
    );
  }

  invalidateProjectionDescendants(
    input: InvalidateProjectionDescendantsCommand,
  ): Promise<InvalidateProjectionDescendantsResult> {
    const command =
      InvalidateProjectionDescendantsCommandSchema.parse(input);
    return this.#protectedMutation(
      "invalidate_projection_descendants",
      command,
      InvalidateProjectionDescendantsResultSchema,
      "projection",
    );
  }

  recordProjectionRebuild(
    input: ProjectionRebuildReceipt,
  ): Promise<RecordProjectionRebuildResult> {
    const receipt = ProjectionRebuildReceiptSchema.parse(input);
    return this.#protectedMutation(
      "record_projection_rebuild",
      receipt,
      RecordProjectionRebuildResultSchema,
      "projection",
    );
  }

  graphProjectionCheckpoint(
    input: GraphScopeInput,
  ): Promise<GraphScopeCheckpoint> {
    const request = GraphScopeInputSchema.parse(input);
    return this.#request(
      "get_graph_projection_checkpoint",
      request,
      GraphScopeCheckpointSchema,
    );
  }

  graphScopeSnapshot(
    input: GraphScopeInput,
  ): Promise<GraphScopeSnapshotResult> {
    const request = GraphScopeInputSchema.parse(input);
    return this.#request(
      "get_graph_scope_snapshot",
      request,
      GraphScopeSnapshotResultSchema,
    );
  }

  listGraphProjectionSnapshots(
    input: GraphProjectionSnapshotListInput = {},
  ): Promise<GraphProjectionSnapshotListResult> {
    const request = GraphProjectionSnapshotListInputSchema.parse(input);
    return this.#request(
      "list_graph_projection_snapshots",
      request,
      GraphProjectionSnapshotListResultSchema,
    );
  }

  claimGraphProjectionJobs(
    input: ClaimGraphProjectionJobsInput,
  ): Promise<ClaimGraphProjectionJobsResult> {
    const request = ClaimGraphProjectionJobsInputSchema.parse(input);
    return this.#protectedMutation(
      "claim_graph_projection_jobs",
      request,
      ClaimGraphProjectionJobsResultSchema,
      "projection",
    );
  }

  applyGraphProjectionJob(
    input: ApplyGraphProjectionJobCommand,
  ): Promise<GraphProjectionJobResult> {
    const command = ApplyGraphProjectionJobCommandSchema.parse(input);
    return this.#protectedMutation(
      "apply_graph_projection_job",
      command,
      GraphProjectionJobResultSchema,
      "projection",
    );
  }

  failGraphProjectionJob(
    input: FailGraphProjectionJobCommand,
  ): Promise<GraphProjectionJobResult> {
    const command = FailGraphProjectionJobCommandSchema.parse(input);
    return this.#protectedMutation(
      "fail_graph_projection_job",
      command,
      GraphProjectionJobResultSchema,
      "projection",
    );
  }

  resetGraphProjectionScopes(
    input: ResetGraphProjectionScopesInput,
  ): Promise<ResetGraphProjectionScopesResult> {
    const request = ResetGraphProjectionScopesInputSchema.parse(input);
    return this.#protectedMutation(
      "reset_graph_projection_scopes",
      request,
      ResetGraphProjectionScopesResultSchema,
      "projection",
    );
  }

  markGraphRestoreUnavailable(
    input: MarkGraphRestoreUnavailableInput,
  ): Promise<MarkGraphRestoreUnavailableResult> {
    const request = MarkGraphRestoreUnavailableInputSchema.parse(input);
    return this.#protectedMutation(
      "mark_graph_restore_unavailable",
      request,
      MarkGraphRestoreUnavailableResultSchema,
      "projection",
    );
  }

  graphProjectionStatus(): Promise<GraphProjectionStatus> {
    return this.#request(
      "graph_projection_status",
      null,
      GraphProjectionStatusSchema,
    );
  }

  registerVectorEmbeddingEpoch(
    input: RegisterVectorEmbeddingEpochCommand,
  ): Promise<RegisterVectorEmbeddingEpochResult> {
    const command = RegisterVectorEmbeddingEpochCommandSchema.parse(input);
    return this.#protectedMutation(
      "register_vector_embedding_epoch",
      command,
      RegisterVectorEmbeddingEpochResultSchema,
      "projection",
    );
  }

  configureVectorProjection(
    input: ConfigureVectorProjectionCommand,
  ): Promise<ConfigureVectorProjectionResult> {
    const command = ConfigureVectorProjectionCommandSchema.parse(input);
    return this.#protectedMutation(
      "configure_vector_projection",
      command,
      ConfigureVectorProjectionResultSchema,
      "projection",
    );
  }

  vectorProjectionCheckpoint(
    input: VectorProjectionScopeInput,
  ): Promise<VectorScopeCheckpoint> {
    const request = VectorProjectionScopeInputSchema.parse(input);
    return this.#request(
      "get_vector_projection_checkpoint",
      request,
      VectorScopeCheckpointSchema,
    );
  }

  claimVectorProjectionJobs(
    input: ClaimVectorProjectionJobsInput,
  ): Promise<ClaimVectorProjectionJobsResult> {
    const request = ClaimVectorProjectionJobsInputSchema.parse(input);
    return this.#protectedMutation(
      "claim_vector_projection_jobs",
      request,
      ClaimVectorProjectionJobsResultSchema,
      "projection",
    );
  }

  applyVectorProjectionJob(
    input: ApplyVectorProjectionJobCommand,
  ): Promise<VectorProjectionJobResult> {
    const command = ApplyVectorProjectionJobCommandSchema.parse(input);
    return this.#protectedMutation(
      "apply_vector_projection_job",
      command,
      VectorProjectionJobResultSchema,
      "projection",
    );
  }

  failVectorProjectionJob(
    input: FailVectorProjectionJobCommand,
  ): Promise<VectorProjectionJobResult> {
    const command = FailVectorProjectionJobCommandSchema.parse(input);
    return this.#protectedMutation(
      "fail_vector_projection_job",
      command,
      VectorProjectionJobResultSchema,
      "projection",
    );
  }

  staleVectorProjectionJob(
    input: StaleVectorProjectionJobCommand,
  ): Promise<VectorProjectionJobResult> {
    const command = StaleVectorProjectionJobCommandSchema.parse(input);
    return this.#protectedMutation(
      "stale_vector_projection_job",
      command,
      VectorProjectionJobResultSchema,
      "projection",
    );
  }

  markVectorRestoreDegraded(
    input: MarkVectorRestoreDegradedInput,
  ): Promise<MarkVectorRestoreDegradedResult> {
    const request = MarkVectorRestoreDegradedInputSchema.parse(input);
    return this.#protectedMutation(
      "mark_vector_restore_degraded",
      request,
      MarkVectorRestoreDegradedResultSchema,
      "projection",
    );
  }

  runVectorTemporalSweep(
    input: RunVectorTemporalSweepInput,
  ): Promise<RunVectorTemporalSweepResult> {
    const request = RunVectorTemporalSweepInputSchema.parse(input);
    return this.#protectedMutation(
      "run_vector_temporal_sweep",
      request,
      RunVectorTemporalSweepResultSchema,
      "projection",
    );
  }

  vectorProjectionStatus(): Promise<VectorProjectionStatus> {
    return this.#request(
      "vector_projection_status",
      null,
      VectorProjectionStatusSchema,
    );
  }

  writeLearningLedger(
    input: LearningLedgerWriteCommand,
  ): Promise<LearningLedgerWriteResult> {
    const command = LearningLedgerWriteCommandSchema.parse(input);
    return this.#protectedMutation(
      "write_learning_ledger",
      command,
      LearningLedgerWriteResultSchema,
      "learning",
    );
  }

  replayLearningLedger(
    input: LearningLedgerReplayInput,
  ): Promise<LearningLedgerReplayResult> {
    const request = LearningLedgerReplayInputSchema.parse(input);
    return this.#request(
      "replay_learning_ledger",
      request,
      LearningLedgerReplayResultSchema,
    );
  }

  readLearningLedger(
    input: LearningLedgerReadInput,
  ): Promise<LearningLedgerReadResult> {
    const request = LearningLedgerReadInputSchema.parse(input);
    return this.#request(
      "read_learning_ledger",
      request,
      LearningLedgerReadResultSchema,
    );
  }

  admitMemory(input: AdmitMemoryCommand): Promise<GovernanceMutationResult> {
    const command = AdmitMemoryCommandSchema.parse(input);
    return this.#protectedMutation(
      "admit_memory",
      command,
      GovernanceMutationResultSchema,
      "canonical",
    );
  }

  applyMemoryRevision(
    input: MemoryRevisionCommand,
  ): Promise<GovernanceMutationResult> {
    const command = MemoryRevisionCommandSchema.parse(input);
    if (command.dry_run) {
      return this.#previewMutation(
        "preview_memory_revision",
        command,
        GovernanceMutationResultSchema,
      );
    }
    return this.#protectedMutation(
      "apply_memory_revision",
      command,
      GovernanceMutationResultSchema,
      "canonical",
    );
  }

  getMemoryCorrectionBasis(
    input: MemoryCorrectionBasisInput,
  ): Promise<MemoryCorrectionBasis | null> {
    const request = MemoryCorrectionBasisInputSchema.parse(input);
    return this.#request(
      "get_memory_correction_basis",
      request,
      MemoryCorrectionBasisResultSchema,
    );
  }

  governanceReplay(
    input: GovernanceReplayInput,
  ): Promise<GovernanceMutationResult | null> {
    const request = GovernanceReplayInputSchema.parse(input);
    return this.#request(
      "governance_replay",
      request,
      GovernanceReplayResultSchema,
    );
  }

  memoryControlReplay(
    input: GovernanceReplayInput,
  ): Promise<MemoryControlResult | null> {
    const request = GovernanceReplayInputSchema.parse(input);
    return this.#request(
      "memory_control_replay",
      request,
      MemoryControlReplayResultSchema,
    );
  }

  applyMemoryControl(
    input: MemoryControlCommand,
  ): Promise<MemoryControlResult> {
    const command = MemoryControlCommandSchema.parse(input);
    if (command.request.envelope.dry_run) {
      return this.#previewMutation(
        "preview_memory_control",
        command,
        MemoryControlResultSchema,
      );
    }
    return this.#protectedMutation(
      "apply_memory_control",
      command,
      MemoryControlResultSchema,
      "control",
    );
  }

  memoryDeleteReplay(
    input: GovernanceReplayInput,
  ): Promise<MemoryDeleteResult | null> {
    const request = GovernanceReplayInputSchema.parse(input);
    return this.#request(
      "memory_delete_replay",
      request,
      MemoryDeleteReplayResultSchema,
    );
  }

  deleteMemory(input: MemoryDeleteCommand): Promise<MemoryDeleteResult> {
    const command = MemoryDeleteCommandSchema.parse(input);
    if (command.request.envelope.dry_run) {
      return this.#previewMutation(
        "preview_memory_delete",
        command,
        MemoryDeleteResultSchema,
      );
    }
    return this.#protectedMutation(
      "delete_memory",
      command,
      MemoryDeleteResultSchema,
      "purge",
    );
  }

  runPurge(input: PurgeRunInput): Promise<PurgeRunResult> {
    const request = PurgeRunInputSchema.parse(input);
    return this.#protectedMutation(
      "run_purge",
      request,
      PurgeRunResultSchema,
      "purge",
      "purge_retry",
    ).then(async (result) => {
      await this.#request(
        "finalize_purge_maintenance",
        null,
        NullSchema,
      );
      return result;
    });
  }

  inspectPurgeReceipt(
    input: InspectPurgeReceiptInput,
  ): Promise<PurgeRunResult | null> {
    const request = InspectPurgeReceiptInputSchema.parse(input);
    return this.#request(
      "inspect_purge_receipt",
      request,
      InspectPurgeReceiptResultSchema,
    );
  }

  auditPurgeArtifacts(
    input: AuditPurgeArtifactsInput,
  ): Promise<ArtifactPurgeAudit> {
    const request = AuditPurgeArtifactsInputSchema.parse(input);
    return this.#writerQueue.enqueue(
      () =>
        this.#request(
          "audit_purge_artifacts",
          request,
          ArtifactPurgeAuditSchema,
        ),
      "purge_audit",
    );
  }

  appendOperatorActionReceipt(
    input: OperatorActionReceipt,
  ): Promise<OperatorActionReceipt> {
    const receipt = OperatorActionReceiptSchema.parse(input);
    return this.#writerQueue.enqueue(
      () =>
        this.#request(
          "append_operator_action_receipt",
          receipt,
          OperatorActionReceiptSchema,
        ),
      "operator_action",
    );
  }

  checkMemoryEligibility(
    input: MemoryEligibilityInput,
  ): Promise<MemoryEligibilityResult> {
    const request = MemoryEligibilityInputSchema.parse(input);
    return this.#request(
      "check_memory_eligibility",
      request,
      MemoryEligibilityResultSchema,
    );
  }

  getGovernedMemory(
    input: GovernedMemoryLookupInput,
  ): Promise<GovernedMemoryLookupResult> {
    const request = GovernedMemoryLookupInputSchema.parse(input);
    return this.#request(
      "get_governed_memory",
      request,
      GovernedMemoryLookupResultSchema,
    );
  }

  searchGovernedMemory(
    input: GovernedMemorySearchQuery,
  ): Promise<GovernedMemorySearchResult> {
    const request = GovernedMemorySearchQuerySchema.parse(input);
    return this.#request(
      "search_governed_memory",
      request,
      GovernedMemorySearchResultSchema,
    );
  }

  commitEpisode(
    input: unknown,
  ): Promise<DurableEpisodeReceipt> {
    const command = CommitEpisodeCommandSchema.parse(input);
    return this.#protectedMutation(
      "commit_episode",
      command,
      MutationReceiptSchema,
      "canonical",
    );
  }

  drainFtsOutbox(): Promise<DrainFtsResult> {
    return this.#protectedMutation(
      "drain_fts",
      null,
      DrainFtsResultSchema,
      "projection",
    );
  }

  searchEvidence(input: unknown): Promise<SearchEvidenceResult> {
    const query = SearchEvidenceQuerySchema.parse(input);
    return this.#request(
      "search_evidence",
      query,
      SearchEvidenceResultSchema,
    );
  }

  rebuildFts(): Promise<RebuildFtsResult> {
    return this.#protectedMutation(
      "rebuild_fts",
      null,
      RebuildFtsResultSchema,
      "projection",
      "rebuild_fts",
    );
  }

  async repairFts(
    input: OperationalRepairInput,
  ): Promise<OperationalRepairResult> {
    const command = OperationalRepairInputSchema.parse(input);
    const prepared = await this.prepareOperationalRepair(command);
    if (prepared.state === "completed") {
      return prepared;
    }
    if (this.#operationalRepairFaultAfterPrepare) {
      this.#operationalRepairFaultAfterPrepare = false;
      throw new StorageError("STORAGE_UNAVAILABLE");
    }
    const rebuilt = await this.rebuildFts();
    return this.completeOperationalRepair({
      command,
      artifact_count: rebuilt.indexed,
      relation_count: 0,
      ledger_epoch: rebuilt.ledger_epoch,
    });
  }

  prepareOperationalRepair(
    input: OperationalRepairInput,
  ): Promise<OperationalRepairResult> {
    const command = OperationalRepairInputSchema.parse(input);
    const maintenanceOperation =
      command.repair_kind === "fts"
        ? "rebuild_fts"
        : command.repair_kind === "layered_projection"
          ? "rebuild_layered_projection"
          : "rebuild_sqlite_relations";
    return this.#protectedMutation(
      "prepare_operational_repair",
      command,
      OperationalRepairResultSchema,
      "projection",
      maintenanceOperation,
    );
  }

  completeOperationalRepair(
    input: CompleteOperationalRepairInput,
  ): Promise<OperationalRepairResult> {
    const command = CompleteOperationalRepairInputSchema.parse(input);
    const maintenanceOperation =
      command.command.repair_kind === "fts"
        ? "rebuild_fts"
        : command.command.repair_kind === "layered_projection"
          ? "rebuild_layered_projection"
          : "rebuild_sqlite_relations";
    return this.#protectedMutation(
      "complete_operational_repair",
      command,
      OperationalRepairResultSchema,
      "projection",
      maintenanceOperation,
    );
  }

  inspectOperationalRepair(
    input: InspectOperationalRepairInput,
  ): Promise<OperationalRepairResult | null> {
    const request = InspectOperationalRepairInputSchema.parse(input);
    return this.#request(
      "inspect_operational_repair",
      request,
      InspectOperationalRepairResultSchema,
    );
  }

  checkpoint(): Promise<CheckpointResult> {
    return this.#writerQueue.enqueue(
      async () => {
        let result: CheckpointResult;
        let attempts = 0;
        do {
          attempts += 1;
          result = await this.#request(
            "checkpoint",
            null,
            CheckpointResultSchema,
          );
        } while (result.busy > 0 && attempts < 3);
        this.#checkpointCounters = { ...result, attempts };
        return result;
      },
      "checkpoint",
    );
  }

  createBackup(): Promise<BackupResult> {
    return this.#writerQueue.enqueue(
      async () => {
        if (this.#recoveryHeadProvider === null) {
          throw new StorageError("RECOVERY_AUTHORITY_INVALID");
        }
        const draft = await this.#request(
          "backup",
          null,
          BackupDraftResultSchema,
        );
        const recoveryAnchor =
          this.#recoveryHeadProvider.issueBackupAnchor({
            manifest: draft.manifest,
            minimums: recoveryMinimumsFromManifest(draft.manifest),
          });
        await this.#request(
          "install_recovery_checkpoint",
          recoveryAnchor,
          NullSchema,
        );
        return BackupResultSchema.parse({
          ...draft,
          recovery_anchor: recoveryAnchor,
        });
      },
      "backup",
    );
  }

  verifyArtifacts(): Promise<VerifyArtifactsResult> {
    return this.#request(
      "verify_artifacts",
      null,
      VerifyArtifactsResultSchema,
    );
  }

  verifyRestoreCandidate(): Promise<RestoreVerificationResult> {
    return this.#request(
      "verify_restore_candidate",
      null,
      RestoreVerificationResultSchema,
    );
  }

  getEvidence(
    input: unknown,
  ): Promise<z.infer<typeof EvidenceLookupResultSchema>> {
    const request = EvidenceLookupInputSchema.parse(input);
    return this.#request(
      "get_evidence",
      request,
      EvidenceLookupResultSchema,
    );
  }

  explainEvidence(input: unknown): Promise<EvidenceExplanation | null> {
    const request = EvidenceLookupInputSchema.parse(input);
    return this.#request(
      "explain_evidence",
      request,
      EvidenceExplanationResultSchema,
    );
  }

  getReceipt(
    input: unknown,
  ): Promise<z.infer<typeof ReceiptLookupResultSchema>> {
    const request = ReceiptLookupInputSchema.parse(input);
    return this.#request(
      "get_receipt",
      request,
      ReceiptLookupResultSchema,
    );
  }

  recordRecall(input: unknown): Promise<RecordRecallResult> {
    const command = RecordRecallCommandSchema.parse(input);
    return this.#protectedMutation(
      "record_recall",
      command,
      RecordRecallResultSchema,
      "context",
    );
  }

  blockWorkerForTest(milliseconds: number): Promise<BlockWorkerResult> {
    if (!this.#options.testOperations) {
      return Promise.reject(new StorageError("INVALID_INPUT"));
    }
    return this.#request(
      "test_block",
      milliseconds,
      BlockWorkerResultSchema,
    );
  }

  holdWriteLockForTest(milliseconds: number): Promise<BlockWorkerResult> {
    if (!this.#options.testOperations) {
      return Promise.reject(new StorageError("INVALID_INPUT"));
    }
    return this.#request(
      "test_hold_write_lock",
      milliseconds,
      BlockWorkerResultSchema,
    );
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closing = true;
    try {
      const worker = this.#worker;
      if (worker !== undefined) {
        try {
          await this.#request("close", null, NullSchema);
        } catch (error) {
          if (
            !(error instanceof StorageError) ||
            error.code !== "WORKER_CRASHED"
          ) {
            throw error;
          }
        } finally {
          await worker.terminate();
        }
      }
    } finally {
      this.#worker = undefined;
      this.#closed = true;
      this.#closing = false;
      this.#rootLease?.release();
    }
  }

  async #initializeRecoveryAuthority(): Promise<void> {
    const provider = this.#recoveryHeadProvider;
    if (provider === null || this.#options.inspectionOnly) {
      return;
    }
    let state = await this.#request(
      "recovery_state",
      null,
      RecoveryStorageStateSchema,
    );
    let current = provider.readCurrent();
    const pendingAtOpen = provider.unresolvedPending();
    if (current === null) {
      current = provider.bootstrap(state);
      await this.#request(
        "install_recovery_checkpoint",
        current,
        NullSchema,
      );
    } else if (pendingAtOpen.length === 0) {
      await this.#request(
        "install_recovery_checkpoint",
        current,
        NullSchema,
      );
    }
    for (const pending of pendingAtOpen) {
      const effect = await this.#request(
        "recovery_effect",
        { pending_id: pending.pending_id },
        RecoveryEffectRecordSchema.nullable(),
      );
      if (effect === null) {
        if (pending.state !== "pending") {
          throw new StorageError("RECOVERY_AUTHORITY_INVALID");
        }
        provider.abort({
          pending_id: pending.pending_id,
          effect_provably_absent: true,
        });
        continue;
      }
      this.#assertRecoveryEffect(pending, effect);
      await this.#reconcileRecoveryEffect(pending, effect);
    }
    state = await this.#request(
      "recovery_state",
      null,
      RecoveryStorageStateSchema,
    );
    current = provider.readCurrent();
    if (
      current === null ||
      current.payload.root_id !== state.root_id ||
      current.payload.principal_id !== state.principal_id ||
      current.payload.state_commitment_hash !==
        state.state_commitment_hash ||
      canonicalJson(current.payload.minimums) !==
        canonicalJson(state.minimums)
    ) {
      throw new StorageError("STALE_RECOVERY_HEAD");
    }
  }

  #protectedRequest<T>(input: {
    workerOperation: WorkerOperation;
    payload: unknown;
    resultSchema: z.ZodType<T>;
    operation: RecoveryPendingReservation["operation"];
    idempotencyKey: string;
    requestHash: CanonicalHash;
  }): Promise<T> {
    const inFlightKey =
      `${input.workerOperation}:${input.idempotencyKey}`;
    return this.#coalesceProtected(
      inFlightKey,
      input.requestHash,
      () => this.#executeProtectedRequest(input),
    );
  }

  #coalesceProtected<T>(
    inFlightKey: string,
    requestHash: CanonicalHash,
    operation: () => Promise<T>,
  ): Promise<T> {
    const existing = this.#protectedInFlight.get(inFlightKey);
    if (existing !== undefined) {
      if (existing.requestHash !== requestHash) {
        return Promise.reject(new StorageError("CONFLICT"));
      }
      return existing.promise as Promise<T>;
    }
    const promise = operation();
    this.#protectedInFlight.set(inFlightKey, {
      requestHash,
      promise,
    });
    const clearInFlight = (): void => {
      if (
        this.#protectedInFlight.get(inFlightKey)?.promise === promise
      ) {
        this.#protectedInFlight.delete(inFlightKey);
      }
    };
    void promise.then(
      clearInFlight,
      clearInFlight,
    );
    return promise;
  }

  async #executeProtectedRequest<T>(input: {
    workerOperation: WorkerOperation;
    payload: unknown;
    resultSchema: z.ZodType<T>;
    operation: RecoveryPendingReservation["operation"];
    idempotencyKey: string;
    requestHash: CanonicalHash;
  }): Promise<T> {
    const provider = this.#recoveryHeadProvider;
    if (provider === null) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    const before = await this.#request(
      "recovery_state",
      null,
      RecoveryStorageStateSchema,
    );
    const authorization = provider.reserve({
      operation: input.operation,
      idempotency_key: input.idempotencyKey,
      request_hash: input.requestHash,
      prior_minimums: before.minimums,
      prior_state_commitment_hash: before.state_commitment_hash,
    });
    const protectedSchema = z
      .object({
        result: input.resultSchema,
        recovery_effect: RecoveryEffectRecordSchema,
      })
      .strict();
    try {
      const protectedResult = await this.#request(
        input.workerOperation,
        input.payload,
        protectedSchema,
        authorization,
      );
      if (
        recoveryContentHash(protectedResult.result) !==
          protectedResult.recovery_effect.effect_receipt_hash
      ) {
        throw new StorageError("RECOVERY_AUTHORITY_INVALID");
      }
      if (authorization.reservation.state === "pending") {
        await this.#reconcileRecoveryEffect(
          authorization.reservation,
          protectedResult.recovery_effect,
        );
      }
      return protectedResult.result;
    } catch (error) {
      const effect = await this.#request(
        "recovery_effect",
        { pending_id: authorization.reservation.pending_id },
        RecoveryEffectRecordSchema.nullable(),
      );
      if (effect === null) {
        if (authorization.reservation.state === "pending") {
          provider.abort({
            pending_id: authorization.reservation.pending_id,
            effect_provably_absent: true,
          });
        }
        throw error;
      }
      this.#assertRecoveryEffect(authorization.reservation, effect);
      if (authorization.reservation.state === "pending") {
        await this.#reconcileRecoveryEffect(
          authorization.reservation,
          effect,
        );
      }
      const replayState = await this.#request(
        "recovery_state",
        null,
        RecoveryStorageStateSchema,
      );
      const replayAuthorization = provider.reserve({
        operation: input.operation,
        idempotency_key: input.idempotencyKey,
        request_hash: input.requestHash,
        prior_minimums: replayState.minimums,
        prior_state_commitment_hash:
          replayState.state_commitment_hash,
      });
      const replay = await this.#request(
        input.workerOperation,
        input.payload,
        protectedSchema,
        replayAuthorization,
      );
      this.#assertRecoveryEffect(
        replayAuthorization.reservation,
        replay.recovery_effect,
      );
      if (
        recoveryContentHash(replay.result) !==
          replay.recovery_effect.effect_receipt_hash
      ) {
        throw new StorageError("RECOVERY_AUTHORITY_INVALID");
      }
      if (replayAuthorization.reservation.state === "pending") {
        await this.#reconcileRecoveryEffect(
          replayAuthorization.reservation,
          replay.recovery_effect,
        );
      }
      if (
        provider
          .unresolvedPending()
          .some(
            ({ pending_id: pendingId }) =>
              pendingId === replayAuthorization.reservation.pending_id,
          )
      ) {
        throw new StorageError("RECOVERY_AUTHORITY_INVALID");
      }
      return replay.result;
    }
  }

  #protectedMutation<T>(
    workerOperation: WorkerOperation,
    payload: unknown,
    resultSchema: z.ZodType<T>,
    operation: RecoveryPendingReservation["operation"],
    queueOperation = "canonical_write",
  ): Promise<T> {
    const requestHash = CanonicalHashSchema.parse(
      recoveryContentHash(payload),
    );
    const record =
      typeof payload === "object" && payload !== null
        ? payload as Record<string, unknown>
        : {};
    const nestedRecord = (
      value: unknown,
    ): Record<string, unknown> =>
      typeof value === "object" && value !== null
        ? value as Record<string, unknown>
        : {};
    const requestRecord = nestedRecord(record.request);
    const envelope = nestedRecord(record.envelope);
    const requestEnvelope = nestedRecord(requestRecord.envelope);
    const identityCandidates = (
      candidate: Record<string, unknown>,
    ): unknown[] => [
      candidate.idempotency_key,
      candidate.idempotencyKey,
      candidate.operation_id,
      candidate.operationId,
      candidate.request_id,
      candidate.requestId,
    ];
    const suppliedIdentity = [
      ...identityCandidates(record),
      ...identityCandidates(envelope),
      ...identityCandidates(requestEnvelope),
    ].find((value): value is string => typeof value === "string");
    const request = {
      workerOperation,
      payload,
      resultSchema,
      operation,
      idempotencyKey:
        suppliedIdentity === undefined
          ? `effect:${workerOperation}:${randomUUID()}`
          : `${workerOperation}:${suppliedIdentity}`,
      requestHash,
    };
    const inFlightKey =
      `${request.workerOperation}:${request.idempotencyKey}`;
    return this.#coalesceProtected(
      inFlightKey,
      requestHash,
      () =>
        this.#writerQueue.enqueue(
          () => this.#executeProtectedRequest(request),
          queueOperation,
        ),
    );
  }

  #previewMutation<T>(
    workerOperation: WorkerOperation,
    payload: unknown,
    resultSchema: z.ZodType<T>,
  ): Promise<T> {
    return this.#writerQueue.enqueue(
      () => this.#request(workerOperation, payload, resultSchema),
      "canonical_write",
    );
  }

  #assertRecoveryEffect(
    pending: RecoveryPendingReservation,
    effect: RecoveryEffectRecord,
  ): void {
    if (
      effect.pending_id !== pending.pending_id ||
      effect.operation !== pending.operation ||
      effect.idempotency_key !== pending.idempotency_key ||
      effect.request_hash !== pending.request_hash ||
      effect.prior_minimums_hash !==
        canonicalSha256(pending.prior_minimums) ||
      effect.prior_state_commitment_hash !==
        pending.prior_state_commitment_hash ||
      effect.prior_head_hash !== pending.prior_head_hash
    ) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
  }

  async #reconcileRecoveryEffect(
    pending: RecoveryPendingReservation,
    effect: RecoveryEffectRecord,
  ): Promise<RecoveryAnchor> {
    const provider = this.#recoveryHeadProvider;
    if (provider === null) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    const latest = provider
      .unresolvedPending()
      .find(({ pending_id: pendingId }) => pendingId === pending.pending_id);
    const state = latest?.state ?? "reconciled";
    const anchor =
      state === "pending"
        ? provider.commit({
            pending_id: pending.pending_id,
            backup_manifest_hash: effect.backup_manifest_hash,
            state_commitment_hash:
              effect.committed_state_commitment_hash,
            root_id: effect.root_id,
            principal_id: effect.principal_id,
            committed_minimums: effect.committed_minimums,
          })
        : (() => {
            const current = provider.readCurrent();
            if (
              current === null ||
              current.payload.previous_head_hash !==
                pending.prior_head_hash ||
              current.payload.state_commitment_hash !==
                effect.committed_state_commitment_hash
            ) {
              throw new StorageError("RECOVERY_AUTHORITY_INVALID");
            }
            return current;
          })();
    await this.#request(
      "reconcile_recovery_effect",
      { pending_id: pending.pending_id, anchor },
      RecoveryEffectRecordSchema,
    );
    if (state !== "reconciled") {
      provider.reconcile(pending.pending_id);
    }
    return anchor;
  }

  async #request<T>(
    operation: WorkerOperation,
    payload: unknown,
    schema: z.ZodType<T>,
    protectedEffect?: RecoveryProtectedEffect,
  ): Promise<T> {
    if (this.#closed || (this.#closing && operation !== "close")) {
      throw new StorageError("STORAGE_UNAVAILABLE");
    }
    const worker = this.#ensureWorker();
    const requestId = randomUUID();

    return new Promise<T>((resolve, reject) => {
      this.#pending.set(requestId, {
        operation,
        schema,
        resolve: (value) => resolve(value as T),
        reject,
        startedAt: performance.now(),
      });
      try {
        const operatorAuthorization =
          this.#operatorAuthorization.getStore() !== undefined &&
          ConfirmedKeyRotationWorkerOperationSchema.safeParse(
            operation,
          ).success
            ? ("confirmed_key_rotation" as const)
            : undefined;
        worker.postMessage({
          requestId,
          operation,
          payload,
          ...(protectedEffect === undefined
            ? {}
            : { protected_effect: protectedEffect }),
          ...(operatorAuthorization === undefined
            ? {}
            : { operator_authorization: operatorAuthorization }),
        });
      } catch {
        this.#pending.delete(requestId);
        reject(new StorageError("WORKER_CRASHED", { retryable: true }));
      }
    });
  }

  #ensureWorker(): Worker {
    if (this.#worker !== undefined) {
      return this.#worker;
    }
    const fault = this.#faultOnNextWorker;
    this.#faultOnNextWorker = false;
    const encryptedArtifactFault =
      this.#encryptedArtifactFaultOnNextWorker;
    this.#encryptedArtifactFaultOnNextWorker = null;
    const operationalMigrationFault =
      this.#operationalMigrationFaultOnNextWorker;
    this.#operationalMigrationFaultOnNextWorker = null;
    const worker = new Worker(new URL("./storage-worker.js", import.meta.url), {
      workerData: {
        dataRoot: this.#options.dataRoot,
        migrationsDir: this.#options.migrationsDir,
        busyTimeoutMs: this.#options.busyTimeoutMs,
        testOperations: this.#options.testOperations,
        secretPrincipalId: this.#options.secretPrincipalId,
        rootFenceToken:
          this.#rootLease?.snapshot.fence_token ?? null,
        inspectionOnly: this.#options.inspectionOnly,
        exitAfterCommitBeforeResponse: fault,
        encryptedArtifactExitAt: encryptedArtifactFault,
        operationalMigrationExitAt: operationalMigrationFault,
        recoveryAuthorityKeyId:
          this.#recoveryHeadProvider?.authorityKeyId ?? null,
        recoveryAuthorityPublicKeyDer:
          this.#recoveryHeadProvider === null
            ? null
            : this.#recoveryHeadProvider.publicKey
                .export({ format: "der", type: "spki" })
                .toString("base64url"),
      },
    });
    this.#worker = worker;

    worker.on("message", (message: unknown) => {
      const response = WorkerResponseSchema.safeParse(message);
      if (!response.success) {
        this.#rejectAll(new StorageError("WORKER_CRASHED", { retryable: true }));
        return;
      }
      const pending = this.#pending.get(response.data.requestId);
      if (pending === undefined) {
        return;
      }
      this.#pending.delete(response.data.requestId);

      if (!response.data.ok) {
        const error = deserializeStorageError(response.data.error);
        this.#emitDiagnostic(pending, "error", error.code);
        pending.reject(error);
        return;
      }

      const parsed = pending.schema.safeParse(response.data.result);
      if (!parsed.success) {
        const error = new StorageError("CORRUPTION");
        this.#emitDiagnostic(pending, "error", error.code);
        pending.reject(error);
        return;
      }
      this.#emitDiagnostic(pending, "ok");
      pending.resolve(parsed.data);
    });

    worker.on("error", () => {
      this.#rejectAll(new StorageError("WORKER_CRASHED", { retryable: true }));
    });
    worker.on("exit", () => {
      if (this.#worker === worker) {
        this.#worker = undefined;
      }
      if (!this.#closing) {
        this.#rejectAll(
          new StorageError("WORKER_CRASHED", { retryable: true }),
        );
      }
    });
    return worker;
  }

  #rejectAll(error: StorageError): void {
    for (const pending of this.#pending.values()) {
      this.#emitDiagnostic(pending, "error", error.code);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #emitDiagnostic(
    pending: PendingRequest,
    outcome: "ok" | "error",
    errorCode?: string,
  ): void {
    const diagnostic: StorageDiagnostic = {
      operation: pending.operation,
      duration_ms:
        Math.round((performance.now() - pending.startedAt) * 1_000) / 1_000,
      queue: this.#writerQueue.metrics(),
      outcome,
      ...(errorCode === undefined ? {} : { error_code: errorCode }),
    };
    try {
      this.#options.onDiagnostic?.(diagnostic);
    } catch {
      // Diagnostics are observational and cannot change storage outcomes.
    }
  }

  async #abort(): Promise<void> {
    this.#closing = true;
    try {
      if (this.#worker !== undefined) {
        await this.#worker.terminate();
      }
    } finally {
      this.#worker = undefined;
      this.#closed = true;
      this.#closing = false;
      this.#rootLease?.release();
    }
  }
}
