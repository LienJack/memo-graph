import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  ContextSliceSchema,
  canonicalSha256Omitting,
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

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target !== undefined) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

describe("purge recovery", () => {
  it("resumes one tombstoned job after restart and replays its completed receipt", async () => {
    const dataRoot = temporaryRoot("purge-recovery");
    let storage = await SqliteStorageClient.open({ dataRoot });
    await storage.commitEpisode(
      inlineEpisode({ text: "Purge recovery marker 5824." }),
    );
    const approvals = new TestApprovalRegistry();
    const kernel = runtime(storage, approvals);
    const proposed = await kernel.memoryPropose(
      memoryProposal({
        candidate: memoryCandidate({
          candidateId: "candidate_purge_recovery",
          logicalKey: "user.preference.purge_recovery",
          scope: PURGE_SCOPE,
          text: "Purge recovery marker 5824.",
        }),
        idempotencyKey: "memory-propose-purge-recovery",
      }),
    );
    expect(proposed.status).toBe("OK");
    if (proposed.status !== "OK") {
      throw new Error("recovery fixture must activate");
    }
    const identity = proposed.data as {
      memory_id: string;
      current_revision_id: string;
    };
    await storage.drainFtsOutbox();
    const frozen = await kernel.memoryContextCompile({
      envelope: {
        schema_version: "1.0.0",
        request_id: "request_context_before_purge",
        tool: "memory_context_compile",
        actor_claim: {
          principal_id: "user_local",
          authority: "user_stated",
        },
        scopes: [PURGE_SCOPE],
        purpose: "Freeze a Context slice before deletion",
        reason: "Prove purge redacts historical Context safely",
        requested_at: PURGE_NOW,
        safety_class: "read_only",
      },
      recall: {
        schema_version: "1.0.0",
        request_id: "request_context_before_purge",
        goal: "Recall the purge recovery marker",
        query: "Purge recovery marker 5824",
        scopes: [PURGE_SCOPE],
        as_of: PURGE_NOW,
        token_budget: 1_800,
        include_sensitive: false,
      },
    });
    expect(frozen.status).toBe("OK");

    const deletion = deleteRequest({
      memoryId: identity.memory_id,
      revisionId: identity.current_revision_id,
      idempotencyKey: "memory-delete-purge-recovery-001",
      approvalId: "approval_delete_purge_recovery",
    });
    approvals.approve(deletion);
    const deleted = await kernel.memoryDelete(deletion);
    expect(deleted.status).toBe("OK");
    if (deleted.status !== "OK") {
      throw new Error("recovery delete must tombstone");
    }
    const purgeJobId = (deleted.data as { purge_job_id: string })
      .purge_job_id;
    await storage.close();

    storage = await SqliteStorageClient.open({ dataRoot });
    const completed = await storage.runPurge({
      purge_job_id: purgeJobId,
    });
    const replayed = await storage.runPurge({
      purge_job_id: purgeJobId,
    });
    expect(replayed).toEqual(completed);

    await storage.close();
    const database = new DatabaseSync(
      join(dataRoot, "ledger", "memory.db"),
    );
    const row = database
      .prepare(
        `SELECT frozen_hash, slice_json FROM context_slices
         WHERE request_id = ?`,
      )
      .get("request_context_before_purge") as {
      frozen_hash: string;
      slice_json: string;
    };
    const slice = ContextSliceSchema.parse(JSON.parse(row.slice_json));
    expect(slice.items[0]?.content).toEqual({
      storage: "inline",
      text: "[PURGED]",
      media_type: "application/x.memo-graph-redacted",
    });
    expect(row.frozen_hash).toBe(
      canonicalSha256Omitting(slice, ["frozen_hash"]),
    );
    expect(
      database
        .prepare("SELECT count(*) AS count FROM purge_redaction_guard")
        .get(),
    ).toEqual({ count: 0 });
    database.close();
  });
});
