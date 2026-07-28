import { z } from "zod";

import { canonicalSha256 } from "./canonical-json.js";
import {
  AbstractionLevelSchema,
  ActorClaimSchema,
  AuthoritySchema,
  CanonicalHashSchema,
  ContentRefSchema,
  ContractVersionSchema,
  IdentifierSchema,
  LifecycleSchema,
  MemoryKindSchema,
  NonEmptyReasonSchema,
  ScopeSchema,
  SensitivitySchema,
  TransformRefSchema,
  UtcTimestampSchema,
  ValidityWindowSchema,
} from "./common.js";

export function normalizeLogicalKey(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, " ");
}

export function logicalKeyHash(value: string): `sha256:${string}` {
  return canonicalSha256(normalizeLogicalKey(value));
}

export const EvidenceSourceSchema = z.enum([
  "conversation_turn",
  "tool_result",
  "artifact",
  "user_feedback",
  "evaluation",
  "import",
]);

export const EvidenceRecordSchema = z
  .object({
    schema_version: ContractVersionSchema,
    evidence_id: IdentifierSchema,
    sequence: z.number().int().nonnegative(),
    occurred_at: UtcTimestampSchema,
    recorded_at: UtcTimestampSchema,
    scope: ScopeSchema,
    actor: ActorClaimSchema,
    source: EvidenceSourceSchema,
    authority: AuthoritySchema,
    sensitivity: SensitivitySchema,
    payload: ContentRefSchema,
    content_hash: CanonicalHashSchema,
  })
  .strict();

export const EpisodeSchema = z
  .object({
    schema_version: ContractVersionSchema,
    episode_id: IdentifierSchema,
    scope: ScopeSchema,
    started_at: UtcTimestampSchema,
    ended_at: UtcTimestampSchema,
    event_ids: z.array(IdentifierSchema).min(1),
    artifact_hashes: z.array(CanonicalHashSchema),
    outcome: z.enum(["succeeded", "failed", "partial", "abandoned"]),
    sealed_hash: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.ended_at) < Date.parse(value.started_at)) {
      context.addIssue({
        code: "custom",
        path: ["ended_at"],
        message: "ended_at must not precede started_at",
      });
    }
  });

export const MemoryObjectSchema = z
  .object({
    schema_version: ContractVersionSchema,
    memory_id: IdentifierSchema,
    kind: MemoryKindSchema,
    scope: ScopeSchema,
    lifecycle: LifecycleSchema,
    current_revision_id: IdentifierSchema.nullable(),
    pinned: z.boolean(),
    context_eligible: z.boolean(),
    created_at: UtcTimestampSchema,
    updated_at: UtcTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.lifecycle === "purged" && value.current_revision_id !== null) {
      context.addIssue({
        code: "custom",
        path: ["current_revision_id"],
        message: "purged memory cannot reference a current revision",
      });
    }
    if (
      [
        "candidate",
        "superseded",
        "revoked",
        "quarantined",
        "purged",
      ].includes(value.lifecycle) &&
      value.context_eligible
    ) {
      context.addIssue({
        code: "custom",
        path: ["context_eligible"],
        message: `${value.lifecycle} memory cannot enter context`,
      });
    }
  });

export const MemoryRevisionSchema = z
  .object({
    schema_version: ContractVersionSchema,
    revision_id: IdentifierSchema,
    memory_id: IdentifierSchema,
    revision: z.number().int().positive(),
    abstraction: AbstractionLevelSchema,
    lifecycle: LifecycleSchema,
    kind: MemoryKindSchema,
    scope: ScopeSchema,
    authority: AuthoritySchema,
    sensitivity: SensitivitySchema,
    validity: ValidityWindowSchema,
    inferred: z.boolean(),
    content: ContentRefSchema.nullable(),
    content_hash: CanonicalHashSchema,
    evidence_ids: z.array(IdentifierSchema),
    derived_from_revision_ids: z.array(IdentifierSchema),
    supersedes_revision_id: IdentifierSchema.nullable(),
    transform: TransformRefSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.abstraction === "l0_evidence") {
      context.addIssue({
        code: "custom",
        path: ["abstraction"],
        message: "MemoryRevision starts at L1; L0 uses EvidenceRecord",
      });
    }
    if (value.lifecycle === "purged" && value.content !== null) {
      context.addIssue({
        code: "custom",
        path: ["content"],
        message: "purged revisions cannot retain plaintext or blob references",
      });
    }
    if (value.lifecycle !== "purged" && value.content === null) {
      context.addIssue({
        code: "custom",
        path: ["content"],
        message: "non-purged revisions require governed content",
      });
    }
    if (value.revision === 1 && value.supersedes_revision_id !== null) {
      context.addIssue({
        code: "custom",
        path: ["supersedes_revision_id"],
        message: "the first revision cannot supersede another revision",
      });
    }
    if (value.revision > 1 && value.supersedes_revision_id === null) {
      context.addIssue({
        code: "custom",
        path: ["supersedes_revision_id"],
        message: "later revisions must identify the revision they supersede",
      });
    }
    if (
      ["l2_topic", "l2_scenario", "l2_relation", "l3_core"].includes(
        value.abstraction,
      ) &&
      value.derived_from_revision_ids.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["derived_from_revision_ids"],
        message: "L2/L3 projections require lower-level lineage",
      });
    }
    if (value.authority === "derived" && value.evidence_ids.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["evidence_ids"],
        message: "derived claims require live evidence lineage",
      });
    }
    if (
      value.abstraction === "l1_memory" &&
      value.lifecycle === "active" &&
      value.evidence_ids.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["evidence_ids"],
        message: "active L1 revisions require live evidence lineage",
      });
    }
  });

