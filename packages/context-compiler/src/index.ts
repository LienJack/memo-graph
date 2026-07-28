import { createHash } from "node:crypto";

import {
  ContextSliceItemSchema,
  ContextSliceSchema,
  EvidenceRecordSchema,
  GovernedSearchItemSchema,
  RecallRequestSchema,
  RetrievalReceiptSchema,
  canonicalJson,
  canonicalSha256,
  canonicalSha256Omitting,
  sealReceipt,
  scopeKey,
} from "@memo-graph/contracts";
import { z } from "zod";

export const CONTEXT_COMPILER_VERSION = "1.0.0";
export const CONTEXT_POLICY_VERSION = "1.0.0";

const L0ContextCandidateSchema = z
  .object({
    abstraction: z.literal("l0_evidence").default("l0_evidence"),
    evidence: EvidenceRecordSchema,
    rank: z.number().finite(),
    lane: z.string().trim().min(1).max(120),
  })
  .strict();

const L1ContextCandidateSchema = z
  .object({
    abstraction: z.literal("l1_memory"),
    memory: GovernedSearchItemSchema.extend({
      abstraction: z.literal("l1_memory"),
    }),
    rank: z.number().finite(),
    lane: z.string().trim().min(1).max(120),
  })
  .strict();

export const ContextCandidateSchema = z.union([
  L0ContextCandidateSchema,
  L1ContextCandidateSchema,
]);

export const ContextExclusionSchema = z
  .object({
    memory_id: z.string().trim().min(1),
    revision_id: z.string().trim().min(1),
    reason_code: z.string().trim().min(1),
    lane: z.string().trim().min(1).max(120),
    score: z.number().finite().nullable(),
  })
  .strict();

export const CompileContextInputSchema = z
  .object({
    request: RecallRequestSchema,
    candidates: z.array(ContextCandidateSchema),
    exclusions: z.array(ContextExclusionSchema).default([]),
    created_at: z.iso.datetime({ offset: true }),
    degraded_lanes: z.array(z.string().trim().min(1).max(120)).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    const allowedScopes = new Set(value.request.scopes.map(scopeKey));
    value.candidates.forEach((candidate, index) => {
      const scope =
        candidate.abstraction === "l0_evidence"
          ? candidate.evidence.scope
          : candidate.memory.scope;
      if (!allowedScopes.has(scopeKey(scope))) {
        context.addIssue({
          code: "custom",
          path: [
            "candidates",
            index,
            candidate.abstraction === "l0_evidence" ? "evidence" : "memory",
            "scope",
          ],
          message: "candidate scope is outside the recall request",
        });
      }
    });
  });

export const CompileContextResultSchema = z
  .object({
    status: z.enum(["OK", "NO_MATCH", "POLICY_EXCLUDED", "DEGRADED"]),
    context_slice: ContextSliceSchema.nullable(),
    receipt: RetrievalReceiptSchema,
    excluded_count: z.number().int().nonnegative(),
    reason_codes: z.array(z.string().trim().min(1)),
    warnings: z.array(z.string().trim().min(1)),
  })
  .strict();

export type CompileContextInput = z.input<typeof CompileContextInputSchema>;
export type CompileContextResult = z.infer<typeof CompileContextResultSchema>;
export type ContextCandidate = z.infer<typeof ContextCandidateSchema>;
export type ContextExclusion = z.infer<typeof ContextExclusionSchema>;

type ClassifiedCandidate = {
  candidate: ContextCandidate;
  memoryId: string;
  revisionId: string;
  item: z.infer<typeof ContextSliceItemSchema> | null;
  exclusion: string | null;
};

function stableIdentifier(prefix: string, value: unknown): string {
  const digest = createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
  return `${prefix}:${digest.slice(0, 48)}`;
}

