import { z } from "zod";

import {
  AuthoritySchema,
  CanonicalHashSchema,
  ContractVersionSchema,
  IdentifierSchema,
  MemoryKindSchema,
  ScopeSchema,
  SensitivitySchema,
  UtcTimestampSchema,
} from "./common.js";

const BoundedTextSchema = z.string().min(1).max(64_000);
const ScoreSchema = z.number().min(0).max(1);

const EventBaseShape = {
  schema_version: ContractVersionSchema,
  event_id: IdentifierSchema,
  session_id: IdentifierSchema,
  cwd: z.string().min(1).max(4_096),
  occurred_at: UtcTimestampSchema,
  model: z.string().trim().min(1).max(240).nullable(),
};

export const SessionStartMemoryEventSchema = z
  .object({
    ...EventBaseShape,
    event_kind: z.literal("session_start"),
    source: z.enum(["startup", "resume", "clear", "compact"]),
  })
  .strict();

export const UserPromptSubmitMemoryEventSchema = z
  .object({
    ...EventBaseShape,
    event_kind: z.literal("user_prompt_submit"),
    turn_id: IdentifierSchema,
    generation: z.number().int().positive(),
    prompt: BoundedTextSchema,
  })
  .strict();

export const AssistantStopMemoryEventSchema = z
  .object({
    ...EventBaseShape,
    event_kind: z.literal("assistant_stop"),
    turn_id: IdentifierSchema,
    generation: z.number().int().positive(),
    stop_hook_active: z.boolean(),
    last_assistant_message: BoundedTextSchema.nullable(),
  })
  .strict();

export const SessionEndMemoryEventSchema = z
  .object({
    ...EventBaseShape,
    event_kind: z.literal("session_end"),
    reason: z.enum(["clear", "logout", "prompt_input_exit", "other"]),
  })
  .strict();

export const AutomaticMemoryEventSchema = z.discriminatedUnion("event_kind", [
  SessionStartMemoryEventSchema,
  UserPromptSubmitMemoryEventSchema,
  AssistantStopMemoryEventSchema,
  SessionEndMemoryEventSchema,
]);

export const AutomaticMemoryCaptureOutcomeSchema = z
  .object({
    schema_version: ContractVersionSchema,
    capture_id: IdentifierSchema,
    event_id: IdentifierSchema,
    session_id: IdentifierSchema,
    outcome: z.enum(["accepted", "spooled", "skipped", "rejected"]),
    reason_code: z.enum([
      "captured",
      "automatic_memory_disabled",
      "duplicate_event",
      "invalid_event",
      "payload_too_large",
      "runtime_unavailable",
      "stop_already_active",
    ]),
    recorded_at: UtcTimestampSchema,
    payload_hash: CanonicalHashSchema.nullable(),
  })
  .strict();

export const AutomaticMemoryCategorySchema = z.enum([
  "stable_user_preference",
  "user_correction",
  "repository_convention",
  "confirmed_project_decision",
]);

export const AutomaticMemoryExclusionReasonSchema = z.enum([
  "temporary_instruction",
  "task_progress",
  "assistant_speculation",
  "unconfirmed_conclusion",
  "secret_or_sensitive",
  "tool_log",
  "global_procedural_change",
  "system_or_developer_instruction",
]);

export const AutomaticMemoryPolicyModeSchema = z.enum([
  "disabled",
  "observe",
  "balanced",
]);

export const AutomaticMemoryDispositionSchema = z.enum([
  "activate",
  "candidate_only",
  "review_required",
  "reject",
]);

export const RedactionFindingCategorySchema = z.enum([
  "credential",
  "secret",
  "personal_identifier",
  "private_key",
  "access_token",
  "connection_string",
  "high_entropy_value",
  "configured_identifier",
  "local_path",
]);

export const RedactionActionSchema = z.enum([
  "accepted",
  "redacted",
  "rejected",
]);

