import { createHash } from "node:crypto";

import {
  ContextConflictSetSchema,
  ContextFrontierSchema,
  ContextSliceItemSchema,
  ContextSliceSchema,
  EffectiveLaneConfigurationSchema,
  EvidenceRecordSchema,
  GovernedSearchItemSchema,
  GraphPathEvidenceSchema,
  LaneTelemetrySchema,
  ProjectionRevisionSchema,
  RecallLaneSchema,
  RecallRequestSchema,
  RetrievalReceiptSchema,
  VectorSelectionEvidenceSchema,
  applicableRecallLanes,
  canonicalJson,
  canonicalSha256,
  canonicalSha256Omitting,
  sealReceipt,
  scopeKey,
} from "@memo-graph/contracts";
import { z } from "zod";

import {
  resolveConflictsAndDedupe,
} from "./conflict-resolver.js";
import {
  hardFilterLayeredCandidates,
  type LayeredCandidateExclusion,
  type LayeredCompilerCandidate,
} from "./hard-filters.js";
import {
  rankLayeredCandidates,
} from "./ranking-policy.js";
import {
  buildLayeredArtifacts,
  type LayeredDecision,
} from "./receipt-builder.js";
import {
  estimateContextTokens,
  estimateStructuredTokens,
  packContextItems,
} from "./token-packer.js";

export const CONTEXT_COMPILER_VERSION = "1.0.0";
export const CONTEXT_POLICY_VERSION = "1.0.0";
export const LAYERED_CONTEXT_COMPILER_VERSION = "3.0.0";
export const LAYERED_CONTEXT_POLICY_VERSION = "2.0.0";
export {
  estimateContextTokens,
  estimateStructuredTokens,
  packContextItems,
  type PackableContextItem,
  type PackedContextDecision,
} from "./token-packer.js";

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

const LayeredMemoryCompilerCandidateSchema = z
  .object({
    kind: z.literal("memory"),
    abstraction: z.literal("l1_memory"),
    lane: z.enum(["recent_l1", "semantic_vector"]),
    scope: z.lazy(() => ContextSliceItemSchema.shape.scope),
    rank: z.number().finite(),
    canonical_revalidated: z.boolean(),
    memory: GovernedSearchItemSchema,
    vector: VectorSelectionEvidenceSchema.optional(),
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
          "semantic_vector compiler candidates require vector selection evidence",
      });
    }
  });

const LayeredProjectionCompilerCandidateSchema = z
  .object({
    kind: z.literal("projection"),
    abstraction: z.enum([
      "l2_topic",
      "l2_scenario",
      "l2_relation",
      "l3_core",
    ]),
    lane: z.enum([
      "topic",
      "scenario_procedure",
      "core",
      "relation_sqlite",
      "relation_graph",
    ]),
    scope: z.lazy(() => ContextSliceItemSchema.shape.scope),
    rank: z.number().finite(),
    canonical_revalidated: z.boolean(),
    projection: ProjectionRevisionSchema,
    graph_path: GraphPathEvidenceSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.lane === "relation_graph") !==
      (value.graph_path !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["graph_path"],
        message:
          "relation_graph compiler candidates require graph path evidence",
      });
    }
  });

export const LayeredCompilerCandidateSchema = z.discriminatedUnion(
  "kind",
  [
    LayeredMemoryCompilerCandidateSchema,
    LayeredProjectionCompilerCandidateSchema,
  ],
);

export const LayeredCompilerExclusionSchema = z
  .object({
    memory_id: z.string().trim().min(1),
    revision_id: z.string().trim().min(1),
    lane: RecallLaneSchema,
    reason_code: z.string().trim().min(1).max(200),
    score: z.number().finite().nullable(),
    graph_path: GraphPathEvidenceSchema.optional(),
    vector: VectorSelectionEvidenceSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.lane === "relation_graph") !==
      (value.graph_path !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["graph_path"],
        message:
          "relation_graph compiler exclusions require graph path evidence",
      });
    }
    if (
      (value.lane === "semantic_vector") !==
      (value.vector !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["vector"],
        message:
          "semantic_vector compiler exclusions require vector selection evidence",
      });
    }
  });

