import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

import {
  WorkbenchControlBootstrapResponseSchema,
  WorkbenchEndpointMetadataSchema,
  type OperationalStatus,
  type WorkbenchControlBootstrapResponse,
  type WorkbenchEndpointMetadata,
} from "@memo-graph/contracts";
import { attachManagedMemoryMcpSession } from "@memo-graph/mcp-server";
import {
  MemoryServerConfigSchema,
  memoryRuntimeConfigIdentity,
  memoryRuntimeRootIdentity,
  startManagedRuntimeHost,
  type ManagedRuntimeHost,
} from "@memo-graph/runtime-host";
import {
  blockedOperationalStatus,
  operationalStatusFromStorageHealth,
} from "@memo-graph/storage-sqlite";
import { z } from "zod";

import {
  publishPrivateFile,
  publishWorkbenchEndpoint,
  removeOwnedArtifact,
  workbenchArtifactPaths,
} from "./lifecycle/artifacts.js";
import {
  startWorkbenchHttpServer,
  type WorkbenchHttpServer,
} from "./http/server.js";

export type MemoryWorkbenchHost = {
  endpoint: WorkbenchEndpointMetadata;
  initialBootstrap: WorkbenchControlBootstrapResponse;
  runtime: ManagedRuntimeHost | null;
  http: WorkbenchHttpServer;
  close(): Promise<void>;
};

async function settledRuntimeStatus(
  runtime: ManagedRuntimeHost,
  timeoutMs = 2_000,
): Promise<OperationalStatus> {
  const deadline = performance.now() + timeoutMs;
  while (true) {
    const health = await runtime.runtime.storage.health();
    const status = operationalStatusFromStorageHealth(health);
    const startupWorkPending =
      health.writer_queue.depth > 0 ||
      health.writer_queue.active_operation !== null;
    if (
      status.readiness !== "blocked" ||
      !startupWorkPending ||
      performance.now() >= deadline
    ) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export async function startMemoryWorkbenchHost(options: {
  config: unknown;
  runtimeDirectory: string;
  instanceId?: string;
  port?: number;
  clock?: () => string;
  onDiagnostic?: (event: {
    component: "memory_workbench_host";
    event: "runtime_blocked";
    code: string;
  }) => void;
}): Promise<MemoryWorkbenchHost> {
  const config = MemoryServerConfigSchema.parse(options.config);
  mkdirSync(config.data_root, { recursive: true, mode: 0o700 });
  const rootIdentity = memoryRuntimeRootIdentity(config.data_root);
  const configIdentity = memoryRuntimeConfigIdentity(config);
  const paths = workbenchArtifactPaths({
    runtimeDirectory: options.runtimeDirectory,
    rootIdentity,
    configIdentity,
  });
  const instanceId = z.string().min(1).max(160).parse(
    options.instanceId ?? `workbench:${randomUUID()}`,
  );
  const clock = options.clock ?? (() => new Date().toISOString());
  const controlCredential = randomBytes(32);
  let credentialIdentity: ReturnType<typeof publishPrivateFile> | null = null;
  let endpointIdentity: ReturnType<typeof publishPrivateFile> | null = null;
  let runtime: ManagedRuntimeHost | null = null;
  let http: WorkbenchHttpServer | null = null;
  let runtimeState: "ready" | "health_only" = "health_only";
  let blockedStatus: OperationalStatus | null = null;
  const createdAt = clock();
  try {
    credentialIdentity = publishPrivateFile(
      paths.controlCredentialPath,
      `${controlCredential.toString("base64url")}\n`,
    );
    try {
      runtime = await startManagedRuntimeHost({
        config,
        runtimeDirectory: paths.runtimeDirectory,
        instanceId,
        attachSession: (socket, _context, opened) =>
          attachManagedMemoryMcpSession(socket, opened),
      });
      const status = await settledRuntimeStatus(runtime);
      if (status.readiness === "blocked") {
        blockedStatus = status;
        await runtime.close();
        runtime = null;
      } else {
        runtimeState = "ready";
      }
    } catch (error) {
      options.onDiagnostic?.({
        component: "memory_workbench_host",
        event: "runtime_blocked",
        code:
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : "INTERNAL_FAILURE",
      });
      blockedStatus = blockedOperationalStatus(error, {
        invalidConfig: error instanceof z.ZodError,
      });
    }
    const health = async (): Promise<OperationalStatus> => {
      if (runtime === null) {
        return blockedStatus ?? blockedOperationalStatus(
          new Error("Runtime unavailable"),
        );
      }
      return operationalStatusFromStorageHealth(
        await runtime.runtime.storage.health(),
      );
    };
    const runtimeOwner = runtime;
    http = await startWorkbenchHttpServer({
      instanceId,
      runtimeState,
      controlCredential,
      health,
      ...(runtimeOwner === null
        ? {}
        : {
            workbenchSession: (sessionId: string) =>
              runtimeOwner.workbenchSession(sessionId),
          }),
      ...(options.port === undefined ? {} : { port: options.port }),
    });
    const readyAt = clock();
    const endpoint = WorkbenchEndpointMetadataSchema.parse({
      schema_version: "1.0.0",
      instance_id: instanceId,
      root_identity: rootIdentity,
      config_identity: configIdentity,
      runtime_state: runtimeState,
      origin: http.origin,
      port: http.port,
      process_id: process.pid,
      control_credential_path: paths.controlCredentialPath,
      runtime_descriptor_path: runtime?.descriptorPath ?? null,
      created_at: createdAt,
      ready_at: readyAt,
    });
    endpointIdentity = publishWorkbenchEndpoint(paths.endpointPath, endpoint);
    const initial = http.sessions.issueTicket();
    const initialBootstrap: WorkbenchControlBootstrapResponse =
      WorkbenchControlBootstrapResponseSchema.parse({
      schema_version: "1.0.0",
      instance_id: instanceId,
      ticket: initial.ticket,
      pairing_code: null,
      expires_at: initial.expires_at,
      });
    let closed = false;
    return {
      endpoint,
      initialBootstrap,
      runtime,
      http,
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        let firstError: unknown;
        try {
          await http?.close();
        } catch (error) {
          firstError ??= error;
        }
        try {
          await runtime?.close();
        } catch (error) {
          firstError ??= error;
        } finally {
          removeOwnedArtifact(paths.endpointPath, endpointIdentity);
          removeOwnedArtifact(
            paths.controlCredentialPath,
            credentialIdentity,
          );
          controlCredential.fill(0);
        }
        if (firstError !== undefined) {
          throw firstError;
        }
      },
    };
  } catch (error) {
    await http?.close().catch(() => undefined);
    await runtime?.close().catch(() => undefined);
    removeOwnedArtifact(paths.endpointPath, endpointIdentity);
    removeOwnedArtifact(paths.controlCredentialPath, credentialIdentity);
    controlCredential.fill(0);
    throw error;
  }
}
