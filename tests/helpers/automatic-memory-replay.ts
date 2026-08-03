import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  AutomaticMemoryCategorySchema,
  AutomaticMemoryExclusionReasonSchema,
} from "../../packages/contracts/src/index.js";

const ReplayCaseSchema = z.object({
  id: z.string().min(1),
  locale: z.enum(["zh-CN", "en"]),
  utterance: z.string().min(1),
  category: AutomaticMemoryCategorySchema,
  recommended_scope: z.enum(["global_user", "repository"]),
  target_scope: z.enum(["user", "workspace"]),
  authority_basis: z.enum([
    "user_explicit",
    "user_confirmation",
    "user_correction",
    "assistant_context_only",
    "mixed",
  ]),
  temporariness: z.enum(["durable", "temporary", "uncertain"]),
  sensitivity: z.enum(["internal", "secret"]),
  exclusions: z.array(AutomaticMemoryExclusionReasonSchema),
  conflict: z.boolean(),
  injection_risk: z.enum(["none", "suspected", "confirmed"]),
  global_change: z.boolean(),
  expected: z.enum(["activate", "review_required", "reject"]),
}).strict();

const CorpusSchema = z.object({
  schema_version: z.literal("1.0.0"),
  corpus_id: z.literal("automatic-memory-v1"),
  cases: z.array(ReplayCaseSchema).min(12),
}).strict();

export type AutomaticMemoryReplayCase = z.infer<typeof ReplayCaseSchema>;

export function loadAutomaticMemoryReplayCorpus() {
  const path = fileURLToPath(
    new URL("../fixtures/automatic-memory-v1.json", import.meta.url),
  );
  return CorpusSchema.parse(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

export function percentile95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
}
