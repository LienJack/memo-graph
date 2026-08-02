import { randomUUID } from "node:crypto";

import {
  CanonicalHashSchema,
  EvidenceRecordSchema,
  MemoryCandidateSchema,
  MemoryCorrectInputSchema,
  WorkbenchCorrectionConfirmRequestSchema,
  WorkbenchCorrectionConfirmResultSchema,
  WorkbenchCorrectionDraftSchema,
  WorkbenchCorrectionPreviewResultSchema,
  WorkbenchMemoryDetailRequestSchema,
  WorkbenchMemoryDetailResultSchema,
  WorkbenchGraphRequestSchema,
  WorkbenchGraphResultSchema,
  WorkbenchMemoryListRequestSchema,
  WorkbenchMemoryListResultSchema,
  canonicalSha256,
  type CanonicalHash,
  type LocalPrincipal,
  type ParsedWorkbenchMemoryListRequest,
  type WorkbenchMemoryDetailResult,
  type WorkbenchGraphResult,
  type WorkbenchMemoryListResult,
  type WorkbenchMemoryMember,
  type WorkbenchOpaqueCursor,
  type WorkbenchCorrectionConfirmResult,
  type WorkbenchCorrectionPreviewResult,
} from "@memo-graph/contracts";
import {
  StorageError,
  type SqliteStorageClient,
} from "@memo-graph/storage-sqlite";

import { evaluateAdmission } from "./governance.js";
import {
  WorkbenchApprovalRegistry,
  WorkbenchPreviewError,
} from "./workbench-approval.js";

export type WorkbenchSnapshotStaleReason =
  | "SNAPSHOT_EXPIRED"
  | "SNAPSHOT_EVICTED"
  | "SNAPSHOT_RESTARTED"
  | "CURSOR_INVALID";

export type WorkbenchSnapshotPage = {
  members: WorkbenchMemoryMember[];
  next_cursor: WorkbenchOpaqueCursor | null;
  retained_count: number;
  omitted_count: number;
  snapshot_expires_at: string;
};

export type WorkbenchSnapshotCreateInput = {
  query_hash: CanonicalHash;
  frontier_hash: CanonicalHash;
  members: WorkbenchMemoryMember[];
  page_size: number;
  omitted_count: number;
  created_at: string;
};

export interface WorkbenchSnapshotRegistry {
  create(input: WorkbenchSnapshotCreateInput): WorkbenchSnapshotPage;
  read(
    cursor: WorkbenchOpaqueCursor,
    queryHash: CanonicalHash,
  ):
    | { status: "ready"; page: WorkbenchSnapshotPage }
    | { status: "stale"; reason_code: WorkbenchSnapshotStaleReason };
}

type WorkbenchStoragePort = Pick<
  SqliteStorageClient,
  | "listWorkbenchMemories"
  | "getWorkbenchMemorySummaries"
  | "getWorkbenchMemoryDetail"
  | "getWorkbenchGraph"
  | "previewWorkbenchCorrection"
  | "applyMemoryRevision"
>;

function hasActiveFilter(request: ParsedWorkbenchMemoryListRequest): boolean {
  return (
    request.query !== null ||
    request.scope !== null ||
    request.kinds.length > 0 ||
    request.lifecycles.length > 0 ||
    request.authorities.length > 0 ||
    request.sources.length > 0 ||
    request.recorded_after !== null ||
    request.recorded_before !== null ||
    request.include_non_current
  );
}

function failure(error: unknown): WorkbenchMemoryListResult {
  return WorkbenchMemoryListResultSchema.parse({
    status: "failed",
    reason_code:
      error instanceof StorageError ? error.code : "WORKBENCH_READ_FAILED",
    retryable: error instanceof StorageError ? error.retryable : false,
    warnings: [],
  });
}

function detailFailure(error: unknown): WorkbenchMemoryDetailResult {
  return WorkbenchMemoryDetailResultSchema.parse({
    status: "failed",
    reason_code:
      error instanceof StorageError ? error.code : "WORKBENCH_READ_FAILED",
    retryable: error instanceof StorageError ? error.retryable : false,
    warnings: [],
  });
}

