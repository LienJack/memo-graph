import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  WorkbenchEndpointMetadataSchema,
  canonicalJson,
} from "../../packages/contracts/src/index.js";
import {
  memoryRuntimeConfigIdentity,
  memoryRuntimeRootIdentity,
  startManagedRuntimeHost,
} from "../../packages/runtime-host/src/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import {
  launchOrReuseWorkbench,
  publishPrivateFile,
  readWorkbenchEndpoint,
  workbenchArtifactPaths,
} from "../../apps/memory-workbench-host/src/index.js";
import type {
  WorkbenchLaunchError,
} from "../../apps/memory-workbench-host/src/index.js";
import { mcpRecoveryFixture } from "../helpers/mcp-recovery.js";

const cleanupPaths: string[] = [];
const activeProcessIds = new Set<number>();
const HOST_ENTRY = resolve(
  "apps/memory-workbench-host/dist/cli.js",
);

async function fixture() {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "memo-workbench-recovery-")),
  );
  cleanupPaths.push(root);
  const dataRoot = join(root, "data");
  const recovery = mcpRecoveryFixture(dataRoot);
  const storage = await SqliteStorageClient.open({
    dataRoot,
    recoveryHeadProvider: recovery.provider,
  });
  await storage.close();
  const config = {
    data_root: dataRoot,
    principal_id: "user_local",
    allowed_scopes: [
      { kind: "workspace", id: "workspace_local" },
    ],
    allowed_authorities: ["user_stated"],
    recovery_head: recovery.config,
  } as const;
  return {
    root,
    config,
    runtimeDirectory: join(root, "runtime"),
  };
}

async function waitUntilStopped(processId: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(processId, 0);
    } catch {
      return;
    }
    await new Promise((resolve_) => setTimeout(resolve_, 20));
  }
}

