import { z } from "zod";

import {
  AuthoritySchema,
  CanonicalHashSchema,
  EvidenceSourceSchema,
  IdentifierSchema,
  LifecycleSchema,
  MemoryKindSchema,
  ScopeSchema,
  SensitivitySchema,
  UtcTimestampSchema,
  ValidityWindowSchema,
} from "./common.js";
import { MutationReceiptSchema } from "./mutation-receipt.js";
import {
  AutomaticMemoryPolicyReasonSchema,
  RedactionActionSchema,
} from "./automatic-memory.js";

export const WorkbenchAutomaticMemoryDecisionSchema = z
  .object({
    decision_id: IdentifierSchema,
    proposal_id: IdentifierSchema,
    disposition: z.enum([
      "activate",
      "candidate_only",
      "review_required",
      "reject",
    ]),
    reason_codes: z.array(AutomaticMemoryPolicyReasonSchema).min(1).max(8),
    requires_user_confirmation: z.boolean(),
    decided_at: UtcTimestampSchema,
    candidate_id: IdentifierSchema.nullable(),
    memory_id: IdentifierSchema.nullable(),
    revision_id: IdentifierSchema.nullable(),
    receipt_id: IdentifierSchema.nullable(),
    memory_scope: ScopeSchema.nullable(),
    current_lifecycle: LifecycleSchema.nullable(),
  })
  .strict();

export const WorkbenchAutomaticMemoryActivitySchema = z
  .object({
    turn_key: IdentifierSchema,
    project_id: IdentifierSchema,
    scope: ScopeSchema.extend({ kind: z.literal("workspace") }),
    session_id: IdentifierSchema,
    turn_id: IdentifierSchema,
    generation: z.number().int().nonnegative(),
    state: z.enum([
      "open",
      "stabilizing",
      "ready",
      "completed",
      "quarantined",
    ]),
    user_captured_at: UtcTimestampSchema.nullable(),
    assistant_captured_at: UtcTimestampSchema.nullable(),
    job: z
      .object({
        job_id: IdentifierSchema,
        status: z.enum(["pending", "processing", "completed", "quarantined"]),
        attempts: z.number().int().nonnegative(),
        updated_at: UtcTimestampSchema,
      })
      .strict()
      .nullable(),
    provider: z
      .object({
        provider_id: IdentifierSchema,
        model: z.string().trim().min(1).max(240),
        state: z.enum(["started", "succeeded", "failed"]),
        redaction_action: RedactionActionSchema,
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative(),
        latency_ms: z.number().int().nonnegative(),
        completed_at: UtcTimestampSchema.nullable(),
      })
      .strict()
      .nullable(),
    decisions: z.array(WorkbenchAutomaticMemoryDecisionSchema).max(8),
  })
  .strict();

export const WorkbenchAutomaticMemoryOverviewSchema = z
  .object({
    projects: z.number().int().nonnegative(),
    events: z.number().int().nonnegative(),
    turns: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    quarantined: z.number().int().nonnegative(),
    recall_uses: z.number().int().nonnegative(),
  })
  .strict();

export const WorkbenchAutomaticMemoryListRequestSchema = z
  .object({ limit: z.number().int().min(1).max(100).default(40) })
  .strict();

export const WorkbenchAutomaticMemoryListResultSchema = z.discriminatedUnion(
  "status",
  [
    z.object({
      status: z.enum(["ready", "ready_empty"]),
      overview: WorkbenchAutomaticMemoryOverviewSchema,
      items: z.array(WorkbenchAutomaticMemoryActivitySchema).max(100),
      warnings: z.array(z.string().trim().min(1).max(160)),
    }).strict(),
    z.object({
      status: z.enum(["blocked", "unauthorized", "failed"]),
      reason_code: z.string().trim().min(1).max(160),
      retryable: z.boolean(),
      warnings: z.array(z.string().trim().min(1).max(160)),
    }).strict(),
  ],
);

export const WorkbenchAutomaticMemoryUndoPreviewRequestSchema = z
  .object({
    memory_id: IdentifierSchema,
    expected_revision_id: IdentifierSchema,
  })
  .strict();

export const WorkbenchAutomaticMemoryUndoPreviewResultSchema =
  z.discriminatedUnion("status", [
    z.object({
      status: z.literal("ready"),
      preview_id: IdentifierSchema,
      memory_id: IdentifierSchema,
      expected_revision_id: IdentifierSchema,
      effect: z.literal("demote_from_automatic_recall"),
      expires_at: UtcTimestampSchema,
      warnings: z.array(z.string().trim().min(1).max(160)),
    }).strict(),
    z.object({
      status: z.enum(["stale", "not_found", "governance_excluded", "failed"]),
      reason_code: z.string().trim().min(1).max(160),
      retryable: z.boolean(),
      warnings: z.array(z.string().trim().min(1).max(160)),
    }).strict(),
  ]);

