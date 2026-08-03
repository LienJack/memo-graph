import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SqliteStorageClient,
  restoreBackupToEmptyDataRoot,
} from "@memo-graph/storage-sqlite";

import { testRecoveryHeadProvider } from "../helpers/recovery.js";

const cleanup: string[] = [];

function temporaryRoot(label: string): string {
  const path = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-u3-lanes-${label}-`)),
  );
  cleanup.push(path);
  return path;
}

afterEach(() => {
  for (const path of cleanup.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("disabled optional lane restore", () => {
  it("keeps graph, vector, and automatic learning publication disabled", async () => {
    const recoveryHeadProvider = testRecoveryHeadProvider(
      "recovery_authority:disabled-lanes",
    );
    const source = temporaryRoot("source");
    const storage = await SqliteStorageClient.open({
      dataRoot: source,
      recoveryHeadProvider,
    });
    const backup = await storage.createBackup();
    await storage.close();
    expect(backup.manifest.decisions).toMatchObject({
      graph_enabled: false,
      vector_enabled: false,
      automatic_learning_publication: false,
    });

    const target = join(temporaryRoot("target-parent"), "target");
    const restored = await restoreBackupToEmptyDataRoot({
      backup,
      dataRoot: target,
      recoveryHeadProvider,
    });
    expect(restored.health.projection_state).toBe("ready");
    expect(restored.health.layered_projection_state).toBe("ready");
    const reopened = await SqliteStorageClient.open({
      dataRoot: target,
      recoveryHeadProvider,
    });
    try {
      await expect(reopened.graphProjectionStatus()).resolves.toEqual({
        scope_states: 0,
        ready_scopes: 0,
        pending_scopes: 0,
        unavailable_scopes: 0,
        outbox_pending: 0,
        outbox_retrying: 0,
        outbox_terminal: 0,
        receipts: 0,
      });
      await expect(reopened.vectorProjectionStatus()).resolves.toEqual({
        mode: "disabled",
        epoch_id: null,
        registered_epochs: 0,
        scope_states: 0,
        published_scopes: 0,
        pending_scopes: 0,
        degraded_scopes: 0,
        outbox_pending: 0,
        outbox_retrying: 0,
        outbox_terminal: 0,
        receipts: 0,
      });
      const learning = await reopened.readLearningLedger({
        principal_id: "user_local",
        scopes: [{ kind: "workspace", id: "workspace_local" }],
      });
      expect(learning.candidates).toEqual([]);
      expect(learning.canary_runs).toEqual([]);
      expect(learning.releases).toEqual([]);
    } finally {
      await reopened.close();
    }
    expect(existsSync(join(target, "derived", "graph"))).toBe(false);
    expect(existsSync(join(target, "derived", "vector"))).toBe(false);
  });
});