afterEach(async () => {
  for (const processId of activeProcessIds) {
    try {
      process.kill(processId, "SIGTERM");
    } catch {
      // The process already stopped.
    }
  }
  await Promise.all([...activeProcessIds].map(waitUntilStopped));
  activeProcessIds.clear();
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path !== undefined) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe("memory workbench launcher recovery", () => {
  it("quarantines crash remnants and starts a replacement instance", async () => {
    const current = await fixture();
    const first = await launchOrReuseWorkbench({
      config: current.config,
      runtimeDirectory: current.runtimeDirectory,
      hostEntry: HOST_ENTRY,
      noOpen: true,
      detach: false,
    });
    activeProcessIds.add(first.processId);
    const paths = workbenchArtifactPaths({
      runtimeDirectory: current.runtimeDirectory,
      rootIdentity: memoryRuntimeRootIdentity(current.config.data_root),
      configIdentity: memoryRuntimeConfigIdentity(current.config),
    });
    const oldEndpointInode = lstatSync(paths.endpointPath).ino;
    const oldCredentialInode = lstatSync(paths.controlCredentialPath).ino;

    process.kill(first.processId, "SIGKILL");
    await waitUntilStopped(first.processId);
    activeProcessIds.delete(first.processId);

    const replacement = await launchOrReuseWorkbench({
      config: current.config,
      runtimeDirectory: current.runtimeDirectory,
      hostEntry: HOST_ENTRY,
      noOpen: true,
      detach: false,
    });
    activeProcessIds.add(replacement.processId);
    expect(replacement.result.status).toBe("started");
    expect(replacement.processId).not.toBe(first.processId);
    expect(replacement.result.instance_id).not.toBe(first.result.instance_id);
    expect(lstatSync(paths.endpointPath).ino).not.toBe(oldEndpointInode);
    expect(lstatSync(paths.controlCredentialPath).ino)
      .not.toBe(oldCredentialInode);
    await expect(fetch(first.result.origin)).rejects.toThrow();
  }, 30_000);

  it("does not delete endpoint metadata for another config identity", async () => {
    const current = await fixture();
    const first = await launchOrReuseWorkbench({
      config: current.config,
      runtimeDirectory: current.runtimeDirectory,
      hostEntry: HOST_ENTRY,
      noOpen: true,
      detach: false,
    });
    activeProcessIds.add(first.processId);
    const paths = workbenchArtifactPaths({
      runtimeDirectory: current.runtimeDirectory,
      rootIdentity: memoryRuntimeRootIdentity(current.config.data_root),
      configIdentity: memoryRuntimeConfigIdentity(current.config),
    });
    const endpoint = readWorkbenchEndpoint(paths.endpointPath);
    process.kill(first.processId, "SIGKILL");
    await waitUntilStopped(first.processId);
    activeProcessIds.delete(first.processId);

    unlinkSync(paths.endpointPath);
    const foreign = WorkbenchEndpointMetadataSchema.parse({
      ...endpoint,
      config_identity: `sha256:${"f".repeat(64)}`,
    });
    publishPrivateFile(paths.endpointPath, `${canonicalJson(foreign)}\n`);

    await expect(
      launchOrReuseWorkbench({
        config: current.config,
        runtimeDirectory: current.runtimeDirectory,
        hostEntry: HOST_ENTRY,
        noOpen: true,
        detach: false,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<WorkbenchLaunchError>>({
        code: "WORKBENCH_IDENTITY_MISMATCH",
      }),
    );
    expect(readWorkbenchEndpoint(paths.endpointPath).config_identity)
      .toBe(foreign.config_identity);
  }, 30_000);

  it("recovers an old launch lock whose owner is no longer live", async () => {
    const current = await fixture();
    const paths = workbenchArtifactPaths({
      runtimeDirectory: current.runtimeDirectory,
      rootIdentity: memoryRuntimeRootIdentity(current.config.data_root),
      configIdentity: memoryRuntimeConfigIdentity(current.config),
    });
    mkdirSync(paths.launchLockPath, { mode: 0o700 });
    writeFileSync(
      join(paths.launchLockPath, "owner.json"),
      `${canonicalJson({
        schema_version: "1.0.0",
        launch_id: "00000000-0000-4000-8000-000000000001",
        process_id: 99_999_999,
        created_at: "2026-08-02T00:00:00.000Z",
      })}\n`,
      { mode: 0o600 },
    );

    const launched = await launchOrReuseWorkbench({
      config: current.config,
      runtimeDirectory: current.runtimeDirectory,
      hostEntry: HOST_ENTRY,
      noOpen: true,
      detach: false,
      lockTimeoutMs: 2_500,
    });
    activeProcessIds.add(launched.processId);
    expect(launched.result.status).toBe("started");
    expect(existsSync(paths.launchLockPath)).toBe(false);
  }, 30_000);

  it("never cleans a live managed Runtime that lacks an HTTP endpoint", async () => {
    const current = await fixture();
    const directOwner = await startManagedRuntimeHost({
      config: current.config,
      runtimeDirectory: current.runtimeDirectory,
      instanceId: "host:managed-owner",
      attachSession: async () => ({ close: async () => undefined }),
    });
    try {
      await expect(
        launchOrReuseWorkbench({
          config: current.config,
          runtimeDirectory: current.runtimeDirectory,
          hostEntry: HOST_ENTRY,
          noOpen: true,
          detach: false,
        }),
      ).rejects.toEqual(
        expect.objectContaining<Partial<WorkbenchLaunchError>>({
          code: "WORKBENCH_HTTP_UNAVAILABLE",
        }),
      );
      expect(existsSync(directOwner.descriptorPath)).toBe(true);
      expect(existsSync(directOwner.descriptor.credential_path)).toBe(true);
    } finally {
      await directOwner.close();
    }
  }, 30_000);

  it("rejects forged Runtime artifact paths without touching their targets", async () => {
    const current = await fixture();
    const rootIdentity = memoryRuntimeRootIdentity(current.config.data_root);
    const configIdentity = memoryRuntimeConfigIdentity(current.config);
    const paths = workbenchArtifactPaths({
      runtimeDirectory: current.runtimeDirectory,
      rootIdentity,
      configIdentity,
    });
    const foreignTarget = join(current.root, "foreign-private.key");
    writeFileSync(foreignTarget, "do-not-touch\n", { mode: 0o600 });
    publishPrivateFile(
      paths.runtimeDescriptorPath,
      `${canonicalJson({
        schema_version: "1.0.0",
        protocol: "memo-graph-mcp-ipc-v1",
        instance_id: "host:forged-path",
        root_identity: rootIdentity,
        config_identity: configIdentity,
        socket_path: foreignTarget,
        credential_path: foreignTarget,
        created_at: "2026-08-02T08:00:00.000Z",
        ready_at: "2026-08-02T08:00:01.000Z",
      })}\n`,
    );

    await expect(
      launchOrReuseWorkbench({
        config: current.config,
        runtimeDirectory: current.runtimeDirectory,
        hostEntry: HOST_ENTRY,
        noOpen: true,
        detach: false,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<WorkbenchLaunchError>>({
        code: "WORKBENCH_IDENTITY_MISMATCH",
      }),
    );
    expect(existsSync(foreignTarget)).toBe(true);
  }, 30_000);
});
