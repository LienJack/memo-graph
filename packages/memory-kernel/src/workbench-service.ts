import {
  CanonicalHashSchema,
  WorkbenchMemoryDetailRequestSchema,
  WorkbenchMemoryDetailResultSchema,
  WorkbenchMemoryListRequestSchema,
  WorkbenchMemoryListResultSchema,
  canonicalSha256,
  type CanonicalHash,
  type LocalPrincipal,
  type ParsedWorkbenchMemoryListRequest,
  type WorkbenchMemoryDetailResult,
  type WorkbenchMemoryListResult,
  type WorkbenchMemoryMember,
  type WorkbenchOpaqueCursor,
} from "@memo-graph/contracts";
import {
  StorageError,
  type SqliteStorageClient,
} from "@memo-graph/storage-sqlite";

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

  constructor(options: {
    storage: WorkbenchStoragePort;
    authority: LocalPrincipal;
    snapshots: WorkbenchSnapshotRegistry;
    clock?: () => string;
    includeSensitive?: boolean;
    maxSnapshotMembers?: number;
    maxHistory?: number;
    maxProvenanceNodes?: number;
  }) {
    this.#storage = options.storage;
    this.#authority = options.authority;
    this.#snapshots = options.snapshots;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#includeSensitive = options.includeSensitive ?? false;
    this.#maxSnapshotMembers = options.maxSnapshotMembers ?? 2_000;
    this.#maxHistory = options.maxHistory ?? 200;
    this.#maxProvenanceNodes = options.maxProvenanceNodes ?? 300;
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
