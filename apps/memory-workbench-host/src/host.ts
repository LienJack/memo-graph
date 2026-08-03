import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

import {
  WorkbenchControlBootstrapResponseSchema,
  WorkbenchEndpointMetadataSchema,
  AutomaticMemoryHookCaptureResponseSchema,
  AutomaticMemoryHookDescriptorSchema,
  IdentifierSchema,
  type OperationalStatus,
  type WorkbenchHealthResult,
  type WorkbenchControlBootstrapResponse,
  type WorkbenchEndpointMetadata,
  type AutomaticMemoryHookCaptureRequest,
  type AutomaticMemoryHookCaptureResponse,
} from "@memo-graph/contracts";
import { adaptEvidenceFastL0 } from "@memo-graph/evidence-adapter";
import { attachManagedMemoryMcpSession } from "@memo-graph/mcp-server";
import { compileAutomaticRecall } from "@memo-graph/memory-kernel";
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
  publishAutomaticMemoryHookDescriptor,
  publishWorkbenchEndpoint,
  removeOwnedArtifact,
  workbenchArtifactPaths,
} from "./lifecycle/artifacts.js";
import {
  startWorkbenchHttpServer,
  type WorkbenchHttpServer,
} from "./http/server.js";
import { workbenchHealth } from "./health.js";
import { loadPackagedWorkbenchWebAssets } from "./http/web-assets.js";

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
  const principalId = IdentifierSchema.parse(config.principal_id);
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
  const hookCredential = randomBytes(32);
  let credentialIdentity: ReturnType<typeof publishPrivateFile> | null = null;
  let hookCredentialIdentity: ReturnType<typeof publishPrivateFile> | null = null;
  let hookDescriptorIdentity: ReturnType<typeof publishPrivateFile> | null = null;
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
    hookCredentialIdentity = publishPrivateFile(
      paths.hookCredentialPath,
      `${hookCredential.toString("base64url")}\n`,
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
    const health = async (): Promise<WorkbenchHealthResult> => {
      const observedAt = clock();
      if (runtime === null) {
        return workbenchHealth({
          runtimeState,
          operational:
            blockedStatus ?? blockedOperationalStatus(
              new Error("Runtime unavailable"),
              { observedAt },
            ),
          lifecycle: null,
          background: [],
          graph: null,
          observedAt,
        });
      }
      try {
        const snapshot = await runtime.health();
        return workbenchHealth({
          runtimeState,
          operational: operationalStatusFromStorageHealth(snapshot.storage, {
            observedAt,
          }),
          lifecycle: snapshot.lifecycle,
          background: snapshot.background,
          graph: snapshot.graph,
          observedAt,
        });
      } catch (error) {
        return workbenchHealth({
          runtimeState: "health_only",
          operational: blockedOperationalStatus(error, { observedAt }),
          lifecycle: null,
          background: [],
          graph: null,
          observedAt,
        });
      }
    };
    const runtimeOwner = runtime;
    const captureHookEvent = async (
      request: AutomaticMemoryHookCaptureRequest,
    ): Promise<AutomaticMemoryHookCaptureResponse> => {
      if (runtimeOwner === null) {
        throw new Error("AUTOMATIC_MEMORY_RUNTIME_UNAVAILABLE");
      }
      if (config.automatic_memory.mode === "disabled") {
        return AutomaticMemoryHookCaptureResponseSchema.parse({
          schema_version: "1.0.0",
          status: "skipped",
          event_id: request.event.event_id,
          additional_context: null,
        });
      }
      const eventText = request.event.event_kind === "user_prompt_submit"
        ? request.event.prompt
        : request.event.event_kind === "assistant_stop"
          ? request.event.last_assistant_message
          : null;
      const secretSignal = eventText !== null &&
        /(?:\b(?:ghp_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{12,})\b|\bBearer\s+[A-Za-z0-9._~-]{16,}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/u.test(
          eventText,
        );
      if (
        secretSignal ||
        (request.event.event_kind === "assistant_stop" && eventText === null)
      ) {
        return AutomaticMemoryHookCaptureResponseSchema.parse({
          schema_version: "1.0.0",
          status: secretSignal ? "rejected" : "skipped",
          event_id: request.event.event_id,
          additional_context: null,
        });
      }
      const project = await runtimeOwner.runtime.storage.registerAutomaticMemoryProject({
        principal_id: principalId,
        cwd: request.event.cwd,
        registered_at: request.event.occurred_at,
      });
      let additionalContext: string | null = null;
      if (request.event.event_kind === "user_prompt_submit") {
        try {
          additionalContext = (await compileAutomaticRecall({
            storage: runtimeOwner.runtime.storage,
            principalId,
            projectId: project.project_id,
            projectScope: project.scope,
            sessionId: request.event.session_id,
            turnId: request.event.turn_id,
            prompt: request.event.prompt,
            asOf: request.event.occurred_at,
          })).additional_context;
        } catch {
          // Automatic recall is fail-open and never blocks capture or the prompt.
        }
      }
      let evidenceId: string | null = null;
      if (eventText !== null) {
        const speaker = request.event.event_kind === "user_prompt_submit"
          ? "user"
          : "assistant";
        const adaptation = adaptEvidenceFastL0({
          idempotency_key: `hook-l0:${request.event.event_id}`,
          principal_id: principalId,
          recorded_at: request.event.occurred_at,
          batch: {
            scope: project.scope,
            outcome: "succeeded",
            items: [
              {
                kind: "conversation_turn",
                speaker,
                text: eventText,
                occurred_at: request.event.occurred_at,
                sensitivity: "internal",
              },
            ],
          },
        });
        await runtimeOwner.runtime.storage.commitEpisode({
          idempotencyKey: `hook-l0:${request.event.event_id}`,
          episode: adaptation.episode,
          evidence: adaptation.evidence,
          blobs: [],
        });
        evidenceId = adaptation.evidence[0]?.evidence_id ?? null;
        if (evidenceId === null) {
          throw new Error("AUTOMATIC_MEMORY_EVIDENCE_MISSING");
        }
      }
      await runtimeOwner.runtime.storage.captureAutomaticMemoryEvent({
        schema_version: "1.0.0",
        idempotency_key: request.idempotency_key,
        principal_id: principalId,
        project_id: project.project_id,
        evidence_id: evidenceId,
        source: request.source,
        captured_at: request.event.occurred_at,
        stabilization_delay_ms: 1_500,
        event: request.event,
      });
      return AutomaticMemoryHookCaptureResponseSchema.parse({
        schema_version: "1.0.0",
        status: "accepted",
        event_id: request.event.event_id,
        additional_context: additionalContext,
      });
    };
    const webAssets = loadPackagedWorkbenchWebAssets();
    http = await startWorkbenchHttpServer({
      instanceId,
      runtimeState,
      controlCredential,
      hookCredential,
      health,
      webAssets,
      ...(runtimeOwner === null
        ? {}
        : {
            workbenchSession: (sessionId: string) =>
              runtimeOwner.workbenchSession(sessionId),
            hookCapture: captureHookEvent,
          }),
      ...(options.port === undefined ? {} : { port: options.port }),
    });
    const readyAt = clock();
    const hookDescriptor = AutomaticMemoryHookDescriptorSchema.parse({
      schema_version: "1.0.0",
      instance_id: instanceId,
      root_identity: rootIdentity,
      config_identity: configIdentity,
      origin: http.origin,
      credential_path: paths.hookCredentialPath,
      capture_path: "/__hooks/capture",
      created_at: createdAt,
      ready_at: readyAt,
    });
    hookDescriptorIdentity = publishAutomaticMemoryHookDescriptor(
      paths.hookDescriptorPath,
      hookDescriptor,
    );
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
          removeOwnedArtifact(paths.hookDescriptorPath, hookDescriptorIdentity);
          removeOwnedArtifact(
            paths.hookCredentialPath,
            hookCredentialIdentity,
          );
          controlCredential.fill(0);
          hookCredential.fill(0);
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
    removeOwnedArtifact(paths.hookDescriptorPath, hookDescriptorIdentity);
    removeOwnedArtifact(paths.hookCredentialPath, hookCredentialIdentity);
    controlCredential.fill(0);
    hookCredential.fill(0);
    throw error;
  }
}