export const WorkbenchAutomaticMemoryUndoConfirmRequestSchema = z
  .object({ preview_id: IdentifierSchema, confirmed: z.literal(true) })
  .strict();

export const WorkbenchAutomaticMemoryUndoConfirmResultSchema =
  z.discriminatedUnion("status", [
    z.object({
      status: z.literal("ready"),
      memory_id: IdentifierSchema,
      current_revision_id: IdentifierSchema,
      lifecycle: z.literal("candidate"),
      replayed: z.boolean(),
      receipt: MutationReceiptSchema,
      warnings: z.array(z.string().trim().min(1).max(160)),
    }).strict(),
    z.object({
      status: z.enum(["stale", "not_found", "failed"]),
      reason_code: z.string().trim().min(1).max(160),
      retryable: z.boolean(),
      warnings: z.array(z.string().trim().min(1).max(160)),
    }).strict(),
  ]);

export type WorkbenchAutomaticMemoryActivity = z.infer<
  typeof WorkbenchAutomaticMemoryActivitySchema
>;
export type WorkbenchAutomaticMemoryListRequest = z.input<
  typeof WorkbenchAutomaticMemoryListRequestSchema
>;
export type WorkbenchAutomaticMemoryListResult = z.infer<
  typeof WorkbenchAutomaticMemoryListResultSchema
>;
export type WorkbenchAutomaticMemoryUndoPreviewResult = z.infer<
  typeof WorkbenchAutomaticMemoryUndoPreviewResultSchema
>;
export type WorkbenchAutomaticMemoryUndoConfirmResult = z.infer<
  typeof WorkbenchAutomaticMemoryUndoConfirmResultSchema
>;

export const WorkbenchOpaqueCursorSchema = z
  .string()
  .min(40)
  .max(768)
  .regex(/^wbcur1_[A-Za-z0-9_-]+$/)
  .brand<"WorkbenchOpaqueCursor">();

export const WorkbenchMemoryGroupSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("workspace_project"),
      scope: ScopeSchema.extend({ kind: z.literal("workspace") }),
    })
    .strict(),
  z
    .object({
      kind: z.literal("topic"),
      scope: ScopeSchema.extend({ kind: z.literal("topic") }),
    })
    .strict(),
  z
    .object({
      kind: z.literal("other"),
      scope: ScopeSchema,
    })
    .strict(),
]);

export const WorkbenchAvailableContentSchema = z
  .object({
    status: z.literal("available"),
    text: z.string().min(1).max(256_000),
    media_type: z.string().min(1).max(160),
    content_hash: CanonicalHashSchema,
  })
  .strict();

export const WorkbenchUnavailableContentSchema = z
  .object({
    status: z.enum([
      "redacted",
      "purged",
      "missing",
      "unavailable",
      "not_permitted",
      "blob_unavailable",
    ]),
    reason_code: z.string().trim().min(1).max(120),
  })
  .strict();

export const WorkbenchContentSchema = z.discriminatedUnion("status", [
  WorkbenchAvailableContentSchema,
  WorkbenchUnavailableContentSchema,
]);

export const WorkbenchNonCurrentReasonSchema = z.enum([
  "HISTORICAL",
  "SUPERSEDED",
  "CANDIDATE_ONLY",
  "QUARANTINED",
  "REVOKED",
  "TOMBSTONED",
  "NO_LIVE_EVIDENCE",
  "NO_ACTIVATION",
  "NOT_YET_VALID",
  "EXPIRED",
  "OPEN_CONFLICT",
  "USAGE_BLOCKED",
  "SENSITIVE_EXCLUDED",
  "SECRET_EXCLUDED",
  "CONTENT_NOT_INLINE",
  "CORRUPT_LINEAGE",
]);

