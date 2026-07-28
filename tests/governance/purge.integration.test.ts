import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MemoryRuntime } from "../../packages/memory-kernel/src/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";

import { TestApprovalRegistry } from "../helpers/approval.js";
import {
  memoryCandidate,
  memoryProposal,
} from "../helpers/governance-examples.js";
import {
  PURGE_NOW,
  PURGE_SCOPE,
  deleteRequest,
} from "../helpers/purge-examples.js";
import { inlineEpisode } from "../helpers/storage-examples.js";

const cleanupPaths: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-graph-${prefix}-`)),
  );
  cleanupPaths.push(root);
  return root;
}

function runtime(
  storage: SqliteStorageClient,
  approvals: TestApprovalRegistry,
): MemoryRuntime {
  return new MemoryRuntime({
    storage,
    approvalRegistry: approvals,
    clock: () => PURGE_NOW,
    policy: {
      principal: {
        principal_id: "user_local",
        allowed_scopes: [PURGE_SCOPE],
        allowed_authorities: ["user_stated"],
        destructive_tools_enabled: true,
      },
      default_token_budget: 1_800,
    },
  });
}

async function propose(
  kernel: MemoryRuntime,
  options: {
    candidateId: string;
    logicalKey: string;
    idempotencyKey: string;
  },
) {
  const response = await kernel.memoryPropose(
    memoryProposal({
      candidate: memoryCandidate({
        candidateId: options.candidateId,
        logicalKey: options.logicalKey,
        scope: PURGE_SCOPE,
        text: "Exclusive purge marker 8472.",
      }),
      idempotencyKey: options.idempotencyKey,
      requestId: `request_${options.idempotencyKey}`,
    }),
  );
  expect(response.status).toBe("OK");
  if (response.status !== "OK") {
    throw new Error("proposal fixture must activate");
  }
  return response.data as {
    memory_id: string;
    current_revision_id: string;
  };
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target !== undefined) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

describe("tombstone and purge saga", () => {
  it("tombstones synchronously and completes an exclusive purge after restart", async () => {
    const dataRoot = temporaryRoot("purge-exclusive");
    let storage = await SqliteStorageClient.open({ dataRoot });
    await storage.commitEpisode(
      inlineEpisode({ text: "Exclusive purge marker 8472." }),
    );
    const approvals = new TestApprovalRegistry();
    const kernel = runtime(storage, approvals);
    const admitted = await propose(kernel, {
      candidateId: "candidate_purge_exclusive",
      logicalKey: "user.preference.purge_exclusive",
      idempotencyKey: "memory-propose-purge-exclusive",
    });
    await storage.drainFtsOutbox();
    const dryRun = deleteRequest({
      memoryId: admitted.memory_id,
      revisionId: admitted.current_revision_id,
      idempotencyKey: "memory-delete-exclusive-dry-run-001",
      approvalId: null,
      dryRun: true,
    });
    expect(await kernel.memoryDelete(dryRun)).toMatchObject({
      status: "OK",
      data: {
        outcome: "DRY_RUN",
        tombstone_epoch: null,
        purge_job_id: null,
      },
    });
    expect((await storage.health()).tombstone_epoch).toBe(0);
    const deletion = deleteRequest({
      memoryId: admitted.memory_id,
      revisionId: admitted.current_revision_id,
      idempotencyKey: "memory-delete-exclusive-001",
      approvalId: "approval_delete_exclusive",
    });
    approvals.approve(deletion);

    const deleted = await kernel.memoryDelete(deletion);
    expect(deleted).toMatchObject({
      status: "OK",
      data: {
        outcome: "TOMBSTONED",
        memory_id: admitted.memory_id,
        revision_id: admitted.current_revision_id,
        tombstone_epoch: 1,
      },
    });
    if (deleted.status !== "OK") {
      throw new Error("delete must return a purge job");
    }
    const approvalChecks = approvals.verifyCalls;
    expect(await kernel.memoryDelete(deletion)).toMatchObject({
      status: "OK",
      receipt_id: deleted.receipt_id,
      data: { replayed: true },
    });
    expect(approvals.verifyCalls).toBe(approvalChecks);
    const purgeJobId = (deleted.data as { purge_job_id: string })
      .purge_job_id;
    expect(
      await storage.checkMemoryEligibility({
        memory_id: admitted.memory_id,
        revision_id: admitted.current_revision_id,
        principal_id: "user_local",
        scope: PURGE_SCOPE,
        as_of: PURGE_NOW,
        include_sensitive: false,
        context_scope: PURGE_SCOPE,
      }),
    ).toMatchObject({ eligible: false, reason_code: "TOMBSTONED" });
    await storage.close();

    storage = await SqliteStorageClient.open({ dataRoot });
    const receipt = await storage.runPurge({
      purge_job_id: purgeJobId,
    });
    expect(receipt).toMatchObject({
      kind: "purge",
      purge_job_id: purgeJobId,
      completed: true,
      state: "purged",
      residual_hashes: [],
    });
    expect(receipt.store_outcomes).toHaveLength(9);
    expect(receipt.store_outcomes.every(
      (outcome) => outcome.status === "verified",
    )).toBe(true);
    expect((await storage.health()).counts).toMatchObject({
      outbox_pending: 0,
      status_events: 3,
    });

    await storage.rebuildFts();
    expect(
      await storage.searchGovernedMemory({
        query: "Exclusive purge marker 8472",
        principal_id: "user_local",
        scope: PURGE_SCOPE,
        as_of: PURGE_NOW,
        include_sensitive: false,
        context_scope: PURGE_SCOPE,
        limit: 20,
      }),
    ).toMatchObject({ items: [] });
    expect(
      await storage.getEvidence({
        evidence_id: "evidence_storage_1",
        principal_id: "user_local",
        scope: PURGE_SCOPE,
      }),
    ).toBeNull();
    await storage.close();
  });

  it("keeps shared evidence as residual debt until every live reference is gone", async () => {
    const dataRoot = temporaryRoot("purge-shared");
    const storage = await SqliteStorageClient.open({ dataRoot });
    const episode = inlineEpisode({ text: "Shared purge marker 9361." });
    await storage.commitEpisode(episode);
    const approvals = new TestApprovalRegistry();
    const kernel = runtime(storage, approvals);
    const first = await propose(kernel, {
      candidateId: "candidate_purge_shared_a",
      logicalKey: "user.preference.purge_shared_a",
      idempotencyKey: "memory-propose-purge-shared-a",
    });
    const second = await propose(kernel, {
      candidateId: "candidate_purge_shared_b",
      logicalKey: "user.preference.purge_shared_b",
      idempotencyKey: "memory-propose-purge-shared-b",
    });

    const firstDelete = deleteRequest({
      memoryId: first.memory_id,
      revisionId: first.current_revision_id,
      idempotencyKey: "memory-delete-shared-a-001",
      approvalId: "approval_delete_shared_a",
    });
    approvals.approve(firstDelete);
    const firstDeleted = await kernel.memoryDelete(firstDelete);
    if (firstDeleted.status !== "OK") {
      throw new Error("first shared delete must tombstone");
    }
    const firstJob = (firstDeleted.data as { purge_job_id: string })
      .purge_job_id;
    const partial = await storage.runPurge({ purge_job_id: firstJob });
    expect(partial).toMatchObject({
      completed: false,
      state: "partial",
      residual_hashes: [episode.evidence[0]?.content_hash],
    });

    const secondDelete = deleteRequest({
      memoryId: second.memory_id,
      revisionId: second.current_revision_id,
      idempotencyKey: "memory-delete-shared-b-001",
      approvalId: "approval_delete_shared_b",
    });
    approvals.approve(secondDelete);
    const secondDeleted = await kernel.memoryDelete(secondDelete);
    if (secondDeleted.status !== "OK") {
      throw new Error("second shared delete must tombstone");
    }
    const secondJob = (secondDeleted.data as { purge_job_id: string })
      .purge_job_id;
    expect(
      await storage.runPurge({ purge_job_id: secondJob }),
    ).toMatchObject({ completed: true, state: "purged" });
    expect(await storage.runPurge({ purge_job_id: firstJob })).toMatchObject({
      purge_job_id: firstJob,
      completed: true,
      state: "purged",
      residual_hashes: [],
    });
    await storage.close();
  });
});
