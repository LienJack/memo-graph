import { createHash } from "node:crypto";

import {
  CONTEXT_COMPILER_VERSION,
  CONTEXT_POLICY_VERSION,
  compileContext,
  compileLayeredContext,
  l0MemoryIdentity,
  type ContextCandidate,
  type ContextExclusion,
} from "@memo-graph/context-compiler";
import {
  GovernedResponseSchema,
  LanePolicySchema,
  LaneTelemetrySchema,
  LearningControlReceiptSchema,
  LearningControlSchema,
  LearningFeedbackObservationSchema,
  LearningInspectionSchema,
  LearningPauseInputSchema,
  LearningReleaseInputSchema,
  LearningResumeInputSchema,
  LearningRollbackInputSchema,
  LocalPrincipalSchema,
  MemoryContextCompileInputSchema,
  MemoryCorrectInputSchema,
  MemoryCandidateSchema,
  MemoryDeleteInputSchema,
  MemoryDemoteInputSchema,
  MemoryEpisodeCommitInputSchema,
  MemoryExplainInputSchema,
  MemoryGetInputSchema,
  MemoryPinInputSchema,
  MemoryReceiptGetInputSchema,
  MemoryRevokeInputSchema,
  MemorySearchInputSchema,
  MemoryProposeInputSchema,
  MemoryFeedbackInputSchema,
  MemoryUsageSetInputSchema,
  applicableRecallLanes,
  RecallRequestSchema,
  RetrievalReceiptSchema,
  authorizeRequestClaims,
  buildContextFrontierV2,
  canonicalJson,
  canonicalSha256,
  canonicalSha256Omitting,
  scopeKey,
  sealReceipt,
} from "@memo-graph/contracts";
import type {
  EvidenceRecordSchema,
  MutationRequestEnvelopeSchema,
  ProposalRequestEnvelopeSchema,
  ReadRequestEnvelopeSchema,
  ScopeSchema,
  BoundedWorkTelemetry,
  LaneTelemetry,
} from "@memo-graph/contracts";
import {
  LearningReleaseError,
  LearningReleaseManager,
  persistLearningStop,
} from "@memo-graph/learning-lab";
import {
  StorageError,
} from "@memo-graph/storage-sqlite";
import type { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import { z } from "zod";

import { evaluateAdmission } from "./governance.js";
import {
  RecallOrchestrator,
  type LayeredRecallResult,
} from "./recall-orchestrator.js";
import type {
  RecallLaneRetriever,
} from "./lane-retrievers.js";
import {
  ApprovalBindingSchema,
  ApprovalError,
  DenyAllApprovalRegistry,
  DenyAllLearningAuthorityRegistry,
  type ApprovalRegistry,
  type LearningAuthorityRegistry,
  type VerifiedApproval,
} from "./approval.js";

export { evaluateAdmission } from "./governance.js";
export {
  ConsolidationService,
  type ProjectionDrainResult,
  type ProjectionRebuildResult,
} from "./consolidation-service.js";
export {
  PROJECTION_TRANSFORM,
  buildDeterministicProjections,
  emptyProjectionFrontier,
  projectionStructuralDigest,
  type ProjectionPolicyInput,
} from "./projection-policy.js";
export {
  LayeredLaneRetrievers,
  type GraphLaneRetriever,
  type VectorLaneRetriever,
  type LaneRetrievalResult,
  type LaneRetrieverRequest,
  type RawLaneCandidate,
  type RawLaneExclusion,
  type RawMemoryLaneCandidate,
  type RawProjectionLaneCandidate,
  type RecallLaneRetriever,
} from "./lane-retrievers.js";
export {
  LayeredRecallExclusionSchema,
  LayeredRecallInputSchema,
  LayeredRecallResultSchema,
  RecallOrchestrator,
  RevalidatedRecallCandidateSchema,
  type LayeredRecallExclusion,
  type LayeredRecallInput,
  type LayeredRecallResult,
  type RevalidatedRecallCandidate,
} from "./recall-orchestrator.js";
export {
  ApprovalBindingSchema,
  ApprovalError,
  DenyAllApprovalRegistry,
  DenyAllLearningAuthorityRegistry,
  assertCanaryAuthorization,
  assertApprovalGrant,
  assertPostCanaryApproval,
  approvalRegistryHash,
  type ApprovalBinding,
  type ApprovalRegistry,
  type LearningAuthorityRegistry,
  type VerifiedApproval,
  type VerifiedCanaryAuthorization,
  type VerifiedPostCanaryApproval,
} from "./approval.js";
export {
  G3_ACCEPTED_M2_COMMIT,
  G3_ACCEPTED_M2_LOCK_HASH,
  G3_BENCHMARK_PROFILES,
  G3_PROTOCOL_VERSION,
  benchmarkG3ReplayCase,
  benchmarkLayeredCompiler,
  runG3ReplayCase,
  type G3BaselineCompiler,
  type G3ComparableInput,
  type G3ReplayOptions,
} from "./layered-benchmark.js";
export {
  buildG3ProfileProjections,
  runG3ResourceBenchmark,
  type G3ResourceBenchmarkOptions,
} from "./layered-resource-benchmark.js";

export const MemoryRuntimePolicySchema = z
  .object({
    principal: LocalPrincipalSchema,
    default_token_budget: z.number().int().positive().max(32_000).default(1_800),
    lane_policy: LanePolicySchema.default({
      allowed_lanes: ["recent_l1"],
      limits: {
        max_candidates_per_lane: 100,
        relation_max_depth: 2,
        relation_max_fanout: 20,
        max_concurrent_lanes: 2,
      },
    }),
  })
  .strict();

export type MemoryRuntimePolicy = z.input<typeof MemoryRuntimePolicySchema>;
export type GovernedResponse = z.infer<typeof GovernedResponseSchema>;

type ReadEnvelope = z.output<typeof ReadRequestEnvelopeSchema>;
type ProposalEnvelope = z.output<typeof ProposalRequestEnvelopeSchema>;
type MutationEnvelope = z.output<typeof MutationRequestEnvelopeSchema>;
type RuntimeEnvelope = ReadEnvelope | ProposalEnvelope | MutationEnvelope;
type MemoryControlRequest =
  | z.output<typeof MemoryPinInputSchema>
  | z.output<typeof MemoryDemoteInputSchema>
  | z.output<typeof MemoryUsageSetInputSchema>
  | z.output<typeof MemoryRevokeInputSchema>;
type LearningControlRequest =
  | z.output<typeof LearningPauseInputSchema>
  | z.output<typeof LearningResumeInputSchema>;
type LearningLedgerSnapshot = Awaited<
  ReturnType<SqliteStorageClient["readLearningLedger"]>
>;
type L0ContextCandidate = Extract<
  ContextCandidate,
  { abstraction: "l0_evidence" }
>;
type RetrievalAuditItem = {
  evidence?: z.output<typeof EvidenceRecordSchema>;
  memory_identity?: {
    memory_id: string;
    revision_id: string;
  };
  decision: "included" | "excluded";
  reason_codes: string[];
  lane: string;
  score: number | null;
};

function stableIdentifier(prefix: string, value: unknown): string {
  const digest = createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
  return `${prefix}:${digest.slice(0, 48)}`;
}

function sameScopeSet(
  left: readonly z.output<typeof ScopeSchema>[],
  right: readonly z.output<typeof ScopeSchema>[],
): boolean {
  const leftKeys = left.map(scopeKey).sort();
  const rightKeys = right.map(scopeKey).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index])
  );
}

function learningStateHash(ledger: LearningLedgerSnapshot) {
  return canonicalSha256({
    candidates: ledger.candidates.map((candidate) => ({
      candidate_id: candidate.candidate_id,
      candidate_hash: candidate.candidate_hash,
    })),
    candidate_states: ledger.candidate_states,
    evaluation_identities: ledger.evaluation_identities.map(
      (identity) => ({
        run_id: identity.run_id,
        common_identity_hash: identity.common_identity_hash,
      }),
    ),
    evaluation_result_sets: ledger.evaluation_result_sets.map(
      (resultSet) => ({
        run_id: resultSet.run_id,
        case_id: resultSet.case_id,
        result_set_hash: resultSet.result_set_hash,
      }),
    ),
    contamination_events: ledger.contamination_events.map((event) => ({
      contamination_event_id: event.contamination_event_id,
      event_hash: event.event_hash,
    })),
    canary_authorizations: ledger.canary_authorizations.map(
      (authorization) => ({
        authorization_id: authorization.authorization_id,
        authorization_hash: authorization.authorization_hash,
      }),
    ),
    canary_runs: ledger.canary_runs.map((run) => ({
      canary_run_id: run.canary_run_id,
      run_hash: run.run_hash,
    })),
    releases: ledger.releases.map((release) => ({
      release_id: release.release_id,
      release_hash: release.release_hash,
    })),
    pointers: ledger.pointers.map((pointer) => ({
      release_slot_hash: pointer.release_slot_hash,
      pointer_hash: pointer.pointer_hash,
    })),
    monitors: ledger.monitors.map((monitor) => ({
      monitor_id: monitor.monitor_id,
      monitor_hash: monitor.monitor_hash,
    })),
    invalid_candidate_ids: ledger.invalid_candidate_ids,
  });
}

function publicFailure(
  code:
    | "INVALID_INPUT"
    | "PERMISSION_DENIED"
    | "CONFLICT"
    | "STALE_REVISION"
    | "APPROVAL_REQUIRED"
    | "APPROVAL_INVALID"
    | "INCOMPLETE_PURGE"
    | "PROJECTION_UNAVAILABLE"
    | "QUEUE_SATURATED"
    | "RESOURCE_PRESSURE"
    | "MAINTENANCE_BLOCKED"
    | "INTERNAL_FAILURE",
  message: string,
  retryable = false,
): GovernedResponse {
  return GovernedResponseSchema.parse({
    status: "FAILED",
    receipt_id: null,
    error: { code, message, retryable, details: {} },
  });
}