export const WorkbenchMemorySummarySchema = z
  .object({
    memory_id: IdentifierSchema,
    revision_id: IdentifierSchema,
    revision: z.number().int().positive(),
    abstraction: z.literal("l1_memory"),
    lifecycle: LifecycleSchema,
    kind: MemoryKindSchema,
    scope: ScopeSchema,
    group: WorkbenchMemoryGroupSchema,
    authority: AuthoritySchema,
    sensitivity: SensitivitySchema,
    validity: ValidityWindowSchema,
    content: WorkbenchContentSchema,
    is_current: z.boolean(),
    writable: z.boolean(),
    non_current_reason: WorkbenchNonCurrentReasonSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const sameScope =
      value.scope.kind === value.group.scope.kind &&
      value.scope.id === value.group.scope.id;
    const correctAxis =
      (value.scope.kind === "workspace" &&
        value.group.kind === "workspace_project") ||
      (value.scope.kind === "topic" && value.group.kind === "topic") ||
      (!["workspace", "topic"].includes(value.scope.kind) &&
        value.group.kind === "other");
    if (!sameScope || !correctAxis) {
      context.addIssue({
        code: "custom",
        path: ["group"],
        message: "workbench grouping must preserve the exact governed scope",
      });
    }
    if (value.is_current !== (value.non_current_reason === null)) {
      context.addIssue({
        code: "custom",
        path: ["non_current_reason"],
        message: "current state and non-current reason must agree",
      });
    }
    if (
      value.writable &&
      (!value.is_current ||
        value.lifecycle !== "active" ||
        value.content.status !== "available")
    ) {
      context.addIssue({
        code: "custom",
        path: ["writable"],
        message: "only current active available memory can be writable",
      });
    }
  });

export const WorkbenchMemoryListRequestSchema = z
  .object({
    query: z.string().trim().min(1).max(500).nullable().default(null),
    scope: ScopeSchema.nullable().default(null),
    kinds: z.array(MemoryKindSchema).max(3).default([]),
    lifecycles: z.array(LifecycleSchema).max(7).default([]),
    authorities: z.array(AuthoritySchema).max(6).default([]),
    sources: z.array(EvidenceSourceSchema).max(6).default([]),
    recorded_after: UtcTimestampSchema.nullable().default(null),
    recorded_before: UtcTimestampSchema.nullable().default(null),
    include_non_current: z.boolean().default(false),
    limit: z.number().int().min(1).max(100).default(40),
    cursor: WorkbenchOpaqueCursorSchema.nullable().default(null),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.recorded_after !== null &&
      value.recorded_before !== null &&
      Date.parse(value.recorded_before) < Date.parse(value.recorded_after)
    ) {
      context.addIssue({
        code: "custom",
        path: ["recorded_before"],
        message: "recorded_before must not precede recorded_after",
      });
    }
  });

export const WorkbenchPageSchema = z
  .object({
    next_cursor: WorkbenchOpaqueCursorSchema.nullable(),
    retained_count: z.number().int().nonnegative(),
    omitted_count: z.number().int().nonnegative(),
    snapshot_expires_at: UtcTimestampSchema,
  })
  .strict();

export const WorkbenchMemoryCandidateSetSchema = z
  .object({
    frontier_hash: CanonicalHashSchema,
    items: z.array(WorkbenchMemorySummarySchema).max(10_000),
    candidate_space_truncated: z.boolean(),
    omitted_count: z.number().int().nonnegative(),
    excluded_count: z.number().int().nonnegative(),
    exclusion_reason_codes: z.array(WorkbenchNonCurrentReasonSchema),
    warnings: z.array(z.string().trim().min(1).max(160)),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.candidate_space_truncated && value.omitted_count !== 0) {
      context.addIssue({
        code: "custom",
        path: ["omitted_count"],
        message: "complete candidate spaces cannot omit members",
      });
    }
    if (
      value.excluded_count === 0 &&
      value.exclusion_reason_codes.length > 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["exclusion_reason_codes"],
        message: "exclusion reasons require excluded candidates",
      });
    }
  });

export const WorkbenchMemoryMemberSchema = z
  .object({
    memory_id: IdentifierSchema,
    revision_id: IdentifierSchema,
  })
  .strict();

export const WorkbenchMemorySummaryBatchResultSchema = z
  .object({
    items: z.array(WorkbenchMemorySummarySchema).max(100),
    missing_count: z.number().int().nonnegative(),
    reason_codes: z.array(WorkbenchNonCurrentReasonSchema),
  })
  .strict();

const WorkbenchListWarningsSchema = z.array(
  z.string().trim().min(1).max(160),
);

const WorkbenchPopulatedListFields = {
  items: z.array(WorkbenchMemorySummarySchema).min(1),
  page: WorkbenchPageSchema,
  excluded_count: z.number().int().nonnegative().default(0),
  reason_codes: z.array(WorkbenchNonCurrentReasonSchema).default([]),
  warnings: WorkbenchListWarningsSchema,
};