export class WorkbenchService {
  readonly #storage: WorkbenchStoragePort;
  readonly #authority: LocalPrincipal;
  readonly #snapshots: WorkbenchSnapshotRegistry;
  readonly #clock: () => string;
  readonly #includeSensitive: boolean;
  readonly #maxSnapshotMembers: number;
  readonly #maxHistory: number;
  readonly #maxProvenanceNodes: number;
  readonly #approvals: WorkbenchApprovalRegistry;
  readonly #sessionId: string;
  readonly #idFactory: (prefix: string) => string;
  readonly #previewTtlMs: number;
  readonly #impactLimit: number;
  readonly #impactSampleLimit: number;

  constructor(options: {
    storage: WorkbenchStoragePort;
    authority: LocalPrincipal;
    snapshots: WorkbenchSnapshotRegistry;
    clock?: () => string;
    includeSensitive?: boolean;
    maxSnapshotMembers?: number;
    maxHistory?: number;
    maxProvenanceNodes?: number;
    approvals?: WorkbenchApprovalRegistry;
    sessionId?: string;
    idFactory?: (prefix: string) => string;
    previewTtlMs?: number;
    impactLimit?: number;
    impactSampleLimit?: number;
  }) {
    this.#storage = options.storage;
    this.#authority = options.authority;
    this.#snapshots = options.snapshots;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#includeSensitive = options.includeSensitive ?? false;
    this.#maxSnapshotMembers = options.maxSnapshotMembers ?? 2_000;
    this.#maxHistory = options.maxHistory ?? 200;
    this.#maxProvenanceNodes = options.maxProvenanceNodes ?? 300;
    this.#approvals =
      options.approvals ?? new WorkbenchApprovalRegistry({ clock: this.#clock });
    this.#sessionId = options.sessionId ?? "workbench_session_local";
    this.#idFactory =
      options.idFactory ?? ((prefix) => `${prefix}:${randomUUID()}`);
    this.#previewTtlMs = options.previewTtlMs ?? 5 * 60 * 1_000;
    this.#impactLimit = options.impactLimit ?? 1_000;
    this.#impactSampleLimit = options.impactSampleLimit ?? 100;
  }

  async list(input: unknown): Promise<WorkbenchMemoryListResult> {
    const parsed = WorkbenchMemoryListRequestSchema.safeParse(input);
    if (!parsed.success) {
      return WorkbenchMemoryListResultSchema.parse({
        status: "failed",
        reason_code: "INVALID_REQUEST",
        retryable: false,
        warnings: [],
      });
    }
    const request = parsed.data;
    const asOf = this.#clock();
    const queryHash = CanonicalHashSchema.parse(
      canonicalSha256({
        principal_id: this.#authority.principal_id,
        allowed_scopes: this.#authority.allowed_scopes,
        include_sensitive: this.#includeSensitive,
        request: { ...request, cursor: null },
      }),
    );
    try {
      if (request.cursor !== null) {
        return await this.#readSnapshotPage(request.cursor, queryHash, asOf);
      }
      const candidateSet = await this.#storage.listWorkbenchMemories({
        principal_id: this.#authority.principal_id,
        allowed_scopes: this.#authority.allowed_scopes,
        as_of: asOf,
        include_sensitive: this.#includeSensitive,
        context_scope: null,
        max_snapshot_members: this.#maxSnapshotMembers,
        request,
      });
      if (candidateSet.items.length === 0) {
        if (candidateSet.candidate_space_truncated) {
          return WorkbenchMemoryListResultSchema.parse({
            status: "failed",
            reason_code: "CANDIDATE_SPACE_TRUNCATED",
            retryable: false,
            warnings: candidateSet.warnings,
          });
        }
        if (candidateSet.excluded_count > 0) {
          return WorkbenchMemoryListResultSchema.parse({
            status: "governance_excluded",
            items: [],
            excluded_count: candidateSet.excluded_count,
            reason_codes: candidateSet.exclusion_reason_codes,
            warnings: candidateSet.warnings,
          });
        }
        return WorkbenchMemoryListResultSchema.parse({
          status: hasActiveFilter(request) ? "filtered_empty" : "ready_empty",
          items: [],
          page: null,
          excluded_count: 0,
          reason_codes: [],
          warnings: candidateSet.warnings,
        });
      }
      const page = this.#snapshots.create({
        query_hash: queryHash,
        frontier_hash: candidateSet.frontier_hash,
        members: candidateSet.items.map((item) => ({
          memory_id: item.memory_id,
          revision_id: item.revision_id,
        })),
        page_size: request.limit,
        omitted_count: candidateSet.omitted_count,
        created_at: asOf,
      });
      const byRevision = new Map(
        candidateSet.items.map((item) => [item.revision_id, item]),
      );
      const items = page.members.flatMap((member) => {
        const item = byRevision.get(member.revision_id);
        return item === undefined ? [] : [item];
      });
      if (items.length === 0) {
        return WorkbenchMemoryListResultSchema.parse({
          status: "failed",
          reason_code: "SNAPSHOT_MEMBERS_MISSING",
          retryable: true,
          warnings: [],
        });
      }
      return WorkbenchMemoryListResultSchema.parse({
        status: candidateSet.candidate_space_truncated ? "degraded" : "ready",
        items,
        page: {
          next_cursor: page.next_cursor,
          retained_count: page.retained_count,
          omitted_count: page.omitted_count,
          snapshot_expires_at: page.snapshot_expires_at,
        },
        excluded_count: candidateSet.excluded_count,
        reason_codes: candidateSet.exclusion_reason_codes,
        warnings: candidateSet.warnings,
      });
    } catch (error) {
      return failure(error);
    }
  }

  async detail(input: unknown): Promise<WorkbenchMemoryDetailResult> {
    const request = WorkbenchMemoryDetailRequestSchema.safeParse(input);
    if (!request.success) {
      return WorkbenchMemoryDetailResultSchema.parse({
        status: "failed",
        reason_code: "INVALID_REQUEST",
        retryable: false,
        warnings: [],
      });
    }
    try {
      return await this.#storage.getWorkbenchMemoryDetail({
        principal_id: this.#authority.principal_id,
        allowed_scopes: this.#authority.allowed_scopes,
        as_of: this.#clock(),
        include_sensitive: this.#includeSensitive,
        context_scope: null,
        max_history: this.#maxHistory,
        max_provenance_nodes: this.#maxProvenanceNodes,
        request: request.data,
      });
    } catch (error) {
      return detailFailure(error);
    }
  }

  async graph(input: unknown): Promise<WorkbenchGraphResult> {
    const request = WorkbenchGraphRequestSchema.safeParse(input);
    if (!request.success) {
      return WorkbenchGraphResultSchema.parse({
        status: "failed",
        reason_code: "INVALID_REQUEST",
        retryable: false,
        warnings: [],
      });
    }
    const allowed = this.#authority.allowed_scopes.some(
      (scope) =>
        scope.kind === request.data.scope.kind &&
        scope.id === request.data.scope.id,
    );
    if (!allowed) {
      return WorkbenchGraphResultSchema.parse({
        status: "governance_excluded",
        reason_code: "SCOPE_NOT_ALLOWED",
        retryable: false,
        warnings: [],
      });
    }
    try {
      return await this.#storage.getWorkbenchGraph({
        principal_id: this.#authority.principal_id,
        allowed_scopes: this.#authority.allowed_scopes,
        as_of: this.#clock(),
        include_sensitive: this.#includeSensitive,
        context_scope: null,
        request: request.data,
      });
    } catch (error) {
      return WorkbenchGraphResultSchema.parse({
        status: "failed",
        reason_code:
          error instanceof StorageError ? error.code : "WORKBENCH_GRAPH_FAILED",
        retryable: error instanceof StorageError ? error.retryable : false,
        warnings: [],
      });
    }
  }

  async previewCorrection(
    input: unknown,
  ): Promise<WorkbenchCorrectionPreviewResult> {
    const draft = WorkbenchCorrectionDraftSchema.safeParse(input);
    if (!draft.success) {
      return WorkbenchCorrectionPreviewResultSchema.parse({
        status: "failed",
        reason_code: "INVALID_REQUEST",
        retryable: false,
        warnings: [],
      });
    }
    const now = this.#clock();
    try {
      const detail = await this.detail({
        memory_id: draft.data.memory_id,
        revision_id: null,
      });
      if (detail.status !== "ready") {
        return WorkbenchCorrectionPreviewResultSchema.parse({
          status:
            detail.status === "not_found"
              ? "not_found"
              : detail.status === "governance_excluded"
                ? "governance_excluded"
                : detail.status === "blocked"
                  ? "blocked"
                  : "failed",
          reason_code: detail.reason_code,
          retryable:
            detail.status === "not_found" ||
            detail.status === "governance_excluded"
              ? false
              : detail.retryable,
          warnings: detail.warnings,
        });
      }
      if (
        detail.memory.revision_id !== draft.data.expected_revision_id ||
        !detail.memory.writable
      ) {
        return WorkbenchCorrectionPreviewResultSchema.parse({
          status: "stale",
          reason_code: "STALE_REVISION",
          retryable: false,
          warnings: [],
        });
      }
      const storagePreview = await this.#storage.previewWorkbenchCorrection({
        memory_id: draft.data.memory_id,
        principal_id: this.#authority.principal_id,
        scope: detail.memory.scope,
        expected_revision_id: draft.data.expected_revision_id,
        impact_limit: this.#impactLimit,
        sample_limit: this.#impactSampleLimit,
      });
      if (storagePreview === null) {
        return WorkbenchCorrectionPreviewResultSchema.parse({
          status: "stale",
          reason_code: "STALE_REVISION",
          retryable: false,
          warnings: [],
        });
      }
      const content = {
        storage: "inline",
        text: draft.data.replacement.text,
        media_type: draft.data.replacement.media_type,
      } as const;
      const contentHash = CanonicalHashSchema.parse(canonicalSha256(content));
      const previewId = this.#idFactory("workbench-preview");
      const operationId = this.#idFactory("workbench-correction");
      const approvalId = this.#idFactory("workbench-approval");
      const evidenceId = this.#idFactory("workbench-feedback");
      const requestId = this.#idFactory("workbench-request");
      const expiresAt = new Date(
        Date.parse(now) + this.#previewTtlMs,
      ).toISOString();
      const payload = {
        storage: "inline",
        text: draft.data.reason,
        media_type: "text/plain",
      } as const;
      const evidence = EvidenceRecordSchema.parse({
        schema_version: "1.0.0",
        evidence_id: evidenceId,
        sequence: 0,
        occurred_at: now,
        recorded_at: now,
        scope: storagePreview.basis.scope,
        actor: {
          principal_id: this.#authority.principal_id,
          authority: "user_stated",
        },
        source: "user_feedback",
        authority: "user_stated",
        sensitivity: storagePreview.basis.sensitivity,
        payload,
        content_hash: canonicalSha256(payload),
      });
      const correctionRequest = MemoryCorrectInputSchema.parse({
        envelope: {
          schema_version: "1.0.0",
          request_id: requestId,
          tool: "memory_correct",
          safety_class: "important_mutation",
          actor_claim: {
            principal_id: this.#authority.principal_id,
            authority: "user_stated",
          },
          scopes: [storagePreview.basis.scope],
          purpose: "Apply a confirmed Memory Workbench correction",
          reason: draft.data.reason,
          requested_at: now,
          idempotency_key: operationId,
          expected_revision_id: draft.data.expected_revision_id,
          approval_id: approvalId,
          dry_run: false,
        },
        memory_id: draft.data.memory_id,
        replacement: {
          content,
          content_hash: contentHash,
          evidence_ids: [evidence.evidence_id],
          validity: {
            valid_from: now,
            valid_to: null,
            recorded_at: now,
          },
          reason: draft.data.reason,
        },
      });
      const requestHash = CanonicalHashSchema.parse(
        canonicalSha256(correctionRequest),
      );
      const candidate = MemoryCandidateSchema.parse({
        schema_version: "1.0.0",
        candidate_id: this.#idFactory("workbench-candidate"),
        logical_key: storagePreview.basis.logical_key,
        kind: storagePreview.basis.kind,
        scope: storagePreview.basis.scope,
        sensitivity: storagePreview.basis.sensitivity,
        inferred: storagePreview.basis.inferred,
        content,
        content_hash: contentHash,
        evidence_ids: [evidence.evidence_id],
        validity: correctionRequest.replacement.validity,
        injection_risk: "none",
        requires_user_confirmation: false,
        transform: { name: "memory-correction", version: "1.0.0" },
      });
      const evaluation = evaluateAdmission(candidate, [evidence]);
      if (evaluation.decision === "reject") {
        return WorkbenchCorrectionPreviewResultSchema.parse({
          status: "governance_excluded",
          reason_code: "CORRECTION_REJECTED",
          retryable: false,
          warnings: [],
        });
      }
      const previewDraft = {
        status: "ready",
        preview_id: previewId,
        operation_id: operationId,
        memory_id: draft.data.memory_id,
        expected_revision_id: draft.data.expected_revision_id,
        replacement: {
          text: content.text,
          media_type: content.media_type,
          content_hash: contentHash,
        },
        reason: draft.data.reason,
        impact: storagePreview.impact,
        seal_hash: `sha256:${"0".repeat(64)}`,
        expires_at: expiresAt,
        warnings: storagePreview.impact.sample_truncated
          ? ["impact_sample_truncated"]
          : [],
      } as const;
      const sealHash = CanonicalHashSchema.parse(
        canonicalSha256({
          session_id: this.#sessionId,
          preview_id: previewDraft.preview_id,
          operation_id: previewDraft.operation_id,
          memory_id: previewDraft.memory_id,
          expected_revision_id: previewDraft.expected_revision_id,
          replacement: previewDraft.replacement,
          reason: previewDraft.reason,
          impact: previewDraft.impact,
          expires_at: previewDraft.expires_at,
        }),
      );
      const preview = WorkbenchCorrectionPreviewResultSchema.parse({
        ...previewDraft,
        seal_hash: sealHash,
      });
      if (preview.status !== "ready") {
        throw new Error("ready correction preview failed validation");
      }
      this.#approvals.prepare({
        session_id: this.#sessionId,
        preview,
        request_hash: requestHash,
        approval_id: approvalId,
        command: {
          idempotency_key: operationId,
          principal_id: this.#authority.principal_id,
          actor_authority: "user_stated",
          scope: storagePreview.basis.scope,
          requested_at: now,
          memory_id: draft.data.memory_id,
          expected_revision_id: draft.data.expected_revision_id,
          candidate,
          evaluation,
          dry_run: false,
          request_hash: requestHash,
          correction_evidence: evidence,
          expected_projection_impact: {
            source_revision_id: storagePreview.impact.source_revision_id,
            descendant_count: storagePreview.impact.descendant_count,
            closure_hash: storagePreview.impact.closure_hash,
            supported_limit: storagePreview.impact.supported_limit,
          },
        },
      });
      return preview;
    } catch (error) {
      return WorkbenchCorrectionPreviewResultSchema.parse({
        status:
          error instanceof StorageError
            ? error.code === "STALE_REVISION"
              ? "stale"
              : error.code === "CORRECTION_IMPACT_LIMIT_EXCEEDED"
                ? "blocked"
                : "failed"
            : "failed",
        reason_code:
          error instanceof StorageError
            ? error.code
            : "CORRECTION_PREVIEW_FAILED",
        retryable: error instanceof StorageError ? error.retryable : false,
        warnings: [],
      });
    }
  }

  async confirmCorrection(
    input: unknown,
  ): Promise<WorkbenchCorrectionConfirmResult> {
    const confirmation = WorkbenchCorrectionConfirmRequestSchema.safeParse(input);
    if (!confirmation.success) {
      return WorkbenchCorrectionConfirmResultSchema.parse({
        status: "failed",
        reason_code: "INVALID_REQUEST",
        retryable: false,
        warnings: [],
      });
    }
    try {
      const prepared = this.#approvals.confirmPreview(
        confirmation.data.preview_id,
        this.#sessionId,
      );
      const approval = await this.#approvals.verify(prepared.binding);
      await this.#approvals.confirmUnchanged(approval);
      const result = await this.#storage.applyMemoryRevision({
        ...prepared.command,
        approval_binding: prepared.binding,
        approval: {
          grant: approval.grant,
          registry_hash: approval.registry_hash,
          verified_at: prepared.confirmed_at,
        },
      });
      return WorkbenchCorrectionConfirmResultSchema.parse({
        status: "ready",
        replayed: result.replayed,
        memory_id: result.memory_id,
        previous_revision_id: prepared.preview.expected_revision_id,
        current_revision_id: result.current_revision_id,
        receipt: result.receipt,
        warnings: result.receipt.warnings,
      });
    } catch (error) {
      if (error instanceof WorkbenchPreviewError) {
        return WorkbenchCorrectionConfirmResultSchema.parse({
          status: "stale_preview",
          reason_code: error.code,
          retryable: false,
          warnings: [],
        });
      }
      if (
        error instanceof StorageError &&
        (error.code === "STALE_REVISION" ||
          error.code === "STALE_PROJECTION_FRONTIER")
      ) {
        return WorkbenchCorrectionConfirmResultSchema.parse({
          status: "stale_preview",
          reason_code: error.code,
          retryable: false,
          warnings: [],
        });
      }
      return WorkbenchCorrectionConfirmResultSchema.parse({
        status:
          error instanceof StorageError && error.code === "APPROVAL_INVALID"
            ? "approval_consumed"
            : "failed",
        reason_code:
          error instanceof StorageError
            ? error.code
            : "CORRECTION_COMMIT_FAILED",
        retryable: error instanceof StorageError ? error.retryable : false,
        warnings: [],
      });
    }
  }

  async #readSnapshotPage(
    cursor: WorkbenchOpaqueCursor,
    queryHash: CanonicalHash,
    asOf: string,
  ): Promise<WorkbenchMemoryListResult> {
    const snapshot = this.#snapshots.read(cursor, queryHash);
    if (snapshot.status === "stale") {
      return WorkbenchMemoryListResultSchema.parse({
        status: "stale_cursor",
        reason_code: snapshot.reason_code,
        retryable: true,
        warnings: [],
      });
    }
    if (snapshot.page.members.length === 0) {
      return WorkbenchMemoryListResultSchema.parse({
        status: "stale_cursor",
        reason_code: "CURSOR_INVALID",
        retryable: true,
        warnings: [],
      });
    }
    const batch = await this.#storage.getWorkbenchMemorySummaries({
      principal_id: this.#authority.principal_id,
      allowed_scopes: this.#authority.allowed_scopes,
      as_of: asOf,
      include_sensitive: this.#includeSensitive,
      context_scope: null,
      members: snapshot.page.members,
    });
    if (batch.items.length === 0) {
      return WorkbenchMemoryListResultSchema.parse({
        status: "failed",
        reason_code: "SNAPSHOT_MEMBERS_UNAVAILABLE",
        retryable: true,
        warnings: ["snapshot_members_unavailable"],
      });
    }
    return WorkbenchMemoryListResultSchema.parse({
      status: batch.missing_count > 0 ? "degraded" : "ready",
      items: batch.items,
      page: {
        next_cursor: snapshot.page.next_cursor,
        retained_count: snapshot.page.retained_count,
        omitted_count: snapshot.page.omitted_count + batch.missing_count,
        snapshot_expires_at: snapshot.page.snapshot_expires_at,
      },
      excluded_count: batch.missing_count,
      reason_codes: batch.reason_codes,
      warnings:
        batch.missing_count > 0 ? ["snapshot_members_unavailable"] : [],
    });
  }
}
