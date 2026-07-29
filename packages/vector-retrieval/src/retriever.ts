import { performance } from "node:perf_hooks";

import {
  GovernedSearchItemSchema,
  IdentifierSchema,
  ScopeSchema,
  VectorEmbeddingEpochSchema,
  VectorQueryResultSchema,
  VectorScopeCheckpointSchema,
  VectorSelectionEvidenceSchema,
  canonicalJson,
  canonicalSha256,
  scopeKey,
  type BoundedWorkTelemetry,
  type Scope,
  type VectorEmbeddingEpoch,
  type VectorFailureCategory,
  type VectorQueryResult,
} from "@memo-graph/contracts";
import { z } from "zod";

import {
  VectorProcessHost,
  VectorRuntimeError,
} from "./process-host.js";
import { activeVectorGenerationRoot } from "./projector.js";

const ExactSourceResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      revision_id: IdentifierSchema,
      status: z.literal("eligible"),
      source: z
        .object({
          memory_id: IdentifierSchema,
          revision_id: IdentifierSchema,
          principal_id: IdentifierSchema,
          scope: ScopeSchema,
          sensitivity: z.enum([
            "public",
            "internal",
            "personal",
            "sensitive",
            "secret",
          ]),
          content_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
        })
        .passthrough(),
    })
    .strict(),
  z
    .object({
      revision_id: IdentifierSchema,
      status: z.literal("ineligible"),
      reason_code: z.string().trim().min(1).max(200),
    })
    .strict(),
]);

const ExactSourceBatchSchema = z
  .object({
    ledger_epoch: z.number().int().nonnegative(),
    tombstone_epoch: z.number().int().nonnegative(),
    results: z.array(ExactSourceResultSchema).max(100),
  })
  .passthrough();

const EligibilitySchema = z.discriminatedUnion("eligible", [
  z
    .object({
      eligible: z.literal(true),
      item: GovernedSearchItemSchema,
    })
    .strict(),
  z
    .object({
      eligible: z.literal(false),
      memory_id: IdentifierSchema,
      revision_id: IdentifierSchema,
      reason_code: z.string().trim().min(1).max(200),
    })
    .strict(),
]);

export type SemanticVectorStorage = {
  vectorProjectionStatus(): Promise<{
    mode: "disabled" | "evaluating" | "enabled";
    epoch_id: string | null;
  }>;
  vectorProjectionCheckpoint(input: {
    principal_id: string;
    scope: Scope;
  }): Promise<unknown>;
  validateProjectionSources(input: {
    principal_id: string;
    scope: Scope;
    as_of: string;
    include_sensitive: false;
    context_scope: Scope;
    revision_ids: string[];
  }): Promise<unknown>;
  checkMemoryEligibility(input: {
    memory_id: string;
    revision_id: string;
    principal_id: string;
    scope: Scope;
    as_of: string;
    include_sensitive: false;
    context_scope: Scope;
  }): Promise<unknown>;
};

export type SemanticVectorRuntime = {
  query(input: unknown): Promise<VectorQueryResult>;
  close(): Promise<void>;
};

export type SemanticVectorRuntimeFactory = {
  open(input: {
    dataRoot: string;
    modelRoot: string;
    principalId: string;
    scope: Scope;
    expectedEpoch: VectorEmbeddingEpoch;
  }): Promise<SemanticVectorRuntime>;
};

export type SemanticVectorRequest = {
  lane: "semantic_vector";
  principal_id: string;
  scope: Scope;
  query: string;
  as_of: string;
  include_sensitive: boolean;
  limit: number;
  vector_top_k: number;
  vector_query_timeout_ms: number;
  vector_max_response_bytes: number;
};

export type SemanticVectorLaneResult = {
  candidates: Array<{
    kind: "memory";
    lane: "semantic_vector";
    memory: z.infer<typeof GovernedSearchItemSchema>;
    rank: number;
    vector: z.infer<typeof VectorSelectionEvidenceSchema>;
  }>;
  exclusions: Array<{
    memory_id: string;
    revision_id: string;
    lane: "semantic_vector";
    reason_code: string;
    score: number | null;
    vector: z.infer<typeof VectorSelectionEvidenceSchema>;
  }>;
  projection_frontier: null;
  truncated: boolean;
  reason_codes: string[];
  bounded_work: BoundedWorkTelemetry[];
  duration_ms: number;
  query_hashes: string[];
};

const defaultRuntimeFactory: SemanticVectorRuntimeFactory = {
  open: (input) => VectorProcessHost.open(input),
};