export const AdmissionDecisionSchema = z
  .object({
    schema_version: ContractVersionSchema,
    decision_id: IdentifierSchema,
    memory_id: IdentifierSchema,
    revision_id: IdentifierSchema,
    decision: z.enum([
      "activate",
      "candidate_only",
      "quarantine",
      "reject",
    ]),
    decided_by: ActorClaimSchema,
    decided_at: UtcTimestampSchema,
    reason: NonEmptyReasonSchema,
    conflict_group_id: IdentifierSchema.nullable(),
    requires_user_confirmation: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.requires_user_confirmation &&
      value.decision === "activate" &&
      value.decided_by.authority !== "user_stated"
    ) {
      context.addIssue({
        code: "custom",
        path: ["decided_by", "authority"],
        message: "user confirmation is required before activation",
      });
    }
  });

export const MemoryCandidateSchema = z
  .object({
    schema_version: ContractVersionSchema,
    candidate_id: IdentifierSchema,
    logical_key: z.string().trim().min(1).max(500),
    kind: MemoryKindSchema,
    scope: ScopeSchema,
    sensitivity: SensitivitySchema,
    inferred: z.boolean(),
    content: ContentRefSchema,
    content_hash: CanonicalHashSchema,
    evidence_ids: z.array(IdentifierSchema).min(1),
    validity: ValidityWindowSchema,
    injection_risk: z.enum(["none", "suspected", "confirmed"]),
    requires_user_confirmation: z.boolean(),
    transform: TransformRefSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.injection_risk !== "none" &&
      value.kind === "procedural" &&
      !value.requires_user_confirmation
    ) {
      context.addIssue({
        code: "custom",
        path: ["requires_user_confirmation"],
        message:
          "injection-risk procedural candidates require user confirmation",
      });
    }
  });

const PROMPT_INJECTION_PATTERN =
  /\b(ignore|disregard|override|bypass)\b.{0,80}\b(instruction|prompt|policy|system|developer)\b/iu;

export function candidateHasPromptInjectionSignal(
  candidate: z.output<typeof MemoryCandidateSchema>,
): boolean {
  return (
    candidate.injection_risk !== "none" ||
    (candidate.kind === "procedural" &&
      candidate.content.storage === "inline" &&
      PROMPT_INJECTION_PATTERN.test(candidate.content.text))
  );
}

export const MemoryConflictGroupSchema = z
  .object({
    schema_version: ContractVersionSchema,
    conflict_group_id: IdentifierSchema,
    logical_key_hash: CanonicalHashSchema,
    candidate_ids: z.array(IdentifierSchema).min(2),
    status: z.enum(["open", "resolved"]),
    resolved_revision_id: IdentifierSchema.nullable(),
    created_at: UtcTimestampSchema,
    resolved_at: UtcTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.candidate_ids).size !== value.candidate_ids.length) {
      context.addIssue({
        code: "custom",
        path: ["candidate_ids"],
        message: "conflict candidates must be unique",
      });
    }
    if (
      (value.status === "open" &&
        (value.resolved_revision_id !== null ||
          value.resolved_at !== null)) ||
      (value.status === "resolved" &&
        (value.resolved_revision_id === null || value.resolved_at === null))
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "conflict resolution state and evidence must agree",
      });
    }
  });

export const MemoryStatusEventSchema = z
  .object({
    schema_version: ContractVersionSchema,
    status_event_id: IdentifierSchema,
    memory_id: IdentifierSchema,
    revision_id: IdentifierSchema,
    action: z.enum([
      "activate",
      "demote",
      "suppress",
      "revoke",
      "tombstone",
      "purge_redact",
    ]),
    lifecycle: LifecycleSchema,
    actor: ActorClaimSchema,
    occurred_at: UtcTimestampSchema,
    reason: NonEmptyReasonSchema,
    tombstone_epoch: z.number().int().positive().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const tombstoneAction =
      value.action === "tombstone" || value.action === "purge_redact";
    if (tombstoneAction !== (value.tombstone_epoch !== null)) {
      context.addIssue({
        code: "custom",
        path: ["tombstone_epoch"],
        message: "only tombstone and purge-redaction events carry an epoch",
      });
    }
    if (
      (value.action === "activate" && value.lifecycle !== "active") ||
      (value.action === "demote" && value.lifecycle !== "candidate") ||
      (value.action === "suppress" && value.lifecycle !== "superseded") ||
      (value.action === "revoke" && value.lifecycle !== "revoked") ||
      (tombstoneAction && value.lifecycle !== "purged")
    ) {
      context.addIssue({
        code: "custom",
        path: ["lifecycle"],
        message: "status action and lifecycle must agree",
      });
    }
  });

