import { describe, expect, it } from "vitest";

import {
  WorkbenchCorrectionConfirmRequestSchema,
  WorkbenchCorrectionImpactSchema,
  WorkbenchCorrectionPreviewResultSchema,
  WorkbenchGraphRequestSchema,
  WorkbenchGraphResultSchema,
  WorkbenchMemoryDetailResultSchema,
  WorkbenchMemoryListRequestSchema,
  WorkbenchMemoryListResultSchema,
  WorkbenchOpaqueCursorSchema,
  WorkbenchProvenanceChainSchema,
} from "../../packages/contracts/src/workbench.js";

const hash = `sha256:${"a".repeat(64)}`;
const timestamp = "2026-08-02T06:00:00.000Z";

const summary = {
  memory_id: "memory_1",
  revision_id: "revision_1",
  revision: 1,
  abstraction: "l1_memory",
  lifecycle: "active",
  kind: "semantic",
  scope: { kind: "topic", id: "topic_alpha" },
  group: {
    kind: "topic",
    scope: { kind: "topic", id: "topic_alpha" },
  },
  authority: "user_stated",
  sensitivity: "personal",
  validity: {
    valid_from: timestamp,
    valid_to: null,
    recorded_at: timestamp,
  },
  content: {
    status: "available",
    text: "The user prefers exact evidence links.",
    media_type: "text/plain",
    content_hash: hash,
  },
  is_current: true,
  writable: true,
  non_current_reason: null,
} as const;

