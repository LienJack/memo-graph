import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  connectAuthenticatedIpc,
  memoryRuntimeRootIdentity,
  readIpcCredential,
  startManagedRuntimeHost,
} from "../../packages/runtime-host/src/index.js";
import { mcpRecoveryFixture } from "../helpers/mcp-recovery.js";

const cleanupPaths: string[] = [];

function fixture() {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "memo-graph-host-recovery-")),
  );
  cleanupPaths.push(root);
  const dataRoot = join(root, "data");
  const recovery = mcpRecoveryFixture(dataRoot);
  return {
    root,
    config: {
      data_root: dataRoot,
      principal_id: "user_local",
      allowed_scopes: [{ kind: "workspace", id: "workspace_local" }],
      allowed_authorities: ["user_stated"],
      recovery_head: recovery.config,
    } as const,
  };
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path !== undefined) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe("managed Runtime host lifecycle recovery", () => {
  it("rejects a second owner, authenticates mutually, and invalidates a stale instance", async () => {
    const current = fixture();
    const runtimeDirectory = join(current.root, "runtime");
    const diagnostics: string[] = [];
    const attachSession = async () => ({ close: async () => undefined });
    const first = await startManagedRuntimeHost({
      config: current.config,
      runtimeDirectory,
      instanceId: "host:first",
      attachSession,
      onDiagnostic: (event) => diagnostics.push(event.code),
    });
    const originalCredential = readIpcCredential(
      first.descriptor.credential_path,
    );
    try {
      await expect(
        startManagedRuntimeHost({
          config: current.config,
          runtimeDirectory,
          instanceId: "host:contender",
          attachSession,
        }),
      ).rejects.toMatchObject({ code: "ROOT_LEASE_HELD" });

      const wrongCredential = Buffer.alloc(32, 0x5a);
      await expect(
        connectAuthenticatedIpc({
          descriptor: first.descriptor,
          credential: wrongCredential,
          expectedRootIdentity: first.descriptor.root_identity,
          expectedConfigIdentity: first.descriptor.config_identity,
        }),
      ).rejects.toEqual(
        expect.objectContaining({
          code: "HOST_AUTHENTICATION_FAILED",
        }),
      );
      expect(diagnostics).toContain("HOST_AUTHENTICATION_FAILED");
    } finally {
      await first.close();
    }

    const replacement = await startManagedRuntimeHost({
      config: current.config,
      runtimeDirectory,
      instanceId: "host:replacement",
      attachSession,
    });
    try {
      await expect(
        connectAuthenticatedIpc({
          descriptor: first.descriptor,
          credential: originalCredential,
          expectedRootIdentity: first.descriptor.root_identity,
          expectedConfigIdentity: first.descriptor.config_identity,
        }),
      ).rejects.toEqual(
        expect.objectContaining({
          code: "HOST_IDENTITY_MISMATCH",
        }),
      );
      const replacementCredential = readIpcCredential(
        replacement.descriptor.credential_path,
      );
      const attached = await connectAuthenticatedIpc({
        descriptor: replacement.descriptor,
        credential: replacementCredential,
        expectedRootIdentity: replacement.descriptor.root_identity,
        expectedConfigIdentity: replacement.descriptor.config_identity,
      });
      replacementCredential.fill(0);
      attached.destroy();
    } finally {
      originalCredential.fill(0);
      await replacement.close();
    }
  }, 30_000);

  it("rejects a host bound to the previous inode when the root path is replaced", async () => {
    const current = fixture();
    const host = await startManagedRuntimeHost({
      config: current.config,
      runtimeDirectory: join(current.root, "runtime"),
      instanceId: "host:old-root",
      attachSession: async () => ({ close: async () => undefined }),
    });
    const credential = readIpcCredential(host.descriptor.credential_path);
    const previousRoot = `${current.config.data_root}-previous`;
    renameSync(current.config.data_root, previousRoot);
    mkdirSync(current.config.data_root, { mode: 0o700 });
    try {
      await expect(
        connectAuthenticatedIpc({
          descriptor: host.descriptor,
          credential,
          expectedRootIdentity: memoryRuntimeRootIdentity(
            current.config.data_root,
          ),
          expectedConfigIdentity: host.descriptor.config_identity,
        }),
      ).rejects.toEqual(
        expect.objectContaining({ code: "HOST_IDENTITY_MISMATCH" }),
      );
    } finally {
      credential.fill(0);
      rmSync(current.config.data_root, { recursive: true, force: true });
      renameSync(previousRoot, current.config.data_root);
      await host.close();
    }
  }, 30_000);

  it("closes a session handle that finishes attaching during host shutdown", async () => {
    const current = fixture();
    let finishAttach: (() => void) | undefined;
    let closedHandles = 0;
    const attachReady = new Promise<void>((resolve) => {
      finishAttach = resolve;
    });
    const host = await startManagedRuntimeHost({
      config: current.config,
      runtimeDirectory: join(current.root, "runtime"),
      instanceId: "host:closing",
      attachSession: async () => {
        await attachReady;
        return {
          close: async () => {
            closedHandles += 1;
          },
        };
      },
    });
    const credential = readIpcCredential(host.descriptor.credential_path);
    const socket = await connectAuthenticatedIpc({
      descriptor: host.descriptor,
      credential,
      expectedRootIdentity: host.descriptor.root_identity,
      expectedConfigIdentity: host.descriptor.config_identity,
    });
    credential.fill(0);

    await host.close();
    finishAttach?.();
    await new Promise((resolve) => setImmediate(resolve));

    expect(socket.destroyed).toBe(true);
    expect(closedHandles).toBe(1);
  }, 30_000);

  it("revokes owned endpoint artifacts even when Runtime shutdown reports an error", async () => {
    const current = fixture();
    const host = await startManagedRuntimeHost({
      config: current.config,
      runtimeDirectory: join(current.root, "runtime"),
      instanceId: "host:shutdown-error",
      attachSession: async () => ({ close: async () => undefined }),
    });
    const descriptorPath = host.descriptorPath;
    const credentialPath = host.descriptor.credential_path;
    const socketPath = host.descriptor.socket_path;
    const closeRuntime = host.runtime.close.bind(host.runtime);
    host.runtime.close = async () => {
      await closeRuntime();
      throw new Error("injected Runtime close failure");
    };

    await expect(host.close()).rejects.toThrow(
      "injected Runtime close failure",
    );
    expect(existsSync(descriptorPath)).toBe(false);
    expect(existsSync(credentialPath)).toBe(false);
    expect(existsSync(socketPath)).toBe(false);
  }, 30_000);

  it("bounds concurrent IPC handshakes and releases capacity on disconnect", async () => {
    const current = fixture();
    const diagnostics: string[] = [];
    const host = await startManagedRuntimeHost({
      config: current.config,
      runtimeDirectory: join(current.root, "runtime"),
      instanceId: "host:bounded-sessions",
      maxIpcSessions: 1,
      attachSession: async () => ({ close: async () => undefined }),
      onDiagnostic: (event) => diagnostics.push(event.code),
    });
    const credential = readIpcCredential(host.descriptor.credential_path);
    const connect = () =>
      connectAuthenticatedIpc({
        descriptor: host.descriptor,
        credential,
        expectedRootIdentity: host.descriptor.root_identity,
        expectedConfigIdentity: host.descriptor.config_identity,
      });
    const first = await connect();
    try {
      await expect(connect()).rejects.toEqual(
        expect.objectContaining({ code: "HOST_UNAVAILABLE" }),
      );
      expect(diagnostics).toContain("SESSION_CAPACITY_EXCEEDED");
      const disconnected = new Promise<void>((resolve) => {
        first.once("close", () => resolve());
      });
      first.destroy();
      await disconnected;
      let replacement: Awaited<ReturnType<typeof connect>> | undefined;
      for (let attempt = 0; attempt < 10 && replacement === undefined; attempt += 1) {
        replacement = await connect().catch(async () => {
          await new Promise((resolve) => setImmediate(resolve));
          return undefined;
        });
      }
      expect(replacement).toBeDefined();
      if (replacement === undefined) {
        throw new Error("IPC capacity was not released after disconnect");
      }
      replacement.destroy();
    } finally {
      credential.fill(0);
      first.destroy();
      await host.close();
    }
  }, 30_000);
});
