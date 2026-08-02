import { z } from "zod";

import {
  AbstractionLevelSchema,
  ActorClaimSchema,
  AuthoritySchema,
  CanonicalHashSchema,
  ContentRefSchema,
  ContractVersionSchema,
  IdentifierSchema,
  LifecycleSchema,
  NonEmptyReasonSchema,
  ScopeSchema,
  SensitivitySchema,
  UtcTimestampSchema,
  scopeKey,
} from "./common.js";
import {
  canonicalSha256,
  canonicalSha256Omitting,
} from "./canonical-json.js";
import { GraphPathEvidenceSchema } from "./graph.js";
import {
  CanaryAuthorizationSchema,
  LearningApprovalDetailsSchema,
  PostCanaryApprovalSchema,
} from "./learning.js";
import {
  ContextConflictSetSchema,
  ContextFrontierSchema,
  ContextScoreComponentsSchema,
  EffectiveLaneConfigurationSchema,
  LaneRequestOverridesSchema,
  LaneTelemetrySchema,
  ProjectionLineageRefSchema,
  RecallLaneSchema,
} from "./projections.js";
import { VectorSelectionEvidenceSchema } from "./vector.js";

export const ToolSafetyClassSchema = z.enum([
  "read_only",
  "proposal",
  "important_mutation",
  "destructive",
]);

export const MemoryToolNameSchema = z.enum([
  "memory_search",
  "memory_get",
  "memory_explain",
  "memory_context_compile",
  "memory_receipt_get",
  "memory_evidence_ingest",
  "memory_episode_commit",
  "memory_propose",
  "memory_feedback",
  "memory_correct",
  "memory_pin",
  "memory_demote",
  "memory_usage_set",
  "memory_revoke",
  "memory_delete",
  "learning_pause",
  "learning_resume",
  "learning_release",
  "learning_rollback",
]);

export type MemoryToolName = z.infer<typeof MemoryToolNameSchema>;
export type ToolSafetyClass = z.infer<typeof ToolSafetyClassSchema>;

export const MEMORY_TOOL_SAFETY_CLASS = {
  memory_search: "read_only",
  memory_get: "read_only",
  memory_explain: "read_only",
  memory_context_compile: "read_only",
  memory_receipt_get: "read_only",
  memory_evidence_ingest: "proposal",
  memory_episode_commit: "proposal",
  memory_propose: "proposal",
  memory_feedback: "proposal",
  memory_correct: "important_mutation",
  memory_pin: "important_mutation",
  memory_demote: "important_mutation",
  memory_usage_set: "important_mutation",
  memory_revoke: "important_mutation",
  learning_pause: "important_mutation",
  learning_resume: "important_mutation",
  learning_release: "important_mutation",
  learning_rollback: "important_mutation",
  memory_delete: "destructive",
} as const satisfies Record<MemoryToolName, ToolSafetyClass>;

const RequestEnvelopeBaseSchema = z
  .object({
    schema_version: ContractVersionSchema,
    request_id: IdentifierSchema,
    tool: MemoryToolNameSchema,
    actor_claim: ActorClaimSchema,
    scopes: z.array(ScopeSchema).min(1),
    purpose: z.string().trim().min(1).max(500),
    reason: NonEmptyReasonSchema,
    requested_at: UtcTimestampSchema,
  })
  .strict();

export const ReadRequestEnvelopeSchema = RequestEnvelopeBaseSchema.safeExtend({
  safety_class: z.literal("read_only"),
}).superRefine((value, context) => {
  const expectedClass = MEMORY_TOOL_SAFETY_CLASS[value.tool];
  if (expectedClass !== value.safety_class) {
    context.addIssue({
      code: "custom",
      path: ["safety_class"],
      message: `${value.tool} requires safety class ${expectedClass}`,
    });
  }
});

export const ProposalRequestEnvelopeSchema = RequestEnvelopeBaseSchema.safeExtend({
  safety_class: z.literal("proposal"),
  idempotency_key: z.string().trim().min(8).max(200),
}).superRefine((value, context) => {
  const expectedClass = MEMORY_TOOL_SAFETY_CLASS[value.tool];
  if (expectedClass !== value.safety_class) {
    context.addIssue({
      code: "custom",
      path: ["safety_class"],
      message: `${value.tool} requires safety class ${expectedClass}`,
    });
  }
});

