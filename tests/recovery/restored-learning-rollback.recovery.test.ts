import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MonitorReceiptSchema,
  MonitorResultSchema,
  canonicalSha256,
  canonicalSha256Omitting,
  sealReceipt,
} from "../../packages/contracts/src/index.js";
import {
  LearningReleaseManager,
} from "../../packages/learning-lab/src/index.js";
import {
  SqliteStorageClient,
  restoreBackupToEmptyDataRoot,
} from "@memo-graph/storage-sqlite";

import {
  authorizeRelease,
  authorizeRollback,
  preparePassedCanary,
  releaseRequest,
  rollbackRequest,
  TestReleaseApprovalRegistry,
} from "../helpers/g5-release.js";
import {
  learningCandidate,
} from "../helpers/learning-examples.js";
import { testRecoveryHeadProvider } from "../helpers/recovery.js";

const cleanupPaths: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-m6-ae6-${prefix}-`)),
  );
  cleanupPaths.push(root);
  return root;
}

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("restored learning rollback", () => {
  it("restores the named base release after a post-restore monitor breach", async () => {
    const recoveryHeadProvider = testRecoveryHeadProvider(
      "recovery_authority:m6-ae6",
    );
    const sourceRoot = temporaryRoot("source");
    let storage = await SqliteStorageClient.open({
      dataRoot: sourceRoot,
      recoveryHeadProvider,
    });
    const approvals = new TestReleaseApprovalRegistry();
    const firstPrepared = await preparePassedCanary({
      storage,
      suffix: "m6-rollback-first",
    });
    const firstRequest = releaseRequest({
      suffix: "m6-rollback-first",
    });
    authorizeRelease({
      request: firstRequest,
      prepared: firstPrepared,
      approvals,
    });
    const first = await new LearningReleaseManager({
      storage,
      authorityRegistry: firstPrepared.authority,
      approvalRegistry: approvals,
      clock: () => "2026-07-28T12:05:00.000Z",
    }).apply(firstRequest);

    const secondCandidate = learningCandidate({
      candidate_id: "candidate_m6_rollback_second",
      target: {
        kind: "retrieval_policy",
        requested_lanes: ["recent_l1"],
        limits: { max_candidates_per_lane: 5 },
      },
      base_release_ids: [first.release.release_id],
      active_base_release_id: first.release.release_id,
      trace_ids: ["trace_m6_rollback_second"],
      rollback_target_release_id: first.release.release_id,
    });
    const secondPrepared = await preparePassedCanary({
      storage,
      suffix: "m6-rollback-second",
      candidate: secondCandidate,
    });
    const secondRequest = releaseRequest({
      suffix: "m6-rollback-second",
      candidateId: secondCandidate.candidate_id,
    });
    authorizeRelease({
      request: secondRequest,
      prepared: secondPrepared,
      approvals,
      baseReleaseId: first.release.release_id,
      expectedPointerRevision: first.pointer.pointer_revision,
    });
    const second = await new LearningReleaseManager({
      storage,
      authorityRegistry: secondPrepared.authority,
      approvalRegistry: approvals,
      clock: () => "2026-07-28T12:05:20.000Z",
    }).apply(secondRequest);
    const backup = await storage.createBackup();
    await storage.close();

    const targetRoot = join(temporaryRoot("target-parent"), "target");
    await restoreBackupToEmptyDataRoot({
      backup,
      dataRoot: targetRoot,
      recoveryHeadProvider,
    });
    storage = await SqliteStorageClient.open({
      dataRoot: targetRoot,
      recoveryHeadProvider,
    });
    try {
      const optionalBefore = {
        graph: await storage.graphProjectionStatus(),
        vector: await storage.vectorProjectionStatus(),
      };
      const monitorInput = {
        schema_version: "1.0.0",
        monitor_id: "monitor_m6_restored_breach",
        release_id: second.release.release_id,
        pointer_revision: second.pointer.pointer_revision,
        canary_receipt_id: secondPrepared.canary.receipt.receipt_id,
        replayed_case_ids: [
          "m6_restored_monitor_1",
          "m6_restored_monitor_2",
          "m6_restored_monitor_3",
        ],
        passed: false,
        failure_codes: ["REGRESSION_DETECTED"],
        rollback_required: true,
        monitored_at: "2026-07-28T12:05:30.000Z",
        monitor_hash: canonicalSha256("placeholder"),
      };
      const monitor = MonitorResultSchema.parse({
        ...monitorInput,
        monitor_hash: canonicalSha256Omitting(monitorInput, [
          "monitor_hash",
        ]),
      });
      const monitorReceipt = MonitorReceiptSchema.parse(
        sealReceipt({
          schema_version: "1.0.0",
          receipt_id: "receipt_monitor_m6_restored_breach",
          created_at: monitor.monitored_at,
          state: "durable",
          request_hash: canonicalSha256({
            monitor_id: monitor.monitor_id,
          }),
          kind: "learning_monitor",
          release_id: second.release.release_id,
          pointer_revision: second.pointer.pointer_revision,
          canary_receipt_id: secondPrepared.canary.receipt.receipt_id,
          monitor_contract_hash:
            second.release.monitor_contract_hash,
          replayed_case_ids: monitor.replayed_case_ids,
          passed: false,
          failure_codes: monitor.failure_codes,
          rollback_required: true,
        }),
      );
      const monitorCommand = {
        kind: "monitor" as const,
        idempotency_key: "learning-monitor-m6-restored-breach-001",
        principal_id: secondRequest.principal_id,
        scopes: secondRequest.scopes,
        monitor,
        receipt: monitorReceipt,
      };
      await storage.writeLearningLedger({
        ...monitorCommand,
        request_hash: canonicalSha256Omitting(monitorCommand, [
          "request_hash",
        ]),
      });

      const rollback = rollbackRequest({
        suffix: "m6-restored-breach",
        released: second,
        targetReleaseId: first.release.release_id,
        monitorReceiptId: monitorReceipt.receipt_id,
      });
      authorizeRollback({
        request: rollback,
        prepared: secondPrepared,
        released: second,
        targetRelease: first,
        approvals,
      });
      const result = await new LearningReleaseManager({
        storage,
        authorityRegistry: secondPrepared.authority,
        approvalRegistry: approvals,
        clock: () => "2026-07-28T12:06:00.000Z",
      }).apply(rollback);
      expect(result).toMatchObject({
        release: {
          action: "rollback",
          previous_release_id: second.release.release_id,
          restored_release_id: first.release.release_id,
          configuration_hash: first.release.configuration_hash,
        },
        pointer: {
          active_release_id: first.release.release_id,
          pointer_revision: 3,
        },
        receipt: {
          restored_release_id: first.release.release_id,
          restored_configuration_hash:
            first.release.configuration_hash,
        },
      });
      expect(await storage.graphProjectionStatus()).toEqual(
        optionalBefore.graph,
      );
      expect(await storage.vectorProjectionStatus()).toEqual(
        optionalBefore.vector,
      );
      expect(backup.manifest.decisions).toMatchObject({
        graph_enabled: false,
        vector_enabled: false,
        automatic_learning_publication: false,
      });
    } finally {
      await storage.close();
    }
  });
});