const WorkbenchEmptyListFields = {
  items: z.array(WorkbenchMemorySummarySchema).length(0),
  page: z.null(),
  excluded_count: z.number().int().nonnegative().default(0),
  reason_codes: z.array(WorkbenchNonCurrentReasonSchema).default([]),
  warnings: WorkbenchListWarningsSchema,
};

export const WorkbenchMemoryListResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ready"),
      ...WorkbenchPopulatedListFields,
    })
    .strict(),
  z
    .object({
      status: z.literal("degraded"),
      ...WorkbenchPopulatedListFields,
    })
    .strict(),
  z
    .object({
      status: z.literal("ready_empty"),
      ...WorkbenchEmptyListFields,
    })
    .strict(),
  z
    .object({
      status: z.literal("filtered_empty"),
      ...WorkbenchEmptyListFields,
    })
    .strict(),
  z
    .object({
      status: z.literal("governance_excluded"),
      items: z.array(WorkbenchMemorySummarySchema).length(0),
      excluded_count: z.number().int().positive(),
      reason_codes: z.array(WorkbenchNonCurrentReasonSchema).min(1),
      warnings: WorkbenchListWarningsSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("stale_cursor"),
      reason_code: z.enum([
        "SNAPSHOT_EXPIRED",
        "SNAPSHOT_EVICTED",
        "SNAPSHOT_RESTARTED",
        "CURSOR_INVALID",
      ]),
      retryable: z.literal(true),
      warnings: WorkbenchListWarningsSchema,
    })
    .strict(),
  z
    .object({
      status: z.enum(["blocked", "unauthorized", "failed"]),
      reason_code: z.string().trim().min(1).max(120),
      retryable: z.boolean(),
      warnings: WorkbenchListWarningsSchema,
    })
    .strict(),
]);

export const WorkbenchProvenanceNodeStatusSchema = z.enum([
  "available",
  "redacted",
  "purged",
  "missing",
  "unavailable",
  "cycle",
]);

const WorkbenchProvenanceNodeBase = {
  node_id: IdentifierSchema,
  status: WorkbenchProvenanceNodeStatusSchema,
  label: z.string().trim().min(1).max(240),
  content: WorkbenchContentSchema,
};

export const WorkbenchProvenanceNodeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("memory_revision"),
      ...WorkbenchProvenanceNodeBase,
      revision_id: IdentifierSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("evidence"),
      ...WorkbenchProvenanceNodeBase,
      evidence_id: IdentifierSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("gap"),
      ...WorkbenchProvenanceNodeBase,
      referenced_id: IdentifierSchema,
      gap_reason: z.enum([
        "missing",
        "redacted",
        "purged",
        "unavailable",
        "cycle",
        "depth_limit",
      ]),
    })
    .strict(),
]);

export const WorkbenchProvenanceEdgeSchema = z
  .object({
    edge_id: IdentifierSchema,
    from_node_id: IdentifierSchema,
    to_node_id: IdentifierSchema,
    relation: z.enum(["supported_by", "supersedes", "derived_from"]),
  })
  .strict();

export const WorkbenchProvenanceChainSchema = z
  .object({
    nodes: z.array(WorkbenchProvenanceNodeSchema).max(500),
    edges: z.array(WorkbenchProvenanceEdgeSchema).max(1_000),
    truncated: z.boolean(),
    omitted_count: z.number().int().nonnegative(),
    cycle_detected: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    const nodeIds = new Set(value.nodes.map((node) => node.node_id));
    for (const [index, edge] of value.edges.entries()) {
      if (!nodeIds.has(edge.from_node_id) || !nodeIds.has(edge.to_node_id)) {
        context.addIssue({
          code: "custom",
          path: ["edges", index],
          message: "provenance edges must reference returned nodes",
        });
      }
    }
    if (!value.truncated && value.omitted_count !== 0) {
      context.addIssue({
        code: "custom",
        path: ["omitted_count"],
        message: "complete provenance cannot report omitted nodes",
      });
    }
  });

export const WorkbenchRevisionHistoryItemSchema = z
  .object({
    revision_id: IdentifierSchema,
    revision: z.number().int().positive(),
    lifecycle: LifecycleSchema,
    authority: AuthoritySchema,
    validity: ValidityWindowSchema,
    content: WorkbenchContentSchema,
    is_current: z.boolean(),
    supersedes_revision_id: IdentifierSchema.nullable(),
  })
  .strict();

export const WorkbenchMemoryConflictSchema = z
  .object({
    conflict_group_id: IdentifierSchema,
    status: z.enum(["open", "resolved"]),
    candidate_count: z.number().int().min(2),
    resolved_revision_id: IdentifierSchema.nullable(),
  })
  .strict();