export const MutationRequestEnvelopeSchema = RequestEnvelopeBaseSchema.safeExtend({
  safety_class: z.enum(["important_mutation", "destructive"]),
  idempotency_key: z.string().trim().min(8).max(200),
  expected_revision_id: IdentifierSchema.nullable(),
  approval_id: IdentifierSchema.nullable(),
  dry_run: z.boolean().default(false),
}).superRefine((value, context) => {
  const expectedClass = MEMORY_TOOL_SAFETY_CLASS[value.tool];
  if (expectedClass !== value.safety_class) {
    context.addIssue({
      code: "custom",
      path: ["safety_class"],
      message: `${value.tool} requires safety class ${expectedClass}`,
    });
  }
  if (!value.dry_run && value.approval_id === null) {
    context.addIssue({
      code: "custom",
      path: ["approval_id"],
      message: "effect-bearing mutations require a trusted approval reference",
    });
  }
});

export const ApprovalGrantSchema = z
  .object({
    schema_version: ContractVersionSchema,
    approval_id: IdentifierSchema,
    principal_id: IdentifierSchema,
    tool: MemoryToolNameSchema,
    safety_class: z.enum(["important_mutation", "destructive"]),
    scopes: z.array(ScopeSchema).min(1),
    request_hash: CanonicalHashSchema,
    issued_at: UtcTimestampSchema,
    expires_at: UtcTimestampSchema,
    manifest_hash: CanonicalHashSchema,
    learning: LearningApprovalDetailsSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (MEMORY_TOOL_SAFETY_CLASS[value.tool] !== value.safety_class) {
      context.addIssue({
        code: "custom",
        path: ["safety_class"],
        message: `${value.tool} requires safety class ${
          MEMORY_TOOL_SAFETY_CLASS[value.tool]
        }`,
      });
    }
    if (Date.parse(value.expires_at) <= Date.parse(value.issued_at)) {
      context.addIssue({
        code: "custom",
        path: ["expires_at"],
        message: "approval expiry must be after issuance",
      });
    }
    const scopeKeys = value.scopes.map(scopeKey);
    if (new Set(scopeKeys).size !== scopeKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["scopes"],
        message: "approval scopes must be unique",
      });
    }
    if (
      value.manifest_hash !==
      canonicalSha256Omitting(value, ["manifest_hash"])
    ) {
      context.addIssue({
        code: "custom",
        path: ["manifest_hash"],
        message: "approval manifest hash must bind the canonical grant",
      });
    }
    const isReleaseTool =
      value.tool === "learning_release" ||
      value.tool === "learning_rollback";
    if (isReleaseTool !== (value.learning !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["learning"],
        message:
          "learning release and rollback grants require exact post-canary binding details",
      });
    }
    if (
      value.learning !== undefined &&
      ((value.tool === "learning_release" &&
        value.learning.action !== "release") ||
        (value.tool === "learning_rollback" &&
          value.learning.action !== "rollback"))
    ) {
      context.addIssue({
        code: "custom",
        path: ["learning", "action"],
        message: "learning approval action must match the governed tool",
      });
    }
  });

export const ApprovalRegistryManifestSchema = z
  .object({
    schema_version: ContractVersionSchema,
    approvals: z.array(ApprovalGrantSchema),
    canary_authorizations: z
      .array(CanaryAuthorizationSchema)
      .optional(),
    post_canary_approvals: z
      .array(PostCanaryApprovalSchema)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.approvals.map((approval) => approval.approval_id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["approvals"],
        message: "approval ids must be unique",
      });
    }
    const canaryIds = (value.canary_authorizations ?? []).map(
      (authorization) => authorization.authorization_id,
    );
    if (new Set(canaryIds).size !== canaryIds.length) {
      context.addIssue({
        code: "custom",
        path: ["canary_authorizations"],
        message: "canary authorization ids must be unique",
      });
    }
    const postCanaryIds = (value.post_canary_approvals ?? []).map(
      (approval) => approval.approval_id,
    );
    if (new Set(postCanaryIds).size !== postCanaryIds.length) {
      context.addIssue({
        code: "custom",
        path: ["post_canary_approvals"],
        message: "post-canary approval ids must be unique",
      });
    }
  });

export const ApprovalBindingSchema = z
  .object({
    approval_id: IdentifierSchema,
    principal_id: IdentifierSchema,
    tool: z.enum([
      "memory_correct",
      "memory_pin",
      "memory_demote",
      "memory_usage_set",
      "memory_revoke",
      "memory_delete",
      "learning_pause",
      "learning_resume",
      "learning_release",
      "learning_rollback",
    ]),
    safety_class: z.enum(["important_mutation", "destructive"]),
    scopes: z.array(ScopeSchema).min(1),
    request_hash: CanonicalHashSchema,
    learning: LearningApprovalDetailsSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const isReleaseTool =
      value.tool === "learning_release" ||
      value.tool === "learning_rollback";
    if (isReleaseTool !== (value.learning !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["learning"],
        message:
          "learning release and rollback bindings require exact post-canary details",
      });
    }
    if (
      value.learning !== undefined &&
      ((value.tool === "learning_release" &&
        value.learning.action !== "release") ||
        (value.tool === "learning_rollback" &&
          value.learning.action !== "rollback"))
    ) {
      context.addIssue({
        code: "custom",
        path: ["learning", "action"],
        message: "learning approval action must match the governed tool",
      });
    }
  });

