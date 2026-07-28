export {
  SqliteStorageClient,
  type SqliteStorageClientOptions,
  type StorageClientHealth,
  type StorageDiagnostic,
} from "./client.js";
export {
  STORAGE_ERROR_CODES,
  StorageError,
  type StorageErrorCode,
} from "./errors.js";
export {
  BackupResultSchema,
  CheckpointResultSchema,
  CommitEpisodeCommandSchema,
  DrainFtsResultSchema,
  RebuildFtsResultSchema,
  SearchEvidenceQuerySchema,
  SearchEvidenceResultSchema,
  StorageHealthSchema,
  VerifyArtifactsResultSchema,
  type BackupResult,
  type CheckpointResult,
  type CommitEpisodeCommand,
  type DrainFtsResult,
  type DurableEpisodeReceipt,
  type RebuildFtsResult,
  type SearchEvidenceQuery,
  type SearchEvidenceResult,
  type StorageHealth,
  type VerifyArtifactsResult,
} from "./protocol.js";
export { WriterQueue, type WriterQueueMetrics } from "./writer-queue.js";
export { runStorageBenchmark } from "./benchmark.js";
export {
  restoreBackupToEmptyDataRoot,
  type RestoreBackupOptions,
  type RestoreBackupResult,
} from "./restore.js";
