import {
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
  type LearningLedgerWriteCommand,
} from "@memo-graph/storage-sqlite";
import { canonicalSha256Omitting } from "../../packages/contracts/src/index.js";
import {
  LEARNING_WORKSPACE_SCOPE,
  learningCanaryAuthorization,
  learningCanaryReceipt,
  learningCanaryRun,
  learningCandidate,
  learningControl,
  learningControlReceipt,
  learningEvalReceipt,
  learningEvaluationIdentity,
  learningPartitionSeals,
  learningReleasePointer,
  learningReleaseReceipt,
  learningReleaseVersion,
  learningResultSet,
  learningTrace,
  learningTransition,
  learningTransitionChain,
  postCanaryApproval,
  releaseApprovalDetails,
  verifiedLearningApproval,
} from "../helpers/learning-examples.js";
import { USER_SCOPE } from "../helpers/examples.js";

const cleanupPaths: string[] = [];

function writeCommand(
  command: LearningLedgerWriteCommand extends infer Command
    ? Command extends unknown
      ? Omit<Command, "request_hash">
      : never
    : never,
): LearningLedgerWriteCommand {
  return {
    ...command,
    request_hash: canonicalSha256Omitting(command, ["request_hash"]),
  } as LearningLedgerWriteCommand;
}

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

