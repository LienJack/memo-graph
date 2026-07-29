import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalSha256,
} from "../../packages/contracts/src/index.js";
import {
  G5PartitionLoader,
  LearningCanaryRunner,
} from "../../packages/learning-lab/src/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import {
  TestLearningAuthorityRegistry,
  canaryAuthorization,
  canaryInput,
  prepareApprovedCandidate,
} from "../helpers/g5-canary.js";
import { NOW } from "../helpers/examples.js";
import { G5_FIXTURE_ROOT } from "../helpers/g5-replay.js";
import {
  learningControl,
  learningControlReceipt,
  verifiedLearningApproval,
} from "../helpers/learning-examples.js";

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

describe("bounded governed canary", () => {
  it("consumes one exact authorization, exposes three cases once, and never moves the pointer", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("g5-canary-pass"),
    });
    try {
      const prepared = await prepareApprovedCandidate({
        storage,
        runId: "run_g5_canary_pass_1",
        evaluationKey: "g5-canary-pass-evaluation-001",
      });
      const input = await canaryInput({
        evaluation: prepared.evaluation,
      });
      const authority = new TestLearningAuthorityRegistry();
      authority.canaryAuthorizations.set(
        input.authorization_id,
        await canaryAuthorization({
          evaluation: prepared.evaluation,
          input,
        }),
      );
      const exposures: string[] = [];
      const runner = new LearningCanaryRunner({
        storage,
        partitions: new G5PartitionLoader({
          fixtureRoot: G5_FIXTURE_ROOT,
          clock: () => NOW,
        }),
        authorityRegistry: authority,
        executeCase: (request) => {
          exposures.push(request.case_body.case_id);
          return {
            case_id: request.case_body.case_id,
            stable_comparator_release_id:
              request.stable_release_id,
            passed: true,
            failure_codes: [],
            initial_state_hash: request.initial_state_hash,
            final_state_hash: request.initial_state_hash,
          };
        },
        stateProbe: () => prepared.evaluation.identity.environment_hash,
        clock: () => NOW,
      });
      const before = await storage.readLearningLedger({
        principal_id: "user_local",
        scopes: input.scopes,
      });
      const result = await runner.run(input);
      expect(result).toMatchObject({
        replayed: false,
        run: { status: "passed", exposure_count: 3 },
        receipt: { passed: true, exposures: 3 },
        transition: {
          from_state: "approved_for_canary",
          to_state: "canary",
        },
      });
      expect(new Set(exposures).size).toBe(3);
      expect(exposures).toHaveLength(3);
      const after = await storage.readLearningLedger({
        principal_id: "user_local",
        scopes: input.scopes,
        candidate_id: input.candidate_id,
      });
      expect(after.pointers).toEqual(before.pointers);
      expect(after.canary_authorizations).toHaveLength(1);
      expect(after.canary_runs).toHaveLength(1);
      expect(after.candidate_states[0]?.state).toBe("canary");
      expect(authority.verifyCanaryCalls).toBe(1);
      expect(authority.confirmCanaryCalls).toBe(1);

      const replayRunner = new LearningCanaryRunner({
        storage,
        partitions: {
          loadCanaryCases: async () => {
            throw new Error("replay must not open canary fixtures");
          },
        },
        authorityRegistry: authority,
        executeCase: async () => {
          throw new Error("replay must not execute canary");
        },
        stateProbe: async () => {
          throw new Error("replay must not probe mutable state");
        },
        clock: () => NOW,
      });
      expect(await replayRunner.run(input)).toMatchObject({
        replayed: true,
        receipt: { receipt_hash: result.receipt.receipt_hash },
      });
      expect(authority.verifyCanaryCalls).toBe(1);
    } finally {
      await storage.close();
    }
  });

  it("keeps canary fixtures sealed before approval and fails closed on drift", async () => {
    const loader = new G5PartitionLoader({
      fixtureRoot: G5_FIXTURE_ROOT,
      clock: () => NOW,
    });
    await expect(
      loader.loadCanaryCases({ candidate_state: "evaluating" }),
    ).rejects.toMatchObject({ code: "CANARY_ACCESS_DENIED" });
  });

  it("persists terminal frozen and aborted evidence for drift and timeout", async () => {
    for (const scenario of ["drift", "timeout"] as const) {
      const storage = await SqliteStorageClient.open({
        dataRoot: temporaryRoot(`g5-canary-${scenario}`),
      });
      try {
        const prepared = await prepareApprovedCandidate({
          storage,
          runId: `run_g5_canary_${scenario}_1`,
          evaluationKey: `g5-canary-${scenario}-evaluation-001`,
        });
        const input = await canaryInput({
          evaluation: prepared.evaluation,
        });
        const authority = new TestLearningAuthorityRegistry();
        authority.canaryAuthorizations.set(
          input.authorization_id,
          await canaryAuthorization({
            evaluation: prepared.evaluation,
            input,
          }),
        );
        let clockCalls = 0;
        let probeCalls = 0;
        const runner = new LearningCanaryRunner({
          storage,
          partitions: new G5PartitionLoader({
            fixtureRoot: G5_FIXTURE_ROOT,
            clock: () => NOW,
          }),
          authorityRegistry: authority,
          executeCase: (request) => ({
            case_id: request.case_body.case_id,
            stable_comparator_release_id:
              request.stable_release_id,
            passed: true,
            failure_codes: [],
            initial_state_hash: request.initial_state_hash,
            final_state_hash: request.initial_state_hash,
          }),
          stateProbe: () => {
            probeCalls += 1;
            return scenario === "drift" && probeCalls > 1
              ? canonicalSha256("mutated-canary-state")
              : prepared.evaluation.identity.environment_hash;
          },
          clock: () => {
            clockCalls += 1;
            return scenario === "timeout" && clockCalls > 1
              ? "2026-07-28T12:10:01.000Z"
              : NOW;
          },
        });
        const result = await runner.run(input);
        expect(result.run.status).toBe(
          scenario === "drift" ? "frozen" : "aborted",
        );
        expect(result.receipt).toMatchObject({
          passed: false,
          failure_codes: [
            scenario === "drift"
              ? "CANARY_STATE_DRIFT"
              : "CANARY_TIMEOUT",
          ],
        });
        const ledger = await storage.readLearningLedger({
          principal_id: input.principal_id,
          scopes: input.scopes,
          candidate_id: input.candidate_id,
        });
        expect(ledger.canary_runs).toHaveLength(1);
        expect(ledger.pointers).toEqual([]);
      } finally {
        await storage.close();
      }
    }
  });

  it("freezes an in-flight canary at one exposure when pause wins", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("g5-canary-pause"),
    });
    try {
      const prepared = await prepareApprovedCandidate({
        storage,
        runId: "run_g5_canary_pause_1",
        evaluationKey: "g5-canary-pause-evaluation-001",
      });
      const input = await canaryInput({
        evaluation: prepared.evaluation,
      });
      const authority = new TestLearningAuthorityRegistry();
      authority.canaryAuthorizations.set(
        input.authorization_id,
        await canaryAuthorization({
          evaluation: prepared.evaluation,
          input,
        }),
      );
      const controlReceipt = learningControlReceipt();
      const controlAuthority = verifiedLearningApproval({
        tool: "learning_pause",
        requestHash: controlReceipt.request_hash,
      });
      let exposures = 0;
      const runner = new LearningCanaryRunner({
        storage,
        partitions: new G5PartitionLoader({
          fixtureRoot: G5_FIXTURE_ROOT,
          clock: () => NOW,
        }),
        authorityRegistry: authority,
        executeCase: async (request) => {
          exposures += 1;
          if (exposures === 1) {
            await storage.writeLearningLedger({
              kind: "control",
              idempotency_key: "g5-canary-pause-control-001",
              request_hash: controlReceipt.request_hash,
              expected_control_epoch: 0,
              expected_frontier_hash:
                controlReceipt.previous_frontier_hash,
              control: learningControl(),
              receipt: controlReceipt,
              approval_binding: controlAuthority.binding,
              approval: controlAuthority.approval,
            });
          }
          return {
            case_id: request.case_body.case_id,
            stable_comparator_release_id:
              request.stable_release_id,
            passed: true,
            failure_codes: [],
            initial_state_hash: request.initial_state_hash,
            final_state_hash: request.initial_state_hash,
          };
        },
        stateProbe: () =>
          prepared.evaluation.identity.environment_hash,
        clock: () => NOW,
      });
      const result = await runner.run(input);
      expect(result).toMatchObject({
        run: { status: "frozen", exposure_count: 1 },
        receipt: {
          passed: false,
          failure_codes: ["LEARNING_PAUSED"],
        },
      });
      expect(exposures).toBe(1);
      const ledger = await storage.readLearningLedger({
        principal_id: input.principal_id,
        scopes: input.scopes,
        candidate_id: input.candidate_id,
      });
      expect(ledger.controls[0]?.status).toBe("paused");
      expect(ledger.pointers).toEqual([]);
      expect(ledger.canary_runs).toHaveLength(1);
    } finally {
      await storage.close();
    }
  });
});
