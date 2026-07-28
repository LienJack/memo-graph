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
  EpisodeSchema,
  EvidenceRecordSchema,
  MutationReceiptSchema,
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
import { applyMigrations } from "./migrations.js";
import {
  CommitEpisodeCommandSchema,
  SearchEvidenceQuerySchema,
  type BackupResult,
  type CheckpointResult,
  type ParsedCommitEpisodeCommand,
  type DrainFtsResult,
  type DurableEpisodeReceipt,
  type MigrationEvidence,
  type RebuildFtsResult,
  type SearchEvidenceResult,
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
  }

  health(): StorageHealth {
    const projection = this.#fts.state();
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

    return {
      schema_version: schemaVersion,
      ledger_epoch: this.#ledgerEpoch(),
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
      },
    };
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
          this.#insertReceipt(receipt);
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
      const backupMigrations = backup
        .prepare(
          "SELECT version, name, hash, applied_at FROM schema_migrations ORDER BY version",
        )
        .all() as MigrationEvidence[];

      if (
        integrityCheck !== "ok" ||
        backupEpoch !== epoch ||
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
           latest_receipt_hash, migration_hashes_json, blob_hashes_json,
           size_bytes, integrity_check
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        backupId,
        `backups/${basename(directory)}/memory.db`,
        now(),
        epoch,
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

  #insertReceipt(receipt: DurableEpisodeReceipt): void {
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
