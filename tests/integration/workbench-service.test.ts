import { describe, expect, it, vi } from "vitest";

import {
  LocalPrincipalSchema,
  WorkbenchMemoryCandidateSetSchema,
  WorkbenchMemoryDetailResultSchema,
  WorkbenchGraphResultSchema,
  WorkbenchMemorySummaryBatchResultSchema,
  WorkbenchMemorySummarySchema,
  WorkbenchOpaqueCursorSchema,
  canonicalSha256,
  type CanonicalHash,
  type WorkbenchOpaqueCursor,
} from "../../packages/contracts/src/index.js";
import {
  WorkbenchService,
  type WorkbenchSnapshotCreateInput,
  type WorkbenchSnapshotPage,
  type WorkbenchSnapshotRegistry,
} from "../../packages/memory-kernel/src/index.js";
import type {
  WorkbenchMemoryDetailQuery,
  WorkbenchMemoryListQuery,
  WorkbenchMemorySummaryBatchQuery,
} from "@memo-graph/storage-sqlite";

const NOW = "2026-08-02T06:00:00.000Z";
const EXPIRES = "2026-08-02T06:05:00.000Z";
const CURSOR = WorkbenchOpaqueCursorSchema.parse(
  `wbcur1_${"a".repeat(48)}`,
);
const scope = { kind: "workspace", id: "workspace_local" } as const;
const authority = LocalPrincipalSchema.parse({
  principal_id: "user_local",
  allowed_scopes: [scope],
  allowed_authorities: ["user_stated"],
  destructive_tools_enabled: true,
});

function summary(id: string, revisionId: string) {
  return WorkbenchMemorySummarySchema.parse({
    memory_id: id,
    revision_id: revisionId,
    revision: 1,
    abstraction: "l1_memory",
    lifecycle: "active",
    kind: "semantic",
    scope,
    group: { kind: "workspace_project", scope },
    authority: "user_stated",
    sensitivity: "personal",
    validity: {
      valid_from: NOW,
      valid_to: null,
      recorded_at: NOW,
    },
    content: {
      status: "available",
      text: `Memory ${id}`,
      media_type: "text/plain",
      content_hash: canonicalSha256({ id }),
    },
    is_current: true,
    writable: true,
    non_current_reason: null,
  });
}

class StableRegistry implements WorkbenchSnapshotRegistry {
  #created: WorkbenchSnapshotCreateInput | null = null;

  create(input: WorkbenchSnapshotCreateInput): WorkbenchSnapshotPage {
    this.#created = input;
    return {
      members: input.members.slice(0, 1),
      next_cursor: input.members.length > 1 ? CURSOR : null,
      retained_count: input.members.length,
      omitted_count: input.omitted_count,
      snapshot_expires_at: EXPIRES,
    };
  }

  read(
    cursor: WorkbenchOpaqueCursor,
    queryHash: CanonicalHash,
  ):
    | { status: "ready"; page: WorkbenchSnapshotPage }
    | { status: "stale"; reason_code: "CURSOR_INVALID" } {
    if (
      cursor !== CURSOR ||
      this.#created === null ||
      queryHash !== this.#created.query_hash
    ) {
      return { status: "stale", reason_code: "CURSOR_INVALID" };
    }
    return {
      status: "ready",
      page: {
        members: this.#created.members.slice(1, 2),
        next_cursor: null,
        retained_count: this.#created.members.length,
        omitted_count: this.#created.omitted_count,
        snapshot_expires_at: EXPIRES,
      },
    };
  }
}

