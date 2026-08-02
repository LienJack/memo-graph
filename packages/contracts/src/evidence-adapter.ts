import { z } from "zod";

import {
  IdentifierSchema,
  ScopeSchema,
  UtcTimestampSchema,
} from "./common.js";
import { EpisodeSchema, EvidenceRecordSchema } from "./memory.js";
import {
  canonicalSha256,
  canonicalSha256Omitting,
} from "./canonical-json.js";

export const EvidenceIngestSensitivitySchema = z.enum([
  "public",
  "internal",
  "personal",
  "sensitive",
]);

const EvidenceIngestItemBaseSchema = z.object({
  occurred_at: UtcTimestampSchema,
  sensitivity: EvidenceIngestSensitivitySchema,
});

const EvidenceIngestTextSchema = z
  .string()
  .min(1)
  .max(64_000)
  .superRefine((value, context) => {
    if (new TextEncoder().encode(value).byteLength > 64_000) {
      context.addIssue({
        code: "custom",
        message: "evidence ingest item exceeds the UTF-8 byte limit",
      });
    }
  });

export const ConversationTurnIngestItemSchema =
  EvidenceIngestItemBaseSchema.extend({
    kind: z.literal("conversation_turn"),
    speaker: z.enum(["user", "assistant"]),
    text: EvidenceIngestTextSchema,
  }).strict();

export const ToolResultIngestItemSchema =
  EvidenceIngestItemBaseSchema.extend({
    kind: z.literal("tool_result"),
    tool_name: IdentifierSchema,
    text: EvidenceIngestTextSchema,
  }).strict();

export const TextFileIngestItemSchema =
  EvidenceIngestItemBaseSchema.extend({
    kind: z.literal("text_file"),
    source_name: z.string().trim().min(1).max(240),
    media_type: z.enum(["text/plain", "text/markdown"]),
    text: EvidenceIngestTextSchema,
  }).strict();

export const EvidenceIngestItemSchema = z.discriminatedUnion("kind", [
  ConversationTurnIngestItemSchema,
  ToolResultIngestItemSchema,
  TextFileIngestItemSchema,
]);

export const EvidenceIngestBatchSchema = z
  .object({
    scope: ScopeSchema,
    outcome: z.enum(["succeeded", "failed", "partial", "abandoned"]),
    items: z.array(EvidenceIngestItemSchema).min(1).max(32),
  })
  .strict()
  .superRefine((value, context) => {
    const totalBytes = value.items.reduce(
      (sum, item) => sum + new TextEncoder().encode(item.text).byteLength,
      0,
    );
    if (totalBytes > 256_000) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "evidence ingest batch exceeds the UTF-8 byte limit",
      });
    }
  });

export const EvidenceAdapterRequestSchema = z
  .object({
    idempotency_key: z.string().trim().min(8).max(200),
    principal_id: IdentifierSchema,
    recorded_at: UtcTimestampSchema,
    batch: EvidenceIngestBatchSchema,
  })
  .strict();

export const EvidenceAdaptationSchema = z
  .object({
    schema_version: z.literal("1.0.0"),
    mode: z.literal("fast_l0"),
    episode: EpisodeSchema,
    evidence: z.array(EvidenceRecordSchema).min(1).max(32),
    blobs: z.tuple([]),
    candidate_count: z.literal(0),
  })
  .strict()
  .superRefine((value, context) => {
    const occurredTimes = value.evidence.map((record) =>
      Date.parse(record.occurred_at),
    );
    if (
      value.episode.event_ids.length !== value.evidence.length ||
      value.evidence.some(
        (record, index) =>
          record.sequence !== index ||
          value.episode.event_ids[index] !== record.evidence_id ||
          record.scope.kind !== value.episode.scope.kind ||
          record.scope.id !== value.episode.scope.id ||
          record.actor.authority !== record.authority ||
          record.content_hash !== canonicalSha256(record.payload),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "adapted evidence must match the sealed episode order and scope",
      });
    }
    if (
      value.episode.started_at !==
        new Date(Math.min(...occurredTimes)).toISOString() ||
      value.episode.ended_at !==
        new Date(Math.max(...occurredTimes)).toISOString() ||
      value.episode.sealed_hash !==
        canonicalSha256Omitting(value.episode, ["sealed_hash"])
    ) {
      context.addIssue({
        code: "custom",
        path: ["episode"],
        message: "adapted episode time range or seal is invalid",
      });
    }
    for (const [index, record] of value.evidence.entries()) {
      const provenanceMatches =
        (record.source === "conversation_turn" &&
          ["user_stated", "observed"].includes(record.authority)) ||
        (record.source === "tool_result" &&
          record.authority === "tool_result") ||
        (record.source === "import" && record.authority === "imported");
      if (!provenanceMatches) {
        context.addIssue({
          code: "custom",
          path: ["evidence", index, "authority"],
          message: "adapted evidence provenance and authority do not match",
        });
      }
    }
  });

export type EvidenceAdaptation = z.infer<typeof EvidenceAdaptationSchema>;
export type EvidenceAdapterRequest = z.infer<
  typeof EvidenceAdapterRequestSchema
>;
export type EvidenceIngestBatch = z.infer<typeof EvidenceIngestBatchSchema>;
export type EvidenceIngestItem = z.infer<typeof EvidenceIngestItemSchema>;
