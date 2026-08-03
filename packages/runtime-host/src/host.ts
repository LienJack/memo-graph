import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { canonicalJson } from "@memo-graph/contracts";
import {
  WorkbenchApprovalRegistry,
  type WorkbenchService,
} from "@memo-graph/memory-kernel";
import { z } from "zod";

import {
  MEMORY_HOST_IPC_PROTOCOL,
  ManagedHostDescriptorSchema,
  authenticateServerSocket,
  type ManagedHostDescriptor,
} from "./ipc-handshake.js";
import {
  openMemoryRuntime,
  type OpenedMemoryRuntime,
} from "./runtime-factory.js";
import { InMemoryWorkbenchSnapshotRegistry } from "./snapshot-registry.js";

export type RuntimeHostSessionContext = {
  session_id: string;
  instance_id: string;
  root_identity: ManagedHostDescriptor["root_identity"];
  config_identity: ManagedHostDescriptor["config_identity"];
};

export type RuntimeHostSessionHandle = {
  close(): Promise<void>;
};

export type ManagedRuntimeHost = {
  descriptorPath: string;
  descriptor: ManagedHostDescriptor;
  runtime: OpenedMemoryRuntime;
  workbenchSession(sessionId: string): WorkbenchService;
  health(): Promise<{
    lifecycle: "ready" | "draining" | "stopped";
    storage: Awaited<ReturnType<OpenedMemoryRuntime["storage"]["health"]>>;
    graph: Awaited<ReturnType<OpenedMemoryRuntime["storage"]["graphProjectionStatus"]>> | null;
    background: ReturnType<NonNullable<OpenedMemoryRuntime["supervisor"]>["observations"]>;
  }>;
  close(): Promise<void>;
};

type FileIdentity = { dev: number; ino: number };

function assertPrivateRuntimeDirectory(pathInput: string): string {
  const path = resolve(pathInput);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const before = lstatSync(path);
  if (
    before.isSymbolicLink() ||
    !before.isDirectory() ||
    realpathSync(path) !== path
  ) {
    throw new Error("runtime directory is not private");
  }
  chmodSync(path, 0o700);
  const stat = lstatSync(path);
  const expectedUid = process.getuid?.();
  if (
    (stat.mode & 0o077) !== 0 ||
    (expectedUid !== undefined && stat.uid !== expectedUid)
  ) {
    throw new Error("runtime directory is not private");
  }
  return path;
}

