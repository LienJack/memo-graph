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
import { inlineEpisode } from "../helpers/storage-examples.js";

const NOW = "2026-07-28T13:00:00.000Z";
const SCOPE = {
  kind: "workspace",
  id: "workspace_local",
} as const;
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
    clock: () => NOW,
    policy: {
      principal: {
        principal_id: "user_local",
        allowed_scopes: [SCOPE],
        allowed_authorities: ["user_stated"],
        destructive_tools_enabled: false,
      },
      default_token_budget: 1_800,
    },
  });
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target !== undefined) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

describe("frozen governance replay", () => {
  it("replays proposal and correction receipts across restart before mutable checks", async () => {
    const dataRoot = temporaryRoot("governance-replay");
    let storage = await SqliteStorageClient.open({ dataRoot });
    await storage.commitEpisode(
      inlineEpisode({ text: "Frozen replay evidence marker 4183." }),
    );
    const approvals = new TestApprovalRegistry();
    let kernel = runtime(storage, approvals);
    const proposal = memoryProposal({
      candidate: memoryCandidate({
        candidateId: "candidate_frozen_replay",
        logicalKey: "user.preference.frozen_replay",
        scope: SCOPE,
        text: "Frozen replay original marker 5294.",
      }),
      idempotencyKey: "memory-propose-frozen-replay-001",
      requestId: "request_memory_propose_frozen_replay",
    });
    const proposed = await kernel.memoryPropose(proposal);
    expect(proposed.status).toBe("OK");
    if (proposed.status !== "OK") {
      throw new Error("frozen replay proposal must activate");
    }
    const identity = proposed.data as {
      memory_id: string;
      current_revision_id: string;
    };
    const replacement = {
      storage: "inline",
      text: "Frozen replay corrected marker 6305.",
      media_type: "text/plain",
    } as const;
    const correction = {
      envelope: {
        schema_version: "1.0.0",
        request_id: "request_memory_correct_frozen_replay",
        tool: "memory_correct",
        safety_class: "important_mutation",
        actor_claim: {
          principal_id: "user_local",
          authority: "user_stated",
        },
        scopes: [SCOPE],
        purpose: "Replay one frozen correction",
        reason: "Prove replay is independent of later mutable state",
        requested_at: NOW,
        idempotency_key: "memory-correct-frozen-replay-001",
        expected_revision_id: identity.current_revision_id,
        approval_id: "approval_correct_frozen_replay",
        dry_run: false,
      },
      memory_id: identity.memory_id,
      replacement: {
        content: replacement,
        content_hash: canonicalSha256(replacement),
        evidence_ids: ["evidence_storage_1"],
        validity: {
          valid_from: NOW,
          valid_to: null,
          recorded_at: NOW,
        },
        reason: "Correct the frozen replay preference",
      },
    } as const;
    approvals.approve(correction);
    const corrected = await kernel.memoryCorrect(correction);
    expect(corrected.status).toBe("OK");
    if (corrected.status !== "OK") {
      throw new Error("frozen replay correction must succeed");
    }
    const frozenReceipt = (
      corrected.data as {
        receipt: Parameters<typeof receiptHashIsValid>[0];
      }
    ).receipt;
    expect(receiptHashIsValid(frozenReceipt)).toBe(true);
    const approvalChecks = approvals.verifyCalls;
    await storage.close();

    storage = await SqliteStorageClient.open({ dataRoot });
    kernel = runtime(storage, approvals);
    approvals.grants.clear();
    const proposalReplay = await kernel.memoryPropose(proposal);
    expect(proposalReplay).toMatchObject({
      status: "OK",
      receipt_id: proposed.receipt_id,
      data: {
        replayed: true,
        current_revision_id: identity.current_revision_id,
      },
    });
    const correctionReplay = await kernel.memoryCorrect(correction);
    expect(correctionReplay).toMatchObject({
      status: "OK",
      receipt_id: corrected.receipt_id,
      data: { replayed: true },
    });
    if (correctionReplay.status === "OK") {
      expect(
        (correctionReplay.data as { receipt: unknown }).receipt,
      ).toEqual(frozenReceipt);
    }
    expect(approvals.verifyCalls).toBe(approvalChecks);

    const changedReplacement = {
      ...replacement,
      text: "Changed content must not reuse the frozen request key.",
    };
    expect(
      await kernel.memoryCorrect({
        ...correction,
        replacement: {
          ...correction.replacement,
          content: changedReplacement,
          content_hash: canonicalSha256(changedReplacement),
        },
      }),
    ).toMatchObject({
      status: "FAILED",
      error: { code: "CONFLICT" },
    });
    await storage.close();
  });
});
