import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";

import { MutationReceiptSchema } from "@memo-graph/contracts";
import { z } from "zod";

import { prepareDataRoot } from "./data-root.js";
import {
  StorageError,
  deserializeStorageError,
} from "./errors.js";
import {
  AdmitMemoryCommandSchema,
  BackupResultSchema,
  BlockWorkerResultSchema,
  CheckpointResultSchema,
  CommitEpisodeCommandSchema,
  ContentReferenceCountsInputSchema,
  ContentReferenceCountsSchema,
  DrainFtsResultSchema,
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
  RecordRecallCommandSchema,
  RecordRecallResultSchema,
  RebuildFtsResultSchema,
  ReceiptLookupInputSchema,
  ReceiptLookupResultSchema,
  SearchEvidenceQuerySchema,
  SearchEvidenceResultSchema,
  StorageHealthSchema,
  RestoreVerificationResultSchema,
  VerifyArtifactsResultSchema,
  WorkerResponseSchema,
  type BackupResult,
  type AdmitMemoryCommand,
  type BlockWorkerResult,
  type CheckpointResult,
  type ContentReferenceCounts,
  type DrainFtsResult,
  type DurableEpisodeReceipt,
  type EvidenceExplanation,
  type GovernanceStorageStatus,
  type GovernanceMutationResult,
  type GovernedMemorySearchQuery,
  type GovernedMemorySearchResult,
  type GovernedMemoryLookupInput,
  type GovernedMemoryLookupResult,
  type GovernanceReplayInput,
  type MemoryRevisionCommand,
  type MemoryEligibilityInput,
  type MemoryEligibilityResult,
  type MemoryControlCommand,
  type MemoryControlResult,
  type MemoryCorrectionBasis,
  type MemoryCorrectionBasisInput,
  type MemoryDeleteCommand,
  type MemoryDeleteResult,
  type PurgeRunInput,
  type PurgeRunResult,
  type RecordRecallResult,
  type RebuildFtsResult,
  type SearchEvidenceResult,
  type StorageHealth,
  type RestoreVerificationResult,
  type VerifyArtifactsResult,
  type WorkerOperation,
} from "./protocol.js";
import { WriterQueue, type WriterQueueMetrics } from "./writer-queue.js";

export type StorageDiagnostic = {
  operation: WorkerOperation;
  duration_ms: number;
  queue: WriterQueueMetrics;
  outcome: "ok" | "error";
  error_code?: string;
};

export type SqliteStorageClientOptions = {
  dataRoot: string;
  migrationsDir?: string;
  busyTimeoutMs?: number;
  testOperations?: boolean;
  testFaults?: {
    exitAfterCommitBeforeResponseOnce?: boolean;
  };
  onDiagnostic?: (diagnostic: StorageDiagnostic) => void;
};

export type StorageClientHealth = StorageHealth & {
  writer_queue: WriterQueueMetrics;
};

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
    onDiagnostic: ((diagnostic: StorageDiagnostic) => void) | undefined;
  };
  readonly #writerQueue = new WriterQueue();
  readonly #pending = new Map<string, PendingRequest>();
  #worker: Worker | undefined;
  #closed = false;
  #closing = false;
  #faultOnNextWorker = false;

  private constructor(options: SqliteStorageClientOptions) {
    const layout = prepareDataRoot(options.dataRoot);
    this.#options = {
      dataRoot: layout.root,
      migrationsDir:
        options.migrationsDir ??
        fileURLToPath(new URL("../../../migrations", import.meta.url)),
      busyTimeoutMs: options.busyTimeoutMs ?? 5_000,
      testOperations: options.testOperations ?? false,
      onDiagnostic: options.onDiagnostic,
    };
    this.#faultOnNextWorker =
      options.testFaults?.exitAfterCommitBeforeResponseOnce ?? false;
  }

  static async open(
    options: SqliteStorageClientOptions,
  ): Promise<SqliteStorageClient> {
    const client = new SqliteStorageClient(options);
    try {
      await client.health();
      return client;
    } catch (error) {
      await client.#abort();
      throw error;
    }
  }

  async health(): Promise<StorageClientHealth> {
    const result = await this.#request("health", null, StorageHealthSchema);
    return {
      ...result,
      writer_queue: this.#writerQueue.metrics(),
    };
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

  admitMemory(input: AdmitMemoryCommand): Promise<GovernanceMutationResult> {
    const command = AdmitMemoryCommandSchema.parse(input);
    return this.#writerQueue.enqueue(() =>
      this.#request(
        "admit_memory",
        command,
        GovernanceMutationResultSchema,
      ),
    );
  }

  applyMemoryRevision(
    input: MemoryRevisionCommand,
  ): Promise<GovernanceMutationResult> {
    const command = MemoryRevisionCommandSchema.parse(input);
    return this.#writerQueue.enqueue(() =>
      this.#request(
        "apply_memory_revision",
        command,
        GovernanceMutationResultSchema,
      ),
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
    return this.#writerQueue.enqueue(() =>
      this.#request(
        "apply_memory_control",
        command,
        MemoryControlResultSchema,
      ),
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
    return this.#writerQueue.enqueue(() =>
      this.#request(
        "delete_memory",
        command,
        MemoryDeleteResultSchema,
      ),
    );
  }

  runPurge(input: PurgeRunInput): Promise<PurgeRunResult> {
    const request = PurgeRunInputSchema.parse(input);
    return this.#writerQueue.enqueue(() =>
      this.#request("run_purge", request, PurgeRunResultSchema),
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
    return this.#writerQueue.enqueue(() =>
      this.#request(
        "commit_episode",
        command,
        MutationReceiptSchema,
      ),
    );
  }

  drainFtsOutbox(): Promise<DrainFtsResult> {
    return this.#writerQueue.enqueue(() =>
      this.#request("drain_fts", null, DrainFtsResultSchema),
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
    return this.#writerQueue.enqueue(() =>
      this.#request("rebuild_fts", null, RebuildFtsResultSchema),
    );
  }

  checkpoint(): Promise<CheckpointResult> {
    return this.#writerQueue.enqueue(() =>
      this.#request("checkpoint", null, CheckpointResultSchema),
    );
  }

  createBackup(): Promise<BackupResult> {
    return this.#writerQueue.enqueue(() =>
      this.#request("backup", null, BackupResultSchema),
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
    return this.#writerQueue.enqueue(() =>
      this.#request(
        "record_recall",
        command,
        RecordRecallResultSchema,
      ),
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
    this.#worker = undefined;
    this.#closed = true;
    this.#closing = false;
  }

  async #request<T>(
    operation: WorkerOperation,
    payload: unknown,
    schema: z.ZodType<T>,
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
        worker.postMessage({ requestId, operation, payload });
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
    const worker = new Worker(new URL("./storage-worker.js", import.meta.url), {
      workerData: {
        dataRoot: this.#options.dataRoot,
        migrationsDir: this.#options.migrationsDir,
        busyTimeoutMs: this.#options.busyTimeoutMs,
        testOperations: this.#options.testOperations,
        exitAfterCommitBeforeResponse: fault,
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
    if (this.#worker !== undefined) {
      await this.#worker.terminate();
    }
    this.#worker = undefined;
    this.#closed = true;
    this.#closing = false;
  }
}
