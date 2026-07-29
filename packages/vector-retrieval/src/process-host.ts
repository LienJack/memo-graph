import { randomUUID } from "node:crypto";
import {
  fork,
  type ChildProcess,
} from "node:child_process";
import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  VectorEmbeddingEpochSchema,
  VectorProcessHealthSchema,
  VectorQueryResultSchema,
  VectorQuerySchema,
  VectorScopeSnapshotSchema,
  ScopeSchema,
  IdentifierSchema,
  canonicalJson,
  type VectorEmbeddingEpoch,
  type VectorFailureCategory,
  type VectorProcessHealth,
  type VectorQuery,
  type VectorQueryResult,
  type VectorScopeSnapshot,
} from "@memo-graph/contracts";
import { z } from "zod";

import {
  createVectorChildEnvironment,
  prepareVectorPaths,
  type VectorPathLayout,
} from "./path-security.js";
import {
  DEFAULT_VECTOR_IPC_MAX_BYTES,
  QUALIFIED_VECTOR_RUNTIME_IDENTITY,
  VECTOR_OPERATION_RESULT_SCHEMAS,
  VECTOR_PROCESS_PROTOCOL_VERSION,
  VectorIpcRequestSchema,
  parseBoundedVectorIpcResponse,
  type VectorOperation,
} from "./protocol.js";

const RestartPolicySchema = z
  .object({
    maxRestarts: z.number().int().min(1).max(1_000),
    windowMs: z.number().int().min(100).max(600_000),
    cooldownMs: z.number().int().min(100).max(600_000),
  })
  .strict();

export class VectorRuntimeError extends Error {
  readonly category: VectorFailureCategory;
  readonly retryable: boolean;

  constructor(
    category: VectorFailureCategory,
    options: {
      retryable?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(`vector runtime failure: ${category}`, {
      ...(options.cause === undefined
        ? {}
        : { cause: options.cause }),
    });
    this.name = "VectorRuntimeError";
    this.category = category;
    this.retryable = options.retryable ?? false;
  }
}

export type VectorProcessDiagnostic = {
  operation: VectorOperation | "startup" | "process";
  generation: number;
  duration_ms: number;
  outcome: "ok" | "error" | "timeout" | "discarded" | "exit";
  failure_category?: VectorFailureCategory;
};

export type VectorProcessHostOptions = {
  dataRoot: string;
  modelRoot: string;
  principalId: string;
  scope: z.input<typeof ScopeSchema>;
  expectedEpoch: VectorEmbeddingEpoch;
  childEntry?: URL;
  requestTimeoutMs?: number;
  writeTimeoutMs?: number;
  startupTimeoutMs?: number;
  maxIpcBytes?: number;
  maxConcurrentRequests?: number;
  restartPolicy?: {
    maxRestarts: number;
    windowMs: number;
    cooldownMs: number;
  };
  onDiagnostic?: (diagnostic: VectorProcessDiagnostic) => void;
};

type PendingRequest = {
  generation: number;
  operation: VectorOperation;
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

function defaultChildEntry(): URL {
  const compiled = new URL("./vector-process.js", import.meta.url);
  if (existsSync(fileURLToPath(compiled))) {
    return compiled;
  }
  throw new VectorRuntimeError("DEPENDENCY_UNAVAILABLE");
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

async function withinDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new VectorRuntimeError("PROCESS_TIMEOUT", {
              retryable: true,
            }),
          );
        }, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function asRuntimeError(
  error: unknown,
  fallback: VectorFailureCategory,
): VectorRuntimeError {
  return error instanceof VectorRuntimeError
    ? error
    : new VectorRuntimeError(fallback, {
        retryable: true,
        cause: error,
      });
}

function unavailableResult(
  query: VectorQuery,
  category: VectorFailureCategory,
): VectorQueryResult {
  return VectorQueryResultSchema.parse({
    schema_version: "1.0.0",
    request_id: query.request_id,
    status: "degraded",
    embedding_epoch_id: query.embedding_epoch_id,
    generation_id: query.generation_id,
    source_frontier_hash: query.source_frontier_hash,
    hits: [],
    complete: false,
    reason_codes: [`VECTOR_${category}`],
    failure_category: category,
  });
}

export class VectorProcessHost {
  readonly #options: {
    expectedEpoch: VectorEmbeddingEpoch;
    principalId: string;
    scope: z.infer<typeof ScopeSchema>;
    childEntry: URL;
    requestTimeoutMs: number;
    writeTimeoutMs: number;
    startupTimeoutMs: number;
    maxIpcBytes: number;
    maxConcurrentRequests: number;
    restartPolicy: z.infer<typeof RestartPolicySchema>;
    onDiagnostic:
      | ((diagnostic: VectorProcessDiagnostic) => void)
      | undefined;
  };
  readonly #layout: VectorPathLayout;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #restartTimes: number[] = [];
  #child: ChildProcess | null = null;
  #generation = 0;
  #restartCount = 0;
  #inFlightRequests = 0;
  #ready = false;
  #activated = false;
  #closed = false;
  #closing = false;
  #lastFailure: VectorFailureCategory | null = null;
  #cooldownUntil = 0;
  #startPromise: Promise<void> | null = null;
  #startupWaiter: StartupWaiter | null = null;

