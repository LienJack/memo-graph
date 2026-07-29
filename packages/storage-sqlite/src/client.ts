import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";

import {
  GraphScopeCheckpointSchema,
  MutationReceiptSchema,
  VectorScopeCheckpointSchema,
  type GraphScopeCheckpoint,
  type VectorScopeCheckpoint,
} from "@memo-graph/contracts";
import { z } from "zod";

import { prepareDataRoot } from "./data-root.js";
import {
  StorageError,
  deserializeStorageError,
} from "./errors.js";
import {
  ApplyProjectionBatchCommandSchema,
  ApplyGraphProjectionJobCommandSchema,
  ApplyVectorProjectionJobCommandSchema,
  AdmitMemoryCommandSchema,
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
  LearningLedgerReadInputSchema,
  LearningLedgerReadResultSchema,
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
  RegisterVectorEmbeddingEpochCommandSchema,
  RegisterVectorEmbeddingEpochResultSchema,
  RelationTraversalInputSchema,
  RelationTraversalResultSchema,
  RebuildFtsResultSchema,
  ReceiptLookupInputSchema,
  ReceiptLookupResultSchema,
  SearchEvidenceQuerySchema,
  SearchEvidenceResultSchema,
  StorageHealthSchema,
  RestoreVerificationResultSchema,
  RunVectorTemporalSweepInputSchema,
  RunVectorTemporalSweepResultSchema,
  StaleVectorProjectionJobCommandSchema,
  VerifyArtifactsResultSchema,
  VectorProjectionJobResultSchema,
  VectorProjectionScopeInputSchema,
  VectorProjectionStatusSchema,
  WorkerResponseSchema,
  type BackupResult,
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
  type PurgeRunInput,
  type PurgeRunResult,
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
  type SearchEvidenceResult,
  type StorageHealth,
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

  applyProjectionBatch(
    input: ApplyProjectionBatchCommand,
  ): Promise<ProjectionBatchResult> {
    const command = ApplyProjectionBatchCommandSchema.parse(input);
    return this.#writerQueue.enqueue(() =>
      this.#request(
        "apply_projection_batch",
        command,
        ProjectionBatchResultSchema,
      ),
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
    return this.#writerQueue.enqueue(() =>
      this.#request(
        "enqueue_projection_job",
        command,
        ProjectionJobMutationResultSchema,
      ),
    );
  }

  claimProjectionJobs(
    input: ClaimProjectionJobsInput,
  ): Promise<ClaimProjectionJobsResult> {
    const request = ClaimProjectionJobsInputSchema.parse(input);
    return this.#writerQueue.enqueue(() =>
      this.#request(
        "claim_projection_jobs",
        request,
        ClaimProjectionJobsResultSchema,
      ),
    );
  }

  failProjectionJob(
    input: FailProjectionJobCommand,
  ): Promise<ProjectionJobMutationResult> {
    const command = FailProjectionJobCommandSchema.parse(input);
    return this.#writerQueue.enqueue(() =>
      this.#request(
        "fail_projection_job",
        command,
        ProjectionJobMutationResultSchema,
      ),
    );
  }

  completeProjectionJob(
    input: CompleteProjectionJobCommand,
  ): Promise<ProjectionJobMutationResult> {
    const command = CompleteProjectionJobCommandSchema.parse(input);
    return this.#writerQueue.enqueue(() =>
      this.#request(
        "complete_projection_job",
        command,
        ProjectionJobMutationResultSchema,
      ),
    );
  }

  invalidateProjectionDescendants(
    input: InvalidateProjectionDescendantsCommand,
  ): Promise<InvalidateProjectionDescendantsResult> {
    const command =
      InvalidateProjectionDescendantsCommandSchema.parse(input);
    return this.#writerQueue.enqueue(() =>
      this.#request(
        "invalidate_projection_descendants",
        command,
        InvalidateProjectionDescendantsResultSchema,
      ),
    );
  }

  recordProjectionRebuild(
    input: ProjectionRebuildReceipt,
  ): Promise<RecordProjectionRebuildResult> {
    const receipt = ProjectionRebuildReceiptSchema.parse(input);
    return this.#writerQueue.enqueue(() =>
      this.#request(
        "record_projection_rebuild",
        receipt,
        RecordProjectionRebuildResultSchema,
      ),
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
    return this.#writerQueue.enqueue(() =>
      this.#request(
        "claim_graph_projection_jobs",
        request,
        ClaimGraphProjectionJobsResultSchema,
      ),
    );
  }

  applyGraphProjectionJob(
    input: ApplyGraphProjectionJobCommand,
  ): Promise<GraphProjectionJobResult> {
    const command = ApplyGraphProjectionJobCommandSchema.parse(input);
    return this.#writerQueue.enqueue(() =>
      this.#request(
        "apply_graph_projection_job",
        command,
        GraphProjectionJobResultSchema,
      ),
    );
  }

  failGraphProjectionJob(
    input: FailGraphProjectionJobCommand,
  ): Promise<GraphProjectionJobResult> {
    const command = FailGraphProjectionJobCommandSchema.parse(input);
    return this.#writerQueue.enqueue(() =>
      this.#request(
        "fail_graph_projection_job",
        command,
        GraphProjectionJobResultSchema,
      ),
    );
  }

  resetGraphProjectionScopes(
    input: ResetGraphProjectionScopesInput,
  ): Promise<ResetGraphProjectionScopesResult> {
    const request = ResetGraphProjectionScopesInputSchema.parse(input);
    return this.#writerQueue.enqueue(() =>
      this.#request(
        "reset_graph_projection_scopes",
        request,
        ResetGraphProjectionScopesResultSchema,
      ),
    );
  }

  markGraphRestoreUnavailable(
    input: MarkGraphRestoreUnavailableInput,
  ): Promise<MarkGraphRestoreUnavailableResult> {
    const request = MarkGraphRestoreUnavailableInputSchema.parse(input);
    return this.#writerQueue.enqueue(() =>
      this.#request(
        "mark_graph_restore_unavailable",
        request,
        MarkGraphRestoreUnavailableResultSchema,
      ),
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
    return this.#writerQueue.enqueue(() =>
      this.#request(
        "register_vector_embedding_epoch",
        command,
        RegisterVectorEmbeddingEpochResultSchema,
      ),
    );
  }

  configureVectorProjection(
    input: ConfigureVectorProjectionCommand,
  ): Promise<ConfigureVectorProjectionResult> {
    const command = ConfigureVectorProjectionCommandSchema.parse(input);
    return this.#writerQueue.enqueue(() =>
      this.#request(
        "configure_vector_projection",
        command,
        ConfigureVectorProjectionResultSchema,
      ),
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
    return this.#writerQueue.enqueue(() =>
      this.#request(
        "claim_vector_projection_jobs",
        request,
        ClaimVectorProjectionJobsResultSchema,
      ),
    );
  }

  applyVectorProjectionJob(
    input: ApplyVectorProjectionJobCommand,
  ): Promise<VectorProjectionJobResult> {
    const command = ApplyVectorProjectionJobCommandSchema.parse(input);
    return this.#writerQueue.enqueue(() =>
      this.#request(
        "apply_vector_projection_job",
        command,
        VectorProjectionJobResultSchema,
      ),
    );
  }

  failVectorProjectionJob(
    input: FailVectorProjectionJobCommand,
  ): Promise<VectorProjectionJobResult> {
    const command = FailVectorProjectionJobCommandSchema.parse(input);
    return this.#writerQueue.enqueue(() =>
      this.#request(
        "fail_vector_projection_job",
        command,
        VectorProjectionJobResultSchema,
      ),
    );
  }

  staleVectorProjectionJob(
    input: StaleVectorProjectionJobCommand,
  ): Promise<VectorProjectionJobResult> {
    const command = StaleVectorProjectionJobCommandSchema.parse(input);
    return this.#writerQueue.enqueue(() =>
      this.#request(
        "stale_vector_projection_job",
        command,
        VectorProjectionJobResultSchema,
      ),
    );
  }

  markVectorRestoreDegraded(
    input: MarkVectorRestoreDegradedInput,
  ): Promise<MarkVectorRestoreDegradedResult> {
    const request = MarkVectorRestoreDegradedInputSchema.parse(input);
    return this.#writerQueue.enqueue(() =>
      this.#request(
        "mark_vector_restore_degraded",
        request,
        MarkVectorRestoreDegradedResultSchema,
      ),
    );
  }

  runVectorTemporalSweep(
    input: RunVectorTemporalSweepInput,
  ): Promise<RunVectorTemporalSweepResult> {
    const request = RunVectorTemporalSweepInputSchema.parse(input);
    return this.#writerQueue.enqueue(() =>
      this.#request(
        "run_vector_temporal_sweep",
        request,
        RunVectorTemporalSweepResultSchema,
      ),
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
    return this.#writerQueue.enqueue(() =>
      this.#request(
        "write_learning_ledger",
        command,
        LearningLedgerWriteResultSchema,
      ),
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
