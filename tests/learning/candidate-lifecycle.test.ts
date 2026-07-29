import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CandidateLifecycle,
  reduceCandidateState,
} from "../../packages/learning-lab/src/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import {
  prepareApprovedCandidate,
} from "../helpers/g5-canary.js";
import { USER_SCOPE } from "../helpers/examples.js";
import {
  LEARNING_WORKSPACE_SCOPE,
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

describe("governed candidate lifecycle", () => {
  it("rejects skips, then persists and replays the legal evaluation path", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("g5-lifecycle"),
    });
    try {
      const prepared = await prepareApprovedCandidate({
        storage,
        runId: "run_g5_lifecycle_1",
        evaluationKey: "g5-lifecycle-evaluation-001",
      });
      const ledger = await storage.readLearningLedger({
        principal_id: "user_local",
        scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
        candidate_id: "candidate_storage_1",
      });
      expect(
        reduceCandidateState(
          "candidate_storage_1",
          ledger.transitions,
        ),
      ).toMatchObject({
        state: "approved_for_canary",
        sequence: 3,
        transition_hash:
          prepared.latest.transition.transition_hash,
      });
      const replay = await new CandidateLifecycle({
        storage,
      }).transition(prepared.latest.request);
      expect(replay).toMatchObject({
        replayed: true,
        transition: {
          transition_hash:
            prepared.latest.transition.transition_hash,
        },
      });
      await expect(
        new CandidateLifecycle({ storage }).transition({
          ...prepared.latest.request,
          reason_code: "CHANGED_UNDER_SAME_KEY",
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    } finally {
      await storage.close();
    }
  });

  it("refuses to approve an evaluation-only candidate or failed evaluation", async () => {
    expect(() =>
      reduceCandidateState("candidate_storage_1", [
        {
          ...({
            transition_id: "invalid_skip",
            candidate_id: "candidate_storage_1",
            sequence: 1,
            from_state: "proposed",
            to_state: "evaluating",
          } as const),
        },
      ]),
    ).toThrow();
  });
});
