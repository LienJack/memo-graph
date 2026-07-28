import { z } from "zod";

import {
  EpisodeSchema,
  EvidenceRecordSchema,
  ScopeSchema,
} from "@memo-graph/contracts";
import type { MutationReceiptSchema } from "@memo-graph/contracts";

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

export const StorageCountsSchema = z
  .object({
    evidence_events: z.number().int().nonnegative(),
    episodes: z.number().int().nonnegative(),
    mutation_receipts: z.number().int().nonnegative(),
    idempotency_keys: z.number().int().nonnegative(),
    outbox_pending: z.number().int().nonnegative(),
    fts_rows: z.number().int().nonnegative(),
    backup_manifests: z.number().int().nonnegative(),
  })
  .strict();

export const StorageHealthSchema = z
  .object({
    schema_version: z.string().regex(/^\d{4}$/),
    ledger_epoch: z.number().int().nonnegative(),
    latest_receipt_hash: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .nullable(),
    sqlite_version: z.string().min(1),
    journal_mode: z.literal("wal"),
    foreign_keys: z.literal(true),
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

export const BlockWorkerResultSchema = z
  .object({
    blocked_ms: z.number().int().min(1).max(2_000),
  })
  .strict();

export const WorkerOperationSchema = z.enum([
  "health",
  "commit_episode",
  "drain_fts",
  "search_evidence",
  "rebuild_fts",
  "checkpoint",
  "backup",
  "verify_artifacts",
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
export type BlockWorkerResult = z.infer<typeof BlockWorkerResultSchema>;
export type CheckpointResult = z.infer<typeof CheckpointResultSchema>;
export type CommitEpisodeCommand = z.input<typeof CommitEpisodeCommandSchema>;
export type ParsedCommitEpisodeCommand = z.output<
  typeof CommitEpisodeCommandSchema
>;
export type DrainFtsResult = z.infer<typeof DrainFtsResultSchema>;
export type MigrationEvidence = z.infer<typeof MigrationEvidenceSchema>;
export type RebuildFtsResult = z.infer<typeof RebuildFtsResultSchema>;
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
