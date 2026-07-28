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
    .strict(),
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
    }),
  "memory_propose",
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
export type MemoryCorrectInput = z.infer<typeof MemoryCorrectInputSchema>;
export type MemoryDeleteInput = z.infer<typeof MemoryDeleteInputSchema>;
export type MemoryDemoteInput = z.infer<typeof MemoryDemoteInputSchema>;
export type MemoryEvidenceLookupInput = z.infer<
  typeof MemoryEvidenceLookupInputSchema
>;
export type MemoryExplainInput = z.infer<typeof MemoryExplainInputSchema>;
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