export function approvalGrantMatches(
  bindingInput: unknown,
  grantInput: unknown,
  verifiedAt: string,
): boolean {
  const binding = ApprovalBindingSchema.parse(bindingInput);
  const grant = ApprovalGrantSchema.parse(grantInput);
  const grantScopes = grant.scopes.map(scopeKey).sort();
  const bindingScopes = binding.scopes.map(scopeKey).sort();
  return (
    grant.approval_id === binding.approval_id &&
    grant.principal_id === binding.principal_id &&
    grant.tool === binding.tool &&
    grant.safety_class === binding.safety_class &&
    grant.request_hash === binding.request_hash &&
    (grant.learning === undefined) === (binding.learning === undefined) &&
    (grant.learning === undefined ||
      binding.learning === undefined ||
      canonicalSha256(grant.learning) === canonicalSha256(binding.learning)) &&
    grantScopes.length === bindingScopes.length &&
    grantScopes.every((scope, index) => scope === bindingScopes[index]) &&
    Date.parse(verifiedAt) >= Date.parse(grant.issued_at) &&
    Date.parse(verifiedAt) < Date.parse(grant.expires_at)
  );
}

export const LocalPrincipalSchema = z
  .object({
    principal_id: IdentifierSchema,
    allowed_scopes: z.array(ScopeSchema).min(1),
    allowed_authorities: z.array(AuthoritySchema).min(1),
    destructive_tools_enabled: z.boolean(),
  })
  .strict();

export const AuthorityDecisionSchema = z.discriminatedUnion("authorized", [
  z
    .object({
      authorized: z.literal(true),
      principal_id: IdentifierSchema,
    })
    .strict(),
  z
    .object({
      authorized: z.literal(false),
      code: z.enum([
        "PRINCIPAL_MISMATCH",
        "AUTHORITY_NOT_ALLOWED",
        "SCOPE_NOT_ALLOWED",
        "DESTRUCTIVE_DISABLED",
      ]),
      reason: NonEmptyReasonSchema,
    })
    .strict(),
]);

type Principal = z.infer<typeof LocalPrincipalSchema>;
type RequestEnvelope =
  | z.infer<typeof MutationRequestEnvelopeSchema>
  | z.infer<typeof ProposalRequestEnvelopeSchema>
  | z.infer<typeof ReadRequestEnvelopeSchema>;

export function authorizeRequestClaims(
  principalInput: Principal,
  requestInput: RequestEnvelope,
): z.infer<typeof AuthorityDecisionSchema> {
  const principal = LocalPrincipalSchema.parse(principalInput);
  const request = z
    .union([
      ReadRequestEnvelopeSchema,
      ProposalRequestEnvelopeSchema,
      MutationRequestEnvelopeSchema,
    ])
    .parse(requestInput);

  if (request.actor_claim.principal_id !== principal.principal_id) {
    return {
      authorized: false,
      code: "PRINCIPAL_MISMATCH",
      reason: "request actor claim does not match the configured local principal",
    };
  }
  if (!principal.allowed_authorities.includes(request.actor_claim.authority)) {
    return {
      authorized: false,
      code: "AUTHORITY_NOT_ALLOWED",
      reason: "request authority claim is outside the configured principal",
    };
  }

  const allowedScopes = new Set(principal.allowed_scopes.map(scopeKey));
  if (request.scopes.some((scope) => !allowedScopes.has(scopeKey(scope)))) {
    return {
      authorized: false,
      code: "SCOPE_NOT_ALLOWED",
      reason: "request scope claim is outside the configured principal",
    };
  }
  if (
    request.safety_class === "destructive" &&
    !principal.destructive_tools_enabled
  ) {
    return {
      authorized: false,
      code: "DESTRUCTIVE_DISABLED",
      reason: "destructive tools are disabled for the configured principal",
    };
  }
  return { authorized: true, principal_id: principal.principal_id };
}

export const RecallStatusSchema = z.enum([
  "OK",
  "NO_MATCH",
  "POLICY_EXCLUDED",
  "DEGRADED",
  "FAILED",
]);

