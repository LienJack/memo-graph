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
  receiptHashIsValid,
} from "../../packages/contracts/src/index.js";
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

function mutationEnvelope(options: {
  tool: "memory_correct" | "memory_pin" | "memory_usage_set";
  idempotencyKey: string;
  expectedRevisionId: string;
  approvalId: string;
}) {
  return {
    schema_version: "1.0.0",
    request_id: `request_${options.idempotencyKey}`,
    tool: options.tool,
    safety_class: "important_mutation" as const,
    actor_claim: {
      principal_id: "user_local",
      authority: "user_stated" as const,
    },
    scopes: [PURGE_SCOPE],
    purpose: "Run the frozen G2 governance loop",
    reason: "Prove one governed effect and its durable replay",
    requested_at: PURGE_NOW,
    idempotency_key: options.idempotencyKey,
    expected_revision_id: options.expectedRevisionId,
    approval_id: options.approvalId,
    dry_run: false,
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

describe("end-to-end L1 governance loop", () => {
  it("activates, corrects, controls, tombstones, restarts, retries, and never resurrects", async () => {
    const dataRoot = temporaryRoot("g2-loop");
    let storage = await SqliteStorageClient.open({ dataRoot });
    await storage.commitEpisode(
      inlineEpisode({ text: "G2 original preference marker 1946." }),
    );
    const approvals = new TestApprovalRegistry();
    let kernel = runtime(storage, approvals);
    const proposed = await kernel.memoryPropose(
      memoryProposal({
        candidate: memoryCandidate({
          candidateId: "candidate_g2_loop_original",
          logicalKey: "user.preference.g2_loop",
          scope: PURGE_SCOPE,
          text: "G2 original preference marker 1946.",
        }),
        idempotencyKey: "memory-propose-g2-loop-001",
      }),
    );
    expect(proposed.status).toBe("OK");
    if (proposed.status !== "OK") {
      throw new Error("G2 proposal must activate");
    }
    const original = proposed.data as {
      memory_id: string;
      current_revision_id: string;
    };

    const lagged = await storage.searchGovernedMemory({
      query: "G2 original preference marker 1946",
      principal_id: "user_local",
      scope: PURGE_SCOPE,
      as_of: PURGE_NOW,
      include_sensitive: false,
      context_scope: PURGE_SCOPE,
      limit: 20,
    });
    expect(lagged.items).toEqual([
      expect.objectContaining({
        lane: "sqlite_canonical",
        item: expect.objectContaining({
          memory_id: original.memory_id,
          revision_id: original.current_revision_id,
        }),
      }),
    ]);

    const replacementContent = {
      storage: "inline",
      text: "G2 corrected preference marker 2857.",
      media_type: "text/plain",
    } as const;
    const correction = {
      envelope: mutationEnvelope({
        tool: "memory_correct",
        idempotencyKey: "memory-correct-g2-loop-001",
        expectedRevisionId: original.current_revision_id,
        approvalId: "approval_correct_g2_loop",
      }),
      memory_id: original.memory_id,
      replacement: {
        content: replacementContent,
        content_hash: canonicalSha256(replacementContent),
        evidence_ids: ["evidence_storage_1"],
        validity: {
          valid_from: PURGE_NOW,
          valid_to: "2026-07-29T13:00:00.000Z",
          recorded_at: PURGE_NOW,
        },
        reason: "Replace the original G2 fixture with its correction",
      },
    };
    approvals.approve(correction);
    const corrected = await kernel.memoryCorrect(correction);
    expect(corrected).toMatchObject({
      status: "OK",
      data: {
        outcome: "REVISED",
        memory_id: original.memory_id,
        replayed: false,
      },
    });
    if (corrected.status !== "OK") {
      throw new Error("G2 correction must succeed");
    }
    const correctedData = corrected.data as {
      current_revision_id: string;
      receipt: Parameters<typeof receiptHashIsValid>[0];
    };
    expect(receiptHashIsValid(correctedData.receipt)).toBe(true);
    expect(
      await storage.searchGovernedMemory({
        query: "G2 original preference marker 1946",
        principal_id: "user_local",
        scope: PURGE_SCOPE,
        as_of: PURGE_NOW,
        include_sensitive: false,
        context_scope: PURGE_SCOPE,
        limit: 20,
      }),
    ).toMatchObject({ items: [] });
    await storage.drainFtsOutbox();
    const contextRequest = {
      envelope: {
        schema_version: "1.0.0",
        request_id: "request_context_g2_loop",
        tool: "memory_context_compile",
        actor_claim: {
          principal_id: "user_local",
          authority: "user_stated",
        },
        scopes: [PURGE_SCOPE],
        purpose: "Freeze the corrected G2 Context",
        reason: "Prove later controls cannot replay prohibited content",
        requested_at: PURGE_NOW,
        safety_class: "read_only",
      },
      recall: {
        schema_version: "1.0.0",
        request_id: "request_context_g2_loop",
        goal: "Recall the corrected G2 preference",
        query: "G2 corrected preference marker 2857",
        scopes: [PURGE_SCOPE],
        as_of: PURGE_NOW,
        token_budget: 1_800,
        include_sensitive: false,
      },
    } as const;
    expect(await kernel.memoryContextCompile(contextRequest)).toMatchObject({
      status: "OK",
      data: {
        context_slice: {
          items: [
            {
              memory_id: original.memory_id,
              revision_id: correctedData.current_revision_id,
            },
          ],
        },
      },
    });

    const pin = {
      envelope: mutationEnvelope({
        tool: "memory_pin",
        idempotencyKey: "memory-pin-g2-loop-001",
        expectedRevisionId: correctedData.current_revision_id,
        approvalId: "approval_pin_g2_loop",
      }),
      memory_id: original.memory_id,
      pinned: true,
    };
    approvals.approve(pin);
    expect(await kernel.memoryPin(pin)).toMatchObject({
      status: "OK",
      data: { outcome: "PINNED", pinned: true },
    });
    expect(
      await storage.checkMemoryEligibility({
        memory_id: original.memory_id,
        revision_id: correctedData.current_revision_id,
        principal_id: "user_local",
        scope: PURGE_SCOPE,
        as_of: "2026-07-30T13:00:00.000Z",
        include_sensitive: false,
        context_scope: PURGE_SCOPE,
      }),
    ).toMatchObject({
      eligible: false,
      reason_code: "EXPIRED",
    });
    const usageBlock = {
      envelope: mutationEnvelope({
        tool: "memory_usage_set",
        idempotencyKey: "memory-usage-g2-loop-001",
        expectedRevisionId: correctedData.current_revision_id,
        approvalId: "approval_usage_g2_loop",
      }),
      memory_id: original.memory_id,
      effect: "block" as const,
      context_scope: PURGE_SCOPE,
    };
    approvals.approve(usageBlock);
    expect(await kernel.memoryUsageSet(usageBlock)).toMatchObject({
      status: "OK",
      data: { outcome: "USAGE_BLOCKED" },
    });
    expect(
      await storage.checkMemoryEligibility({
        memory_id: original.memory_id,
        revision_id: correctedData.current_revision_id,
        principal_id: "user_local",
        scope: PURGE_SCOPE,
        as_of: PURGE_NOW,
        include_sensitive: false,
        context_scope: PURGE_SCOPE,
      }),
    ).toMatchObject({
      eligible: false,
      reason_code: "USAGE_BLOCKED",
    });
    expect(await kernel.memoryContextCompile(contextRequest)).toMatchObject({
      status: "FAILED",
      error: { code: "CONFLICT" },
    });

    const deletion = deleteRequest({
      memoryId: original.memory_id,
      revisionId: correctedData.current_revision_id,
      idempotencyKey: "memory-delete-g2-loop-001",
      approvalId: "approval_delete_g2_loop",
    });
    approvals.approve(deletion);
    const deleted = await kernel.memoryDelete(deletion);
    expect(deleted).toMatchObject({
      status: "OK",
      data: { outcome: "TOMBSTONED", tombstone_epoch: 1 },
    });
    if (deleted.status !== "OK") {
      throw new Error("G2 delete must tombstone");
    }
    const deleteData = deleted.data as {
      purge_job_id: string;
      receipt: Parameters<typeof receiptHashIsValid>[0];
    };
    expect(receiptHashIsValid(deleteData.receipt)).toBe(true);
    await storage.close();

    storage = await SqliteStorageClient.open({ dataRoot });
    kernel = runtime(storage, approvals);
    approvals.grants.clear();
    expect(await kernel.memoryDelete(deletion)).toMatchObject({
      status: "OK",
      receipt_id: deleted.receipt_id,
      data: { replayed: true },
    });
    const purgeReceipt = await storage.runPurge({
      purge_job_id: deleteData.purge_job_id,
    });
    expect(purgeReceipt).toMatchObject({
      completed: true,
      residual_hashes: [],
    });
    expect(
      await storage.runPurge({ purge_job_id: deleteData.purge_job_id }),
    ).toEqual(purgeReceipt);
    await storage.rebuildFts();
    expect(
      await storage.searchGovernedMemory({
        query: "G2 corrected preference marker 2857",
        principal_id: "user_local",
        scope: PURGE_SCOPE,
        as_of: PURGE_NOW,
        include_sensitive: false,
        context_scope: PURGE_SCOPE,
        limit: 20,
      }),
    ).toMatchObject({ items: [] });
    expect(await storage.verifyRestoreCandidate()).toMatchObject({
      integrity_check: "ok",
      incomplete_purge_jobs: 0,
      residual_hashes: [],
    });
    await storage.close();
  });
});