export const RedactionReportSchema = z
  .object({
    schema_version: ContractVersionSchema,
    policy_version: ContractVersionSchema,
    original_hash: CanonicalHashSchema,
    redacted_hash: CanonicalHashSchema,
    action: RedactionActionSchema,
    finding_categories: z.array(RedactionFindingCategorySchema).max(32),
    egress_safe: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === "rejected" && value.egress_safe) {
      context.addIssue({
        code: "custom",
        path: ["egress_safe"],
        message: "rejected content cannot be marked safe for egress",
      });
    }
    if (value.action === "redacted" && value.finding_categories.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["finding_categories"],
        message: "redaction requires at least one finding category",
      });
    }
  });

export const FormationEvidenceReferenceSchema = z
  .object({
    evidence_id: IdentifierSchema,
    speaker: z.enum(["user", "assistant"]),
    authority: AuthoritySchema,
    content_hash: CanonicalHashSchema,
  })
  .strict();

export const FormationProposalSchema = z
  .object({
    schema_version: ContractVersionSchema,
    proposal_id: IdentifierSchema,
    category: AutomaticMemoryCategorySchema,
    summary: z.string().trim().min(1).max(2_000),
    logical_key: z.string().trim().min(1).max(500),
    recommended_scope: z.enum(["global_user", "repository"]),
    sensitivity: SensitivitySchema,
    authority_basis: z.enum([
      "user_explicit",
      "user_confirmation",
      "user_correction",
      "assistant_context_only",
      "mixed",
    ]),
    temporariness: z.enum(["durable", "uncertain", "temporary"]),
    explicitness: ScoreSchema,
    expected_reuse: ScoreSchema,
    stability: ScoreSchema,
    confidence: ScoreSchema,
    conflict_likelihood: ScoreSchema,
    evidence: z.array(FormationEvidenceReferenceSchema).min(1).max(16),
  })
  .strict();

export const ProviderFormationTurnSchema = z
  .object({
    evidence_id: IdentifierSchema,
    role: z.enum(["user", "assistant"]),
    text: BoundedTextSchema,
    content_hash: CanonicalHashSchema,
  })
  .strict();

export const ProviderFormationRequestSchema = z
  .object({
    schema_version: ContractVersionSchema,
    request_id: IdentifierSchema,
    provider_id: IdentifierSchema,
    model: z.string().trim().min(1).max(240),
    prompt_version: ContractVersionSchema,
    policy_version: ContractVersionSchema,
    schema_revision: ContractVersionSchema,
    requested_at: UtcTimestampSchema,
    project_identity_hash: CanonicalHashSchema,
    redaction: RedactionReportSchema,
    turns: z.array(ProviderFormationTurnSchema).min(1).max(24),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.redaction.egress_safe) {
      context.addIssue({
        code: "custom",
        path: ["redaction", "egress_safe"],
        message: "provider requests require locally approved egress",
      });
    }
  });

export const ProviderFormationUsageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  })
  .strict();

export const ProviderFormationResultSchema = z
  .object({
    schema_version: ContractVersionSchema,
    request_id: IdentifierSchema,
    provider_id: IdentifierSchema,
    model: z.string().trim().min(1).max(240),
    completed_at: UtcTimestampSchema,
    proposals: z.array(FormationProposalSchema).max(8),
    usage: ProviderFormationUsageSchema,
  })
  .strict();

export const AutomaticMemoryPolicyInputSchema = z
  .object({
    schema_version: ContractVersionSchema,
    decision_id: IdentifierSchema,
    mode: AutomaticMemoryPolicyModeSchema,
    policy_version: ContractVersionSchema,
    decided_at: UtcTimestampSchema,
    target_scope: ScopeSchema,
    proposal: FormationProposalSchema,
    exclusions: z.array(AutomaticMemoryExclusionReasonSchema).max(16),
    has_local_conflict: z.boolean(),
    injection_risk: z.enum(["none", "suspected", "confirmed"]),
    changes_global_behavior: z.boolean(),
  })
  .strict();

export const AutomaticMemoryPolicyReasonSchema = z.enum([
  "automatic_memory_disabled",
  "observe_mode",
  "eligible_for_activation",
  "excluded_content",
  "sensitive_content",
  "assistant_only_authority",
  "temporary_or_uncertain",
  "threshold_not_met",
  "mixed_authority",
  "local_conflict",
  "prompt_injection_confirmed",
  "prompt_injection_suspected",
  "scope_or_authority_requires_review",
  "global_behavior_change_requires_review",
]);

