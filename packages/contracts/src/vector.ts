import { z } from "zod";

import {
  canonicalSha256,
  canonicalSha256Omitting,
} from "./canonical-json.js";
import {
  CanonicalHashSchema,
  ContractVersionSchema,
  IdentifierSchema,
  NonEmptyReasonSchema,
  ScopeSchema,
  UtcTimestampSchema,
} from "./common.js";

const SemanticVersionSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/);

export const VectorModelFileSchema = z
  .object({
    path: z.enum([
      "config.json",
      "onnx/model_int8.onnx",
      "tokenizer.json",
      "tokenizer_config.json",
    ]),
    sha256: CanonicalHashSchema,
  })
  .strict();

const VectorEmbeddingEpochInputSchema = z
  .object({
    schema_version: ContractVersionSchema,
    runtime: z
      .object({
        package_name: z.literal("@huggingface/transformers"),
        package_version: SemanticVersionSchema,
      })
      .strict(),
    sqlite_binding: z
      .object({
        package_name: z.literal("better-sqlite3"),
        package_version: SemanticVersionSchema,
      })
      .strict(),
    model: z
      .object({
        repository: z.literal("Xenova/multilingual-e5-small"),
        revision: z.string().regex(/^[a-f0-9]{40}$/),
        files: z.array(VectorModelFileSchema).length(4),
        onnx_artifact: z.literal("onnx/model_int8.onnx"),
        dimensions: z.literal(384),
        dtype: z.literal("int8"),
        pooling: z.literal("mean"),
        normalization: z.literal("l2"),
        query_prefix: z.literal("query: "),
        passage_prefix: z.literal("passage: "),
        max_tokens: z.literal(512),
      })
      .strict(),
    index: z
      .object({
        package_name: z.literal("sqlite-vec"),
        package_version: SemanticVersionSchema,
        algorithm: z.literal("flat"),
        metric: z.literal("cosine"),
      })
      .strict(),
    projection_schema_version: ContractVersionSchema,
    dependency_lock_hash: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const expectedPaths = VectorModelFileSchema.shape.path.options;
    const paths = value.model.files.map((file) => file.path);
    if (
      paths.length !== expectedPaths.length ||
      paths.some((path, index) => path !== expectedPaths[index])
    ) {
      context.addIssue({
        code: "custom",
        path: ["model", "files"],
        message: "vector model files must be the exact canonical four-file snapshot",
      });
    }
    const artifact = value.model.files.find(
      (file) => file.path === value.model.onnx_artifact,
    );
    if (artifact === undefined) {
      context.addIssue({
        code: "custom",
        path: ["model", "onnx_artifact"],
        message: "vector ONNX artifact must resolve inside the model snapshot",
      });
    }
  });

export const VectorEmbeddingEpochSchema =
  VectorEmbeddingEpochInputSchema.safeExtend({
    epoch_id: CanonicalHashSchema,
  }).superRefine((value, context) => {
    if (
      value.epoch_id !== canonicalSha256Omitting(value, ["epoch_id"])
    ) {
      context.addIssue({
        code: "custom",
        path: ["epoch_id"],
        message: "vector embedding epoch identity must seal its complete contract",
      });
    }
  });

export function buildVectorEmbeddingEpoch(
  input: z.input<typeof VectorEmbeddingEpochInputSchema>,
): z.infer<typeof VectorEmbeddingEpochSchema> {
  const parsed = VectorEmbeddingEpochInputSchema.parse(input);
  return VectorEmbeddingEpochSchema.parse({
    ...parsed,
    epoch_id: canonicalSha256(parsed),
  });
}

export const VectorSourceFrontierSchema = z
  .object({
    ledger_epoch: z.number().int().nonnegative(),
    tombstone_epoch: z.number().int().nonnegative(),
    source_frontier_hash: CanonicalHashSchema,
    next_validity_transition_at: UtcTimestampSchema.nullable(),
  })
  .strict();

export const VectorRecordSchema = z
  .object({
    schema_version: ContractVersionSchema,
    revision_id: IdentifierSchema,
    source_content_hash: CanonicalHashSchema,
    vector: z.array(z.number().finite()).length(384),
  })
  .strict()
  .superRefine((value, context) => {
    const norm = Math.sqrt(
      value.vector.reduce((sum, component) => sum + component ** 2, 0),
    );
    if (Math.abs(norm - 1) > 0.001) {
      context.addIssue({
        code: "custom",
        path: ["vector"],
        message: "vector records must contain L2-normalized embeddings",
      });
    }
  });

const VectorScopeSnapshotInputSchema = z
  .object({
    schema_version: ContractVersionSchema,
    principal_id: IdentifierSchema,
    scope: ScopeSchema,
    embedding_epoch_id: CanonicalHashSchema,
    generation_id: IdentifierSchema,
    frontier: VectorSourceFrontierSchema,
    records: z.array(VectorRecordSchema),
  })
  .strict();

