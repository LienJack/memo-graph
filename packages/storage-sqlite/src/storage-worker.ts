import { parentPort, workerData } from "node:worker_threads";

import { z } from "zod";

import { prepareDataRoot } from "./data-root.js";
import { StorageDatabase } from "./database.js";
import {
  StorageError,
  serializeStorageError,
} from "./errors.js";
import {
  ApplyProjectionBatchCommandSchema,
  ApplyGraphProjectionJobCommandSchema,
  ApplyVectorProjectionJobCommandSchema,
  AdmitMemoryCommandSchema,
  ClaimProjectionJobsInputSchema,
  ClaimGraphProjectionJobsInputSchema,
  ClaimVectorProjectionJobsInputSchema,
  ConfigureVectorProjectionCommandSchema,
  CompleteProjectionJobCommandSchema,
  CommitEpisodeCommandSchema,
  ContentReferenceCountsInputSchema,
  EnqueueProjectionJobCommandSchema,
  EvidenceLookupInputSchema,
  GovernanceReplayInputSchema,
  GovernedMemoryLookupInputSchema,
  GovernedMemorySearchQuerySchema,
  FailProjectionJobCommandSchema,
  FailGraphProjectionJobCommandSchema,
  FailVectorProjectionJobCommandSchema,
  InvalidateProjectionDescendantsCommandSchema,
  LearningLedgerReadInputSchema,
  LearningLedgerWriteCommandSchema,
  MemoryEligibilityInputSchema,
  MemoryControlCommandSchema,
  MemoryCorrectionBasisInputSchema,
  MemoryDeleteCommandSchema,
  MemoryRevisionCommandSchema,
  PurgeRunInputSchema,
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
  RecordRecallCommandSchema,
  ReceiptLookupInputSchema,
  RelationTraversalInputSchema,
  SearchEvidenceQuerySchema,
  WorkerRequestSchema,
} from "./protocol.js";

const WorkerOptionsSchema = z
  .object({
    dataRoot: z.string(),
    migrationsDir: z.string(),
    busyTimeoutMs: z.number().int().min(1).max(120_000),
    testOperations: z.boolean(),
    exitAfterCommitBeforeResponse: z.boolean(),
  })
  .strict();

const options = WorkerOptionsSchema.parse(workerData);
let database: StorageDatabase | undefined;
let initializationError: unknown;
let exitAfterCommitBeforeResponse =
  options.exitAfterCommitBeforeResponse;

try {
  database = new StorageDatabase({
    layout: prepareDataRoot(options.dataRoot),
    migrationsDir: options.migrationsDir,
    busyTimeoutMs: options.busyTimeoutMs,
    testOperations: options.testOperations,
  });
} catch (error) {
  initializationError = error;
}

if (parentPort === null) {
  throw new Error("storage worker requires a parent port");
}

const port = parentPort;
let operationChain: Promise<void> = Promise.resolve();

