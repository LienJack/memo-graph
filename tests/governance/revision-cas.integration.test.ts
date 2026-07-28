import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import {
  memoryCandidate,
  memoryProposal,
  revisionCommand,
} from "../helpers/governance-examples.js";
import { inlineEpisode } from "../helpers/storage-examples.js";

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

async function seededStorage(prefix: string) {
  const dataRoot = temporaryRoot(prefix);
  const storage = await SqliteStorageClient.open({
    dataRoot,
  });
  await storage.commitEpisode(inlineEpisode({}));
  const first = await storage.admitMemory({
    request: memoryProposal({
      candidate: memoryCandidate({
        scope: { kind: "workspace", id: "workspace_local" },
      }),
    }),
    evaluation: {
      decision: "activate",
      reason: "live exact-scope user-stated evidence is eligible",
    },
  });
  return { dataRoot, storage, first };
}

describe("logical identity, conflict, and revision CAS", () => {
  it("reuses an exact duplicate and opens a divergent conflict without pointer change", async () => {
    const { storage, first } = await seededStorage("identity");
    const duplicate = await storage.admitMemory({
      request: memoryProposal({
        requestId: "request_memory_propose_duplicate",
        idempotencyKey: "memory-propose-request-duplicate",
        candidate: memoryCandidate({
          candidateId: "candidate_pref_duplicate",
          logicalKey: "  USER.PREFERENCE.EXPLANATION_STYLE  ",
          scope: { kind: "workspace", id: "workspace_local" },
        }),
      }),
      evaluation: {
        decision: "activate",
        reason: "live exact-scope user-stated evidence is eligible",
      },
    });
    const conflict = await storage.admitMemory({
      request: memoryProposal({
        requestId: "request_memory_propose_conflict",
        idempotencyKey: "memory-propose-request-conflict",
        candidate: memoryCandidate({
          candidateId: "candidate_pref_conflict",
          scope: { kind: "workspace", id: "workspace_local" },
          text: "Always return long unstructured explanations.",
        }),
      }),
      evaluation: {
        decision: "activate",
        reason: "live exact-scope user-stated evidence is eligible",
      },
    });

    expect(duplicate).toMatchObject({
      outcome: "REUSED",
      memory_id: first.memory_id,
      current_revision_id: first.current_revision_id,
    });
    expect(conflict).toMatchObject({
      outcome: "CONFLICT",
      memory_id: first.memory_id,
      current_revision_id: first.current_revision_id,
    });
    expect(conflict.conflict_group_id).not.toBeNull();
    expect((await storage.governanceStatus()).governance).toMatchObject({
      memory_candidates: 3,
      memory_objects: 1,
      memory_revisions: 1,
      conflict_groups: 1,
    });
    await storage.close();
  });

  it("allows one concurrent successor and rejects the stale writer", async () => {
    const { storage, first } = await seededStorage("revision-cas");
    const expected = first.current_revision_id;
    if (expected === null) {
      throw new Error("active fixture requires a current revision");
    }
    const left = revisionCommand({
      memoryId: first.memory_id,
      expectedRevisionId: expected,
      idempotencyKey: "memory-revision-left-001",
      candidate: memoryCandidate({
        candidateId: "candidate_revision_left",
        scope: { kind: "workspace", id: "workspace_local" },
        text: "Prefer concise, evidence-dense explanations.",
      }),
    });
    const right = revisionCommand({
      memoryId: first.memory_id,
      expectedRevisionId: expected,
      idempotencyKey: "memory-revision-right-001",
      candidate: memoryCandidate({
        candidateId: "candidate_revision_right",
        scope: { kind: "workspace", id: "workspace_local" },
        text: "Prefer explanations with explicit verification commands.",
      }),
    });

    const settled = await Promise.allSettled([
      storage.applyMemoryRevision(left),
      storage.applyMemoryRevision(right),
    ]);
    const successes = settled.filter(
      (result) => result.status === "fulfilled",
    );
    const failures = settled.filter(
      (result) => result.status === "rejected",
    );

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      reason: { code: "STALE_REVISION" },
    });
    expect((await storage.governanceStatus()).governance).toMatchObject({
      memory_objects: 1,
      memory_revisions: 2,
      admission_decisions: 2,
    });
    await storage.close();
  });

  it("replays the same revision receipt and conflicts on changed content", async () => {
    const { dataRoot, storage, first } = await seededStorage("revision-replay");
    const expected = first.current_revision_id;
    if (expected === null) {
      throw new Error("active fixture requires a current revision");
    }
    const command = revisionCommand({
      memoryId: first.memory_id,
      expectedRevisionId: expected,
      idempotencyKey: "memory-revision-replay-001",
      candidate: memoryCandidate({
        candidateId: "candidate_revision_replay",
        scope: { kind: "workspace", id: "workspace_local" },
        text: "Prefer answers with one falsifiable conclusion.",
      }),
    });

    const committed = await storage.applyMemoryRevision(command);
    const database = new DatabaseSync(
      join(dataRoot, "ledger", "memory.db"),
    );
    database.exec("PRAGMA foreign_keys = ON");
    database
      .prepare(
        `INSERT INTO approval_consumptions (
           approval_id, idempotency_key, request_hash, manifest_hash,
           principal_id, tool, scopes_json, consumed_at, receipt_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "approval_revision_replay",
        command.idempotency_key,
        committed.receipt.request_hash,
        `sha256:${"d".repeat(64)}`,
        "user_local",
        "memory_correct",
        JSON.stringify([command.scope]),
        command.requested_at,
        committed.receipt.receipt_id,
      );
    database.close();
    const replayed = await storage.applyMemoryRevision(command);
    expect(replayed).toEqual({ ...committed, replayed: true });

    await expect(
      storage.applyMemoryRevision({
        ...command,
        candidate: memoryCandidate({
          candidateId: "candidate_revision_changed",
          scope: { kind: "workspace", id: "workspace_local" },
          text: "Changed content cannot reuse the idempotency key.",
        }),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await storage.close();
  });
});
