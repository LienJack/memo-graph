import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MemoryRuntime } from "../../packages/memory-kernel/src/index.js";
import {
  SqliteStorageClient,
  restoreBackupToEmptyDataRoot,
} from "@memo-graph/storage-sqlite";

import { TestApprovalRegistry } from "../helpers/approval.js";
import {
  memoryCandidate,
  memoryProposal,
} from "../helpers/governance-examples.js";
import {
  PURGE_NOW,
  PURGE_SCOPE,
  deleteRequest,
} from "../helpers/purge-examples.js";
import { inlineEpisode } from "../helpers/storage-examples.js";

const cleanupPaths: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-graph-${prefix}-`)),
  );
  cleanupPaths.push(root);
  return root;
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target !== undefined) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

describe("restore tombstone frontier", () => {
  it("rejects a pre-delete snapshot and publishes only a verified current snapshot", async () => {
    const dataRoot = temporaryRoot("frontier-source");
    const restoreParent = temporaryRoot("frontier-target");
    const staleTarget = join(restoreParent, "stale");
    const unverifiedTarget = join(restoreParent, "unverified");
    const corruptTarget = join(restoreParent, "corrupt");
    const currentTarget = join(restoreParent, "current");
    const storage = await SqliteStorageClient.open({ dataRoot });
    await storage.commitEpisode(
      inlineEpisode({ text: "Tombstone frontier marker 7315." }),
    );
    const approvals = new TestApprovalRegistry();
    const kernel = new MemoryRuntime({
      storage,
      approvalRegistry: approvals,
      clock: () => PURGE_NOW,
      policy: {
        principal: {
          principal_id: "user_local",
          allowed_scopes: [PURGE_SCOPE],
          allowed_authorities: ["user_stated"],
          destructive_tools_enabled: true,
        },
        default_token_budget: 1_800,
      },
    });
    const proposed = await kernel.memoryPropose(
      memoryProposal({
        candidate: memoryCandidate({
          candidateId: "candidate_frontier_restore",
          logicalKey: "user.preference.frontier_restore",
          scope: PURGE_SCOPE,
          text: "Tombstone frontier marker 7315.",
        }),
        idempotencyKey: "memory-propose-frontier-restore",
      }),
    );
    if (proposed.status !== "OK") {
      throw new Error("frontier fixture must activate");
    }
    const identity = proposed.data as {
      memory_id: string;
      current_revision_id: string;
    };
    const staleBackup = await storage.createBackup();
    const deletion = deleteRequest({
      memoryId: identity.memory_id,
      revisionId: identity.current_revision_id,
      idempotencyKey: "memory-delete-frontier-restore-001",
      approvalId: "approval_delete_frontier_restore",
    });
    approvals.approve(deletion);
    const deleted = await kernel.memoryDelete(deletion);
    if (deleted.status !== "OK") {
      throw new Error("frontier delete must tombstone");
    }
    const purgeJobId = (deleted.data as { purge_job_id: string })
      .purge_job_id;
    const unverifiedBackup = await storage.createBackup();
    expect(await storage.runPurge({ purge_job_id: purgeJobId })).toMatchObject({
      completed: false,
      state: "partial",
      store_outcomes: expect.arrayContaining([
        expect.objectContaining({
          store: "backups",
          status: "residual",
        }),
      ]),
    });
    const currentBackup = await storage.createBackup();
    await storage.close();

    await expect(
      restoreBackupToEmptyDataRoot({
        backup: staleBackup,
        dataRoot: staleTarget,
        minimumTombstoneEpoch: 1,
      }),
    ).rejects.toMatchObject({ code: "STALE_TOMBSTONE_FRONTIER" });
    expect(existsSync(staleTarget)).toBe(false);

    await expect(
      restoreBackupToEmptyDataRoot({
        backup: unverifiedBackup,
        dataRoot: unverifiedTarget,
        minimumTombstoneEpoch: 1,
      }),
    ).rejects.toMatchObject({ code: "INCOMPLETE_PURGE" });
    expect(existsSync(unverifiedTarget)).toBe(false);

    await expect(
      restoreBackupToEmptyDataRoot({
        backup: {
          ...currentBackup,
          ledger_epoch: currentBackup.ledger_epoch + 1,
        },
        dataRoot: corruptTarget,
        minimumTombstoneEpoch: 1,
      }),
    ).rejects.toMatchObject({ code: "CORRUPTION" });
    expect(existsSync(corruptTarget)).toBe(false);

    const restored = await restoreBackupToEmptyDataRoot({
      backup: currentBackup,
      dataRoot: currentTarget,
      minimumTombstoneEpoch: 1,
    });
    expect(restored).toMatchObject({
      minimum_tombstone_epoch: 1,
      health: { tombstone_epoch: 1 },
      verification: {
        integrity_check: "ok",
        foreign_key_violations: 0,
        incomplete_purge_jobs: 1,
      },
    });
    expect(existsSync(currentTarget)).toBe(true);
  });
});
