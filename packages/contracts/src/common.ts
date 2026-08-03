import { z } from "zod";

export const ContractVersionSchema = z
  .string()
  .regex(/^[1-9]\d*\.[0-9]+\.[0-9]+$/)
  .brand<"ContractVersion">();

export const IdentifierSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  .brand<"Identifier">();

export const UtcTimestampSchema = z.iso
  .datetime({ offset: true })
  .brand<"UtcTimestamp">();

export const CanonicalHashSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/)
  .brand<"CanonicalHash">();

export const EvidenceSourceSchema = z.enum([
  "conversation_turn",
  "tool_result",
  "artifact",
  "user_feedback",
  "evaluation",
  "import",
]);

export const NonEmptyReasonSchema = z.string().trim().min(1).max(2_000);

export const AbstractionLevelSchema = z.enum([
  "l0_evidence",
  "l1_memory",
  "l2_topic",
  "l2_scenario",
  "l2_relation",
  "l3_core",
]);

export const LifecycleSchema = z.enum([
  "working",
  "candidate",
  "active",
  "superseded",
  "revoked",
  "quarantined",
  "purged",
]);

export const MemoryKindSchema = z.enum([
  "episodic",
  "semantic",
  "procedural",
]);

export const ScopeKindSchema = z.enum([
  "thread",
  "topic",
  "scenario",
  "user",
  "workspace",
  "agent",
]);

export const AuthoritySchema = z.enum([
  "user_stated",
  "observed",
  "tool_result",
  "inferred",
  "derived",
  "imported",
]);

export const SensitivitySchema = z.enum([
  "public",
  "internal",
  "personal",
  "sensitive",
  "secret",
]);

export const ScopeSchema = z
  .object({
    kind: ScopeKindSchema,
    id: IdentifierSchema,
  })
  .strict();

export const ActorClaimSchema = z
  .object({
    principal_id: IdentifierSchema,
    authority: AuthoritySchema,
  })
  .strict();

export const ValidityWindowSchema = z
  .object({
    valid_from: UtcTimestampSchema,
    valid_to: UtcTimestampSchema.nullable(),
    recorded_at: UtcTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.valid_to !== null &&
      Date.parse(value.valid_to) < Date.parse(value.valid_from)
    ) {
      context.addIssue({
        code: "custom",
        path: ["valid_to"],
        message: "valid_to must not precede valid_from",
      });
    }
  });

export const TransformRefSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    version: ContractVersionSchema,
  })
  .strict();

export const InlineContentSchema = z
  .object({
    storage: z.literal("inline"),
    text: z.string().min(1).max(256_000),
    media_type: z.string().min(1).max(160).default("text/plain"),
  })
  .strict();

export const BlobContentSchema = z
  .object({
    storage: z.literal("blob"),
    content_hash: CanonicalHashSchema,
    size_bytes: z.number().int().nonnegative(),
    media_type: z.string().min(1).max(160),
  })
  .strict();

export const ContentRefSchema = z.discriminatedUnion("storage", [
  InlineContentSchema,
  BlobContentSchema,
]);

export function scopeKey(scope: z.infer<typeof ScopeSchema>): string {
  return `${scope.kind}:${scope.id}`;
}

export type AbstractionLevel = z.infer<typeof AbstractionLevelSchema>;
export type ActorClaim = z.infer<typeof ActorClaimSchema>;
export type Authority = z.infer<typeof AuthoritySchema>;
export type CanonicalHash = z.infer<typeof CanonicalHashSchema>;
export type ContentRef = z.infer<typeof ContentRefSchema>;
export type ContractVersion = z.infer<typeof ContractVersionSchema>;
export type Identifier = z.infer<typeof IdentifierSchema>;
export type Lifecycle = z.infer<typeof LifecycleSchema>;
export type MemoryKind = z.infer<typeof MemoryKindSchema>;
export type Scope = z.infer<typeof ScopeSchema>;
export type Sensitivity = z.infer<typeof SensitivitySchema>;
export type TransformRef = z.infer<typeof TransformRefSchema>;
export type UtcTimestamp = z.infer<typeof UtcTimestampSchema>;
export type ValidityWindow = z.infer<typeof ValidityWindowSchema>;
