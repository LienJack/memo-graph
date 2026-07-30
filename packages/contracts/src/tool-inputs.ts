import { z } from "zod";

import {
  CanonicalHashSchema,
  ContentRefSchema,
  AuthoritySchema,
  IdentifierSchema,
  LifecycleSchema,
  MemoryKindSchema,
  ScopeSchema,
  SensitivitySchema,
  TransformRefSchema,
  ValidityWindowSchema,
  scopeKey,
} from "./common.js";
import {
  MutationRequestEnvelopeSchema,
  ReadRequestEnvelopeSchema,
  ProposalRequestEnvelopeSchema,
  RecallRequestSchema,
} from "./mcp.js";
import {
  EpisodeSchema,
  EvidenceRecordSchema,
  MemoryCandidateSchema,
} from "./memory.js";
import { canonicalJson } from "./canonical-json.js";
import { LearningOutcomeSchema } from "./learning.js";

function withExpectedTool<T extends z.ZodType>(
  schema: T,
  tool: string,
): T {
  return schema.superRefine((value, context) => {
    if (
      typeof value === "object" &&
      value !== null &&
      "envelope" in value &&
      typeof value.envelope === "object" &&
      value.envelope !== null &&
      "tool" in value.envelope &&
      value.envelope.tool !== tool
    ) {
      context.addIssue({
        code: "custom",
        path: ["envelope", "tool"],
        message: `expected ${tool}`,
      });
    }
  }) as T;
}

const Base64Schema = z
  .string()
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);

export const MemorySearchInputSchema = withExpectedTool(
  z
    .object({
      envelope: ReadRequestEnvelopeSchema,
      query: z.string().trim().min(1).max(500),
      limit: z.number().int().min(1).max(100).default(20),
      include_sensitive: z.boolean().default(false),
    })
    .strict(),
  "memory_search",
);

export const MemoryEvidenceLookupInputSchema = z
  .object({
    envelope: ReadRequestEnvelopeSchema,
    evidence_id: z.string().trim().min(1).max(160),
    scope: ScopeSchema,
  })
  .strict();

export const GovernedMemoryLookupSelectorSchema = z.union([
  z.object({ evidence_id: IdentifierSchema }).strict(),
  z.object({ memory_id: IdentifierSchema }).strict(),
]);

const MemoryGovernedLookupInputSchema = z
  .object({
    envelope: ReadRequestEnvelopeSchema,
    memory_id: IdentifierSchema,
    scope: ScopeSchema,
    include_sensitive: z.boolean().default(false),
  })
  .strict();

export const MemoryGetInputSchema = withExpectedTool(
  z.union([
    MemoryEvidenceLookupInputSchema,
    MemoryGovernedLookupInputSchema,
  ]),
  "memory_get",
);

export const MemoryExplainInputSchema = withExpectedTool(
  z.union([
    MemoryEvidenceLookupInputSchema,
    MemoryGovernedLookupInputSchema,
  ]),
  "memory_explain",
);

export const MemoryReceiptGetInputSchema = withExpectedTool(
  z
    .object({
      envelope: ReadRequestEnvelopeSchema,
      receipt_id: z.string().trim().min(1).max(160),
    })
    .strict(),
  "memory_receipt_get",
);

export const MemoryContextCompileInputSchema = withExpectedTool(
  z
    .object({
      envelope: ReadRequestEnvelopeSchema,
      recall: RecallRequestSchema,
    })
    .strict()
    .superRefine((value, context) => {
      if (value.envelope.request_id !== value.recall.request_id) {
        context.addIssue({
          code: "custom",
          path: ["recall", "request_id"],
          message: "recall and envelope request ids must match",
        });
      }
      const envelopeScopes = value.envelope.scopes.map(scopeKey).sort();
      const recallScopes = value.recall.scopes.map(scopeKey).sort();
      if (canonicalJson(envelopeScopes) !== canonicalJson(recallScopes)) {
        context.addIssue({
          code: "custom",
          path: ["recall", "scopes"],
          message: "recall and envelope scopes must match",
        });
      }
    }),
  "memory_context_compile",
);