export const AutomaticMemoryPolicyDecisionSchema = z
  .object({
    schema_version: ContractVersionSchema,
    decision_id: IdentifierSchema,
    proposal_id: IdentifierSchema,
    mode: AutomaticMemoryPolicyModeSchema,
    disposition: AutomaticMemoryDispositionSchema,
    memory_kind: MemoryKindSchema,
    reason_codes: z.array(AutomaticMemoryPolicyReasonSchema).min(1).max(8),
    requires_user_confirmation: z.boolean(),
    decided_at: UtcTimestampSchema,
    policy_version: ContractVersionSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.disposition === "review_required" && !value.requires_user_confirmation) {
      context.addIssue({
        code: "custom",
        path: ["requires_user_confirmation"],
        message: "review-required decisions require user confirmation",
      });
    }
    if (value.disposition === "activate" && value.requires_user_confirmation) {
      context.addIssue({
        code: "custom",
        path: ["requires_user_confirmation"],
        message: "activation cannot precede required user confirmation",
      });
    }
    if (value.mode !== "balanced" && value.disposition === "activate") {
      context.addIssue({
        code: "custom",
        path: ["disposition"],
        message: "only balanced mode can activate automatic memory",
      });
    }
  });

export const AutomaticMemoryDispositionCountsSchema = z
  .object({
    activate: z.number().int().nonnegative(),
    candidate_only: z.number().int().nonnegative(),
    review_required: z.number().int().nonnegative(),
    reject: z.number().int().nonnegative(),
  })
  .strict();

export const AutomaticMemoryAuditSummarySchema = z
  .object({
    schema_version: ContractVersionSchema,
    audit_id: IdentifierSchema,
    session_id: IdentifierSchema,
    event_id: IdentifierSchema,
    request_id: IdentifierSchema.nullable(),
    provider_id: IdentifierSchema.nullable(),
    proposal_count: z.number().int().nonnegative().max(8),
    disposition_counts: AutomaticMemoryDispositionCountsSchema,
    reason_codes: z.array(AutomaticMemoryPolicyReasonSchema).max(32),
    redaction_action: RedactionActionSchema,
    recorded_at: UtcTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const count =
      value.disposition_counts.activate +
      value.disposition_counts.candidate_only +
      value.disposition_counts.review_required +
      value.disposition_counts.reject;
    if (count !== value.proposal_count) {
      context.addIssue({
        code: "custom",
        path: ["disposition_counts"],
        message: "disposition counts must equal proposal_count",
      });
    }
  });

export type AutomaticMemoryAuditSummary = z.infer<
  typeof AutomaticMemoryAuditSummarySchema
>;
export type AutomaticMemoryCaptureOutcome = z.infer<
  typeof AutomaticMemoryCaptureOutcomeSchema
>;
export type AutomaticMemoryCategory = z.infer<
  typeof AutomaticMemoryCategorySchema
>;
export type AutomaticMemoryDisposition = z.infer<
  typeof AutomaticMemoryDispositionSchema
>;
export type AutomaticMemoryEvent = z.infer<typeof AutomaticMemoryEventSchema>;
export type AutomaticMemoryExclusionReason = z.infer<
  typeof AutomaticMemoryExclusionReasonSchema
>;
export type AutomaticMemoryPolicyDecision = z.infer<
  typeof AutomaticMemoryPolicyDecisionSchema
>;
export type AutomaticMemoryPolicyInput = z.infer<
  typeof AutomaticMemoryPolicyInputSchema
>;
export type AutomaticMemoryPolicyMode = z.infer<
  typeof AutomaticMemoryPolicyModeSchema
>;
export type FormationProposal = z.infer<typeof FormationProposalSchema>;
export type ProviderFormationRequest = z.infer<
  typeof ProviderFormationRequestSchema
>;
export type ProviderFormationResult = z.infer<
  typeof ProviderFormationResultSchema
>;
export type ProviderFormationTurn = z.infer<
  typeof ProviderFormationTurnSchema
>;
export type RedactionFindingCategory = z.infer<
  typeof RedactionFindingCategorySchema
>;
export type RedactionReport = z.infer<typeof RedactionReportSchema>;