describe("WorkbenchService", () => {
  it("keeps cursor membership stable while reloading current governance state", async () => {
    const first = summary("memory_first", "revision_first");
    const second = summary("memory_second", "revision_second");
    const historicalSecond = WorkbenchMemorySummarySchema.parse({
      ...second,
      writable: false,
      is_current: false,
      non_current_reason: "SUPERSEDED",
    });
    const listWorkbenchMemories = vi.fn(
      async (_input: WorkbenchMemoryListQuery) =>
        WorkbenchMemoryCandidateSetSchema.parse({
          frontier_hash: canonicalSha256({ frontier: 1 }),
          items: [first, second],
          candidate_space_truncated: false,
          omitted_count: 0,
          excluded_count: 0,
          exclusion_reason_codes: [],
          warnings: [],
        }),
    );
    const getWorkbenchMemorySummaries = vi.fn(
      async (_input: WorkbenchMemorySummaryBatchQuery) =>
        WorkbenchMemorySummaryBatchResultSchema.parse({
          items: [historicalSecond],
          missing_count: 0,
          reason_codes: ["SUPERSEDED"],
        }),
    );
    const service = new WorkbenchService({
      authority,
      snapshots: new StableRegistry(),
      clock: () => NOW,
      storage: {
        listWorkbenchMemories,
        getWorkbenchMemorySummaries,
        getWorkbenchMemoryDetail: async (
          _input: WorkbenchMemoryDetailQuery,
        ) =>
          WorkbenchMemoryDetailResultSchema.parse({
            status: "not_found",
            reason_code: "NOT_FOUND",
            retryable: false,
            warnings: [],
          }),
        getWorkbenchGraph: vi.fn(),
        previewWorkbenchCorrection: vi.fn(),
        applyMemoryRevision: vi.fn(),
      },
    });

    const firstPage = await service.list({ limit: 1 });
    expect(firstPage.status).toBe("ready");
    if (firstPage.status !== "ready") {
      throw new Error("expected first page");
    }
    expect(firstPage.items.map((item) => item.memory_id)).toEqual([
      "memory_first",
    ]);
    expect(listWorkbenchMemories).toHaveBeenCalledWith(
      expect.objectContaining({
        principal_id: "user_local",
        allowed_scopes: [scope],
      }),
    );

    const secondPage = await service.list({
      limit: 1,
      cursor: firstPage.page.next_cursor,
    });
    expect(secondPage.status).toBe("ready");
    if (secondPage.status !== "ready") {
      throw new Error("expected second page");
    }
    expect(secondPage.items).toMatchObject([
      {
        memory_id: "memory_second",
        revision_id: "revision_second",
        is_current: false,
        non_current_reason: "SUPERSEDED",
      },
    ]);
    expect(listWorkbenchMemories).toHaveBeenCalledTimes(1);
    expect(getWorkbenchMemorySummaries).toHaveBeenCalledTimes(1);
  });

  it("returns a typed stale cursor without querying storage", async () => {
    const getWorkbenchMemorySummaries = vi.fn();
    const service = new WorkbenchService({
      authority,
      clock: () => NOW,
      snapshots: {
        create: () => {
          throw new Error("not used");
        },
        read: () => ({
          status: "stale",
          reason_code: "SNAPSHOT_EXPIRED",
        }),
      },
      storage: {
        listWorkbenchMemories: vi.fn(),
        getWorkbenchMemorySummaries,
        getWorkbenchMemoryDetail: vi.fn(),
        getWorkbenchGraph: vi.fn(),
        previewWorkbenchCorrection: vi.fn(),
        applyMemoryRevision: vi.fn(),
      },
    });

    await expect(service.list({ limit: 1, cursor: CURSOR })).resolves.toEqual({
      status: "stale_cursor",
      reason_code: "SNAPSHOT_EXPIRED",
      retryable: true,
      warnings: [],
    });
    expect(getWorkbenchMemorySummaries).not.toHaveBeenCalled();
  });

  it("does not misreport a truncated candidate scan as governance-excluded", async () => {
    const service = new WorkbenchService({
      authority,
      snapshots: new StableRegistry(),
      clock: () => NOW,
      storage: {
        listWorkbenchMemories: async () =>
          WorkbenchMemoryCandidateSetSchema.parse({
            frontier_hash: canonicalSha256({ frontier: "truncated" }),
            items: [],
            candidate_space_truncated: true,
            omitted_count: 5,
            excluded_count: 10,
            exclusion_reason_codes: ["OPEN_CONFLICT"],
            warnings: ["candidate_space_truncated"],
          }),
        getWorkbenchMemorySummaries: vi.fn(),
        getWorkbenchMemoryDetail: vi.fn(),
        getWorkbenchGraph: vi.fn(),
        previewWorkbenchCorrection: vi.fn(),
        applyMemoryRevision: vi.fn(),
      },
    });

    await expect(service.list({ limit: 1 })).resolves.toEqual({
      status: "failed",
      reason_code: "CANDIDATE_SPACE_TRUNCATED",
      retryable: false,
      warnings: ["candidate_space_truncated"],
    });
  });

  it("derives Graph authority from the session principal and exact allowed scope", async () => {
    const center = summary("memory_graph", "revision_graph");
    const graphResult = WorkbenchGraphResultSchema.parse({
      status: "degraded",
      center_node_id: center.revision_id,
      nodes: [
        {
          node_id: center.revision_id,
          kind: "memory_revision",
          authority_plane: "canonical",
          reference_id: center.memory_id,
          revision_id: center.revision_id,
          label: "Memory memory_graph",
          scope,
          lifecycle: "active",
          is_current: true,
          content: center.content,
        },
      ],
      edges: [],
      projection_state: "unavailable",
      truncated: false,
      omitted_node_count: 0,
      omitted_edge_count: 0,
      warnings: ["graph_projection_unavailable"],
    });
    const getWorkbenchGraph = vi.fn(async () => graphResult);
    const service = new WorkbenchService({
      authority,
      snapshots: new StableRegistry(),
      clock: () => NOW,
      storage: {
        listWorkbenchMemories: vi.fn(),
        getWorkbenchMemorySummaries: vi.fn(),
        getWorkbenchMemoryDetail: vi.fn(),
        getWorkbenchGraph,
        previewWorkbenchCorrection: vi.fn(),
        applyMemoryRevision: vi.fn(),
      },
    });

    await expect(service.graph({
      scope,
      center: { kind: "memory_revision", revision_id: center.revision_id },
    })).resolves.toEqual(graphResult);
    expect(getWorkbenchGraph).toHaveBeenCalledWith(
      expect.objectContaining({
        principal_id: "user_local",
        allowed_scopes: [scope],
        request: expect.objectContaining({ scope }),
      }),
    );

    await expect(service.graph({
      scope: { kind: "topic", id: "outside" },
      center: { kind: "memory_revision", revision_id: center.revision_id },
    })).resolves.toMatchObject({
      status: "governance_excluded",
      reason_code: "SCOPE_NOT_ALLOWED",
    });
    expect(getWorkbenchGraph).toHaveBeenCalledTimes(1);
  });
});
