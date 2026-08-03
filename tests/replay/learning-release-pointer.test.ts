import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  LearningReleaseManager,
} from "../../packages/learning-lab/src/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";

import {
  authorizeRelease,
  preparePassedCanary,
  releaseRequest,
  TestReleaseApprovalRegistry,
} from "../helpers/g5-release.js";

const cleanupPaths: string[] = [];

function temporaryRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "memo-graph-release-cas-")),
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

describe("learning release pointer CAS", () => {
  it("allows one winner from one observed pointer", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot(),
    });
    try {
      const prepared = await preparePassedCanary({
        storage,
        suffix: "concurrent",
      });
      const first = releaseRequest({
        suffix: "concurrent-a",
        approvalId: "post_canary_release_concurrent_a",
      });
      const second = releaseRequest({
        suffix: "concurrent-b",
        approvalId: "post_canary_release_concurrent_b",
      });
      const approvals = new TestReleaseApprovalRegistry();
      authorizeRelease({ request: first, prepared, approvals });
      authorizeRelease({ request: second, prepared, approvals });
      const manager = new LearningReleaseManager({
        storage,
        authorityRegistry: prepared.authority,
        approvalRegistry: approvals,
        clock: () => "2026-07-28T12:05:00.000Z",
      });

      const outcomes = await Promise.allSettled([
        manager.apply(first),
        manager.apply(second),
      ]);
      expect(
        outcomes.filter((outcome) => outcome.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        outcomes.filter((outcome) => outcome.status === "rejected"),
      ).toHaveLength(1);
      const ledger = await storage.readLearningLedger({
        principal_id: first.principal_id,
        scopes: [...first.scopes],
        release_slot_hash:
          prepared.candidate.release_slot?.slot_hash,
      });
      expect(ledger.releases).toHaveLength(1);
      expect(ledger.pointers[0]?.pointer_revision).toBe(1);
      expect(ledger.candidate_states[0]?.state).toBe("released");
    } finally {
      await storage.close();
    }
  });
});
