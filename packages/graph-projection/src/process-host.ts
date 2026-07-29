import { randomUUID } from "node:crypto";
import {
  fork,
  type ChildProcess,
} from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import {
  GraphBackendIdentitySchema,
  GraphProcessHealthSchema,
  GraphQuerySchema,
  GraphScopeSnapshotSchema,
  ScopeSchema,
  canonicalJson,
  canonicalSha256,
  type GraphBackendIdentity,
  type GraphFailureCode,
  type GraphProcessHealth,
  type GraphQueryResult,
  type GraphScopeSnapshot,
  type Scope,
} from "@memo-graph/contracts";
import { z } from "zod";

import {
  GraphStoreError,
  graphUnavailableResult,
  type GraphStore,
} from "./graph-store.js";
import {
  createGraphChildEnvironment,
  prepareGraphDatabasePath,
  type GraphPathLayout,
} from "./path-security.js";
import {
  DEFAULT_GRAPH_IPC_MAX_BYTES,
  GRAPH_OPERATION_RESULT_SCHEMAS,
  GRAPH_PROCESS_PROTOCOL_VERSION,
  GraphIpcRequestSchema,
  parseBoundedGraphIpcResponse,
  type GraphOperation,
} from "./protocol.js";

const RestartPolicySchema = z
  .object({
    maxRestarts: z.number().int().min(1).max(100),
    windowMs: z.number().int().min(100).max(600_000),
    cooldownMs: z.number().int().min(100).max(600_000),
  })
  .strict();

const TestHooksSchema = z
  .object({
    identityOverride: GraphBackendIdentitySchema.optional(),
    adversarialNativeQuery: z.boolean().optional(),
    adversarialNativeWrite: z.boolean().optional(),
  })
  .strict();

export type GraphProcessDiagnostic = {
  operation: GraphOperation | "startup" | "process";
  generation: number;
  duration_ms: number;
  outcome:
    | "ok"
    | "error"
    | "timeout"
    | "discarded"
    | "exit";
  error_code?: GraphFailureCode;
};

export type GraphProcessHostOptions = {
  dataRoot: string;
  generationId?: string;
  expectedIdentity: GraphBackendIdentity;
  childEntry?: URL;
  requestTimeoutMs?: number;
  writeTimeoutMs?: number;
  startupTimeoutMs?: number;
  maxIpcBytes?: number;
  restartPolicy?: {
    maxRestarts: number;
    windowMs: number;
    cooldownMs: number;
  };
  onDiagnostic?: (diagnostic: GraphProcessDiagnostic) => void;
  testHooks?: {
    identityOverride?: GraphBackendIdentity;
    adversarialNativeQuery?: boolean;
    adversarialNativeWrite?: boolean;
  };
};

