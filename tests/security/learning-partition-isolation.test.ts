import {
  cpSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  G5PartitionLoader,
} from "../../packages/learning-lab/src/index.js";
import { canonicalSha256 } from "../../packages/contracts/src/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import { NOW } from "../helpers/examples.js";
import {
  G5_FIXTURE_ROOT,
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

describe("G5 partition and fixture isolation", () => {
  it("records forbidden calibration access and invalidates the evaluation", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("g5-contamination"),
    });
    try {
      await seedLearningCandidate(storage);
      const loader = new G5PartitionLoader({
        fixtureRoot: G5_FIXTURE_ROOT,
        clock: () => NOW,
      });
      await expect(
        loader.loadPartition({
          role: "calibration_tuning",
          partition: "holdout",
        }),
      ).rejects.toMatchObject({
        code: "PARTITION_ACCESS_DENIED",
      });
      const result = await runG5Evaluation({
        storage,
        loader,
        idempotencyKey: "g5-contaminated-evaluation-001",
        runId: "run_g5_contaminated_1",
      });
      expect(result.receipt).toMatchObject({
        passed: false,
        invalidated: true,
      });
      expect(result.receipt.contamination_event_ids).toHaveLength(1);
      expect(
        result.rules.find((rule) => rule.rule_id === "NO_CONTAMINATION"),
      ).toMatchObject({ passed: false });
      const ledger = await storage.readLearningLedger({
        principal_id: "user_local",
        scopes: result.scopes,
        candidate_id: result.identity.candidate_id,
      });
      expect(ledger.contamination_events).toHaveLength(1);
    } finally {
      await storage.close();
    }
  });

  it("rejects fixture mutation after the manifest is frozen", async () => {
    const fixtureRoot = temporaryRoot("g5-tampered-fixtures");
    cpSync(G5_FIXTURE_ROOT, fixtureRoot, { recursive: true });
    const target = join(
      fixtureRoot,
      "holdout/g5-hold-policy-gain.case.json",
    );
    const body = JSON.parse(readFileSync(target, "utf8")) as {
      description: string;
    };
    body.description = "Tampered after freeze.";
    writeFileSync(target, `${JSON.stringify(body, null, 2)}\n`);
    const loader = new G5PartitionLoader({
      fixtureRoot,
      clock: () => NOW,
    });
    await expect(
      loader.loadPartition({
        role: "gate_evaluator",
        partition: "holdout",
      }),
    ).rejects.toMatchObject({ code: "FIXTURE_HASH_MISMATCH" });
  });

  it("invalidates any evaluation that changes normal runtime state", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("g5-state-side-effect"),
    });
    try {
      await seedLearningCandidate(storage);
      let probeCount = 0;
      const result = await runG5Evaluation({
        storage,
        idempotencyKey: "g5-state-side-effect-001",
        runId: "run_g5_state_side_effect_1",
        stateProbe: () => {
          probeCount += 1;
          return canonicalSha256({
            state: probeCount === 1 ? "before" : "after",
          });
        },
      });
      expect(result.receipt).toMatchObject({
        passed: false,
        invalidated: true,
      });
      expect(
        result.rules.find((rule) => rule.rule_id === "NO_CONTAMINATION"),
      ).toMatchObject({ passed: false });
      const ledger = await storage.readLearningLedger({
        principal_id: "user_local",
        scopes: result.scopes,
        candidate_id: result.identity.candidate_id,
      });
      expect(
        ledger.contamination_events.map((event) => event.code),
      ).toContain("NORMAL_STATE_MUTATED");
    } finally {
      await storage.close();
    }
  });
});