export const EpisodeBlobInputSchema = z
  .object({
    content_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    media_type: z.string().trim().min(1).max(160),
    data_base64: Base64Schema,
  })
  .strict();

export const MemoryEpisodeCommitInputSchema = withExpectedTool(
  z
    .object({
      envelope: ProposalRequestEnvelopeSchema,
      episode: EpisodeSchema,
      evidence: z.array(EvidenceRecordSchema).min(1),
      blobs: z.array(EpisodeBlobInputSchema),
    })
    .strict()
    .superRefine((value, context) => {
      for (const [index, evidence] of value.evidence.entries()) {
        if (evidence.sensitivity === "secret") {
          context.addIssue({
            code: "custom",
            path: ["evidence", index, "sensitivity"],
            message:
              "MCP cannot originate secret plaintext; reference an existing encrypted evidence identity",
          });
        }
      }
    }),
  "memory_episode_commit",
);

export const MemoryProposeInputSchema = withExpectedTool(
  z
    .object({
      envelope: ProposalRequestEnvelopeSchema,
      candidate: MemoryCandidateSchema,
    })
    .strict()
    .superRefine((value, context) => {
      if (
        !value.envelope.scopes.some(
          (scope) => scopeKey(scope) === scopeKey(value.candidate.scope),
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["candidate", "scope"],
          message: "candidate scope is outside the request envelope",
        });
      }
      if (value.candidate.sensitivity === "secret") {
        context.addIssue({
          code: "custom",
          path: ["candidate", "sensitivity"],
          message:
            "MCP cannot originate secret plaintext; reference an existing encrypted evidence identity",
        });
      }
    }),
  "memory_propose",
);

export const MemoryFeedbackInputSchema = withExpectedTool(
  z
    .object({
      envelope: ProposalRequestEnvelopeSchema,
      feedback: z
        .object({
          task_id: IdentifierSchema,
          context_slice_id: IdentifierSchema,
          outcome: LearningOutcomeSchema,
          evidence_ids: z.array(IdentifierSchema).max(100),
          error_codes: z
            .array(z.string().trim().min(1).max(200))
            .max(100),
          gap_codes: z
            .array(z.string().trim().min(1).max(200))
            .max(100),
          observed_at: z.iso.datetime({ offset: true }),
        })
        .strict()
        .superRefine((value, context) => {
          if (
            value.evidence_ids.length === 0 &&
            value.error_codes.length === 0 &&
            value.gap_codes.length === 0
          ) {
            context.addIssue({
              code: "custom",
              path: ["evidence_ids"],
              message:
                "learning feedback requires evidence, a typed error, or a typed gap",
            });
          }
          for (const [field, entries] of [
            ["evidence_ids", value.evidence_ids],
            ["error_codes", value.error_codes],
            ["gap_codes", value.gap_codes],
          ] as const) {
            if (new Set(entries).size !== entries.length) {
              context.addIssue({
                code: "custom",
                path: [field],
                message: `${field} must be unique`,
              });
            }
          }
        }),
    })
    .strict()
    .superRefine((value, context) => {
      if (
        value.feedback.evidence_ids.length *
          value.envelope.scopes.length >
        100
      ) {
        context.addIssue({
          code: "custom",
          path: ["feedback", "evidence_ids"],
          message:
            "feedback exact-scope evidence checks are bounded to 100 pairs",
        });
      }
    }),
  "memory_feedback",
);

const LearningControlFrontierInputShape = {
  expected_control_epoch: z.number().int().nonnegative(),
  expected_release_revision: z.number().int().nonnegative().optional(),
  expected_frontier_hash: CanonicalHashSchema,
  runtime_identity_hash: CanonicalHashSchema,
  configuration_hash: CanonicalHashSchema,
  corpus_hash: CanonicalHashSchema,
};