type PendingRequest = {
  generation: number;
  operation: GraphOperation;
  schema: z.ZodType;
  startedAt: number;
  timer: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

type StartupWaiter = {
  generation: number;
  timer: NodeJS.Timeout;
  resolve: () => void;
  reject: (error: unknown) => void;
};

function asGraphStoreError(
  error: unknown,
  fallback: GraphFailureCode,
): GraphStoreError {
  return error instanceof GraphStoreError
    ? error
    : new GraphStoreError(fallback, {
        cause: error,
        retryable: true,
      });
}

function failureOutcome(code: GraphFailureCode) {
  switch (code) {
    case "GRAPH_DEADLINE_EXCEEDED":
      return "deadline_killed" as const;
    case "GRAPH_CHILD_EXITED":
      return "child_exited" as const;
    case "GRAPH_PROTOCOL_INVALID":
      return "protocol_error" as const;
    case "GRAPH_CIRCUIT_OPEN":
      return "circuit_open" as const;
    case "GRAPH_OPTIONAL_DEPENDENCY_MISSING":
      return "missing_dependency" as const;
    case "GRAPH_DISABLED":
      return "disabled" as const;
    default:
      return "store_error" as const;
  }
}

function defaultChildEntry(): URL {
  const compiled = new URL("./ladybug-process.js", import.meta.url);
  if (existsSync(fileURLToPath(compiled))) {
    return compiled;
  }
  return new URL("./ladybug-process.ts", import.meta.url);
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    timer.unref();
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

export class GraphProcessHost implements GraphStore {
  readonly #options: {
    expectedIdentity: GraphBackendIdentity;
    childEntry: URL;
    requestTimeoutMs: number;
    writeTimeoutMs: number;
    startupTimeoutMs: number;
    maxIpcBytes: number;
    restartPolicy: z.infer<typeof RestartPolicySchema>;
    onDiagnostic:
      | ((diagnostic: GraphProcessDiagnostic) => void)
      | undefined;
    testHooks: z.infer<typeof TestHooksSchema> | undefined;
  };
  readonly #layout: GraphPathLayout;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #restartTimes: number[] = [];
  #child: ChildProcess | null = null;
  #generation = 0;
  #restartCount = 0;
  #ready = false;
  #activated = false;
  #closed = false;
  #closing = false;
  #lastFailure: GraphFailureCode | null = null;
  #circuitOpenUntil = 0;
  #startPromise: Promise<void> | null = null;
  #startupWaiter: StartupWaiter | null = null;

  private constructor(options: {
    input: GraphProcessHostOptions;
    layout: GraphPathLayout;
    environment: NodeJS.ProcessEnv;
  }) {
    this.#layout = options.layout;
    this.#environment = options.environment;
    this.#options = {
      expectedIdentity: GraphBackendIdentitySchema.parse(
        options.input.expectedIdentity,
      ),
      childEntry: options.input.childEntry ?? defaultChildEntry(),
      requestTimeoutMs:
        z.number().int().min(1).max(60_000).parse(
          options.input.requestTimeoutMs ?? 75,
        ),
      writeTimeoutMs:
        z.number().int().min(1).max(120_000).parse(
          options.input.writeTimeoutMs ?? 5_000,
        ),
      startupTimeoutMs:
        z.number().int().min(1).max(60_000).parse(
          options.input.startupTimeoutMs ?? 2_000,
        ),
      maxIpcBytes:
        z.number().int().min(1_024).max(16 * 1_024 * 1_024).parse(
          options.input.maxIpcBytes ?? DEFAULT_GRAPH_IPC_MAX_BYTES,
        ),
      restartPolicy: RestartPolicySchema.parse(
        options.input.restartPolicy ?? {
          maxRestarts: 3,
          windowMs: 10_000,
          cooldownMs: 30_000,
        },
      ),
      onDiagnostic: options.input.onDiagnostic,
      testHooks:
        options.input.testHooks === undefined
          ? undefined
          : TestHooksSchema.parse(options.input.testHooks),
    };
  }

  static async open(
    input: GraphProcessHostOptions,
  ): Promise<GraphProcessHost> {
    const layout = await prepareGraphDatabasePath(input.dataRoot, {
      ...(input.generationId === undefined
        ? {}
        : { generationId: input.generationId }),
    });
    const host = new GraphProcessHost({
      input,
      layout,
      environment: await createGraphChildEnvironment({
        dataRoot: layout.dataRoot,
      }),
    });
    try {
      await host.#startChild(false);
      await host.#request(
        "initialize",
        null,
        GRAPH_OPERATION_RESULT_SCHEMAS.initialize,
        host.#options.writeTimeoutMs,
      );
      host.#activated = true;
      return host;
    } catch (error) {
      await host.#abort();
      throw error;
    }
  }

  processId(): number | null {
    return this.#child?.pid ?? null;
  }

  pathLayout(): GraphPathLayout {
    return { ...this.#layout };
  }

  processHealth(): GraphProcessHealth {
    const now = Date.now();
    const circuitOpen = this.#circuitOpenUntil > now;
    return GraphProcessHealthSchema.parse({
      schema_version: "1.0.0",
      status: this.#closed
        ? "stopped"
        : circuitOpen
          ? "circuit_open"
          : this.#ready
            ? "ready"
            : this.#startPromise !== null
              ? "starting"
              : this.#lastFailure === null
                ? "unavailable"
                : "quarantined",
      backend_identity:
        this.#ready ? this.#options.expectedIdentity : null,
      process_generation: this.#generation,
      restart_count: this.#restartCount,
      queue_depth: this.#pending.size,
      active_requests: this.#pending.size,
      database_path_hash: this.#layout.databasePathHash,
      circuit_open_until:
        circuitOpen
          ? new Date(this.#circuitOpenUntil).toISOString()
          : null,
      last_failure:
        circuitOpen
          ? "GRAPH_CIRCUIT_OPEN"
          : this.#lastFailure,
    });
  }

  async waitUntilHealthy(timeoutMs: number): Promise<boolean> {
    const deadline = performance.now() + timeoutMs;
    while (!this.#closed && performance.now() <= deadline) {
      try {
        await this.#ensureReady();
        if (this.#ready) {
          return true;
        }
      } catch {
        // The caller asked for a bounded health wait, so transient failures
        // are observed through the final boolean instead of escaping.
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 10);
        timer.unref();
      });
    }
    return false;
  }

  async health(): Promise<GraphProcessHealth> {
    if (!this.#ready) {
      return this.processHealth();
    }
    return await this.#request(
      "health",
      null,
      GRAPH_OPERATION_RESULT_SCHEMAS.health,
      this.#options.requestTimeoutMs,
    ) as GraphProcessHealth;
  }

  async replaceScope(input: unknown): Promise<GraphScopeSnapshot> {
    const snapshot = GraphScopeSnapshotSchema.parse(input);
    return await this.#request(
      "replace_scope",
      snapshot,
      GRAPH_OPERATION_RESULT_SCHEMAS.replace_scope,
      this.#options.writeTimeoutMs,
    ) as GraphScopeSnapshot;
  }

  async deleteScope(input: {
    principal_id: string;
    scope: Scope;
  }): Promise<void> {
    const exactScope = {
      principal_id:
        z.string().trim().min(1).max(200).parse(input.principal_id),
      scope: ScopeSchema.parse(input.scope),
    };
    await this.#request(
      "delete_scope",
      exactScope,
      GRAPH_OPERATION_RESULT_SCHEMAS.delete_scope,
      this.#options.writeTimeoutMs,
    );
  }

  async readScopeSnapshot(input: {
    principal_id: string;
    scope: Scope;
  }): Promise<GraphScopeSnapshot | null> {
    const exactScope = {
      principal_id:
        z.string().trim().min(1).max(200).parse(input.principal_id),
      scope: ScopeSchema.parse(input.scope),
    };
    return await this.#request(
      "read_scope_snapshot",
      exactScope,
      GRAPH_OPERATION_RESULT_SCHEMAS.read_scope_snapshot,
      this.#options.writeTimeoutMs,
    ) as GraphScopeSnapshot | null;
  }

  async queryPaths(input: unknown): Promise<GraphQueryResult> {
    const query = GraphQuerySchema.parse(input);
    const startedAt = performance.now();
    try {
      return await this.#request(
        "query_paths",
        query,
        GRAPH_OPERATION_RESULT_SCHEMAS.query_paths,
        Math.min(
          query.parent_deadline_ms,
          this.#options.requestTimeoutMs,
        ),
      ) as GraphQueryResult;
    } catch (error) {
      const failure = asGraphStoreError(error, "GRAPH_UNKNOWN_WORK");
      return graphUnavailableResult({
        query,
        code: failure.code,
        elapsedMs: performance.now() - startedAt,
        outcome: failureOutcome(failure.code),
      });
    }
  }

  async close(): Promise<void> {
    if (this.#closed || this.#closing) {
      return;
    }
    this.#closing = true;
    const child = this.#child;
    let exitedGracefully = false;
    if (child !== null && this.#ready && child.connected) {
      try {
        await this.#request(
          "close",
          null,
          GRAPH_OPERATION_RESULT_SCHEMAS.close,
          250,
          true,
        );
        exitedGracefully = await waitForExit(child, 1_000);
      } catch {
        // Shutdown remains best-effort; OS termination below is authoritative.
      }
    }
    if (
      child !== null &&
      child.exitCode === null &&
      !exitedGracefully
    ) {
      child.kill("SIGKILL");
      await waitForExit(child, 1_000);
    }
    this.#closed = true;
    this.#closing = false;
    this.#ready = false;
    this.#child = null;
    this.#rejectAll(new GraphStoreError("GRAPH_CHILD_EXITED"));
  }

  async #abort(): Promise<void> {
    this.#activated = false;
    this.#closing = true;
    const child = this.#child;
    if (child !== null && child.exitCode === null) {
      child.kill("SIGKILL");
      await waitForExit(child, 1_000);
    }
    this.#closed = true;
    this.#closing = false;
    this.#ready = false;
    this.#child = null;
    this.#rejectAll(new GraphStoreError("GRAPH_CHILD_EXITED"));
  }

  async #ensureReady(): Promise<void> {
    if (this.#closed || this.#closing) {
      throw new GraphStoreError("GRAPH_CHILD_EXITED");
    }
    if (this.#ready && this.#child !== null) {
      return;
    }
    if (this.#circuitOpenUntil > Date.now()) {
      throw new GraphStoreError("GRAPH_CIRCUIT_OPEN", {
        retryable: true,
      });
    }
    if (this.#circuitOpenUntil !== 0) {
      this.#circuitOpenUntil = 0;
      this.#lastFailure = null;
    }
    await this.#startChild(this.#generation > 0);
  }

  #startChild(countRestart: boolean): Promise<void> {
    if (this.#startPromise !== null) {
      return this.#startPromise;
    }
    const promise = this.#launchChild(countRestart);
    this.#startPromise = promise;
    void promise.finally(() => {
      if (this.#startPromise === promise) {
        this.#startPromise = null;
      }
    }).catch(() => undefined);
    return promise;
  }

  async #launchChild(countRestart: boolean): Promise<void> {
    if (countRestart && !this.#admitRestart()) {
      throw new GraphStoreError("GRAPH_CIRCUIT_OPEN", {
        retryable: true,
      });
    }
    this.#generation += 1;
    const generation = this.#generation;
    if (countRestart) {
      this.#restartCount += 1;
    }
    const startupConfig = {
      protocol_version: GRAPH_PROCESS_PROTOCOL_VERSION,
      database_path: this.#layout.databasePath,
      database_path_hash: this.#layout.databasePathHash,
      expected_identity: this.#options.expectedIdentity,
      process_generation: generation,
      restart_count: this.#restartCount,
      max_ipc_bytes: this.#options.maxIpcBytes,
      ...(this.#options.testHooks?.identityOverride === undefined
        ? {}
        : {
            test_identity_override:
              this.#options.testHooks.identityOverride,
          }),
      ...(
          this.#options.testHooks?.adversarialNativeQuery !== true &&
            this.#options.testHooks?.adversarialNativeWrite !== true
        ? {}
        : {
            test_hooks: {
              adversarial_native_query:
                this.#options.testHooks?.adversarialNativeQuery === true,
              adversarial_native_write:
                this.#options.testHooks?.adversarialNativeWrite === true,
            },
          }
      ),
    };
    const encoded = Buffer.from(
      JSON.stringify(startupConfig),
      "utf8",
    ).toString("base64url");
    const child = fork(
      fileURLToPath(this.#options.childEntry),
      [encoded],
      {
        env: this.#environment,
        execArgv: [],
        serialization: "json",
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    this.#child = child;
    this.#ready = false;
    child.stderr?.on("data", (chunk: Buffer | string) => {
      this.#diagnostic({
        operation: "process",
        generation,
        duration_ms: 0,
        outcome: "error",
        error_code: "GRAPH_CHILD_EXITED",
      });
      if (Buffer.byteLength(chunk) > this.#options.maxIpcBytes) {
        this.#quarantine(
          generation,
          "GRAPH_PROTOCOL_INVALID",
        );
      }
    });
    child.on("message", (message: unknown) => {
      this.#handleMessage(generation, message);
    });
    child.once("error", (error) => {
      this.#startupWaiter?.reject(
        new GraphStoreError("GRAPH_PROCESS_START_FAILED", {
          cause: error,
          retryable: true,
        }),
      );
    });
    child.once("exit", () => {
      this.#handleExit(generation);
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new GraphStoreError("GRAPH_PROCESS_START_FAILED", {
            retryable: true,
          }),
        );
        this.#quarantine(
          generation,
          "GRAPH_PROCESS_START_FAILED",
        );
      }, this.#options.startupTimeoutMs);
      timer.unref();
      this.#startupWaiter = {
        generation,
        timer,
        resolve,
        reject,
      };
    });
  }

  #admitRestart(): boolean {
    const now = Date.now();
    const windowStart = now - this.#options.restartPolicy.windowMs;
    while (
      this.#restartTimes[0] !== undefined &&
      this.#restartTimes[0] < windowStart
    ) {
      this.#restartTimes.shift();
    }
    if (
      this.#restartTimes.length >=
      this.#options.restartPolicy.maxRestarts
    ) {
      this.#circuitOpenUntil =
        now + this.#options.restartPolicy.cooldownMs;
      this.#lastFailure = "GRAPH_CIRCUIT_OPEN";
      return false;
    }
    this.#restartTimes.push(now);
    return true;
  }

  async #request(
    operation: GraphOperation,
    payload: unknown,
    schema: z.ZodType,
    timeoutMs: number,
    allowClosing = false,
  ): Promise<unknown> {
    if (!allowClosing) {
      await this.#ensureReady();
    }
    const child = this.#child;
    if (
      child === null ||
      !this.#ready ||
      !child.connected ||
      (this.#closing && !allowClosing)
    ) {
      throw new GraphStoreError("GRAPH_CHILD_EXITED", {
        retryable: true,
      });
    }
    const request = GraphIpcRequestSchema.parse({
      protocol_version: GRAPH_PROCESS_PROTOCOL_VERSION,
      kind: "request",
      request_id: randomUUID(),
      operation,
      payload,
    });
    const generation = this.#generation;
    const startedAt = performance.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.#pending.get(request.request_id);
        if (pending === undefined || pending.generation !== generation) {
          return;
        }
        this.#pending.delete(request.request_id);
        const error = new GraphStoreError(
          "GRAPH_DEADLINE_EXCEEDED",
          { retryable: true },
        );
        reject(error);
        this.#diagnostic({
          operation,
          generation,
          duration_ms: performance.now() - startedAt,
          outcome: "timeout",
          error_code: error.code,
        });
        this.#quarantine(generation, error.code);
      }, timeoutMs);
      timer.unref();
      this.#pending.set(request.request_id, {
        generation,
        operation,
        schema,
        startedAt,
        timer,
        resolve,
        reject,
      });
      child.send(request, (error) => {
        if (error === null) {
          return;
        }
        const pending = this.#pending.get(request.request_id);
        if (pending === undefined) {
          return;
        }
        clearTimeout(pending.timer);
        this.#pending.delete(request.request_id);
        reject(
          new GraphStoreError("GRAPH_CHILD_EXITED", {
            cause: error,
            retryable: true,
          }),
        );
        this.#quarantine(generation, "GRAPH_CHILD_EXITED");
      });
    });
  }

  #handleMessage(generation: number, input: unknown): void {
    let message: ReturnType<typeof parseBoundedGraphIpcResponse>;
    try {
      message = parseBoundedGraphIpcResponse(
        input,
        this.#options.maxIpcBytes,
      );
    } catch (error) {
      this.#startupWaiter?.reject(
        new GraphStoreError("GRAPH_PROTOCOL_INVALID", {
          cause: error,
        }),
      );
      this.#rejectGeneration(
        generation,
        new GraphStoreError("GRAPH_PROTOCOL_INVALID", {
          cause: error,
        }),
      );
      this.#quarantine(generation, "GRAPH_PROTOCOL_INVALID");
      return;
    }
    if (message.kind === "startup_error") {
      const startup = this.#startupWaiter;
      if (startup?.generation === generation) {
        clearTimeout(startup.timer);
        this.#startupWaiter = null;
        startup.reject(
          new GraphStoreError(message.error.code, {
            retryable: message.error.retryable,
          }),
        );
      }
      this.#quarantine(generation, message.error.code);
      return;
    }
    if (message.kind === "ready") {
      const startup = this.#startupWaiter;
      if (startup === null || startup.generation !== generation) {
        this.#quarantine(generation, "GRAPH_PROTOCOL_INVALID");
        return;
      }
      if (
        canonicalJson(message.identity) !==
          canonicalJson(this.#options.expectedIdentity) ||
        message.database_path_hash !==
          this.#layout.databasePathHash
      ) {
        clearTimeout(startup.timer);
        this.#startupWaiter = null;
        const error = new GraphStoreError(
          "GRAPH_IDENTITY_MISMATCH",
        );
        startup.reject(error);
        this.#quarantine(generation, error.code);
        return;
      }
      clearTimeout(startup.timer);
      this.#startupWaiter = null;
      this.#ready = true;
      this.#lastFailure = null;
      startup.resolve();
      this.#diagnostic({
        operation: "startup",
        generation,
        duration_ms: 0,
        outcome: "ok",
      });
      return;
    }

    const pending = this.#pending.get(message.request_id);
    if (pending === undefined) {
      this.#diagnostic({
        operation: message.operation,
        generation,
        duration_ms: 0,
        outcome: "discarded",
      });
      return;
    }
    if (
      pending.generation !== generation ||
      pending.operation !== message.operation
    ) {
      this.#rejectGeneration(
        generation,
        new GraphStoreError("GRAPH_PROTOCOL_INVALID"),
      );
      this.#quarantine(generation, "GRAPH_PROTOCOL_INVALID");
      return;
    }
    clearTimeout(pending.timer);
    this.#pending.delete(message.request_id);
    if (!message.ok) {
      const error = new GraphStoreError(
        message.error?.code ?? "GRAPH_UNKNOWN_WORK",
        {
          retryable: message.error?.retryable ?? false,
        },
      );
      pending.reject(error);
      this.#diagnostic({
        operation: pending.operation,
        generation,
        duration_ms: performance.now() - pending.startedAt,
        outcome: "error",
        error_code: error.code,
      });
      return;
    }
    try {
      const parsed = pending.schema.parse(message.payload);
      pending.resolve(parsed);
      this.#diagnostic({
        operation: pending.operation,
        generation,
        duration_ms: performance.now() - pending.startedAt,
        outcome: "ok",
      });
    } catch (error) {
      pending.reject(
        new GraphStoreError("GRAPH_PROTOCOL_INVALID", {
          cause: error,
        }),
      );
      this.#quarantine(generation, "GRAPH_PROTOCOL_INVALID");
    }
  }

  #handleExit(generation: number): void {
    if (this.#startupWaiter?.generation === generation) {
      clearTimeout(this.#startupWaiter.timer);
      this.#startupWaiter.reject(
        new GraphStoreError("GRAPH_CHILD_EXITED", {
          retryable: true,
        }),
      );
      this.#startupWaiter = null;
    }
    this.#rejectGeneration(
      generation,
      new GraphStoreError("GRAPH_CHILD_EXITED", {
        retryable: true,
      }),
    );
    if (generation === this.#generation) {
      this.#ready = false;
      this.#child = null;
      if (this.#lastFailure === null) {
        this.#lastFailure = "GRAPH_CHILD_EXITED";
      }
    }
    this.#diagnostic({
      operation: "process",
      generation,
      duration_ms: 0,
      outcome: "exit",
      error_code: this.#lastFailure ?? "GRAPH_CHILD_EXITED",
    });
    if (
      this.#activated &&
      !this.#closed &&
      !this.#closing &&
      this.#circuitOpenUntil <= Date.now()
    ) {
      queueMicrotask(() => {
        void this.#startChild(true).catch(() => undefined);
      });
    }
  }

  #quarantine(
    generation: number,
    code: GraphFailureCode,
  ): void {
    if (generation !== this.#generation) {
      return;
    }
    this.#lastFailure = code;
    this.#ready = false;
    const child = this.#child;
    if (child !== null && child.exitCode === null) {
      child.kill("SIGKILL");
    }
  }

  #rejectGeneration(
    generation: number,
    error: GraphStoreError,
  ): void {
    for (const [requestId, pending] of this.#pending) {
      if (pending.generation !== generation) {
        continue;
      }
      clearTimeout(pending.timer);
      this.#pending.delete(requestId);
      pending.reject(error);
    }
  }

  #rejectAll(error: GraphStoreError): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #diagnostic(diagnostic: GraphProcessDiagnostic): void {
    this.#options.onDiagnostic?.({
      ...diagnostic,
      duration_ms: Number(diagnostic.duration_ms.toFixed(3)),
    });
  }
}

export function graphProcessExpectedQueryHash(input: unknown): string {
  return canonicalSha256(GraphQuerySchema.parse(input));
}
