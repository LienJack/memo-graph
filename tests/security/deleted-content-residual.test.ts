import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
const SECRET_MARKER = "deleted-secret-marker-440938";

function temporaryRoot(prefix: string): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-graph-${prefix}-`)),
  );
  cleanupPaths.push(root);
  return root;
}

function filesUnder(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
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

describe("deleted-content residual security", () => {
  it("scrubs exclusive plaintext and keeps append-only guards closed outside purge", async () => {
    const dataRoot = temporaryRoot("purge-residual");
    const storage = await SqliteStorageClient.open({ dataRoot });
    await storage.commitEpisode(inlineEpisode({ text: SECRET_MARKER }));
    const approvals = new TestApprovalRegistry();
    const kernel = new MemoryRuntime({
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
    const proposed = await kernel.memoryPropose(
      memoryProposal({
        candidate: memoryCandidate({
          candidateId: "candidate_deleted_residual",
          logicalKey: "user.preference.deleted_residual",
          scope: PURGE_SCOPE,
          text: SECRET_MARKER,
        }),
        idempotencyKey: "memory-propose-deleted-residual",
      }),
    );
    if (proposed.status !== "OK") {
      throw new Error("residual fixture must activate");
    }
    const identity = proposed.data as {
      memory_id: string;
      current_revision_id: string;
    };
    const deletion = deleteRequest({
      memoryId: identity.memory_id,
      revisionId: identity.current_revision_id,
      idempotencyKey: "memory-delete-residual-001",
      approvalId: "approval_delete_residual",
    });
    approvals.approve(deletion);
    const deleted = await kernel.memoryDelete(deletion);
    if (deleted.status !== "OK") {
      throw new Error("residual delete must tombstone");
    }
    const purgeJobId = (deleted.data as { purge_job_id: string })
      .purge_job_id;
    expect(await storage.runPurge({ purge_job_id: purgeJobId })).toMatchObject({
      completed: true,
      residual_hashes: [],
    });
    await storage.close();

    for (const path of filesUnder(dataRoot)) {
      expect(readFileSync(path).includes(Buffer.from(SECRET_MARKER))).toBe(
        false,
      );
    }

    const database = new DatabaseSync(
      join(dataRoot, "ledger", "memory.db"),
    );
    expect(() =>
      database
        .prepare(
          `UPDATE evidence_events SET payload_inline = ?
           WHERE evidence_id = ?`,
        )
        .run("unauthorized rewrite", "evidence_storage_1"),
    ).toThrow(/APPEND_ONLY:evidence_events/u);
    database.close();
  });
});
