import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";

import {
  ContextSliceSchema,
  EpisodeSchema,
  EvidenceRecordSchema,
  MutationReceiptSchema,
  ProjectionRevisionSchema,
  RecallRequestSchema,
  ReceiptSchema,
  RetrievalReceiptSchema,
  canonicalJson,
  canonicalSha256,
  canonicalSha256Omitting,
  receiptHashIsValid,
  sealReceipt,
} from "@memo-graph/contracts";
import Database from "better-sqlite3";
import type { z } from "zod";

import { BlobStore, type StoredBlob } from "./blob-store.js";
import { ControlRepository } from "./control-repository.js";
import type { DataRootLayout } from "./data-root.js";
import { StorageError } from "./errors.js";
import { FtsIndex } from "./fts-index.js";
import { GovernanceRepository } from "./governance-repository.js";
import { GovernedMemoryReader } from "./governed-memory-reader.js";
import { GraphProjectionRepository } from "./graph-projection-repository.js";
import { applyMigrations } from "./migrations.js";
import { ProjectionRepository } from "./projection-repository.js";
import { PurgeRepository } from "./purge-repository.js";
import { RelationRepository } from "./relation-repository.js";
import { VectorProjectionRepository } from "./vector-projection-repository.js";
import {
  ApplyVectorProjectionJobCommandSchema,
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
  PurgeRunInputSchema,
  RecordRecallCommandSchema,
  RelationTraversalInputSchema,
  ReceiptLookupInputSchema,
  SearchEvidenceQuerySchema,
  type BackupResult,
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
  type RestoreVerificationResult,
  type StorageHealth,
} from "./protocol.js";

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
  readonly #journalMode: string;

  constructor(options: {
    layout: DataRootLayout;
    migrationsDir: string;
    busyTimeoutMs: number;
  }) {
    this.#layout = options.layout;
    this.#database = new Database(options.layout.database);
    chmodSync(options.layout.database, 0o600);
    this.#database.pragma(`busy_timeout = ${options.busyTimeoutMs}`);
    this.#database.pragma("foreign_keys = ON");
    this.#database.pragma("synchronous = FULL");
    this.#database.pragma("secure_delete = ON");
    this.#database.pragma("temp_store = MEMORY");
    this.#database.pragma("trusted_schema = OFF");
    this.#database.pragma("recursive_triggers = ON");
    this.#database.pragma("journal_size_limit = 67108864");
    this.#database.pragma("wal_autocheckpoint = 1000");
    this.#journalMode = String(
      this.#database.pragma("journal_mode = WAL", { simple: true }),
    ).toLowerCase();
    if (this.#journalMode !== "wal") {
      this.#database.close();
      throw new StorageError("STORAGE_UNAVAILABLE");
    }
    this.#migrations = applyMigrations(this.#database, options.migrationsDir);
    this.#blobStore = new BlobStore(options.layout.blobs);
    this.#fts = new FtsIndex(this.#database);
    this.#governance = new GovernanceRepository(this.#database);
    this.#governedMemory = new GovernedMemoryReader(this.#database);
    this.#control = new ControlRepository(this.#database);
    this.#purge = new PurgeRepository(this.#database, this.#blobStore);
    this.#graph = new GraphProjectionRepository(this.#database);
    this.#vector = new VectorProjectionRepository(this.#database);
    this.#projections = new ProjectionRepository(
      this.#database,
      this.#graph,
    );
    this.#relations = new RelationRepository(this.#database);
  }

  health(): StorageHealth {
    const projection = this.#fts.state();
    const governance = this.#governance.counts();
    const purge = this.#purge.counts();
    const layeredProjection = this.#projections.state();
    const count = (table: string, where = ""): number =>
      Number(
        (
          this.#database
            .prepare(`SELECT count(*) AS count FROM ${table} ${where}`)
            .get() as { count: number }
        ).count,
      );
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
        ...this.#projections.counts(),
        ...governance,
        ...purge,
      },
    };
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

  runPurge(input: unknown): PurgeRunResult {
    const request = PurgeRunInputSchema.parse(input);
    return this.#purge.run(request.purge_job_id);
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

  checkpoint(): CheckpointResult {
    const rows = this.#database.pragma(
      "wal_checkpoint(TRUNCATE)",
    ) as CheckpointResult[];
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

  async createBackup(): Promise<BackupResult> {
    const epoch = this.#ledgerEpoch();
    const tombstoneEpoch = this.#purge.tombstoneEpoch();
    const backupId = `backup:${randomUUID()}`;
    const directory = join(
      this.#layout.backups,
      `snapshot-${epoch}-${backupId.slice("backup:".length)}`,
    );
    const backupBlobs = join(directory, "blobs");
    mkdirSync(backupBlobs, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    chmodSync(backupBlobs, 0o700);
    const path = join(directory, "memory.db");
    const latestReceipt = this.#latestReceipt();
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
    fsyncPath(backupBlobs);
    fsyncPath(directory);

    const backup = new Database(path, {
      readonly: true,
      fileMustExist: true,
    });
    let integrityCheck: string;
    try {
      integrityCheck = String(
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
          `SELECT receipt_hash FROM mutation_receipts
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
      const backupMigrations = backup
        .prepare(
          "SELECT version, name, hash, applied_at FROM schema_migrations ORDER BY version",
        )
        .all() as MigrationEvidence[];

      if (
        integrityCheck !== "ok" ||
        backupEpoch !== epoch ||
        backupTombstoneEpoch !== tombstoneEpoch ||
        backupReceipt?.receipt_hash !== latestReceipt?.receipt_hash ||
        canonicalJson(backupMigrations) !== canonicalJson(this.#migrations)
      ) {
        throw new StorageError("CORRUPTION");
      }
    } finally {
      backup.close();
    }

    const sizeBytes = statSync(path).size;
    this.#database
      .prepare(
        `INSERT INTO backup_manifests (
           backup_id, relative_path, created_at, ledger_epoch,
           tombstone_epoch,
           latest_receipt_hash, migration_hashes_json, blob_hashes_json,
           size_bytes, integrity_check
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        backupId,
        `backups/${basename(directory)}/memory.db`,
        now(),
        epoch,
        tombstoneEpoch,
        latestReceipt?.receipt_hash ?? null,
        canonicalJson(this.#migrations),
        canonicalJson(artifacts.map((artifact) => artifact.content_hash)),
        sizeBytes,
        integrityCheck,
      );

    return {
      backup_id: backupId,
      directory,
      path,
      ledger_epoch: epoch,
      tombstone_epoch: tombstoneEpoch,
      latest_receipt_hash: latestReceipt?.receipt_hash ?? null,
      blob_hashes: artifacts.map((artifact) => artifact.content_hash),
      integrity_check: "ok",
      size_bytes: sizeBytes,
    };
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

    const artifacts = this.verifyArtifacts();
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

    return {
      integrity_check: "ok",
      foreign_key_violations: 0,
      verified_artifacts: artifacts.verified,
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
      this.checkpoint();
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

  #latestReceipt(): LatestReceipt {
    return this.#database
      .prepare(
        `SELECT receipt_hash FROM mutation_receipts
         ORDER BY resulting_epoch DESC, receipt_id DESC LIMIT 1`,
      )
      .get() as LatestReceipt;
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
