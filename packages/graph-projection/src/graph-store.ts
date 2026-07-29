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
  outcome:
    | "disabled"
    | "missing_dependency"
    | "deadline_killed"
    | "child_exited"
    | "protocol_error"
    | "circuit_open"
    | "store_error";
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
