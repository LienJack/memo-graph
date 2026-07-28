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

import { BlobStore, type StoredBlob } from "./blob-store.js";
import type { DataRootLayout } from "./data-root.js";
import { StorageError } from "./errors.js";
import { FtsIndex } from "./fts-index.js";
import { GovernanceRepository } from "./governance-repository.js";
import { GovernedMemoryReader } from "./governed-memory-reader.js";
import { applyMigrations } from "./migrations.js";
import { PurgeRepository } from "./purge-repository.js";
import {
  AdmitMemoryCommandSchema,
  CommitEpisodeCommandSchema,
  EvidenceExplanationSchema,
  EvidenceLookupInputSchema,
  GovernanceReplayInputSchema,
  GovernedMemoryLookupInputSchema,
  GovernedMemorySearchQuerySchema,
  MemoryEligibilityInputSchema,
  MemoryRevisionCommandSchema,
  RecordRecallCommandSchema,
  ReceiptLookupInputSchema,
  SearchEvidenceQuerySchema,
  type BackupResult,
  type CheckpointResult,
  type ContentReferenceCounts,
  type DrainFtsResult,
  type DurableEpisodeReceipt,
  type EvidenceExplanation,
  type MigrationEvidence,
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
  receipt_json: string;
  slice_json: string | null;
};

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
  readonly #purge: PurgeRepository;
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
    this.#purge = new PurgeRepository(this.#database);
  }

  health(): StorageHealth {
    const projection = this.#fts.state();
    const governance = this.#governance.counts();
    const purge = this.#purge.counts();
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

  governanceReplay(input: unknown): GovernanceMutationResult | null {
    const request = GovernanceReplayInputSchema.parse(input);
    return this.#governance.replayMutation(
      request.idempotency_key,
      request.request_hash,
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
           AND e.scope_id = ?`,
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
      if (
        !allowedScopes.has(`${item.scope.kind}:${item.scope.id}`) ||
        !includedMemoryIds.has(`${item.memory_id}:${item.revision_id}`)
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
    }
  }

  #readRecall(requestId: string): ExistingRecall | undefined {
    return this.#database
      .prepare(
        `SELECT q.request_id, q.principal_id, q.request_hash,
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
            contextSlice.frozen_hash))
    ) {
      throw new StorageError("CORRUPTION");
    }
    return { receipt, context_slice: contextSlice, replayed: true };
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

  #governanceEffect(
    effect: () => GovernanceMutationResult,
  ): GovernanceMutationResult {
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
