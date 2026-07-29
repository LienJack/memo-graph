import {
  IdentifierSchema,
  VectorEmbeddingEpochSchema,
  VectorFailureCategorySchema,
  VectorProcessHealthSchema,
  VectorQueryResultSchema,
  VectorQuerySchema,
  VectorScopeSnapshotSchema,
} from "@memo-graph/contracts";
import { z } from "zod";

export const VECTOR_PROCESS_PROTOCOL_VERSION = "1.0.0" as const;
export const DEFAULT_VECTOR_IPC_MAX_BYTES = 1_048_576;

export const VectorEmbedPassagesInputSchema = z
  .object({
    passages: z
      .array(z.string().trim().min(1).max(20_000))
      .min(1)
      .max(32),
  })
  .strict();

export const VectorEmbedPassagesResultSchema = z
  .array(z.array(z.number().finite()).length(384))
  .min(1)
  .max(32)
  .superRefine((vectors, context) => {
    for (const [index, vector] of vectors.entries()) {
      const norm = Math.sqrt(
        vector.reduce(
          (sum, component) => sum + component ** 2,
          0,
        ),
      );
      if (Math.abs(norm - 1) > 0.001) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "passage embeddings must be L2 normalized",
        });
      }
    }
  });

export const VectorChildRuntimeIdentitySchema = z
  .object({
    node_version: z.literal("v24.18.0"),
    platform: z.literal("darwin"),
    architecture: z.literal("arm64"),
    runtime_package: z.literal("@huggingface/transformers"),
    runtime_version: z.literal("4.2.0"),
    sqlite_binding: z.literal("better-sqlite3"),
    sqlite_binding_version: z.literal("13.0.1"),
    index_package: z.literal("sqlite-vec"),
    index_package_version: z.literal("0.1.9"),
    index_extension_version: z.literal("v0.1.9"),
  })
  .strict();

export const QUALIFIED_VECTOR_RUNTIME_IDENTITY =
  VectorChildRuntimeIdentitySchema.parse({
    node_version: "v24.18.0",
    platform: "darwin",
    architecture: "arm64",
    runtime_package: "@huggingface/transformers",
    runtime_version: "4.2.0",
    sqlite_binding: "better-sqlite3",
    sqlite_binding_version: "13.0.1",
    index_package: "sqlite-vec",
    index_package_version: "0.1.9",
    index_extension_version: "v0.1.9",
  });

const VectorIpcBaseShape = {
  protocol_version: z.literal(VECTOR_PROCESS_PROTOCOL_VERSION),
  kind: z.literal("request"),
  request_id: IdentifierSchema,
} as const;

export const VectorIpcRequestSchema = z.discriminatedUnion(
  "operation",
  [
    z.object({
      ...VectorIpcBaseShape,
      operation: z.literal("health"),
      payload: z.null(),
    }).strict(),
    z.object({
      ...VectorIpcBaseShape,
      operation: z.literal("initialize"),
      payload: z.null(),
    }).strict(),
    z.object({
      ...VectorIpcBaseShape,
      operation: z.literal("embed_passages"),
      payload: VectorEmbedPassagesInputSchema,
    }).strict(),
    z.object({
      ...VectorIpcBaseShape,
      operation: z.literal("replace_scope"),
      payload: VectorScopeSnapshotSchema,
    }).strict(),
    z.object({
      ...VectorIpcBaseShape,
      operation: z.literal("delete_scope"),
      payload: z.null(),
    }).strict(),
    z.object({
      ...VectorIpcBaseShape,
      operation: z.literal("read_scope_snapshot"),
      payload: z.null(),
    }).strict(),
    z.object({
      ...VectorIpcBaseShape,
      operation: z.literal("query"),
      payload: VectorQuerySchema,
    }).strict(),
    z.object({
      ...VectorIpcBaseShape,
      operation: z.literal("close"),
      payload: z.null(),
    }).strict(),
  ],
);

export const VectorIpcReadySchema = z
  .object({
    protocol_version: z.literal(VECTOR_PROCESS_PROTOCOL_VERSION),
    kind: z.literal("ready"),
    epoch: VectorEmbeddingEpochSchema,
    runtime: VectorChildRuntimeIdentitySchema,
    database_path_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  })
  .strict();

export const VectorIpcStartupErrorSchema = z
  .object({
    protocol_version: z.literal(VECTOR_PROCESS_PROTOCOL_VERSION),
    kind: z.literal("startup_error"),
    error: z
      .object({
        category: VectorFailureCategorySchema,
        retryable: z.boolean(),
      })
      .strict(),
  })
  .strict();

const VectorIpcResponseEnvelopeSchema = z
  .object({
    protocol_version: z.literal(VECTOR_PROCESS_PROTOCOL_VERSION),
    kind: z.literal("response"),
    request_id: IdentifierSchema,
    operation: z.enum([
      "health",
      "initialize",
      "embed_passages",
      "replace_scope",
      "delete_scope",
      "read_scope_snapshot",
      "query",
      "close",
    ]),
    ok: z.boolean(),
    payload: z.unknown().optional(),
    error: z
      .object({
        category: VectorFailureCategorySchema,
        retryable: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.ok !==
      (value.payload !== undefined && value.error === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["ok"],
        message:
          "vector IPC response must contain exactly one success payload or error",
      });
    }
  });

export const VectorIpcResponseSchema = z.union([
  VectorIpcReadySchema,
  VectorIpcStartupErrorSchema,
  VectorIpcResponseEnvelopeSchema,
]);

export const VECTOR_OPERATION_RESULT_SCHEMAS = {
  health: VectorProcessHealthSchema,
  initialize: z.null(),
  embed_passages: VectorEmbedPassagesResultSchema,
  replace_scope: VectorScopeSnapshotSchema,
  delete_scope: z.null(),
  read_scope_snapshot: VectorScopeSnapshotSchema.nullable(),
  query: VectorQueryResultSchema,
  close: z.null(),
} as const;

function messageBytes(input: unknown): number {
  if (typeof input === "string") {
    return Buffer.byteLength(input, "utf8");
  }
  const serialized = JSON.stringify(input);
  if (serialized === undefined) {
    throw new Error("vector IPC message is not JSON serializable");
  }
  return Buffer.byteLength(serialized, "utf8");
}

function parseJsonInput(input: unknown): unknown {
  if (typeof input !== "string") {
    return input;
  }
  try {
    return JSON.parse(input) as unknown;
  } catch {
    throw new Error("vector IPC message is malformed JSON");
  }
}

function assertMessageSize(input: unknown, maxBytes: number): void {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error("vector IPC size limit must be a positive integer");
  }
  if (messageBytes(input) > maxBytes) {
    throw new Error("vector IPC message exceeds the configured size limit");
  }
}

export function parseBoundedVectorIpcRequest(
  input: unknown,
  maxBytes = DEFAULT_VECTOR_IPC_MAX_BYTES,
): z.infer<typeof VectorIpcRequestSchema> {
  assertMessageSize(input, maxBytes);
  return VectorIpcRequestSchema.parse(parseJsonInput(input));
}

export function parseBoundedVectorIpcResponse(
  input: unknown,
  maxBytes = DEFAULT_VECTOR_IPC_MAX_BYTES,
): z.infer<typeof VectorIpcResponseSchema> {
  assertMessageSize(input, maxBytes);
  return VectorIpcResponseSchema.parse(parseJsonInput(input));
}

export type VectorIpcRequest = z.infer<
  typeof VectorIpcRequestSchema
>;
export type VectorIpcResponse = z.infer<
  typeof VectorIpcResponseSchema
>;
export type VectorOperation = VectorIpcRequest["operation"];