export const McpErrorCodeSchema = z.enum([
  "INVALID_INPUT",
  "PERMISSION_DENIED",
  "CONFLICT",
  "STALE_REVISION",
  "APPROVAL_REQUIRED",
  "APPROVAL_INVALID",
  "PROJECTION_UNAVAILABLE",
  "INCOMPLETE_PURGE",
  "STALE_TOMBSTONE_FRONTIER",
  "DEGRADED_RECALL",
  "QUEUE_SATURATED",
  "RESOURCE_PRESSURE",
  "MAINTENANCE_BLOCKED",
  "INTERNAL_FAILURE",
]);

export const McpErrorSchema = z
  .object({
    code: McpErrorCodeSchema,
    message: z.string().trim().min(1).max(1_000),
    retryable: z.boolean(),
    details: z.record(z.string(), z.json()).default({}),
  })
  .strict();

export const GovernedResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("OK"),
      receipt_id: IdentifierSchema,
      data: z.json(),
    })
    .strict(),
  z
    .object({
      status: z.literal("NO_MATCH"),
      receipt_id: IdentifierSchema,
      reason: NonEmptyReasonSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("POLICY_EXCLUDED"),
      receipt_id: IdentifierSchema,
      excluded_count: z.number().int().positive(),
      reason_codes: z.array(z.string().trim().min(1)).min(1),
    })
    .strict(),
  z
    .object({
      status: z.literal("DEGRADED"),
      receipt_id: IdentifierSchema,
      fallback_lane: z.string().trim().min(1),
      warnings: z.array(z.string().trim().min(1)).min(1),
      data: z.json(),
    })
    .strict(),
  z
    .object({
      status: z.literal("FAILED"),
      receipt_id: IdentifierSchema.nullable(),
      error: McpErrorSchema,
    })
    .strict(),
]);

export const RecallRequestSchema = z
  .object({
    schema_version: ContractVersionSchema,
    request_id: IdentifierSchema,
    goal: z.string().trim().min(1).max(4_000),
    query: z.string().trim().min(1).max(4_000),
    scopes: z.array(ScopeSchema).min(1),
    as_of: UtcTimestampSchema,
    token_budget: z.number().int().positive().max(32_000),
    include_sensitive: z.boolean().default(false),
    lane_overrides: LaneRequestOverridesSchema.optional(),
  })
  .strict();

export const ContextSliceItemSchema = z
  .object({
    memory_id: IdentifierSchema,
    revision_id: IdentifierSchema,
    abstraction: AbstractionLevelSchema,
    lifecycle: LifecycleSchema,
    authority: AuthoritySchema,
    sensitivity: SensitivitySchema,
    scope: ScopeSchema,
    content: ContentRefSchema,
    evidence_ids: z.array(IdentifierSchema).min(1),
    selection_reason: NonEmptyReasonSchema,
    uncertainty: z.string().trim().min(1).nullable(),
    token_estimate: z.number().int().nonnegative(),
    lane: RecallLaneSchema.optional(),
    projection: ProjectionLineageRefSchema.optional(),
    graph_path: GraphPathEvidenceSchema.optional(),
    vector: VectorSelectionEvidenceSchema.optional(),
    score_components: ContextScoreComponentsSchema.optional(),
    conflict_group_id: IdentifierSchema.nullable().optional(),
    decision_reason_codes: z
      .array(z.string().trim().min(1).max(200))
      .min(1)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.lane === "semantic_vector") !==
      (value.vector !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["vector"],
        message:
          "semantic_vector Context items require vector selection evidence and other lanes cannot carry it",
      });
    }
    if (
      value.vector !== undefined &&
      value.abstraction !== "l1_memory"
    ) {
      context.addIssue({
        code: "custom",
        path: ["vector"],
        message: "only L1 Context items may carry vector selection evidence",
      });
    }
    const projectionLaneByAbstraction = {
      l2_topic: "topic",
      l2_scenario: "scenario_procedure",
      l3_core: "core",
    } as const;
    const fixedExpectedLane =
      value.abstraction in projectionLaneByAbstraction
        ? projectionLaneByAbstraction[
            value.abstraction as keyof typeof projectionLaneByAbstraction
          ]
        : null;
    const laneMatches =
      value.abstraction === "l2_relation"
        ? value.lane === "relation_sqlite" ||
          value.lane === "relation_graph"
        : fixedExpectedLane === null || value.lane === fixedExpectedLane;

    if (
      fixedExpectedLane !== null ||
      value.abstraction === "l2_relation"
    ) {
      if (
        !laneMatches ||
        value.projection === undefined ||
        value.score_components === undefined
      ) {
        context.addIssue({
          code: "custom",
          path: ["projection"],
          message:
            "L2/L3 Context items require matching lane, lineage, and score components",
        });
      }
      if (
        (value.lane === "relation_graph") !==
        (value.graph_path !== undefined)
      ) {
        context.addIssue({
          code: "custom",
          path: ["graph_path"],
          message:
            "relation_graph Context items require graph path evidence and other lanes cannot carry it",
        });
      }
      return;
    }

    if (
      value.projection !== undefined ||
      value.graph_path !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["projection"],
        message:
          "L0/L1 Context items cannot carry projection or graph lineage",
      });
    }
  });