function storageFailure(error: StorageError): GovernedResponse {
  switch (error.code) {
    case "CONFLICT":
      return publicFailure("CONFLICT", error.message, error.retryable);
    case "STALE_REVISION":
      return publicFailure(
        "STALE_REVISION",
        error.message,
        error.retryable,
      );
    case "APPROVAL_INVALID":
      return publicFailure(
        "APPROVAL_INVALID",
        error.message,
        error.retryable,
      );
    case "INCOMPLETE_PURGE":
      return publicFailure(
        "INCOMPLETE_PURGE",
        error.message,
        error.retryable,
      );
    case "INVALID_INPUT":
    case "INVALID_DATA_ROOT":
    case "ENCRYPTION_REQUIRED":
      return publicFailure(
        "INVALID_INPUT",
        error.message,
        error.retryable,
      );
    case "KEY_PROVIDER_INVALID":
    case "KEY_UNAVAILABLE":
    case "KEY_REVOKED":
    case "KEY_STATE_AMBIGUOUS":
    case "NONCE_REUSE":
    case "AUTHORITY_REPLAY":
    case "ROTATION_INCOMPLETE":
      return publicFailure(
        "INVALID_INPUT",
        "the secret operation is unavailable",
        false,
      );
    case "FTS_UNAVAILABLE":
      return publicFailure(
        "PROJECTION_UNAVAILABLE",
        error.message,
        error.retryable,
      );
    case "QUEUE_SATURATED":
    case "RESOURCE_PRESSURE":
    case "MAINTENANCE_BLOCKED":
      return publicFailure(error.code, error.message, error.retryable);
    case "STALE_PROJECTION_FRONTIER":
    case "STALE_TOMBSTONE_FRONTIER":
    case "STALE_LEARNING_FRONTIER":
    case "CORRUPTION":
    case "MIGRATION_DRIFT":
    case "WORKER_CRASHED":
    case "STORAGE_UNAVAILABLE":
    case "ROOT_LEASE_HELD":
    case "STALE_ROOT_LEASE":
      return publicFailure(
        "INTERNAL_FAILURE",
        error.message,
        error.retryable,
      );
  }
}

function approvalFailureCode(
  error: unknown,
): "APPROVAL_REQUIRED" | "APPROVAL_INVALID" | null {
  if (error instanceof ApprovalError) {
    return error.code;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "ApprovalError" &&
    "code" in error &&
    (error.code === "APPROVAL_REQUIRED" ||
      error.code === "APPROVAL_INVALID")
  ) {
    return error.code;
  }
  return null;
}

function sameScope(
  left: z.input<typeof ScopeSchema>,
  right: z.input<typeof ScopeSchema>,
): boolean {
  return left.kind === right.kind && left.id === right.id;
}

const EMPTY_FRONTIER_HASH = canonicalSha256([]);
const DEFAULT_PROJECTION_TRANSFORM = {
  name: "deterministic-layered-consolidation",
  version: "1.0.0",
} as const;

function recallEpochsAgree(recalls: LayeredRecallResult[]): boolean {
  const ready = recalls.filter(
    (recall) => recall.projection_scope_frontier.status === "ready",
  );
  const epochs = new Set(
    ready.map((recall) =>
      `${recall.projection_scope_frontier.ledger_epoch}:${
        recall.projection_scope_frontier.tombstone_epoch
      }`
    ),
  );
  return epochs.size === 1;
}

function aggregateBoundedWork(
  rows: LaneTelemetry[],
): BoundedWorkTelemetry[] | undefined {
  const byBoundary = new Map<
    BoundedWorkTelemetry["boundary"],
    BoundedWorkTelemetry[]
  >();
  for (const row of rows) {
    for (const item of row.bounded_work ?? []) {
      const current = byBoundary.get(item.boundary) ?? [];
      current.push(item);
      byBoundary.set(item.boundary, current);
    }
  }
  const aggregated = [...byBoundary.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([boundary, items]) => {
      const complete = items.every((item) => item.complete);
      const reasonCode = [
        ...new Set(
          items.flatMap((item) =>
            item.reason_code === undefined ? [] : [item.reason_code]
          ),
        ),
      ].sort()[0];
      return {
        boundary,
        configured_limit: items.reduce(
          (sum, item) => sum + item.configured_limit,
          0,
        ),
        observed_count: items.reduce(
          (sum, item) => sum + item.observed_count,
          0,
        ),
        retained_count: items.reduce(
          (sum, item) => sum + item.retained_count,
          0,
        ),
        truncated_count: items.reduce(
          (sum, item) => sum + item.truncated_count,
          0,
        ),
        complete,
        ...(complete || reasonCode === undefined
          ? {}
          : { reason_code: reasonCode }),
      };
    });
  return aggregated.length === 0 ? undefined : aggregated;
}

function aggregateRecallTelemetry(options: {
  recalls: LayeredRecallResult[];
  projectionDegradationReason: string | null;
  dropProjectionCandidates: boolean;
}): LaneTelemetry[] {
  const statusOrder = [
    "unavailable",
    "degraded",
    "stale",
    "eligible",
    "empty",
    "disabled_by_policy",
    "disabled_by_request",
  ] as const;
  const telemetryLanes = applicableRecallLanes(
    options.recalls.flatMap(
      (recall) => recall.effective_configuration.requested_lanes,
    ),
  );
  return LaneTelemetrySchema.array().parse(
    telemetryLanes.map((lane) => {
      const rows = options.recalls.map((recall) => {
        const row = recall.telemetry.find((item) => item.lane === lane);
        if (row === undefined) {
          throw new Error(`recall telemetry is missing lane ${lane}`);
        }
        return row;
      });
      const disabled = rows.every((row) =>
        row.status === "disabled_by_policy" ||
        row.status === "disabled_by_request"
      );
      const projectionFallback =
        lane !== "recent_l1" &&
        options.projectionDegradationReason !== null &&
        !disabled;
      const removedCandidates =
        projectionFallback && options.dropProjectionCandidates
        ? options.recalls.reduce(
            (sum, recall) =>
              sum +
              recall.candidates.filter(
                (candidate) =>
                  candidate.kind === "projection" &&
                  candidate.lane === lane,
              ).length,
            0,
          )
        : 0;
      const exclusionCounts = Object.fromEntries(
        [
          ...new Set(
            rows.flatMap((row) => Object.keys(row.exclusion_counts)),
          ),
          ...(removedCandidates > 0 &&
              options.projectionDegradationReason !== null
            ? [options.projectionDegradationReason]
            : []),
        ].sort().map((reason) => [
          reason,
          rows.reduce(
            (sum, row) => sum + (row.exclusion_counts[reason] ?? 0),
            0,
          ) +
            (reason === options.projectionDegradationReason
              ? removedCandidates
              : 0),
        ]),
      );
      const boundedWork = aggregateBoundedWork(rows);
      const queryHashes = [
        ...new Set(rows.flatMap((row) => row.query_hashes ?? [])),
      ].sort();
      return {
        lane,
        status: projectionFallback
          ? "degraded"
          : statusOrder.find((status) =>
              rows.some((row) => row.status === status)
            ) ?? rows[0]?.status ?? "empty",
        duration_ms: rows.reduce(
          (sum, row) => sum + row.duration_ms,
          0,
        ),
        candidate_count: rows.reduce(
          (sum, row) => sum + row.candidate_count,
          0,
        ),
        eligible_count:
          projectionFallback && options.dropProjectionCandidates
          ? 0
          : rows.reduce(
              (sum, row) => sum + row.eligible_count,
              0,
            ),
        selected_count: 0,
        exclusion_counts: exclusionCounts,
        reason_codes: [
          ...new Set([
            ...rows.flatMap((row) => row.reason_codes),
            ...(projectionFallback &&
                options.projectionDegradationReason !== null
              ? [options.projectionDegradationReason]
              : []),
          ]),
        ].sort(),
        ...(boundedWork === undefined
          ? {}
          : { bounded_work: boundedWork }),
        ...(queryHashes.length === 0
          ? {}
          : { query_hashes: queryHashes }),
      };
    }),
  );
}

function buildRecallFrontier(recalls: LayeredRecallResult[]) {
  if (recalls.length === 0) {
    throw new Error("layered recall requires at least one exact scope");
  }
  const ready = recalls.filter(
    (recall) => recall.projection_scope_frontier.status === "ready",
  );
  const epochSources = ready.length > 0 ? ready : recalls;
  return buildContextFrontierV2({
    ledger_epoch: Math.max(
      ...epochSources.map(
        (recall) => recall.projection_scope_frontier.ledger_epoch,
      ),
    ),
    tombstone_epoch: Math.max(
      ...epochSources.map(
        (recall) => recall.projection_scope_frontier.tombstone_epoch,
      ),
    ),
    scope_frontiers: recalls.map((recall) => {
      const frontier = recall.projection_scope_frontier;
      const ready = frontier.status === "ready";
      return {
        scope: frontier.scope,
        projection_epoch: frontier.projection_epoch,
        source_frontier_hash:
          ready
            ? frontier.source_frontier_hash ?? EMPTY_FRONTIER_HASH
            : EMPTY_FRONTIER_HASH,
        projection_frontier_hash:
          ready
            ? frontier.projection_frontier_hash ?? EMPTY_FRONTIER_HASH
            : EMPTY_FRONTIER_HASH,
        transform_versions:
          ready && frontier.transform_versions.length > 0
            ? frontier.transform_versions
            : [DEFAULT_PROJECTION_TRANSFORM],
      };
    }),
  });
}

