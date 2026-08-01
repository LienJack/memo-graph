import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

import {
  CandidateChangeSchema,
  CanonicalHashSchema,
  ContextSliceSchema,
  EpisodeSchema,
  EvidenceRecordSchema,
  OperatorActionReceiptSchema,
  MutationReceiptSchema,
  LearningControlSchema,
  LearningReleaseVersionSchema,
  LearningTraceSchema,
  IdentifierSchema,
  ProjectionRevisionSchema,
  RecallRequestSchema,
  ReceiptSchema,
  RecoveryMinimumsSchema,
  RetrievalReceiptSchema,
  ReleasePointerSchema,
  canonicalJson,
  canonicalSha256,
  canonicalSha256Omitting,
  receiptHashIsValid,
  sealReceipt,
  type SecretUseAuthority,
  type SecretAdmissionApproval,
  type G6ReleaseControl,
  type G6ReleaseControlTrust,
  type RuntimeIdentity,
  type SecretAdmissionTrust,
  type SecretContentOwner,
  type ArtifactPurgeAudit,
  type OperatorActionReceipt,
} from "@memo-graph/contracts";
import Database from "better-sqlite3";
import type { z } from "zod";

import { BlobStore, type StoredBlob } from "./blob-store.js";
import { recoveryStateCommitment } from "./anchor-coordinator.js";
import {
  ACCEPTED_RECOVERY_DECISIONS,
  backupDatabaseLogicalHash,
  rawFileHash,
  sealCompleteBackupManifest,
  withBackupDatabase,
  writeCompleteBackupManifest,
} from "./backup-manifest.js";
import { ControlRepository } from "./control-repository.js";
import type { DataRootLayout } from "./data-root.js";
import {
  EncryptedArtifactStore,
  type EncryptedArtifactFailurePoint,
} from "./encrypted-artifact-store.js";
import {
  EncryptedContentStore,
  type ReserveSecretInput,
  type ReserveSecretResult,
} from "./encrypted-content-store.js";
import { StorageError } from "./errors.js";
import { FtsIndex } from "./fts-index.js";
import { GovernanceRepository } from "./governance-repository.js";
import { GovernedMemoryReader } from "./governed-memory-reader.js";
import { GraphProjectionRepository } from "./graph-projection-repository.js";
import { LearningRepository } from "./learning-repository.js";
import { KeyRepository } from "./key-repository.js";
import {
  applyMigrations,
  type OperationalMigrationFailurePoint,
  verifyAppliedMigrations,
} from "./migrations.js";
import { ProjectionRepository } from "./projection-repository.js";
import {
  PurgeRepository,
  type PurgeFailurePoint,
} from "./purge-repository.js";
import { recoveryContentHash } from "./recovery-hash.js";
import { OperationalRepository } from "./operational-repository.js";
import { RelationRepository } from "./relation-repository.js";
import { VectorProjectionRepository } from "./vector-projection-repository.js";
import {
  ApplyVectorProjectionJobCommandSchema,
  AuditPurgeArtifactsInputSchema,
  ApplyProjectionBatchCommandSchema,
  ApplyGraphProjectionJobCommandSchema,
  AdmitMemoryCommandSchema,
  ClaimProjectionJobsInputSchema,
  ClaimGraphProjectionJobsInputSchema,
  ClaimVectorProjectionJobsInputSchema,
  ConfigureVectorProjectionCommandSchema,
  CompleteProjectionJobCommandSchema,
  CommitEpisodeCommandSchema,
  EnqueueProjectionJobCommandSchema,
  EvidenceExplanationSchema,
  EvidenceLookupInputSchema,
  GovernanceReplayInputSchema,
  GovernedMemoryLookupInputSchema,
  GovernedMemorySearchQuerySchema,
  MemoryEligibilityInputSchema,
  MemoryControlCommandSchema,
  MemoryCorrectionBasisInputSchema,
  MemoryDeleteCommandSchema,
  MemoryRevisionCommandSchema,
  FailProjectionJobCommandSchema,
  FailGraphProjectionJobCommandSchema,
  FailVectorProjectionJobCommandSchema,
  InvalidateProjectionDescendantsCommandSchema,
  InspectPurgeReceiptInputSchema,
  InspectOperationalRepairInputSchema,
  CompleteOperationalRepairInputSchema,
  OperationalRepairInputSchema,
  OperatorConfirmationBindingSchema,
  ProjectionPageQuerySchema,
  ProjectionQuerySchema,
  ProjectionScopeFrontierInputSchema,
  GraphScopeInputSchema,
  GraphProjectionSnapshotListInputSchema,
  ProjectionSourceBatchQuerySchema,
  ProjectionSourceListInputSchema,
  ProjectionRebuildReceiptSchema,
  MarkGraphRestoreUnavailableInputSchema,
  MarkVectorRestoreDegradedInputSchema,
  RegisterVectorEmbeddingEpochCommandSchema,
  ResetGraphProjectionScopesInputSchema,
  RunVectorTemporalSweepInputSchema,
  StaleVectorProjectionJobCommandSchema,
  VectorProjectionScopeInputSchema,
  PurgeCompletionInputSchema,
  PurgePhysicalMaintenanceSchema,
  PurgeRunInputSchema,
  RecordRecallCommandSchema,
  RelationTraversalInputSchema,
  LearningLedgerReadInputSchema,
  LearningLedgerReplayInputSchema,
  LearningLedgerWriteCommandSchema,
  ReceiptLookupInputSchema,
  RecoveryEffectRecordSchema,
  RecoveryStorageStateSchema,
  SearchEvidenceQuerySchema,
  type BackupDraftResult,
  type ClaimProjectionJobsResult,
  type ClaimGraphProjectionJobsResult,
  type CheckpointResult,
  type ContentReferenceCounts,
  type DrainFtsResult,
  type DurableEpisodeReceipt,
  type EvidenceExplanation,
  type MigrationEvidence,
  type InvalidateProjectionDescendantsResult,
  type GraphProjectionJobResult,
  type GraphProjectionStatus,
  type GraphProjectionSnapshotListResult,
  type GraphScopeSnapshotResult,
  type ParsedCommitEpisodeCommand,
  type ParsedRecordRecallCommand,
  type RecordRecallResult,
  type RebuildFtsResult,
  type OperationalRepairResult,
  type SearchEvidenceResult,
  type GovernanceStorageStatus,
  type GovernanceMutationResult,
  type GovernedMemorySearchResult,
  type GovernedMemoryLookupResult,
  type MemoryEligibilityResult,
  type MemoryControlResult,
  type MemoryCorrectionBasis,
  type MemoryDeleteResult,
  type PurgeRunResult,
  type PurgePreparationResult,
  type ProjectionBatchResult,
  type ProjectionJobMutationResult,
  type ProjectionPageResult,
  type ProjectionQueryResult,
  type ProjectionScopeStorageFrontier,
  type ProjectionSourceBatchResult,
  type ProjectionSourceListResult,
  type RecordProjectionRebuildResult,
  type ResetGraphProjectionScopesResult,
  type RelationTraversalResult,
  type LearningLedgerReadResult,
  type LearningLedgerReplayResult,
  type LearningLedgerWriteResult,
  type RestoreVerificationResult,
  type RecoveryEffectRecord,
  type RecoveryStorageState,
  type StorageHealth,
} from "./protocol.js";
import type {
  EncryptionKeyInventory,
  EncryptionReceipt,
  CanonicalHash,
  RecoveryAnchor,
  RecoveryMinimums,
  RecoveryPendingAuthorization,
} from "@memo-graph/contracts";

type ExistingIdempotency = {
  request_hash: string;
  receipt_json: string;
};

type CommitResult = {
  receipt: DurableEpisodeReceipt;
  committed: boolean;
};

type LatestReceipt = {
  receipt_hash: string;
} | undefined;

type RecoveryFrontierComponent =
  | "ledger"
  | "receipt"
  | "tombstone"
  | "purge"
  | "maintenance"
  | "fts"
  | "layered"
  | "relation"
  | "context"
  | "learning"
  | "encryption"
  | "release_control";

type RecoveryFrontierChange = {
  change_id: number;
  component: RecoveryFrontierComponent;
  table_name: string;
  row_key: string;
  operation: "insert" | "update" | "delete";
  old_row_json: string | null;
  new_row_json: string | null;
};

type RecoveryFrontierMetadata = {
  schema_version: "1.0.0";
  component_hashes: {
    purge: CanonicalHash;
    fts: CanonicalHash;
    layered: CanonicalHash;
    relation: CanonicalHash;
    context: CanonicalHash;
    learning: CanonicalHash;
    encryption: CanonicalHash;
  };
  latest_receipt: {
    resulting_epoch: number;
    receipt_id: string;
    receipt_hash: CanonicalHash;
  } | null;
  keys: Record<
    string,
    {
      key_id: RecoveryMinimums["required_keys"][number]["key_id"];
      key_generation: number;
      state: EncryptionKeyInventory["keys"][number]["state"];
    }
  >;
};

type RecoveryFrontierCache = {
  minimums: RecoveryMinimums;
  metadata: RecoveryFrontierMetadata;
  state_commitment_hash: CanonicalHash;
  last_change_id: number;
  initialized_at: string;
  updated_at: string;
  full_scan_count: number;
};

const MAX_RECOVERY_FRONTIER_CHANGES_PER_EFFECT = 20_000;
const MAX_RECOVERY_FRONTIER_HISTORY = 4_096;

type EvidenceRow = {
  evidence_id: string;
  sequence: number;
  occurred_at: string;
  recorded_at: string;
  scope_kind: string;
  scope_id: string;
  principal_id: string;
  actor_authority: string;
  source: string;
  authority: string;
  sensitivity: string;
  payload_storage: "inline" | "blob";
  payload_inline: string | null;
  payload_blob_hash: string | null;
  media_type: string;
  content_hash: string;
  schema_version: string;
  artifact_size_bytes: number | null;
};

type EpisodeRow = {
  episode_id: string;
  scope_kind: string;
  scope_id: string;
  started_at: string;
  ended_at: string;
  outcome: string;
  artifact_hashes_json: string;
  sealed_hash: string;
  schema_version: string;
};

type ExistingRecall = {
  request_id: string;
  principal_id: string;
  request_hash: string;
  request_json: string;
  receipt_json: string;
  slice_json: string | null;
};

type ParsedContextSlice = z.output<typeof ContextSliceSchema>;
type ParsedProjectionRevision = z.output<typeof ProjectionRevisionSchema>;
type ProjectionEligibility =
  | { status: "eligible"; projection: ParsedProjectionRevision }
  | { status: "changed" | "tombstoned" };

function now(): string {
  return new Date().toISOString();
}

function stableIdentifier(prefix: string, value: unknown): string {
  const digest = createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
  return `${prefix}:${digest.slice(0, 48)}`;
}

function sameScope(
  left: { kind: string; id: string },
  right: { kind: string; id: string },
): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function assertSetEqual(left: readonly string[], right: readonly string[]): void {
  if (
    left.length !== right.length ||
    [...left].sort().some((value, index) => value !== [...right].sort()[index])
  ) {
    throw new StorageError("INVALID_INPUT");
  }
}

function requestHash(
  command: ParsedCommitEpisodeCommand,
): `sha256:${string}` {
  const evidenceById = new Map(
    command.evidence.map((record) => [record.evidence_id, record]),
  );
  return canonicalSha256({
    episode: command.episode,
    evidence: command.episode.event_ids.map((evidenceId) =>
      evidenceById.get(evidenceId),
    ),
    blobs: command.blobs
      .map((blob) => ({
        content_hash: blob.content_hash,
        media_type: blob.media_type,
        size_bytes: blob.bytes.byteLength,
      }))
      .sort((left, right) =>
        left.content_hash.localeCompare(right.content_hash),
      ),
  });
}

