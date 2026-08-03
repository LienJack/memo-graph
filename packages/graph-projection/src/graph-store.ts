import {
  GraphBackendIdentitySchema,
  GraphQuerySchema,
  GraphQueryResultSchema,
  GraphScopeSnapshotSchema,
  canonicalSha256,
  type GraphFailureCode,
  type GraphProcessHealth,
  type GraphQuery,
  type GraphQueryResult,
  type GraphScopeSnapshot,
  type Scope,
} from "@memo-graph/contracts";

export const GRAPH_PROCESS_TRUST_BOUNDARY =
  "The child process provides availability and crash containment. It is not an OS sandbox: @ladybugdb/core remains a trusted native dependency running with the local user's permissions.";

export type GraphProcessFailureOutcome =
  | "disabled"
  | "missing_dependency"
  | "deadline_killed"
  | "child_exited"
  | "protocol_error"
  | "circuit_open"
  | "store_error";

export type GraphFailureDisposition = {
  category:
    | "configuration"
    | "availability"
    | "protocol"
    | "resource"
    | "store"
    | "freshness"
    | "integrity"
    | "unknown";
  runtime: "sqlite_fallback";
  recovery:
    | "none"
    | "bounded_retry"
    | "cooldown"
    | "rebuild"
    | "reject_request";
  process_outcome: GraphProcessFailureOutcome;
};

export function graphFailureDisposition(
  code: GraphFailureCode,
): GraphFailureDisposition {
  switch (code) {
    case "GRAPH_DISABLED":
      return {
        category: "configuration",
        runtime: "sqlite_fallback",
        recovery: "none",
        process_outcome: "disabled",
      };
    case "GRAPH_OPTIONAL_DEPENDENCY_MISSING":
      return {
        category: "configuration",
        runtime: "sqlite_fallback",
        recovery: "none",
        process_outcome: "missing_dependency",
      };
    case "GRAPH_IDENTITY_MISMATCH":
    case "GRAPH_DIGEST_MISMATCH":
      return {
        category: "integrity",
        runtime: "sqlite_fallback",
        recovery: "rebuild",
        process_outcome: "store_error",
      };
    case "GRAPH_PROCESS_START_FAILED":
      return {
        category: "availability",
        runtime: "sqlite_fallback",
        recovery: "bounded_retry",
        process_outcome: "store_error",
      };
    case "GRAPH_PROTOCOL_INVALID":
      return {
        category: "protocol",
        runtime: "sqlite_fallback",
        recovery: "bounded_retry",
        process_outcome: "protocol_error",
      };
    case "GRAPH_REQUEST_LIMIT_EXCEEDED":
      return {
        category: "resource",
        runtime: "sqlite_fallback",
        recovery: "reject_request",
        process_outcome: "store_error",
      };
    case "GRAPH_DEADLINE_EXCEEDED":
      return {
        category: "resource",
        runtime: "sqlite_fallback",
        recovery: "bounded_retry",
        process_outcome: "deadline_killed",
      };
    case "GRAPH_CHILD_EXITED":
      return {
        category: "availability",
        runtime: "sqlite_fallback",
        recovery: "bounded_retry",
        process_outcome: "child_exited",
      };
    case "GRAPH_CIRCUIT_OPEN":
      return {
        category: "availability",
        runtime: "sqlite_fallback",
        recovery: "cooldown",
        process_outcome: "circuit_open",
      };
    case "GRAPH_STORE_LOCKED":
      return {
        category: "store",
        runtime: "sqlite_fallback",
        recovery: "bounded_retry",
        process_outcome: "store_error",
      };
    case "GRAPH_STORE_CORRUPT":
    case "GRAPH_SCOPE_REBUILDING":
      return {
        category:
          code === "GRAPH_STORE_CORRUPT" ? "store" : "freshness",
        runtime: "sqlite_fallback",
        recovery: "rebuild",
        process_outcome: "store_error",
      };
    case "GRAPH_SCOPE_STALE":
    case "GRAPH_SCOPE_PENDING":
    case "GRAPH_POSTVALIDATION_FAILED":
      return {
        category: "freshness",
        runtime: "sqlite_fallback",
        recovery:
          code === "GRAPH_POSTVALIDATION_FAILED"
            ? "reject_request"
            : "bounded_retry",
        process_outcome: "store_error",
      };
    case "GRAPH_UNKNOWN_WORK":
      return {
        category: "unknown",
        runtime: "sqlite_fallback",
        recovery: "bounded_retry",
        process_outcome: "store_error",
      };
  }
}

export class GraphStoreError extends Error {
  readonly code: GraphFailureCode;
  readonly retryable: boolean;

  constructor(
    code: GraphFailureCode,
    options: {
      retryable?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(code, { cause: options.cause });
    this.name = "GraphStoreError";
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

export interface GraphStore {
  health(): Promise<GraphProcessHealth>;
  replaceScope(input: unknown): Promise<GraphScopeSnapshot>;
  deleteScope(input: {
    principal_id: string;
    scope: Scope;
  }): Promise<void>;
  readScopeSnapshot(input: {
    principal_id: string;
    scope: Scope;
  }): Promise<GraphScopeSnapshot | null>;
  queryPaths(input: unknown): Promise<GraphQueryResult>;
  close(): Promise<void>;
}

export function validateExpectedGraphIdentity(input: unknown) {
  return GraphBackendIdentitySchema.parse(input);
}

export function validateGraphSnapshot(input: unknown): GraphScopeSnapshot {
  return GraphScopeSnapshotSchema.parse(input);
}

export function graphUnavailableResult(options: {
  query: unknown;
  code: GraphFailureCode;
  elapsedMs: number;
  outcome: GraphProcessFailureOutcome;
}): GraphQueryResult {
  const query: GraphQuery = GraphQuerySchema.parse(options.query);
  return GraphQueryResultSchema.parse({
    schema_version: "1.0.0",
    query_id: query.query_id,
    status: "unavailable",
    query_hash: canonicalSha256(query),
    frontier: query.frontier,
    paths: [],
    elapsed_ms: Math.max(0, options.elapsedMs),
    complete: false,
    reason_codes: [options.code],
    process_outcome: options.outcome,
  });
}
