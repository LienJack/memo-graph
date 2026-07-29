import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import {
  AdmissionController,
  maintenanceCompatible,
} from "../../packages/storage-sqlite/src/admission-control.js";
import { WriterQueue } from "../../packages/storage-sqlite/src/writer-queue.js";

const cleanupPaths: string[] = [];

function temporaryRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "memo-graph-maintenance-")),
  );
  cleanupPaths.push(root);
  return join(root, "data");
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target !== undefined) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

describe("maintenance compatibility", () => {
  it("fails closed for incompatible and unknown operations", async () => {
    expect(maintenanceCompatible(null, "backup")).toBe(true);
    expect(maintenanceCompatible("backup", "canonical_write")).toBe(false);
    expect(maintenanceCompatible(null, "future_maintenance")).toBe(false);
    const controller = new AdmissionController({
      observe: () => ({
        available_bytes: Number.MAX_SAFE_INTEGER,
        wal_bytes: 0,
        checkpoint_healthy: true,
        active_maintenance: null,
      }),
    });
    const queue = new WriterQueue({
      admit: (stage, metrics, operation) =>
        controller.assert(
          stage,
          metrics,
          operation as "backup" | "canonical_write",
        ),
    });
    let release!: () => void;
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backup = queue.enqueue(async () => {
      started();
      await held;
    }, "backup");
    await running;
    await expect(
      queue.enqueue(async () => undefined, "canonical_write"),
    ).rejects.toMatchObject({ code: "MAINTENANCE_BLOCKED" });
    release();
    await backup;
  });

  it("keeps inspection available while maintenance is declared active", async () => {
    const dataRoot = temporaryRoot();
    let activeMaintenance: "backup" | null = null;
    const storage = await SqliteStorageClient.open({
      dataRoot,
      admission: {
        observe: () => ({
          available_bytes: Number.MAX_SAFE_INTEGER,
          wal_bytes: 0,
          checkpoint_healthy: true,
          active_maintenance: activeMaintenance,
        }),
      },
    });
    let inspection:
      | Awaited<ReturnType<typeof SqliteStorageClient.inspect>>
      | undefined;
    try {
      await storage.checkpoint();
      activeMaintenance = "backup";
      inspection = await SqliteStorageClient.inspect({ dataRoot });
      await expect(inspection.health()).resolves.toMatchObject({
        admission_read_only: false,
        admission_observation: null,
        root_lease: null,
      });
    } finally {
      await inspection?.close();
      await storage.close();
    }
  });
});
