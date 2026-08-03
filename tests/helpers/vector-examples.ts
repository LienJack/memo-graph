import {
  buildVectorEmbeddingEpoch,
  canonicalSha256,
  VectorProjectionReceiptSchema,
  type Scope,
  type VectorProjectionReceipt,
} from "../../packages/contracts/src/index.js";

export const VECTOR_NOW = "2026-07-29T06:00:00.000Z";
export const VECTOR_LATER = "2026-07-29T06:10:00.000Z";
export const VECTOR_SCOPE = {
  kind: "workspace",
  id: "workspace_local",
} as const;
export const vectorHash = (
  character: string,
): `sha256:${string}` =>
  `sha256:${character.repeat(64)}`;

export function qualifiedVectorEpoch() {
  return buildVectorEmbeddingEpoch({
    schema_version: "1.0.0",
    runtime: {
      package_name: "@huggingface/transformers",
      package_version: "4.2.0",
    },
    sqlite_binding: {
      package_name: "better-sqlite3",
      package_version: "13.0.1",
    },
    model: {
      repository: "Xenova/multilingual-e5-small",
      revision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78",
      files: [
        { path: "config.json", sha256: vectorHash("a") },
        {
          path: "onnx/model_int8.onnx",
          sha256: vectorHash("b"),
        },
        { path: "tokenizer.json", sha256: vectorHash("c") },
        {
          path: "tokenizer_config.json",
          sha256: vectorHash("d"),
        },
      ],
      onnx_artifact: "onnx/model_int8.onnx",
      dimensions: 384,
      dtype: "int8",
      pooling: "mean",
      normalization: "l2",
      query_prefix: "query: ",
      passage_prefix: "passage: ",
      max_tokens: 512,
    },
    index: {
      package_name: "sqlite-vec",
      package_version: "0.1.9",
      algorithm: "flat",
      metric: "cosine",
    },
    projection_schema_version: "1.0.0",
    dependency_lock_hash: vectorHash("e"),
  });
}

export function vectorProjectionReceipt(input: {
  receiptId: string;
  job: {
    job_id: string;
    principal_id: string;
    scope: Scope;
    desired_epoch_id: string;
    desired_generation_id: string;
    source_frontier_hash: string;
  };
  outcome?: "published" | "stale" | "failed" | "purged" | "disabled";
  logicalDigest?: string | null;
  failureCategory?:
    | "MODEL_MISSING"
    | "MODEL_IDENTITY_MISMATCH"
    | "DEPENDENCY_UNAVAILABLE"
    | "INDEX_MISSING"
    | "INDEX_LOCKED"
    | "INDEX_CORRUPT"
    | "EPOCH_STALE"
    | "FRONTIER_STALE"
    | "REBUILDING"
    | "PROCESS_TIMEOUT"
    | "PROCESS_EXIT"
    | "PROTOCOL_INVALID"
    | "RESOURCE_LIMIT"
    | null;
  createdAt?: string;
}): VectorProjectionReceipt {
  const outcome = input.outcome ?? "published";
  const body = {
    schema_version: "1.0.0",
    receipt_id: input.receiptId,
    job_id: input.job.job_id,
    principal_id: input.job.principal_id,
    scope: input.job.scope,
    embedding_epoch_id: input.job.desired_epoch_id,
    generation_id: input.job.desired_generation_id,
    source_frontier_hash: input.job.source_frontier_hash,
    logical_digest:
      input.logicalDigest === undefined
        ? vectorHash("f")
        : input.logicalDigest,
    outcome,
    failure_category:
      input.failureCategory === undefined
        ? outcome === "failed"
          ? "PROCESS_EXIT" as const
          : null
        : input.failureCategory,
    reason_codes:
      outcome === "failed" ? ["VECTOR_PROCESS_EXIT"] : [],
    created_at: input.createdAt ?? VECTOR_LATER,
  };
  return VectorProjectionReceiptSchema.parse({
    ...body,
    receipt_hash: canonicalSha256(body),
  });
}