describe("learning ledger transaction recovery", () => {
  it("rolls back control, receipt, approval, and idempotency together", async () => {
    const dataRoot = temporaryRoot("learning-control-atomic");
    const authority = verifiedLearningApproval({
      tool: "learning_pause",
      requestHash: learningControlReceipt().request_hash,
    });
    const command = {
      kind: "control" as const,
      idempotency_key: "learning-control-atomic-001",
      request_hash: learningControlReceipt().request_hash,
      expected_control_epoch: 0,
      expected_frontier_hash:
        learningControlReceipt().previous_frontier_hash,
      control: learningControl(),
      receipt: learningControlReceipt(),
      approval_binding: authority.binding,
      approval: authority.approval,
    };
    const failing = await SqliteStorageClient.open({
      dataRoot,
      testOperations: true,
    });
    for (const testFailurePoint of [
      "after_guard",
      "after_control",
      "after_receipt",
      "after_approval",
      "after_idempotency",
    ] as const) {
      await expect(
        failing.writeLearningLedger({
          ...command,
          test_failure_point: testFailurePoint,
        }),
      ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
      expect(
        await failing.readLearningLedger({
          principal_id: "user_local",
          scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
        }),
      ).toMatchObject({ controls: [], receipts: [] });
    }
    await failing.close();

    const reopened = await SqliteStorageClient.open({ dataRoot });
    try {
      const empty = await reopened.readLearningLedger({
        principal_id: "user_local",
        scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
      });
      expect(empty.controls).toEqual([]);
      expect(empty.receipts).toEqual([]);
      expect(
        await reopened.writeLearningLedger(command),
      ).toMatchObject({ replayed: false });
      expect(
        await reopened.writeLearningLedger(command),
      ).toMatchObject({ replayed: true });
      await expect(
        reopened.writeLearningLedger({
          ...command,
          idempotency_key: "learning-control-reuse-001",
        }),
      ).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    } finally {
      await reopened.close();
    }
  });

  it("rolls back release, pointer, transition, receipt, approval, and idempotency at every boundary", async () => {
    const dataRoot = temporaryRoot("learning-release-atomic");
    const storage = await SqliteStorageClient.open({
      dataRoot,
      testOperations: true,
    });
    try {
      await storage.writeLearningLedger(
        writeCommand({
          kind: "trace",
          idempotency_key: "learning-release-atomic-trace-001",
          trace: learningTrace(),
        }),
      );
      await storage.writeLearningLedger(
        writeCommand({
          kind: "candidate",
          idempotency_key: "learning-release-atomic-candidate-001",
          candidate: learningCandidate(),
        }),
      );
      const transitionChain = learningTransitionChain();
      const canaryTransition = transitionChain[3];
      if (canaryTransition === undefined) {
        throw new Error("canary transition fixture is required");
      }
      for (const transition of transitionChain.slice(0, -1)) {
        await storage.writeLearningLedger(
          writeCommand({
            kind: "transition",
            idempotency_key: `atomic-${transition.idempotency_key}`,
            transition,
          }),
        );
      }
      await storage.writeLearningLedger(
        writeCommand({
          kind: "evaluation",
          idempotency_key: "learning-release-atomic-evaluation-001",
          principal_id: "user_local",
          scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
          identity: learningEvaluationIdentity(),
          partition_seals: learningPartitionSeals(),
          result_sets: (
            ["calibration", "holdout", "transfer"] as const
          ).map(learningResultSet),
          contamination_events: [],
          receipt: learningEvalReceipt(),
        }),
      );
      await storage.writeLearningLedger(
        writeCommand({
          kind: "canary",
          idempotency_key: "learning-release-atomic-canary-001",
          idempotency_hash:
            learningCanaryAuthorization().request_hash,
          principal_id: "user_local",
          scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
          authorization: learningCanaryAuthorization(),
          transition: canaryTransition,
          run: learningCanaryRun(),
          receipt: learningCanaryReceipt(),
        }),
      );
      const authority = verifiedLearningApproval({
        tool: "learning_release",
        requestHash: learningReleaseReceipt().request_hash,
        learning: releaseApprovalDetails(),
      });
      const releaseTransition = learningTransition({
        transition_id: "transition_release_atomic",
        sequence: 5,
        from_state: "canary",
        to_state: "released",
        evidence_receipt_ids: [
          "receipt_eval_storage_1",
          "receipt_canary_storage_1",
        ],
        expected_previous_transition_hash:
          transitionChain.at(-1)?.transition_hash ?? null,
        idempotency_key: "transition-release-atomic-001",
        authority_id: authority.approval.grant.approval_id,
      });
      const releaseCommand = {
        kind: "release" as const,
        idempotency_key: "learning-release-atomic-001",
        request_hash: learningReleaseReceipt().request_hash,
        principal_id: "user_local",
        scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
        expected_control_epoch: 0,
        expected_pointer_revision: 0,
        approval_artifact: postCanaryApproval(),
        approval_binding: authority.binding,
        approval: authority.approval,
        release: learningReleaseVersion(),
        pointer: learningReleasePointer(),
        transition: releaseTransition,
        receipt: learningReleaseReceipt(),
      };
      for (const testFailurePoint of [
        "after_guard",
        "after_release",
        "after_pointer",
        "after_transition",
        "after_receipt",
        "after_approval",
        "after_idempotency",
      ] as const) {
        await expect(
          storage.writeLearningLedger({
            ...releaseCommand,
            test_failure_point: testFailurePoint,
          }),
        ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
        const ledger = await storage.readLearningLedger({
          principal_id: "user_local",
          scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
          candidate_id: "candidate_storage_1",
        });
        expect(ledger.releases).toEqual([]);
        expect(ledger.pointers).toEqual([]);
        expect(ledger.transitions).toHaveLength(4);
        expect(ledger.receipts.map((receipt) => receipt.kind)).toEqual([
          "evaluation",
          "learning_canary",
        ]);
      }
      await expect(
        storage.writeLearningLedger(releaseCommand),
      ).resolves.toMatchObject({ kind: "release", replayed: false });
      await expect(
        storage.writeLearningLedger(releaseCommand),
      ).resolves.toMatchObject({ kind: "release", replayed: true });
    } finally {
      await storage.close();
    }
  });

  it("rolls back canary transition, authorization, run, receipt, and idempotency together", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("learning-canary-atomic"),
      testOperations: true,
    });
    try {
      await storage.writeLearningLedger(
        writeCommand({
          kind: "trace",
          idempotency_key: "learning-canary-atomic-trace-001",
          trace: learningTrace(),
        }),
      );
      await storage.writeLearningLedger(
        writeCommand({
          kind: "candidate",
          idempotency_key: "learning-canary-atomic-candidate-001",
          candidate: learningCandidate(),
        }),
      );
      const transitionChain = learningTransitionChain();
      const canaryTransition = transitionChain[3];
      if (canaryTransition === undefined) {
        throw new Error("canary transition fixture is required");
      }
      for (const transition of transitionChain.slice(0, -1)) {
        await storage.writeLearningLedger(
          writeCommand({
            kind: "transition",
            idempotency_key: `canary-atomic-${transition.idempotency_key}`,
            transition,
          }),
        );
      }
      await storage.writeLearningLedger(
        writeCommand({
          kind: "evaluation",
          idempotency_key: "learning-canary-atomic-evaluation-001",
          principal_id: "user_local",
          scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
          identity: learningEvaluationIdentity(),
          partition_seals: learningPartitionSeals(),
          result_sets: (
            ["calibration", "holdout", "transfer"] as const
          ).map(learningResultSet),
          contamination_events: [],
          receipt: learningEvalReceipt(),
        }),
      );
      const canaryCommand = writeCommand({
        kind: "canary",
        idempotency_key: "learning-canary-atomic-run-001",
        idempotency_hash:
          learningCanaryAuthorization().request_hash,
        principal_id: "user_local",
        scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
        authorization: learningCanaryAuthorization(),
        transition: canaryTransition,
        run: learningCanaryRun(),
        receipt: learningCanaryReceipt(),
      }) as Extract<LearningLedgerWriteCommand, { kind: "canary" }>;
      for (const testFailurePoint of [
        "after_guard",
        "after_transition",
        "after_authorization",
        "after_canary_run",
        "after_receipt",
        "after_idempotency",
      ] as const) {
        await expect(
          storage.writeLearningLedger({
            ...canaryCommand,
            test_failure_point: testFailurePoint,
          }),
        ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
        const ledger = await storage.readLearningLedger({
          principal_id: "user_local",
          scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
          candidate_id: "candidate_storage_1",
        });
        expect(ledger.candidate_states[0]?.state).toBe(
          "approved_for_canary",
        );
        expect(ledger.canary_authorizations).toEqual([]);
        expect(ledger.canary_runs).toEqual([]);
        expect(
          ledger.receipts.filter(
            (receipt) => receipt.kind === "learning_canary",
          ),
        ).toEqual([]);
      }
      await expect(
        storage.writeLearningLedger(canaryCommand),
      ).resolves.toMatchObject({ kind: "canary", replayed: false });
      await expect(
        storage.writeLearningLedger(canaryCommand),
      ).resolves.toMatchObject({ kind: "canary", replayed: true });
    } finally {
      await storage.close();
    }
  });

  it("carries learning frontiers through backup and refuses stale restore", async () => {
    const dataRoot = temporaryRoot("learning-backup");
    const authority = verifiedLearningApproval({
      tool: "learning_pause",
      requestHash: learningControlReceipt().request_hash,
    });
    const storage = await SqliteStorageClient.open({ dataRoot });
    await storage.writeLearningLedger({
      kind: "control",
      idempotency_key: "learning-control-backup-001",
      request_hash: learningControlReceipt().request_hash,
      expected_control_epoch: 0,
      expected_frontier_hash:
        learningControlReceipt().previous_frontier_hash,
      control: learningControl(),
      receipt: learningControlReceipt(),
      approval_binding: authority.binding,
      approval: authority.approval,
    });
    const backup = await storage.createBackup();
    await storage.close();

    expect(backup).toMatchObject({
      learning_control_epoch: 1,
      learning_release_revision: 0,
    });
    await expect(
      restoreBackupToEmptyDataRoot({
        backup,
        dataRoot: join(
          temporaryRoot("learning-stale-parent"),
          "stale-restore",
        ),
        minimumTombstoneEpoch: 0,
        minimumLearningControlEpoch: 2,
      }),
    ).rejects.toMatchObject({ code: "STALE_LEARNING_FRONTIER" });

    const restored = await restoreBackupToEmptyDataRoot({
      backup,
      dataRoot: join(
        temporaryRoot("learning-restore-parent"),
        "restored",
      ),
      minimumTombstoneEpoch: 0,
      minimumLearningControlEpoch: 1,
      minimumLearningReleaseRevision: 0,
    });
    expect(restored.health.learning_frontier).toMatchObject({
      control_epoch: 1,
      release_revision: 0,
      frontier_hash: backup.learning_frontier_hash,
    });
    expect(restored.verification.learning_control_rows_verified).toBe(1);
  });
});
