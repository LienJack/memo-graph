export const STORAGE_ERROR_CODES = [
  "INVALID_DATA_ROOT",
  "INVALID_INPUT",
  "CONFLICT",
  "STALE_REVISION",
  "STALE_PROJECTION_FRONTIER",
  "APPROVAL_INVALID",
  "INCOMPLETE_PURGE",
  "STALE_TOMBSTONE_FRONTIER",
  "STALE_LEARNING_FRONTIER",
  "CORRUPTION",
  "MIGRATION_DRIFT",
  "ENCRYPTION_REQUIRED",
  "KEY_PROVIDER_INVALID",
  "KEY_UNAVAILABLE",
  "KEY_REVOKED",
  "KEY_STATE_AMBIGUOUS",
  "NONCE_REUSE",
  "AUTHORITY_REPLAY",
  "ROTATION_INCOMPLETE",
  "FTS_UNAVAILABLE",
  "WORKER_CRASHED",
  "STORAGE_UNAVAILABLE",
  "QUEUE_SATURATED",
  "RESOURCE_PRESSURE",
  "MAINTENANCE_BLOCKED",
  "ROOT_LEASE_HELD",
  "STALE_ROOT_LEASE",
] as const;

export type StorageErrorCode = (typeof STORAGE_ERROR_CODES)[number];

export type SerializedStorageError = {
  code: StorageErrorCode;
  message: string;
  retryable: boolean;
};

const PUBLIC_MESSAGES: Record<StorageErrorCode, string> = {
  INVALID_DATA_ROOT: "the configured data root is unsafe or unsupported",
  INVALID_INPUT: "the storage request is invalid",
  CONFLICT: "the storage request conflicts with durable state",
  STALE_REVISION: "the expected memory revision is no longer current",
  STALE_PROJECTION_FRONTIER:
    "the projection scope frontier changed during the read",
  APPROVAL_INVALID:
    "the trusted approval is invalid, expired, changed, or already consumed",
  INCOMPLETE_PURGE: "the purge still has residual or failed stores",
  STALE_TOMBSTONE_FRONTIER:
    "the backup predates the required tombstone frontier",
  STALE_LEARNING_FRONTIER:
    "the backup predates the required learning release or control frontier",
  CORRUPTION: "stored content failed an integrity check",
  MIGRATION_DRIFT: "the migration history differs from the applied schema",
  ENCRYPTION_REQUIRED:
    "application-level encryption is required for this content or volume",
  KEY_PROVIDER_INVALID:
    "the opened key descriptor is not a private owner-checked 32-byte regular file",
  KEY_UNAVAILABLE: "the required encryption key is unavailable",
  KEY_REVOKED: "the required encryption key is revoked or compromised",
  KEY_STATE_AMBIGUOUS: "the encryption key lifecycle state is ambiguous",
  NONCE_REUSE: "the encryption nonce reservation conflicts with durable state",
  AUTHORITY_REPLAY:
    "the secret-use authority was already consumed or conflicts with durable state",
  ROTATION_INCOMPLETE: "the encryption key rotation is not complete",
  FTS_UNAVAILABLE: "the FTS projection is unavailable",
  WORKER_CRASHED: "the dedicated storage worker exited before responding",
  STORAGE_UNAVAILABLE: "the storage operation is temporarily unavailable",
  QUEUE_SATURATED: "the bounded storage queue cannot admit more work",
  RESOURCE_PRESSURE: "local capacity or WAL pressure requires read-only mode",
  MAINTENANCE_BLOCKED:
    "the requested operation conflicts with active maintenance",
  ROOT_LEASE_HELD: "another live writer owns the local data root",
  STALE_ROOT_LEASE:
    "the root lease cannot be recovered without exact stale-owner proof",
};

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly retryable: boolean;

  constructor(code: StorageErrorCode, options?: { retryable?: boolean }) {
    super(PUBLIC_MESSAGES[code]);
    this.name = "StorageError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
  }
}

export function serializeStorageError(error: unknown): SerializedStorageError {
  if (error instanceof StorageError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    (error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED")
  ) {
    const storageError = new StorageError("STORAGE_UNAVAILABLE", {
      retryable: true,
    });
    return {
      code: storageError.code,
      message: storageError.message,
      retryable: storageError.retryable,
    };
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    (error.code === "SQLITE_CORRUPT" || error.code === "SQLITE_NOTADB")
  ) {
    const storageError = new StorageError("CORRUPTION");
    return {
      code: storageError.code,
      message: storageError.message,
      retryable: storageError.retryable,
    };
  }

  const storageError = new StorageError("STORAGE_UNAVAILABLE", {
    retryable: false,
  });
  return {
    code: storageError.code,
    message: storageError.message,
    retryable: storageError.retryable,
  };
}

export function deserializeStorageError(
  error: SerializedStorageError,
): StorageError {
  return new StorageError(error.code, { retryable: error.retryable });
}