export function l0MemoryIdentity(evidence: {
  evidence_id: string;
  content_hash: string;
}): { memory_id: string; revision_id: string } {
  return {
    memory_id: stableIdentifier("l0m", evidence.evidence_id),
    revision_id: stableIdentifier("l0r", {
      evidence_id: evidence.evidence_id,
      content_hash: evidence.content_hash,
    }),
  };
}

export function estimateContextTokens(text: string): number {
  let asciiBytes = 0;
  let nonAsciiCodePoints = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && codePoint <= 0x7f) {
      asciiBytes += Buffer.byteLength(character, "utf8");
    } else {
      nonAsciiCodePoints += 1;
    }
  }
  return Math.ceil(asciiBytes / 4) + nonAsciiCodePoints * 2;
}

function candidateOrder(
  left: ContextCandidate,
  right: ContextCandidate,
): number {
  const leftTimestamp =
    left.abstraction === "l0_evidence"
      ? left.evidence.occurred_at
      : left.memory.validity.recorded_at;
  const rightTimestamp =
    right.abstraction === "l0_evidence"
      ? right.evidence.occurred_at
      : right.memory.validity.recorded_at;
  const leftId =
    left.abstraction === "l0_evidence"
      ? left.evidence.evidence_id
      : left.memory.revision_id;
  const rightId =
    right.abstraction === "l0_evidence"
      ? right.evidence.evidence_id
      : right.memory.revision_id;
  return (
    left.rank - right.rank ||
    rightTimestamp.localeCompare(leftTimestamp) ||
    leftId.localeCompare(rightId)
  );
}

function itemTokenEstimate(
  item: Omit<z.input<typeof ContextSliceItemSchema>, "token_estimate">,
): number {
  const provenance = [
    `memory=${item.memory_id}`,
    `revision=${item.revision_id}`,
    `scope=${item.scope.kind}:${item.scope.id}`,
    `authority=${item.authority}`,
    `sensitivity=${item.sensitivity}`,
    `evidence=${item.evidence_ids.join(",")}`,
    `selection=${item.selection_reason}`,
    `uncertainty=${item.uncertainty ?? "none"}`,
  ].join("\n");
  const content =
    item.content.storage === "inline"
      ? item.content.text
      : canonicalJson(item.content);
  return estimateContextTokens(`${provenance}\ncontent=${content}`);
}

