import { generateKeyPairSync } from "node:crypto";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileRecoveryHeadProvider,
  SqliteStorageClient,
  operationalStatusFromStorageHealth,
} from "@memo-graph/storage-sqlite";

import {
  learningControl,
  learningControlReceipt,
  verifiedLearningApproval,
} from "../helpers/learning-examples.js";
import { inlineEpisode } from "../helpers/storage-examples.js";
import {
  openWithoutTestRecoveryProvider,
} from "../setup/recovery-provider.js";

const cleanupPaths: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-m6-authority-${prefix}-`)),
  );
  cleanupPaths.push(root);
  return root;
}

function logicalState(
  health: Awaited<ReturnType<SqliteStorageClient["health"]>>,
) {
  return {
    ledger_epoch: health.ledger_epoch,
    tombstone_epoch: health.tombstone_epoch,
    latest_receipt_hash: health.latest_receipt_hash,
    projection_frontier: health.projection_frontier,
    learning_frontier: health.learning_frontier,
    encryption: health.encryption,
    counts: health.counts,
  };
}

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("recovery authority protection", () => {
  it("keeps inspection available but rejects every protected mutation class without a provider", async () => {
    const dataRoot = temporaryRoot("missing");
    const storage = await openWithoutTestRecoveryProvider({
      dataRoot,
      testOperations: true,
      recoveryHeadProvider: null,
    });
    const before = await storage.health();
    expect(before.recovery).toEqual({
      configured: false,
      state: "blocked",
      current_generation: null,
      unresolved_pending_count: 0,
    });
    expect(
      operationalStatusFromStorageHealth(before, {
        observedAt: "2026-07-30T12:00:00.000Z",
      }),
    ).toMatchObject({
      readiness: "blocked",
      primary_reason: "RECOVERY_AUTHORITY_INVALID",
      next_action: "RECOVER_EXTERNAL_AUTHORITY",
    });

    const receipt = learningControlReceipt("pause", {
      receipt_id: "receipt_missing_recovery_learning",
    });
    const authority = verifiedLearningApproval({
      tool: "learning_pause",
      requestHash: receipt.request_hash,
    });
    const attempts = [
      storage.commitEpisode(
        inlineEpisode({
          episodeId: "episode_missing_recovery",
          evidenceId: "evidence_missing_recovery",
          idempotencyKey: "commit:missing-recovery:0001",
        }),
      ),
      storage.enqueueProjectionJob({
        job_id: "projection_job_missing_recovery",
        kind: "refresh",
        aggregate_id: "projection_missing_recovery",
        principal_id: "user_local",
        scope: { kind: "workspace", id: "workspace_local" },
        source_revision_ids: ["revision_missing_recovery"],
        available_at: "2026-07-30T12:00:00.000Z",
        created_at: "2026-07-30T12:00:00.000Z",
      }),
      storage.writeLearningLedger({
        kind: "control",
        idempotency_key: "learning-control-missing-recovery-001",
        request_hash: receipt.request_hash,
        expected_control_epoch: 0,
        expected_frontier_hash: receipt.previous_frontier_hash,
        control: learningControl("paused", {
          frontier_hash: receipt.frontier_hash,
        }),
        receipt,
        approval_binding: authority.binding,
        approval: authority.approval,
      }),
      storage.darkLaunchRevokeEncryptionKey({
        idempotency_key: "key-revoke-missing-recovery-001",
        key_id: "key:missing-recovery",
      }),
    ];
    for (const attempt of attempts) {
      await expect(attempt).rejects.toMatchObject({
        code: "RECOVERY_AUTHORITY_INVALID",
      });
    }
    expect(logicalState(await storage.health())).toEqual(
      logicalState(before),
    );
    await storage.close();

    const inspection = await SqliteStorageClient.inspect({ dataRoot });
    try {
      expect((await inspection.health()).recovery).toMatchObject({
        configured: false,
        state: "blocked",
      });
    } finally {
      await inspection.close();
    }
  });

  it.each(["missing_head", "authority_lock"] as const)(
    "fails closed with zero committed effects after file-provider %s",
    async (failure) => {
      const dataRoot = temporaryRoot(`lost-${failure}`);
      const providerDirectory = join(
        temporaryRoot(`provider-${failure}`),
        "head",
      );
      const keys = generateKeyPairSync("ed25519");
      const provider = new FileRecoveryHeadProvider({
        directory: providerDirectory,
        authorityKeyId: `recovery_authority:${failure}`,
        trustRootVersion: 1,
        privateKey: keys.privateKey,
        publicKey: keys.publicKey,
        create: true,
      });
      const storage = await SqliteStorageClient.open({
        dataRoot,
        recoveryHeadProvider: provider,
      });
      const before = await storage.health();
      expect(before.recovery.state).toBe("ready");
      if (failure === "missing_head") {
        unlinkSync(join(providerDirectory, "head.json"));
      } else {
        writeFileSync(
          join(providerDirectory, ".head.lock"),
          "operator reconciliation required\n",
          { mode: 0o600 },
        );
      }
      expect((await storage.health()).recovery).toMatchObject({
        configured: true,
        state: "blocked",
      });
      await expect(
        storage.commitEpisode(
          inlineEpisode({
            episodeId: `episode_${failure}`,
            evidenceId: `evidence_${failure}`,
            idempotencyKey: `commit:${failure}:0001`,
          }),
        ),
      ).rejects.toMatchObject({
        code: "RECOVERY_AUTHORITY_INVALID",
      });
      expect(logicalState(await storage.health())).toEqual(
        logicalState(before),
      );
      await storage.close();
    },
  );
});