port.on("message", (message: unknown) => {
  operationChain = operationChain.then(async () => {
    let requestId = "00000000-0000-4000-8000-000000000000";
    try {
      const request = WorkerRequestSchema.parse(message);
      requestId = request.requestId;
      if (initializationError !== undefined) {
        throw initializationError;
      }
      if (database === undefined) {
        throw new StorageError("STORAGE_UNAVAILABLE");
      }

      let result: unknown;
      switch (request.operation) {
        case "health":
          result = database.health();
          break;
        case "governance_status":
          result = database.governanceStatus();
          break;
        case "count_content_references": {
          const input = ContentReferenceCountsInputSchema.parse(
            request.payload,
          );
          result = database.contentReferenceCounts(input.content_hash);
          break;
        }
        case "apply_projection_batch":
          result = database.applyProjectionBatch(
            ApplyProjectionBatchCommandSchema.parse(request.payload),
          );
          break;
        case "get_projection_scope_frontier":
          result = database.projectionScopeFrontier(
            ProjectionScopeFrontierInputSchema.parse(request.payload),
          );
          break;
        case "query_projections":
          result = database.queryProjections(
            ProjectionQuerySchema.parse(request.payload),
          );
          break;
        case "query_projection_page":
          result = database.queryProjectionPage(
            ProjectionPageQuerySchema.parse(request.payload),
          );
          break;
        case "validate_projection_sources":
          result = database.validateProjectionSources(
            ProjectionSourceBatchQuerySchema.parse(request.payload),
          );
          break;
        case "list_projection_sources":
          result = database.listProjectionSources(
            ProjectionSourceListInputSchema.parse(request.payload),
          );
          break;
        case "traverse_relations":
          result = database.traverseRelations(
            RelationTraversalInputSchema.parse(request.payload),
          );
          break;
        case "enqueue_projection_job":
          result = database.enqueueProjectionJob(
            EnqueueProjectionJobCommandSchema.parse(request.payload),
          );
          break;
        case "claim_projection_jobs":
          result = database.claimProjectionJobs(
            ClaimProjectionJobsInputSchema.parse(request.payload),
          );
          break;
        case "fail_projection_job":
          result = database.failProjectionJob(
            FailProjectionJobCommandSchema.parse(request.payload),
          );
          break;
        case "complete_projection_job":
          result = database.completeProjectionJob(
            CompleteProjectionJobCommandSchema.parse(request.payload),
          );
          break;
        case "invalidate_projection_descendants":
          result = database.invalidateProjectionDescendants(
            InvalidateProjectionDescendantsCommandSchema.parse(
              request.payload,
            ),
          );
          break;
        case "record_projection_rebuild":
          result = database.recordProjectionRebuild(
            ProjectionRebuildReceiptSchema.parse(request.payload),
          );
          break;
        case "get_graph_projection_checkpoint":
          result = database.graphProjectionCheckpoint(
            GraphScopeInputSchema.parse(request.payload),
          );
          break;
        case "get_graph_scope_snapshot":
          result = database.graphScopeSnapshot(
            GraphScopeInputSchema.parse(request.payload),
          );
          break;
        case "list_graph_projection_snapshots":
          result = database.listGraphProjectionSnapshots(
            GraphProjectionSnapshotListInputSchema.parse(request.payload),
          );
          break;
        case "claim_graph_projection_jobs":
          result = database.claimGraphProjectionJobs(
            ClaimGraphProjectionJobsInputSchema.parse(request.payload),
          );
          break;
        case "apply_graph_projection_job":
          result = database.applyGraphProjectionJob(
            ApplyGraphProjectionJobCommandSchema.parse(request.payload),
          );
          break;
        case "fail_graph_projection_job":
          result = database.failGraphProjectionJob(
            FailGraphProjectionJobCommandSchema.parse(request.payload),
          );
          break;
        case "reset_graph_projection_scopes":
          result = database.resetGraphProjectionScopes(
            ResetGraphProjectionScopesInputSchema.parse(request.payload),
          );
          break;
        case "mark_graph_restore_unavailable":
          result = database.markGraphRestoreUnavailable(
            MarkGraphRestoreUnavailableInputSchema.parse(request.payload),
          );
          break;
        case "graph_projection_status":
          result = database.graphProjectionStatus();
          break;
        case "register_vector_embedding_epoch":
          result = database.registerVectorEmbeddingEpoch(
            RegisterVectorEmbeddingEpochCommandSchema.parse(
              request.payload,
            ),
          );
          break;
        case "configure_vector_projection":
          result = database.configureVectorProjection(
            ConfigureVectorProjectionCommandSchema.parse(
              request.payload,
            ),
          );
          break;
        case "get_vector_projection_checkpoint":
          result = database.vectorProjectionCheckpoint(
            VectorProjectionScopeInputSchema.parse(request.payload),
          );
          break;
        case "claim_vector_projection_jobs":
          result = database.claimVectorProjectionJobs(
            ClaimVectorProjectionJobsInputSchema.parse(
              request.payload,
            ),
          );
          break;
        case "apply_vector_projection_job":
          result = database.applyVectorProjectionJob(
            ApplyVectorProjectionJobCommandSchema.parse(
              request.payload,
            ),
          );
          break;
        case "fail_vector_projection_job":
          result = database.failVectorProjectionJob(
            FailVectorProjectionJobCommandSchema.parse(
              request.payload,
            ),
          );
          break;
        case "stale_vector_projection_job":
          result = database.staleVectorProjectionJob(
            StaleVectorProjectionJobCommandSchema.parse(
              request.payload,
            ),
          );
          break;
        case "mark_vector_restore_degraded":
          result = database.markVectorRestoreDegraded(
            MarkVectorRestoreDegradedInputSchema.parse(
              request.payload,
            ),
          );
          break;
        case "run_vector_temporal_sweep":
          result = database.runVectorTemporalSweep(
            RunVectorTemporalSweepInputSchema.parse(request.payload),
          );
          break;
        case "vector_projection_status":
          result = database.vectorProjectionStatus();
          break;
        case "write_learning_ledger":
          result = database.writeLearningLedger(
            LearningLedgerWriteCommandSchema.parse(request.payload),
          );
          break;
        case "read_learning_ledger":
          result = database.readLearningLedger(
            LearningLedgerReadInputSchema.parse(request.payload),
          );
          break;
        case "admit_memory":
          result = database.admitMemory(
            AdmitMemoryCommandSchema.parse(request.payload),
          );
          break;
        case "apply_memory_revision":
          result = database.applyMemoryRevision(
            MemoryRevisionCommandSchema.parse(request.payload),
          );
          break;
        case "get_memory_correction_basis":
          result = database.getMemoryCorrectionBasis(
            MemoryCorrectionBasisInputSchema.parse(request.payload),
          );
          break;
        case "governance_replay": {
          const replay = GovernanceReplayInputSchema.parse(request.payload);
          result = database.governanceReplay(replay);
          break;
        }
        case "memory_control_replay": {
          const replay = GovernanceReplayInputSchema.parse(request.payload);
          result = database.memoryControlReplay(replay);
          break;
        }
        case "apply_memory_control":
          result = database.applyMemoryControl(
            MemoryControlCommandSchema.parse(request.payload),
          );
          break;
        case "memory_delete_replay": {
          const replay = GovernanceReplayInputSchema.parse(request.payload);
          result = database.memoryDeleteReplay(replay);
          break;
        }
        case "delete_memory":
          result = database.deleteMemory(
            MemoryDeleteCommandSchema.parse(request.payload),
          );
          break;
        case "run_purge":
          result = database.runPurge(
            PurgeRunInputSchema.parse(request.payload),
          );
          break;
        case "check_memory_eligibility":
          result = database.checkMemoryEligibility(
            MemoryEligibilityInputSchema.parse(request.payload),
          );
          break;
        case "get_governed_memory":
          result = database.getGovernedMemory(
            GovernedMemoryLookupInputSchema.parse(request.payload),
          );
          break;
        case "search_governed_memory":
          result = database.searchGovernedMemory(
            GovernedMemorySearchQuerySchema.parse(request.payload),
          );
          break;
        case "commit_episode": {
          const committed = database.commitEpisode(
            CommitEpisodeCommandSchema.parse(request.payload),
          );
          if (committed.committed && exitAfterCommitBeforeResponse) {
            exitAfterCommitBeforeResponse = false;
            process.exit(91);
          }
          result = committed.receipt;
          break;
        }
        case "drain_fts":
          result = database.drainFtsOutbox();
          break;
        case "search_evidence":
          result = database.searchEvidence(
            SearchEvidenceQuerySchema.parse(request.payload),
          );
          break;
        case "rebuild_fts":
          result = database.rebuildFts();
          break;
        case "checkpoint":
          result = database.checkpoint();
          break;
        case "backup":
          result = await database.createBackup();
          break;
        case "verify_artifacts":
          result = database.verifyArtifacts();
          break;
        case "verify_restore_candidate":
          result = database.verifyRestoreCandidate();
          break;
        case "get_evidence":
          result = database.getEvidence(
            EvidenceLookupInputSchema.parse(request.payload),
          );
          break;
        case "explain_evidence":
          result = database.explainEvidence(
            EvidenceLookupInputSchema.parse(request.payload),
          );
          break;
        case "get_receipt":
          result = database.getReceipt(
            ReceiptLookupInputSchema.parse(request.payload),
          );
          break;
        case "record_recall":
          result = database.recordRecall(
            RecordRecallCommandSchema.parse(request.payload),
          );
          break;
        case "test_block": {
          if (!options.testOperations) {
            throw new StorageError("INVALID_INPUT");
          }
          const milliseconds = z.number().int().min(1).max(2_000).parse(
            request.payload,
          );
          database.blockForTest(milliseconds);
          result = { blocked_ms: milliseconds };
          break;
        }
        case "test_hold_write_lock": {
          if (!options.testOperations) {
            throw new StorageError("INVALID_INPUT");
          }
          const milliseconds = z.number().int().min(1).max(2_000).parse(
            request.payload,
          );
          database.holdWriteLockForTest(milliseconds);
          result = { blocked_ms: milliseconds };
          break;
        }
        case "close":
          database.close();
          result = null;
          break;
      }

      port.postMessage({
        requestId,
        ok: true,
        result,
      });
      if (request.operation === "close") {
        setImmediate(() => port.close());
      }
    } catch (error) {
      const normalized =
        error instanceof z.ZodError
          ? new StorageError("INVALID_INPUT")
          : error;
      port.postMessage({
        requestId,
        ok: false,
        error: serializeStorageError(normalized),
      });
    }
  });
});