export const ContextSliceSchema = z
  .object({
    schema_version: ContractVersionSchema,
    context_slice_id: IdentifierSchema,
    request_id: IdentifierSchema,
    compiler_version: ContractVersionSchema,
    created_at: UtcTimestampSchema,
    token_budget: z.number().int().positive(),
    token_used: z.number().int().nonnegative(),
    items: z.array(ContextSliceItemSchema),
    frozen_hash: CanonicalHashSchema,
    policy_version: ContractVersionSchema.optional(),
    frontier: ContextFrontierSchema.optional(),
    effective_lane_configuration:
      EffectiveLaneConfigurationSchema.optional(),
    lane_telemetry: z.array(LaneTelemetrySchema).optional(),
    conflict_sets: z.array(ContextConflictSetSchema).optional(),
    active_learning_release_id: IdentifierSchema.optional(),
    active_learning_release_hash: CanonicalHashSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.token_used > value.token_budget) {
      context.addIssue({
        code: "custom",
        path: ["token_used"],
        message: "compiled context cannot exceed its token budget",
      });
    }

    const projectionItems = value.items.filter(
      (item) => item.projection !== undefined,
    );
    if (
      projectionItems.length > 0 &&
      (value.policy_version === undefined ||
        value.frontier === undefined ||
        value.effective_lane_configuration === undefined ||
        value.lane_telemetry === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["frontier"],
        message:
          "layered Context requires policy, frontier, effective lanes, and telemetry",
      });
    }

    if (value.lane_telemetry !== undefined) {
      const lanes = value.lane_telemetry.map((item) => item.lane);
      if (new Set(lanes).size !== lanes.length) {
        context.addIssue({
          code: "custom",
          path: ["lane_telemetry"],
          message: "Context lane telemetry must contain one row per lane",
        });
      }
    }

    const conflictIds = new Set(
      (value.conflict_sets ?? []).map((set) => set.conflict_group_id),
    );
    for (const [index, item] of value.items.entries()) {
      if (
        item.conflict_group_id !== undefined &&
        item.conflict_group_id !== null &&
        !conflictIds.has(item.conflict_group_id)
      ) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "conflict_group_id"],
          message: "Context item conflict reference must resolve",
        });
      }
    }
    if (
      (value.active_learning_release_id === undefined) !==
      (value.active_learning_release_hash === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["active_learning_release_id"],
        message:
          "Context learning release identity and hash must appear together",
      });
    }
    if (
      value.active_learning_release_id !==
        value.effective_lane_configuration?.active_learning_release_id ||
      value.active_learning_release_hash !==
        value.effective_lane_configuration?.active_learning_release_hash
    ) {
      context.addIssue({
        code: "custom",
        path: ["effective_lane_configuration"],
        message:
          "Context and effective lane configuration must bind the same active learning release",
      });
    }
  });

export type AuthorityDecision = z.infer<typeof AuthorityDecisionSchema>;
export type ApprovalGrant = z.infer<typeof ApprovalGrantSchema>;
export type ApprovalBinding = z.infer<typeof ApprovalBindingSchema>;
export type ApprovalRegistryManifest = z.infer<
  typeof ApprovalRegistryManifestSchema
>;
export type ContextSlice = z.infer<typeof ContextSliceSchema>;
export type ContextSliceItem = z.infer<typeof ContextSliceItemSchema>;
export type GovernedResponse = z.infer<typeof GovernedResponseSchema>;
export type LocalPrincipal = z.infer<typeof LocalPrincipalSchema>;
export type McpError = z.infer<typeof McpErrorSchema>;
export type MutationRequestEnvelope = z.infer<
  typeof MutationRequestEnvelopeSchema
>;
export type RecallRequest = z.infer<typeof RecallRequestSchema>;
export type RecallStatus = z.infer<typeof RecallStatusSchema>;