function refineVectorSnapshot(
  value: z.infer<typeof VectorScopeSnapshotInputSchema> & {
    logical_digest?: z.infer<typeof CanonicalHashSchema>;
  },
  context: z.RefinementCtx,
): void {
  const revisionIds = value.records.map((record) => record.revision_id);
  if (new Set(revisionIds).size !== revisionIds.length) {
    context.addIssue({
      code: "custom",
      path: ["records"],
      message: "vector snapshot revision identities must be unique",
    });
  }
  if (
    revisionIds.some(
      (revisionId, index) =>
        index > 0 && revisionId < (revisionIds[index - 1] ?? ""),
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["records"],
      message: "vector snapshot records must use canonical revision order",
    });
  }
  if (
    value.logical_digest !== undefined &&
    value.logical_digest !==
      canonicalSha256Omitting(value, ["logical_digest"])
  ) {
    context.addIssue({
      code: "custom",
      path: ["logical_digest"],
      message: "vector snapshot logical digest must seal the normalized snapshot",
    });
  }
}

export const VectorScopeSnapshotSchema =
  VectorScopeSnapshotInputSchema.safeExtend({
    logical_digest: CanonicalHashSchema,
  }).superRefine(refineVectorSnapshot);

export function buildVectorScopeSnapshot(
  input: z.input<typeof VectorScopeSnapshotInputSchema>,
): z.infer<typeof VectorScopeSnapshotSchema> {
  const parsed = VectorScopeSnapshotInputSchema.parse(input);
  const normalized = {
    ...parsed,
    records: [...parsed.records].sort((left, right) =>
      left.revision_id.localeCompare(right.revision_id),
    ),
  };
  return VectorScopeSnapshotSchema.parse({
    ...normalized,
    logical_digest: canonicalSha256(normalized),
  });
}

export const VectorFailureCategorySchema = z.enum([
  "MODEL_MISSING",
  "MODEL_IDENTITY_MISMATCH",
  "DEPENDENCY_UNAVAILABLE",
  "INDEX_MISSING",
  "INDEX_LOCKED",
  "INDEX_CORRUPT",
  "EPOCH_STALE",
  "FRONTIER_STALE",
  "REBUILDING",
  "PROCESS_TIMEOUT",
  "PROCESS_EXIT",
  "PROTOCOL_INVALID",
  "RESOURCE_LIMIT",
]);

export const VectorQuerySchema = z
  .object({
    schema_version: ContractVersionSchema,
    request_id: IdentifierSchema,
    principal_id: IdentifierSchema,
    scope: ScopeSchema,
    query: z.string().trim().min(1).max(4_000),
    embedding_epoch_id: CanonicalHashSchema,
    generation_id: IdentifierSchema,
    source_frontier_hash: CanonicalHashSchema,
    top_k: z.number().int().min(1).max(100),
    parent_deadline_ms: z.number().int().min(1).max(75),
    max_response_bytes: z
      .number()
      .int()
      .min(1_024)
      .max(16 * 1_024 * 1_024),
  })
  .strict();

export const VectorHitSchema = z
  .object({
    revision_id: IdentifierSchema,
    source_content_hash: CanonicalHashSchema,
    distance: z.number().finite().min(0).max(2),
    rank: z.number().int().positive().max(100),
  })
  .strict();

export const VectorQueryResultSchema = z
  .object({
    schema_version: ContractVersionSchema,
    request_id: IdentifierSchema,
    status: z.enum(["complete", "no_match", "degraded"]),
    embedding_epoch_id: CanonicalHashSchema,
    generation_id: IdentifierSchema,
    source_frontier_hash: CanonicalHashSchema,
    hits: z.array(VectorHitSchema).max(100),
    complete: z.boolean(),
    reason_codes: z.array(z.string().trim().min(1).max(200)),
    failure_category: VectorFailureCategorySchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const ranks = value.hits.map((hit) => hit.rank);
    const revisionIds = value.hits.map((hit) => hit.revision_id);
    if (
      new Set(ranks).size !== ranks.length ||
      new Set(revisionIds).size !== revisionIds.length ||
      ranks.some((rank, index) => rank !== index + 1)
    ) {
      context.addIssue({
        code: "custom",
        path: ["hits"],
        message: "vector hits must be unique and canonically ranked from one",
      });
    }
    if (
      value.complete !== (value.status !== "degraded") ||
      (value.status === "no_match" && value.hits.length !== 0) ||
      (value.status === "complete" && value.hits.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "vector result status, completeness, and hit cardinality must agree",
      });
    }
    if (
      (value.status === "degraded") !==
        (value.failure_category !== undefined) ||
      (value.status === "degraded" && value.reason_codes.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["failure_category"],
        message: "only degraded vector results require a failure and reason",
      });
    }
  });

export const VectorSelectionEvidenceSchema = z
  .object({
    schema_version: ContractVersionSchema,
    embedding_epoch_id: CanonicalHashSchema,
    generation_id: IdentifierSchema,
    source_frontier_hash: CanonicalHashSchema,
    distance: z.number().finite().min(0).max(2),
    rank: z.number().int().positive().max(100),
    canonical_revalidated: z.literal(true),
  })
  .strict();