  private constructor(options: {
    input: VectorProcessHostOptions;
    layout: VectorPathLayout;
    environment: NodeJS.ProcessEnv;
  }) {
    this.#layout = options.layout;
    this.#environment = options.environment;
    this.#options = {
      expectedEpoch: VectorEmbeddingEpochSchema.parse(
        options.input.expectedEpoch,
      ),
      principalId: IdentifierSchema.parse(options.input.principalId),
      scope: ScopeSchema.parse(options.input.scope),
      childEntry: options.input.childEntry ?? defaultChildEntry(),
      requestTimeoutMs: z.number().int().min(1).max(60_000).parse(
        options.input.requestTimeoutMs ?? 75,
      ),
      writeTimeoutMs: z.number().int().min(1).max(120_000).parse(
        options.input.writeTimeoutMs ?? 5_000,
      ),
      startupTimeoutMs: z.number().int().min(1).max(60_000).parse(
        options.input.startupTimeoutMs ?? 2_000,
      ),
      maxIpcBytes: z
        .number()
        .int()
        .min(1_024)
        .max(16 * 1_024 * 1_024)
        .parse(
          options.input.maxIpcBytes ?? DEFAULT_VECTOR_IPC_MAX_BYTES,
        ),
      maxConcurrentRequests: z.number().int().min(1).max(10_000).parse(
        options.input.maxConcurrentRequests ?? 64,
      ),
      restartPolicy: RestartPolicySchema.parse(
        options.input.restartPolicy ?? {
          maxRestarts: 3,
          windowMs: 10_000,
          cooldownMs: 30_000,
        },
      ),
      onDiagnostic: options.input.onDiagnostic,
    };
  }

  static async open(
    input: VectorProcessHostOptions,
  ): Promise<VectorProcessHost> {
    const layout = await prepareVectorPaths({
      dataRoot: input.dataRoot,
      modelRoot: input.modelRoot,
      principalId: input.principalId,
      scope: input.scope,
    });
    const host = new VectorProcessHost({
      input,
      layout,
      environment: await createVectorChildEnvironment({
        dataRoot: layout.dataRoot,
      }),
    });
    try {
      await host.#startChild(false);
      await host.#request(
        "initialize",
        null,
        VECTOR_OPERATION_RESULT_SCHEMAS.initialize,
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

  pathLayout(): VectorPathLayout {
    return { ...this.#layout };
  }

  processHealth(): VectorProcessHealth {
    const cooldown = this.#cooldownUntil > Date.now();
    return VectorProcessHealthSchema.parse({
      schema_version: "1.0.0",
      status: this.#closed
        ? "closed"
        : cooldown
          ? "cooldown"
          : this.#ready
            ? "ready"
            : this.#startPromise !== null
              ? "starting"
              : "quarantined",
      embedding_epoch_id:
        this.#ready ? this.#options.expectedEpoch.epoch_id : null,
      process_id: this.#ready ? this.#child?.pid ?? null : null,
      restart_count: this.#restartCount,
      failure_category:
        cooldown ? "PROCESS_EXIT" : this.#lastFailure,
      reason:
        cooldown || this.#lastFailure !== null
          ? "vector child is unavailable"
          : null,
    });
  }

  async waitUntilHealthy(timeoutMs: number): Promise<boolean> {
    const deadline = performance.now() + timeoutMs;
    while (!this.#closed && performance.now() <= deadline) {
      try {
        await this.#ensureReady();
        const health = await this.health();
        if (health.status === "ready") {
          return true;
        }
      } catch {
        // A bounded health wait reports transient failure as false.
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5);
        timer.unref();
      });
    }
    return false;
  }

  async health(): Promise<VectorProcessHealth> {
    if (!this.#ready) {
      return this.processHealth();
    }
    return await this.#request(
      "health",
      null,
      VECTOR_OPERATION_RESULT_SCHEMAS.health,
      this.#options.requestTimeoutMs,
    ) as VectorProcessHealth;
  }

  async replaceScope(input: unknown): Promise<VectorScopeSnapshot> {
    const snapshot = VectorScopeSnapshotSchema.parse(input);
    if (
      snapshot.embedding_epoch_id !==
      this.#options.expectedEpoch.epoch_id
    ) {
      throw new VectorRuntimeError("EPOCH_STALE");
    }
    if (
      snapshot.principal_id !== this.#options.principalId ||
      canonicalJson(snapshot.scope) !==
        canonicalJson(this.#options.scope)
    ) {
      throw new VectorRuntimeError("PROTOCOL_INVALID");
    }
    return await this.#request(
      "replace_scope",
      snapshot,
      VECTOR_OPERATION_RESULT_SCHEMAS.replace_scope,
      this.#options.writeTimeoutMs,
    ) as VectorScopeSnapshot;
  }

  async deleteScope(): Promise<void> {
    await this.#request(
      "delete_scope",
      null,
      VECTOR_OPERATION_RESULT_SCHEMAS.delete_scope,
      this.#options.writeTimeoutMs,
    );
  }

  async readScopeSnapshot(): Promise<VectorScopeSnapshot | null> {
    return await this.#request(
      "read_scope_snapshot",
      null,
      VECTOR_OPERATION_RESULT_SCHEMAS.read_scope_snapshot,
      this.#options.writeTimeoutMs,
    ) as VectorScopeSnapshot | null;
  }

  async query(input: unknown): Promise<VectorQueryResult> {
    const query = VectorQuerySchema.parse(input);
    if (
      query.principal_id !== this.#options.principalId ||
      canonicalJson(query.scope) !==
        canonicalJson(this.#options.scope)
    ) {
      return unavailableResult(query, "PROTOCOL_INVALID");
    }
    if (
      query.embedding_epoch_id !==
      this.#options.expectedEpoch.epoch_id
    ) {
      return unavailableResult(query, "EPOCH_STALE");
    }
    try {
      return await this.#request(
        "query",
        query,
        VECTOR_OPERATION_RESULT_SCHEMAS.query,
        Math.min(
          query.parent_deadline_ms,
          this.#options.requestTimeoutMs,
        ),
      ) as VectorQueryResult;
    } catch (error) {
      return unavailableResult(
        query,
        asRuntimeError(error, "PROCESS_EXIT").category,
      );
    }
  }

  async close(): Promise<void> {
    if (this.#closed || this.#closing) {
      return;
    }
    this.#closing = true;
    const child = this.#child;
    let graceful = false;
    if (child !== null && this.#ready && child.connected) {
      try {
        await this.#request(
          "close",
          null,
          VECTOR_OPERATION_RESULT_SCHEMAS.close,
          250,
          true,
        );
        graceful = await waitForExit(child, 1_000);
      } catch {
        // OS termination below is authoritative.
      }
    }
    if (
      child !== null &&
      child.exitCode === null &&
      !graceful
    ) {
      child.kill("SIGKILL");
      await waitForExit(child, 1_000);
    }
    this.#closed = true;
    this.#closing = false;
    this.#ready = false;
    this.#child = null;
    this.#rejectAll(new VectorRuntimeError("PROCESS_EXIT"));
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
    this.#rejectAll(new VectorRuntimeError("PROCESS_EXIT"));
  }

  async #ensureReady(): Promise<void> {
    if (this.#closed || this.#closing) {
      throw new VectorRuntimeError("PROCESS_EXIT");
    }
    if (this.#ready && this.#child !== null) {
      return;
    }
    if (this.#cooldownUntil > Date.now()) {
      throw new VectorRuntimeError("PROCESS_EXIT", {
        retryable: true,
      });
    }
    if (this.#cooldownUntil !== 0) {
      this.#cooldownUntil = 0;
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
      throw new VectorRuntimeError("PROCESS_EXIT", {
        retryable: true,
      });
    }
    this.#generation += 1;
    const generation = this.#generation;
    if (countRestart) {
      this.#restartCount += 1;
    }
    const startupConfig = {
      protocol_version: VECTOR_PROCESS_PROTOCOL_VERSION,
      database_path: this.#layout.databasePath,
      database_path_hash: this.#layout.databasePathHash,
      model_root: this.#layout.modelRoot,
      expected_epoch: this.#options.expectedEpoch,
      process_generation: generation,
      restart_count: this.#restartCount,
      max_ipc_bytes: this.#options.maxIpcBytes,
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
      if (Buffer.byteLength(chunk) > this.#options.maxIpcBytes) {
        this.#quarantine(generation, "PROTOCOL_INVALID");
      }
    });
    child.on("message", (message: unknown) => {
      this.#handleMessage(generation, message);
    });
    child.once("error", (error) => {
      this.#rejectStartup(
        generation,
        new VectorRuntimeError("PROCESS_EXIT", {
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
        const error = new VectorRuntimeError("PROCESS_TIMEOUT", {
          retryable: true,
        });
        reject(error);
        this.#quarantine(generation, error.category);
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
      this.#cooldownUntil =
        now + this.#options.restartPolicy.cooldownMs;
      this.#lastFailure = "PROCESS_EXIT";
      return false;
    }
    this.#restartTimes.push(now);
    return true;
  }

  async #request(
    operation: VectorOperation,
    payload: unknown,
    schema: z.ZodType,
    timeoutMs: number,
    allowClosing = false,
  ): Promise<unknown> {
    const startedAt = performance.now();
    if (
      !allowClosing &&
      this.#inFlightRequests >= this.#options.maxConcurrentRequests
    ) {
      throw new VectorRuntimeError("RESOURCE_LIMIT", {
        retryable: true,
      });
    }
    if (!allowClosing) {
      this.#inFlightRequests += 1;
    }
    try {
      if (!allowClosing) {
        await withinDeadline(this.#ensureReady(), timeoutMs);
      }
      const child = this.#child;
      if (
        child === null ||
        !this.#ready ||
        !child.connected ||
        (this.#closing && !allowClosing)
      ) {
        throw new VectorRuntimeError("PROCESS_EXIT", {
          retryable: true,
        });
      }
      const request = VectorIpcRequestSchema.parse({
        protocol_version: VECTOR_PROCESS_PROTOCOL_VERSION,
        kind: "request",
        request_id: randomUUID(),
        operation,
        payload,
      });
      const generation = this.#generation;
      const remainingMs = timeoutMs - (performance.now() - startedAt);
      if (remainingMs <= 0) {
        throw new VectorRuntimeError("PROCESS_TIMEOUT", {
          retryable: true,
        });
      }
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const pending = this.#pending.get(request.request_id);
          if (
            pending === undefined ||
            pending.generation !== generation
          ) {
            return;
          }
          this.#pending.delete(request.request_id);
          const error = new VectorRuntimeError("PROCESS_TIMEOUT", {
            retryable: true,
          });
          pending.reject(error);
          this.#diagnostic({
            operation,
            generation,
            duration_ms: performance.now() - startedAt,
            outcome: "timeout",
            failure_category: error.category,
          });
          this.#quarantine(generation, error.category);
        }, remainingMs);
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
          pending.reject(
            new VectorRuntimeError("PROCESS_EXIT", {
              cause: error,
              retryable: true,
            }),
          );
          this.#quarantine(generation, "PROCESS_EXIT");
        });
      });
    } finally {
      if (!allowClosing) {
        this.#inFlightRequests -= 1;
      }
    }
  }

  #handleMessage(generation: number, input: unknown): void {
    let message: ReturnType<typeof parseBoundedVectorIpcResponse>;
    try {
      message = parseBoundedVectorIpcResponse(
        input,
        this.#options.maxIpcBytes,
      );
    } catch (error) {
      const failure = new VectorRuntimeError("PROTOCOL_INVALID", {
        cause: error,
      });
      this.#rejectStartup(generation, failure);
      this.#rejectGeneration(generation, failure);
      this.#quarantine(generation, failure.category);
      return;
    }
    if (message.kind === "startup_error") {
      const error = new VectorRuntimeError(message.error.category, {
        retryable: message.error.retryable,
      });
      this.#rejectStartup(generation, error);
      this.#quarantine(generation, error.category);
      return;
    }
    if (message.kind === "ready") {
      const startup = this.#startupWaiter;
      if (
        startup === null ||
        startup.generation !== generation ||
        canonicalJson(message.epoch) !==
          canonicalJson(this.#options.expectedEpoch) ||
        canonicalJson(message.runtime) !==
          canonicalJson(QUALIFIED_VECTOR_RUNTIME_IDENTITY) ||
        message.database_path_hash !==
          this.#layout.databasePathHash
      ) {
        const error = new VectorRuntimeError(
          "MODEL_IDENTITY_MISMATCH",
        );
        this.#rejectStartup(generation, error);
        this.#quarantine(generation, error.category);
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
      const error = new VectorRuntimeError("PROTOCOL_INVALID");
      this.#rejectGeneration(generation, error);
      this.#quarantine(generation, error.category);
      return;
    }
    clearTimeout(pending.timer);
    this.#pending.delete(message.request_id);
    if (!message.ok) {
      const error = new VectorRuntimeError(
        message.error?.category ?? "PROTOCOL_INVALID",
        { retryable: message.error?.retryable ?? false },
      );
      pending.reject(error);
      this.#diagnostic({
        operation: pending.operation,
        generation,
        duration_ms: performance.now() - pending.startedAt,
        outcome: "error",
        failure_category: error.category,
      });
      return;
    }
    try {
      pending.resolve(pending.schema.parse(message.payload));
      this.#diagnostic({
        operation: pending.operation,
        generation,
        duration_ms: performance.now() - pending.startedAt,
        outcome: "ok",
      });
    } catch (error) {
      pending.reject(
        new VectorRuntimeError("PROTOCOL_INVALID", {
          cause: error,
        }),
      );
      this.#quarantine(generation, "PROTOCOL_INVALID");
    }
  }

  #handleExit(generation: number): void {
    const error = new VectorRuntimeError("PROCESS_EXIT", {
      retryable: true,
    });
    this.#rejectStartup(generation, error);
    this.#rejectGeneration(generation, error);
    if (generation === this.#generation) {
      this.#ready = false;
      this.#child = null;
      this.#lastFailure ??= "PROCESS_EXIT";
    }
    this.#diagnostic({
      operation: "process",
      generation,
      duration_ms: 0,
      outcome: "exit",
      failure_category: this.#lastFailure ?? "PROCESS_EXIT",
    });
    if (
      generation !== this.#generation ||
      !this.#activated ||
      this.#closed ||
      this.#closing ||
      this.#cooldownUntil > Date.now()
    ) {
      return;
    }
    queueMicrotask(() => {
      if (
        generation !== this.#generation ||
        !this.#activated ||
        this.#closed ||
        this.#closing
      ) {
        return;
      }
      void this.#startChild(true).catch(() => undefined);
    });
  }

  #rejectStartup(
    generation: number,
    error: VectorRuntimeError,
  ): void {
    const startup = this.#startupWaiter;
    if (startup === null || startup.generation !== generation) {
      return;
    }
    clearTimeout(startup.timer);
    this.#startupWaiter = null;
    startup.reject(error);
  }

  #quarantine(
    generation: number,
    category: VectorFailureCategory,
  ): void {
    if (generation !== this.#generation) {
      return;
    }
    this.#lastFailure = category;
    this.#ready = false;
    const child = this.#child;
    if (child !== null && child.exitCode === null) {
      child.kill("SIGKILL");
    }
  }

  #rejectGeneration(
    generation: number,
    error: VectorRuntimeError,
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

  #rejectAll(error: VectorRuntimeError): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #diagnostic(diagnostic: VectorProcessDiagnostic): void {
    this.#options.onDiagnostic?.({
      ...diagnostic,
      duration_ms: Number(diagnostic.duration_ms.toFixed(3)),
    });
  }
}