describe("workbench contracts", () => {
  it("seals a bounded complete correction impact before confirmation", () => {
    const impact = WorkbenchCorrectionImpactSchema.parse({
      source_revision_id: "revision_1",
      descendant_count: 3,
      closure_hash: hash,
      supported_limit: 1_000,
      sample: [
        {
          projection_id: "projection_1",
          projection_revision_id: "projection_revision_1",
        },
      ],
      sample_truncated: true,
      omitted_count: 2,
    });
    const preview = WorkbenchCorrectionPreviewResultSchema.parse({
      status: "ready",
      preview_id: "preview_1",
      operation_id: "operation_1",
      memory_id: "memory_1",
      expected_revision_id: "revision_1",
      replacement: {
        text: "Corrected memory",
        media_type: "text/plain",
        content_hash: hash,
      },
      reason: "The user corrected the prior memory",
      impact,
      seal_hash: hash,
      expires_at: "2026-08-02T06:05:00.000Z",
      warnings: ["impact_sample_truncated"],
    });

    expect(preview.status).toBe("ready");
    expect(
      WorkbenchCorrectionConfirmRequestSchema.parse({
        preview_id: "preview_1",
        confirmed: true,
      }),
    ).toEqual({ preview_id: "preview_1", confirmed: true });
    expect(() =>
      WorkbenchCorrectionConfirmRequestSchema.parse({
        preview_id: "preview_1",
        confirmed: false,
      }),
    ).toThrow();
    expect(() =>
      WorkbenchCorrectionImpactSchema.parse({
        ...impact,
        omitted_count: 1,
      }),
    ).toThrow();
  });

  it("parses strict browse filters while keeping free-text out of cursor state", () => {
    expect(
      WorkbenchMemoryListRequestSchema.parse({
        query: "exact evidence",
        scope: { kind: "topic", id: "topic_alpha" },
        kinds: ["semantic"],
        lifecycles: ["active"],
        authorities: ["user_stated"],
        sources: ["user_feedback"],
        recorded_after: null,
        recorded_before: null,
        include_non_current: false,
        limit: 40,
        cursor: null,
      }),
    ).toMatchObject({ limit: 40, cursor: null });

    expect(() =>
      WorkbenchMemoryListRequestSchema.parse({
        query: null,
        scope: null,
        kinds: [],
        lifecycles: [],
        authorities: [],
        sources: [],
        recorded_after: null,
        recorded_before: null,
        include_non_current: false,
        limit: 20,
        cursor: null,
        principal_id: "must_not_be_a_browser_claim",
      }),
    ).toThrow();

    expect(() =>
      WorkbenchOpaqueCursorSchema.parse("topic_alpha:secret search text"),
    ).toThrow();
  });

  it("represents exact workspace and topic scopes as peer grouping axes", () => {
    const parsed = WorkbenchMemoryListResultSchema.parse({
      status: "ready",
      items: [summary],
      page: {
        next_cursor: null,
        retained_count: 1,
        omitted_count: 0,
        snapshot_expires_at: "2026-08-02T06:05:00.000Z",
      },
      warnings: [],
    });

    expect(parsed.status).toBe("ready");
    if (parsed.status !== "ready") {
      throw new Error("expected ready workbench list");
    }
    expect(parsed.items[0]?.group).toEqual({
      kind: "topic",
      scope: { kind: "topic", id: "topic_alpha" },
    });
    expect(parsed.items[0]?.group).not.toHaveProperty("workspace_parent");

    expect(() =>
      WorkbenchMemoryListResultSchema.parse({
        status: "ready",
        items: [
          {
            ...summary,
            group: {
              kind: "workspace_project",
              scope: { kind: "workspace", id: "invented_parent" },
            },
          },
        ],
        page: {
          next_cursor: null,
          retained_count: 1,
          omitted_count: 0,
          snapshot_expires_at: "2026-08-02T06:05:00.000Z",
        },
        warnings: [],
      }),
    ).toThrow();
  });

  it("keeps verified empty, filtered empty, and governance exclusion distinct", () => {
    expect(
      WorkbenchMemoryListResultSchema.parse({
        status: "ready_empty",
        items: [],
        page: null,
        warnings: [],
      }).status,
    ).toBe("ready_empty");

    expect(
      WorkbenchMemoryListResultSchema.parse({
        status: "filtered_empty",
        items: [],
        page: null,
        warnings: [],
      }).status,
    ).toBe("filtered_empty");

    expect(
      WorkbenchMemoryListResultSchema.parse({
        status: "governance_excluded",
        items: [],
        excluded_count: 3,
        reason_codes: ["OPEN_CONFLICT"],
        warnings: [],
      }).status,
    ).toBe("governance_excluded");

    expect(
      WorkbenchMemoryListResultSchema.parse({
        status: "stale_cursor",
        reason_code: "SNAPSHOT_EXPIRED",
        retryable: true,
        warnings: [],
      }).status,
    ).toBe("stale_cursor");
  });

  it("represents history and bounded provenance gaps without editable evidence", () => {
    const provenance = WorkbenchProvenanceChainSchema.parse({
      nodes: [
        {
          kind: "memory_revision",
          node_id: "revision_1",
          revision_id: "revision_1",
          status: "available",
          label: "Revision 1",
          content: summary.content,
        },
        {
          kind: "evidence",
          node_id: "evidence_1",
          evidence_id: "evidence_1",
          status: "redacted",
          label: "Redacted evidence",
          content: { status: "redacted", reason_code: "REDACTED" },
        },
      ],
      edges: [
        {
          edge_id: "revision_1:evidence_1",
          from_node_id: "revision_1",
          to_node_id: "evidence_1",
          relation: "supported_by",
        },
      ],
      truncated: true,
      omitted_count: 2,
      cycle_detected: false,
    });

    expect(provenance.nodes[1]?.status).toBe("redacted");
    expect(() =>
      WorkbenchProvenanceChainSchema.parse({
        ...provenance,
        nodes: [{ ...provenance.nodes[1], editable: true }],
        edges: [],
      }),
    ).toThrow();

    const detail = WorkbenchMemoryDetailResultSchema.parse({
      status: "ready",
      memory: {
        ...summary,
        current_revision_id: "revision_1",
        conflicts: [],
        projection_state: "ready",
      },
      history: [
        {
          revision_id: "revision_1",
          revision: 1,
          lifecycle: "active",
          authority: "user_stated",
          validity: summary.validity,
          content: summary.content,
          is_current: true,
          supersedes_revision_id: null,
        },
      ],
      provenance,
      warnings: [],
    });

    expect(detail.status).toBe("ready");
    if (detail.status !== "ready") {
      throw new Error("expected ready workbench detail");
    }
    expect(detail.memory.writable).toBe(true);
    expect(detail.history).toHaveLength(1);
  });

  it("requires a bounded graph whose semantic edges reference returned governed nodes", () => {
    const request = WorkbenchGraphRequestSchema.parse({
      scope: { kind: "topic", id: "topic_alpha" },
      center: { kind: "memory_revision", revision_id: "revision_1" },
    });
    expect(request).toMatchObject({
      max_depth: 2,
      max_fanout: 20,
      max_nodes: 80,
      max_edges: 120,
    });

    const graph = WorkbenchGraphResultSchema.parse({
      status: "degraded",
      center_node_id: "revision_1",
      nodes: [
        {
          node_id: "revision_1",
          kind: "memory_revision",
          authority_plane: "canonical",
          reference_id: "memory_1",
          revision_id: "revision_1",
          label: "The user prefers exact evidence links.",
          scope: summary.scope,
          lifecycle: "active",
          is_current: true,
          content: summary.content,
        },
        {
          node_id: "projection_revision_topic_1",
          kind: "topic",
          authority_plane: "projection",
          reference_id: "projection_topic_1",
          revision_id: "projection_revision_topic_1",
          label: "Evidence discipline",
          scope: summary.scope,
          lifecycle: "active",
          is_current: true,
          content: {
            ...summary.content,
            text: "Evidence discipline",
          },
        },
      ],
      edges: [
        {
          edge_id: "edge_projection_source",
          from_node_id: "projection_revision_topic_1",
          to_node_id: "revision_1",
          relation: "derived_from",
          direction: "directed",
          authority_plane: "projection_lineage",
          source_reference_id: "projection_revision_topic_1",
          description: null,
        },
      ],
      projection_state: "unavailable",
      truncated: false,
      omitted_node_count: 0,
      omitted_edge_count: 0,
      warnings: ["graph_projection_unavailable"],
    });
    expect(graph.status).toBe("degraded");
    if (graph.status !== "degraded") {
      throw new Error("expected a degraded graph contract fixture");
    }
    const lineageEdge = graph.edges[0];
    if (lineageEdge === undefined) {
      throw new Error("expected a projection lineage edge");
    }

    expect(() =>
      WorkbenchGraphResultSchema.parse({
        ...graph,
        edges: [
          {
            ...lineageEdge,
            to_node_id: "hidden_revision",
          },
        ],
      }),
    ).toThrow();
  });
});