export const WorkbenchMemoryDetailSchema = WorkbenchMemorySummarySchema.extend({
  current_revision_id: IdentifierSchema.nullable(),
  conflicts: z.array(WorkbenchMemoryConflictSchema),
  projection_state: z.enum([
    "ready",
    "pending",
    "rebuilding",
    "degraded",
    "failed",
    "unavailable",
  ]),
}).strict();

export const WorkbenchMemoryDetailRequestSchema = z
  .object({
    memory_id: IdentifierSchema,
    revision_id: IdentifierSchema.nullable().default(null),
  })
  .strict();

export const WorkbenchMemoryDetailResultSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        status: z.literal("ready"),
        memory: WorkbenchMemoryDetailSchema,
        history: z.array(WorkbenchRevisionHistoryItemSchema).max(1_000),
        provenance: WorkbenchProvenanceChainSchema,
        warnings: WorkbenchListWarningsSchema,
      })
      .strict(),
    z
      .object({
        status: z.literal("governance_excluded"),
        memory_id: IdentifierSchema,
        revision_id: IdentifierSchema.nullable(),
        reason_code: WorkbenchNonCurrentReasonSchema,
        warnings: WorkbenchListWarningsSchema,
      })
      .strict(),
    z
      .object({
        status: z.enum(["not_found", "blocked", "unauthorized", "failed"]),
        reason_code: z.string().trim().min(1).max(120),
        retryable: z.boolean(),
        warnings: WorkbenchListWarningsSchema,
      })
      .strict(),
  ],
);

export const WorkbenchCorrectionDraftSchema = z
  .object({
    memory_id: IdentifierSchema,
    expected_revision_id: IdentifierSchema,
    replacement: z
      .object({
        text: z.string().trim().min(1).max(256_000),
        media_type: z.string().trim().min(1).max(160).default("text/plain"),
      })
      .strict(),
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const WorkbenchCorrectionImpactMemberSchema = z
  .object({
    projection_id: IdentifierSchema,
    projection_revision_id: IdentifierSchema,
  })
  .strict();

export const WorkbenchCorrectionImpactSealSchema = z
  .object({
    source_revision_id: IdentifierSchema,
    descendant_count: z.number().int().nonnegative(),
    closure_hash: CanonicalHashSchema,
    supported_limit: z.number().int().positive().max(10_000),
  })
  .strict();

export const WorkbenchCorrectionImpactSchema =
  WorkbenchCorrectionImpactSealSchema.extend({
    sample: z.array(WorkbenchCorrectionImpactMemberSchema).max(100),
    sample_truncated: z.boolean(),
    omitted_count: z.number().int().nonnegative(),
  })
    .strict()
    .superRefine((value, context) => {
      if (
        value.sample_truncated !== (value.omitted_count > 0) ||
        value.descendant_count !== value.sample.length + value.omitted_count
      ) {
        context.addIssue({
          code: "custom",
          path: ["omitted_count"],
          message: "correction impact sample counts must describe the full closure",
        });
      }
    });

const WorkbenchCorrectionWarningsSchema = z.array(
  z.string().trim().min(1).max(160),
);

export const WorkbenchCorrectionPreviewResultSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        status: z.literal("ready"),
        preview_id: IdentifierSchema,
        operation_id: IdentifierSchema,
        memory_id: IdentifierSchema,
        expected_revision_id: IdentifierSchema,
        replacement: z
          .object({
            text: z.string().min(1).max(256_000),
            media_type: z.string().trim().min(1).max(160),
            content_hash: CanonicalHashSchema,
          })
          .strict(),
        reason: z.string().trim().min(1).max(2_000),
        impact: WorkbenchCorrectionImpactSchema,
        seal_hash: CanonicalHashSchema,
        expires_at: UtcTimestampSchema,
        warnings: WorkbenchCorrectionWarningsSchema,
      })
      .strict(),
    z
      .object({
        status: z.enum([
          "stale",
          "not_found",
          "governance_excluded",
          "blocked",
          "failed",
        ]),
        reason_code: z.string().trim().min(1).max(120),
        retryable: z.boolean(),
        warnings: WorkbenchCorrectionWarningsSchema,
      })
      .strict(),
  ],
);

export const WorkbenchCorrectionConfirmRequestSchema = z
  .object({
    preview_id: IdentifierSchema,
    confirmed: z.literal(true),
  })
  .strict();

export const WorkbenchCorrectionConfirmResultSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        status: z.literal("ready"),
        replayed: z.boolean(),
        memory_id: IdentifierSchema,
        previous_revision_id: IdentifierSchema,
        current_revision_id: IdentifierSchema,
        receipt: MutationReceiptSchema,
        warnings: WorkbenchCorrectionWarningsSchema,
      })
      .strict(),
    z
      .object({
        status: z.enum([
          "stale_preview",
          "approval_consumed",
          "blocked",
          "failed",
        ]),
        reason_code: z.string().trim().min(1).max(120),
        retryable: z.boolean(),
        warnings: WorkbenchCorrectionWarningsSchema,
      })
      .strict(),
  ],
);

export const WorkbenchGraphNodeKindSchema = z.enum([
  "memory_revision",
  "topic",
  "scenario",
  "procedure",
  "core",
]);

export const WorkbenchGraphCenterSchema = z
  .object({
    kind: z.enum(["memory_revision", "projection_revision"]),
    revision_id: IdentifierSchema,
  })
  .strict();

export const WorkbenchGraphRequestSchema = z
  .object({
    scope: ScopeSchema,
    center: WorkbenchGraphCenterSchema,
    max_depth: z.number().int().min(0).max(3).default(2),
    max_fanout: z.number().int().min(1).max(50).default(20),
    max_nodes: z.number().int().min(1).max(200).default(80),
    max_edges: z.number().int().min(0).max(400).default(120),
  })
  .strict();

export const WorkbenchGraphNodeSchema = z
  .object({
    node_id: IdentifierSchema,
    kind: WorkbenchGraphNodeKindSchema,
    authority_plane: z.enum(["canonical", "projection"]),
    reference_id: IdentifierSchema,
    revision_id: IdentifierSchema,
    label: z.string().trim().min(1).max(8_000),
    scope: ScopeSchema,
    lifecycle: LifecycleSchema,
    is_current: z.boolean(),
    content: WorkbenchContentSchema,
  })
  .strict();

export const WorkbenchGraphRelationSchema = z.enum([
  "derived_from",
  "supports",
  "contradicts",
  "supersedes",
  "depends_on",
  "causes",
  "precedes",
  "belongs_to_topic",
  "applies_to_scenario",
  "references_entity",
]);

export const WorkbenchGraphEdgeSchema = z
  .object({
    edge_id: IdentifierSchema,
    from_node_id: IdentifierSchema,
    to_node_id: IdentifierSchema,
    relation: WorkbenchGraphRelationSchema,
    direction: z.enum(["directed", "undirected"]),
    authority_plane: z.enum(["projection_lineage", "governed_relation"]),
    source_reference_id: IdentifierSchema,
    description: z.string().trim().min(1).max(8_000).nullable(),
  })
  .strict();

const WorkbenchGraphProjectionStateSchema = z.enum([
  "ready",
  "pending",
  "rebuilding",
  "unavailable",
]);

const WorkbenchGraphReadyResultSchema = z
  .object({
    status: z.enum(["ready", "ready_empty", "degraded"]),
    center_node_id: IdentifierSchema,
    nodes: z.array(WorkbenchGraphNodeSchema).min(1).max(200),
    edges: z.array(WorkbenchGraphEdgeSchema).max(400),
    projection_state: WorkbenchGraphProjectionStateSchema,
    truncated: z.boolean(),
    omitted_node_count: z.number().int().nonnegative(),
    omitted_edge_count: z.number().int().nonnegative(),
    warnings: z.array(z.string().trim().min(1).max(160)),
  })
  .strict()
  .superRefine((value, context) => {
    const nodeIds = new Set(value.nodes.map((node) => node.node_id));
    if (!nodeIds.has(value.center_node_id)) {
      context.addIssue({
        code: "custom",
        path: ["center_node_id"],
        message: "graph center must be a returned node",
      });
    }
    for (const [index, edge] of value.edges.entries()) {
      if (!nodeIds.has(edge.from_node_id) || !nodeIds.has(edge.to_node_id)) {
        context.addIssue({
          code: "custom",
          path: ["edges", index],
          message: "graph edges must reference returned nodes",
        });
      }
    }
    const omitted = value.omitted_node_count + value.omitted_edge_count;
    if (value.truncated !== (omitted > 0)) {
      context.addIssue({
        code: "custom",
        path: ["truncated"],
        message: "graph truncation must match omitted counts",
      });
    }
    if (value.status === "ready_empty" && value.edges.length !== 0) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "ready-empty graph cannot contain relationships",
      });
    }
    if (
      value.status === "degraded" &&
      value.projection_state === "ready" &&
      !value.truncated
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "degraded graph needs a projection or truncation reason",
      });
    }
  });

