import process from "node:process";

import {
  VectorEmbeddingEpochSchema,
  VectorProcessHealthSchema,
  VectorQuerySchema,
  VectorScopeSnapshotSchema,
  canonicalJson,
  type VectorFailureCategory,
  type VectorQuery,
} from "@memo-graph/contracts";
import { z } from "zod";

import { createLocalTransformersEmbedder } from "./embedder.js";
import {
  VectorRuntimeError,
} from "./process-host.js";
import {
  VectorChildRuntimeIdentitySchema,
  VectorEmbedPassagesInputSchema,
  VectorEmbedPassagesResultSchema,
  VECTOR_PROCESS_PROTOCOL_VERSION,
  parseBoundedVectorIpcRequest,
  type VectorIpcRequest,
} from "./protocol.js";
import { SqliteVecIndex } from "./vector-index.js";

const StartupConfigSchema = z
  .object({
    protocol_version: z.literal(VECTOR_PROCESS_PROTOCOL_VERSION),
    database_path: z.string().trim().min(1),
    database_path_hash: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/u),
    model_root: z.string().trim().min(1),
    expected_epoch: VectorEmbeddingEpochSchema,
    process_generation: z.number().int().positive(),
    restart_count: z.number().int().nonnegative(),
    max_ipc_bytes: z
      .number()
      .int()
      .min(1_024)
      .max(16 * 1_024 * 1_024),
  })
  .strict();

function decodeStartupConfig() {
  const encoded = process.argv[2];
  if (encoded === undefined) {
    throw new VectorRuntimeError("PROTOCOL_INVALID");
  }
  try {
    return StartupConfigSchema.parse(
      JSON.parse(
        Buffer.from(encoded, "base64url").toString("utf8"),
      ) as unknown,
    );
  } catch (error) {
    throw new VectorRuntimeError("PROTOCOL_INVALID", {
      cause: error,
    });
  }
}

function send(message: unknown): void {
  if (typeof process.send === "function" && process.connected) {
    process.send(message);
  }
}

function failureCategory(error: unknown): VectorFailureCategory {
  if (error instanceof VectorRuntimeError) {
    return error.category;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  ) {
    return "MODEL_MISSING";
  }
  return "INDEX_CORRUPT";
}

function retryable(error: unknown): boolean {
  return error instanceof VectorRuntimeError && error.retryable;
}

function success(
  request: VectorIpcRequest,
  payload: unknown,
): void {
  send({
    protocol_version: VECTOR_PROCESS_PROTOCOL_VERSION,
    kind: "response",
    request_id: request.request_id,
    operation: request.operation,
    ok: true,
    payload,
  });
}

function failure(
  request: VectorIpcRequest,
  error: unknown,
): void {
  send({
    protocol_version: VECTOR_PROCESS_PROTOCOL_VERSION,
    kind: "response",
    request_id: request.request_id,
    operation: request.operation,
    ok: false,
    error: {
      category: failureCategory(error),
      retryable: retryable(error),
    },
  });
}

function queryResult(
  query: VectorQuery,
  hits: Awaited<ReturnType<SqliteVecIndex["search"]>>,
) {
  return {
    schema_version: "1.0.0" as const,
    request_id: query.request_id,
    status: hits.length === 0 ? "no_match" as const : "complete" as const,
    embedding_epoch_id: query.embedding_epoch_id,
    generation_id: query.generation_id,
    source_frontier_hash: query.source_frontier_hash,
    hits,
    complete: true,
    reason_codes: [],
  };
}

let index: SqliteVecIndex | null = null;
let embedder:
  | Awaited<ReturnType<typeof createLocalTransformersEmbedder>>
  | null = null;
let closing = false;
const seenRequestIds = new Set<string>();
let operationChain: Promise<void> = Promise.resolve();

async function closeAndExit(code: number): Promise<never> {
  if (!closing) {
    closing = true;
    await Promise.allSettled([
      index?.close(),
      embedder?.close(),
    ]);
  }
  process.exit(code);
}