function classifyCandidate(
  candidate: ContextCandidate,
  request: z.output<typeof RecallRequestSchema>,
): ClassifiedCandidate {
  if (candidate.abstraction === "l1_memory") {
    const memory = candidate.memory;
    let exclusion: string | null = null;
    if (memory.lifecycle !== "active") {
      exclusion =
        {
          working: "CANDIDATE_ONLY",
          candidate: "CANDIDATE_ONLY",
          superseded: "SUPERSEDED",
          revoked: "REVOKED",
          quarantined: "QUARANTINED",
          purged: "TOMBSTONED",
        }[memory.lifecycle] ?? "POLICY_EXCLUDED";
    } else if (Date.parse(memory.validity.valid_from) > Date.parse(request.as_of)) {
      exclusion = "NOT_YET_VALID";
    } else if (
      memory.validity.valid_to !== null &&
      Date.parse(memory.validity.valid_to) < Date.parse(request.as_of)
    ) {
      exclusion = "EXPIRED";
    } else if (
      memory.sensitivity === "sensitive" &&
      !request.include_sensitive
    ) {
      exclusion = "SENSITIVE_EXCLUDED";
    } else if (memory.sensitivity === "secret") {
      exclusion = "SECRET_EXCLUDED";
    } else if (memory.content.storage !== "inline") {
      exclusion = "CONTENT_NOT_INLINE";
    }
    if (exclusion !== null) {
      return {
        candidate,
        memoryId: memory.memory_id,
        revisionId: memory.revision_id,
        item: null,
        exclusion,
      };
    }
    const itemWithoutEstimate = {
      memory_id: memory.memory_id,
      revision_id: memory.revision_id,
      abstraction: memory.abstraction,
      lifecycle: memory.lifecycle,
      authority: memory.authority,
      sensitivity: memory.sensitivity,
      scope: memory.scope,
      content: memory.content,
      evidence_ids: memory.evidence_ids,
      selection_reason: memory.reason_codes.join(","),
      uncertainty: null,
    } satisfies Omit<
      z.input<typeof ContextSliceItemSchema>,
      "token_estimate"
    >;
    return {
      candidate,
      memoryId: memory.memory_id,
      revisionId: memory.revision_id,
      item: ContextSliceItemSchema.parse({
        ...itemWithoutEstimate,
        token_estimate: itemTokenEstimate(itemWithoutEstimate),
      }),
      exclusion: null,
    };
  }
  const identity = l0MemoryIdentity(candidate.evidence);
  const memoryId = identity.memory_id;
  const revisionId = identity.revision_id;
  let exclusion: string | null = null;
  if (Date.parse(candidate.evidence.occurred_at) > Date.parse(request.as_of)) {
    exclusion = "AFTER_AS_OF";
  } else if (
    candidate.evidence.sensitivity === "sensitive" &&
    !request.include_sensitive
  ) {
    exclusion = "SENSITIVE_EXCLUDED";
  } else if (candidate.evidence.sensitivity === "secret") {
    exclusion = "SECRET_EXCLUDED";
  } else if (candidate.evidence.payload.storage !== "inline") {
    exclusion = "CONTENT_NOT_INLINE";
  }

  if (exclusion !== null) {
    return { candidate, memoryId, revisionId, item: null, exclusion };
  }

  const itemWithoutEstimate = {
    memory_id: memoryId,
    revision_id: revisionId,
    abstraction: "l0_evidence",
    lifecycle: "active",
    authority: candidate.evidence.authority,
    sensitivity: candidate.evidence.sensitivity,
    scope: candidate.evidence.scope,
    content: candidate.evidence.payload,
    evidence_ids: [candidate.evidence.evidence_id],
    selection_reason: `ranked ${candidate.lane} evidence`,
    uncertainty: "raw evidence has not been admitted as L1 memory",
  } satisfies Omit<
    z.input<typeof ContextSliceItemSchema>,
    "token_estimate"
  >;
  return {
    candidate,
    memoryId,
    revisionId,
    item: ContextSliceItemSchema.parse({
      ...itemWithoutEstimate,
      token_estimate: itemTokenEstimate(itemWithoutEstimate),
    }),
    exclusion: null,
  };
}

