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
  type ReleaseRequestFixture,
} from "../helpers/g5-release.js";

const cleanupPaths: string[] = [];

function temporaryRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "memo-graph-release-crash-")),
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

describe("learning release recovery", () => {
  it.each([
    "after_guard",
    "after_canonical_effect",
    "after_release",
    "after_pointer",
    "after_transition",
    "after_receipt",
    "after_approval",
    "after_idempotency",
  ] as const)("rolls back the whole release at %s", async (failurePoint) => {
    const dataRoot = temporaryRoot();
    let storage = await SqliteStorageClient.open({
      dataRoot,
      testOperations: true,
    });
    const prepared = await preparePassedCanary({
      storage,
      suffix: failurePoint,
    });
    const request = releaseRequest({
      suffix: failurePoint,
      approvalId: `post_canary_release_${failurePoint}`,
      failurePoint:
        failurePoint as ReleaseRequestFixture["test_failure_point"],
    });
    const approvals = new TestReleaseApprovalRegistry();
    authorizeRelease({ request, prepared, approvals });
    const manager = new LearningReleaseManager({
      storage,
      authorityRegistry: prepared.authority,
      approvalRegistry: approvals,
      clock: () => "2026-07-28T12:05:00.000Z",
    });

    await expect(manager.apply(request)).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    });
    await storage.close();
    storage = await SqliteStorageClient.open({
      dataRoot,
      testOperations: true,
    });
    try {
      const ledger = await storage.readLearningLedger({
        principal_id: request.principal_id,
        scopes: [...request.scopes],
        release_slot_hash:
          prepared.candidate.release_slot?.slot_hash,
      });
      expect(ledger.releases).toEqual([]);
      expect(ledger.pointers).toEqual([]);
      expect(ledger.candidate_states[0]?.state).toBe("canary");
      expect(
        await storage.replayLearningLedger({
          idempotency_key: request.idempotency_key,
          idempotency_hash:
            (await import("../../packages/contracts/src/index.js"))
              .canonicalSha256(request),
        }),
      ).toBeNull();
    } finally {
      await storage.close();
    }
  });
});