export const MemoryPinEventSchema = z
  .object({
    schema_version: ContractVersionSchema,
    pin_event_id: IdentifierSchema,
    memory_id: IdentifierSchema,
    revision_id: IdentifierSchema,
    pinned: z.boolean(),
    actor: ActorClaimSchema,
    occurred_at: UtcTimestampSchema,
    reason: NonEmptyReasonSchema,
  })
  .strict();

export const MemoryUsageRuleSchema = z
  .object({
    schema_version: ContractVersionSchema,
    usage_rule_id: IdentifierSchema,
    memory_id: IdentifierSchema,
    revision_id: IdentifierSchema,
    effect: z.enum(["allow", "block"]),
    context_scope: ScopeSchema.nullable(),
    actor: ActorClaimSchema,
    occurred_at: UtcTimestampSchema,
    reason: NonEmptyReasonSchema,
  })
  .strict();

export const GovernedMemoryRecordSchema = z
  .object({
    memory: MemoryObjectSchema,
    current_revision: MemoryRevisionSchema.nullable(),
    admission: AdmissionDecisionSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const revision = value.current_revision;
    if (
      (value.memory.current_revision_id === null) !== (revision === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["current_revision"],
        message: "memory pointer and current revision must agree",
      });
      return;
    }
    if (revision === null) {
      return;
    }
    if (
      value.memory.current_revision_id !== revision.revision_id ||
      value.memory.memory_id !== revision.memory_id ||
      value.memory.kind !== revision.kind ||
      value.memory.scope.kind !== revision.scope.kind ||
      value.memory.scope.id !== revision.scope.id ||
      value.memory.lifecycle !== revision.lifecycle
    ) {
      context.addIssue({
        code: "custom",
        path: ["current_revision"],
        message: "current revision must match the logical memory pointer",
      });
    }
    if (
      value.admission !== null &&
      (value.admission.memory_id !== value.memory.memory_id ||
        value.admission.revision_id !== revision.revision_id)
    ) {
      context.addIssue({
        code: "custom",
        path: ["admission"],
        message: "admission decision must match the current revision",
      });
    }
    if (value.memory.lifecycle === "active") {
      if (
        value.admission === null ||
        value.admission.decision !== "activate" ||
        value.admission.memory_id !== value.memory.memory_id ||
        value.admission.revision_id !== revision.revision_id ||
        revision.evidence_ids.length === 0
      ) {
        context.addIssue({
          code: "custom",
          path: ["admission"],
          message:
            "active L1 memory requires a matching activation decision and evidence",
        });
      }
    }
  });

export const RelationRevisionSchema = z
  .object({
    schema_version: ContractVersionSchema,
    relation_revision_id: IdentifierSchema,
    relation_id: IdentifierSchema,
    revision: z.number().int().positive(),
    source_memory_id: IdentifierSchema,
    target_memory_id: IdentifierSchema,
    relation_type: z.string().trim().min(1).max(120),
    lifecycle: LifecycleSchema,
    scope: ScopeSchema,
    authority: AuthoritySchema,
    validity: ValidityWindowSchema,
    evidence_ids: z.array(IdentifierSchema).min(1),
    derived_from_revision_ids: z.array(IdentifierSchema).min(1),
    transform: TransformRefSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.source_memory_id === value.target_memory_id) {
      context.addIssue({
        code: "custom",
        path: ["target_memory_id"],
        message: "self-relations require an explicit intermediate projection",
      });
    }
  });

export const MemoryArtifactSchema = z.union([
  EvidenceRecordSchema,
  EpisodeSchema,
  MemoryObjectSchema,
  MemoryRevisionSchema,
  AdmissionDecisionSchema,
  MemoryCandidateSchema,
  MemoryConflictGroupSchema,
  MemoryStatusEventSchema,
  MemoryPinEventSchema,
  MemoryUsageRuleSchema,
  RelationRevisionSchema,
]);

export type AdmissionDecision = z.infer<typeof AdmissionDecisionSchema>;
export type Episode = z.infer<typeof EpisodeSchema>;
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;
export type GovernedMemoryRecord = z.infer<
  typeof GovernedMemoryRecordSchema
>;
export type MemoryCandidate = z.infer<typeof MemoryCandidateSchema>;
export type MemoryConflictGroup = z.infer<
  typeof MemoryConflictGroupSchema
>;
export type MemoryObject = z.infer<typeof MemoryObjectSchema>;
export type MemoryPinEvent = z.infer<typeof MemoryPinEventSchema>;
export type MemoryRevision = z.infer<typeof MemoryRevisionSchema>;
export type MemoryStatusEvent = z.infer<typeof MemoryStatusEventSchema>;
export type MemoryUsageRule = z.infer<typeof MemoryUsageRuleSchema>;
export type RelationRevision = z.infer<typeof RelationRevisionSchema>;