function fsyncPath(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export class StorageDatabase {
  readonly #database: Database.Database;
  readonly #layout: DataRootLayout;
  readonly #migrations: MigrationEvidence[];
  readonly #blobStore: BlobStore;
  readonly #fts: FtsIndex;
  readonly #governance: GovernanceRepository;
  readonly #governedMemory: GovernedMemoryReader;
  readonly #control: ControlRepository;
  readonly #purge: PurgeRepository;
  readonly #graph: GraphProjectionRepository;
  readonly #vector: VectorProjectionRepository;
  readonly #projections: ProjectionRepository;
  readonly #relations: RelationRepository;
  readonly #learning: LearningRepository;
  readonly #operations: OperationalRepository;
  readonly #keys: KeyRepository;
  readonly #encryptedContent: EncryptedContentStore;
  readonly #encryptedArtifacts: EncryptedArtifactStore;
  readonly #journalMode: string;
  readonly #inspectionOnly: boolean;
  readonly #testOperations: boolean;
  readonly #busyTimeoutMs: number;
  readonly #principalId: string;

  constructor(options: {
    layout: DataRootLayout;
    migrationsDir: string;
    busyTimeoutMs: number;
    testOperations?: boolean;
    secretPrincipalId?: string | null;
    rootFenceToken?: number | null;
    inspectionOnly?: boolean;
    encryptedArtifactFault?: (
      point: EncryptedArtifactFailurePoint,
    ) => void;
    operationalMigrationFault?: (
      point: OperationalMigrationFailurePoint,
    ) => void;
    purgeFault?: (point: PurgeFailurePoint) => void;
    admissionTrust?: SecretAdmissionTrust | null;
    releaseVerification?: {
      trust: G6ReleaseControlTrust;
      runtimeIdentity: RuntimeIdentity;
    } | null;
  }) {
    this.#layout = options.layout;
    this.#principalId = options.secretPrincipalId ?? "principal_local_default";
    this.#inspectionOnly = options.inspectionOnly ?? false;
    this.#testOperations = options.testOperations ?? false;
    this.#busyTimeoutMs = options.busyTimeoutMs;
    const persistedBytes = this.#inspectionOnly
      ? readFileSync(options.layout.database)
      : undefined;
    const persistedWal =
      persistedBytes?.[18] === 2 && persistedBytes[19] === 2;
    const inspectionBytes =
      persistedBytes === undefined ? undefined : Buffer.from(persistedBytes);
    if (inspectionBytes !== undefined && persistedWal) {
      inspectionBytes[18] = 1;
      inspectionBytes[19] = 1;
    }
    this.#database = this.#inspectionOnly
      ? new Database(inspectionBytes)
      : new Database(options.layout.database);
    if (!this.#inspectionOnly) {
      chmodSync(options.layout.database, 0o600);
    }
    this.#database.pragma(`busy_timeout = ${options.busyTimeoutMs}`);
    this.#database.pragma("foreign_keys = ON");
    this.#database.pragma("trusted_schema = OFF");
    if (this.#inspectionOnly) {
      this.#database.pragma("secure_delete = ON");
      this.#database.pragma("query_only = ON");
      this.#journalMode = persistedWal ? "wal" : "delete";
    } else {
      this.#database.pragma("synchronous = FULL");
      this.#database.pragma("secure_delete = ON");
      this.#database.pragma("temp_store = MEMORY");
      this.#database.pragma("recursive_triggers = ON");
      this.#database.pragma("journal_size_limit = 67108864");
      this.#database.pragma("wal_autocheckpoint = 1000");
      this.#journalMode = String(
        this.#database.pragma("journal_mode = WAL", { simple: true }),
      ).toLowerCase();
    }
    if (this.#journalMode !== "wal") {
      this.#database.close();
      throw new StorageError("STORAGE_UNAVAILABLE");
    }
    this.#migrations = this.#inspectionOnly
      ? verifyAppliedMigrations(this.#database, options.migrationsDir)
      : applyMigrations(this.#database, options.migrationsDir, {
          ...(options.operationalMigrationFault === undefined
            ? {}
            : {
                operationalFailure:
                  options.operationalMigrationFault,
              }),
        });
    this.#blobStore = new BlobStore(options.layout.blobs);
    this.#fts = new FtsIndex(this.#database, {
      inspectionOnly: this.#inspectionOnly,
    });
    this.#governance = new GovernanceRepository(this.#database);
    this.#governedMemory = new GovernedMemoryReader(this.#database);
    this.#control = new ControlRepository(this.#database);
    this.#purge = new PurgeRepository(
      this.#database,
      this.#blobStore,
      options.purgeFault === undefined
        ? {}
        : { fault: options.purgeFault },
    );
    this.#graph = new GraphProjectionRepository(this.#database);
    this.#vector = new VectorProjectionRepository(this.#database);
    this.#projections = new ProjectionRepository(
      this.#database,
      this.#graph,
    );
    this.#relations = new RelationRepository(this.#database);
    this.#learning = new LearningRepository(this.#database, {
      allowTestOperations: options.testOperations ?? false,
      governance: this.#governance,
    });
    this.#operations = new OperationalRepository(this.#database);
    this.#keys = new KeyRepository(this.#database, this.#operations);
    this.#encryptedArtifacts = new EncryptedArtifactStore({
      database: this.#database,
      blobRoot: options.layout.blobs,
      inspectionOnly: this.#inspectionOnly,
      ...(options.encryptedArtifactFault === undefined
        ? {}
        : { fault: options.encryptedArtifactFault }),
    });
    this.#encryptedContent = new EncryptedContentStore(
      this.#database,
      this.#keys,
      this.#operations,
      this.#encryptedArtifacts,
      {
        principalId: options.secretPrincipalId ?? null,
        rootFenceToken: options.rootFenceToken ?? null,
        admissionTrust: options.admissionTrust ?? null,
        releaseVerification: options.releaseVerification ?? null,
      },
    );
    if (
      !this.#inspectionOnly &&
      this.#tableExists("encrypted_artifact_operations")
    ) {
      this.#reconcileBackupPurgeIntents();
      this.#encryptedArtifacts.reconcile();
    }
    if (this.#tableExists("recovery_frontier_cache")) {
      this.#initializeRecoveryFrontier();
    }
  }

  inspectEncryptionKeys(): EncryptionKeyInventory {
    return this.#keys.inventory();
  }

  installEncryptionKey(input: {
    operation_id: string;
    request_digest: CanonicalHash;
    key_id: string;
    key_generation: number;
    verification_tag: string;
    authority_key_id: string;
    authority_public_key_base64url: string;
    commitment_key_id: string;
    commitment_verification_tag: string;
    created_at: string;
  }): EncryptionReceipt {
    return this.#keys.installCurrent(input);
  }

  verifyEncryptionKey(input: {
    key_id: string;
    key_generation: number;
    verification_tag: string;
    forbidden_authority_public_keys?: readonly string[] | undefined;
  }): null {
    this.#keys.verifyProvider(input);
    return null;
  }

  reserveSecretNonce(input: ReserveSecretInput): ReserveSecretResult {
    return this.#encryptedContent.reserve(input);
  }

  commitEncryptedSecret(input: {
    operation_id: string;
    request_digest: CanonicalHash;
    payload: unknown;
    approval: SecretAdmissionApproval;
    release_control: G6ReleaseControl | null;
    validated_at: string;
  }): EncryptionReceipt {
    return this.#encryptedContent.commit(input);
  }

  beginKeyRotation(input: {
    rotation_id: string;
    request_digest: CanonicalHash;
    new_key_id: string;
    new_key_generation: number;
    new_verification_tag: string;
    new_authority_key_id: string;
    new_authority_public_key_base64url: string;
    new_commitment_key_id: string;
    new_commitment_verification_tag: string;
    started_at: string;
  }) {
    return this.#keys.beginRotation(input);
  }

  getKeyRotation(rotationId: string) {
    return this.#keys.rotation(rotationId);
  }

  getKeyRotationNext(rotationId: string) {
    return this.#encryptedContent.rotationNext(rotationId);
  }

  consumeSecretUseAuthority(authority: SecretUseAuthority) {
    return this.#encryptedContent.consumeUseAuthority(authority);
  }

  reserveRotationNonce(
    input: ReserveSecretInput & { rotation_id: string },
  ): ReserveSecretResult {
    return this.#encryptedContent.reserve(input);
  }

  commitRotatedSecret(input: {
    rotation_id: string;
    old_ciphertext_id: string;
    operation_id: string;
    request_digest: CanonicalHash;
    payload: unknown;
  }): EncryptionReceipt {
    const receipt = this.#encryptedContent.commit(input);
    this.#encryptedArtifacts.finalizeRetired();
    return receipt;
  }

  completeKeyRotation(rotationId: string) {
    return this.#keys.completeRotation(rotationId);
  }

  abortKeyRotation(rotationId: string) {
    return this.#keys.abortRotation(rotationId);
  }

  revokeEncryptionKey(input: {
    operation_id: string;
    request_digest: CanonicalHash;
    key_id: string;
    changed_at: string;
  }) {
    return this.#keys.revoke(input);
  }

  replaySecretPurge(input: {
    operation_id: string;
    request_digest: CanonicalHash;
  }): EncryptionReceipt | null {
    return this.#encryptedContent.replayPurge(
      input.operation_id,
      input.request_digest,
    );
  }

  getSecretPurgeTarget(owner: SecretContentOwner) {
    return this.#encryptedContent.purgeTarget(owner);
  }

  purgeEncryptedSecret(input: {
    operation_id: string;
    request_digest: CanonicalHash;
    authority: SecretUseAuthority;
  }): EncryptionReceipt {
    const replay = this.#encryptedContent.replayPurge(
      input.operation_id,
      input.request_digest,
    );
    if (replay !== null) {
      return replay;
    }
    const validatedAt = Date.now();
    this.#encryptedContent.validatePurgeAuthority(input, validatedAt);
    this.#registerSecretBackupPurgeIntents(input.authority.owner);
    const receipt = this.#encryptedContent.purge({
      ...input,
      validated_at: validatedAt,
    });
    return receipt;
  }

  finalizeSecretPurgeMaintenance(): void {
    if (!this.#tableExists("secret_purge_physical_maintenance")) {
      return;
    }
    const pending = Number(
      (
        this.#database
          .prepare(
            `SELECT count(*) AS count
             FROM secret_purge_physical_maintenance
             WHERE state = 'pending'`,
          )
          .get() as { count: number }
      ).count,
    );
    if (pending === 0) {
      return;
    }
    this.#reconcileBackupPurgeIntents();
    this.#encryptedArtifacts.finalizeRetired();
    this.finalizePurgeMaintenance();
    const completedAt = new Date().toISOString();
    const completed = this.#database
      .prepare(
        `UPDATE secret_purge_physical_maintenance
         SET state = 'completed', completed_at = ?
         WHERE state = 'pending'`,
      )
      .run(completedAt).changes;
    if (completed !== pending) {
      throw new StorageError("CORRUPTION");
    }
  }

  finalizePurgeMaintenance(): void {
    this.#database.exec("VACUUM");
    this.#database.pragma("wal_checkpoint(TRUNCATE)");
  }

  recoveryState(): RecoveryStorageState {
    if (!this.#tableExists("recovery_frontier_cache")) {
      return this.#legacyRecoveryState();
    }
    if (!this.#inspectionOnly) {
      this.#advanceRecoveryFrontier();
    }
    return this.#recoveryStateFromCache();
  }

  #legacyRecoveryState(): RecoveryStorageState {
    const identity = this.#recoveryRootIdentity();
    const purgeRows = this.#database
      .prepare(
        `SELECT store_id, tombstone_epoch, debt_count, frontier_hash,
                source_purge_job_id
         FROM artifact_purge_frontiers ORDER BY store_id`,
      )
      .all();
    const relationRows = this.#database
      .prepare(
        `SELECT relation_id, current_relation_revision_id, lifecycle
         FROM relation_objects ORDER BY relation_id`,
      )
      .all();
    const contextRows = this.#database
      .prepare(
        `SELECT context_slice_id, frozen_hash
         FROM context_slices ORDER BY context_slice_id`,
      )
      .all();
    const learning = this.#learning.frontier();
    const g6Control = this.#database
      .prepare("SELECT control_hash FROM g6_release_controls LIMIT 1")
      .get() as { control_hash: string } | undefined;
    const keys = this.#keys.inventory();
    const keyReceipts = this.#database
      .prepare(
        `SELECT operation_kind, operation_id, request_digest, receipt_hash
         FROM operational_receipts
         WHERE operation_kind LIKE 'key_%'
            OR operation_kind = 'secret_purge'
         ORDER BY created_at, receipt_id`,
      )
      .all();
    const keyStateRows = this.#database
      .prepare(
        `SELECT key_id, key_generation, state, authority_key_id,
                commitment_key_id, created_at, state_changed_at
         FROM encryption_keys ORDER BY key_generation, key_id`,
      )
      .all();
    const rotationRows = this.#database
      .prepare(
        `SELECT rotation_id, old_key_id, new_key_id, state,
                total_items, rewritten_items, request_digest,
                started_at, updated_at, completed_at, receipt_id
         FROM key_rotations ORDER BY started_at, rotation_id`,
      )
      .all();
    const liveCiphertextRows = this.#database
      .prepare(
        `SELECT c.key_id, count(DISTINCT c.ciphertext_id) AS value
         FROM encrypted_contents AS c
         JOIN encrypted_content_owners AS o
           ON o.ciphertext_id = c.ciphertext_id
         WHERE o.active = 1
         GROUP BY c.key_id`,
      )
      .all() as Array<{ key_id: string; value: number }>;
    const liveCiphertexts = new Map(
      liveCiphertextRows.map(({ key_id, value }) => [
        key_id,
        Number(value),
      ]),
    );
    const minimums = RecoveryMinimumsSchema.parse({
      ledger_epoch: this.#ledgerEpoch(),
      latest_receipt_hash: this.#latestReceipt()?.receipt_hash ?? null,
      tombstone_epoch: this.#purge.tombstoneEpoch(),
      purge_frontier_hash: canonicalSha256(purgeRows),
      projection_frontier_hash: canonicalSha256({
        fts: canonicalSha256({
          last_epoch: Number(this.#fts.state().last_epoch),
        }),
        layered: canonicalSha256(this.#projections.frontier()),
        relation: canonicalSha256(relationRows),
      }),
      context_frontier_hash: canonicalSha256(contextRows),
      learning_control_epoch: learning.control_epoch,
      learning_release_revision: learning.release_revision,
      learning_frontier_hash: learning.frontier_hash,
      required_keys: keys.keys
        .filter(
          ({ key_id, state }) =>
            state === "current" ||
            state === "rotating_to" ||
            state === "retired" ||
            (state === "revoked_or_compromised" &&
              (liveCiphertexts.get(key_id) ?? 0) > 0),
        )
        .map(({ key_id, generation, state }) => ({
          key_id,
          key_generation: generation,
          state,
        })),
      encryption_frontier_hash: canonicalSha256({
        keys: keyStateRows,
        rotations: rotationRows,
        receipts: keyReceipts,
        live_ciphertexts: keys.keys.map(({ key_id }) => ({
          key_id,
          live_ciphertext_count: liveCiphertexts.get(key_id) ?? 0,
        })),
      }),
      key_live_ciphertexts: keys.keys.map(({ key_id }) => ({
        key_id,
        live_ciphertext_count: liveCiphertexts.get(key_id) ?? 0,
      })),
      g6_release_control_hash: g6Control?.control_hash ?? null,
    });
    return RecoveryStorageStateSchema.parse({
      ...identity,
      minimums,
      state_commitment_hash: recoveryStateCommitment({
        ...identity,
        minimums,
      }),
    });
  }

  #initializeRecoveryFrontier(): void {
    const row = this.#database
      .prepare(
        `SELECT minimums_json FROM recovery_frontier_cache
         WHERE singleton = 1`,
      )
      .get() as { minimums_json: string | null } | undefined;
    if (row === undefined) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    if (row.minimums_json !== null) {
      const cache = this.#readRecoveryFrontierCache();
      const latestChangeId = this.#latestRecoveryFrontierChangeId();
      if (this.#inspectionOnly && latestChangeId !== cache.last_change_id) {
        throw new StorageError("RECOVERY_AUTHORITY_INVALID");
      }
      if (!this.#inspectionOnly) {
        this.#advanceRecoveryFrontier();
      }
      return;
    }
    if (this.#inspectionOnly) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }

    this.#database
      .transaction(() => {
        const state = this.#legacyRecoveryState();
        const fts = this.#fts.state();
        const relationRows = this.#database
          .prepare(
            `SELECT relation_id, current_relation_revision_id, lifecycle
             FROM relation_objects ORDER BY relation_id`,
          )
          .all();
        const inventory = this.#keys.inventory();
        const metadata: RecoveryFrontierMetadata = {
          schema_version: "1.0.0",
          component_hashes: {
            purge: state.minimums.purge_frontier_hash,
            fts: CanonicalHashSchema.parse(
              canonicalSha256({ last_epoch: Number(fts.last_epoch) }),
            ),
            layered: CanonicalHashSchema.parse(
              canonicalSha256(this.#projections.frontier()),
            ),
            relation: CanonicalHashSchema.parse(
              canonicalSha256(relationRows),
            ),
            context: state.minimums.context_frontier_hash,
            learning: state.minimums.learning_frontier_hash,
            encryption: state.minimums.encryption_frontier_hash,
          },
          latest_receipt: this.#latestRecoveryReceiptCursor(),
          keys: Object.fromEntries(
            inventory.keys.map(({ key_id, generation, state: keyState }) => [
              key_id,
              {
                key_id,
                key_generation: generation,
                state: keyState,
              },
            ]),
          ),
        };
        const timestamp = now();
        const lastChangeId = this.#latestRecoveryFrontierChangeId();
        const cache: RecoveryFrontierCache = {
          minimums: state.minimums,
          metadata,
          state_commitment_hash: state.state_commitment_hash,
          last_change_id: lastChangeId,
          initialized_at: timestamp,
          updated_at: timestamp,
          full_scan_count: 1,
        };
        const sourceRows = this.#recoveryFrontierSourceRows();
        const rowsHash = this.#recoveryFrontierRowsHash(sourceRows);

        this.#withRecoveryFrontierGuard(() => {
          const insertRow = this.#database.prepare(
            `INSERT INTO recovery_frontier_rows (
               component, table_name, row_key, row_json, row_hash
             ) VALUES (?, ?, ?, ?, ?)`,
          );
          for (const source of sourceRows) {
            insertRow.run(
              source.component,
              source.table_name,
              source.row_key,
              source.row_json,
              canonicalSha256(JSON.parse(source.row_json) as unknown),
            );
          }
          const seedHash = canonicalSha256({
            schema_version: "1.0.0",
            minimums: cache.minimums,
            metadata: cache.metadata,
            state_commitment_hash: cache.state_commitment_hash,
            last_change_id: cache.last_change_id,
            rows_hash: rowsHash,
            seeded_at: timestamp,
          });
          this.#database
            .prepare(
              `INSERT INTO recovery_frontier_seed (
                 singleton, minimums_json, metadata_json,
                 state_commitment_hash, last_change_id, rows_hash,
                 seed_hash, seeded_at
               ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              canonicalJson(cache.minimums),
              canonicalJson(cache.metadata),
              cache.state_commitment_hash,
              cache.last_change_id,
              rowsHash,
              seedHash,
              timestamp,
            );
          this.#writeRecoveryFrontierCache(cache);
          this.#compactRecoveryFrontierHistory(cache);
        });
      })
      .immediate();
  }

  #recoveryStateFromCache(): RecoveryStorageState {
    const cache = this.#readRecoveryFrontierCache();
    const identity = this.#recoveryRootIdentity();
    return RecoveryStorageStateSchema.parse({
      ...identity,
      minimums: cache.minimums,
      state_commitment_hash: cache.state_commitment_hash,
    });
  }

  #readRecoveryFrontierCache(): RecoveryFrontierCache {
    const row = this.#database
      .prepare(
        `SELECT schema_version, minimums_json, metadata_json,
                state_commitment_hash, last_change_id, cache_hash,
                initialized_at, updated_at, full_scan_count
         FROM recovery_frontier_cache WHERE singleton = 1`,
      )
      .get() as
      | {
          schema_version: string;
          minimums_json: string | null;
          metadata_json: string | null;
          state_commitment_hash: CanonicalHash | null;
          last_change_id: number;
          cache_hash: CanonicalHash | null;
          initialized_at: string | null;
          updated_at: string | null;
          full_scan_count: number;
        }
      | undefined;
    try {
      if (
        row === undefined ||
        row.schema_version !== "1.0.0" ||
        row.minimums_json === null ||
        row.metadata_json === null ||
        row.state_commitment_hash === null ||
        row.cache_hash === null ||
        row.initialized_at === null ||
        row.updated_at === null
      ) {
        throw new Error("uninitialized recovery frontier");
      }
      const minimums = RecoveryMinimumsSchema.parse(
        JSON.parse(row.minimums_json) as unknown,
      );
      const metadata = this.#parseRecoveryFrontierMetadata(
        JSON.parse(row.metadata_json) as unknown,
      );
      const cache: RecoveryFrontierCache = {
        minimums,
        metadata,
        state_commitment_hash: row.state_commitment_hash,
        last_change_id: Number(row.last_change_id),
        initialized_at: row.initialized_at,
        updated_at: row.updated_at,
        full_scan_count: Number(row.full_scan_count),
      };
      const identity = this.#recoveryRootIdentity();
      if (
        cache.state_commitment_hash !==
          recoveryStateCommitment({ ...identity, minimums }) ||
        row.cache_hash !== this.#recoveryFrontierCacheHash(cache) ||
        minimums.purge_frontier_hash !==
          metadata.component_hashes.purge ||
        minimums.context_frontier_hash !==
          metadata.component_hashes.context ||
        minimums.learning_frontier_hash !==
          metadata.component_hashes.learning ||
        minimums.encryption_frontier_hash !==
          metadata.component_hashes.encryption ||
        minimums.projection_frontier_hash !==
          this.#projectionRecoveryFrontierHash(metadata) ||
        minimums.latest_receipt_hash !==
          (metadata.latest_receipt?.receipt_hash ?? null)
      ) {
        throw new Error("recovery frontier seal mismatch");
      }
      return cache;
    } catch {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
  }

  #parseRecoveryFrontierMetadata(input: unknown): RecoveryFrontierMetadata {
    if (
      typeof input !== "object" ||
      input === null ||
      !("schema_version" in input) ||
      input.schema_version !== "1.0.0" ||
      !("component_hashes" in input) ||
      typeof input.component_hashes !== "object" ||
      input.component_hashes === null ||
      !("keys" in input) ||
      typeof input.keys !== "object" ||
      input.keys === null ||
      !("latest_receipt" in input)
    ) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    const metadata = input as RecoveryFrontierMetadata;
    const hashes = Object.values(metadata.component_hashes);
    if (
      hashes.length !== 7 ||
      hashes.some((hash) => !/^sha256:[0-9a-f]{64}$/u.test(hash)) ||
      (metadata.latest_receipt !== null &&
        (!Number.isSafeInteger(metadata.latest_receipt.resulting_epoch) ||
          metadata.latest_receipt.resulting_epoch < 0 ||
          !/^sha256:[0-9a-f]{64}$/u.test(
            metadata.latest_receipt.receipt_hash,
          )))
    ) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    return metadata;
  }

  #recoveryFrontierCacheHash(
    cache: RecoveryFrontierCache,
  ): CanonicalHash {
    return CanonicalHashSchema.parse(canonicalSha256({
      schema_version: "1.0.0",
      minimums: cache.minimums,
      metadata: cache.metadata,
      state_commitment_hash: cache.state_commitment_hash,
      last_change_id: cache.last_change_id,
      initialized_at: cache.initialized_at,
      updated_at: cache.updated_at,
      full_scan_count: cache.full_scan_count,
    }));
  }

  #writeRecoveryFrontierCache(cache: RecoveryFrontierCache): void {
    const changed = this.#database
      .prepare(
        `UPDATE recovery_frontier_cache
         SET minimums_json = ?, metadata_json = ?,
             state_commitment_hash = ?, last_change_id = ?, cache_hash = ?,
             initialized_at = ?, updated_at = ?, full_scan_count = ?
         WHERE singleton = 1`,
      )
      .run(
        canonicalJson(cache.minimums),
        canonicalJson(cache.metadata),
        cache.state_commitment_hash,
        cache.last_change_id,
        this.#recoveryFrontierCacheHash(cache),
        cache.initialized_at,
        cache.updated_at,
        cache.full_scan_count,
      ).changes;
    if (changed !== 1) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
  }

  #withRecoveryFrontierGuard<T>(effect: () => T): T {
    return this.#database
      .transaction(() => {
        const inserted = this.#database
          .prepare(
            `INSERT INTO recovery_frontier_write_guard (singleton, opened_at)
             VALUES (1, ?)`,
          )
          .run(now()).changes;
        if (inserted !== 1) {
          throw new StorageError("RECOVERY_AUTHORITY_INVALID");
        }
        const result = effect();
        const deleted = this.#database
          .prepare(
            `DELETE FROM recovery_frontier_write_guard
             WHERE singleton = 1`,
          )
          .run().changes;
        if (deleted !== 1) {
          throw new StorageError("RECOVERY_AUTHORITY_INVALID");
        }
        return result;
      })
      .immediate();
  }

  #assertNoPendingPurgeMaintenance(): void {
    const pending = [
      "purge_physical_maintenance",
      "purge_legacy_physical_maintenance",
      "secret_purge_physical_maintenance",
    ].reduce((count, table) => {
      if (!this.#tableExists(table)) {
        return count;
      }
      return count + Number(
        (
          this.#database
            .prepare(
              `SELECT count(*) AS count FROM ${table}
               WHERE state = 'pending'`,
            )
            .get() as { count: number }
        ).count,
      );
    }, 0);
    if (pending !== 0) {
      throw new StorageError("INCOMPLETE_PURGE");
    }
  }

  #latestRecoveryFrontierChangeId(): number {
    return Number(
      (
        this.#database
          .prepare(
            `SELECT max(value) AS value FROM (
               SELECT coalesce(max(change_id), 0) AS value
               FROM recovery_frontier_changes
               UNION ALL
               SELECT coalesce(last_change_id, 0) AS value
               FROM recovery_frontier_seed WHERE singleton = 1
             )`,
          )
          .get() as { value: number }
      ).value,
    );
  }

  #recoveryFrontierSourceRows(): Array<{
    component: RecoveryFrontierComponent;
    table_name: string;
    row_key: string;
    row_json: string;
  }> {
    return this.#database
      .prepare(
        `SELECT component, table_name, row_key, row_json
         FROM recovery_frontier_source_rows
         ORDER BY component, table_name, row_key`,
      )
      .all() as Array<{
      component: RecoveryFrontierComponent;
      table_name: string;
      row_key: string;
      row_json: string;
    }>;
  }

  #recoveryFrontierRowsHash(
    rows: ReadonlyArray<{
      component: RecoveryFrontierComponent;
      table_name: string;
      row_key: string;
      row_json: string;
    }>,
  ): CanonicalHash {
    return CanonicalHashSchema.parse(
      canonicalSha256(
        rows
          .map((row) => ({
            component: row.component,
            table_name: row.table_name,
            row_key: row.row_key,
            row: JSON.parse(row.row_json) as unknown,
          }))
          .sort(
            (left, right) =>
              left.component.localeCompare(right.component) ||
              left.table_name.localeCompare(right.table_name) ||
              left.row_key.localeCompare(right.row_key),
          ),
      ),
    );
  }

  #advanceRecoveryFrontier(): void {
    const cache = this.#readRecoveryFrontierCache();
    const changes = this.#database
      .prepare(
        `SELECT change_id, component, table_name, row_key, operation,
                old_row_json, new_row_json
         FROM recovery_frontier_changes
         WHERE change_id > ?
         ORDER BY change_id
         LIMIT ?`,
      )
      .all(
        cache.last_change_id,
        MAX_RECOVERY_FRONTIER_CHANGES_PER_EFFECT + 1,
      ) as RecoveryFrontierChange[];
    if (changes.length === 0) {
      return;
    }
    if (changes.length > MAX_RECOVERY_FRONTIER_CHANGES_PER_EFFECT) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }

    this.#withRecoveryFrontierGuard(() => {
      for (const change of changes) {
        this.#applyRecoveryFrontierRowChange(change);
        this.#applyRecoveryFrontierMinimumChange(cache, change);
        cache.last_change_id = Number(change.change_id);
      }
      const identity = this.#recoveryRootIdentity();
      cache.minimums = RecoveryMinimumsSchema.parse(cache.minimums);
      cache.state_commitment_hash = recoveryStateCommitment({
        ...identity,
        minimums: cache.minimums,
      });
      cache.updated_at = now();
      this.#writeRecoveryFrontierCache(cache);
      this.#compactRecoveryFrontierHistory(cache);
    });
  }

  #compactRecoveryFrontierHistory(cache: RecoveryFrontierCache): void {
    const historyCount = Number(
      (
        this.#database
          .prepare(
            `SELECT count(*) AS value FROM recovery_frontier_changes
             WHERE change_id <= ?`,
          )
          .get(cache.last_change_id) as { value: number }
      ).value,
    );
    if (historyCount <= MAX_RECOVERY_FRONTIER_HISTORY) {
      return;
    }
    const rows = this.#database
      .prepare(
        `SELECT component, table_name, row_key, row_json
         FROM recovery_frontier_rows
         ORDER BY component, table_name, row_key`,
      )
      .all() as Array<{
      component: RecoveryFrontierComponent;
      table_name: string;
      row_key: string;
      row_json: string;
    }>;
    const sourceRows = this.#recoveryFrontierSourceRows();
    const rowsHash = this.#recoveryFrontierRowsHash(rows);
    if (rowsHash !== this.#recoveryFrontierRowsHash(sourceRows)) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    const seededAt = now();
    const seedHash = canonicalSha256({
      schema_version: "1.0.0",
      minimums: cache.minimums,
      metadata: cache.metadata,
      state_commitment_hash: cache.state_commitment_hash,
      last_change_id: cache.last_change_id,
      rows_hash: rowsHash,
      seeded_at: seededAt,
    });
    const updated = this.#database
      .prepare(
        `UPDATE recovery_frontier_seed SET
           minimums_json = ?, metadata_json = ?, state_commitment_hash = ?,
           last_change_id = ?, rows_hash = ?, seed_hash = ?, seeded_at = ?
         WHERE singleton = 1`,
      )
      .run(
        canonicalJson(cache.minimums),
        canonicalJson(cache.metadata),
        cache.state_commitment_hash,
        cache.last_change_id,
        rowsHash,
        seedHash,
        seededAt,
      ).changes;
    if (updated !== 1) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    this.#database
      .prepare(
        `DELETE FROM recovery_frontier_changes WHERE change_id <= ?`,
      )
      .run(cache.last_change_id);
  }

  #applyRecoveryFrontierRowChange(change: RecoveryFrontierChange): void {
    const existing = this.#database
      .prepare(
        `SELECT row_json, row_hash FROM recovery_frontier_rows
         WHERE component = ? AND table_name = ? AND row_key = ?`,
      )
      .get(change.component, change.table_name, change.row_key) as
      | { row_json: string; row_hash: string }
      | undefined;
    const oldRow =
      change.old_row_json === null
        ? null
        : (JSON.parse(change.old_row_json) as unknown);
    const newRow =
      change.new_row_json === null
        ? null
        : (JSON.parse(change.new_row_json) as unknown);
    if (
      (oldRow === null && existing !== undefined) ||
      (oldRow !== null &&
        (existing === undefined ||
          existing.row_hash !== canonicalSha256(oldRow) ||
          canonicalJson(JSON.parse(existing.row_json) as unknown) !==
            canonicalJson(oldRow)))
    ) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    if (newRow === null) {
      const deleted = this.#database
        .prepare(
          `DELETE FROM recovery_frontier_rows
           WHERE component = ? AND table_name = ? AND row_key = ?`,
        )
        .run(change.component, change.table_name, change.row_key).changes;
      if (deleted !== 1) {
        throw new StorageError("RECOVERY_AUTHORITY_INVALID");
      }
      return;
    }
    this.#database
      .prepare(
        `INSERT INTO recovery_frontier_rows (
           component, table_name, row_key, row_json, row_hash
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(component, table_name, row_key) DO UPDATE SET
           row_json = excluded.row_json,
           row_hash = excluded.row_hash`,
      )
      .run(
        change.component,
        change.table_name,
        change.row_key,
        canonicalJson(newRow),
        canonicalSha256(newRow),
      );
  }

  #applyRecoveryFrontierMinimumChange(
    cache: RecoveryFrontierCache,
    change: RecoveryFrontierChange,
  ): void {
    const oldRow =
      change.old_row_json === null
        ? null
        : (JSON.parse(change.old_row_json) as Record<string, unknown>);
    const newRow =
      change.new_row_json === null
        ? null
        : (JSON.parse(change.new_row_json) as Record<string, unknown>);
    const hashKey =
      change.component === "purge" ||
      change.component === "fts" ||
      change.component === "layered" ||
      change.component === "relation" ||
      change.component === "context" ||
      change.component === "encryption"
        ? change.component
        : null;
    if (hashKey !== null) {
      cache.metadata.component_hashes[hashKey] = CanonicalHashSchema.parse(canonicalSha256({
        schema_version: "1.0.0",
        previous_hash: cache.metadata.component_hashes[hashKey],
        change: {
          change_id: Number(change.change_id),
          table_name: change.table_name,
          row_key: change.row_key,
          operation: change.operation,
          old_row_hash: oldRow === null ? null : canonicalSha256(oldRow),
          new_row_hash: newRow === null ? null : canonicalSha256(newRow),
        },
      }));
    }

    switch (change.component) {
      case "ledger": {
        if (newRow === null) {
          throw new StorageError("RECOVERY_AUTHORITY_INVALID");
        }
        cache.minimums.ledger_epoch = Number(newRow.ledger_epoch);
        break;
      }
      case "receipt": {
        if (newRow === null) {
          throw new StorageError("RECOVERY_AUTHORITY_INVALID");
        }
        const receiptJson = JSON.parse(String(newRow.receipt_json)) as {
          warnings?: unknown;
        };
        const warnings = Array.isArray(receiptJson.warnings)
          ? receiptJson.warnings
          : [];
        if (!warnings.includes("DRY_RUN")) {
          const candidate = {
            resulting_epoch: Number(newRow.resulting_epoch),
            receipt_id: String(newRow.receipt_id),
            receipt_hash: CanonicalHashSchema.parse(newRow.receipt_hash),
          };
          const previous = cache.metadata.latest_receipt;
          if (
            previous === null ||
            candidate.resulting_epoch > previous.resulting_epoch ||
            (candidate.resulting_epoch === previous.resulting_epoch &&
              candidate.receipt_id > previous.receipt_id)
          ) {
            cache.metadata.latest_receipt = candidate;
            cache.minimums.latest_receipt_hash = candidate.receipt_hash;
          }
        }
        break;
      }
      case "tombstone": {
        if (newRow === null) {
          throw new StorageError("RECOVERY_AUTHORITY_INVALID");
        }
        cache.minimums.tombstone_epoch = Number(
          newRow.tombstone_epoch,
        );
        break;
      }
      case "purge":
        cache.minimums.purge_frontier_hash =
          cache.metadata.component_hashes.purge;
        break;
      case "fts":
      case "layered":
      case "relation":
        cache.minimums.projection_frontier_hash =
          this.#projectionRecoveryFrontierHash(cache.metadata);
        break;
      case "context":
        cache.minimums.context_frontier_hash =
          cache.metadata.component_hashes.context;
        break;
      case "learning": {
        const learning = this.#learning.frontier();
        cache.minimums.learning_control_epoch = learning.control_epoch;
        cache.minimums.learning_release_revision =
          learning.release_revision;
        cache.metadata.component_hashes.learning =
          learning.frontier_hash;
        cache.minimums.learning_frontier_hash =
          learning.frontier_hash;
        break;
      }
      case "encryption":
        this.#applyEncryptionRecoveryMinimumChange(cache, change, oldRow, newRow);
        cache.minimums.encryption_frontier_hash =
          cache.metadata.component_hashes.encryption;
        break;
      case "release_control":
        cache.minimums.g6_release_control_hash =
          newRow === null
            ? null
            : CanonicalHashSchema.parse(newRow.control_hash);
        break;
    }
  }

  #applyEncryptionRecoveryMinimumChange(
    cache: RecoveryFrontierCache,
    change: RecoveryFrontierChange,
    oldRow: Record<string, unknown> | null,
    newRow: Record<string, unknown> | null,
  ): void {
    if (change.table_name === "encryption_keys") {
      if (newRow === null) {
        throw new StorageError("RECOVERY_AUTHORITY_INVALID");
      }
      const keyId = IdentifierSchema.parse(newRow.key_id);
      cache.metadata.keys[keyId] = {
        key_id: keyId,
        key_generation: Number(newRow.key_generation),
        state: String(newRow.state) as EncryptionKeyInventory["keys"][number]["state"],
      };
      if (
        !cache.minimums.key_live_ciphertexts.some(
          ({ key_id }) => key_id === keyId,
        )
      ) {
        cache.minimums.key_live_ciphertexts.push({
          key_id: keyId,
          live_ciphertext_count: 0,
        });
      }
    }
    if (change.table_name === "encrypted_content_owners") {
      const live = new Map(
        cache.minimums.key_live_ciphertexts.map((entry) => [
          entry.key_id,
          entry.live_ciphertext_count,
        ]),
      );
      const adjust = (
        row: Record<string, unknown> | null,
        direction: -1 | 1,
      ): void => {
        if (row === null || Number(row.active) !== 1) {
          return;
        }
        const keyId = IdentifierSchema.parse(row.key_id);
        const next = (live.get(keyId) ?? 0) + direction;
        if (next < 0 || !(keyId in cache.metadata.keys)) {
          throw new StorageError("RECOVERY_AUTHORITY_INVALID");
        }
        live.set(keyId, next);
      };
      adjust(oldRow, -1);
      adjust(newRow, 1);
      cache.minimums.key_live_ciphertexts = this.#orderedRecoveryKeys(
        cache.metadata,
      ).map(({ key_id }) => ({
        key_id,
        live_ciphertext_count: live.get(key_id) ?? 0,
      }));
    }
    const live = new Map(
      cache.minimums.key_live_ciphertexts.map((entry) => [
        entry.key_id,
        entry.live_ciphertext_count,
      ]),
    );
    const orderedKeys = this.#orderedRecoveryKeys(cache.metadata);
    cache.minimums.key_live_ciphertexts = orderedKeys.map(({ key_id }) => ({
      key_id,
      live_ciphertext_count: live.get(key_id) ?? 0,
    }));
    cache.minimums.required_keys = orderedKeys
      .filter(
        ({ key_id, state }) =>
          state === "current" ||
          state === "rotating_to" ||
          state === "retired" ||
          (state === "revoked_or_compromised" &&
            (live.get(key_id) ?? 0) > 0),
      )
      .map(({ key_id, key_generation, state }) => ({
        key_id,
        key_generation,
        state,
      }));
  }

  #orderedRecoveryKeys(
    metadata: RecoveryFrontierMetadata,
  ): Array<RecoveryFrontierMetadata["keys"][string]> {
    return Object.values(metadata.keys).sort(
      (left, right) =>
        left.key_generation - right.key_generation ||
        left.key_id.localeCompare(right.key_id),
    );
  }

  #projectionRecoveryFrontierHash(
    metadata: RecoveryFrontierMetadata,
  ): CanonicalHash {
    return CanonicalHashSchema.parse(canonicalSha256({
      fts: metadata.component_hashes.fts,
      layered: metadata.component_hashes.layered,
      relation: metadata.component_hashes.relation,
    }));
  }

  #latestRecoveryReceiptCursor(): RecoveryFrontierMetadata["latest_receipt"] {
    const row = this.#database
      .prepare(
        `SELECT receipt.resulting_epoch, receipt.receipt_id,
                receipt.receipt_hash
         FROM mutation_receipts AS receipt
         WHERE NOT EXISTS (
           SELECT 1 FROM json_each(receipt.receipt_json, '$.warnings')
           WHERE value = 'DRY_RUN'
         )
         ORDER BY receipt.resulting_epoch DESC, receipt.receipt_id DESC
         LIMIT 1`,
      )
      .get() as
      | {
          resulting_epoch: number;
          receipt_id: string;
          receipt_hash: CanonicalHash;
        }
      | undefined;
    return row === undefined
      ? null
      : {
          resulting_epoch: Number(row.resulting_epoch),
          receipt_id: row.receipt_id,
          receipt_hash: row.receipt_hash,
        };
  }

  #replayRecoveryFrontierFromSeed(): {
    cache: RecoveryFrontierCache;
    seed_rows_hash: CanonicalHash;
    changes: RecoveryFrontierChange[];
  } {
    const row = this.#database
      .prepare(
        `SELECT minimums_json, metadata_json, state_commitment_hash,
                last_change_id, rows_hash, seed_hash, seeded_at
         FROM recovery_frontier_seed WHERE singleton = 1`,
      )
      .get() as
      | {
          minimums_json: string;
          metadata_json: string;
          state_commitment_hash: CanonicalHash;
          last_change_id: number;
          rows_hash: CanonicalHash;
          seed_hash: CanonicalHash;
          seeded_at: string;
        }
      | undefined;
    if (row === undefined) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    const minimums = RecoveryMinimumsSchema.parse(
      JSON.parse(row.minimums_json) as unknown,
    );
    const metadata = this.#parseRecoveryFrontierMetadata(
      JSON.parse(row.metadata_json) as unknown,
    );
    const lastChangeId = Number(row.last_change_id);
    if (
      row.seed_hash !==
        canonicalSha256({
          schema_version: "1.0.0",
          minimums,
          metadata,
          state_commitment_hash: row.state_commitment_hash,
          last_change_id: lastChangeId,
          rows_hash: row.rows_hash,
          seeded_at: row.seeded_at,
        }) ||
      row.state_commitment_hash !==
        recoveryStateCommitment({
          ...this.#recoveryRootIdentity(),
          minimums,
        })
    ) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    const cache: RecoveryFrontierCache = {
      minimums,
      metadata,
      state_commitment_hash: row.state_commitment_hash,
      last_change_id: lastChangeId,
      initialized_at: row.seeded_at,
      updated_at: row.seeded_at,
      full_scan_count: 0,
    };
    const changes = this.#database
      .prepare(
        `SELECT change_id, component, table_name, row_key, operation,
                old_row_json, new_row_json
         FROM recovery_frontier_changes
         WHERE change_id > ?
         ORDER BY change_id
         LIMIT ?`,
      )
      .all(
        lastChangeId,
        MAX_RECOVERY_FRONTIER_CHANGES_PER_EFFECT + 1,
      ) as RecoveryFrontierChange[];
    if (changes.length > MAX_RECOVERY_FRONTIER_CHANGES_PER_EFFECT) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    for (const change of changes) {
      this.#applyRecoveryFrontierMinimumChange(cache, change);
      cache.last_change_id = Number(change.change_id);
    }
    cache.minimums = RecoveryMinimumsSchema.parse(cache.minimums);
    cache.state_commitment_hash = recoveryStateCommitment({
      ...this.#recoveryRootIdentity(),
      minimums: cache.minimums,
    });
    return {
      cache,
      seed_rows_hash: row.rows_hash,
      changes,
    };
  }

  #verifyRecoveryFrontierFull(): void {
    const cache = this.#readRecoveryFrontierCache();
    if (this.#latestRecoveryFrontierChangeId() !== cache.last_change_id) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    const sourceRows = this.#recoveryFrontierSourceRows();
    const cachedRows = this.#database
      .prepare(
        `SELECT component, table_name, row_key, row_json, row_hash
         FROM recovery_frontier_rows
         ORDER BY component, table_name, row_key`,
      )
      .all() as Array<{
      component: RecoveryFrontierComponent;
      table_name: string;
      row_key: string;
      row_json: string;
      row_hash: CanonicalHash;
    }>;
    if (sourceRows.length !== cachedRows.length) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    for (let index = 0; index < sourceRows.length; index += 1) {
      const source = sourceRows[index];
      const cached = cachedRows[index];
      if (
        source === undefined ||
        cached === undefined ||
        source.component !== cached.component ||
        source.table_name !== cached.table_name ||
        source.row_key !== cached.row_key ||
        canonicalJson(JSON.parse(source.row_json) as unknown) !==
          canonicalJson(JSON.parse(cached.row_json) as unknown) ||
        cached.row_hash !==
          canonicalSha256(JSON.parse(source.row_json) as unknown)
      ) {
        throw new StorageError("RECOVERY_AUTHORITY_INVALID");
      }
    }
    const replay = this.#replayRecoveryFrontierFromSeed();
    if (
      replay.cache.last_change_id !== cache.last_change_id ||
      replay.cache.state_commitment_hash !==
        cache.state_commitment_hash ||
      canonicalJson(replay.cache.minimums) !==
        canonicalJson(cache.minimums) ||
      canonicalJson(replay.cache.metadata) !==
        canonicalJson(cache.metadata)
    ) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    const replayRows = new Map(
      cachedRows.map((row) => [
        `${row.component}\u001f${row.table_name}\u001f${row.row_key}`,
        {
          component: row.component,
          table_name: row.table_name,
          row_key: row.row_key,
          row_json: row.row_json,
        },
      ]),
    );
    for (const change of [...replay.changes].reverse()) {
      const key =
        `${change.component}\u001f${change.table_name}\u001f${change.row_key}`;
      const current = replayRows.get(key);
      if (
        (change.new_row_json === null && current !== undefined) ||
        (change.new_row_json !== null &&
          (current === undefined ||
            canonicalJson(JSON.parse(current.row_json) as unknown) !==
              canonicalJson(
                JSON.parse(change.new_row_json) as unknown,
              )))
      ) {
        throw new StorageError("RECOVERY_AUTHORITY_INVALID");
      }
      if (change.old_row_json === null) {
        replayRows.delete(key);
      } else {
        replayRows.set(key, {
          component: change.component,
          table_name: change.table_name,
          row_key: change.row_key,
          row_json: change.old_row_json,
        });
      }
    }
    if (
      this.#recoveryFrontierRowsHash([...replayRows.values()]) !==
      replay.seed_rows_hash
    ) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    const legacyLatest = this.#latestRecoveryReceiptCursor();
    const liveCounts = new Map<string, number>();
    const sourceKeys: RecoveryFrontierMetadata["keys"] = {};
    let ledgerEpoch = 0;
    let tombstoneEpoch = 0;
    let learningControlEpoch = 0;
    let learningReleaseRevision = 0;
    let releaseControlHash: CanonicalHash | null = null;
    for (const source of sourceRows) {
      const row = JSON.parse(source.row_json) as Record<string, unknown>;
      if (source.table_name === "ledger_state") {
        ledgerEpoch = Number(row.ledger_epoch);
      } else if (source.table_name === "tombstone_state") {
        tombstoneEpoch = Number(row.tombstone_epoch);
      } else if (source.table_name === "learning_control_state") {
        learningControlEpoch = Math.max(
          learningControlEpoch,
          Number(row.control_epoch),
        );
      } else if (source.table_name === "learning_release_pointers") {
        learningReleaseRevision = Math.max(
          learningReleaseRevision,
          Number(row.pointer_revision),
        );
      } else if (source.table_name === "encryption_keys") {
        const keyId = IdentifierSchema.parse(row.key_id);
        sourceKeys[keyId] = {
          key_id: keyId,
          key_generation: Number(row.key_generation),
          state: String(row.state) as EncryptionKeyInventory["keys"][number]["state"],
        };
        if (!liveCounts.has(keyId)) {
          liveCounts.set(keyId, 0);
        }
      } else if (
        source.table_name === "encrypted_content_owners" &&
        Number(row.active) === 1
      ) {
        const keyId = IdentifierSchema.parse(row.key_id);
        liveCounts.set(keyId, (liveCounts.get(keyId) ?? 0) + 1);
      } else if (source.table_name === "g6_release_controls") {
        releaseControlHash = CanonicalHashSchema.parse(row.control_hash);
      }
    }
    const expectedKeyCounts = Object.values(sourceKeys)
      .sort(
        (left, right) =>
          left.key_generation - right.key_generation ||
          left.key_id.localeCompare(right.key_id),
      )
      .map(({ key_id }) => ({
        key_id,
        live_ciphertext_count: liveCounts.get(key_id) ?? 0,
      }));
    const expectedRequiredKeys = Object.values(sourceKeys)
      .sort(
        (left, right) =>
          left.key_generation - right.key_generation ||
          left.key_id.localeCompare(right.key_id),
      )
      .filter(
        ({ key_id, state }) =>
          state === "current" ||
          state === "rotating_to" ||
          state === "retired" ||
          (state === "revoked_or_compromised" &&
            (liveCounts.get(key_id) ?? 0) > 0),
      )
      .map(({ key_id, key_generation, state }) => ({
        key_id,
        key_generation,
        state,
      }));
    if (
      canonicalJson(sourceKeys) !== canonicalJson(cache.metadata.keys) ||
      ledgerEpoch !== cache.minimums.ledger_epoch ||
      tombstoneEpoch !== cache.minimums.tombstone_epoch ||
      learningControlEpoch !== cache.minimums.learning_control_epoch ||
      learningReleaseRevision !==
        cache.minimums.learning_release_revision ||
      releaseControlHash !== cache.minimums.g6_release_control_hash ||
      canonicalJson(legacyLatest) !==
        canonicalJson(cache.metadata.latest_receipt) ||
      canonicalJson(expectedKeyCounts) !==
        canonicalJson(cache.minimums.key_live_ciphertexts) ||
      canonicalJson(expectedRequiredKeys) !==
        canonicalJson(cache.minimums.required_keys)
    ) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    if (!this.#inspectionOnly) {
      cache.full_scan_count += 1;
      cache.updated_at = now();
      this.#withRecoveryFrontierGuard(() => {
        this.#writeRecoveryFrontierCache(cache);
      });
    }
  }

  installRecoveryCheckpoint(anchor: RecoveryAnchor): void {
    const checkpoint = this.#database
      .prepare(
        `SELECT anchor_hash, state_commitment_hash, generation
         FROM recovery_anchor_checkpoint WHERE singleton = 1`,
      )
      .get() as {
      anchor_hash: string | null;
      state_commitment_hash: string | null;
      generation: number;
    };
    if (
      checkpoint.anchor_hash !== null &&
      (anchor.payload.generation < Number(checkpoint.generation) ||
        (anchor.payload.generation === Number(checkpoint.generation) &&
          anchor.anchor_hash !== checkpoint.anchor_hash))
    ) {
      throw new StorageError("STALE_RECOVERY_HEAD");
    }
    const state = this.recoveryState();
    if (
      anchor.payload.root_id !== state.root_id ||
      anchor.payload.principal_id !== state.principal_id ||
      anchor.payload.state_commitment_hash !==
        state.state_commitment_hash ||
      canonicalJson(anchor.payload.minimums) !==
        canonicalJson(state.minimums)
    ) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    if (
      checkpoint.anchor_hash === anchor.anchor_hash &&
      checkpoint.state_commitment_hash ===
        anchor.payload.state_commitment_hash &&
      Number(checkpoint.generation) === anchor.payload.generation
    ) {
      return;
    }
    const initial =
      checkpoint.anchor_hash === null &&
      Number(checkpoint.generation) === 0 &&
      anchor.payload.generation === 1 &&
      anchor.payload.previous_head_hash === null &&
      anchor.payload.backup_manifest_hash === null;
    const advance =
      checkpoint.anchor_hash !== null &&
      anchor.payload.backup_manifest_hash !== null &&
      anchor.payload.previous_head_hash === checkpoint.anchor_hash &&
      anchor.payload.generation === Number(checkpoint.generation) + 1 &&
      anchor.payload.state_commitment_hash ===
        checkpoint.state_commitment_hash;
    if (!initial && !advance) {
      throw new StorageError("STALE_RECOVERY_HEAD");
    }
    const changed = this.#database
      .prepare(
        `UPDATE recovery_anchor_checkpoint
         SET anchor_hash = ?, state_commitment_hash = ?,
             generation = ?, updated_at = ?
         WHERE singleton = 1 AND anchor_hash IS ?
           AND generation = ?`,
      )
      .run(
        anchor.anchor_hash,
        anchor.payload.state_commitment_hash,
        anchor.payload.generation,
        now(),
        checkpoint.anchor_hash,
        checkpoint.generation,
      ).changes;
    if (changed !== 1) {
      throw new StorageError("STALE_RECOVERY_HEAD");
    }
  }

  runRecoveryProtectedEffect<T>(
    authorization: RecoveryPendingAuthorization,
    effect: () => T,
  ): { result: T; recovery_effect: RecoveryEffectRecord } {
    return this.#database.transaction(() => {
      const input = authorization.reservation;
      if (input.state === "reconciled") {
        const recorded = this.recoveryEffect(input.pending_id);
        const before = this.recoveryState();
        const checkpoint = this.#database
          .prepare(
            `SELECT anchor_hash, state_commitment_hash
             FROM recovery_anchor_checkpoint WHERE singleton = 1`,
          )
          .get() as {
          anchor_hash: string | null;
          state_commitment_hash: string | null;
        };
        if (
          recorded === null ||
          recorded.state !== "reconciled" ||
          recorded.anchor_hash === null ||
          recorded.operation !== input.operation ||
          recorded.idempotency_key !== input.idempotency_key ||
          recorded.request_hash !== input.request_hash ||
          checkpoint.anchor_hash === null ||
          checkpoint.state_commitment_hash !==
            before.state_commitment_hash
        ) {
          throw new StorageError("RECOVERY_AUTHORITY_INVALID");
        }
        const result = effect();
        if (result instanceof Promise) {
          throw new StorageError("INVALID_INPUT");
        }
        const after = this.recoveryState();
        if (
          canonicalJson(before) !== canonicalJson(after) ||
          recoveryContentHash(result) !==
            recorded.effect_receipt_hash
        ) {
          throw new StorageError("RECOVERY_AUTHORITY_INVALID");
        }
        return { result, recovery_effect: recorded };
      }
      if (input.state !== "pending") {
        throw new StorageError("RECOVERY_AUTHORITY_INVALID");
      }
      const before = this.recoveryState();
      const checkpoint = this.#database
        .prepare(
          `SELECT anchor_hash, state_commitment_hash
           FROM recovery_anchor_checkpoint WHERE singleton = 1`,
        )
        .get() as {
        anchor_hash: string | null;
        state_commitment_hash: string | null;
      };
      if (
        checkpoint.anchor_hash !== input.prior_head_hash ||
        checkpoint.state_commitment_hash !==
          input.prior_state_commitment_hash ||
        before.state_commitment_hash !==
          input.prior_state_commitment_hash ||
        canonicalJson(before.minimums) !==
          canonicalJson(input.prior_minimums)
      ) {
        throw new StorageError("STALE_RECOVERY_HEAD");
      }
      const result = effect();
      if (result instanceof Promise) {
        throw new StorageError("INVALID_INPUT");
      }
      const after = this.recoveryState();
      const afterKeys = new Set(
        after.minimums.required_keys.map(({ key_id }) => key_id),
      );
      const afterLiveCiphertexts = new Map(
        after.minimums.key_live_ciphertexts.map(
          ({ key_id, live_ciphertext_count }) => [
            key_id,
            live_ciphertext_count,
          ],
        ),
      );
      for (const priorKey of input.prior_minimums.required_keys) {
        if (
          !afterKeys.has(priorKey.key_id) &&
          ((input.operation !== "key" && input.operation !== "purge") ||
            after.minimums.encryption_frontier_hash ===
              input.prior_minimums.encryption_frontier_hash ||
            afterLiveCiphertexts.get(priorKey.key_id) !== 0)
        ) {
          throw new StorageError("RECOVERY_AUTHORITY_INVALID");
        }
      }
      const effectReceiptHash = recoveryContentHash(result);
      this.#database
        .prepare(
          `INSERT INTO recovery_anchored_effects (
             pending_id, operation_kind, idempotency_key, request_hash,
             prior_minimums_hash, prior_state_commitment_hash,
             prior_head_hash,
             committed_minimums_json, committed_state_commitment_hash,
             root_id, principal_id, backup_manifest_hash,
             effect_receipt_hash, state, anchor_hash, created_at,
             committed_at, reconciled_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?,
                     'effect_committed', NULL, ?, ?, NULL)`,
        )
        .run(
          input.pending_id,
          input.operation,
          input.idempotency_key,
          input.request_hash,
          canonicalSha256(input.prior_minimums),
          input.prior_state_commitment_hash,
          input.prior_head_hash,
          canonicalJson(after.minimums),
          after.state_commitment_hash,
          after.root_id,
          after.principal_id,
          effectReceiptHash,
          now(),
          now(),
        );
      return {
        result,
        recovery_effect: RecoveryEffectRecordSchema.parse({
          pending_id: input.pending_id,
          operation: input.operation,
          idempotency_key: input.idempotency_key,
          request_hash: input.request_hash,
          prior_minimums_hash: canonicalSha256(input.prior_minimums),
          prior_state_commitment_hash:
            input.prior_state_commitment_hash,
          prior_head_hash: input.prior_head_hash,
          committed_minimums: after.minimums,
          committed_state_commitment_hash:
            after.state_commitment_hash,
          root_id: after.root_id,
          principal_id: after.principal_id,
          backup_manifest_hash: null,
          effect_receipt_hash: effectReceiptHash,
          state: "effect_committed",
          anchor_hash: null,
        }),
      };
    }).immediate();
  }

  recoveryEffect(pendingId: string): RecoveryEffectRecord | null {
    const row = this.#database
      .prepare(
        `SELECT pending_id, operation_kind, idempotency_key, request_hash,
                prior_minimums_hash, prior_state_commitment_hash,
                prior_head_hash,
                committed_minimums_json, committed_state_commitment_hash,
                root_id, principal_id, backup_manifest_hash,
                effect_receipt_hash, state, anchor_hash
         FROM recovery_anchored_effects WHERE pending_id = ?`,
      )
      .get(pendingId) as
      | {
          pending_id: string;
          operation_kind: RecoveryEffectRecord["operation"];
          idempotency_key: string;
          request_hash: `sha256:${string}`;
          prior_minimums_hash: `sha256:${string}`;
          prior_state_commitment_hash: `sha256:${string}`;
          prior_head_hash: `sha256:${string}` | null;
          committed_minimums_json: string;
          committed_state_commitment_hash: `sha256:${string}`;
          root_id: string;
          principal_id: string;
          backup_manifest_hash: `sha256:${string}` | null;
          effect_receipt_hash: `sha256:${string}`;
          state: RecoveryEffectRecord["state"];
          anchor_hash: `sha256:${string}` | null;
        }
      | undefined;
    return row === undefined
      ? null
      : RecoveryEffectRecordSchema.parse({
          pending_id: row.pending_id,
          operation: row.operation_kind,
          idempotency_key: row.idempotency_key,
          request_hash: row.request_hash,
          prior_minimums_hash: row.prior_minimums_hash,
          prior_state_commitment_hash:
            row.prior_state_commitment_hash,
          prior_head_hash: row.prior_head_hash,
          committed_minimums: RecoveryMinimumsSchema.parse(
            JSON.parse(row.committed_minimums_json) as unknown,
          ),
          committed_state_commitment_hash:
            row.committed_state_commitment_hash,
          root_id: row.root_id,
          principal_id: row.principal_id,
          backup_manifest_hash: row.backup_manifest_hash,
          effect_receipt_hash: row.effect_receipt_hash,
          state: row.state,
          anchor_hash: row.anchor_hash,
        });
  }

  reconcileRecoveryEffect(
    pendingId: string,
    anchor: RecoveryAnchor,
  ): RecoveryEffectRecord {
    const committed = this.recoveryEffect(pendingId);
    if (
      committed === null ||
      committed.prior_head_hash !== anchor.payload.previous_head_hash ||
      committed.committed_state_commitment_hash !==
        anchor.payload.state_commitment_hash ||
      committed.root_id !== anchor.payload.root_id ||
      committed.principal_id !== anchor.payload.principal_id ||
      committed.backup_manifest_hash !==
        anchor.payload.backup_manifest_hash ||
      canonicalJson(committed.committed_minimums) !==
        canonicalJson(anchor.payload.minimums)
    ) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    this.#database.transaction(() => {
      const changed = this.#database
        .prepare(
          `UPDATE recovery_anchored_effects
           SET state = 'reconciled', anchor_hash = ?, reconciled_at = ?
           WHERE pending_id = ? AND state = 'effect_committed'`,
        )
        .run(anchor.anchor_hash, now(), pendingId).changes;
      if (changed === 1) {
        const advanced = this.#database
          .prepare(
            `UPDATE recovery_anchor_checkpoint
             SET anchor_hash = ?, state_commitment_hash = ?,
                 generation = ?, updated_at = ?
             WHERE singleton = 1 AND anchor_hash IS ?
               AND generation = ?`,
          )
          .run(
            anchor.anchor_hash,
            anchor.payload.state_commitment_hash,
            anchor.payload.generation,
            now(),
            anchor.payload.previous_head_hash,
            anchor.payload.generation - 1,
          ).changes;
        if (advanced !== 1) {
          throw new StorageError("STALE_RECOVERY_HEAD");
        }
      }
    })();
    const effect = this.recoveryEffect(pendingId);
    if (
      effect === null ||
      effect.state !== "reconciled" ||
      effect.anchor_hash !== anchor.anchor_hash
    ) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    return effect;
  }

  health(): StorageHealth {
    const projection = this.#fts.state();
    const governance = this.#governance.counts();
    const purge = this.#purge.counts();
    const learningFrontier = this.#learning.frontier();
    const layeredProjection = this.#projections.state();
    const count = (table: string, where = ""): number =>
      Number(
        (
          this.#database
            .prepare(`SELECT count(*) AS count FROM ${table} ${where}`)
            .get() as { count: number }
        ).count,
      );
    const countIfPresent = (table: string, where = ""): number =>
      this.#tableExists(table) ? count(table, where) : 0;
    const ftsRows = this.#tableExists("evidence_fts")
      ? count("evidence_fts")
      : 0;
    const schemaVersion = this.#migrations.at(-1)?.version;
    if (schemaVersion === undefined) {
      throw new StorageError("MIGRATION_DRIFT");
    }
    if (
      Number(this.#database.pragma("foreign_keys", { simple: true })) !== 1
    ) {
      throw new StorageError("STORAGE_UNAVAILABLE");
    }
    if (
      Number(this.#database.pragma("secure_delete", { simple: true })) !== 1
    ) {
      throw new StorageError("STORAGE_UNAVAILABLE");
    }

    return {
      schema_version: schemaVersion,
      ledger_epoch: this.#ledgerEpoch(),
      tombstone_epoch: this.#purge.tombstoneEpoch(),
      latest_receipt_hash: this.#latestReceipt()?.receipt_hash ?? null,
      sqlite_version: String(
        (
          this.#database
            .prepare("SELECT sqlite_version() AS version")
            .get() as { version: string }
        ).version,
      ),
      journal_mode: "wal",
      foreign_keys: true,
      secure_delete: true,
      projection_state: projection.status,
      layered_projection_state: layeredProjection.status,
      projection_frontier: this.#projections.frontier(),
      learning_frontier: learningFrontier,
      encryption: this.#tableExists("encryption_keys")
        ? this.#keys.inventory()
        : {
            keys: [],
            current_key_id: null,
            rotating_to_key_id: null,
            encrypted_content_count: 0,
            rotation_id: null,
            rotation_state: null,
          },
      filesystem_type: this.#layout.filesystem_type,
      migrations: this.#migrations,
      counts: {
        evidence_events: count("evidence_events"),
        episodes: count("episodes"),
        mutation_receipts: count("mutation_receipts"),
        idempotency_keys: count("idempotency_keys"),
        outbox_pending: count(
          "outbox_jobs",
          "WHERE status IN ('pending', 'failed')",
        ),
        fts_rows: ftsRows,
        backup_manifests: count("backup_manifests"),
        recall_requests: count("recall_requests"),
        retrieval_receipts: count("retrieval_receipts"),
        context_slices: count("context_slices"),
        receipt_access_scopes: count("receipt_access_scopes"),
        encryption_keys: countIfPresent("encryption_keys"),
        encrypted_contents: countIfPresent("encrypted_contents"),
        secret_nonce_reservations: countIfPresent(
          "secret_nonce_reservations",
        ),
        key_rotations: countIfPresent("key_rotations"),
        encrypted_artifact_operations: countIfPresent(
          "encrypted_artifact_operations",
        ),
        operational_receipts: countIfPresent("operational_receipts"),
        artifact_store_registry: countIfPresent("artifact_store_registry"),
        ...this.#projections.counts(),
        ...governance,
        ...purge,
        ...this.#learning.counts(),
      },
    };
  }

  writeLearningLedger(input: unknown): LearningLedgerWriteResult {
    return this.#learning.write(
      LearningLedgerWriteCommandSchema.parse(input),
    );
  }

  replayLearningLedger(input: unknown): LearningLedgerReplayResult {
    return this.#learning.replay(
      LearningLedgerReplayInputSchema.parse(input),
    );
  }

  readLearningLedger(input: unknown): LearningLedgerReadResult {
    return this.#learning.read(LearningLedgerReadInputSchema.parse(input));
  }

  governanceStatus(): GovernanceStorageStatus {
    return {
      tombstone_epoch: this.#purge.tombstoneEpoch(),
      governance: this.#governance.counts(),
      purge: this.#purge.counts(),
    };
  }

  contentReferenceCounts(contentHash: string): ContentReferenceCounts {
    return this.#governance.contentReferenceCounts(contentHash);
  }

  applyProjectionBatch(input: unknown): ProjectionBatchResult {
    return this.#projections.applyBatch(
      ApplyProjectionBatchCommandSchema.parse(input),
    );
  }

  projectionScopeFrontier(input: unknown): ProjectionScopeStorageFrontier {
    return this.#projections.scopeFrontier(
      ProjectionScopeFrontierInputSchema.parse(input),
    );
  }

  queryProjections(input: unknown): ProjectionQueryResult {
    return this.#projections.query(ProjectionQuerySchema.parse(input));
  }

  queryProjectionPage(input: unknown): ProjectionPageResult {
    return this.#projections.page(ProjectionPageQuerySchema.parse(input));
  }

  validateProjectionSources(input: unknown): ProjectionSourceBatchResult {
    return this.#governedMemory.exactProjectionSources(
      ProjectionSourceBatchQuerySchema.parse(input),
    );
  }

  listProjectionSources(input: unknown): ProjectionSourceListResult {
    return this.#governedMemory.listProjectionSources(
      ProjectionSourceListInputSchema.parse(input),
    );
  }

  traverseRelations(input: unknown): RelationTraversalResult {
    return this.#relations.traverse(
      RelationTraversalInputSchema.parse(input),
    );
  }

  enqueueProjectionJob(input: unknown): ProjectionJobMutationResult {
    return this.#projections.enqueue(
      EnqueueProjectionJobCommandSchema.parse(input),
    );
  }

  claimProjectionJobs(input: unknown): ClaimProjectionJobsResult {
    return this.#projections.claim(
      ClaimProjectionJobsInputSchema.parse(input),
    );
  }

  failProjectionJob(input: unknown): ProjectionJobMutationResult {
    return this.#projections.fail(
      FailProjectionJobCommandSchema.parse(input),
    );
  }

  completeProjectionJob(input: unknown): ProjectionJobMutationResult {
    return this.#projections.complete(
      CompleteProjectionJobCommandSchema.parse(input),
    );
  }

  invalidateProjectionDescendants(
    input: unknown,
  ): InvalidateProjectionDescendantsResult {
    return this.#projections.invalidateDescendants(
      InvalidateProjectionDescendantsCommandSchema.parse(input),
    );
  }

  recordProjectionRebuild(input: unknown): RecordProjectionRebuildResult {
    return this.#projections.recordRebuild(
      ProjectionRebuildReceiptSchema.parse(input),
    );
  }

  graphProjectionCheckpoint(input: unknown) {
    return this.#graph.checkpoint(GraphScopeInputSchema.parse(input));
  }

  graphScopeSnapshot(input: unknown): GraphScopeSnapshotResult {
    return this.#graph.scopeSnapshot(GraphScopeInputSchema.parse(input));
  }

  listGraphProjectionSnapshots(
    input: unknown,
  ): GraphProjectionSnapshotListResult {
    return this.#graph.listSnapshots(
      GraphProjectionSnapshotListInputSchema.parse(input),
    );
  }

  claimGraphProjectionJobs(
    input: unknown,
  ): ClaimGraphProjectionJobsResult {
    return this.#graph.claim(
      ClaimGraphProjectionJobsInputSchema.parse(input),
    );
  }

  applyGraphProjectionJob(input: unknown): GraphProjectionJobResult {
    return this.#graph.apply(
      ApplyGraphProjectionJobCommandSchema.parse(input),
    );
  }

  failGraphProjectionJob(input: unknown): GraphProjectionJobResult {
    return this.#graph.fail(
      FailGraphProjectionJobCommandSchema.parse(input),
    );
  }

  resetGraphProjectionScopes(
    input: unknown,
  ): ResetGraphProjectionScopesResult {
    return this.#graph.reset(
      ResetGraphProjectionScopesInputSchema.parse(input),
    );
  }

  markGraphRestoreUnavailable(input: unknown) {
    return this.#graph.markRestoreUnavailable(
      MarkGraphRestoreUnavailableInputSchema.parse(input),
    );
  }

  graphProjectionStatus(): GraphProjectionStatus {
    return this.#graph.status();
  }

  registerVectorEmbeddingEpoch(input: unknown) {
    return this.#vector.registerEpoch(
      RegisterVectorEmbeddingEpochCommandSchema.parse(input),
    );
  }

  configureVectorProjection(input: unknown) {
    return this.#vector.configure(
      ConfigureVectorProjectionCommandSchema.parse(input),
    );
  }

  vectorProjectionCheckpoint(input: unknown) {
    return this.#vector.checkpoint(
      VectorProjectionScopeInputSchema.parse(input),
    );
  }

  claimVectorProjectionJobs(input: unknown) {
    return this.#vector.claim(
      ClaimVectorProjectionJobsInputSchema.parse(input),
    );
  }

  applyVectorProjectionJob(input: unknown) {
    return this.#vector.apply(
      ApplyVectorProjectionJobCommandSchema.parse(input),
    );
  }

  failVectorProjectionJob(input: unknown) {
    return this.#vector.fail(
      FailVectorProjectionJobCommandSchema.parse(input),
    );
  }

  staleVectorProjectionJob(input: unknown) {
    return this.#vector.stale(
      StaleVectorProjectionJobCommandSchema.parse(input),
    );
  }

  markVectorRestoreDegraded(input: unknown) {
    return this.#vector.markRestoreDegraded(
      MarkVectorRestoreDegradedInputSchema.parse(input),
    );
  }

  runVectorTemporalSweep(input: unknown) {
    return this.#vector.temporalSweep(
      RunVectorTemporalSweepInputSchema.parse(input),
    );
  }

  vectorProjectionStatus() {
    return this.#vector.status();
  }

  admitMemory(input: unknown): GovernanceMutationResult {
    const command = AdmitMemoryCommandSchema.parse(input);
    return this.#governanceEffect(() =>
      this.#governance.admitMemory(command),
    );
  }

  applyMemoryRevision(input: unknown): GovernanceMutationResult {
    const command = MemoryRevisionCommandSchema.parse(input);
    return this.#governanceEffect(() =>
      this.#governance.applyMemoryRevision(command),
    );
  }

  getMemoryCorrectionBasis(input: unknown): MemoryCorrectionBasis | null {
    return this.#governance.correctionBasis(
      MemoryCorrectionBasisInputSchema.parse(input),
    );
  }

  governanceReplay(input: unknown): GovernanceMutationResult | null {
    const request = GovernanceReplayInputSchema.parse(input);
    return this.#governance.replayMutation(
      request.idempotency_key,
      request.request_hash,
    );
  }

  memoryControlReplay(input: unknown): MemoryControlResult | null {
    const request = GovernanceReplayInputSchema.parse(input);
    return this.#control.replay(
      request.idempotency_key,
      request.request_hash,
    );
  }

  applyMemoryControl(input: unknown): MemoryControlResult {
    return this.#governanceEffect(() =>
      this.#control.apply(MemoryControlCommandSchema.parse(input)),
    );
  }

  memoryDeleteReplay(input: unknown): MemoryDeleteResult | null {
    const request = GovernanceReplayInputSchema.parse(input);
    return this.#purge.replayDelete(
      request.idempotency_key,
      request.request_hash,
    );
  }

  deleteMemory(input: unknown): MemoryDeleteResult {
    return this.#governanceEffect(() =>
      this.#purge.deleteMemory(MemoryDeleteCommandSchema.parse(input)),
    );
  }

  preparePurge(input: unknown): PurgePreparationResult {
    const request = PurgeRunInputSchema.parse(input);
    return this.#purge.prepare(
      request.purge_job_id,
      request.operator_action,
    );
  }

  finalizePurgeJobMaintenance(input: unknown): void {
    const maintenance = PurgePhysicalMaintenanceSchema.parse(input);
    this.#purge.finalizePhysicalMaintenance(
      maintenance,
      () => this.finalizePurgeMaintenance(),
    );
  }

  completePurge(input: unknown): PurgeRunResult {
    const request = PurgeCompletionInputSchema.parse(input);
    return this.#purge.complete(
      request.purge_job_id,
      request.maintenance,
      request.operator_action,
    );
  }

  inspectPurgeReceipt(input: unknown): PurgeRunResult | null {
    const request = InspectPurgeReceiptInputSchema.parse(input);
    return this.#purge.inspectReceipt(
      request.purge_job_id,
      request.operator_operation_id,
    );
  }

  auditPurgeArtifacts(input: unknown): ArtifactPurgeAudit {
    return this.#operations.auditPurgeArtifacts(
      AuditPurgeArtifactsInputSchema.parse(input),
    );
  }

  appendOperatorActionReceipt(input: unknown): OperatorActionReceipt {
    return this.#operations.appendOperatorActionReceipt(
      OperatorActionReceiptSchema.parse(input),
    );
  }

  bindOperatorConfirmation(input: unknown) {
    return this.#operations.bindOperatorConfirmation(
      OperatorConfirmationBindingSchema.parse(input),
    );
  }

  checkMemoryEligibility(input: unknown): MemoryEligibilityResult {
    return this.#governedMemory.checkEligibility(
      MemoryEligibilityInputSchema.parse(input),
    );
  }

  getGovernedMemory(input: unknown): GovernedMemoryLookupResult {
    return this.#governedMemory.lookup(
      GovernedMemoryLookupInputSchema.parse(input),
    );
  }

  searchGovernedMemory(input: unknown): GovernedMemorySearchResult {
    return this.#governedMemory.search(
      GovernedMemorySearchQuerySchema.parse(input),
    );
  }

  commitEpisode(input: unknown): CommitResult {
    const command = CommitEpisodeCommandSchema.parse(input);
    this.#validateEpisode(command);
    const hash = requestHash(command);
    const existing = this.#readIdempotency(command.idempotencyKey);
    if (existing !== undefined) {
      return {
        receipt: this.#parseExistingReceipt(existing, hash),
        committed: false,
      };
    }

    const storedBlobs = this.#prepareBlobs(command);
    const searchableEvidence = command.evidence.filter(
      (record) => record.payload.storage === "inline",
    );
    const createdAt = now();
    const projectionJobs = searchableEvidence.map((record) =>
      stableIdentifier("job", {
        kind: "fts_evidence_upsert",
        episode_id: command.episode.episode_id,
        evidence_id: record.evidence_id,
      }),
    );

    try {
      const receipt = this.#database
        .transaction(() => {
          const repeated = this.#readIdempotency(command.idempotencyKey);
          if (repeated !== undefined) {
            return this.#parseExistingReceipt(repeated, hash);
          }

          this.#insertArtifacts(storedBlobs);
          this.#insertEvidence(command);
          this.#insertEpisode(command);
          const epoch = this.#advanceEpoch(createdAt);
          this.#insertOutbox(
            searchableEvidence.map((record, index) => ({
              jobId: projectionJobs[index] as string,
              evidenceId: record.evidence_id,
            })),
            createdAt,
          );

          const receipt = MutationReceiptSchema.parse(
            sealReceipt({
              schema_version: "1.0.0",
              receipt_id: stableIdentifier("receipt", {
                idempotency_key: command.idempotencyKey,
                request_hash: hash,
              }),
              created_at: createdAt,
              state:
                projectionJobs.length > 0 ? "projection_pending" : "durable",
              request_hash: hash,
              receipt_hash: `sha256:${"0".repeat(64)}`,
              kind: "mutation",
              idempotency_key: command.idempotencyKey,
              affected_memory_ids: [],
              affected_revision_ids: [],
              resulting_epoch: epoch,
              projection_jobs: projectionJobs,
              warnings: [],
            }),
          );
          this.#insertReceipt(receipt, command);
          if (projectionJobs.length > 0) {
            this.#fts.markPending(epoch);
          }
          return receipt;
        })
        .immediate();

      return { receipt, committed: true };
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string" &&
        error.code.startsWith("SQLITE_CONSTRAINT")
      ) {
        throw new StorageError("CONFLICT");
      }
      throw error;
    }
  }

  drainFtsOutbox(): DrainFtsResult {
    return this.#fts.drain();
  }

  searchEvidence(input: unknown): SearchEvidenceResult {
    const query = SearchEvidenceQuerySchema.parse(input);
    return this.#fts.search(query);
  }

  rebuildFts(): RebuildFtsResult {
    return this.#fts.rebuild();
  }

  prepareOperationalRepair(input: unknown): OperationalRepairResult {
    return this.#operations.prepareRepair(
      OperationalRepairInputSchema.parse(input),
    );
  }

  completeOperationalRepair(input: unknown): OperationalRepairResult {
    return this.#operations.completeRepair(
      CompleteOperationalRepairInputSchema.parse(input),
    );
  }

  inspectOperationalRepair(input: unknown): OperationalRepairResult | null {
    const request = InspectOperationalRepairInputSchema.parse(input);
    return this.#operations.inspectRepair(request.operation_id);
  }

  checkpoint(): CheckpointResult {
    this.#database.pragma("busy_timeout = 0");
    let rows: CheckpointResult[];
    try {
      rows = this.#database.pragma(
        "wal_checkpoint(TRUNCATE)",
      ) as CheckpointResult[];
    } finally {
      this.#database.pragma(`busy_timeout = ${this.#busyTimeoutMs}`);
    }
    const row = rows[0];
    if (row === undefined) {
      throw new StorageError("STORAGE_UNAVAILABLE");
    }
    return {
      busy: Number(row.busy),
      log: Number(row.log),
      checkpointed: Number(row.checkpointed),
    };
  }

  async createBackup(): Promise<BackupDraftResult> {
    this.#assertNoPendingPurgeMaintenance();
    const recoveryState = this.recoveryState();
    this.#verifyRecoveryFrontierFull();
    const recoveryFrontier = this.#readRecoveryFrontierCache();
    const epoch = this.#ledgerEpoch();
    const tombstoneEpoch = this.#purge.tombstoneEpoch();
    const learningFrontier = this.#learning.frontier();
    const backupId = `backup:${randomUUID()}`;
    const directory = join(
      this.#layout.backups,
      `snapshot-${epoch}-${backupId.slice("backup:".length)}`,
    );
    const backupDatabaseDirectory = join(directory, "database");
    const backupBlobs = join(directory, "artifacts", "blobs");
    const backupCiphertext = join(directory, "artifacts", "ciphertext");
    mkdirSync(backupDatabaseDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(backupBlobs, { recursive: true, mode: 0o700 });
    mkdirSync(backupCiphertext, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    chmodSync(backupDatabaseDirectory, 0o700);
    chmodSync(backupBlobs, 0o700);
    chmodSync(backupCiphertext, 0o700);
    try {
    const path = join(backupDatabaseDirectory, "memory.db");
    const latestReceipt = this.#latestReceipt();
    const resolvedRootIdentity = this.#recoveryRootIdentity();
    await this.#database.backup(path);
    chmodSync(path, 0o600);

    const artifacts = this.#database
      .prepare(
        `SELECT content_hash, size_bytes, media_type
         FROM artifacts ORDER BY content_hash`,
      )
      .all() as Array<{
        content_hash: string;
        size_bytes: number;
        media_type: string;
      }>;
    for (const artifact of artifacts) {
      this.#blobStore.verifyExisting(
        artifact.content_hash,
        Number(artifact.size_bytes),
      );
      const filename = artifact.content_hash.slice("sha256:".length);
      const destination = join(backupBlobs, filename);
      copyFileSync(
        this.#blobStore.pathFor(artifact.content_hash),
        destination,
        constants.COPYFILE_EXCL,
      );
      chmodSync(destination, 0o600);
      const copiedDigest = createHash("sha256")
        .update(readFileSync(destination))
        .digest("hex");
      if (`sha256:${copiedDigest}` !== artifact.content_hash) {
        throw new StorageError("CORRUPTION");
      }
      fsyncPath(destination);
    }
    const ciphertextRows = this.#tableExists("encrypted_contents")
      ? this.#database
          .prepare(
            `SELECT c.ciphertext_id, c.storage_kind,
                    c.external_relative_path, c.ciphertext_hash,
                    c.ciphertext_size_bytes
             FROM encrypted_contents AS c
             JOIN encrypted_content_owners AS o
               ON o.ciphertext_id = c.ciphertext_id
             WHERE c.retired_at IS NULL AND o.active = 1
             GROUP BY c.ciphertext_id
             ORDER BY c.ciphertext_id`,
          )
          .all() as Array<{
          ciphertext_id: string;
          storage_kind: "inline" | "external";
          external_relative_path: string | null;
          ciphertext_hash: `sha256:${string}`;
          ciphertext_size_bytes: number;
        }>
      : [];
    for (const ciphertext of ciphertextRows) {
      if (ciphertext.storage_kind !== "external") {
        continue;
      }
      if (ciphertext.external_relative_path === null) {
        throw new StorageError("CORRUPTION");
      }
      const bytes = this.#encryptedArtifacts.read({
        relative_path: ciphertext.external_relative_path,
        ciphertext_hash: ciphertext.ciphertext_hash,
        size_bytes: Number(ciphertext.ciphertext_size_bytes),
      });
      const destination = join(
        backupCiphertext,
        ciphertext.ciphertext_id.replaceAll(":", "_"),
      );
      const descriptor = openSync(destination, "wx", 0o600);
      try {
        writeFileSync(descriptor, bytes);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      chmodSync(destination, 0o600);
    }
    fsyncPath(backupBlobs);
    fsyncPath(backupCiphertext);
    fsyncPath(backupDatabaseDirectory);
    fsyncPath(directory);

    const { integrityCheck, backupMigrations } = withBackupDatabase(
      path,
      (backup) => {
        const integrityCheck = String(
        backup.pragma("integrity_check", { simple: true }),
        ).toLowerCase();
        const backupEpoch = Number(
          (
            backup
              .prepare(
                "SELECT ledger_epoch FROM ledger_state WHERE singleton = 1",
              )
              .get() as { ledger_epoch: number }
          ).ledger_epoch,
        );
        const backupReceipt = backup
          .prepare(
            `SELECT receipt.receipt_hash
             FROM mutation_receipts AS receipt
             WHERE NOT EXISTS (
               SELECT 1
               FROM json_each(receipt.receipt_json, '$.warnings')
               WHERE value = 'DRY_RUN'
             )
             ORDER BY resulting_epoch DESC, receipt_id DESC LIMIT 1`,
          )
          .get() as LatestReceipt;
        const backupTombstoneEpoch = Number(
          (
            backup
              .prepare(
                `SELECT tombstone_epoch
                 FROM tombstone_state WHERE singleton = 1`,
              )
              .get() as { tombstone_epoch: number }
          ).tombstone_epoch,
        );
        const backupLearningControlEpoch = Number(
          (
            backup
              .prepare(
                `SELECT coalesce(max(control_epoch), 0) AS value
                 FROM learning_control_state`,
              )
              .get() as { value: number }
          ).value,
        );
        const backupLearningReleaseRevision = Number(
          (
            backup
              .prepare(
                `SELECT coalesce(max(pointer_revision), 0) AS value
                 FROM learning_release_pointers`,
              )
              .get() as { value: number }
          ).value,
        );
        const backupMigrations = backup
          .prepare(
            "SELECT version, name, hash, applied_at FROM schema_migrations ORDER BY version",
          )
          .all() as MigrationEvidence[];

        if (
          integrityCheck !== "ok" ||
          backupEpoch !== epoch ||
          backupTombstoneEpoch !== tombstoneEpoch ||
          backupLearningControlEpoch !== learningFrontier.control_epoch ||
          backupLearningReleaseRevision !== learningFrontier.release_revision ||
          backupReceipt?.receipt_hash !== latestReceipt?.receipt_hash ||
          canonicalJson(backupMigrations) !== canonicalJson(this.#migrations)
        ) {
          throw new StorageError("CORRUPTION");
        }
        return { integrityCheck, backupMigrations };
      },
    );

    const sizeBytes = statSync(path).size;
    const purgeDebtCount = Number(
      (
        this.#database
          .prepare(
            `SELECT coalesce(sum(debt_count), 0) AS value
             FROM artifact_purge_frontiers`,
          )
          .get() as { value: number }
      ).value,
    );
    const pointerRows = this.#database
      .prepare(
        `SELECT release_slot_hash, active_release_id, pointer_revision,
                pointer_hash
         FROM learning_release_pointers ORDER BY release_slot_hash`,
      )
      .all();
    const monitorRows = this.#database
      .prepare(
        `SELECT monitor_id, monitor_hash
         FROM learning_monitor_results ORDER BY monitored_at, monitor_id`,
      )
      .all() as Array<{ monitor_id: string; monitor_hash: string }>;
    const rollbackRows = this.#database
      .prepare(
        `SELECT release_id, release_hash
         FROM learning_release_versions
         WHERE action = 'rollback'
         ORDER BY activated_at, release_id`,
      )
      .all() as Array<{ release_id: string; release_hash: string }>;
    const g6Control = this.#database
      .prepare(
        `SELECT control_hash FROM g6_release_controls LIMIT 1`,
      )
      .get() as { control_hash: string } | undefined;
    const ftsState = this.#fts.state();
    const keyInventory = this.#keys.inventory();
    const artifactDescriptors = [
      ...artifacts.map((artifact) => ({
        kind: "blob" as const,
        artifact_id: artifact.content_hash,
        storage_kind: "external" as const,
        bundle_path:
          `artifacts/blobs/${artifact.content_hash.slice("sha256:".length)}`,
        raw_hash: artifact.content_hash,
        size_bytes: Number(artifact.size_bytes),
      })),
      ...ciphertextRows.map((ciphertext) => ({
        kind: "ciphertext" as const,
        artifact_id: ciphertext.ciphertext_id,
        storage_kind: ciphertext.storage_kind,
        bundle_path:
          ciphertext.storage_kind === "inline"
            ? null
            : `artifacts/ciphertext/${ciphertext.ciphertext_id.replaceAll(":", "_")}`,
        raw_hash: ciphertext.ciphertext_hash,
        size_bytes: Number(ciphertext.ciphertext_size_bytes),
      })),
    ];
    const databaseRawHash = rawFileHash(path);
    const manifest = sealCompleteBackupManifest({
      schema_version: "1.0.0",
      backup_id: backupId,
      created_at: now(),
      root_identity: resolvedRootIdentity,
      database: {
        bundle_path: "database/memory.db",
        raw_hash: databaseRawHash,
        size_bytes: sizeBytes,
        logical_hash: backupDatabaseLogicalHash(path),
      },
      artifacts: artifactDescriptors,
      schema: {
        current_version:
          backupMigrations.at(-1)?.version ??
          (() => {
            throw new StorageError("MIGRATION_DRIFT");
          })(),
        migration_set_hash: canonicalSha256(backupMigrations),
        migrations: backupMigrations,
      },
      frontiers: {
        ledger_epoch: epoch,
        latest_receipt_hash: latestReceipt?.receipt_hash ?? null,
        tombstone_epoch: tombstoneEpoch,
        purge_frontier_hash:
          recoveryFrontier.metadata.component_hashes.purge,
        purge_debt_count: purgeDebtCount,
        fts_frontier_hash: canonicalSha256(ftsState),
        fts_logical_frontier_hash:
          recoveryFrontier.metadata.component_hashes.fts,
        layered_frontier_hash:
          recoveryFrontier.metadata.component_hashes.layered,
        relation_frontier_hash:
          recoveryFrontier.metadata.component_hashes.relation,
        context_frontier_hash:
          recoveryFrontier.metadata.component_hashes.context,
        learning_control_epoch: learningFrontier.control_epoch,
        learning_release_revision: learningFrontier.release_revision,
        learning_frontier_hash:
          recoveryFrontier.metadata.component_hashes.learning,
        learning_pointer_hash: canonicalSha256(pointerRows),
        learning_monitor_hash:
          monitorRows.length === 0 ? null : canonicalSha256(monitorRows),
        learning_rollback_hash:
          rollbackRows.length === 0 ? null : canonicalSha256(rollbackRows),
        encryption_frontier_hash:
          recoveryState.minimums.encryption_frontier_hash,
        g6_release_control_hash: g6Control?.control_hash ?? null,
      },
      encryption: {
        format_version: 1,
        required_keys: keyInventory.keys
          .filter(
            ({ key_id, state }) =>
              state === "current" ||
              state === "rotating_to" ||
              state === "retired" ||
              (state === "revoked_or_compromised" &&
                (recoveryState.minimums.key_live_ciphertexts.find(
                  (key) => key.key_id === key_id,
                )?.live_ciphertext_count ?? 0) > 0),
          )
          .map(({ key_id, generation, state }) => ({
            key_id,
            key_generation: generation,
            state,
          })),
        key_live_ciphertexts:
          recoveryState.minimums.key_live_ciphertexts,
      },
      decisions: ACCEPTED_RECOVERY_DECISIONS,
      creation_identity: {
        config_hash: canonicalSha256({
          busy_timeout_ms: this.#busyTimeoutMs,
          schema_version: backupMigrations.at(-1)?.version,
          principal_id: this.#principalId,
        }),
        environment_hash: canonicalSha256({
          platform: process.platform,
          architecture: process.arch,
          node_version: process.versions.node,
          filesystem_type: this.#layout.filesystem_type,
        }),
        filesystem_type: this.#layout.filesystem_type,
        platform: process.platform,
        architecture: process.arch,
        node_version: process.versions.node,
      },
    });
    const manifestPath = writeCompleteBackupManifest(directory, manifest);
    this.#database
      .transaction(() => {
        this.#database
      .prepare(
        `INSERT INTO backup_manifests (
           backup_id, relative_path, created_at, ledger_epoch,
           tombstone_epoch,
           learning_control_epoch, learning_release_revision,
           latest_receipt_hash, migration_hashes_json, blob_hashes_json,
           size_bytes, integrity_check
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        backupId,
        `backups/${basename(directory)}/database/memory.db`,
        now(),
        epoch,
        tombstoneEpoch,
        learningFrontier.control_epoch,
        learningFrontier.release_revision,
        latestReceipt?.receipt_hash ?? null,
        canonicalJson(this.#migrations),
        canonicalJson(artifacts.map((artifact) => artifact.content_hash)),
        sizeBytes,
        integrityCheck,
      );
        this.#database
          .prepare(
            `INSERT INTO complete_backup_manifests (
               backup_id, manifest_hash, database_raw_hash,
               database_logical_hash, root_id, principal_id,
               manifest_json, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            backupId,
            manifest.manifest_hash,
            manifest.database.raw_hash,
            manifest.database.logical_hash,
            manifest.root_identity.root_id,
            manifest.root_identity.principal_id,
            canonicalJson(manifest),
            manifest.created_at,
          );
        const insertArtifact = this.#database.prepare(
          `INSERT INTO backup_artifact_inventory (
             backup_id, artifact_id, artifact_kind, storage_kind,
             bundle_path, raw_hash, size_bytes
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const artifact of manifest.artifacts) {
          insertArtifact.run(
            backupId,
            artifact.artifact_id,
            artifact.kind,
            artifact.storage_kind,
            artifact.bundle_path,
            artifact.raw_hash,
            artifact.size_bytes,
          );
        }
      })();

    return {
      backup_id: backupId,
      directory,
      path,
      ledger_epoch: epoch,
      tombstone_epoch: tombstoneEpoch,
      learning_control_epoch: learningFrontier.control_epoch,
      learning_release_revision: learningFrontier.release_revision,
      learning_frontier_hash:
        manifest.frontiers.learning_frontier_hash,
      latest_receipt_hash: latestReceipt?.receipt_hash ?? null,
      blob_hashes: artifacts.map((artifact) => artifact.content_hash),
      integrity_check: "ok",
      size_bytes: sizeBytes,
      manifest_path: manifestPath,
      manifest,
    };
    } catch (error) {
      if (existsSync(directory)) {
        rmSync(directory, { recursive: true, force: true });
        fsyncPath(this.#layout.backups);
      }
      throw error;
    }
  }

  verifyArtifacts(): { verified: number } {
    const artifacts = this.#database
      .prepare(
        "SELECT content_hash, size_bytes FROM artifacts ORDER BY content_hash",
      )
      .all() as Array<{ content_hash: string; size_bytes: number }>;
    for (const artifact of artifacts) {
      this.#blobStore.verifyExisting(
        artifact.content_hash,
        Number(artifact.size_bytes),
      );
    }
    return { verified: artifacts.length };
  }

  verifyRestoreCandidate(): RestoreVerificationResult {
    try {
      return this.#verifyRestoreCandidate();
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError("CORRUPTION");
    }
  }

  #verifyRestoreCandidate(): RestoreVerificationResult {
    this.#assertNoPendingPurgeMaintenance();
    const integrityRows = this.#database.pragma(
      "integrity_check",
    ) as Array<Record<string, unknown>>;
    if (
      integrityRows.length !== 1 ||
      Object.values(integrityRows[0] ?? {})[0] !== "ok"
    ) {
      throw new StorageError("CORRUPTION");
    }
    const foreignKeyViolations = (
      this.#database.pragma("foreign_key_check") as unknown[]
    ).length;
    if (foreignKeyViolations !== 0) {
      throw new StorageError("CORRUPTION");
    }

    this.#verifyRecoveryFrontierFull();

    const artifacts = this.verifyArtifacts();
    const encryptedContents = this.#tableExists("encrypted_contents")
      ? this.#database
          .prepare(
            `SELECT c.storage_kind, c.ciphertext,
                    c.external_relative_path, c.ciphertext_hash,
                    c.ciphertext_size_bytes
             FROM encrypted_contents AS c
             JOIN encrypted_content_owners AS o
               ON o.ciphertext_id = c.ciphertext_id
             WHERE c.retired_at IS NULL AND o.active = 1
             GROUP BY c.ciphertext_id
             ORDER BY c.ciphertext_id`,
          )
          .all() as Array<{
          storage_kind: "inline" | "external";
          ciphertext: Buffer | null;
          external_relative_path: string | null;
          ciphertext_hash: string;
          ciphertext_size_bytes: number;
        }>
      : [];
    for (const encrypted of encryptedContents) {
      if (encrypted.storage_kind === "external") {
        if (encrypted.external_relative_path === null) {
          throw new StorageError("CORRUPTION");
        }
        this.#encryptedArtifacts.read({
          relative_path: encrypted.external_relative_path,
          ciphertext_hash: encrypted.ciphertext_hash,
          size_bytes: Number(encrypted.ciphertext_size_bytes),
        });
        continue;
      }
      if (
        encrypted.ciphertext === null ||
        encrypted.ciphertext.byteLength !==
          Number(encrypted.ciphertext_size_bytes) ||
        `sha256:${createHash("sha256")
          .update(encrypted.ciphertext)
          .digest("hex")}` !== encrypted.ciphertext_hash
      ) {
        throw new StorageError("CORRUPTION");
      }
    }
    const memoryViolations = Number(
      (
        this.#database
          .prepare(
            `SELECT count(*) AS count
             FROM memory_objects AS o
             LEFT JOIN memory_revisions AS r
               ON r.revision_id = o.current_revision_id
             WHERE (
               o.lifecycle = 'active'
               AND (
                 o.current_revision_id IS NULL
                 OR r.revision_id IS NULL
                 OR r.memory_id <> o.memory_id
                 OR r.lifecycle <> 'active'
                 OR r.purged_at IS NOT NULL
               )
             )
                OR (
                  o.lifecycle = 'purged'
                  AND (
                    o.current_revision_id IS NOT NULL
                    OR o.context_eligible <> 0
                  )
                )
                OR (
                  r.revision_id IS NOT NULL
                  AND r.memory_id <> o.memory_id
                )`,
          )
          .get() as { count: number }
      ).count,
    );
    const redactionViolations = Number(
      (
        this.#database
          .prepare(
            `SELECT
               (
                 SELECT count(*) FROM evidence_events
                 WHERE purged_at IS NOT NULL
                   AND (
                     payload_storage <> 'inline'
                     OR payload_inline <> '[PURGED]'
                     OR payload_blob_hash IS NOT NULL
                     OR media_type <> 'application/x.memo-graph-redacted'
                   )
               ) +
               (
                 SELECT count(*) FROM memory_revisions
                 WHERE purged_at IS NOT NULL
                   AND (
                     lifecycle <> 'purged'
                     OR content_storage <> 'redacted'
                     OR content_inline IS NOT NULL
                     OR content_blob_hash IS NOT NULL
                     OR media_type <> 'application/x.memo-graph-redacted'
                   )
               ) +
               (
                 SELECT count(*) FROM memory_candidates
                 WHERE purged_at IS NOT NULL
                   AND (
                     content_storage <> 'redacted'
                     OR content_inline IS NOT NULL
                     OR content_blob_hash IS NOT NULL
                     OR media_type <> 'application/x.memo-graph-redacted'
                   )
               ) +
               (
                 SELECT count(*) FROM projection_revisions
                 WHERE purged_at IS NOT NULL
                   AND (
                     lifecycle <> 'purged'
                     OR payload_json IS NOT NULL
                     OR content_json IS NOT NULL
                     OR json_extract(revision_json, '$.lifecycle')
                       <> 'purged'
                     OR json_type(revision_json, '$.payload') <> 'null'
                     OR json_type(revision_json, '$.content') <> 'null'
                   )
               ) +
               (
                 SELECT count(*) FROM relation_revisions
                 WHERE lifecycle = 'purged'
                   AND (
                     description IS NOT NULL
                     OR json_type(relation_json, '$.description') <> 'null'
                   )
               ) AS count`,
          )
          .get() as { count: number }
      ).count,
    );
    if (memoryViolations !== 0 || redactionViolations !== 0) {
      throw new StorageError("CORRUPTION");
    }

    const activeProjectionRows = this.#database
      .prepare(
        `SELECT o.projection_id, o.current_revision_id, r.revision_json
         FROM projection_objects AS o
         JOIN projection_revisions AS r
           ON r.projection_revision_id = o.current_revision_id
         WHERE o.lifecycle = 'active'
           AND r.lifecycle = 'active'
           AND r.purged_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM projection_invalidations AS i
             WHERE i.projection_revision_id = r.projection_revision_id
           )
         ORDER BY o.projection_id`,
      )
      .all() as Array<{
        projection_id: string;
        current_revision_id: string;
        revision_json: string;
      }>;
    const activeProjectionObjectCount = Number(
      (
        this.#database
          .prepare(
            `SELECT count(*) AS count FROM projection_objects
             WHERE lifecycle = 'active'`,
          )
          .get() as { count: number }
      ).count,
    );
    if (activeProjectionRows.length !== activeProjectionObjectCount) {
      throw new StorageError("CORRUPTION");
    }
    for (const row of activeProjectionRows) {
      let projection: ParsedProjectionRevision;
      try {
        projection = ProjectionRevisionSchema.parse(
          JSON.parse(row.revision_json) as unknown,
        );
      } catch {
        throw new StorageError("CORRUPTION");
      }
      if (
        projection.projection_id !== row.projection_id ||
        projection.projection_revision_id !== row.current_revision_id ||
        projection.lifecycle !== "active" ||
        projection.payload === null ||
        projection.content === null
      ) {
        throw new StorageError("CORRUPTION");
      }
      const sourceRows = this.#database
        .prepare(
          `SELECT ordinal, source_revision_id,
                  coalesce(source_memory_id, source_projection_id)
                    AS source_identity_id,
                  source_abstraction, source_content_hash,
                  source_principal_id, source_scope_kind, source_scope_id,
                  source_authority, source_sensitivity,
                  source_valid_from, source_valid_to,
                  source_recorded_at, evidence_ids_json
           FROM projection_revision_sources
           WHERE projection_revision_id = ?
           ORDER BY ordinal`,
        )
        .all(row.current_revision_id) as Array<{
          ordinal: number;
          source_revision_id: string;
          source_identity_id: string;
          source_abstraction: string;
          source_content_hash: string;
          source_principal_id: string;
          source_scope_kind: string;
          source_scope_id: string;
          source_authority: string;
          source_sensitivity: string;
          source_valid_from: string;
          source_valid_to: string | null;
          source_recorded_at: string;
          evidence_ids_json: string;
        }>;
      if (
        sourceRows.length !== projection.source_revisions.length ||
        sourceRows.some((sourceRow, index) => {
          const source = projection.source_revisions[index];
          return (
            source === undefined ||
            sourceRow.ordinal !== index ||
            sourceRow.source_identity_id !== source.memory_id ||
            sourceRow.source_revision_id !== source.revision_id ||
            sourceRow.source_abstraction !== source.abstraction ||
            sourceRow.source_content_hash !== source.content_hash ||
            sourceRow.source_principal_id !== source.principal_id ||
            sourceRow.source_scope_kind !== source.scope.kind ||
            sourceRow.source_scope_id !== source.scope.id ||
            sourceRow.source_authority !== source.authority ||
            sourceRow.source_sensitivity !== source.sensitivity ||
            sourceRow.source_valid_from !== source.validity.valid_from ||
            sourceRow.source_valid_to !== source.validity.valid_to ||
            sourceRow.source_recorded_at !== source.validity.recorded_at ||
            canonicalJson(
              JSON.parse(sourceRow.evidence_ids_json) as unknown,
            ) !== canonicalJson(source.evidence_ids)
          );
        })
      ) {
        throw new StorageError("CORRUPTION");
      }
      for (const source of projection.source_revisions) {
        const sourceRow =
          source.abstraction === "l1_memory"
            ? this.#database
                .prepare(
                  `SELECT o.current_revision_id, o.lifecycle,
                          r.lifecycle AS revision_lifecycle,
                          r.content_hash
                   FROM memory_objects AS o
                   JOIN memory_revisions AS r
                     ON r.revision_id = o.current_revision_id
                   WHERE o.memory_id = ? AND r.revision_id = ?`,
                )
                .get(source.memory_id, source.revision_id)
            : this.#database
                .prepare(
                  `SELECT o.current_revision_id, o.lifecycle,
                          r.lifecycle AS revision_lifecycle,
                          r.content_hash
                   FROM projection_objects AS o
                   JOIN projection_revisions AS r
                     ON r.projection_revision_id =
                       o.current_revision_id
                   WHERE o.projection_id = ?
                     AND r.projection_revision_id = ?
                     AND r.purged_at IS NULL
                     AND NOT EXISTS (
                       SELECT 1
                       FROM projection_invalidations AS i
                       WHERE i.projection_revision_id =
                         r.projection_revision_id
                     )`,
                )
                .get(source.memory_id, source.revision_id);
        const parsedSource = sourceRow as
          | {
              current_revision_id: string;
              lifecycle: string;
              revision_lifecycle: string;
              content_hash: string;
            }
          | undefined;
        if (
          parsedSource === undefined ||
          parsedSource.current_revision_id !== source.revision_id ||
          parsedSource.lifecycle !== "active" ||
          parsedSource.revision_lifecycle !== "active" ||
          parsedSource.content_hash !== source.content_hash
        ) {
          throw new StorageError("CORRUPTION");
        }
      }
    }

    const activeRelationRows = this.#database
      .prepare(
        `SELECT ro.relation_id, rr.relation_revision_id,
                rr.relation_json, pr.revision_json
         FROM relation_objects AS ro
         JOIN relation_revisions AS rr
           ON rr.relation_revision_id =
             ro.current_relation_revision_id
         JOIN projection_objects AS po
           ON po.projection_id = rr.relation_id
          AND po.current_revision_id = rr.projection_revision_id
         JOIN projection_revisions AS pr
           ON pr.projection_revision_id = rr.projection_revision_id
         WHERE ro.lifecycle = 'active'
           AND rr.lifecycle = 'active'
           AND po.lifecycle = 'active'
           AND pr.lifecycle = 'active'
           AND pr.purged_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM projection_invalidations AS i
             WHERE i.projection_revision_id =
               rr.projection_revision_id
           )
         ORDER BY ro.relation_id`,
      )
      .all() as Array<{
        relation_id: string;
        relation_revision_id: string;
        relation_json: string;
        revision_json: string;
      }>;
    const activeRelationObjectCount = Number(
      (
        this.#database
          .prepare(
            `SELECT count(*) AS count FROM relation_objects
             WHERE lifecycle = 'active'`,
          )
          .get() as { count: number }
      ).count,
    );
    if (activeRelationRows.length !== activeRelationObjectCount) {
      throw new StorageError("CORRUPTION");
    }
    for (const row of activeRelationRows) {
      let projection: ParsedProjectionRevision;
      try {
        projection = ProjectionRevisionSchema.parse(
          JSON.parse(row.revision_json) as unknown,
        );
      } catch {
        throw new StorageError("CORRUPTION");
      }
      if (
        projection.projection_id !== row.relation_id ||
        projection.projection_revision_id !==
          row.relation_revision_id ||
        projection.payload?.kind !== "relation" ||
        canonicalJson(projection.payload) !==
          canonicalJson(JSON.parse(row.relation_json) as unknown)
      ) {
        throw new StorageError("CORRUPTION");
      }
    }
    const projectionState = this.#projections.state();
    const projectionRebuildRequired =
      projectionState.status !== "ready" ||
      projectionState.ledger_epoch !== this.#ledgerEpoch() ||
      projectionState.tombstone_epoch !== this.#purge.tombstoneEpoch();

    const contextRows = this.#database
      .prepare(
        `SELECT context_slice_id, slice_json
         FROM context_slices ORDER BY context_slice_id`,
      )
      .all() as Array<{ context_slice_id: string; slice_json: string }>;
    for (const row of contextRows) {
      const slice = ContextSliceSchema.parse(
        JSON.parse(row.slice_json) as unknown,
      );
      if (
        slice.context_slice_id !== row.context_slice_id ||
        canonicalSha256Omitting(slice, ["frozen_hash"]) !== slice.frozen_hash
      ) {
        throw new StorageError("CORRUPTION");
      }
      const itemRows = this.#database
        .prepare(
          `SELECT ordinal, item_json
           FROM context_slice_items
           WHERE context_slice_id = ?
           ORDER BY ordinal`,
        )
        .all(row.context_slice_id) as Array<{
        ordinal: number;
        item_json: string;
      }>;
      if (
        itemRows.length !== slice.items.length ||
        itemRows.some(
          (item, index) =>
            item.ordinal !== index ||
            canonicalJson(JSON.parse(item.item_json) as unknown) !==
              canonicalJson(slice.items[index]),
        )
      ) {
        throw new StorageError("CORRUPTION");
      }
    }

    const receiptRows = this.#database
      .prepare(
        `SELECT receipt_json FROM mutation_receipts
         UNION ALL
         SELECT receipt_json FROM retrieval_receipts
         UNION ALL
         SELECT receipt_json FROM purge_receipts`,
      )
      .all() as Array<{ receipt_json: string }>;
    for (const row of receiptRows) {
      const receipt = ReceiptSchema.parse(
        JSON.parse(row.receipt_json) as unknown,
      );
      if (!receiptHashIsValid(receipt)) {
        throw new StorageError("CORRUPTION");
      }
    }

    const purgeJobs = this.#database
      .prepare(
        `SELECT purge_job_id, status
         FROM purge_jobs ORDER BY tombstone_epoch`,
      )
      .all() as Array<{
      purge_job_id: string;
      status: "pending" | "running" | "partial" | "completed" | "failed";
    }>;
    let incompletePurgeJobs = 0;
    const residualHashes: string[] = [];
    for (const job of purgeJobs) {
      const receiptRow = this.#database
        .prepare(
          `SELECT receipt_json FROM purge_receipts
           WHERE purge_job_id = ?
           ORDER BY created_at DESC, receipt_id DESC LIMIT 1`,
        )
        .get(job.purge_job_id) as { receipt_json: string } | undefined;
      if (
        job.status === "pending" ||
        job.status === "running" ||
        job.status === "failed" ||
        receiptRow === undefined
      ) {
        throw new StorageError("INCOMPLETE_PURGE");
      }
      const receipt = ReceiptSchema.parse(
        JSON.parse(receiptRow.receipt_json) as unknown,
      );
      if (
        receipt.kind !== "purge" ||
        receipt.purge_job_id !== job.purge_job_id ||
        !receiptHashIsValid(receipt)
      ) {
        throw new StorageError("CORRUPTION");
      }
      if (job.status === "completed") {
        if (!receipt.completed || receipt.residual_hashes.length !== 0) {
          throw new StorageError("CORRUPTION");
        }
        continue;
      }
      if (
        receipt.completed ||
        receipt.residual_hashes.length === 0 ||
        receipt.store_outcomes.some((outcome) => outcome.status === "failed")
      ) {
        throw new StorageError("CORRUPTION");
      }
      incompletePurgeJobs += 1;
      residualHashes.push(...receipt.residual_hashes);
    }

    const learningTraceRows = this.#database
      .prepare(
        "SELECT trace_id, trace_hash, artifact_json FROM learning_traces",
      )
      .all() as Array<{
      trace_id: string;
      trace_hash: string;
      artifact_json: string;
    }>;
    for (const row of learningTraceRows) {
      const trace = LearningTraceSchema.parse(
        JSON.parse(row.artifact_json) as unknown,
      );
      if (
        trace.trace_id !== row.trace_id ||
        trace.trace_hash !== row.trace_hash
      ) {
        throw new StorageError("CORRUPTION");
      }
    }
    const learningCandidateRows = this.#database
      .prepare(
        `SELECT candidate_id, candidate_hash, artifact_json
         FROM learning_candidates`,
      )
      .all() as Array<{
      candidate_id: string;
      candidate_hash: string;
      artifact_json: string;
    }>;
    for (const row of learningCandidateRows) {
      const candidate = CandidateChangeSchema.parse(
        JSON.parse(row.artifact_json) as unknown,
      );
      if (
        candidate.candidate_id !== row.candidate_id ||
        candidate.candidate_hash !== row.candidate_hash
      ) {
        throw new StorageError("CORRUPTION");
      }
    }
    const learningReleaseRows = this.#database
      .prepare(
        `SELECT release_id, release_hash, artifact_json
         FROM learning_release_versions`,
      )
      .all() as Array<{
      release_id: string;
      release_hash: string;
      artifact_json: string;
    }>;
    for (const row of learningReleaseRows) {
      const release = LearningReleaseVersionSchema.parse(
        JSON.parse(row.artifact_json) as unknown,
      );
      if (
        release.release_id !== row.release_id ||
        release.release_hash !== row.release_hash
      ) {
        throw new StorageError("CORRUPTION");
      }
    }
    const learningPointerRows = this.#database
      .prepare(
        `SELECT release_slot_hash, active_release_id, pointer_revision,
                artifact_json
         FROM learning_release_pointers`,
      )
      .all() as Array<{
      release_slot_hash: string;
      active_release_id: string | null;
      pointer_revision: number;
      artifact_json: string;
    }>;
    for (const row of learningPointerRows) {
      const pointer = ReleasePointerSchema.parse(
        JSON.parse(row.artifact_json) as unknown,
      );
      if (
        pointer.release_slot_hash !== row.release_slot_hash ||
        pointer.active_release_id !== row.active_release_id ||
        pointer.pointer_revision !== Number(row.pointer_revision)
      ) {
        throw new StorageError("CORRUPTION");
      }
    }
    const learningControlRows = this.#database
      .prepare(
        `SELECT principal_id, control_epoch, frontier_hash, artifact_json
         FROM learning_control_state`,
      )
      .all() as Array<{
      principal_id: string;
      control_epoch: number;
      frontier_hash: string;
      artifact_json: string;
    }>;
    for (const row of learningControlRows) {
      const control = LearningControlSchema.parse(
        JSON.parse(row.artifact_json) as unknown,
      );
      if (
        control.principal_id !== row.principal_id ||
        control.control_epoch !== Number(row.control_epoch) ||
        control.frontier_hash !== row.frontier_hash
      ) {
        throw new StorageError("CORRUPTION");
      }
    }

    return {
      integrity_check: "ok",
      foreign_key_violations: 0,
      verified_artifacts: artifacts.verified,
      verified_encrypted_contents: encryptedContents.length,
      active_memories_verified: Number(
        (
          this.#database
            .prepare(
              `SELECT count(*) AS count FROM memory_objects
               WHERE lifecycle = 'active'`,
            )
            .get() as { count: number }
        ).count,
      ),
      active_projections_verified: activeProjectionRows.length,
      active_relations_verified: activeRelationRows.length,
      projection_rebuild_required: projectionRebuildRequired,
      context_slices_verified: contextRows.length,
      receipts_verified: receiptRows.length,
      purge_jobs_verified: purgeJobs.length,
      learning_traces_verified: learningTraceRows.length,
      learning_candidates_verified: learningCandidateRows.length,
      learning_releases_verified: learningReleaseRows.length,
      learning_control_rows_verified: learningControlRows.length,
      incomplete_purge_jobs: incompletePurgeJobs,
      residual_hashes: [...new Set(residualHashes)].sort(),
    };
  }

  getEvidence(
    input: unknown,
  ): ReturnType<typeof EvidenceRecordSchema.parse> | null {
    const request = EvidenceLookupInputSchema.parse(input);
    const row = this.#database
      .prepare(
        `SELECT e.*, a.size_bytes AS artifact_size_bytes
         FROM evidence_events AS e
         LEFT JOIN artifacts AS a ON a.content_hash = e.payload_blob_hash
         WHERE e.evidence_id = ?
           AND e.principal_id = ?
           AND e.scope_kind = ?
           AND e.scope_id = ?
           AND e.purged_at IS NULL`,
      )
      .get(
        request.evidence_id,
        request.principal_id,
        request.scope.kind,
        request.scope.id,
      ) as EvidenceRow | undefined;
    return row === undefined ? null : this.#evidenceFromRow(row);
  }

  explainEvidence(input: unknown): EvidenceExplanation | null {
    const request = EvidenceLookupInputSchema.parse(input);
    const evidence = this.getEvidence(request);
    if (evidence === null) {
      return null;
    }
    const episodeRows = this.#database
      .prepare(
        `SELECT e.*
         FROM episodes AS e
         JOIN episode_events AS ee ON ee.episode_id = e.episode_id
         WHERE ee.evidence_id = ?
         ORDER BY e.ended_at DESC, e.episode_id`,
      )
      .all(evidence.evidence_id) as EpisodeRow[];
    const episodes = episodeRows.map((row) => {
      const eventIds = (
        this.#database
          .prepare(
            `SELECT evidence_id FROM episode_events
             WHERE episode_id = ? ORDER BY ordinal`,
          )
          .all(row.episode_id) as Array<{ evidence_id: string }>
      ).map((event) => event.evidence_id);
      return EpisodeSchema.parse({
        schema_version: row.schema_version,
        episode_id: row.episode_id,
        scope: { kind: row.scope_kind, id: row.scope_id },
        started_at: row.started_at,
        ended_at: row.ended_at,
        event_ids: eventIds,
        artifact_hashes: JSON.parse(row.artifact_hashes_json) as unknown,
        outcome: row.outcome,
        sealed_hash: row.sealed_hash,
      });
    });
    return EvidenceExplanationSchema.parse({ evidence, episodes });
  }

  getReceipt(input: unknown): ReturnType<typeof ReceiptSchema.parse> | null {
    const request = ReceiptLookupInputSchema.parse(input);
    const allowedScopes = new Set(
      request.scopes.map((scope) => `${scope.kind}:${scope.id}`),
    );
    const access = this.#database
      .prepare(
        `SELECT scope_kind, scope_id
         FROM receipt_access_scopes
         WHERE receipt_id = ? AND principal_id = ?
         ORDER BY scope_kind, scope_id`,
      )
      .all(request.receipt_id, request.principal_id) as Array<{
      scope_kind: string;
      scope_id: string;
    }>;
    if (
      access.length === 0 ||
      access.some(
        (scope) =>
          !allowedScopes.has(`${scope.scope_kind}:${scope.scope_id}`),
      )
    ) {
      return null;
    }
    const row =
      (this.#database
        .prepare(
          "SELECT receipt_json FROM mutation_receipts WHERE receipt_id = ?",
        )
        .get(request.receipt_id) as { receipt_json: string } | undefined) ??
      (this.#database
        .prepare(
          "SELECT receipt_json FROM retrieval_receipts WHERE receipt_id = ?",
        )
        .get(request.receipt_id) as { receipt_json: string } | undefined);
    if (row === undefined) {
      return null;
    }
    const receipt = ReceiptSchema.parse(
      JSON.parse(row.receipt_json) as unknown,
    );
    if (!receiptHashIsValid(receipt)) {
      throw new StorageError("CORRUPTION");
    }
    return receipt;
  }

  recordRecall(input: unknown): RecordRecallResult {
    const command = RecordRecallCommandSchema.parse(input);
    this.#validateRecall(command);
    const hash = canonicalSha256(command.request);
    const existing = this.#readRecall(command.request.request_id);
    if (existing !== undefined) {
      return this.#parseExistingRecall(
        existing,
        hash,
        command.principal_id,
      );
    }

    try {
      return this.#database
        .transaction(() => {
          const repeated = this.#readRecall(command.request.request_id);
          if (repeated !== undefined) {
            return this.#parseExistingRecall(
              repeated,
              hash,
              command.principal_id,
            );
          }
          this.#insertRecall(command);
          return {
            receipt: command.receipt,
            context_slice: command.context_slice ?? null,
            replayed: false,
          };
        })
        .immediate();
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string" &&
        error.code.startsWith("SQLITE_CONSTRAINT")
      ) {
        throw new StorageError("CONFLICT");
      }
      throw error;
    }
  }

  blockForTest(milliseconds: number): void {
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)),
      0,
      0,
      milliseconds,
    );
  }

  generateRecoveryFrontierChangesForTest(count: number): void {
    if (
      !this.#testOperations ||
      !Number.isSafeInteger(count) ||
      count < 1 ||
      count > MAX_RECOVERY_FRONTIER_CHANGES_PER_EFFECT + 1
    ) {
      throw new StorageError("INVALID_INPUT");
    }
    const update = this.#database.prepare(
      `UPDATE projection_state
       SET last_epoch = last_epoch + 1
       WHERE projection_name = 'fts'`,
    );
    for (let index = 0; index < count; index += 1) {
      if (update.run().changes !== 1) {
        throw new StorageError("CORRUPTION");
      }
    }
  }

  holdWriteLockForTest(milliseconds: number): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.blockForTest(milliseconds);
    } finally {
      this.#database.exec("ROLLBACK");
    }
  }

  close(): void {
    if (this.#database.open) {
      if (!this.#inspectionOnly) {
        this.checkpoint();
      }
      this.#database.close();
    }
  }

  #validateEpisode(command: ParsedCommitEpisodeCommand): void {
    const episode = EpisodeSchema.parse(command.episode);
    const evidence = command.evidence.map((record) =>
      EvidenceRecordSchema.parse(record),
    );
    const evidenceById = new Map(
      evidence.map((record) => [record.evidence_id, record]),
    );
    if (
      evidenceById.size !== evidence.length ||
      episode.event_ids.length !== evidence.length
    ) {
      throw new StorageError("INVALID_INPUT");
    }

    const ordered = [...evidence].sort(
      (left, right) => left.sequence - right.sequence,
    );
    ordered.forEach((record, index) => {
      if (record.sensitivity === "secret") {
        throw new StorageError("ENCRYPTION_REQUIRED");
      }
      if (
        record.sequence !== index ||
        episode.event_ids[index] !== record.evidence_id ||
        !sameScope(record.scope, episode.scope)
      ) {
        throw new StorageError("INVALID_INPUT");
      }
      if (
        record.payload.storage === "inline" &&
        canonicalSha256(record.payload) !== record.content_hash
      ) {
        throw new StorageError("INVALID_INPUT");
      }
      if (
        record.payload.storage === "blob" &&
        record.payload.content_hash !== record.content_hash
      ) {
        throw new StorageError("INVALID_INPUT");
      }
    });

    if (
      canonicalSha256Omitting(episode, ["sealed_hash"]) !== episode.sealed_hash
    ) {
      throw new StorageError("INVALID_INPUT");
    }

    const blobReferences = evidence
      .filter((record) => record.payload.storage === "blob")
      .map((record) => record.content_hash);
    assertSetEqual(blobReferences, episode.artifact_hashes);
    const suppliedBlobHashes: string[] = command.blobs.map(
      (blob) => blob.content_hash,
    );
    for (const blob of command.blobs) {
      const actual = createHash("sha256").update(blob.bytes).digest("hex");
      if (`sha256:${actual}` !== blob.content_hash) {
        throw new StorageError("INVALID_INPUT");
      }
    }
    const referencedHashes = new Set<string>(blobReferences);
    if (
      new Set(suppliedBlobHashes).size !== suppliedBlobHashes.length ||
      suppliedBlobHashes.some((hash) => !referencedHashes.has(hash))
    ) {
      throw new StorageError("INVALID_INPUT");
    }
  }

  #validateRecall(command: ParsedRecordRecallCommand): void {
    const request = RecallRequestSchema.parse(command.request);
    const receipt = RetrievalReceiptSchema.parse(command.receipt);
    const expectedRequestHash = canonicalSha256(request);
    if (
      receipt.request_hash !== expectedRequestHash ||
      !receiptHashIsValid(receipt)
    ) {
      throw new StorageError("INVALID_INPUT");
    }

    const contextSlice =
      command.context_slice === undefined
        ? null
        : ContextSliceSchema.parse(command.context_slice);
    if (contextSlice === null) {
      if (receipt.context_slice_id !== null) {
        throw new StorageError("INVALID_INPUT");
      }
      return;
    }
    if (
      contextSlice.request_id !== request.request_id ||
      receipt.context_slice_id !== contextSlice.context_slice_id ||
      contextSlice.compiler_version !== receipt.compiler_version ||
      contextSlice.token_budget !== request.token_budget ||
      (contextSlice.policy_version !== undefined &&
        contextSlice.policy_version !== receipt.policy_version) ||
      canonicalJson(contextSlice.frontier ?? null) !==
        canonicalJson(receipt.frontier ?? null) ||
      canonicalJson(
        contextSlice.effective_lane_configuration ?? null,
      ) !== canonicalJson(
        receipt.effective_lane_configuration ?? null,
      ) ||
      canonicalJson(contextSlice.lane_telemetry ?? null) !==
        canonicalJson(receipt.lane_telemetry ?? null) ||
      canonicalSha256Omitting(contextSlice, ["frozen_hash"]) !==
        contextSlice.frozen_hash
    ) {
      throw new StorageError("INVALID_INPUT");
    }

    const allowedScopes = new Set(
      request.scopes.map((scope) => `${scope.kind}:${scope.id}`),
    );
    const includedMemoryIds = new Set(
      receipt.items
        .filter((item) => item.decision === "included")
        .map((item) => `${item.memory_id}:${item.revision_id}`),
    );
    for (const item of contextSlice.items) {
      const receiptItem = receipt.items.find(
        (candidate) =>
          candidate.decision === "included" &&
          candidate.memory_id === item.memory_id &&
          candidate.revision_id === item.revision_id,
      );
      if (
        !allowedScopes.has(`${item.scope.kind}:${item.scope.id}`) ||
        !includedMemoryIds.has(`${item.memory_id}:${item.revision_id}`) ||
        receiptItem === undefined ||
        canonicalJson(receiptItem.projection ?? null) !==
          canonicalJson(item.projection ?? null)
      ) {
        throw new StorageError("INVALID_INPUT");
      }
      for (const evidenceId of item.evidence_ids) {
        const found = this.#database
          .prepare(
            `SELECT 1 FROM evidence_events
             WHERE evidence_id = ? AND scope_kind = ? AND scope_id = ?
               AND principal_id = ?`,
          )
          .get(
            evidenceId,
            item.scope.kind,
            item.scope.id,
            command.principal_id,
          );
        if (found === undefined) {
          throw new StorageError("INVALID_INPUT");
        }
      }
      if (item.projection !== undefined) {
        const eligibility = this.#projectionContextEligibility(
          item.projection.projection_id,
          item.projection.projection_revision_id,
          command.principal_id,
          item.scope,
          request.as_of,
          request.include_sensitive,
          new Set(),
        );
        if (
          eligibility.status !== "eligible" ||
          !this.#contextItemMatchesProjection(
            item,
            eligibility.projection,
            contextSlice.frontier,
          )
        ) {
          throw new StorageError("INVALID_INPUT");
        }
      }
    }
  }

  #readRecall(requestId: string): ExistingRecall | undefined {
    return this.#database
      .prepare(
        `SELECT q.request_id, q.principal_id, q.request_hash, q.request_json,
                r.receipt_json, s.slice_json
         FROM recall_requests AS q
         JOIN retrieval_receipts AS r ON r.request_id = q.request_id
         LEFT JOIN context_slices AS s ON s.request_id = q.request_id
         WHERE q.request_id = ?`,
      )
      .get(requestId) as ExistingRecall | undefined;
  }

  #parseExistingRecall(
    existing: ExistingRecall,
    expectedRequestHash: string,
    expectedPrincipalId?: string,
  ): RecordRecallResult {
    if (
      existing.request_hash !== expectedRequestHash ||
      (expectedPrincipalId !== undefined &&
        existing.principal_id !== expectedPrincipalId)
    ) {
      throw new StorageError("CONFLICT");
    }
    if (this.#recallContainsUnredactedTombstone(existing.request_id)) {
      throw new StorageError("INCOMPLETE_PURGE");
    }
    const receipt = RetrievalReceiptSchema.parse(
      JSON.parse(existing.receipt_json) as unknown,
    );
    const contextSlice =
      existing.slice_json === null
        ? null
        : ContextSliceSchema.parse(
            JSON.parse(existing.slice_json) as unknown,
          );
    if (
      !receiptHashIsValid(receipt) ||
      receipt.request_hash !== existing.request_hash ||
      (contextSlice === null && receipt.context_slice_id !== null) ||
      (contextSlice !== null &&
        (contextSlice.request_id !== existing.request_id ||
          receipt.context_slice_id !== contextSlice.context_slice_id ||
          canonicalSha256Omitting(contextSlice, ["frozen_hash"]) !==
            contextSlice.frozen_hash ||
          (contextSlice.policy_version !== undefined &&
            contextSlice.policy_version !== receipt.policy_version) ||
          canonicalJson(contextSlice.frontier ?? null) !==
            canonicalJson(receipt.frontier ?? null) ||
          canonicalJson(
            contextSlice.effective_lane_configuration ?? null,
          ) !== canonicalJson(
            receipt.effective_lane_configuration ?? null,
          ) ||
          canonicalJson(contextSlice.lane_telemetry ?? null) !==
            canonicalJson(receipt.lane_telemetry ?? null)))
    ) {
      throw new StorageError("CORRUPTION");
    }
    if (contextSlice !== null) {
      let requestJson: unknown;
      try {
        requestJson = JSON.parse(existing.request_json) as unknown;
      } catch {
        throw new StorageError("CORRUPTION");
      }
      const parsedRequest = RecallRequestSchema.safeParse(requestJson);
      if (!parsedRequest.success) {
        throw new StorageError("CORRUPTION");
      }
      const request = parsedRequest.data;
      this.#assertGovernedContextReplayEligible(
        contextSlice,
        existing.principal_id,
        request.as_of,
        request.include_sensitive,
      );
    }
    return { receipt, context_slice: contextSlice, replayed: true };
  }

  #assertGovernedContextReplayEligible(
    contextSlice: ParsedContextSlice,
    principalId: string,
    asOf: string,
    includeSensitive: boolean,
  ): void {
    for (const item of contextSlice.items) {
      const isRedacted =
        item.content.storage === "inline" &&
        item.content.text === "[PURGED]" &&
        item.content.media_type ===
          "application/x.memo-graph-redacted";
      if (item.abstraction !== "l1_memory" || isRedacted) {
        if (item.projection === undefined || isRedacted) {
          continue;
        }
        const eligibility = this.#projectionContextEligibility(
          item.projection.projection_id,
          item.projection.projection_revision_id,
          principalId,
          item.scope,
          asOf,
          includeSensitive,
          new Set(),
        );
        if (
          eligibility.status !== "eligible" ||
          !this.#contextItemMatchesProjection(
            item,
            eligibility.projection,
            contextSlice.frontier,
          )
        ) {
          throw new StorageError(
            eligibility.status === "tombstoned"
              ? "INCOMPLETE_PURGE"
              : "CONFLICT",
          );
        }
        continue;
      }
      const eligibility = this.#governedMemory.checkEligibility(
        MemoryEligibilityInputSchema.parse({
          memory_id: item.memory_id,
          revision_id: item.revision_id,
          principal_id: principalId,
          scope: item.scope,
          as_of: asOf,
          include_sensitive: includeSensitive,
          context_scope: item.scope,
        }),
      );
      if (!eligibility.eligible) {
        throw new StorageError(
          eligibility.reason_code === "TOMBSTONED"
            ? "INCOMPLETE_PURGE"
            : "CONFLICT",
        );
      }
    }
  }

  #contextItemMatchesProjection(
    item: ParsedContextSlice["items"][number],
    projection: ParsedProjectionRevision,
    contextFrontier: ParsedContextSlice["frontier"],
  ): boolean {
    if (
      projection.content === null ||
      item.projection === undefined ||
      contextFrontier === undefined
    ) {
      return false;
    }
    const lineage = {
      projection_id: projection.projection_id,
      projection_revision_id: projection.projection_revision_id,
      source_revision_ids: projection.source_revisions.map(
        (source) => source.revision_id,
      ),
      source_content_hashes: projection.source_revisions.map(
        (source) => source.content_hash,
      ),
      transform: projection.transform,
      frontier: projection.frontier,
    };
    const scopedFrontier =
      "scope_frontiers" in contextFrontier
        ? contextFrontier.scope_frontiers.find(
            (frontier) =>
              frontier.scope.kind === projection.scope.kind &&
              frontier.scope.id === projection.scope.id,
          )
        : contextFrontier;
    if (scopedFrontier === undefined) {
      return false;
    }
    return (
      item.memory_id === projection.projection_id &&
      item.revision_id === projection.projection_revision_id &&
      item.abstraction === projection.abstraction &&
      item.lifecycle === projection.lifecycle &&
      item.authority === projection.authority &&
      item.sensitivity === projection.sensitivity &&
      item.scope.kind === projection.scope.kind &&
      item.scope.id === projection.scope.id &&
      canonicalJson(item.content) === canonicalJson(projection.content) &&
      canonicalJson([...item.evidence_ids].sort()) ===
      canonicalJson([...projection.evidence_ids].sort()) &&
      canonicalJson(item.projection) === canonicalJson(lineage) &&
      projection.frontier.ledger_epoch ===
        contextFrontier.ledger_epoch &&
      projection.frontier.tombstone_epoch ===
        contextFrontier.tombstone_epoch &&
      projection.frontier.projection_epoch ===
        scopedFrontier.projection_epoch &&
      projection.frontier.source_frontier_hash ===
        scopedFrontier.source_frontier_hash &&
      projection.frontier.projection_frontier_hash ===
        scopedFrontier.projection_frontier_hash &&
      scopedFrontier.transform_versions.some(
        (transform) =>
          transform.name === projection.transform.name &&
          transform.version === projection.transform.version,
      )
    );
  }

  #projectionContextEligibility(
    projectionId: string,
    projectionRevisionId: string,
    principalId: string,
    scope: ParsedContextSlice["items"][number]["scope"],
    asOf: string,
    includeSensitive: boolean,
    seen: Set<string>,
  ): ProjectionEligibility {
    if (seen.has(projectionRevisionId)) {
      return { status: "changed" };
    }
    seen.add(projectionRevisionId);
    const row = this.#database
      .prepare(
        `SELECT r.revision_json, r.lifecycle AS revision_lifecycle,
                r.purged_at, o.lifecycle AS object_lifecycle,
                o.current_revision_id,
                EXISTS (
                  SELECT 1 FROM projection_invalidations AS i
                  WHERE i.projection_revision_id = r.projection_revision_id
                ) AS invalidated
         FROM projection_revisions AS r
         JOIN projection_objects AS o ON o.projection_id = r.projection_id
         WHERE r.projection_id = ? AND r.projection_revision_id = ?`,
      )
      .get(projectionId, projectionRevisionId) as
        | {
            revision_json: string;
            revision_lifecycle: string;
            purged_at: string | null;
            object_lifecycle: string;
            current_revision_id: string | null;
            invalidated: number;
          }
        | undefined;
    if (row === undefined) {
      return { status: "changed" };
    }
    if (
      row.purged_at !== null ||
      row.revision_lifecycle === "purged" ||
      row.object_lifecycle === "purged"
    ) {
      return { status: "tombstoned" };
    }
    if (
      row.current_revision_id !== projectionRevisionId ||
      row.revision_lifecycle !== "active" ||
      row.object_lifecycle !== "active" ||
      row.invalidated !== 0
    ) {
      return { status: "changed" };
    }
    let projection: ParsedProjectionRevision;
    try {
      projection = ProjectionRevisionSchema.parse(
        JSON.parse(row.revision_json) as unknown,
      );
    } catch {
      return { status: "changed" };
    }
    if (
      projection.principal_id !== principalId ||
      projection.scope.kind !== scope.kind ||
      projection.scope.id !== scope.id ||
      projection.lifecycle !== "active" ||
      projection.payload === null ||
      projection.content === null ||
      Date.parse(projection.validity.valid_from) > Date.parse(asOf) ||
      (projection.validity.valid_to !== null &&
        Date.parse(projection.validity.valid_to) < Date.parse(asOf)) ||
      projection.sensitivity === "secret" ||
      (projection.sensitivity === "sensitive" && !includeSensitive)
    ) {
      return { status: "changed" };
    }
    for (const source of projection.source_revisions) {
      if (source.abstraction === "l1_memory") {
        const eligibility = this.#governedMemory.checkEligibility(
          MemoryEligibilityInputSchema.parse({
            memory_id: source.memory_id,
            revision_id: source.revision_id,
            principal_id: principalId,
            scope,
            as_of: asOf,
            include_sensitive: includeSensitive,
            context_scope: scope,
          }),
        );
        if (!eligibility.eligible) {
          return {
            status:
              eligibility.reason_code === "TOMBSTONED"
                ? "tombstoned"
                : "changed",
          };
        }
        const canonical = eligibility.item;
        if (
          source.authority !== canonical.authority ||
          source.sensitivity !== canonical.sensitivity ||
          source.content_hash !== canonical.content_hash ||
          canonicalJson(source.validity) !==
            canonicalJson(canonical.validity) ||
          canonicalJson([...source.evidence_ids].sort()) !==
            canonicalJson([...canonical.evidence_ids].sort())
        ) {
          return { status: "changed" };
        }
        continue;
      }
      const nested = this.#projectionContextEligibility(
        source.memory_id,
        source.revision_id,
        principalId,
        scope,
        asOf,
        includeSensitive,
        new Set(seen),
      );
      if (nested.status !== "eligible") {
        return nested;
      }
      if (
        source.abstraction !== nested.projection.abstraction ||
        source.authority !== nested.projection.authority ||
        source.sensitivity !== nested.projection.sensitivity ||
        source.content_hash !== nested.projection.content_hash ||
        canonicalJson(source.validity) !==
          canonicalJson(nested.projection.validity) ||
        canonicalJson([...source.evidence_ids].sort()) !==
          canonicalJson([...nested.projection.evidence_ids].sort())
      ) {
        return { status: "changed" };
      }
    }
    return { status: "eligible", projection };
  }

  #recallContainsUnredactedTombstone(requestId: string): boolean {
    return (
      this.#database
        .prepare(
          `SELECT 1
           FROM context_slice_items AS i
           JOIN context_slices AS s
             ON s.context_slice_id = i.context_slice_id
           WHERE s.request_id = ?
             AND NOT (
               json_extract(i.item_json, '$.content.storage') IS 'inline'
               AND json_extract(i.item_json, '$.content.text') IS '[PURGED]'
               AND json_extract(i.item_json, '$.content.media_type')
                 IS 'application/x.memo-graph-redacted'
             )
             AND (
               EXISTS (
                 SELECT 1
                 FROM memory_objects AS direct_m
                 WHERE direct_m.memory_id = i.memory_id
                   AND direct_m.lifecycle = 'purged'
               )
               OR EXISTS (
                 SELECT 1
                 FROM context_slice_item_evidence AS cie
                 JOIN evidence_events AS e
                   ON e.evidence_id = cie.evidence_id
                 WHERE cie.context_slice_id = i.context_slice_id
                   AND cie.ordinal = i.ordinal
                   AND e.purged_at IS NOT NULL
               )
               OR EXISTS (
                 SELECT 1
                 FROM context_slice_item_evidence AS cie
                 JOIN memory_revision_evidence AS re
                   ON re.evidence_id = cie.evidence_id
                 JOIN memory_revisions AS r
                   ON r.revision_id = re.revision_id
                 JOIN memory_objects AS m ON m.memory_id = r.memory_id
                 WHERE cie.context_slice_id = i.context_slice_id
                   AND cie.ordinal = i.ordinal
                   AND m.lifecycle = 'purged'
                   AND NOT EXISTS (
                     SELECT 1
                     FROM memory_revision_evidence AS other_re
                     JOIN memory_revisions AS other_r
                       ON other_r.revision_id = other_re.revision_id
                     JOIN memory_objects AS other_m
                       ON other_m.memory_id = other_r.memory_id
                     WHERE other_re.evidence_id = cie.evidence_id
                       AND other_m.lifecycle <> 'purged'
                   )
               )
               OR EXISTS (
                 WITH RECURSIVE ancestry(
                   source_revision_id,
                   source_memory_id
                 ) AS (
                   SELECT source.source_revision_id,
                          source.source_memory_id
                   FROM projection_revision_sources AS source
                   WHERE source.projection_revision_id = json_extract(
                     i.item_json,
                     '$.projection.projection_revision_id'
                   )
                   UNION ALL
                   SELECT source.source_revision_id,
                          source.source_memory_id
                   FROM projection_revision_sources AS source
                   JOIN ancestry
                     ON source.projection_revision_id =
                       ancestry.source_revision_id
                 )
                 SELECT 1
                 FROM ancestry
                 JOIN memory_objects AS source_memory
                   ON source_memory.memory_id =
                     ancestry.source_memory_id
                 WHERE source_memory.lifecycle = 'purged'
                 LIMIT 1
               )
             )
           LIMIT 1`,
        )
        .get(requestId) !== undefined
    );
  }

  #insertRecall(command: ParsedRecordRecallCommand): void {
    const hash = canonicalSha256(command.request);
    this.#database
      .prepare(
        `INSERT INTO recall_requests (
           request_id, principal_id, request_hash, request_json, created_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        command.request.request_id,
        command.principal_id,
        hash,
        canonicalJson(command.request),
        command.receipt.created_at,
      );

    if (command.context_slice !== undefined) {
      const slice = command.context_slice;
      this.#database
        .prepare(
          `INSERT INTO context_slices (
             context_slice_id, request_id, compiler_version, token_budget,
             token_used, frozen_hash, slice_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          slice.context_slice_id,
          slice.request_id,
          slice.compiler_version,
          slice.token_budget,
          slice.token_used,
          slice.frozen_hash,
          canonicalJson(slice),
          slice.created_at,
        );
      const insertItem = this.#database.prepare(
        `INSERT INTO context_slice_items (
           context_slice_id, ordinal, memory_id, revision_id, item_json
         ) VALUES (?, ?, ?, ?, ?)`,
      );
      const insertEvidence = this.#database.prepare(
        `INSERT INTO context_slice_item_evidence (
           context_slice_id, ordinal, evidence_id
         ) VALUES (?, ?, ?)`,
      );
      slice.items.forEach((item, ordinal) => {
        insertItem.run(
          slice.context_slice_id,
          ordinal,
          item.memory_id,
          item.revision_id,
          canonicalJson(item),
        );
        for (const evidenceId of item.evidence_ids) {
          insertEvidence.run(slice.context_slice_id, ordinal, evidenceId);
        }
      });
    }

    this.#database
      .prepare(
        `INSERT INTO retrieval_receipts (
           receipt_id, request_id, context_slice_id, request_hash,
           receipt_hash, state, receipt_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        command.receipt.receipt_id,
        command.request.request_id,
        command.receipt.context_slice_id,
        command.receipt.request_hash,
        command.receipt.receipt_hash,
        command.receipt.state,
        canonicalJson(command.receipt),
        command.receipt.created_at,
      );
    const insertAccess = this.#database.prepare(
      `INSERT INTO receipt_access_scopes (
         receipt_id, receipt_kind, principal_id, scope_kind, scope_id,
         created_at
       ) VALUES (?, 'retrieval', ?, ?, ?, ?)`,
    );
    for (const scope of command.request.scopes) {
      insertAccess.run(
        command.receipt.receipt_id,
        command.principal_id,
        scope.kind,
        scope.id,
        command.receipt.created_at,
      );
    }
  }

  #prepareBlobs(command: ParsedCommitEpisodeCommand): StoredBlob[] {
    const stored = this.#blobStore.ensure(command.blobs);
    const supplied = new Set(stored.map((blob) => blob.content_hash));
    for (const record of command.evidence) {
      if (
        record.payload.storage === "blob" &&
        !supplied.has(record.payload.content_hash)
      ) {
        const artifact = this.#database
          .prepare(
            `SELECT size_bytes, media_type FROM artifacts
             WHERE content_hash = ?`,
          )
          .get(record.payload.content_hash) as
          | { size_bytes: number; media_type: string }
          | undefined;
        if (artifact === undefined) {
          throw new StorageError("INVALID_INPUT");
        }
        const verified = this.#blobStore.verifyExisting(
          record.payload.content_hash,
          record.payload.size_bytes,
        );
        stored.push({ ...verified, media_type: artifact.media_type });
      }
    }
    return stored;
  }

  #readIdempotency(idempotencyKey: string): ExistingIdempotency | undefined {
    return this.#database
      .prepare(
        `SELECT i.request_hash, r.receipt_json
         FROM idempotency_keys AS i
         JOIN mutation_receipts AS r ON r.receipt_id = i.receipt_id
         WHERE i.idempotency_key = ?`,
      )
      .get(idempotencyKey) as ExistingIdempotency | undefined;
  }

  #parseExistingReceipt(
    existing: ExistingIdempotency,
    expectedRequestHash: string,
  ): DurableEpisodeReceipt {
    if (existing.request_hash !== expectedRequestHash) {
      throw new StorageError("CONFLICT");
    }
    const receipt = MutationReceiptSchema.parse(
      JSON.parse(existing.receipt_json) as unknown,
    );
    if (!receiptHashIsValid(receipt)) {
      throw new StorageError("CORRUPTION");
    }
    return receipt;
  }

  #insertArtifacts(blobs: StoredBlob[]): void {
    const insert = this.#database.prepare(
      `INSERT INTO artifacts (
         content_hash, size_bytes, media_type, relative_path, created_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(content_hash) DO NOTHING`,
    );
    const read = this.#database.prepare(
      `SELECT size_bytes, media_type, relative_path FROM artifacts
       WHERE content_hash = ?`,
    );
    for (const blob of blobs) {
      insert.run(
        blob.content_hash,
        blob.size_bytes,
        blob.media_type,
        blob.relative_path,
        now(),
      );
      const existing = read.get(blob.content_hash) as {
        size_bytes: number;
        media_type: string;
        relative_path: string;
      };
      if (
        Number(existing.size_bytes) !== blob.size_bytes ||
        existing.media_type !== blob.media_type ||
        existing.relative_path !== blob.relative_path
      ) {
        throw new StorageError("CORRUPTION");
      }
    }
  }

  #insertEvidence(command: ParsedCommitEpisodeCommand): void {
    const insert = this.#database.prepare(
      `INSERT INTO evidence_events (
         evidence_id, sequence, occurred_at, recorded_at, scope_kind, scope_id,
         principal_id, actor_authority, source, authority, sensitivity,
         payload_storage, payload_inline, payload_blob_hash, media_type,
         content_hash, schema_version
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const byId = new Map(
      command.evidence.map((record) => [record.evidence_id, record]),
    );
    for (const evidenceId of command.episode.event_ids) {
      const record = byId.get(evidenceId);
      if (record === undefined) {
        throw new StorageError("INVALID_INPUT");
      }
      insert.run(
        record.evidence_id,
        record.sequence,
        record.occurred_at,
        record.recorded_at,
        record.scope.kind,
        record.scope.id,
        record.actor.principal_id,
        record.actor.authority,
        record.source,
        record.authority,
        record.sensitivity,
        record.payload.storage,
        record.payload.storage === "inline" ? record.payload.text : null,
        record.payload.storage === "blob"
          ? record.payload.content_hash
          : null,
        record.payload.media_type,
        record.content_hash,
        record.schema_version,
      );
    }
  }

  #insertEpisode(command: ParsedCommitEpisodeCommand): void {
    this.#database
      .prepare(
        `INSERT INTO episodes (
           episode_id, scope_kind, scope_id, started_at, ended_at, outcome,
           artifact_hashes_json, sealed_hash, schema_version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        command.episode.episode_id,
        command.episode.scope.kind,
        command.episode.scope.id,
        command.episode.started_at,
        command.episode.ended_at,
        command.episode.outcome,
        canonicalJson(command.episode.artifact_hashes),
        command.episode.sealed_hash,
        command.episode.schema_version,
      );
    const insertMembership = this.#database.prepare(
      `INSERT INTO episode_events (episode_id, evidence_id, ordinal)
       VALUES (?, ?, ?)`,
    );
    command.episode.event_ids.forEach((evidenceId, index) => {
      insertMembership.run(command.episode.episode_id, evidenceId, index);
    });
  }

  #advanceEpoch(updatedAt: string): number {
    this.#database
      .prepare(
        `UPDATE ledger_state
         SET ledger_epoch = ledger_epoch + 1, updated_at = ?
         WHERE singleton = 1`,
      )
      .run(updatedAt);
    return this.#ledgerEpoch();
  }

  #insertOutbox(
    jobs: Array<{ jobId: string; evidenceId: string }>,
    createdAt: string,
  ): void {
    const insert = this.#database.prepare(
      `INSERT INTO outbox_jobs (
         job_id, kind, aggregate_id, status, attempts, available_at, created_at
       ) VALUES (?, 'fts_evidence_upsert', ?, 'pending', 0, ?, ?)`,
    );
    for (const job of jobs) {
      insert.run(job.jobId, job.evidenceId, createdAt, createdAt);
    }
  }

  #insertReceipt(
    receipt: DurableEpisodeReceipt,
    command: ParsedCommitEpisodeCommand,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO mutation_receipts (
           receipt_id, idempotency_key, request_hash, receipt_hash, state,
           resulting_epoch, receipt_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.receipt_id,
        receipt.idempotency_key,
        receipt.request_hash,
        receipt.receipt_hash,
        receipt.state,
        receipt.resulting_epoch,
        canonicalJson(receipt),
        receipt.created_at,
      );
    this.#database
      .prepare(
        `INSERT INTO idempotency_keys (
           idempotency_key, request_hash, receipt_id, created_at
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(
        receipt.idempotency_key,
        receipt.request_hash,
        receipt.receipt_id,
        receipt.created_at,
      );
    const insertAccess = this.#database.prepare(
      `INSERT INTO receipt_access_scopes (
         receipt_id, receipt_kind, principal_id, scope_kind, scope_id,
         created_at
       ) VALUES (?, 'mutation', ?, ?, ?, ?)`,
    );
    const seen = new Set<string>();
    for (const evidence of command.evidence) {
      const key = `${evidence.actor.principal_id}:${evidence.scope.kind}:${evidence.scope.id}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      insertAccess.run(
        receipt.receipt_id,
        evidence.actor.principal_id,
        evidence.scope.kind,
        evidence.scope.id,
        receipt.created_at,
      );
    }
  }

  #evidenceFromRow(
    row: EvidenceRow,
  ): ReturnType<typeof EvidenceRecordSchema.parse> {
    return EvidenceRecordSchema.parse({
      schema_version: row.schema_version,
      evidence_id: row.evidence_id,
      sequence: Number(row.sequence),
      occurred_at: row.occurred_at,
      recorded_at: row.recorded_at,
      scope: { kind: row.scope_kind, id: row.scope_id },
      actor: {
        principal_id: row.principal_id,
        authority: row.actor_authority,
      },
      source: row.source,
      authority: row.authority,
      sensitivity: row.sensitivity,
      payload:
        row.payload_storage === "inline"
          ? {
              storage: "inline",
              text: row.payload_inline,
              media_type: row.media_type,
            }
          : {
              storage: "blob",
              content_hash: row.payload_blob_hash,
              size_bytes: row.artifact_size_bytes,
              media_type: row.media_type,
            },
      content_hash: row.content_hash,
    });
  }

  #governanceEffect<T>(
    effect: () => T,
  ): T {
    try {
      return effect();
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string" &&
        error.code.startsWith("SQLITE_CONSTRAINT")
      ) {
        throw new StorageError("CONFLICT");
      }
      throw error;
    }
  }

  #ledgerEpoch(): number {
    return Number(
      (
        this.#database
          .prepare(
            "SELECT ledger_epoch FROM ledger_state WHERE singleton = 1",
          )
          .get() as { ledger_epoch: number }
      ).ledger_epoch,
    );
  }

  #recoveryRootIdentity(): {
    root_id: string;
    principal_id: string;
  } {
    const existing = this.#database
      .prepare(
        `SELECT root_id, principal_id
         FROM recovery_root_identity WHERE singleton = 1`,
      )
      .get() as
      | { root_id: string; principal_id: string }
      | undefined;
    if (existing !== undefined) {
      if (existing.principal_id !== this.#principalId) {
        throw new StorageError("RECOVERY_AUTHORITY_INVALID");
      }
      return existing;
    }
    if (this.#inspectionOnly) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    const identity = {
      root_id: `recovery_root:${randomUUID()}`,
      principal_id: this.#principalId,
    };
    this.#database
      .prepare(
        `INSERT INTO recovery_root_identity (
           singleton, root_id, principal_id, created_at
         ) VALUES (1, ?, ?, ?)`,
      )
      .run(identity.root_id, identity.principal_id, now());
    return identity;
  }

  #latestReceipt(): LatestReceipt {
    return this.#database
      .prepare(
        `SELECT receipt.receipt_hash
         FROM mutation_receipts AS receipt
         WHERE NOT EXISTS (
           SELECT 1
           FROM json_each(receipt.receipt_json, '$.warnings')
           WHERE value = 'DRY_RUN'
         )
         ORDER BY receipt.resulting_epoch DESC, receipt.receipt_id DESC
         LIMIT 1`,
      )
      .get() as LatestReceipt;
  }

  #registerSecretBackupPurgeIntents(owner: SecretContentOwner): void {
    for (const entry of readdirSync(this.#layout.backups, {
      withFileTypes: true,
    })) {
      const directory = join(this.#layout.backups, entry.name);
      if (!entry.isDirectory() || lstatSync(directory).isSymbolicLink()) {
        continue;
      }
      const completeBackupPath = join(
        directory,
        "database",
        "memory.db",
      );
      const usesCompleteLayout = existsSync(completeBackupPath);
      const path = usesCompleteLayout
        ? completeBackupPath
        : join(directory, "memory.db");
      if (!existsSync(path) || lstatSync(path).isSymbolicLink()) {
        continue;
      }
      const backup = new Database(path, {
        readonly: true,
        fileMustExist: true,
      });
      let containsTarget = false;
      try {
        const hasEncryption = backup
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name = 'secret_nonce_reservations'`,
          )
          .get();
        if (hasEncryption !== undefined) {
          containsTarget =
            backup
              .prepare(
                `SELECT 1 FROM secret_nonce_reservations
                 WHERE owner_kind = ? AND owner_id = ?
                   AND owner_generation = ?
                 LIMIT 1`,
              )
              .get(owner.kind, owner.id, owner.generation) !== undefined;
        }
      } finally {
        backup.close();
      }
      if (!containsTarget) {
        continue;
      }
      const relativePath = usesCompleteLayout
        ? `backups/${entry.name}/database/memory.db`
        : `backups/${entry.name}/memory.db`;
      const manifest = this.#database
        .prepare(
          `SELECT backup_id FROM backup_manifests
           WHERE relative_path = ?`,
        )
        .get(relativePath) as { backup_id: string } | undefined;
      const backupId =
        manifest?.backup_id ??
        `backup:legacy:${canonicalSha256(relativePath).slice(
          "sha256:".length,
        )}`;
      this.#database
        .prepare(
          `INSERT OR IGNORE INTO backup_manifest_purge_intents (
             backup_id, relative_path, created_at
           ) VALUES (?, ?, ?)`,
        )
        .run(
          backupId,
          relativePath,
          new Date().toISOString(),
        );
    }
  }

  #reconcileBackupPurgeIntents(): void {
    if (!this.#tableExists("backup_manifest_purge_intents")) {
      return;
    }
    const intents = this.#database
      .prepare(
        `SELECT backup_id, relative_path
         FROM backup_manifest_purge_intents ORDER BY created_at, backup_id`,
      )
      .all() as Array<{ backup_id: string; relative_path: string }>;
    for (const intent of intents) {
      const match =
        /^backups\/(snapshot-[A-Za-z0-9-]+)\/(?:database\/)?memory\.db$/u.exec(
          intent.relative_path,
        );
      if (match?.[1] === undefined) {
        throw new StorageError("CORRUPTION");
      }
      const directory = join(this.#layout.backups, match[1]);
      if (existsSync(directory)) {
        if (lstatSync(directory).isSymbolicLink()) {
          throw new StorageError("CORRUPTION");
        }
        rmSync(directory, { recursive: true });
        fsyncPath(this.#layout.backups);
      }
      this.#database.transaction(() => {
        if (
          this.#tableExists("complete_backup_manifests")
        ) {
          this.#database
            .prepare(
              `INSERT OR IGNORE INTO backup_manifest_purge_authorizations (
                 backup_id, authorized_at
               ) VALUES (?, ?)`,
            )
            .run(intent.backup_id, new Date().toISOString());
          this.#database
            .prepare(
              "DELETE FROM backup_artifact_inventory WHERE backup_id = ?",
            )
            .run(intent.backup_id);
          this.#database
            .prepare(
              "DELETE FROM complete_backup_manifests WHERE backup_id = ?",
            )
            .run(intent.backup_id);
        }
        this.#database
          .prepare(
            "DELETE FROM backup_manifests WHERE backup_id = ?",
          )
          .run(intent.backup_id);
        if (this.#tableExists("backup_manifest_purge_authorizations")) {
          this.#database
            .prepare(
              `DELETE FROM backup_manifest_purge_authorizations
               WHERE backup_id = ?`,
            )
            .run(intent.backup_id);
        }
        this.#database
          .prepare(
            "DELETE FROM backup_manifest_purge_intents WHERE backup_id = ?",
          )
          .run(intent.backup_id);
      })();
    }
  }

  #tableExists(name: string): boolean {
    return (
      this.#database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(name) !== undefined
    );
  }
}