function requireLearningMutationExecution<T extends z.ZodType>(
  schema: T,
): T {
  return schema.superRefine((value, context) => {
    if (
      typeof value !== "object" ||
      value === null ||
      !("envelope" in value) ||
      typeof value.envelope !== "object" ||
      value.envelope === null
    ) {
      return;
    }
    if (
      "expected_revision_id" in value.envelope &&
      value.envelope.expected_revision_id !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["envelope", "expected_revision_id"],
        message:
          "learning mutations use the exact learning frontier, not a memory revision",
      });
    }
    if ("dry_run" in value.envelope && value.envelope.dry_run !== false) {
      context.addIssue({
        code: "custom",
        path: ["envelope", "dry_run"],
        message: "learning control mutations require durable execution",
      });
    }
  }) as T;
}

export const LearningPauseInputSchema = withExpectedTool(
  requireLearningMutationExecution(
    z
      .object({
        envelope: MutationRequestEnvelopeSchema,
        ...LearningControlFrontierInputShape,
      })
      .strict(),
  ),
  "learning_pause",
);

export const LearningResumeInputSchema = withExpectedTool(
  requireLearningMutationExecution(
    z
      .object({
        envelope: MutationRequestEnvelopeSchema,
        ...LearningControlFrontierInputShape,
        abandon_in_flight: z.boolean(),
      })
      .strict(),
  ),
  "learning_resume",
);

export const LearningReleaseInputSchema = withExpectedTool(
  requireLearningMutationExecution(
    z
      .object({
        envelope: MutationRequestEnvelopeSchema,
        candidate_id: IdentifierSchema,
        release_slot_hash: CanonicalHashSchema,
        evaluation_receipt_id: IdentifierSchema,
        canary_receipt_id: IdentifierSchema,
        expected_pointer_revision: z.number().int().nonnegative(),
        expected_control_epoch: z.number().int().nonnegative(),
        base_configuration_hash: CanonicalHashSchema,
        monitor_contract_hash: CanonicalHashSchema,
        effect_manifest_hash: CanonicalHashSchema,
      })
      .strict(),
  ),
  "learning_release",
);

export const LearningRollbackInputSchema = withExpectedTool(
  requireLearningMutationExecution(
    z
      .object({
        envelope: MutationRequestEnvelopeSchema,
        release_id: IdentifierSchema,
        restore_release_id: IdentifierSchema.nullable(),
        monitor_receipt_id: IdentifierSchema,
        expected_pointer_revision: z.number().int().nonnegative(),
        expected_control_epoch: z.number().int().nonnegative(),
        base_configuration_hash: CanonicalHashSchema,
        effect_manifest_hash: CanonicalHashSchema,
      })
      .strict(),
  ),
  "learning_rollback",
);

export const MemoryCorrectionSchema = z
  .object({
    content: ContentRefSchema,
    content_hash: CanonicalHashSchema,
    evidence_ids: z.array(IdentifierSchema).min(1),
    validity: ValidityWindowSchema,
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict();

function requireExpectedRevision<T extends z.ZodType>(
  schema: T,
): T {
  return schema.superRefine((value, context) => {
    if (
      typeof value === "object" &&
      value !== null &&
      "envelope" in value &&
      typeof value.envelope === "object" &&
      value.envelope !== null &&
      "expected_revision_id" in value.envelope &&
      value.envelope.expected_revision_id === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["envelope", "expected_revision_id"],
        message: "this mutation requires the exact expected revision",
      });
    }
  }) as T;
}

export const MemoryCorrectInputSchema = withExpectedTool(
  requireExpectedRevision(
    z
      .object({
        envelope: MutationRequestEnvelopeSchema,
        memory_id: IdentifierSchema,
        replacement: MemoryCorrectionSchema,
      })
      .strict(),
  ),
  "memory_correct",
);

export const MemoryPinInputSchema = withExpectedTool(
  requireExpectedRevision(
    z
      .object({
        envelope: MutationRequestEnvelopeSchema,
        memory_id: IdentifierSchema,
        pinned: z.boolean(),
      })
      .strict(),
  ),
  "memory_pin",
);

export const MemoryDemoteInputSchema = withExpectedTool(
  requireExpectedRevision(
    z
      .object({
        envelope: MutationRequestEnvelopeSchema,
        memory_id: IdentifierSchema,
      })
      .strict(),
  ),
  "memory_demote",
);

