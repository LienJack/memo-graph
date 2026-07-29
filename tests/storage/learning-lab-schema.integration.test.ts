import {
  cpSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  SqliteStorageClient,
  LearningLedgerWriteCommandSchema,
  WorkerRequestSchema,
  WorkerResponseSchema,
  type LearningLedgerWriteCommand,
} from "@memo-graph/storage-sqlite";
import {
  canonicalSha256,
  canonicalSha256Omitting,
} from "../../packages/contracts/src/index.js";
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
  learningMonitorReceipt,
  learningMonitorResult,
  learningPartitionSeals,
  learningReleasePointer,
  learningReleaseReceipt,
  learningReleaseVersion,
  learningRollbackPointer,
  learningRollbackReceipt,
  learningRollbackVersion,
  learningResultSet,
  learningStopReceipt,
  learningTrace,
  learningTransition,
  learningTransitionChain,
  learningTransitionReceipt,
  postCanaryApproval,
  postCanaryRollbackApproval,
  releaseApprovalDetails,
  rollbackApprovalDetails,
  verifiedLearningApproval,
} from "../helpers/learning-examples.js";
import { USER_SCOPE } from "../helpers/examples.js";
import { inlineEpisode } from "../helpers/storage-examples.js";

const cleanupPaths: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-graph-${prefix}-`)),
  );
  cleanupPaths.push(root);
  return root;
}

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

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target !== undefined) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

describe("SQLite learning ledger schema", () => {
  it("runtime-decodes learning commands and worker envelopes strictly", () => {
    expect(
      LearningLedgerWriteCommandSchema.safeParse({
        kind: "unknown_learning_write",
      }).success,
    ).toBe(false);
    expect(
      WorkerRequestSchema.safeParse({
        requestId: "00000000-0000-4000-8000-000000000001",
        operation: "write_learning_ledger",
        payload: {},
        unexpected: true,
      }).success,
    ).toBe(false);
    expect(
      WorkerResponseSchema.safeParse({
        requestId: "00000000-0000-4000-8000-000000000001",
        ok: true,
      }).success,
    ).toBe(false);
  });

  it("persists scoped stop receipts without creating a candidate", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("learning-stop"),
    });
    try {
      const receipt = learningStopReceipt();
      expect(
        await storage.writeLearningLedger(
          writeCommand({
            kind: "stop",
            idempotency_key: "learning-stop-storage-001",
            principal_id: "user_local",
            scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
            receipt,
          }),
        ),
      ).toMatchObject({
        kind: "stop",
        replayed: false,
        receipt: { kind: "learning_stop" },
      });
      expect(
        await storage.readLearningLedger({
          principal_id: "user_local",
          scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
        }),
      ).toMatchObject({
        candidates: [],
        receipts: [receipt],
      });
    } finally {
      await storage.close();
    }
  });

  it("upgrades a populated 0013 database without rewriting old rows or hashes", async () => {
    const dataRoot = temporaryRoot("learning-upgrade");
    const migrationRoot = temporaryRoot("learning-upgrade-migrations");
    const migrationNames = readdirSync(join(process.cwd(), "migrations"));
    for (let version = 1; version <= 13; version += 1) {
      const prefix = String(version).padStart(4, "0");
      const name = migrationNames.find((entry) =>
        entry.startsWith(`${prefix}-`),
      );
      if (name === undefined) {
        throw new Error(`missing migration ${prefix}`);
      }
      cpSync(
        join(process.cwd(), "migrations", name),
        join(migrationRoot, name),
      );
    }
    const before = await SqliteStorageClient.open({
      dataRoot,
      migrationsDir: migrationRoot,
    });
    const receipt = await before.commitEpisode(
      inlineEpisode({
        episodeId: "episode_before_learning_migration",
        evidenceId: "evidence_before_learning_migration",
        idempotencyKey: "commit-before-learning-migration-001",
        text: "Canonical row that must survive additive migration 0014.",
      }),
    );
    const beforeHealth = await before.health();
    await before.close();

    const beforeDatabase = new DatabaseSync(
      join(dataRoot, "ledger", "memory.db"),
    );
    const rawBefore = beforeDatabase.prepare(
        `SELECT * FROM evidence_events
         WHERE evidence_id = 'evidence_before_learning_migration'`,
      )
      .get();
    beforeDatabase.close();
    cpSync(
      join(process.cwd(), "migrations", "0014-learning-lab.sql"),
      join(migrationRoot, "0014-learning-lab.sql"),
    );

    const upgraded = await SqliteStorageClient.open({
      dataRoot,
      migrationsDir: migrationRoot,
    });
    try {
      const health = await upgraded.health();
      expect(health.schema_version).toBe("0014");
      expect(health.counts.evidence_events).toBe(
        beforeHealth.counts.evidence_events,
      );
      expect(health.counts.learning_traces).toBe(0);
      expect(health.learning_frontier).toMatchObject({
        control_epoch: 0,
        release_revision: 0,
      });
      expect(
        await upgraded.getReceipt({
          receipt_id: receipt.receipt_id,
          principal_id: "user_local",
          scopes: [LEARNING_WORKSPACE_SCOPE],
        }),
      ).toEqual(receipt);
    } finally {
      await upgraded.close();
    }

    const database = new DatabaseSync(join(dataRoot, "ledger", "memory.db"));
    expect(
      database
        .prepare(
          `SELECT * FROM evidence_events
           WHERE evidence_id = 'evidence_before_learning_migration'`,
        )
        .get(),
    ).toEqual(rawBefore);
    database.close();
  });

  it("persists sealed traces, inactive candidates, and legal transitions", async () => {
    const dataRoot = temporaryRoot("learning-ledger");
    const storage = await SqliteStorageClient.open({ dataRoot });
    try {
      const trace = learningTrace();
      const candidate = learningCandidate();
      const transition = learningTransition();
      const transitionReceipt = learningTransitionReceipt(transition);

      expect(
        await storage.writeLearningLedger(
          writeCommand({
            kind: "trace",
            idempotency_key: "learning-trace-storage-001",
            trace,
          }),
        ),
      ).toMatchObject({ kind: "trace", replayed: false });
      expect(
        await storage.writeLearningLedger(
          writeCommand({
            kind: "candidate",
            idempotency_key: "learning-candidate-storage-001",
            candidate,
          }),
        ),
      ).toMatchObject({ kind: "candidate", replayed: false });
      expect(
        await storage.writeLearningLedger(
          writeCommand({
            kind: "transition",
            idempotency_key: "learning-transition-storage-001",
            transition,
            receipt: transitionReceipt,
          }),
        ),
      ).toMatchObject({
        kind: "transition",
        replayed: false,
        receipt: transitionReceipt,
      });

      const ledger = await storage.readLearningLedger({
        principal_id: "user_local",
        scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
        candidate_id: candidate.candidate_id,
      });
      expect(ledger.traces).toEqual([trace]);
      expect(ledger.candidates).toEqual([candidate]);
      expect(ledger.transitions).toEqual([transition]);
      expect(ledger.receipts).toEqual([transitionReceipt]);
      expect(ledger.candidate_states).toEqual([
        {
          candidate_id: candidate.candidate_id,
          state: "quarantined",
          sequence: 1,
          transition_hash: transition.transition_hash,
        },
      ]);
    } finally {
      await storage.close();
    }

    const reopened = await SqliteStorageClient.open({ dataRoot });
    try {
      expect((await reopened.health()).schema_version).toBe("0014");
      expect((await reopened.health()).counts.learning_candidates).toBe(1);
      expect(
        await reopened.writeLearningLedger(
          writeCommand({
            kind: "candidate",
            idempotency_key: "learning-candidate-storage-001",
            candidate: learningCandidate(),
          }),
        ),
      ).toMatchObject({ replayed: true });
      await expect(
        reopened.writeLearningLedger(
          writeCommand({
            kind: "candidate",
            idempotency_key: "learning-candidate-storage-001",
            candidate: learningCandidate({
              candidate_id: "candidate_changed_under_same_key",
            }),
          }),
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    } finally {
      await reopened.close();
    }
  });

  it("rejects stale transitions, foreign scope reads, and direct rewrites", async () => {
    const dataRoot = temporaryRoot("learning-guards");
    const storage = await SqliteStorageClient.open({ dataRoot });
    const trace = learningTrace();
    const candidate = learningCandidate();
    try {
      await storage.writeLearningLedger(
        writeCommand({
          kind: "trace",
          idempotency_key: "learning-trace-guards-001",
          trace,
        }),
      );
      await storage.writeLearningLedger(
        writeCommand({
          kind: "candidate",
          idempotency_key: "learning-candidate-guards-001",
          candidate,
        }),
      );
      await storage.writeLearningLedger(
        writeCommand({
          kind: "transition",
          idempotency_key: "learning-transition-guards-001",
          transition: learningTransition(),
        }),
      );
      await expect(
        storage.writeLearningLedger(
          writeCommand({
            kind: "transition",
            idempotency_key: "learning-transition-stale-001",
            transition: learningTransition({
              transition_id: "transition_storage_stale",
              sequence: 2,
              from_state: "proposed",
              to_state: "rejected",
              expected_previous_transition_hash:
                learningTransition().transition_hash,
            }),
          }),
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(
        await storage.readLearningLedger({
          principal_id: "other_user",
          scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
          candidate_id: candidate.candidate_id,
        }),
      ).toMatchObject({ traces: [], candidates: [], transitions: [] });
    } finally {
      await storage.close();
    }

    const database = new DatabaseSync(join(dataRoot, "ledger", "memory.db"));
    expect(() =>
      database.exec(
        "UPDATE learning_candidates SET candidate_hash = candidate_hash",
      ),
    ).toThrow(/APPEND_ONLY/u);
    expect(() =>
      database.exec("DELETE FROM learning_traces"),
    ).toThrow(/APPEND_ONLY/u);
    database.close();
  });

  it("persists protected evaluation, canary, release, monitor, and control chains", async () => {
    const dataRoot = temporaryRoot("learning-complete-ledger");
    const storage = await SqliteStorageClient.open({ dataRoot });
    try {
      await storage.writeLearningLedger(
        writeCommand({
          kind: "trace",
          idempotency_key: "learning-complete-trace-001",
          trace: learningTrace(),
        }),
      );
      await storage.writeLearningLedger(
        writeCommand({
          kind: "candidate",
          idempotency_key: "learning-complete-candidate-001",
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
            idempotency_key: `write-${transition.idempotency_key}`,
            transition,
          }),
        );
      }

      const resultSets = (
        ["calibration", "holdout", "transfer"] as const
      ).map(learningResultSet);
      expect(
        await storage.writeLearningLedger(
          writeCommand({
            kind: "evaluation",
            idempotency_key: "learning-evaluation-storage-001",
            principal_id: "user_local",
            scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
            identity: learningEvaluationIdentity(),
            partition_seals: learningPartitionSeals(),
            result_sets: resultSets,
            contamination_events: [],
            receipt: learningEvalReceipt(),
          }),
        ),
      ).toMatchObject({
        kind: "evaluation",
        replayed: false,
        receipt: { kind: "evaluation" },
      });
      expect(
        await storage.writeLearningLedger(
          writeCommand({
            kind: "canary",
            idempotency_key: "learning-canary-storage-001",
            idempotency_hash:
              learningCanaryAuthorization().request_hash,
            principal_id: "user_local",
            scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
            authorization: learningCanaryAuthorization(),
            transition: canaryTransition,
            run: learningCanaryRun(),
            receipt: learningCanaryReceipt(),
          }),
        ),
      ).toMatchObject({
        kind: "canary",
        receipt: { kind: "learning_canary" },
      });

      const releaseAuthority = verifiedLearningApproval({
        tool: "learning_release",
        requestHash: learningReleaseReceipt().request_hash,
        learning: releaseApprovalDetails(),
      });
      const releaseTransition = learningTransition({
        transition_id: "transition_storage_release",
        sequence: 5,
        from_state: "canary",
        to_state: "released",
        expected_previous_transition_hash:
          transitionChain.at(-1)?.transition_hash ?? null,
        idempotency_key: "transition-storage-release-001",
        authority_id: releaseAuthority.approval.grant.approval_id,
        evidence_receipt_ids: [
          "receipt_eval_storage_1",
          "receipt_canary_storage_1",
        ],
      });
      expect(
        await storage.writeLearningLedger({
          kind: "release",
          idempotency_key: "learning-release-storage-001",
          request_hash: learningReleaseReceipt().request_hash,
          principal_id: "user_local",
          scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
          expected_control_epoch: 0,
          expected_pointer_revision: 0,
          approval_artifact: postCanaryApproval(),
          approval_binding: releaseAuthority.binding,
          approval: releaseAuthority.approval,
          release: learningReleaseVersion(),
          pointer: learningReleasePointer(),
          transition: releaseTransition,
          receipt: learningReleaseReceipt(),
        }),
      ).toMatchObject({
        kind: "release",
        receipt: { kind: "release" },
      });

      expect(
        await storage.writeLearningLedger(
          writeCommand({
            kind: "monitor",
            idempotency_key: "learning-monitor-storage-001",
            principal_id: "user_local",
            scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
            monitor: learningMonitorResult(),
            receipt: learningMonitorReceipt(),
          }),
        ),
      ).toMatchObject({
        kind: "monitor",
        receipt: { kind: "learning_monitor" },
      });

      const rollbackAuthority = verifiedLearningApproval({
        tool: "learning_rollback",
        requestHash: learningRollbackReceipt().request_hash,
        learning: rollbackApprovalDetails(),
      });
      const rollbackTransition = learningTransition({
        transition_id: "transition_storage_rollback",
        sequence: 6,
        from_state: "released",
        to_state: "rolled_back",
        expected_previous_transition_hash: releaseTransition.transition_hash,
        idempotency_key: "transition-storage-rollback-001",
        authority_id: rollbackAuthority.approval.grant.approval_id,
        evidence_receipt_ids: [
          "receipt_eval_storage_1",
          "receipt_canary_storage_1",
          "receipt_monitor_storage_1",
        ],
      });
      expect(
        await storage.writeLearningLedger({
          kind: "rollback",
          idempotency_key: "learning-rollback-storage-001",
          request_hash: learningRollbackReceipt().request_hash,
          principal_id: "user_local",
          scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
          expected_control_epoch: 0,
          expected_pointer_revision: 1,
          approval_artifact: postCanaryRollbackApproval(),
          approval_binding: rollbackAuthority.binding,
          approval: rollbackAuthority.approval,
          release: learningRollbackVersion(),
          pointer: learningRollbackPointer(),
          transition: rollbackTransition,
          receipt: learningRollbackReceipt(),
        }),
      ).toMatchObject({
        kind: "rollback",
        receipt: { kind: "rollback" },
      });

      const observedLearningFrontier = (
        await storage.health()
      ).learning_frontier.frontier_hash;
      const postReleaseControl = learningControl("paused", {
        reason_code: "RELEASE_COMPLETED_BEFORE_PAUSE",
        frontier_hash: canonicalSha256({
          previous_frontier_hash: observedLearningFrontier,
          action: "pause",
          release_id: learningReleaseVersion().release_id,
        }),
      });
      const postReleaseControlReceipt = learningControlReceipt("pause", {
        previous_frontier_hash: observedLearningFrontier,
        frontier_hash: postReleaseControl.frontier_hash,
        reason_code: "RELEASE_COMPLETED_BEFORE_PAUSE",
      });
      const controlAuthority = verifiedLearningApproval({
        tool: "learning_pause",
        requestHash: postReleaseControlReceipt.request_hash,
      });
      expect(
        await storage.writeLearningLedger({
          kind: "control",
          idempotency_key: "learning-control-storage-001",
          request_hash: postReleaseControlReceipt.request_hash,
          expected_control_epoch: 0,
          expected_frontier_hash: observedLearningFrontier,
          control: postReleaseControl,
          receipt: postReleaseControlReceipt,
          approval_binding: controlAuthority.binding,
          approval: controlAuthority.approval,
        }),
      ).toMatchObject({
        kind: "control",
        receipt: { kind: "learning_control" },
      });

      const ledger = await storage.readLearningLedger({
        principal_id: "user_local",
        scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
        candidate_id: "candidate_storage_1",
      });
      expect(ledger.evaluation_identities).toHaveLength(1);
      expect(ledger.evaluation_result_sets).toHaveLength(3);
      expect(ledger.canary_runs).toHaveLength(1);
      expect(ledger.releases).toEqual([
        learningReleaseVersion(),
        learningRollbackVersion(),
      ]);
      expect(ledger.pointers).toEqual([learningRollbackPointer()]);
      expect(ledger.monitors).toEqual([learningMonitorResult()]);
      expect(ledger.controls).toEqual([postReleaseControl]);
      expect(ledger.receipts.map((receipt) => receipt.kind)).toEqual([
        "evaluation",
        "learning_canary",
        "release",
        "learning_monitor",
        "rollback",
        "learning_control",
      ]);
    } finally {
      await storage.close();
    }
  });
});
