export const STORAGE_ERROR_CODES = [
  "INVALID_DATA_ROOT",
  "INVALID_INPUT",
  "CONFLICT",
  "CORRUPTION",
  "MIGRATION_DRIFT",
  "FTS_UNAVAILABLE",
  "WORKER_CRASHED",
  "STORAGE_UNAVAILABLE",
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
  CORRUPTION: "stored content failed an integrity check",
  MIGRATION_DRIFT: "the migration history differs from the applied schema",
  FTS_UNAVAILABLE: "the FTS projection is unavailable",
  WORKER_CRASHED: "the dedicated storage worker exited before responding",
  STORAGE_UNAVAILABLE: "the storage operation is temporarily unavailable",
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
