import {
  WorkbenchCorrectionConfirmResultSchema,
  WorkbenchCorrectionPreviewResultSchema,
  WorkbenchMemoryDetailResultSchema,
  WorkbenchMemoryListResultSchema,
  WorkbenchMemorySummarySchema,
  WorkbenchGraphResultSchema,
} from "../../../packages/contracts/src/workbench.js";

const NOW = "2026-08-02T08:00:00.000Z";
const EXPIRES = "2026-08-02T08:05:00.000Z";
const workspaceScope = { kind: "workspace", id: "memo_graph" } as const;
const topicScope = { kind: "topic", id: "memory_governance" } as const;

export const currentMemory = summary({
  memoryId: "memory_current",
  revisionId: "revision_current",
  text: "启动后先进入记忆工作台，Graph 与运行仪表盘保持同级。",
  scope: workspaceScope,
  writable: true,
});

export const topicMemory = summary({
  memoryId: "memory_topic",
  revisionId: "revision_topic",
  text: "主题记忆保持独立 scope，不伪造 workspace 父节点。",
  scope: topicScope,
  writable: true,
});

export const historicalMemory = WorkbenchMemorySummarySchema.parse({
  ...currentMemory,
  revision_id: "revision_historical",
  revision: 1,
  lifecycle: "superseded",
  content: available("旧的启动入口描述"),
  is_current: false,
  writable: false,
  non_current_reason: "SUPERSEDED",
});

export const readyList = WorkbenchMemoryListResultSchema.parse({
  status: "ready",
  items: [currentMemory, topicMemory],
  page: {
    next_cursor: null,
    retained_count: 2,
    omitted_count: 0,
    snapshot_expires_at: EXPIRES,
  },
  excluded_count: 0,
  reason_codes: [],
  warnings: [],
});

export const readyDetail = WorkbenchMemoryDetailResultSchema.parse({
  status: "ready",
  memory: {
    ...currentMemory,
    current_revision_id: currentMemory.revision_id,
    conflicts: [],
    projection_state: "ready",
  },
  history: [
    {
      revision_id: currentMemory.revision_id,
      revision: 2,
      lifecycle: "active",
      authority: "user_stated",
      validity: currentMemory.validity,
      content: currentMemory.content,
      is_current: true,
      supersedes_revision_id: historicalMemory.revision_id,
    },
    {
      revision_id: historicalMemory.revision_id,
      revision: 1,
      lifecycle: "superseded",
      authority: "user_stated",
      validity: historicalMemory.validity,
      content: historicalMemory.content,
      is_current: false,
      supersedes_revision_id: null,
    },
  ],
  provenance: {
    nodes: [
      {
        kind: "memory_revision",
        node_id: "node_current_revision",
        status: "available",
        label: "当前记忆修订",
        content: currentMemory.content,
        revision_id: currentMemory.revision_id,
      },
      {
        kind: "evidence",
        node_id: "node_user_feedback",
        status: "available",
        label: "用户明确说明",
        content: available("用户确认启动入口应为记忆工作台"),
        evidence_id: "evidence_user_feedback",
      },
      {
        kind: "gap",
        node_id: "node_redacted_gap",
        status: "redacted",
        label: "已脱敏来源",
        content: {
          status: "redacted",
          reason_code: "SOURCE_REDACTED",
        },
        referenced_id: "evidence_redacted",
        gap_reason: "redacted",
      },
    ],
    edges: [
      {
        edge_id: "edge_current_feedback",
        from_node_id: "node_current_revision",
        to_node_id: "node_user_feedback",
        relation: "supported_by",
      },
      {
        edge_id: "edge_current_gap",
        from_node_id: "node_current_revision",
        to_node_id: "node_redacted_gap",
        relation: "supported_by",
      },
    ],
    truncated: false,
    omitted_count: 0,
    cycle_detected: false,
  },
  warnings: [],
});

export const historicalDetail = WorkbenchMemoryDetailResultSchema.parse({
  ...readyDetail,
  memory: {
    ...historicalMemory,
    current_revision_id: currentMemory.revision_id,
    conflicts: [],
    projection_state: "ready",
  },
});

