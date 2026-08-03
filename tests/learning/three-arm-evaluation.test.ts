import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  LearningEvaluationRunner,
} from "../../packages/learning-lab/src/index.js";
import { canonicalJson } from "../../packages/contracts/src/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import {
  G5_FIXTURE_ROOT,
  G5_STATE_HASH,
  runG5Evaluation,
  safeArmExecution,
  seedLearningCandidate,
} from "../helpers/g5-replay.js";

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

describe("G5 protected three-arm evaluation", () => {
  it("runs all three identical common identities and replays the frozen result", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("g5-three-arm"),
    });
    try {
      await seedLearningCandidate(storage);
      const first = await runG5Evaluation({
        storage,
        idempotencyKey: "g5-safe-evaluation-001",
        runId: "run_g5_safe_1",
      });
      expect(first.replayed).toBe(false);
      expect(first.receipt).toMatchObject({
        passed: true,
        invalidated: false,
      });
      expect(first.rules.every((rule) => rule.passed)).toBe(true);
      expect(first.result_sets).toHaveLength(9);
      for (const resultSet of first.result_sets) {
        expect(resultSet.results.map((result) => result.arm)).toEqual([
          "no_candidate",
          "current",
          "candidate",
        ]);
        expect(
          new Set(
            resultSet.results.map(
              (result) => result.common_identity_hash,
            ),
          ).size,
        ).toBe(1);
      }

      const replayOnly = new LearningEvaluationRunner({
        storage,
        partitions: {
          loadManifest: async () => {
            throw new Error("replay must not reopen fixtures");
          },
        },
        executeArm: async () => {
          throw new Error("replay must not execute an arm");
        },
        stateProbe: async () => {
          throw new Error("replay must not inspect mutable runtime state");
        },
      });
      const replay = await replayOnly.run({
        schema_version: "1.0.0",
        idempotency_key: "g5-safe-evaluation-001",
        principal_id: "user_local",
        scopes: first.scopes,
        identity: first.identity,
        candidate_hash: first.candidate_hash,
        fixture_manifest_hash: first.fixture_manifest_hash,
        thresholds_hash: first.thresholds_hash,
        started_at: first.started_at,
      });
      expect(replay).toMatchObject({
        replayed: true,
        receipt: { receipt_hash: first.receipt.receipt_hash },
      });
      expect(canonicalJson(replay.result_sets)).toBe(
        canonicalJson(first.result_sets),
      );
      expect(canonicalJson(replay.rules)).toBe(
        canonicalJson(first.rules),
      );
    } finally {
      await storage.close();
    }
  });

  it("binds changed evaluation identity to a new run and receipt", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("g5-identity"),
    });
    try {
      await seedLearningCandidate(storage);
      const first = await runG5Evaluation({
        storage,
        idempotencyKey: "g5-identity-evaluation-001",
        runId: "run_g5_identity_1",
      });
      const second = await runG5Evaluation({
        storage,
        idempotencyKey: "g5-identity-evaluation-002",
        runId: "run_g5_identity_2",
      });
      expect(second.identity.common_identity_hash).not.toBe(
        first.identity.common_identity_hash,
      );
      expect(second.receipt.receipt_hash).not.toBe(
        first.receipt.receipt_hash,
      );
      expect(await Promise.resolve(safeArmExecution)).toBeDefined();
      expect(G5_FIXTURE_ROOT).toBe("fixtures/g5");
      expect(G5_STATE_HASH).toMatch(/^sha256:/);
    } finally {
      await storage.close();
    }
  });
});
