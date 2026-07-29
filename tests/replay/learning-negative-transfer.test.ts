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
  harmfulTransferExecution,
  resultFor,
  runG5Evaluation,
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

describe("G5 negative-transfer rejection", () => {
  it("rejects calibration gain when transfer loses a current task unit", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("g5-negative-transfer"),
    });
    try {
      await seedLearningCandidate(storage);
      const before = await storage.readLearningLedger({
        principal_id: "user_local",
        scopes: [
          { kind: "user", id: "user_local" },
          { kind: "workspace", id: "workspace_local" },
        ],
      });
      const result = await runG5Evaluation({
        storage,
        idempotencyKey: "g5-negative-transfer-001",
        runId: "run_g5_negative_transfer_1",
        executeArm: harmfulTransferExecution,
      });
      expect(result.receipt).toMatchObject({
        passed: false,
        invalidated: false,
      });
      expect(
        result.rules.find(
          (rule) => rule.rule_id === "NO_REQUIRED_TASK_UNIT_LOSS",
        ),
      ).toMatchObject({ passed: false });
      expect(
        result.rules.find(
          (rule) => rule.rule_id === "GAIN_OVER_CURRENT_TRANSFER",
        ),
      ).toMatchObject({ passed: false });
      expect(
        resultFor(result, "g5_transfer_negative", "candidate"),
      ).toMatchObject({
        error_codes: ["REQUIRED_LANE_REMOVED"],
        negative_transfer_units: ["retain_required_relation_lane"],
      });
      const after = await storage.readLearningLedger({
        principal_id: "user_local",
        scopes: result.scopes,
      });
      expect(after.pointers).toEqual(before.pointers);
      expect(after.candidates).toEqual(before.candidates);
      expect(after.traces).toEqual(before.traces);
    } finally {
      await storage.close();
    }
  });
});
