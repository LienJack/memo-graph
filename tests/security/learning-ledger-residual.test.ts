import {
  existsSync,
  mkdtempSync,
  readFileSync,
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
  LEARNING_WORKSPACE_SCOPE,
  learningMemoryCandidate,
  learningTrace,
} from "../helpers/learning-examples.js";
import {
  PURGE_NOW,
  deleteRequest,
} from "../helpers/purge-examples.js";
import { inlineEpisode } from "../helpers/storage-examples.js";
import { USER_SCOPE } from "../helpers/examples.js";
import { canonicalSha256Omitting } from "../../packages/contracts/src/index.js";

const MARKER = "Learning purge marker 592731.";
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

describe("learning ledger privacy and purge residuals", () => {
  it("stores references only and invalidates a purged canonical target", async () => {
    const dataRoot = temporaryRoot("learning-residual");
    const storage = await SqliteStorageClient.open({ dataRoot });
    await storage.commitEpisode(inlineEpisode({ text: MARKER }));
    const approvals = new TestApprovalRegistry();
    const runtime = new MemoryRuntime({
      storage,
      approvalRegistry: approvals,
      clock: () => PURGE_NOW,
      policy: {
        principal: {
          principal_id: "user_local",
          allowed_scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
          allowed_authorities: ["user_stated"],
          destructive_tools_enabled: true,
        },
        default_token_budget: 1_800,
      },
    });
    const canonicalCandidate = memoryCandidate({
      candidateId: "candidate_learning_purge_source",
      logicalKey: "workspace.learning.purge_source",
      scope: LEARNING_WORKSPACE_SCOPE,
      text: MARKER,
    });
    const proposed = await runtime.memoryPropose(
      memoryProposal({
        candidate: canonicalCandidate,
        idempotencyKey: "memory-propose-learning-purge-001",
        requestId: "request_memory_propose_learning_purge_001",
      }),
    );
    expect(proposed.status).toBe("OK");
    if (proposed.status !== "OK") {
      throw new Error("canonical learning target fixture must activate");
    }
    const admitted = proposed.data as {
      memory_id: string;
      current_revision_id: string;
    };
    const trace = learningTrace();
    await storage.writeLearningLedger({
      kind: "trace",
      idempotency_key: "learning-purge-trace-001",
      trace,
      request_hash: canonicalSha256Omitting(
        {
          kind: "trace",
          idempotency_key: "learning-purge-trace-001",
          trace,
        },
        ["request_hash"],
      ),
    });
    const learningCandidateArtifact = learningMemoryCandidate({
      memoryId: admitted.memory_id,
      revisionId: admitted.current_revision_id,
      contentHash: canonicalCandidate.content_hash,
    });
    const candidateCommand = {
      kind: "candidate" as const,
      idempotency_key: "learning-purge-candidate-001",
      candidate: learningCandidateArtifact,
    };
    await storage.writeLearningLedger({
      ...candidateCommand,
      request_hash: canonicalSha256Omitting(candidateCommand, [
        "request_hash",
      ]),
    });

    const request = deleteRequest({
      memoryId: admitted.memory_id,
      revisionId: admitted.current_revision_id,
      idempotencyKey: "memory-delete-learning-purge-001",
      approvalId: "approval_memory_delete_learning_purge_001",
    });
    approvals.approve(request);
    const deleted = await runtime.memoryDelete(request);
    expect(deleted.status).toBe("OK");
    if (deleted.status !== "OK") {
      throw new Error("learning target tombstone fixture must succeed");
    }
    const purgeJobId = (deleted.data as { purge_job_id: string }).purge_job_id;
    const purge = await storage.runPurge({ purge_job_id: purgeJobId });
    expect(purge.completed).toBe(true);
    const ledger = await storage.readLearningLedger({
      principal_id: "user_local",
      scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
      candidate_id: learningCandidateArtifact.candidate_id,
    });
    expect(ledger.invalid_candidate_ids).toEqual([
      learningCandidateArtifact.candidate_id,
    ]);

    await storage.checkpoint();
    await storage.close();
    for (const path of [
      join(dataRoot, "ledger", "memory.db"),
      join(dataRoot, "ledger", "memory.db-wal"),
      join(dataRoot, "ledger", "memory.db-shm"),
    ]) {
      if (existsSync(path)) {
        expect(readFileSync(path).includes(Buffer.from(MARKER))).toBe(false);
      }
    }
  });
});