export const CompileLayeredContextInputSchema = z
  .object({
    request: RecallRequestSchema,
    candidates: z.array(LayeredCompilerCandidateSchema),
    exclusions: z.array(LayeredCompilerExclusionSchema).default([]),
    frontier: ContextFrontierSchema,
    effective_configuration: EffectiveLaneConfigurationSchema,
    telemetry: z.array(LaneTelemetrySchema),
    conflict_sets: z.array(ContextConflictSetSchema).default([]),
    created_at: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, context) => {
    const scopes = new Set(value.request.scopes.map(scopeKey));
    const enabled = new Set(
      value.effective_configuration.enabled_lanes,
    );
    for (const [index, candidate] of value.candidates.entries()) {
      if (!scopes.has(scopeKey(candidate.scope))) {
        context.addIssue({
          code: "custom",
          path: ["candidates", index, "scope"],
          message: "layered candidate scope is outside the recall request",
        });
      }
      if (!enabled.has(candidate.lane)) {
        context.addIssue({
          code: "custom",
          path: ["candidates", index, "lane"],
          message: "a disabled lane cannot inject compiler candidates",
        });
      }
    }
    const telemetryLanes = value.telemetry.map((item) => item.lane);
    const expectedTelemetryLanes = applicableRecallLanes([
      ...value.effective_configuration.requested_lanes,
      ...value.effective_configuration.enabled_lanes,
      ...(value.request.lane_overrides?.requested_lanes ?? []),
    ]);
    if (
      telemetryLanes.length !== expectedTelemetryLanes.length ||
      new Set(telemetryLanes).size !== telemetryLanes.length ||
      expectedTelemetryLanes.some(
        (lane) => !telemetryLanes.includes(lane),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["telemetry"],
        message:
          "layered compile telemetry must cover every applicable lane once",
      });
    }
  });

export type CompileLayeredContextInput = z.input<
  typeof CompileLayeredContextInputSchema
>;

function exclusionDecision(
  exclusion: LayeredCandidateExclusion | z.infer<
    typeof LayeredCompilerExclusionSchema
  >,
): LayeredDecision {
  return {
    memory_id: exclusion.memory_id,
    revision_id: exclusion.revision_id,
    lane: exclusion.lane,
    included: false,
    reason_codes: [exclusion.reason_code],
    score: exclusion.score,
    ...(exclusion.graph_path === undefined
      ? {}
      : { graph_path: exclusion.graph_path }),
    ...(exclusion.vector === undefined
      ? {}
      : { vector: exclusion.vector }),
  };
}

