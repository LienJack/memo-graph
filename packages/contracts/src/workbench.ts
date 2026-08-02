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