function unavailable(
  request: SemanticVectorRequest,
  startedAt: number,
  reasonCode: string,
): SemanticVectorLaneResult {
  return {
    candidates: [],
    exclusions: [],
    projection_frontier: null,
    truncated: true,
    reason_codes: [reasonCode],
    bounded_work: [
      {
        boundary: "vector_candidates",
        configured_limit: request.vector_top_k,
        observed_count: 0,
        retained_count: 0,
        truncated_count: 0,
        complete: false,
        reason_code: reasonCode,
      },
    ],
    duration_ms: performance.now() - startedAt,
    query_hashes: [
      canonicalSha256({
        lane: request.lane,
        query: request.query.normalize("NFKC"),
      }),
    ],
  };
}

function failureReason(category: VectorFailureCategory): string {
  return `VECTOR_${category}`;
}

function opaqueRejectedHit(
  generationId: string,
  rank: number,
): {
  memory_id: string;
  revision_id: string;
} {
  const suffix = canonicalSha256({
    generation_id: generationId,
    rank,
  }).slice("sha256:".length, 40);
  return {
    memory_id: `vector-rejected-memory:${suffix}`,
    revision_id: `vector-rejected-revision:${suffix}`,
  };
}

export class SemanticVectorRetriever {
  readonly #storage: SemanticVectorStorage;
  readonly #dataRoot: string;
  readonly #modelRoot: string;
  readonly #epoch: VectorEmbeddingEpoch;
  readonly #runtimeFactory: SemanticVectorRuntimeFactory;
  readonly #allowEvaluating: boolean;
  readonly #failureCooldownMs: number;
  readonly #clock: () => number;
  readonly #runtimeFailures = new Map<string, {
    reason_code: string;
    retry_after: number;
  }>();

  constructor(input: {
    storage: SemanticVectorStorage;
    dataRoot: string;
    modelRoot: string;
    epoch: VectorEmbeddingEpoch;
    runtimeFactory?: SemanticVectorRuntimeFactory;
    allowEvaluating?: boolean;
    failureCooldownMs?: number;
    clock?: () => number;
  }) {
    this.#storage = input.storage;
    this.#dataRoot = input.dataRoot;
    this.#modelRoot = input.modelRoot;
    this.#epoch = VectorEmbeddingEpochSchema.parse(input.epoch);
    this.#runtimeFactory =
      input.runtimeFactory ?? defaultRuntimeFactory;
    this.#allowEvaluating = input.allowEvaluating ?? false;
    this.#failureCooldownMs = z.number().int().min(0).max(60_000)
      .parse(input.failureCooldownMs ?? 1_000);
    this.#clock = input.clock ?? Date.now;
  }

  async retrieve(
    input: SemanticVectorRequest,
  ): Promise<SemanticVectorLaneResult> {
    const startedAt = performance.now();
    const request = {
      lane: "semantic_vector" as const,
      principal_id: IdentifierSchema.parse(input.principal_id),
      scope: ScopeSchema.parse(input.scope),
      query: z.string().trim().min(1).max(4_000).parse(input.query),
      as_of: z.iso.datetime({ offset: true }).parse(input.as_of),
      include_sensitive: z.boolean().parse(input.include_sensitive),
      limit: z.number().int().min(1).max(1_000).parse(input.limit),
      vector_top_k: z.number().int().min(1).max(100)
        .parse(input.vector_top_k),
      vector_query_timeout_ms: z.number().int().min(1).max(75)
        .parse(input.vector_query_timeout_ms),
      vector_max_response_bytes: z.number().int()
        .min(1_024)
        .max(16 * 1_024 * 1_024)
        .parse(input.vector_max_response_bytes),
    };
    const configuration = await this.#storage.vectorProjectionStatus();
    const modeAllowed =
      configuration.mode === "enabled" ||
      (this.#allowEvaluating &&
        configuration.mode === "evaluating");
    if (
      !modeAllowed ||
      configuration.epoch_id !== this.#epoch.epoch_id
    ) {
      return unavailable(
        request,
        startedAt,
        configuration.mode === "disabled"
          ? "VECTOR_DISABLED"
          : "VECTOR_EPOCH_STALE",
      );
    }
    let checkpoint: z.infer<typeof VectorScopeCheckpointSchema>;
    try {
      checkpoint = VectorScopeCheckpointSchema.parse(
        await this.#storage.vectorProjectionCheckpoint({
          principal_id: request.principal_id,
          scope: request.scope,
        }),
      );
    } catch {
      return unavailable(
        request,
        startedAt,
        "VECTOR_CHECKPOINT_MISSING",
      );
    }
    if (
      checkpoint.state !== "published" ||
      checkpoint.active_epoch_id !== checkpoint.desired_epoch_id ||
      checkpoint.active_generation_id === null ||
      checkpoint.active_generation_id !==
        checkpoint.desired_generation_id ||
      checkpoint.logical_digest === null
    ) {
      return unavailable(
        request,
        startedAt,
        `VECTOR_SCOPE_${checkpoint.state.toUpperCase()}`,
      );
    }
    const activeRoot = await activeVectorGenerationRoot({
      dataRoot: this.#dataRoot,
      principalId: request.principal_id,
      scope: request.scope,
      epochId: checkpoint.active_epoch_id,
      generationId: checkpoint.active_generation_id,
    });
    const failureKey = canonicalSha256({
      principal_id: request.principal_id,
      scope: request.scope,
      embedding_epoch_id: checkpoint.active_epoch_id,
      generation_id: checkpoint.active_generation_id,
    });
    const now = this.#clock();
    this.#pruneRuntimeFailures(now);
    const rememberedFailure = this.#runtimeFailures.get(failureKey);
    if (
      rememberedFailure !== undefined &&
      rememberedFailure.retry_after > now
    ) {
      return unavailable(
        request,
        startedAt,
        rememberedFailure.reason_code,
      );
    }
    let runtime: SemanticVectorRuntime | null = null;
    let result: VectorQueryResult;
    const queryRequestId =
      `vector-query:${canonicalSha256({
        principal_id: request.principal_id,
        scope: request.scope,
        query: request.query,
        as_of: request.as_of,
        generation_id: checkpoint.active_generation_id,
      }).slice("sha256:".length, 48)}`;
    try {
      runtime = await this.#runtimeFactory.open({
        dataRoot: activeRoot,
        modelRoot: this.#modelRoot,
        principalId: request.principal_id,
        scope: request.scope,
        expectedEpoch: this.#epoch,
      });
      result = VectorQueryResultSchema.parse(
        await runtime.query({
          schema_version: "1.0.0",
          request_id: queryRequestId,
          principal_id: request.principal_id,
          scope: request.scope,
          query: request.query,
          embedding_epoch_id: checkpoint.active_epoch_id,
          generation_id: checkpoint.active_generation_id,
          source_frontier_hash:
            checkpoint.frontier.source_frontier_hash,
          top_k: Math.min(
            request.limit,
            request.vector_top_k,
          ),
          parent_deadline_ms: request.vector_query_timeout_ms,
          max_response_bytes: request.vector_max_response_bytes,
        }),
      );
    } catch (error) {
      const category = error instanceof VectorRuntimeError
        ? error.category
        : "PROCESS_EXIT";
      const reasonCode = failureReason(category);
      this.#rememberRuntimeFailure(failureKey, reasonCode);
      return unavailable(
        request,
        startedAt,
        reasonCode,
      );
    } finally {
      await runtime?.close().catch(() => undefined);
    }
    const responseBytes = Buffer.byteLength(
      canonicalJson(result),
      "utf8",
    );
    if (responseBytes > request.vector_max_response_bytes) {
      this.#rememberRuntimeFailure(
        failureKey,
        "VECTOR_RESOURCE_LIMIT",
      );
      return unavailable(
        request,
        startedAt,
        "VECTOR_RESOURCE_LIMIT",
      );
    }
    if (result.status === "degraded") {
      const reasonCode = failureReason(
        result.failure_category ?? "PROCESS_EXIT",
      );
      this.#rememberRuntimeFailure(failureKey, reasonCode);
      return unavailable(
        request,
        startedAt,
        reasonCode,
      );
    }
    if (
      result.request_id !== queryRequestId ||
      result.embedding_epoch_id !== checkpoint.active_epoch_id ||
      result.generation_id !== checkpoint.active_generation_id ||
      result.source_frontier_hash !==
        checkpoint.frontier.source_frontier_hash
    ) {
      this.#rememberRuntimeFailure(
        failureKey,
        "VECTOR_RESPONSE_IDENTITY_MISMATCH",
      );
      return unavailable(
        request,
        startedAt,
        "VECTOR_RESPONSE_IDENTITY_MISMATCH",
      );
    }
    this.#runtimeFailures.delete(failureKey);
    if (result.hits.length === 0) {
      return {
        candidates: [],
        exclusions: [],
        projection_frontier: null,
        truncated: false,
        reason_codes: ["VECTOR_COMPLETE_NO_MATCH"],
        bounded_work: [
          {
            boundary: "vector_candidates",
            configured_limit: request.vector_top_k,
            observed_count: 0,
            retained_count: 0,
            truncated_count: 0,
            complete: true,
          },
          {
            boundary: "vector_response_bytes",
            configured_limit: request.vector_max_response_bytes,
            observed_count: responseBytes,
            retained_count: responseBytes,
            truncated_count: 0,
            complete: true,
          },
        ],
        duration_ms: performance.now() - startedAt,
        query_hashes: [
          canonicalSha256({
            lane: request.lane,
            query: request.query.normalize("NFKC"),
          }),
        ],
      };
    }
    const revisionIds = result.hits.map((hit) => hit.revision_id);
    const batch = ExactSourceBatchSchema.parse(
      await this.#storage.validateProjectionSources({
        principal_id: request.principal_id,
        scope: request.scope,
        as_of: request.as_of,
        include_sensitive: false,
        context_scope: request.scope,
        revision_ids: revisionIds,
      }),
    );
    const batchByRevision = new Map(
      batch.results.map((entry) => [entry.revision_id, entry]),
    );
    const candidates: SemanticVectorLaneResult["candidates"] = [];
    const exclusions: SemanticVectorLaneResult["exclusions"] = [];
    for (const hit of result.hits) {
      const vectorEvidence = VectorSelectionEvidenceSchema.parse({
        schema_version: "1.0.0",
        embedding_epoch_id: result.embedding_epoch_id,
        generation_id: result.generation_id,
        source_frontier_hash: result.source_frontier_hash,
        distance: hit.distance,
        rank: hit.rank,
        canonical_revalidated: true,
      });
      const exact = batchByRevision.get(hit.revision_id);
      if (
        exact === undefined ||
        exact.status === "ineligible" ||
        exact.source.principal_id !== request.principal_id ||
        scopeKey(exact.source.scope) !== scopeKey(request.scope) ||
        exact.source.sensitivity === "sensitive" ||
        exact.source.sensitivity === "secret"
      ) {
        const opaque = opaqueRejectedHit(
          result.generation_id,
          hit.rank,
        );
        exclusions.push({
          ...opaque,
          lane: "semantic_vector",
          reason_code: "VECTOR_HIT_INELIGIBLE",
          score: hit.distance,
          vector: vectorEvidence,
        });
        continue;
      }
      if (exact.source.content_hash !== hit.source_content_hash) {
        exclusions.push({
          memory_id: exact.source.memory_id,
          revision_id: exact.source.revision_id,
          lane: "semantic_vector",
          reason_code: "VECTOR_CANONICAL_MISMATCH",
          score: hit.distance,
          vector: vectorEvidence,
        });
        continue;
      }
      const eligibility = EligibilitySchema.parse(
        await this.#storage.checkMemoryEligibility({
          memory_id: exact.source.memory_id,
          revision_id: hit.revision_id,
          principal_id: request.principal_id,
          scope: request.scope,
          as_of: request.as_of,
          include_sensitive: false,
          context_scope: request.scope,
        }),
      );
      if (!eligibility.eligible) {
        exclusions.push({
          memory_id: eligibility.memory_id,
          revision_id: eligibility.revision_id,
          lane: "semantic_vector",
          reason_code: eligibility.reason_code,
          score: hit.distance,
          vector: vectorEvidence,
        });
        continue;
      }
      candidates.push({
        kind: "memory",
        lane: "semantic_vector",
        memory: eligibility.item,
        rank: hit.distance + hit.rank / 1_000,
        vector: vectorEvidence,
      });
    }
    const allStale = candidates.length === 0 &&
      result.hits.length > 0;
    const reasonCodes = [
      ...(allStale ? ["VECTOR_ALL_HITS_STALE"] : []),
      ...(exclusions.length > 0
        ? ["VECTOR_POSTVALIDATION_REJECTED"]
        : []),
    ];
    return {
      candidates,
      exclusions,
      projection_frontier: null,
      truncated: allStale,
      reason_codes: reasonCodes,
      bounded_work: [
        {
          boundary: "vector_candidates",
          configured_limit: request.vector_top_k,
          observed_count: result.hits.length,
          retained_count: result.hits.length,
          truncated_count: 0,
          complete: true,
        },
        {
          boundary: "vector_postvalidation",
          configured_limit: request.vector_top_k,
          observed_count: result.hits.length,
          retained_count: candidates.length,
          truncated_count: exclusions.length,
          complete: exclusions.length === 0,
          ...(exclusions.length === 0
            ? {}
            : { reason_code: "VECTOR_POSTVALIDATION_REJECTED" }),
        },
        {
          boundary: "vector_response_bytes",
          configured_limit: request.vector_max_response_bytes,
          observed_count: responseBytes,
          retained_count: responseBytes,
          truncated_count: 0,
          complete: true,
        },
      ],
      duration_ms: performance.now() - startedAt,
      query_hashes: [
        canonicalSha256({
          lane: request.lane,
          query: request.query.normalize("NFKC"),
        }),
      ],
    };
  }

  #rememberRuntimeFailure(
    failureKey: string,
    reasonCode: string,
  ): void {
    this.#runtimeFailures.set(failureKey, {
      reason_code: reasonCode,
      retry_after: this.#clock() + this.#failureCooldownMs,
    });
  }

  #pruneRuntimeFailures(now: number): void {
    for (const [key, failure] of this.#runtimeFailures) {
      if (failure.retry_after <= now) {
        this.#runtimeFailures.delete(key);
      }
    }
  }
}