export class MemoryRuntime {
  readonly #storage: SqliteStorageClient;
  readonly #policy: z.output<typeof MemoryRuntimePolicySchema>;
  readonly #approvalRegistry: ApprovalRegistry;
  readonly #learningReleaseManager: LearningReleaseManager;
  readonly #clock: () => string;
  readonly #recallOrchestrator: RecallOrchestrator;

  constructor(options: {
    storage: SqliteStorageClient;
    policy: MemoryRuntimePolicy;
    approvalRegistry?: ApprovalRegistry;
    learningAuthorityRegistry?: LearningAuthorityRegistry;
    clock?: () => string;
    laneRetriever?: RecallLaneRetriever;
  }) {
    this.#storage = options.storage;
    this.#policy = MemoryRuntimePolicySchema.parse(options.policy);
    this.#approvalRegistry =
      options.approvalRegistry ?? new DenyAllApprovalRegistry();
    const learningAuthorityRegistry =
      options.learningAuthorityRegistry ??
      new DenyAllLearningAuthorityRegistry();
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#learningReleaseManager = new LearningReleaseManager({
      storage: options.storage,
      authorityRegistry: learningAuthorityRegistry,
      approvalRegistry: this.#approvalRegistry,
      clock: this.#clock,
    });
    this.#recallOrchestrator = new RecallOrchestrator({
      storage: options.storage,
      ...(options.laneRetriever === undefined
        ? {}
        : { retriever: options.laneRetriever }),
    });
  }

  memorySearch(input: unknown): Promise<GovernedResponse> {
    return this.#execute(async () => {
      const request = MemorySearchInputSchema.parse(input);
      const unauthorized = this.#authorize(request.envelope);
      if (unauthorized !== null) {
        return unauthorized;
      }

      const searched = await this.#searchContextScopes(
        request.query,
        request.envelope.scopes,
        request.limit,
        request.envelope.requested_at,
        request.include_sensitive,
      );
      const allowed: RetrievalAuditItem[] = [];
      const excluded: RetrievalAuditItem[] = [];
      const outputItems: unknown[] = [];
      for (const candidate of searched.candidates) {
        if (candidate.abstraction === "l1_memory") {
          allowed.push({
            memory_identity: {
              memory_id: candidate.memory.memory_id,
              revision_id: candidate.memory.revision_id,
            },
            decision: "included",
            reason_codes: candidate.memory.reason_codes,
            lane: candidate.lane,
            score: candidate.rank,
          });
          outputItems.push(candidate.memory);
        } else if (
          (candidate.evidence.sensitivity === "sensitive" &&
            !request.include_sensitive) ||
          candidate.evidence.sensitivity === "secret"
        ) {
          excluded.push({
            evidence: candidate.evidence,
            decision: "excluded",
            reason_codes: [
              candidate.evidence.sensitivity === "secret"
                ? "SECRET_EXCLUDED"
                : "SENSITIVE_EXCLUDED",
            ],
            lane: candidate.lane,
            score: candidate.rank,
          });
        } else {
          allowed.push({
            evidence: candidate.evidence,
            decision: "included",
            reason_codes: ["RANKED_EVIDENCE"],
            lane: candidate.lane,
            score: candidate.rank,
          });
          outputItems.push(candidate.evidence);
        }
      }
      for (const item of searched.exclusions) {
        excluded.push({
          memory_identity: {
            memory_id: item.memory_id,
            revision_id: item.revision_id,
          },
          decision: "excluded",
          reason_codes: [item.reason_code],
          lane: item.lane,
          score: item.score,
        });
      }
      const audit = await this.#recordAudit({
        envelope: request.envelope,
        query: request.query,
        includeSensitive: request.include_sensitive,
        items: [...allowed, ...excluded],
        partial: searched.degraded.length > 0,
      });
      const data = {
        items: outputItems,
        receipt: audit.receipt,
      };
      if (searched.degraded.length > 0) {
        return GovernedResponseSchema.parse({
          status: "DEGRADED",
          receipt_id: audit.receipt.receipt_id,
          fallback_lane:
            allowed.length > 0 ? "partial_sqlite_fts" : "none",
          warnings: searched.degraded,
          data,
        });
      }
      if (allowed.length > 0) {
        return GovernedResponseSchema.parse({
          status: "OK",
          receipt_id: audit.receipt.receipt_id,
          data,
        });
      }
      if (excluded.length > 0) {
        return GovernedResponseSchema.parse({
          status: "POLICY_EXCLUDED",
          receipt_id: audit.receipt.receipt_id,
          excluded_count: excluded.length,
          reason_codes: [
            ...new Set(excluded.flatMap((item) => item.reason_codes)),
          ].sort(),
        });
      }
      return GovernedResponseSchema.parse({
        status: "NO_MATCH",
        receipt_id: audit.receipt.receipt_id,
        reason: "no exact-scope evidence matched the query",
      });
    });
  }

  memoryGet(input: unknown): Promise<GovernedResponse> {
    return this.#evidenceRead(input, MemoryGetInputSchema, "get");
  }

  memoryExplain(input: unknown): Promise<GovernedResponse> {
    return this.#evidenceRead(input, MemoryExplainInputSchema, "explain");
  }

  memoryReceiptGet(input: unknown): Promise<GovernedResponse> {
    return this.#execute(async () => {
      const request = MemoryReceiptGetInputSchema.parse(input);
      const unauthorized = this.#authorize(request.envelope);
      if (unauthorized !== null) {
        return unauthorized;
      }
      const receipt = await this.#storage.getReceipt({
        receipt_id: request.receipt_id,
        principal_id: request.envelope.actor_claim.principal_id,
        scopes: request.envelope.scopes,
      });
      const audit = await this.#recordAudit({
        envelope: request.envelope,
        query: `receipt:${request.receipt_id}`,
        includeSensitive: false,
        items: [],
        partial: false,
      });
      if (receipt === null) {
        return GovernedResponseSchema.parse({
          status: "NO_MATCH",
          receipt_id: audit.receipt.receipt_id,
          reason: "the requested receipt does not exist",
        });
      }
      return GovernedResponseSchema.parse({
        status: "OK",
        receipt_id: audit.receipt.receipt_id,
        data: { receipt, audit_receipt: audit.receipt },
      });
    });
  }

  memoryFeedback(input: unknown): Promise<GovernedResponse> {
    return this.#execute(async () => {
      const request = MemoryFeedbackInputSchema.parse(input);
      const unauthorized = this.#authorize(request.envelope);
      if (unauthorized !== null) {
        return unauthorized;
      }
      for (const evidenceId of request.feedback.evidence_ids) {
        let accessible = false;
        for (const scope of request.envelope.scopes) {
          if (
            await this.#storage.getEvidence({
              evidence_id: evidenceId,
              principal_id:
                request.envelope.actor_claim.principal_id,
              scope,
            })
          ) {
            accessible = true;
            break;
          }
        }
        if (!accessible) {
          return publicFailure(
            "PERMISSION_DENIED",
            "feedback evidence is outside the exact request scope",
          );
        }
      }
      const requestHash = canonicalSha256(request);
      const ledger = await this.#storage.readLearningLedger({
        principal_id: request.envelope.actor_claim.principal_id,
        scopes: request.envelope.scopes,
      });
      const control = ledger.controls.at(-1);
      const feedbackInput = {
        schema_version: request.envelope.schema_version,
        feedback_id: stableIdentifier("learning-feedback", {
          idempotency_key: request.envelope.idempotency_key,
          request_hash: requestHash,
        }),
        task_id: request.feedback.task_id,
        context_slice_id: request.feedback.context_slice_id,
        outcome: request.feedback.outcome,
        evidence_ids: [...request.feedback.evidence_ids].sort(),
        error_codes: [...request.feedback.error_codes].sort(),
        gap_codes: [...request.feedback.gap_codes].sort(),
        observed_at: request.feedback.observed_at,
        feedback_hash: canonicalSha256("placeholder"),
      };
      const feedback = LearningFeedbackObservationSchema.parse({
        ...feedbackInput,
        feedback_hash: canonicalSha256Omitting(feedbackInput, [
          "feedback_hash",
        ]),
      });
      const stopped = await persistLearningStop({
        storage: this.#storage,
        idempotencyKey: request.envelope.idempotency_key,
        idempotencyHash: requestHash,
        principalId: request.envelope.actor_claim.principal_id,
        scopes: request.envelope.scopes,
        controlEpoch: control?.control_epoch ?? 0,
        reasonCode:
          control?.status === "paused"
            ? "LEARNING_PAUSED"
            : "FEEDBACK_RECORDED_PENDING_TRACE",
        createdAt: request.feedback.observed_at,
        requestIdentity: request,
        feedback,
      });
      return GovernedResponseSchema.parse({
        status: "OK",
        receipt_id: stopped.receipt.receipt_id,
        data: {
          receipt: stopped.receipt,
          reason_code: stopped.receipt.reason_code,
          evidence_ids: [...request.feedback.evidence_ids].sort(),
          candidate_published: false,
          pointer_changed: false,
        },
      });
    });
  }

  learningPause(input: unknown): Promise<GovernedResponse> {
    return this.#execute(async () =>
      this.#learningControl(
        LearningPauseInputSchema.parse(input),
        "pause",
      )
    );
  }

  learningResume(input: unknown): Promise<GovernedResponse> {
    return this.#execute(async () =>
      this.#learningControl(
        LearningResumeInputSchema.parse(input),
        "resume",
      )
    );
  }

  learningRelease(input: unknown): Promise<GovernedResponse> {
    return this.#execute(async () => {
      const request = LearningReleaseInputSchema.parse(input);
      const unauthorized = this.#authorize(request.envelope);
      if (unauthorized !== null) {
        return unauthorized;
      }
      const ledger = await this.#storage.readLearningLedger({
        principal_id: request.envelope.actor_claim.principal_id,
        scopes: request.envelope.scopes,
        candidate_id: request.candidate_id,
      });
      const candidate = ledger.candidates.find(
        (item) => item.candidate_id === request.candidate_id,
      );
      if (
        candidate === undefined ||
        candidate.release_slot === null
      ) {
        throw new LearningReleaseError("CANDIDATE_INACCESSIBLE");
      }
      const result = await this.#learningReleaseManager.apply(
        {
          schema_version: request.envelope.schema_version,
          action: "release",
          idempotency_key: request.envelope.idempotency_key,
          principal_id: request.envelope.actor_claim.principal_id,
          scopes: request.envelope.scopes,
          candidate_id: request.candidate_id,
          approval_id: request.envelope.approval_id,
          target_release_id: null,
          operator_lane_policy:
            candidate.target.kind === "retrieval_policy"
              ? this.#policy.lane_policy
              : null,
          base_configuration_hash:
            request.base_configuration_hash,
          monitor_contract_hash: request.monitor_contract_hash,
          monitor_receipt_id: null,
          reason: request.envelope.reason,
          activated_at: request.envelope.requested_at,
        },
        {
          requestHash: canonicalSha256(request),
          expected: {
            release_slot_hash: request.release_slot_hash,
            evaluation_receipt_id:
              request.evaluation_receipt_id,
            canary_receipt_id: request.canary_receipt_id,
            pointer_revision: request.expected_pointer_revision,
            control_epoch: request.expected_control_epoch,
            effect_manifest_hash: request.effect_manifest_hash,
          },
        },
      );
      return GovernedResponseSchema.parse({
        status: "OK",
        receipt_id: result.receipt.receipt_id,
        data: result,
      });
    });
  }

  learningRollback(input: unknown): Promise<GovernedResponse> {
    return this.#execute(async () => {
      const request = LearningRollbackInputSchema.parse(input);
      const unauthorized = this.#authorize(request.envelope);
      if (unauthorized !== null) {
        return unauthorized;
      }
      const ledger = await this.#storage.readLearningLedger({
        principal_id: request.envelope.actor_claim.principal_id,
        scopes: request.envelope.scopes,
      });
      const currentRelease = ledger.releases.find(
        (release) => release.release_id === request.release_id,
      );
      if (currentRelease === undefined) {
        throw new LearningReleaseError("POINTER_CONFLICT");
      }
      const candidate = ledger.candidates.find(
        (item) => item.candidate_id === currentRelease.candidate_id,
      );
      if (
        candidate === undefined ||
        candidate.release_slot === null
      ) {
        throw new LearningReleaseError("CANDIDATE_INACCESSIBLE");
      }
      const result = await this.#learningReleaseManager.apply(
        {
          schema_version: request.envelope.schema_version,
          action: "rollback",
          idempotency_key: request.envelope.idempotency_key,
          principal_id: request.envelope.actor_claim.principal_id,
          scopes: request.envelope.scopes,
          candidate_id: currentRelease.candidate_id,
          approval_id: request.envelope.approval_id,
          target_release_id: request.restore_release_id,
          operator_lane_policy:
            candidate.target.kind === "retrieval_policy"
              ? this.#policy.lane_policy
              : null,
          base_configuration_hash:
            request.base_configuration_hash,
          monitor_contract_hash:
            currentRelease.monitor_contract_hash,
          monitor_receipt_id: request.monitor_receipt_id,
          reason: request.envelope.reason,
          activated_at: request.envelope.requested_at,
        },
        {
          requestHash: canonicalSha256(request),
          expected: {
            release_slot_hash: currentRelease.release_slot_hash,
            evaluation_receipt_id:
              currentRelease.evaluation_receipt_id,
            canary_receipt_id: currentRelease.canary_receipt_id,
            pointer_revision: request.expected_pointer_revision,
            control_epoch: request.expected_control_epoch,
            effect_manifest_hash: request.effect_manifest_hash,
            current_release_id: request.release_id,
          },
        },
      );
      return GovernedResponseSchema.parse({
        status: "OK",
        receipt_id: result.receipt.receipt_id,
        data: result,
      });
    });
  }

  async learningInspection() {
    const snapshot = await this.#learningActionSnapshot();
    const { health, ledger } = snapshot;
    const states = new Map(
      ledger.candidate_states.map((state) => [
        state.candidate_id,
        state,
      ]),
    );
    return LearningInspectionSchema.parse({
      schema_version: "1.0.0",
      principal_id: this.#policy.principal.principal_id,
      action_frontier: {
        expected_control_epoch:
          snapshot.currentControl?.control_epoch ?? 0,
        expected_release_revision:
          health.learning_frontier.release_revision,
        expected_frontier_hash:
          health.learning_frontier.frontier_hash,
        runtime_identity_hash: snapshot.runtimeIdentityHash,
        configuration_hash: snapshot.configurationHash,
        corpus_hash: snapshot.corpusHash,
        learning_state_hash: snapshot.learningStateHash,
        required_scopes: snapshot.requiredScopes,
      },
      storage_frontier: health.learning_frontier,
      control: ledger.controls.at(-1) ?? null,
      candidates: ledger.candidates
        .map((candidate) => {
          const state = states.get(candidate.candidate_id);
          return {
            candidate_id: candidate.candidate_id,
            candidate_hash: candidate.candidate_hash,
            candidate_type: candidate.candidate_type,
            release_capability: candidate.release_capability,
            state: state?.state ?? "proposed",
            sequence: state?.sequence ?? 0,
            transition_hash: state?.transition_hash ?? null,
            release_slot_hash:
              candidate.release_slot?.slot_hash ?? null,
          };
        })
        .sort((left, right) =>
          left.candidate_id.localeCompare(right.candidate_id)
        ),
      releases: ledger.releases
        .map((release) => ({
          release_id: release.release_id,
          release_hash: release.release_hash,
          action: release.action,
          candidate_id: release.candidate_id,
          configuration_hash: release.configuration_hash,
        }))
        .sort((left, right) =>
          left.release_id.localeCompare(right.release_id)
        ),
      pointers: [...ledger.pointers].sort((left, right) =>
        left.release_slot_hash.localeCompare(right.release_slot_hash)
      ),
      receipts: ledger.receipts
        .map((receipt) => ({
          receipt_id: receipt.receipt_id,
          kind: receipt.kind,
          state: receipt.state,
          receipt_hash: receipt.receipt_hash,
          created_at: receipt.created_at,
        }))
        .sort((left, right) =>
          left.receipt_id.localeCompare(right.receipt_id)
        ),
      limitations: [
        "CONTENT_EXCLUDED",
        "EXACT_CONFIGURED_SCOPE_SET_ONLY",
        "INSPECTION_DOES_NOT_MUTATE_OR_ENTER_CONTEXT",
      ],
    });
  }

  memoryContextCompile(input: unknown): Promise<GovernedResponse> {
    return this.#execute(async () => {
      const request = MemoryContextCompileInputSchema.parse(input);
      const unauthorized = this.#authorize(request.envelope);
      if (unauthorized !== null) {
        return unauthorized;
      }
      const layeredMode = this.#policy.lane_policy.allowed_lanes.some(
        (lane) => lane !== "recent_l1",
      );
      const compileRequest = layeredMode
        ? MemoryContextCompileInputSchema.parse({
            ...request,
            recall: {
              ...request.recall,
              scopes: [...request.recall.scopes].sort((left, right) =>
                scopeKey(left).localeCompare(scopeKey(right))
              ),
            },
          })
        : request;
      const compiled = layeredMode
        ? await this.#compileLayeredContext(compileRequest)
        : await this.#compileLegacyContext(compileRequest);
      const stored = await this.#storage.recordRecall({
        principal_id: this.#policy.principal.principal_id,
        request: compileRequest.recall,
        receipt: compiled.receipt,
        ...(compiled.context_slice === null
          ? {}
          : { context_slice: compiled.context_slice }),
      });
      const data = {
        context_slice: stored.context_slice,
        receipt: stored.receipt,
        replayed: stored.replayed,
      };
      const fallbackLane = layeredMode ? "recent_l1" : "partial_sqlite_fts";
      if (stored.replayed) {
        if (stored.receipt.state === "partial") {
          return GovernedResponseSchema.parse({
            status: "DEGRADED",
            receipt_id: stored.receipt.receipt_id,
            fallback_lane:
              stored.context_slice === null ? "none" : fallbackLane,
            warnings: ["frozen replay of a partial retrieval"],
            data,
          });
        }
        if (stored.context_slice !== null) {
          return GovernedResponseSchema.parse({
            status: "OK",
            receipt_id: stored.receipt.receipt_id,
            data,
          });
        }
        const excluded = stored.receipt.items.filter(
          (item) => item.decision === "excluded",
        );
        if (excluded.length > 0) {
          return GovernedResponseSchema.parse({
            status: "POLICY_EXCLUDED",
            receipt_id: stored.receipt.receipt_id,
            excluded_count: excluded.length,
            reason_codes: [
              ...new Set(
                excluded.flatMap((item) => item.reason_codes),
              ),
            ].sort(),
          });
        }
        return GovernedResponseSchema.parse({
          status: "NO_MATCH",
          receipt_id: stored.receipt.receipt_id,
          reason: "the frozen replay contains no matched evidence",
        });
      }
      if (compiled.status === "DEGRADED") {
        return GovernedResponseSchema.parse({
          status: "DEGRADED",
          receipt_id: stored.receipt.receipt_id,
          fallback_lane:
            stored.context_slice === null ? "none" : fallbackLane,
          warnings: compiled.warnings,
          data,
        });
      }
      if (compiled.status === "OK") {
        return GovernedResponseSchema.parse({
          status: "OK",
          receipt_id: stored.receipt.receipt_id,
          data,
        });
      }
      if (compiled.status === "POLICY_EXCLUDED") {
        return GovernedResponseSchema.parse({
          status: "POLICY_EXCLUDED",
          receipt_id: stored.receipt.receipt_id,
          excluded_count: compiled.excluded_count,
          reason_codes: compiled.reason_codes,
        });
      }
      return GovernedResponseSchema.parse({
        status: "NO_MATCH",
        receipt_id: stored.receipt.receipt_id,
        reason: "no exact-scope evidence matched the recall request",
      });
    });
  }

  async #compileLegacyContext(
    request: z.output<typeof MemoryContextCompileInputSchema>,
  ) {
    const searched = await this.#searchContextScopes(
      request.recall.query,
      request.recall.scopes,
      100,
      request.recall.as_of,
      request.recall.include_sensitive,
    );
    return compileContext({
      request: request.recall,
      candidates: searched.candidates,
      exclusions: searched.exclusions,
      created_at: request.envelope.requested_at,
      degraded_lanes: searched.degraded,
    });
  }

  async #compileLayeredContext(
    request: z.output<typeof MemoryContextCompileInputSchema>,
  ) {
    const scopes = [...request.recall.scopes].sort((left, right) =>
      scopeKey(left).localeCompare(scopeKey(right))
    );
    const resolvedEffectiveConfiguration =
      await this.#recallOrchestrator.resolveEffectiveConfiguration({
        principal_id: this.#policy.principal.principal_id,
        scopes,
        lane_policy: this.#policy.lane_policy,
        ...(request.recall.lane_overrides === undefined
          ? {}
          : { lane_overrides: request.recall.lane_overrides }),
      });
    const recallAllScopes = () =>
      Promise.all(
        scopes.map((scope) =>
          this.#recallOrchestrator.recall({
            principal_id: this.#policy.principal.principal_id,
            scope,
            query: request.recall.query,
            as_of: request.recall.as_of,
            include_sensitive: request.recall.include_sensitive,
            lane_policy: this.#policy.lane_policy,
            ...(resolvedEffectiveConfiguration
                .active_learning_release_id === undefined
              ? {}
              : {
                  resolved_effective_configuration:
                    resolvedEffectiveConfiguration,
                }),
            ...(request.recall.lane_overrides === undefined
              ? {}
              : { lane_overrides: request.recall.lane_overrides }),
          })
        ),
      );
    let recalls = await recallAllScopes();
    if (!recallEpochsAgree(recalls)) {
      recalls = await recallAllScopes();
    }
    const first = recalls[0];
    if (first === undefined) {
      throw new Error("layered recall requires at least one exact scope");
    }
    const epochMismatch = !recallEpochsAgree(recalls);
    const scopeFrontierNotReady = recalls.some(
      (recall) => recall.projection_scope_frontier.status !== "ready",
    );
    const projectionDegradationReason = epochMismatch
      ? "SCOPE_FRONTIER_EPOCH_MISMATCH"
      : scopeFrontierNotReady
        ? "PROJECTION_SCOPE_NOT_READY"
        : null;
    const dropProjectionCandidates = epochMismatch;
    const candidates = recalls.flatMap((recall) => recall.candidates);
    const retainedCandidates =
      dropProjectionCandidates
        ? candidates.filter((candidate) => candidate.kind === "memory")
        : candidates;
    const runtimeExclusions =
      !dropProjectionCandidates
        ? []
        : candidates.flatMap((candidate) =>
            candidate.kind === "projection"
              ? [{
                  memory_id: candidate.projection.projection_id,
                  revision_id:
                    candidate.projection.projection_revision_id,
                  lane: candidate.lane,
                  reason_code: "SCOPE_FRONTIER_EPOCH_MISMATCH",
                  score: candidate.rank,
                  ...(candidate.graph_path === undefined
                    ? {}
                    : { graph_path: candidate.graph_path }),
                }]
              : []
          );
    const frontier = buildRecallFrontier(recalls);
    const telemetry = aggregateRecallTelemetry({
      recalls,
      projectionDegradationReason,
      dropProjectionCandidates,
    });
    return compileLayeredContext({
      request: request.recall,
      candidates: retainedCandidates,
      exclusions: [
        ...recalls.flatMap((recall) => recall.exclusions),
        ...runtimeExclusions,
      ],
      frontier,
      effective_configuration: first.effective_configuration,
      telemetry,
      created_at: request.envelope.requested_at,
    });
  }

  memoryPropose(input: unknown): Promise<GovernedResponse> {
    return this.#execute(async () => {
      const request = MemoryProposeInputSchema.parse(input);
      const unauthorized = this.#authorize(request.envelope);
      if (unauthorized !== null) {
        return unauthorized;
      }
      const replay = await this.#storage.governanceReplay({
        idempotency_key: request.envelope.idempotency_key,
        request_hash: canonicalSha256(request),
      });
      if (replay !== null) {
        return GovernedResponseSchema.parse({
          status: "OK",
          receipt_id: replay.receipt.receipt_id,
          data: replay,
        });
      }
      const evidence = await Promise.all(
        request.candidate.evidence_ids.map((evidenceId) =>
          this.#storage.getEvidence({
            evidence_id: evidenceId,
            principal_id: this.#policy.principal.principal_id,
            scope: request.candidate.scope,
          }),
        ),
      );
      if (
        new Set(request.candidate.evidence_ids).size !==
          request.candidate.evidence_ids.length ||
        evidence.some((item) => item === null)
      ) {
        return publicFailure(
          "INVALID_INPUT",
          "candidate evidence is missing, deleted, or outside the exact scope",
        );
      }
      const liveEvidence = evidence.filter(
        (item): item is NonNullable<typeof item> => item !== null,
      );
      const evaluation = evaluateAdmission(
        request.candidate,
        liveEvidence,
      );
      if (evaluation.decision === "reject") {
        return publicFailure("INVALID_INPUT", evaluation.reason);
      }
      const result = await this.#storage.admitMemory({
        request,
        evaluation,
      });
      return GovernedResponseSchema.parse({
        status: "OK",
        receipt_id: result.receipt.receipt_id,
        data: result,
      });
    });
  }

  memoryPin(input: unknown): Promise<GovernedResponse> {
    return this.#execute(async () =>
      this.#memoryControl(MemoryPinInputSchema.parse(input)),
    );
  }

  memoryCorrect(input: unknown): Promise<GovernedResponse> {
    return this.#execute(async () => {
      const request = MemoryCorrectInputSchema.parse(input);
      const unauthorized = this.#authorize(request.envelope);
      if (unauthorized !== null) {
        return unauthorized;
      }
      const requestHash = canonicalSha256(request);
      const replay = await this.#storage.governanceReplay({
        idempotency_key: request.envelope.idempotency_key,
        request_hash: requestHash,
      });
      if (replay !== null) {
        return GovernedResponseSchema.parse({
          status: "OK",
          receipt_id: replay.receipt.receipt_id,
          data: replay,
        });
      }
      const expectedRevisionId = request.envelope.expected_revision_id;
      if (expectedRevisionId === null) {
        throw new StorageError("STALE_REVISION");
      }
      let basis:
        | NonNullable<Awaited<
            ReturnType<SqliteStorageClient["getMemoryCorrectionBasis"]>
          >>
        | undefined;
      for (const scope of request.envelope.scopes) {
        const candidateBasis =
          await this.#storage.getMemoryCorrectionBasis({
            memory_id: request.memory_id,
            principal_id:
              request.envelope.actor_claim.principal_id,
            scope,
            expected_revision_id: expectedRevisionId,
          });
        if (candidateBasis !== null) {
          basis = candidateBasis;
          break;
        }
      }
      if (basis === undefined) {
        throw new StorageError("STALE_REVISION");
      }
      const candidate = MemoryCandidateSchema.parse({
        schema_version: "1.0.0",
        candidate_id: stableIdentifier("candidate", {
          idempotency_key: request.envelope.idempotency_key,
          request_hash: requestHash,
        }),
        logical_key: basis.logical_key,
        kind: basis.kind,
        scope: basis.scope,
        sensitivity: basis.sensitivity,
        inferred: basis.inferred,
        content: request.replacement.content,
        content_hash: request.replacement.content_hash,
        evidence_ids: request.replacement.evidence_ids,
        validity: request.replacement.validity,
        injection_risk: "none",
        requires_user_confirmation: false,
        transform: {
          name: "memory-correction",
          version: "1.0.0",
        },
      });
      const evidence = await Promise.all(
        candidate.evidence_ids.map((evidenceId) =>
          this.#storage.getEvidence({
            evidence_id: evidenceId,
            principal_id:
              request.envelope.actor_claim.principal_id,
            scope: candidate.scope,
          }),
        ),
      );
      if (
        new Set(candidate.evidence_ids).size !==
          candidate.evidence_ids.length ||
        evidence.some((item) => item === null)
      ) {
        return publicFailure(
          "INVALID_INPUT",
          "correction evidence is missing, deleted, or outside the exact scope",
        );
      }
      const evaluation = evaluateAdmission(
        candidate,
        evidence.filter(
          (item): item is NonNullable<typeof item> => item !== null,
        ),
      );
      if (evaluation.decision === "reject") {
        return publicFailure("INVALID_INPUT", evaluation.reason);
      }

      let approval: VerifiedApproval | undefined;
      let binding:
        | z.output<typeof ApprovalBindingSchema>
        | undefined;
      if (!request.envelope.dry_run) {
        if (request.envelope.approval_id === null) {
          throw new ApprovalError("APPROVAL_REQUIRED");
        }
        binding = ApprovalBindingSchema.parse({
          approval_id: request.envelope.approval_id,
          principal_id:
            request.envelope.actor_claim.principal_id,
          tool: request.envelope.tool,
          safety_class: request.envelope.safety_class,
          scopes: request.envelope.scopes,
          request_hash: requestHash,
        });
        approval = await this.#approvalRegistry.verify(binding);
        await this.#approvalRegistry.confirmUnchanged(approval);
      }
      const result = await this.#storage.applyMemoryRevision({
        idempotency_key: request.envelope.idempotency_key,
        principal_id:
          request.envelope.actor_claim.principal_id,
        actor_authority: request.envelope.actor_claim.authority,
        scope: basis.scope,
        requested_at: request.envelope.requested_at,
        memory_id: request.memory_id,
        expected_revision_id: expectedRevisionId,
        candidate,
        evaluation,
        dry_run: request.envelope.dry_run,
        ...(approval === undefined || binding === undefined
          ? {}
          : {
              request_hash: requestHash,
              approval_binding: binding,
              approval: {
                grant: approval.grant,
                registry_hash: approval.registry_hash,
                verified_at: this.#clock(),
              },
            }),
      });
      return GovernedResponseSchema.parse({
        status: "OK",
        receipt_id: result.receipt.receipt_id,
        data: result,
      });
    });
  }

  memoryDemote(input: unknown): Promise<GovernedResponse> {
    return this.#execute(async () =>
      this.#memoryControl(MemoryDemoteInputSchema.parse(input)),
    );
  }

  memoryUsageSet(input: unknown): Promise<GovernedResponse> {
    return this.#execute(async () =>
      this.#memoryControl(MemoryUsageSetInputSchema.parse(input)),
    );
  }

  memoryRevoke(input: unknown): Promise<GovernedResponse> {
    return this.#execute(async () =>
      this.#memoryControl(MemoryRevokeInputSchema.parse(input)),
    );
  }

  memoryDelete(input: unknown): Promise<GovernedResponse> {
    return this.#execute(async () => {
      const request = MemoryDeleteInputSchema.parse(input);
      const unauthorized = this.#authorize(request.envelope);
      if (unauthorized !== null) {
        return unauthorized;
      }
      const requestHash = canonicalSha256(request);
      const replay = await this.#storage.memoryDeleteReplay({
        idempotency_key: request.envelope.idempotency_key,
        request_hash: requestHash,
      });
      if (replay !== null) {
        return GovernedResponseSchema.parse({
          status: "OK",
          receipt_id: replay.receipt.receipt_id,
          data: replay,
        });
      }
      let approval: VerifiedApproval | null = null;
      if (!request.envelope.dry_run) {
        if (request.envelope.approval_id === null) {
          throw new ApprovalError("APPROVAL_REQUIRED");
        }
        const binding = ApprovalBindingSchema.parse({
          approval_id: request.envelope.approval_id,
          principal_id:
            request.envelope.actor_claim.principal_id,
          tool: request.envelope.tool,
          safety_class: request.envelope.safety_class,
          scopes: request.envelope.scopes,
          request_hash: requestHash,
        });
        approval = await this.#approvalRegistry.verify(binding);
        await this.#approvalRegistry.confirmUnchanged(approval);
      }
      const result = await this.#storage.deleteMemory({
        request,
        approval:
          approval === null
            ? null
            : {
                grant: approval.grant,
                registry_hash: approval.registry_hash,
                verified_at: this.#clock(),
              },
      });
      return GovernedResponseSchema.parse({
        status: "OK",
        receipt_id: result.receipt.receipt_id,
        data: result,
      });
    });
  }

  memoryEpisodeCommit(input: unknown): Promise<GovernedResponse> {
    return this.#execute(async () => {
      const request = MemoryEpisodeCommitInputSchema.parse(input);
      const unauthorized = this.#authorize(request.envelope);
      if (unauthorized !== null) {
        return unauthorized;
      }
      const allowedScopes = new Set(request.envelope.scopes.map(scopeKey));
      const allowedAuthorities = new Set(
        this.#policy.principal.allowed_authorities,
      );
      if (
        !allowedScopes.has(scopeKey(request.episode.scope)) ||
        request.evidence.some(
          (evidence) =>
            !allowedScopes.has(scopeKey(evidence.scope)) ||
            evidence.actor.principal_id !==
              this.#policy.principal.principal_id ||
            !allowedAuthorities.has(evidence.actor.authority) ||
            !allowedAuthorities.has(evidence.authority),
        )
      ) {
        return publicFailure(
          "PERMISSION_DENIED",
          "episode evidence is outside the configured principal",
        );
      }
      const receipt = await this.#storage.commitEpisode({
        idempotencyKey: request.envelope.idempotency_key,
        episode: request.episode,
        evidence: request.evidence,
        blobs: request.blobs.map((blob) => ({
          content_hash: blob.content_hash,
          media_type: blob.media_type,
          bytes: new Uint8Array(Buffer.from(blob.data_base64, "base64")),
        })),
      });
      await this.#storage.drainFtsOutbox();
      return GovernedResponseSchema.parse({
        status: "OK",
        receipt_id: receipt.receipt_id,
        data: { receipt },
      });
    });
  }

  async #evidenceRead(
    input: unknown,
    schema: typeof MemoryGetInputSchema | typeof MemoryExplainInputSchema,
    kind: "get" | "explain",
  ): Promise<GovernedResponse> {
    return this.#execute(async () => {
      const request = schema.parse(input);
      const unauthorized = this.#authorize(request.envelope);
      if (unauthorized !== null) {
        return unauthorized;
      }
      if (
        !request.envelope.scopes.some((scope) =>
          sameScope(scope, request.scope),
        )
      ) {
        return publicFailure(
          "PERMISSION_DENIED",
          "lookup scope is outside the request envelope",
        );
      }
      if ("memory_id" in request) {
        return this.#governedMemoryRead(request, kind);
      }
      const storedResult =
        kind === "get"
          ? await this.#storage.getEvidence({
              evidence_id: request.evidence_id,
              principal_id: this.#policy.principal.principal_id,
              scope: request.scope,
            })
          : await this.#storage.explainEvidence({
              evidence_id: request.evidence_id,
              principal_id: this.#policy.principal.principal_id,
              scope: request.scope,
            });
      const storedEvidence =
        storedResult !== null && "evidence" in storedResult
          ? storedResult.evidence
          : storedResult;
      const result =
        storedEvidence !== null &&
        !this.#evidenceIsAllowed(storedEvidence)
          ? null
          : storedResult;
      const evidence =
        result !== null && "evidence" in result ? result.evidence : result;
      const auditItems: RetrievalAuditItem[] =
        evidence === null
          ? []
          : [
              {
                evidence,
                decision: "included",
                reason_codes: ["EXACT_ID"],
                lane: "sqlite_authority",
                score: null,
              },
            ];
      const audit = await this.#recordAudit({
        envelope: request.envelope,
        query: `${kind}:${request.evidence_id}`,
        includeSensitive: true,
        items: auditItems,
        partial: false,
      });
      if (result === null) {
        return GovernedResponseSchema.parse({
          status: "NO_MATCH",
          receipt_id: audit.receipt.receipt_id,
          reason: "the requested evidence does not exist in the exact scope",
        });
      }
      return GovernedResponseSchema.parse({
        status: "OK",
        receipt_id: audit.receipt.receipt_id,
        data: { result, receipt: audit.receipt },
      });
    });
  }

  async #governedMemoryRead(
    request: Extract<
      z.output<typeof MemoryGetInputSchema>,
      { memory_id: unknown }
    >,
    kind: "get" | "explain",
  ): Promise<GovernedResponse> {
    const result = await this.#storage.getGovernedMemory({
      memory_id: request.memory_id,
      principal_id: this.#policy.principal.principal_id,
      scope: request.scope,
      as_of: request.envelope.requested_at,
      include_sensitive: request.include_sensitive,
      context_scope: request.scope,
    });
    const audit = await this.#recordAudit({
      envelope: request.envelope,
      query: `${kind}:${request.memory_id}`,
      includeSensitive: request.include_sensitive,
      items:
        result === null
          ? []
          : [
              {
                memory_identity: result.eligible
                  ? {
                      memory_id: result.item.memory_id,
                      revision_id: result.item.revision_id,
                    }
                  : {
                      memory_id: result.memory_id,
                      revision_id: result.revision_id,
                    },
                decision: result.eligible ? "included" : "excluded",
                reason_codes: result.eligible
                  ? result.item.reason_codes
                  : [result.reason_code],
                lane: "sqlite_canonical",
                score: null,
              },
            ],
      partial: false,
    });
    if (result === null) {
      return GovernedResponseSchema.parse({
        status: "NO_MATCH",
        receipt_id: audit.receipt.receipt_id,
        reason: "the requested governed memory does not exist",
      });
    }
    if (!result.eligible) {
      return GovernedResponseSchema.parse({
        status: "POLICY_EXCLUDED",
        receipt_id: audit.receipt.receipt_id,
        excluded_count: 1,
        reason_codes: [result.reason_code],
      });
    }
    return GovernedResponseSchema.parse({
      status: "OK",
      receipt_id: audit.receipt.receipt_id,
      data: {
        result:
          kind === "get"
            ? result.item
            : {
                memory: result.item,
                evidence_ids: result.item.evidence_ids,
                transform: result.item.transform,
                eligibility: result.item.reason_codes,
              },
        receipt: audit.receipt,
      },
    });
  }

  #authorize(envelope: RuntimeEnvelope): GovernedResponse | null {
    const decision = authorizeRequestClaims(
      this.#policy.principal,
      envelope,
    );
    return decision.authorized
      ? null
      : publicFailure("PERMISSION_DENIED", decision.reason);
  }

  async #memoryControl(
    request: MemoryControlRequest,
  ): Promise<GovernedResponse> {
    const unauthorized = this.#authorize(request.envelope);
    if (unauthorized !== null) {
      return unauthorized;
    }
    const requestHash = canonicalSha256(request);
    const replay = await this.#storage.memoryControlReplay({
      idempotency_key: request.envelope.idempotency_key,
      request_hash: requestHash,
    });
    if (replay !== null) {
      return GovernedResponseSchema.parse({
        status: "OK",
        receipt_id: replay.receipt.receipt_id,
        data: replay,
      });
    }

    let approval: VerifiedApproval | null = null;
    if (!request.envelope.dry_run) {
      if (request.envelope.approval_id === null) {
        throw new ApprovalError("APPROVAL_REQUIRED");
      }
      const binding = ApprovalBindingSchema.parse({
        approval_id: request.envelope.approval_id,
        principal_id: request.envelope.actor_claim.principal_id,
        tool: request.envelope.tool,
        safety_class: request.envelope.safety_class,
        scopes: request.envelope.scopes,
        request_hash: requestHash,
      });
      approval = await this.#approvalRegistry.verify(binding);
      await this.#approvalRegistry.confirmUnchanged(approval);
    }

    const result = await this.#storage.applyMemoryControl({
      request,
      approval:
        approval === null
          ? null
          : {
              grant: approval.grant,
              registry_hash: approval.registry_hash,
              verified_at: this.#clock(),
            },
    });
    return GovernedResponseSchema.parse({
      status: "OK",
      receipt_id: result.receipt.receipt_id,
      data: result,
    });
  }

  async #learningActionSnapshot() {
    const requiredScopes = [
      ...this.#policy.principal.allowed_scopes,
    ].sort((left, right) =>
      scopeKey(left).localeCompare(scopeKey(right))
    );
    const [health, ledger] = await Promise.all([
      this.#storage.health(),
      this.#storage.readLearningLedger({
        principal_id: this.#policy.principal.principal_id,
        scopes: requiredScopes,
      }),
    ]);
    const runtimeIdentityHash = canonicalSha256({
      node: process.versions.node,
      platform: process.platform,
      architecture: process.arch,
      storage_schema_version: health.schema_version,
      sqlite_version: health.sqlite_version,
      context_compiler_version: CONTEXT_COMPILER_VERSION,
      context_policy_version: CONTEXT_POLICY_VERSION,
      migrations: health.migrations.map((migration) => ({
        version: migration.version,
        hash: migration.hash,
      })),
    });
    const configurationHash = canonicalSha256({
      default_token_budget: this.#policy.default_token_budget,
      lane_policy: this.#policy.lane_policy,
      principal: {
        principal_id: this.#policy.principal.principal_id,
        allowed_scopes: requiredScopes,
        allowed_authorities: [
          ...this.#policy.principal.allowed_authorities,
        ].sort(),
        destructive_tools_enabled:
          this.#policy.principal.destructive_tools_enabled,
      },
    });
    const corpusHash = canonicalSha256({
      tombstone_epoch: health.tombstone_epoch,
      projection_frontier: health.projection_frontier,
      canonical_counts: {
        evidence_events: health.counts.evidence_events,
        episodes: health.counts.episodes,
        memory_candidates: health.counts.memory_candidates,
        memory_objects: health.counts.memory_objects,
        memory_revisions: health.counts.memory_revisions,
        admission_decisions: health.counts.admission_decisions,
        conflict_groups: health.counts.conflict_groups,
        status_events: health.counts.status_events,
        pin_events: health.counts.pin_events,
        usage_rules: health.counts.usage_rules,
        projection_objects: health.counts.projection_objects,
        projection_revisions: health.counts.projection_revisions,
        projection_sources: health.counts.projection_sources,
        relation_objects: health.counts.relation_objects,
        relation_revisions: health.counts.relation_revisions,
      },
    });
    return {
      health,
      ledger,
      requiredScopes,
      currentControl: ledger.controls.at(-1),
      runtimeIdentityHash,
      configurationHash,
      corpusHash,
      learningStateHash: learningStateHash(ledger),
    };
  }

  async #learningControl(
    request: LearningControlRequest,
    action: "pause" | "resume",
  ): Promise<GovernedResponse> {
    const unauthorized = this.#authorize(request.envelope);
    if (unauthorized !== null) {
      return unauthorized;
    }
    if (
      !sameScopeSet(
        request.envelope.scopes,
        this.#policy.principal.allowed_scopes,
      )
    ) {
      return publicFailure(
        "PERMISSION_DENIED",
        "learning controls require the complete configured scope set",
      );
    }
    const requestHash = canonicalSha256(request);
    const replay = await this.#storage.replayLearningLedger({
      idempotency_key: request.envelope.idempotency_key,
      idempotency_hash: requestHash,
    });
    if (replay !== null) {
      if (
        replay.kind !== "control" ||
        replay.receipt?.kind !== "learning_control"
      ) {
        throw new StorageError("CONFLICT");
      }
      const receipt = replay.receipt;
      const control = LearningControlSchema.parse({
        schema_version: receipt.schema_version,
        principal_id: receipt.principal_id,
        status: receipt.action === "pause" ? "paused" : "active",
        control_epoch: receipt.resulting_epoch,
        reason_code: receipt.reason_code,
        actor_id: request.envelope.actor_claim.principal_id,
        changed_at: receipt.created_at,
        frontier_hash: receipt.frontier_hash,
        runtime_identity_hash: receipt.runtime_identity_hash,
        configuration_hash: receipt.configuration_hash,
        corpus_hash: receipt.corpus_hash,
      });
      return GovernedResponseSchema.parse({
        status: "OK",
        receipt_id: receipt.receipt_id,
        data: { receipt, control, replayed: true },
      });
    }

    const abandonInFlight =
      "abandon_in_flight" in request &&
      request.abandon_in_flight;
    if (request.envelope.approval_id === null) {
      throw new ApprovalError("APPROVAL_REQUIRED");
    }
    const binding = ApprovalBindingSchema.parse({
      approval_id: request.envelope.approval_id,
      principal_id: request.envelope.actor_claim.principal_id,
      tool: request.envelope.tool,
      safety_class: request.envelope.safety_class,
      scopes: request.envelope.scopes,
      request_hash: requestHash,
    });
    const approval = await this.#approvalRegistry.verify(binding);
    await this.#approvalRegistry.confirmUnchanged(approval);

    let snapshot = await this.#learningActionSnapshot();
    const validateSnapshot = (
      currentSnapshot: typeof snapshot,
      permitReleaseFirst: boolean,
    ) => {
      const current = currentSnapshot.currentControl;
      const currentEpoch = current?.control_epoch ?? 0;
      const currentReleaseRevision =
        currentSnapshot.health.learning_frontier.release_revision;
      const expectedReleaseRevision =
        request.expected_release_revision ?? 0;
      const releaseFirst =
        action === "pause" &&
        permitReleaseFirst &&
        request.expected_frontier_hash !==
          currentSnapshot.health.learning_frontier.frontier_hash &&
        expectedReleaseRevision + 1 === currentReleaseRevision;
      if (
        request.expected_control_epoch !== currentEpoch ||
        (expectedReleaseRevision !== currentReleaseRevision &&
          !releaseFirst) ||
        (request.expected_frontier_hash !==
          currentSnapshot.health.learning_frontier.frontier_hash &&
          !releaseFirst) ||
        request.runtime_identity_hash !==
          currentSnapshot.runtimeIdentityHash ||
        request.configuration_hash !==
          currentSnapshot.configurationHash ||
        request.corpus_hash !== currentSnapshot.corpusHash
      ) {
        throw new StorageError("CONFLICT");
      }
      if (
        (action === "pause" && current?.status === "paused") ||
        (action === "resume" && current?.status !== "paused")
      ) {
        throw new StorageError("CONFLICT");
      }
      const identityDrift =
        current !== undefined &&
        (current.runtime_identity_hash !==
          currentSnapshot.runtimeIdentityHash ||
          current.configuration_hash !==
            currentSnapshot.configurationHash ||
          current.corpus_hash !== currentSnapshot.corpusHash);
      const learningStateDrift =
        current !== undefined &&
        current.frontier_hash !== currentSnapshot.learningStateHash;
      if (
        action === "resume" &&
        (identityDrift || learningStateDrift) &&
        !abandonInFlight
      ) {
        throw new StorageError("CONFLICT");
      }
      return {
        currentEpoch,
        drifted: identityDrift || learningStateDrift,
        releaseFirst,
      };
    };

    let validated = validateSnapshot(snapshot, true);
    const persist = async (
      currentSnapshot: typeof snapshot,
      currentValidation: typeof validated,
    ) => {
      const reasonCode =
        action === "pause"
          ? currentValidation.releaseFirst
            ? "RELEASE_COMPLETED_BEFORE_PAUSE"
            : "USER_REQUESTED"
          : currentValidation.drifted
            ? "IN_FLIGHT_ABANDONED_AFTER_DRIFT"
            : "EXACT_FRONTIER_RESUMED";
      const changedAt = this.#clock();
      const resultingEpoch = currentValidation.currentEpoch + 1;
      const control = LearningControlSchema.parse({
        schema_version: request.envelope.schema_version,
        principal_id: request.envelope.actor_claim.principal_id,
        status: action === "pause" ? "paused" : "active",
        control_epoch: resultingEpoch,
        reason_code: reasonCode,
        actor_id: request.envelope.actor_claim.principal_id,
        changed_at: changedAt,
        frontier_hash: currentSnapshot.learningStateHash,
        runtime_identity_hash: currentSnapshot.runtimeIdentityHash,
        configuration_hash: currentSnapshot.configurationHash,
        corpus_hash: currentSnapshot.corpusHash,
      });
      const receipt = LearningControlReceiptSchema.parse(
        sealReceipt({
          schema_version: request.envelope.schema_version,
          receipt_id: stableIdentifier("learning-control-receipt", {
            idempotency_key: request.envelope.idempotency_key,
            request_hash: requestHash,
          }),
          created_at: changedAt,
          state: "durable",
          request_hash: requestHash,
          kind: "learning_control",
          principal_id: request.envelope.actor_claim.principal_id,
          action,
          previous_epoch: currentValidation.currentEpoch,
          resulting_epoch: resultingEpoch,
          previous_frontier_hash:
            currentSnapshot.health.learning_frontier.frontier_hash,
          frontier_hash: currentSnapshot.learningStateHash,
          runtime_identity_hash: currentSnapshot.runtimeIdentityHash,
          configuration_hash: currentSnapshot.configurationHash,
          corpus_hash: currentSnapshot.corpusHash,
          reason_code: reasonCode,
        }),
      );
      await this.#approvalRegistry.confirmUnchanged(approval);
      const stored = await this.#storage.writeLearningLedger({
        kind: "control",
        idempotency_key: request.envelope.idempotency_key,
        idempotency_hash: requestHash,
        request_hash: requestHash,
        expected_control_epoch: currentValidation.currentEpoch,
        expected_frontier_hash:
          currentSnapshot.health.learning_frontier.frontier_hash,
        control,
        receipt,
        approval_binding: binding,
        approval: {
          grant: approval.grant,
          registry_hash: approval.registry_hash,
          verified_at: this.#clock(),
        },
      });
      return GovernedResponseSchema.parse({
        status: "OK",
        receipt_id: receipt.receipt_id,
        data: {
          receipt,
          control,
          replayed: stored.replayed,
        },
      });
    };

    try {
      return await persist(snapshot, validated);
    } catch (error) {
      if (
        !(error instanceof StorageError) ||
        error.code !== "CONFLICT" ||
        action !== "pause"
      ) {
        throw error;
      }
      const previousReleaseRevision =
        snapshot.health.learning_frontier.release_revision;
      snapshot = await this.#learningActionSnapshot();
      if (
        snapshot.health.learning_frontier.release_revision <=
        previousReleaseRevision
      ) {
        throw error;
      }
      validated = validateSnapshot(snapshot, true);
      return persist(snapshot, {
        ...validated,
        releaseFirst: true,
      });
    }
  }

  async #searchScopes(
    query: string,
    scopes: ReadEnvelope["scopes"],
    limit: number,
  ): Promise<{ candidates: L0ContextCandidate[]; degraded: string[] }> {
    const candidates: L0ContextCandidate[] = [];
    const degraded: string[] = [];
    for (const scope of scopes) {
      const result = await this.#storage.searchEvidence({
        query,
        principal_id: this.#policy.principal.principal_id,
        scope,
        limit,
      });
      if (result.status === "DEGRADED") {
        degraded.push(`${scopeKey(scope)}:${result.reason_code}`);
        continue;
      }
      for (const item of result.items) {
        const evidence = await this.#storage.getEvidence({
          evidence_id: item.evidence_id,
          principal_id: this.#policy.principal.principal_id,
          scope,
        });
        if (evidence === null) {
          throw new StorageError("CORRUPTION");
        }
        if (!this.#evidenceIsAllowed(evidence)) {
          continue;
        }
        candidates.push({
          abstraction: "l0_evidence",
          evidence,
          rank: item.rank,
          lane: "sqlite_fts",
        });
      }
    }
    candidates.sort(
      (left, right) =>
        left.rank - right.rank ||
        right.evidence.occurred_at.localeCompare(
          left.evidence.occurred_at,
        ) ||
        left.evidence.evidence_id.localeCompare(
          right.evidence.evidence_id,
        ),
    );
    return {
      candidates: candidates.slice(0, limit),
      degraded: [...new Set(degraded)].sort(),
    };
  }

  async #searchContextScopes(
    query: string,
    scopes: ReadEnvelope["scopes"],
    limit: number,
    asOf: string,
    includeSensitive: boolean,
  ): Promise<{
    candidates: ContextCandidate[];
    exclusions: ContextExclusion[];
    degraded: string[];
  }> {
    const evidence = await this.#searchScopes(query, scopes, limit);
    const candidates: ContextCandidate[] = [...evidence.candidates];
    const exclusions: ContextExclusion[] = [];
    const degraded = [...evidence.degraded];
    for (const scope of scopes) {
      const result = await this.#storage.searchGovernedMemory({
        query,
        principal_id: this.#policy.principal.principal_id,
        scope,
        as_of: asOf,
        include_sensitive: includeSensitive,
        context_scope: scope,
        limit,
      });
      degraded.push(...result.degraded_lanes.map(
        (lane) => `${scopeKey(scope)}:${lane}`,
      ));
      for (const item of result.items) {
        candidates.push({
          abstraction: "l1_memory",
          memory: item.item,
          rank: item.rank - 1_000,
          lane: item.lane,
        });
      }
      exclusions.push(...result.exclusions);
    }
    const governedEvidenceIds = new Set(
      candidates.flatMap((candidate) =>
        candidate.abstraction === "l1_memory"
          ? candidate.memory.evidence_ids
          : [],
      ),
    );
    const deduplicated = candidates.filter(
      (candidate) =>
        candidate.abstraction === "l1_memory" ||
        !governedEvidenceIds.has(candidate.evidence.evidence_id),
    );
    return {
      candidates: deduplicated
        .sort((left, right) => left.rank - right.rank)
        .slice(0, limit),
      exclusions,
      degraded: [...new Set(degraded)].sort(),
    };
  }

  async #recordAudit(options: {
    envelope: ReadEnvelope;
    query: string;
    includeSensitive: boolean;
    items: RetrievalAuditItem[];
    partial: boolean;
  }) {
    const recall = RecallRequestSchema.parse({
      schema_version: "1.0.0",
      request_id: options.envelope.request_id,
      goal: options.envelope.purpose,
      query: options.query,
      scopes: options.envelope.scopes,
      as_of: options.envelope.requested_at,
      token_budget: this.#policy.default_token_budget,
      include_sensitive: options.includeSensitive,
    });
    const receiptItems = options.items.map((item) => {
      const identity =
        item.memory_identity ??
        (item.evidence === undefined
          ? null
          : l0MemoryIdentity(item.evidence));
      if (identity === null) {
        throw new StorageError("CORRUPTION");
      }
      return {
        memory_id: identity.memory_id,
        revision_id: identity.revision_id,
        decision: item.decision,
        reason_codes: item.reason_codes,
        lane: item.lane,
        score: item.score,
      };
    });
    const receipt = RetrievalReceiptSchema.parse(
      sealReceipt({
        schema_version: "1.0.0",
        receipt_id: stableIdentifier("retrieval", {
          request_id: recall.request_id,
          items: receiptItems,
          partial: options.partial,
        }),
        created_at: options.envelope.requested_at,
        state: options.partial ? "partial" : "durable",
        request_hash: canonicalSha256(recall),
        receipt_hash: `sha256:${"0".repeat(64)}`,
        kind: "retrieval",
        context_slice_id: null,
        compiler_version: CONTEXT_COMPILER_VERSION,
        policy_version: CONTEXT_POLICY_VERSION,
        items: receiptItems,
      }),
    );
    return this.#storage.recordRecall({
      principal_id: options.envelope.actor_claim.principal_id,
      request: recall,
      receipt,
    });
  }

  #evidenceIsAllowed(
    evidence: z.output<typeof EvidenceRecordSchema>,
  ): boolean {
    return (
      evidence.actor.principal_id === this.#policy.principal.principal_id &&
      this.#policy.principal.allowed_authorities.includes(
        evidence.actor.authority,
      ) &&
      this.#policy.principal.allowed_authorities.includes(
        evidence.authority,
      )
    );
  }

  async #execute(
    operation: () => Promise<GovernedResponse>,
  ): Promise<GovernedResponse> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof z.ZodError) {
        return publicFailure(
          "INVALID_INPUT",
          "the tool request does not satisfy its runtime contract",
        );
      }
      if (error instanceof StorageError) {
        return storageFailure(error);
      }
      if (error instanceof LearningReleaseError) {
        if (error.code === "APPROVAL_INVALID") {
          return publicFailure(
            "APPROVAL_INVALID",
            "the trusted learning approval is invalid",
          );
        }
        if (
          error.code === "CANDIDATE_INACCESSIBLE" ||
          error.code === "RELEASE_INELIGIBLE" ||
          error.code === "ROLLBACK_TARGET_INVALID" ||
          error.code === "MONITOR_INACCESSIBLE"
        ) {
          return publicFailure(
            "INVALID_INPUT",
            "the requested learning release artifact is inaccessible or ineligible",
          );
        }
        return publicFailure(
          "CONFLICT",
          "the learning release frontier changed or is not eligible for this transition",
        );
      }
      const approvalCode = approvalFailureCode(error);
      if (approvalCode !== null) {
        return publicFailure(
          approvalCode,
          approvalCode === "APPROVAL_REQUIRED"
            ? "a trusted approval was not found"
            : "the trusted approval does not authorize this request",
        );
      }
      return publicFailure(
        "INTERNAL_FAILURE",
        "the memory runtime could not complete the request",
      );
    }
  }
}
