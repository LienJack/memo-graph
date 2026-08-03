import {
  GraphBackendIdentitySchema,
  GraphDegradedReasonSchema,
  GraphProcessHealthSchema,
  GraphQueryResultSchema,
  GraphQuerySchema,
  GraphScopeSnapshotSchema,
  IdentifierSchema,
  ScopeSchema,
} from "@memo-graph/contracts";
import { z } from "zod";

export const GRAPH_PROCESS_PROTOCOL_VERSION = "1.0.0" as const;
export const DEFAULT_GRAPH_IPC_MAX_BYTES = 1_048_576;

const GraphIpcBaseShape = {
  protocol_version: z.literal(GRAPH_PROCESS_PROTOCOL_VERSION),
  kind: z.literal("request"),
  request_id: IdentifierSchema,
} as const;

const ExactScopeInputSchema = z
  .object({
    principal_id: IdentifierSchema,
    scope: ScopeSchema,
  })
  .strict();

export const GraphIpcRequestSchema = z.discriminatedUnion("operation", [
  z.object({
    ...GraphIpcBaseShape,
    operation: z.literal("health"),
    payload: z.null(),
  }).strict(),
  z.object({
    ...GraphIpcBaseShape,
    operation: z.literal("initialize"),
    payload: z.null(),
  }).strict(),
  z.object({
    ...GraphIpcBaseShape,
    operation: z.literal("replace_scope"),
    payload: GraphScopeSnapshotSchema,
  }).strict(),
  z.object({
    ...GraphIpcBaseShape,
    operation: z.literal("delete_scope"),
    payload: ExactScopeInputSchema,
  }).strict(),
  z.object({
    ...GraphIpcBaseShape,
    operation: z.literal("read_scope_snapshot"),
    payload: ExactScopeInputSchema,
  }).strict(),
  z.object({
    ...GraphIpcBaseShape,
    operation: z.literal("query_paths"),
    payload: GraphQuerySchema,
  }).strict(),
  z.object({
    ...GraphIpcBaseShape,
    operation: z.literal("close"),
    payload: z.null(),
  }).strict(),
]);

export const GraphIpcReadySchema = z
  .object({
    protocol_version: z.literal(GRAPH_PROCESS_PROTOCOL_VERSION),
    kind: z.literal("ready"),
    identity: GraphBackendIdentitySchema,
    database_path_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  })
  .strict();

export const GraphIpcStartupErrorSchema = z
  .object({
    protocol_version: z.literal(GRAPH_PROCESS_PROTOCOL_VERSION),
    kind: z.literal("startup_error"),
    error: GraphDegradedReasonSchema,
  })
  .strict();

const GraphIpcResponseEnvelopeSchema = z
  .object({
    protocol_version: z.literal(GRAPH_PROCESS_PROTOCOL_VERSION),
    kind: z.literal("response"),
    request_id: IdentifierSchema,
    operation: z.enum([
      "health",
      "initialize",
      "replace_scope",
      "delete_scope",
      "read_scope_snapshot",
      "query_paths",
      "close",
    ]),
    ok: z.boolean(),
    payload: z.unknown().optional(),
    error: GraphDegradedReasonSchema.optional(),
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
          "graph IPC response must contain exactly one success payload or error",
      });
    }
  });

export const GraphIpcResponseSchema = z.union([
  GraphIpcReadySchema,
  GraphIpcStartupErrorSchema,
  GraphIpcResponseEnvelopeSchema,
]);

export const GRAPH_OPERATION_RESULT_SCHEMAS = {
  health: GraphProcessHealthSchema,
  initialize: z.null(),
  replace_scope: GraphScopeSnapshotSchema,
  delete_scope: z.null(),
  read_scope_snapshot: GraphScopeSnapshotSchema.nullable(),
  query_paths: GraphQueryResultSchema,
  close: z.null(),
} as const;

function messageBytes(input: unknown): number {
  if (typeof input === "string") {
    return Buffer.byteLength(input, "utf8");
  }
  const serialized = JSON.stringify(input);
  if (serialized === undefined) {
    throw new Error("graph IPC message is not JSON serializable");
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
    throw new Error("graph IPC message is malformed JSON");
  }
}

function assertMessageSize(input: unknown, maxBytes: number): void {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error("graph IPC size limit must be a positive integer");
  }
  if (messageBytes(input) > maxBytes) {
    throw new Error("graph IPC message exceeds the configured size limit");
  }
}

export function parseBoundedGraphIpcRequest(
  input: unknown,
  maxBytes = DEFAULT_GRAPH_IPC_MAX_BYTES,
): z.infer<typeof GraphIpcRequestSchema> {
  assertMessageSize(input, maxBytes);
  return GraphIpcRequestSchema.parse(parseJsonInput(input));
}

export function parseBoundedGraphIpcResponse(
  input: unknown,
  maxBytes = DEFAULT_GRAPH_IPC_MAX_BYTES,
): z.infer<typeof GraphIpcResponseSchema> {
  assertMessageSize(input, maxBytes);
  return GraphIpcResponseSchema.parse(parseJsonInput(input));
}

export type GraphIpcRequest = z.infer<typeof GraphIpcRequestSchema>;
export type GraphIpcResponse = z.infer<typeof GraphIpcResponseSchema>;
export type GraphOperation = GraphIpcRequest["operation"];
export type GraphExactScopeInput = z.infer<typeof ExactScopeInputSchema>;