async function handleRequest(
  config: z.infer<typeof StartupConfigSchema>,
  input: unknown,
): Promise<void> {
  let request: VectorIpcRequest;
  try {
    request = parseBoundedVectorIpcRequest(
      input,
      config.max_ipc_bytes,
    );
  } catch {
    return closeAndExit(64);
  }
  if (seenRequestIds.has(request.request_id)) {
    failure(request, new VectorRuntimeError("PROTOCOL_INVALID"));
    return closeAndExit(65);
  }
  seenRequestIds.add(request.request_id);
  if (seenRequestIds.size > 10_000) {
    const first = seenRequestIds.values().next().value;
    if (typeof first === "string") {
      seenRequestIds.delete(first);
    }
  }
  if (index === null || embedder === null) {
    failure(
      request,
      new VectorRuntimeError("DEPENDENCY_UNAVAILABLE"),
    );
    return;
  }

  try {
    switch (request.operation) {
      case "health":
        success(
          request,
          VectorProcessHealthSchema.parse({
            schema_version: "1.0.0",
            status: "ready",
            embedding_epoch_id:
              config.expected_epoch.epoch_id,
            process_id: process.pid,
            restart_count: config.restart_count,
            failure_category: null,
            reason: null,
          }),
        );
        return;
      case "initialize":
        success(request, null);
        return;
      case "embed_passages": {
        const payload = VectorEmbedPassagesInputSchema.parse(
          request.payload,
        );
        const vectors = await embedder.embedPassages(
          payload.passages,
        );
        success(
          request,
          VectorEmbedPassagesResultSchema.parse(vectors),
        );
        return;
      }
      case "replace_scope":
        success(
          request,
          await index.replaceScope(
            VectorScopeSnapshotSchema.parse(request.payload),
          ),
        );
        return;
      case "delete_scope":
        await index.deleteScope();
        success(request, null);
        return;
      case "read_scope_snapshot":
        success(request, await index.readScopeSnapshot());
        return;
      case "query": {
        const query = VectorQuerySchema.parse(request.payload);
        const active = await index.readScopeSnapshot();
        if (active === null) {
          throw new VectorRuntimeError("INDEX_MISSING", {
            retryable: true,
          });
        }
        if (
          query.principal_id !== active.principal_id ||
          canonicalJson(query.scope) !== canonicalJson(active.scope)
        ) {
          throw new VectorRuntimeError("PROTOCOL_INVALID");
        }
        if (
          query.embedding_epoch_id !== active.embedding_epoch_id
        ) {
          throw new VectorRuntimeError("EPOCH_STALE", {
            retryable: true,
          });
        }
        if (
          query.generation_id !== active.generation_id ||
          query.source_frontier_hash !==
            active.frontier.source_frontier_hash
        ) {
          throw new VectorRuntimeError("FRONTIER_STALE", {
            retryable: true,
          });
        }
        const vector = await embedder.embedQuery(query.query);
        const result = queryResult(
          query,
          await index.search(vector, query.top_k),
        );
        if (
          Buffer.byteLength(JSON.stringify(result), "utf8") >
          query.max_response_bytes
        ) {
          throw new VectorRuntimeError("RESOURCE_LIMIT");
        }
        success(request, result);
        return;
      }
      case "close":
        success(request, null);
        return closeAndExit(0);
    }
  } catch (error) {
    failure(request, error);
  }
}

async function startRuntime(): Promise<{
  config: z.infer<typeof StartupConfigSchema>;
  openedIndex: SqliteVecIndex;
  openedEmbedder: Awaited<
    ReturnType<typeof createLocalTransformersEmbedder>
  >;
}> {
  const config = decodeStartupConfig();
  let openedEmbedder:
    | Awaited<ReturnType<typeof createLocalTransformersEmbedder>>
    | undefined;
  try {
    openedEmbedder = await createLocalTransformersEmbedder({
      modelRoot: config.model_root,
      epoch: config.expected_epoch,
    });
  } catch (error) {
    throw new VectorRuntimeError(
      failureCategory(error) === "MODEL_MISSING"
        ? "MODEL_MISSING"
        : "MODEL_IDENTITY_MISMATCH",
      { cause: error },
    );
  }
  try {
    const openedIndex = await SqliteVecIndex.open({
      databasePath: config.database_path,
      dimensions: config.expected_epoch.model.dimensions,
    });
    return { config, openedIndex, openedEmbedder };
  } catch (error) {
    await openedEmbedder.close();
    throw new VectorRuntimeError("DEPENDENCY_UNAVAILABLE", {
      cause: error,
    });
  }
}

async function main(): Promise<void> {
  process.title = "memo-graph-vector-child";
  let started: Awaited<ReturnType<typeof startRuntime>>;
  try {
    started = await startRuntime();
  } catch (error) {
    send({
      protocol_version: VECTOR_PROCESS_PROTOCOL_VERSION,
      kind: "startup_error",
      error: {
        category: failureCategory(error),
        retryable: retryable(error),
      },
    });
    return closeAndExit(66);
  }
  const config = started.config;
  index = started.openedIndex;
  embedder = started.openedEmbedder;

  send({
    protocol_version: VECTOR_PROCESS_PROTOCOL_VERSION,
    kind: "ready",
    epoch: config.expected_epoch,
    runtime: VectorChildRuntimeIdentitySchema.parse({
      node_version: process.version,
      platform: process.platform,
      architecture: process.arch,
      runtime_package: "@huggingface/transformers",
      runtime_version:
        config.expected_epoch.runtime.package_version,
      sqlite_binding: "better-sqlite3",
      sqlite_binding_version:
        config.expected_epoch.sqlite_binding.package_version,
      index_package: "sqlite-vec",
      index_package_version:
        config.expected_epoch.index.package_version,
      index_extension_version:
        started.openedIndex.extensionVersion(),
    }),
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
