import process from "node:process";

import {
  GraphBackendIdentitySchema,
  GraphProcessHealthSchema,
  GraphQuerySchema,
  GraphScopeSnapshotSchema,
  IdentifierSchema,
  ScopeSchema,
  type GraphFailureCode,
} from "@memo-graph/contracts";
import { z } from "zod";

import {
  GraphStoreError,
} from "./graph-store.js";
import {
  LadybugGraphAdapter,
} from "./ladybug-adapter.js";
import {
  GRAPH_PROCESS_PROTOCOL_VERSION,
  parseBoundedGraphIpcRequest,
  type GraphIpcRequest,
} from "./protocol.js";

const StartupConfigSchema = z
  .object({
    protocol_version: z.literal(GRAPH_PROCESS_PROTOCOL_VERSION),
    database_path: z.string().trim().min(1),
    database_path_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    expected_identity: GraphBackendIdentitySchema,
    process_generation: z.number().int().positive(),
    restart_count: z.number().int().nonnegative(),
    max_ipc_bytes: z.number().int().min(1_024).max(16 * 1_024 * 1_024),
    test_hooks: z.object({
      adversarial_native_query: z.boolean(),
      adversarial_native_write: z.boolean(),
    }).strict().optional(),
  })
  .strict();

function decodeStartupConfig() {
  const encoded = process.argv[2];
  if (encoded === undefined) {
    throw new GraphStoreError("GRAPH_PROTOCOL_INVALID");
  }
  try {
    return StartupConfigSchema.parse(
      JSON.parse(
        Buffer.from(encoded, "base64url").toString("utf8"),
      ) as unknown,
    );
  } catch (error) {
    throw new GraphStoreError("GRAPH_PROTOCOL_INVALID", {
      cause: error,
    });
  }
}

function send(message: unknown): void {
  if (typeof process.send === "function" && process.connected) {
    process.send(message);
  }
}

function failureCode(error: unknown): GraphFailureCode {
  return error instanceof GraphStoreError
    ? error.code
    : "GRAPH_UNKNOWN_WORK";
}

function retryable(error: unknown): boolean {
  return error instanceof GraphStoreError && error.retryable;
}

function success(
  request: GraphIpcRequest,
  payload: unknown,
): void {
  send({
    protocol_version: GRAPH_PROCESS_PROTOCOL_VERSION,
    kind: "response",
    request_id: request.request_id,
    operation: request.operation,
    ok: true,
    payload,
  });
}

function failure(
  request: GraphIpcRequest,
  error: unknown,
): void {
  send({
    protocol_version: GRAPH_PROCESS_PROTOCOL_VERSION,
    kind: "response",
    request_id: request.request_id,
    operation: request.operation,
    ok: false,
    error: {
      code: failureCode(error),
      message: "graph operation failed",
      retryable: retryable(error),
    },
  });
}

let adapter: LadybugGraphAdapter | null = null;
let closing = false;
const seenRequestIds = new Set<string>();
let operationChain: Promise<void> = Promise.resolve();

async function closeAndExit(code: number): Promise<never> {
  if (!closing) {
    closing = true;
    await adapter?.close().catch(() => undefined);
  }
  process.exit(code);
}

async function handleRequest(
  config: z.infer<typeof StartupConfigSchema>,
  input: unknown,
): Promise<void> {
  let request: GraphIpcRequest;
  try {
    request = parseBoundedGraphIpcRequest(
      input,
      config.max_ipc_bytes,
    );
  } catch {
    return closeAndExit(64);
  }
  if (seenRequestIds.has(request.request_id)) {
    failure(
      request,
      new GraphStoreError("GRAPH_PROTOCOL_INVALID"),
    );
    await closeAndExit(65);
  }
  seenRequestIds.add(request.request_id);
  if (seenRequestIds.size > 10_000) {
    const first = seenRequestIds.values().next().value;
    if (typeof first === "string") {
      seenRequestIds.delete(first);
    }
  }
  if (adapter === null) {
    failure(
      request,
      new GraphStoreError("GRAPH_PROCESS_START_FAILED"),
    );
    return;
  }

  try {
    switch (request.operation) {
      case "health":
        success(
          request,
          GraphProcessHealthSchema.parse({
            schema_version: "1.0.0",
            status: "ready",
            backend_identity: adapter.identity,
            process_generation: config.process_generation,
            restart_count: config.restart_count,
            queue_depth: 0,
            active_requests: 1,
            database_path_hash: config.database_path_hash,
            circuit_open_until: null,
            last_failure: null,
          }),
        );
        return;
      case "initialize":
        await adapter.initialize();
        success(request, null);
        return;
      case "replace_scope":
        success(
          request,
          await adapter.replaceScope(
            GraphScopeSnapshotSchema.parse(request.payload),
          ),
        );
        return;
      case "delete_scope":
        await adapter.deleteScope(
          z.object({
            principal_id: IdentifierSchema,
            scope: ScopeSchema,
          }).strict().parse(request.payload),
        );
        success(request, null);
        return;
      case "read_scope_snapshot":
        success(
          request,
          await adapter.readScopeSnapshot(
            z.object({
              principal_id: IdentifierSchema,
              scope: ScopeSchema,
            }).strict().parse(request.payload),
          ),
        );
        return;
      case "query_paths":
        success(
          request,
          await adapter.queryPaths(
            GraphQuerySchema.parse(request.payload),
          ),
        );
        return;
      case "close":
        success(request, null);
        await closeAndExit(0);
    }
  } catch (error) {
    failure(request, error);
  }
}

async function startAdapter(): Promise<{
  config: z.infer<typeof StartupConfigSchema>;
  opened: LadybugGraphAdapter;
}> {
  try {
    const config = decodeStartupConfig();
    const opened = await LadybugGraphAdapter.open({
      databasePath: config.database_path,
      dependencyLockHash:
        config.expected_identity.dependency_lock_hash,
      expectedIdentity: config.expected_identity,
      ...(config.test_hooks === undefined
        ? {}
        : { testHooks: config.test_hooks }),
    });
    return { config, opened };
  } catch (error) {
    send({
      protocol_version: GRAPH_PROCESS_PROTOCOL_VERSION,
      kind: "startup_error",
      error: {
        code: failureCode(error),
        message: "graph child startup failed",
        retryable: retryable(error),
      },
    });
    return closeAndExit(66);
  }
}

async function main(): Promise<void> {
  process.title = "memo-graph-ladybug-child";
  const started = await startAdapter();
  const config = started.config;
  adapter = started.opened;

  send({
    protocol_version: GRAPH_PROCESS_PROTOCOL_VERSION,
    kind: "ready",
    identity: started.opened.identity,
    database_path_hash: config.database_path_hash,
  });

  process.on("message", (message: unknown) => {
    operationChain = operationChain.then(() =>
      handleRequest(config, message)
    );
    void operationChain.catch(() => closeAndExit(67));
  });
  process.once("disconnect", () => {
    void closeAndExit(0);
  });
  process.once("SIGTERM", () => {
    void closeAndExit(0);
  });
}

await main();