export const degradedGraph = WorkbenchGraphResultSchema.parse({
  status: "degraded",
  center_node_id: currentMemory.revision_id,
  nodes: [
    {
      node_id: currentMemory.revision_id,
      kind: "memory_revision",
      authority_plane: "canonical",
      reference_id: currentMemory.memory_id,
      revision_id: currentMemory.revision_id,
      label: currentMemory.content.status === "available"
        ? currentMemory.content.text
        : "当前记忆",
      scope: currentMemory.scope,
      lifecycle: currentMemory.lifecycle,
      is_current: true,
      content: currentMemory.content,
    },
    {
      node_id: "projection_revision_workbench_topic",
      kind: "topic",
      authority_plane: "projection",
      reference_id: "projection_workbench_topic",
      revision_id: "projection_revision_workbench_topic",
      label: "启动入口治理",
      scope: currentMemory.scope,
      lifecycle: "active",
      is_current: true,
      content: available("记忆工作台、Graph 与运行仪表盘的入口关系"),
    },
  ],
  edges: [
    {
      edge_id: "edge_workbench_topic_source",
      from_node_id: "projection_revision_workbench_topic",
      to_node_id: currentMemory.revision_id,
      relation: "derived_from",
      direction: "directed",
      authority_plane: "projection_lineage",
      source_reference_id: "projection_revision_workbench_topic",
      description: null,
    },
  ],
  projection_state: "unavailable",
  truncated: false,
  omitted_node_count: 0,
  omitted_edge_count: 0,
  warnings: ["graph_projection_unavailable"],
});

export const readyPreview = WorkbenchCorrectionPreviewResultSchema.parse({
  status: "ready",
  preview_id: "workbench-preview_test",
  operation_id: "workbench-correction_test",
  memory_id: currentMemory.memory_id,
  expected_revision_id: currentMemory.revision_id,
  replacement: {
    text: "启动后直接进入可治理的记忆工作台。",
    media_type: "text/plain",
    content_hash: testHash("1"),
  },
  reason: "用户明确纠正了启动入口描述",
  impact: {
    source_revision_id: currentMemory.revision_id,
    descendant_count: 2,
    closure_hash: testHash("2"),
    supported_limit: 1_000,
    sample: [
      {
        projection_id: "projection_topic",
        projection_revision_id: "projection_revision_topic",
      },
    ],
    sample_truncated: true,
    omitted_count: 1,
  },
  seal_hash: testHash("3"),
  expires_at: EXPIRES,
  warnings: ["impact_sample_truncated"],
});

export const readyConfirmation = WorkbenchCorrectionConfirmResultSchema.parse({
  status: "ready",
  replayed: false,
  memory_id: currentMemory.memory_id,
  previous_revision_id: currentMemory.revision_id,
  current_revision_id: "revision_successor",
  receipt: {
    schema_version: "1.0.0",
    receipt_id: "receipt_workbench_correction",
    created_at: NOW,
    state: "projection_pending",
    request_hash: testHash("4"),
    receipt_hash: testHash("5"),
    kind: "mutation",
    idempotency_key: "workbench-correction-test",
    affected_memory_ids: [currentMemory.memory_id],
    affected_revision_ids: ["revision_successor"],
    resulting_epoch: 4,
    projection_jobs: ["projection_job_topic"],
    warnings: [],
  },
  warnings: [],
});

function summary(input: {
  memoryId: string;
  revisionId: string;
  text: string;
  scope: typeof workspaceScope | typeof topicScope;
  writable: boolean;
}) {
  return WorkbenchMemorySummarySchema.parse({
    memory_id: input.memoryId,
    revision_id: input.revisionId,
    revision: 2,
    abstraction: "l1_memory",
    lifecycle: "active",
    kind: "semantic",
    scope: input.scope,
    group:
      input.scope.kind === "workspace"
        ? { kind: "workspace_project", scope: input.scope }
        : { kind: "topic", scope: input.scope },
    authority: "user_stated",
    sensitivity: "personal",
    validity: {
      valid_from: NOW,
      valid_to: null,
      recorded_at: NOW,
    },
    content: available(input.text),
    is_current: true,
    writable: input.writable,
    non_current_reason: null,
  });
}

function available(text: string) {
  return {
    status: "available" as const,
    text,
    media_type: "text/plain",
    content_hash: testHash("a"),
  };
}

function testHash(fill: string) {
  return `sha256:${fill.repeat(64)}`;
}