export const MemoryUsageSetInputSchema = withExpectedTool(
  requireExpectedRevision(
    z
      .object({
        envelope: MutationRequestEnvelopeSchema,
        memory_id: IdentifierSchema,
        effect: z.enum(["allow", "block"]),
        context_scope: ScopeSchema.nullable(),
      })
      .strict()
      .superRefine((value, context) => {
        const contextScope = value.context_scope;
        if (
          contextScope !== null &&
          !value.envelope.scopes.some(
            (scope) => scopeKey(scope) === scopeKey(contextScope),
          )
        ) {
          context.addIssue({
            code: "custom",
            path: ["context_scope"],
            message:
              "a scoped usage rule must name an authorized envelope scope",
          });
        }
      }),
  ),
  "memory_usage_set",
);

export const MemoryRevokeInputSchema = withExpectedTool(
  requireExpectedRevision(
    z
      .object({
        envelope: MutationRequestEnvelopeSchema,
        memory_id: IdentifierSchema,
      })
      .strict(),
  ),
  "memory_revoke",
);

export const MemoryDeleteInputSchema = withExpectedTool(
  requireExpectedRevision(
    z
      .object({
        envelope: MutationRequestEnvelopeSchema,
        memory_id: IdentifierSchema,
      })
      .strict(),
  ),
  "memory_delete",
);

export const GovernedSearchItemSchema = z
  .object({
    abstraction: z.literal("l1_memory"),
    memory_id: IdentifierSchema,
    revision_id: IdentifierSchema,
    lifecycle: LifecycleSchema,
    kind: MemoryKindSchema,
    scope: ScopeSchema,
    authority: AuthoritySchema,
    sensitivity: SensitivitySchema,
    validity: ValidityWindowSchema,
    content: ContentRefSchema,
    content_hash: CanonicalHashSchema,
    evidence_ids: z.array(IdentifierSchema).min(1),
    transform: TransformRefSchema.nullable(),
    reason_codes: z.array(z.string().trim().min(1)).min(1),
  })
  .strict();

export type EpisodeBlobInput = z.infer<typeof EpisodeBlobInputSchema>;
export type MemoryContextCompileInput = z.infer<
  typeof MemoryContextCompileInputSchema
>;
export type MemoryEpisodeCommitInput = z.infer<
  typeof MemoryEpisodeCommitInputSchema
>;
export type LearningPauseInput = z.infer<typeof LearningPauseInputSchema>;
export type LearningReleaseInput = z.infer<typeof LearningReleaseInputSchema>;
export type LearningResumeInput = z.infer<typeof LearningResumeInputSchema>;
export type LearningRollbackInput = z.infer<
  typeof LearningRollbackInputSchema
>;
export type MemoryCorrectInput = z.infer<typeof MemoryCorrectInputSchema>;
export type MemoryDeleteInput = z.infer<typeof MemoryDeleteInputSchema>;
export type MemoryDemoteInput = z.infer<typeof MemoryDemoteInputSchema>;
export type MemoryEvidenceLookupInput = z.infer<
  typeof MemoryEvidenceLookupInputSchema
>;
export type MemoryExplainInput = z.infer<typeof MemoryExplainInputSchema>;
export type MemoryFeedbackInput = z.infer<typeof MemoryFeedbackInputSchema>;
export type MemoryGetInput = z.infer<typeof MemoryGetInputSchema>;
export type MemoryPinInput = z.infer<typeof MemoryPinInputSchema>;
export type MemoryProposeInput = z.infer<typeof MemoryProposeInputSchema>;
export type MemoryReceiptGetInput = z.infer<
  typeof MemoryReceiptGetInputSchema
>;
export type MemoryRevokeInput = z.infer<typeof MemoryRevokeInputSchema>;
export type MemorySearchInput = z.infer<typeof MemorySearchInputSchema>;
export type MemoryUsageSetInput = z.infer<
  typeof MemoryUsageSetInputSchema
>;