function publishPrivateFile(path: string, bytes: Buffer | string): FileIdentity {
  const temporary = `${path}.tmp-${randomUUID()}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, path);
    unlinkSync(temporary);
    const stat = lstatSync(path);
    return { dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    if (existsSync(temporary)) {
      unlinkSync(temporary);
    }
    throw error;
  }
}

function unlinkIfOwned(path: string, identity: FileIdentity | null): void {
  if (identity === null || !existsSync(path)) {
    return;
  }
  const stat = lstatSync(path);
  if (
    !stat.isSymbolicLink() &&
    stat.dev === identity.dev &&
    stat.ino === identity.ino
  ) {
    unlinkSync(path);
  }
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(path);
  });
}

export async function startManagedRuntimeHost(options: {
  config: unknown;
  runtimeDirectory: string;
  attachSession(
    socket: Socket,
    context: RuntimeHostSessionContext,
    runtime: OpenedMemoryRuntime,
  ): Promise<RuntimeHostSessionHandle>;
  instanceId?: string;
  clock?: () => string;
  handshakeTimeoutMs?: number;
  maxIpcSessions?: number;
  onDiagnostic?: (event: {
    component: "runtime_host";
    event: "session_rejected" | "listener_error";
    code: string;
  }) => void;
}): Promise<ManagedRuntimeHost> {
  const runtimeDirectory = assertPrivateRuntimeDirectory(options.runtimeDirectory);
  const instanceId = z
    .string()
    .min(1)
    .max(160)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
    .parse(options.instanceId ?? `host:${randomUUID()}`);
  const clock = options.clock ?? (() => new Date().toISOString());
  const maxIpcSessions = z.number().int().min(1).max(256)
    .parse(options.maxIpcSessions ?? 64);
  const runtime = await openMemoryRuntime(options.config, { mode: "managed" });
  const identityStem = [
    runtime.rootIdentity.canonical_root_hash.slice("sha256:".length, 14),
    runtime.configIdentity.slice("sha256:".length, 14),
  ].join("-");
  const localSocketPath = join(runtimeDirectory, `h-${identityStem}.sock`);
  const socketPath =
    Buffer.byteLength(localSocketPath, "utf8") <= 100
      ? localSocketPath
      : join(
          assertPrivateRuntimeDirectory(
            join(
              realpathSync(tmpdir()),
              `memo-graph-ipc-${process.getuid?.() ?? "local"}`,
            ),
          ),
          `h-${identityStem}.sock`,
        );
  if (Buffer.byteLength(socketPath, "utf8") > 100) {
    await runtime.close();
    throw new Error("private IPC socket path is too long");
  }
  const descriptorPath = join(runtimeDirectory, `h-${identityStem}.json`);
  const credentialPath = join(runtimeDirectory, `h-${identityStem}.key`);
  const credential = randomBytes(32);
  let credentialIdentity: FileIdentity | null = null;
  let descriptorIdentity: FileIdentity | null = null;
  let socketIdentity: FileIdentity | null = null;
  let server: Server | null = null;
  const sockets = new Set<Socket>();
  const handles = new Map<Socket, RuntimeHostSessionHandle>();
  const snapshotRegistry = new InMemoryWorkbenchSnapshotRegistry({ instanceId });
  const workbenchSessions = new Map<
    string,
    { service: WorkbenchService; approvals: WorkbenchApprovalRegistry }
  >();
  let lifecycle: "ready" | "draining" | "stopped" = "ready";
  let closed = false;
  const createdAt = clock();
  try {
    credentialIdentity = publishPrivateFile(
      credentialPath,
      `${credential.toString("base64url")}\n`,
    );
    const descriptor = ManagedHostDescriptorSchema.parse({
      schema_version: "1.0.0",
      protocol: MEMORY_HOST_IPC_PROTOCOL,
      instance_id: instanceId,
      root_identity: runtime.rootIdentity,
      config_identity: runtime.configIdentity,
      socket_path: socketPath,
      credential_path: credentialPath,
      created_at: createdAt,
      ready_at: clock(),
    });
    server = createServer({ pauseOnConnect: true }, (socket) => {
      if (sockets.size >= maxIpcSessions) {
        options.onDiagnostic?.({
          component: "runtime_host",
          event: "session_rejected",
          code: "SESSION_CAPACITY_EXCEEDED",
        });
        socket.destroy();
        return;
      }
      sockets.add(socket);
      socket.once("close", () => {
        sockets.delete(socket);
        const handle = handles.get(socket);
        handles.delete(socket);
        if (handle !== undefined) {
          void handle.close().catch(() => undefined);
        }
      });
      void (async () => {
        if (lifecycle !== "ready") {
          socket.destroy();
          return;
        }
        try {
          await authenticateServerSocket({
            socket,
            descriptor,
            credential,
            timeoutMs: options.handshakeTimeoutMs ?? 2_000,
          });
          if (lifecycle !== "ready") {
            socket.destroy();
            return;
          }
          const handle = await options.attachSession(
            socket,
            {
              session_id: `mcp:${randomUUID()}`,
              instance_id: instanceId,
              root_identity: descriptor.root_identity,
              config_identity: descriptor.config_identity,
            },
            runtime,
          );
          if (lifecycle !== "ready" || socket.destroyed) {
            await handle.close().catch(() => undefined);
            socket.destroy();
            return;
          }
          handles.set(socket, handle);
          socket.resume();
        } catch (error) {
          options.onDiagnostic?.({
            component: "runtime_host",
            event: "session_rejected",
            code:
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              typeof error.code === "string"
                ? error.code
                : "SESSION_ATTACH_FAILED",
          });
          socket.destroy();
        }
      })();
    });
    await listen(server, socketPath);
    server.on("error", (error) => {
      options.onDiagnostic?.({
        component: "runtime_host",
        event: "listener_error",
        code:
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : "HOST_LISTENER_FAILED",
      });
    });
    chmodSync(socketPath, 0o600);
    const socketStat = lstatSync(socketPath);
    socketIdentity = { dev: socketStat.dev, ino: socketStat.ino };
    descriptorIdentity = publishPrivateFile(
      descriptorPath,
      `${canonicalJson(descriptor)}\n`,
    );

    return {
      descriptorPath,
      descriptor,
      runtime,
      workbenchSession: (sessionId) => {
        if (lifecycle !== "ready") {
          throw new Error("runtime host is not accepting sessions");
        }
        const existing = workbenchSessions.get(sessionId);
        if (existing !== undefined) {
          return existing.service;
        }
        if (workbenchSessions.size >= 64) {
          throw new Error("workbench session capacity exceeded");
        }
        const approvals = new WorkbenchApprovalRegistry();
        const service = runtime.runtime.createWorkbenchService(
          snapshotRegistry.session(sessionId),
          { approvals, sessionId },
        );
        workbenchSessions.set(sessionId, { service, approvals });
        return service;
      },
      health: async () => {
        const [storage, graph] = await Promise.all([
          runtime.storage.health(),
          runtime.storage.graphProjectionStatus().catch(() => null),
        ]);
        return {
          lifecycle,
          storage,
          graph,
          background: runtime.supervisor?.observations() ?? [],
        };
      },
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        lifecycle = "draining";
        let shutdownError: unknown;
        const preserve = (error: unknown): void => {
          shutdownError ??= error;
        };
        try {
          await runtime.supervisor?.drain(5_000);
        } catch (error) {
          preserve(error);
        }
        try {
          const exactServer = server;
          const serverClosed =
            exactServer === null
              ? Promise.resolve()
              : new Promise<void>((resolveClose) => {
                  exactServer.close(() => resolveClose());
                });
          const closingHandles = [...handles.values()].map((handle) =>
            handle.close(),
          );
          handles.clear();
          for (const socket of sockets) {
            socket.destroy();
          }
          const handleResults = await Promise.allSettled(closingHandles);
          for (const result of handleResults) {
            if (result.status === "rejected") {
              preserve(result.reason);
            }
          }
          await serverClosed;
        } catch (error) {
          preserve(error);
        }
        for (const session of workbenchSessions.values()) {
          session.approvals.clear();
        }
        workbenchSessions.clear();
        snapshotRegistry.close();
        try {
          await runtime.close();
        } catch (error) {
          preserve(error);
        } finally {
          for (const [path, identity] of [
            [descriptorPath, descriptorIdentity],
            [credentialPath, credentialIdentity],
            [socketPath, socketIdentity],
          ] as const) {
            try {
              unlinkIfOwned(path, identity);
            } catch (error) {
              preserve(error);
            }
          }
          credential.fill(0);
          lifecycle = "stopped";
        }
        if (shutdownError !== undefined) {
          throw shutdownError;
        }
      },
    };
  } catch (error) {
    try {
      server?.close();
    } catch {
      // A listener that failed before binding is already closed.
    }
    for (const socket of sockets) {
      socket.destroy();
    }
    snapshotRegistry.close();
    unlinkIfOwned(descriptorPath, descriptorIdentity);
    unlinkIfOwned(credentialPath, credentialIdentity);
    unlinkIfOwned(socketPath, socketIdentity);
    credential.fill(0);
    await runtime.close().catch(() => undefined);
    throw error;
  }
}