export const WorkbenchGraphResultSchema = z.discriminatedUnion("status", [
  WorkbenchGraphReadyResultSchema,
  z
    .object({
      status: z.enum([
        "not_found",
        "governance_excluded",
        "unavailable",
        "failed",
      ]),
      reason_code: z.string().trim().min(1).max(120),
      retryable: z.boolean(),
      warnings: z.array(z.string().trim().min(1).max(160)),
    })
    .strict(),
]);

export const WorkbenchHealthStateSchema = z.enum([
  "healthy",
  "lagging",
  "degraded",
  "failed",
  "unavailable",
]);

export const WorkbenchHealthGuidanceSchema = z.enum([
  "NONE",
  "REOPEN_WORKBENCH",
  "CHECK_RUNTIME_CONFIG",
  "WAIT_FOR_PROJECTION",
  "INSPECT_PROJECTION_LOGS",
  "INSPECT_BACKGROUND_LOGS",
  "PROTECT_CANONICAL_DATA",
]);

export const WorkbenchHealthComponentIdSchema = z.enum([
  "canonical_storage",
  "runtime_owner",
  "fts_projection",
  "layered_projection",
  "graph_projection",
  "background_work",
]);

export const WorkbenchHealthMetricSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
    value: z.number().finite().nonnegative(),
    unit: z.enum(["count", "epoch", "bytes", "milliseconds"]),
  })
  .strict();

export const WorkbenchHealthComponentSchema = z
  .object({
    component: WorkbenchHealthComponentIdSchema,
    authority_plane: z.enum(["canonical", "runtime", "projection", "worker"]),
    observation_scope: z.enum([
      "canonical_root",
      "runtime_instance",
      "configured_scopes",
    ]),
    state: WorkbenchHealthStateSchema,
    observed_at: UtcTimestampSchema.nullable(),
    reason_code: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,79}$/u)
      .nullable(),
    guidance_code: WorkbenchHealthGuidanceSchema,
    metrics: z.array(WorkbenchHealthMetricSchema).max(16),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.state === "healthy") !== (value.reason_code === null)) {
      context.addIssue({
        code: "custom",
        path: ["reason_code"],
        message: "only healthy workbench health components omit a reason",
      });
    }
    if ((value.state === "healthy") !== (value.guidance_code === "NONE")) {
      context.addIssue({
        code: "custom",
        path: ["guidance_code"],
        message: "only healthy workbench health components use NONE guidance",
      });
    }
    if (value.state === "unavailable" && value.metrics.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["metrics"],
        message: "unavailable workbench health has no observed metrics",
      });
    }
    const names = value.metrics.map((metric) => metric.name);
    if (new Set(names).size !== names.length) {
      context.addIssue({
        code: "custom",
        path: ["metrics"],
        message: "workbench health metric names must be unique",
      });
    }
  });

export const WorkbenchHealthLaneSchema = z
  .object({
    lane: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
    state: WorkbenchHealthStateSchema,
    in_flight: z.boolean(),
    observed_at: UtcTimestampSchema,
    last_success_at: UtcTimestampSchema.nullable(),
    reason_code: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,79}$/u)
      .nullable(),
    claimed: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    retrying: z.number().int().nonnegative(),
    terminal: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.state === "healthy") !== (value.reason_code === null)) {
      context.addIssue({
        code: "custom",
        path: ["reason_code"],
        message: "only healthy background lanes omit a reason",
      });
    }
  });

