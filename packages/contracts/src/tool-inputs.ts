import { z } from "zod";

import {
  ScopeSchema,
  scopeKey,
} from "./common.js";
import {
  ReadRequestEnvelopeSchema,
  ProposalRequestEnvelopeSchema,
  RecallRequestSchema,
} from "./mcp.js";
import {
  EpisodeSchema,
  EvidenceRecordSchema,
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

export const MemoryGetInputSchema = withExpectedTool(
  MemoryEvidenceLookupInputSchema,
  "memory_get",
);

export const MemoryExplainInputSchema = withExpectedTool(
  MemoryEvidenceLookupInputSchema,
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

export type EpisodeBlobInput = z.infer<typeof EpisodeBlobInputSchema>;
export type MemoryContextCompileInput = z.infer<
  typeof MemoryContextCompileInputSchema
>;
export type MemoryEpisodeCommitInput = z.infer<
  typeof MemoryEpisodeCommitInputSchema
>;
export type MemoryEvidenceLookupInput = z.infer<
  typeof MemoryEvidenceLookupInputSchema
>;
export type MemoryExplainInput = z.infer<typeof MemoryExplainInputSchema>;
export type MemoryGetInput = z.infer<typeof MemoryGetInputSchema>;
export type MemoryReceiptGetInput = z.infer<
  typeof MemoryReceiptGetInputSchema
>;
export type MemorySearchInput = z.infer<typeof MemorySearchInputSchema>;