export const VectorProjectionStateSchema = z.enum([
  "disabled",
  "pending",
  "building",
  "quarantined",
  "published",
  "degraded",
]);

export const VectorScopeCheckpointSchema = z
  .object({
    schema_version: ContractVersionSchema,
    principal_id: IdentifierSchema,
    scope: ScopeSchema,
    desired_epoch_id: CanonicalHashSchema,
    active_epoch_id: CanonicalHashSchema.nullable(),
    desired_generation_id: IdentifierSchema,
    active_generation_id: IdentifierSchema.nullable(),
    frontier: VectorSourceFrontierSchema,
    logical_digest: CanonicalHashSchema.nullable(),
    state: VectorProjectionStateSchema,
    last_job_id: IdentifierSchema.nullable(),
    failure_category: VectorFailureCategorySchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const published =
      value.state === "published" &&
      value.active_epoch_id === value.desired_epoch_id &&
      value.active_generation_id === value.desired_generation_id &&
      value.logical_digest !== null;
    if (value.state === "published" && !published) {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "published vector checkpoints require matching active identity and digest",
      });
    }
    if (
      (value.state === "degraded") !==
      (value.failure_category !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["failure_category"],
        message: "only degraded checkpoints require a failure category",
      });
    }
  });

export const VectorProjectionJobSchema = z
  .object({
    schema_version: ContractVersionSchema,
    job_id: IdentifierSchema,
    principal_id: IdentifierSchema,
    scope: ScopeSchema,
    reason: z.enum([
      "enable",
      "canonical_change",
      "temporal_transition",
      "epoch_change",
      "purge",
      "rebuild",
      "recovery",
    ]),
    desired_epoch_id: CanonicalHashSchema,
    desired_generation_id: IdentifierSchema,
    source_frontier_hash: CanonicalHashSchema,
    attempt: z.number().int().nonnegative(),
    lease_id: IdentifierSchema.nullable(),
    lease_expires_at: UtcTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.lease_id === null) !== (value.lease_expires_at === null)) {
      context.addIssue({
        code: "custom",
        path: ["lease_id"],
        message: "vector job lease identity and expiry must appear together",
      });
    }
  });

export const VectorProjectionReceiptSchema = z
  .object({
    schema_version: ContractVersionSchema,
    receipt_id: IdentifierSchema,
    job_id: IdentifierSchema,
    principal_id: IdentifierSchema,
    scope: ScopeSchema,
    embedding_epoch_id: CanonicalHashSchema,
    generation_id: IdentifierSchema,
    source_frontier_hash: CanonicalHashSchema,
    logical_digest: CanonicalHashSchema.nullable(),
    outcome: z.enum([
      "published",
      "stale",
      "failed",
      "purged",
      "disabled",
    ]),
    failure_category: VectorFailureCategorySchema.nullable(),
    reason_codes: z.array(z.string().trim().min(1).max(200)),
    created_at: UtcTimestampSchema,
    receipt_hash: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.outcome === "failed") !==
      (value.failure_category !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["failure_category"],
        message: "only failed vector projection receipts require a failure",
      });
    }
    if (
      value.receipt_hash !==
      canonicalSha256Omitting(value, ["receipt_hash"])
    ) {
      context.addIssue({
        code: "custom",
        path: ["receipt_hash"],
        message: "vector projection receipt hash must seal the receipt",
      });
    }
  });

export const VectorProcessHealthSchema = z
  .object({
    schema_version: ContractVersionSchema,
    status: z.enum(["starting", "ready", "quarantined", "cooldown", "closed"]),
    embedding_epoch_id: CanonicalHashSchema.nullable(),
    process_id: z.number().int().positive().nullable(),
    restart_count: z.number().int().nonnegative(),
    failure_category: VectorFailureCategorySchema.nullable(),
    reason: NonEmptyReasonSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.status === "ready" &&
      (value.embedding_epoch_id === null || value.process_id === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "ready vector process health requires epoch and process identity",
      });
    }
  });

export type VectorEmbeddingEpoch = z.infer<
  typeof VectorEmbeddingEpochSchema
>;
export type VectorFailureCategory = z.infer<
  typeof VectorFailureCategorySchema
>;
export type VectorHit = z.infer<typeof VectorHitSchema>;
export type VectorProcessHealth = z.infer<
  typeof VectorProcessHealthSchema
>;
export type VectorProjectionJob = z.infer<
  typeof VectorProjectionJobSchema
>;
export type VectorProjectionReceipt = z.infer<
  typeof VectorProjectionReceiptSchema
>;
export type VectorQuery = z.infer<typeof VectorQuerySchema>;
export type VectorQueryResult = z.infer<
  typeof VectorQueryResultSchema
>;
export type VectorScopeCheckpoint = z.infer<
  typeof VectorScopeCheckpointSchema
>;
export type VectorScopeSnapshot = z.infer<
  typeof VectorScopeSnapshotSchema
>;
export type VectorSelectionEvidence = z.infer<
  typeof VectorSelectionEvidenceSchema
>;