export function compileContext(input: unknown): CompileContextResult {
  const parsed = CompileContextInputSchema.parse(input);
  const ordered = [...parsed.candidates].sort(candidateOrder);
  const seenCandidates = new Set<string>();
  const identityUnique = ordered.filter((candidate) => {
    const key =
      candidate.abstraction === "l0_evidence"
        ? `evidence:${candidate.evidence.evidence_id}`
        : `memory:${candidate.memory.memory_id}:${candidate.memory.revision_id}`;
    if (seenCandidates.has(key)) {
      return false;
    }
    seenCandidates.add(key);
    return true;
  });
  const governedEvidenceIds = new Set(
    identityUnique.flatMap((candidate) =>
      candidate.abstraction === "l1_memory"
        ? candidate.memory.evidence_ids
        : [],
    ),
  );
  const unique = identityUnique.filter(
    (candidate) =>
      candidate.abstraction === "l1_memory" ||
      !governedEvidenceIds.has(candidate.evidence.evidence_id),
  );
  const classified = unique.map((candidate) =>
    classifyCandidate(candidate, parsed.request),
  );
  const included: ClassifiedCandidate[] = [];
  const exclusions = new Map<string, string>();
  let tokenUsed = 0;

  for (const candidate of classified) {
    if (candidate.item === null) {
      exclusions.set(
        `${candidate.memoryId}:${candidate.revisionId}`,
        candidate.exclusion ?? "POLICY_EXCLUDED",
      );
      continue;
    }
    if (
      tokenUsed + candidate.item.token_estimate >
      parsed.request.token_budget
    ) {
      exclusions.set(
        `${candidate.memoryId}:${candidate.revisionId}`,
        "BUDGET_EXCEEDED",
      );
      continue;
    }
    included.push(candidate);
    tokenUsed += candidate.item.token_estimate;
  }

  const contextSlice =
    included.length === 0
      ? null
      : ContextSliceSchema.parse({
          schema_version: "1.0.0",
          context_slice_id: stableIdentifier("context", {
            request_id: parsed.request.request_id,
            item_ids: included.map(
              (candidate) =>
                `${candidate.memoryId}:${candidate.revisionId}`,
            ),
          }),
          request_id: parsed.request.request_id,
          compiler_version: CONTEXT_COMPILER_VERSION,
          created_at: parsed.created_at,
          token_budget: parsed.request.token_budget,
          token_used: tokenUsed,
          items: included.map((candidate) => candidate.item),
          frozen_hash: `sha256:${"0".repeat(64)}`,
        });
  const sealedContextSlice =
    contextSlice === null
      ? null
      : ContextSliceSchema.parse({
          ...contextSlice,
          frozen_hash: canonicalSha256Omitting(contextSlice, [
            "frozen_hash",
          ]),
        });

  const degradedLanes = [...new Set(parsed.degraded_lanes)].sort();
  const status =
    degradedLanes.length > 0
      ? "DEGRADED"
      : included.length > 0
        ? "OK"
        : classified.length === 0 && parsed.exclusions.length === 0
          ? "NO_MATCH"
          : "POLICY_EXCLUDED";
  const receiptItems: Array<{
    memory_id: string;
    revision_id: string;
    decision: "included" | "excluded";
    reason_codes: string[];
    lane: string;
    score: number | null;
  }> = classified.map((candidate) => {
    const reason = exclusions.get(
      `${candidate.memoryId}:${candidate.revisionId}`,
    );
    return {
      memory_id: candidate.memoryId,
      revision_id: candidate.revisionId,
      decision: reason === undefined ? "included" : "excluded",
      reason_codes:
        reason === undefined
          ? candidate.candidate.abstraction === "l1_memory"
            ? candidate.candidate.memory.reason_codes
            : ["RANKED_EVIDENCE"]
          : [reason],
      lane: candidate.candidate.lane,
      score: candidate.candidate.rank,
    };
  });
  for (const exclusion of parsed.exclusions) {
    exclusions.set(
      `${exclusion.memory_id}:${exclusion.revision_id}`,
      exclusion.reason_code,
    );
    receiptItems.push({
      memory_id: exclusion.memory_id,
      revision_id: exclusion.revision_id,
      decision: "excluded",
      reason_codes: [exclusion.reason_code],
      lane: exclusion.lane,
      score: exclusion.score,
    });
  }
  const receipt = RetrievalReceiptSchema.parse(
    sealReceipt({
      schema_version: "1.0.0",
      receipt_id: stableIdentifier("retrieval", {
        request_id: parsed.request.request_id,
        context_slice_id: sealedContextSlice?.context_slice_id ?? null,
        status,
        items: receiptItems,
      }),
      created_at: parsed.created_at,
      state: degradedLanes.length > 0 ? "partial" : "durable",
      request_hash: canonicalSha256(parsed.request),
      receipt_hash: `sha256:${"0".repeat(64)}`,
      kind: "retrieval",
      context_slice_id: sealedContextSlice?.context_slice_id ?? null,
      compiler_version: CONTEXT_COMPILER_VERSION,
      policy_version: CONTEXT_POLICY_VERSION,
      items: receiptItems,
    }),
  );
  return CompileContextResultSchema.parse({
    status,
    context_slice: sealedContextSlice,
    receipt,
    excluded_count: exclusions.size,
    reason_codes: [...new Set(exclusions.values())].sort(),
    warnings: degradedLanes.map((lane) => `lane unavailable: ${lane}`),
  });
}