export const WorkbenchHealthResultSchema = z
  .object({
    status: z.literal("ready"),
    observed_at: UtcTimestampSchema,
    stale_after: UtcTimestampSchema,
    runtime_state: z.enum(["ready", "health_only"]),
    canonical: WorkbenchHealthComponentSchema,
    runtime: WorkbenchHealthComponentSchema,
    projections: z.array(WorkbenchHealthComponentSchema).length(3),
    background: WorkbenchHealthComponentSchema,
    lanes: z.array(WorkbenchHealthLaneSchema).max(16),
    warnings: z.array(z.string().trim().min(1).max(160)),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.canonical.component !== "canonical_storage" ||
      value.canonical.authority_plane !== "canonical" ||
      value.canonical.observation_scope !== "canonical_root"
    ) {
      context.addIssue({
        code: "custom",
        path: ["canonical"],
        message: "canonical health must remain the primary authority plane",
      });
    }
    if (
      value.runtime.component !== "runtime_owner" ||
      value.runtime.authority_plane !== "runtime" ||
      value.runtime.observation_scope !== "runtime_instance"
    ) {
      context.addIssue({
        code: "custom",
        path: ["runtime"],
        message: "runtime health must describe Runtime ownership",
      });
    }
    const projectionIds = value.projections.map(({ component }) => component);
    if (
      projectionIds.join(",") !==
        "fts_projection,layered_projection,graph_projection" ||
      value.projections.some(
        ({ authority_plane, observation_scope }) =>
          authority_plane !== "projection" ||
          observation_scope !== "configured_scopes",
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["projections"],
        message: "projection health must use the fixed subordinate order",
      });
    }
    if (
      value.background.component !== "background_work" ||
      value.background.authority_plane !== "worker" ||
      value.background.observation_scope !== "runtime_instance"
    ) {
      context.addIssue({
        code: "custom",
        path: ["background"],
        message: "background health must remain a worker observation",
      });
    }
    if (Date.parse(value.stale_after) <= Date.parse(value.observed_at)) {
      context.addIssue({
        code: "custom",
        path: ["stale_after"],
        message: "workbench health observations need a future stale boundary",
      });
    }
    const lanes = value.lanes.map(({ lane }) => lane);
    if (
      new Set(lanes).size !== lanes.length ||
      [...lanes].sort().some((lane, index) => lane !== lanes[index])
    ) {
      context.addIssue({
        code: "custom",
        path: ["lanes"],
        message: "background lanes must be unique and deterministic",
      });
    }
  });

export type WorkbenchContent = z.infer<typeof WorkbenchContentSchema>;
export type WorkbenchGraphRequest = z.input<
  typeof WorkbenchGraphRequestSchema
>;
export type ParsedWorkbenchGraphRequest = z.output<
  typeof WorkbenchGraphRequestSchema
>;
export type WorkbenchGraphResult = z.infer<
  typeof WorkbenchGraphResultSchema
>;
export type WorkbenchHealthComponent = z.infer<
  typeof WorkbenchHealthComponentSchema
>;
export type WorkbenchHealthResult = z.infer<
  typeof WorkbenchHealthResultSchema
>;
export type WorkbenchCorrectionConfirmRequest = z.input<
  typeof WorkbenchCorrectionConfirmRequestSchema
>;
export type WorkbenchCorrectionConfirmResult = z.infer<
  typeof WorkbenchCorrectionConfirmResultSchema
>;
export type WorkbenchCorrectionDraft = z.input<
  typeof WorkbenchCorrectionDraftSchema
>;
export type ParsedWorkbenchCorrectionDraft = z.output<
  typeof WorkbenchCorrectionDraftSchema
>;
export type WorkbenchCorrectionImpact = z.infer<
  typeof WorkbenchCorrectionImpactSchema
>;
export type WorkbenchCorrectionImpactSeal = z.infer<
  typeof WorkbenchCorrectionImpactSealSchema
>;
export type WorkbenchCorrectionPreviewResult = z.infer<
  typeof WorkbenchCorrectionPreviewResultSchema
>;
export type WorkbenchMemoryDetail = z.infer<
  typeof WorkbenchMemoryDetailSchema
>;
export type WorkbenchMemoryCandidateSet = z.infer<
  typeof WorkbenchMemoryCandidateSetSchema
>;
export type WorkbenchMemoryDetailRequest = z.input<
  typeof WorkbenchMemoryDetailRequestSchema
>;
export type WorkbenchMemoryDetailResult = z.infer<
  typeof WorkbenchMemoryDetailResultSchema
>;
export type WorkbenchMemoryListRequest = z.input<
  typeof WorkbenchMemoryListRequestSchema
>;
export type WorkbenchMemoryMember = z.infer<
  typeof WorkbenchMemoryMemberSchema
>;
export type WorkbenchMemorySummaryBatchResult = z.infer<
  typeof WorkbenchMemorySummaryBatchResultSchema
>;
export type ParsedWorkbenchMemoryListRequest = z.output<
  typeof WorkbenchMemoryListRequestSchema
>;
export type WorkbenchMemoryListResult = z.infer<
  typeof WorkbenchMemoryListResultSchema
>;
export type WorkbenchMemorySummary = z.infer<
  typeof WorkbenchMemorySummarySchema
>;
export type WorkbenchOpaqueCursor = z.infer<
  typeof WorkbenchOpaqueCursorSchema
>;
export type WorkbenchProvenanceChain = z.infer<
  typeof WorkbenchProvenanceChainSchema
>;