export function compileLayeredContext(
  input: unknown,
): CompileContextResult {
  const parsed = CompileLayeredContextInputSchema.parse(input);
  const request = RecallRequestSchema.parse({
    ...parsed.request,
    scopes: [...parsed.request.scopes].sort((left, right) =>
      scopeKey(left).localeCompare(scopeKey(right))
    ),
  });
  const filtered = hardFilterLayeredCandidates({
    candidates: parsed.candidates as LayeredCompilerCandidate[],
    allowed_scopes: request.scopes,
    as_of: request.as_of,
    include_sensitive: request.include_sensitive,
    frontier: parsed.frontier,
  });
  const resolved = resolveConflictsAndDedupe({
    candidates: filtered.eligible,
    conflict_sets: parsed.conflict_sets,
  });
  const ranked = rankLayeredCandidates({
    candidates: resolved.candidates,
    query: request.query,
    as_of: request.as_of,
  });
  const itemByRevision = new Map(
    ranked.map((rankedCandidate) => {
      const candidate = rankedCandidate.candidate;
      const itemWithoutEstimate = {
        memory_id: candidate.memory_id,
        revision_id: candidate.revision_id,
        abstraction: candidate.abstraction,
        lifecycle: candidate.lifecycle,
        authority: candidate.authority,
        sensitivity: candidate.sensitivity,
        scope: candidate.scope,
        content: candidate.content,
        evidence_ids: candidate.evidence_ids,
        selection_reason:
          `ranked ${candidate.lane} after canonical revalidation`,
        uncertainty:
          candidate.conflict_group_id === null
            ? null
            : "Competing claims are retained without synthetic merge.",
        lane: candidate.lane,
        score_components: rankedCandidate.score_components,
        conflict_group_id: candidate.conflict_group_id,
        decision_reason_codes: candidate.decision_reason_codes,
        ...(candidate.projection === null
          ? {}
          : { projection: candidate.projection }),
        ...(candidate.graph_path === null
          ? {}
          : { graph_path: candidate.graph_path }),
        ...(candidate.vector === null
          ? {}
          : { vector: candidate.vector }),
      };
      return [
        candidate.revision_id,
        ContextSliceItemSchema.parse({
          ...itemWithoutEstimate,
          token_estimate: estimateStructuredTokens(itemWithoutEstimate),
        }),
      ] as const;
    }),
  );
  const packed = packContextItems(
    ranked.map((rankedCandidate) => {
      const item = itemByRevision.get(
        rankedCandidate.candidate.revision_id,
      );
      if (item === undefined) {
        throw new Error("ranked candidate is missing its Context item");
      }
      return {
        key: rankedCandidate.candidate.revision_id,
        lane: rankedCandidate.candidate.lane,
        constraint_priority: rankedCandidate.constraint_priority,
        total_score: rankedCandidate.total_score,
        item,
      };
    }),
    request.token_budget,
  );
  const rankedByRevision = new Map(
    ranked.map((candidate) => [
      candidate.candidate.revision_id,
      candidate,
    ]),
  );
  const decisions: LayeredDecision[] = packed.decisions.map((decision) => {
    const rankedCandidate = rankedByRevision.get(decision.candidate.key);
    if (rankedCandidate === undefined) {
      throw new Error("packed candidate is missing its ranking evidence");
    }
    const candidate = rankedCandidate.candidate;
    return {
      memory_id: candidate.memory_id,
      revision_id: candidate.revision_id,
      lane: candidate.lane,
      included: decision.included,
      reason_codes:
        decision.included
          ? ["INCLUDED", ...candidate.decision_reason_codes]
          : [decision.reason_code],
      score: rankedCandidate.total_score,
      score_components: rankedCandidate.score_components,
      token_estimate: decision.candidate.item.token_estimate,
      ...(candidate.projection === null
        ? {}
        : { projection: candidate.projection }),
      ...(candidate.graph_path === null
        ? {}
        : { graph_path: candidate.graph_path }),
      ...(candidate.vector === null
        ? {}
        : { vector: candidate.vector }),
      conflict_group_id: candidate.conflict_group_id,
      item: decision.candidate.item,
    };
  });
  decisions.push(
    ...filtered.exclusions.map(exclusionDecision),
    ...resolved.exclusions.map(exclusionDecision),
    ...parsed.exclusions.map(exclusionDecision),
  );
  const orderedDecisions = decisions.sort(
    (left, right) =>
      Number(right.included) - Number(left.included) ||
      RecallLaneSchema.options.indexOf(
        left.lane as z.infer<typeof RecallLaneSchema>,
      ) -
        RecallLaneSchema.options.indexOf(
          right.lane as z.infer<typeof RecallLaneSchema>,
        ) ||
      left.revision_id.localeCompare(right.revision_id),
  );
  const degradedLanes = parsed.telemetry
    .filter((item) =>
      item.status === "unavailable" || item.status === "degraded"
    )
    .map((item) => item.lane)
    .sort();
  const artifacts = buildLayeredArtifacts({
    request,
    created_at: parsed.created_at,
    compiler_version: LAYERED_CONTEXT_COMPILER_VERSION,
    policy_version: LAYERED_CONTEXT_POLICY_VERSION,
    frontier: parsed.frontier,
    effective_configuration: parsed.effective_configuration,
    telemetry: parsed.telemetry,
    conflict_sets: resolved.conflict_sets,
    decisions: orderedDecisions,
    degraded: degradedLanes.length > 0,
  });
  const excluded = orderedDecisions.filter(
    (decision) => !decision.included,
  );
  const status =
    degradedLanes.length > 0
      ? "DEGRADED"
      : packed.included.length > 0
        ? "OK"
        : excluded.length > 0
          ? "POLICY_EXCLUDED"
          : "NO_MATCH";
  return CompileContextResultSchema.parse({
    status,
    context_slice: artifacts.context_slice,
    receipt: artifacts.receipt,
    excluded_count: excluded.length,
    reason_codes: [
      ...new Set(excluded.flatMap((decision) => decision.reason_codes)),
    ].sort(),
    warnings: degradedLanes.map((lane) =>
      `lane unavailable or degraded: ${lane}`
    ),
  });
}
