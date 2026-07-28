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
import {
  ConsolidationService,
  MemoryRuntime,
} from "../../packages/memory-kernel/src/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";

import { TestApprovalRegistry } from "../helpers/approval.js";
import {
  memoryCandidate,
  memoryProposal,
} from "../helpers/governance-examples.js";
import {
  seedLayeredProjectionSources,
} from "../helpers/projection-examples.js";
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
  layered = false,
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
      ...(layered
        ? {
            lane_policy: {
              allowed_lanes: [
                "recent_l1",
                "topic",
                "scenario_procedure",
                "core",
                "relation_sqlite",
              ] as const,
              limits: {
                max_candidates_per_lane: 20,
                relation_max_depth: 2,
                relation_max_fanout: 5,
                max_concurrent_lanes: 2,
              },
            },
          }
        : {}),
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
    const contextRequest = {
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
    } as const;
    const frozen = await kernel.memoryContextCompile(contextRequest);
    expect(frozen.status, JSON.stringify(frozen)).toBe("OK");

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
    expect(await kernel.memoryContextCompile(contextRequest)).toMatchObject({
      status: "FAILED",
      error: { code: "INCOMPLETE_PURGE" },
    });
    await storage.close();

    storage = await SqliteStorageClient.open({ dataRoot });
    const completed = await storage.runPurge({
      purge_job_id: purgeJobId,
    });
    const replayed = await storage.runPurge({
      purge_job_id: purgeJobId,
    });
    expect(replayed).toEqual(completed);
    expect(
      await runtime(storage, approvals).memoryContextCompile(contextRequest),
    ).toMatchObject({
      status: "OK",
      data: {
        replayed: true,
        context_slice: {
          items: [
            {
              content: {
                storage: "inline",
                text: "[PURGED]",
                media_type: "application/x.memo-graph-redacted",
              },
            },
          ],
        },
      },
    });

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

  it("redacts every frozen projection descendant and never recalls it again", async () => {
    const dataRoot = temporaryRoot("layered-context-purge");
    const storage = await SqliteStorageClient.open({ dataRoot });
    const admitted = await seedLayeredProjectionSources(storage);
    await new ConsolidationService({ storage }).drain({
      worker_id: "layered_context_purge_worker",
      claimed_at: "2026-07-28T12:10:00.000Z",
      lease_expires_at: "2026-07-28T12:11:00.000Z",
    });
    const approvals = new TestApprovalRegistry();
    const kernel = runtime(storage, approvals, true);
    const contextRequest = {
      envelope: {
        schema_version: "1.0.0",
        request_id: "request_layered_context_before_purge",
        tool: "memory_context_compile",
        actor_claim: {
          principal_id: "user_local",
          authority: "user_stated",
        },
        scopes: [PURGE_SCOPE],
        purpose: "freeze layered Context before purge",
        reason: "prove projection descendants are redacted",
        requested_at: PURGE_NOW,
        safety_class: "read_only",
      },
      recall: {
        schema_version: "1.0.0",
        request_id: "request_layered_context_before_purge",
        goal: "restore governed agent memory",
        query: "agent memory",
        scopes: [PURGE_SCOPE],
        as_of: PURGE_NOW,
        token_budget: 1_800,
        include_sensitive: false,
      },
    } as const;
    const frozen = await kernel.memoryContextCompile(contextRequest);
    expect(frozen.status).toBe("OK");
    if (frozen.status !== "OK") {
      throw new Error("layered purge fixture must freeze Context");
    }
    const frozenItems = (
      frozen.data as {
        context_slice: {
          items: Array<{
            projection?: { source_revision_ids: string[] };
          }>;
        };
      }
    ).context_slice.items;
    expect(
      frozenItems.some((item) => item.projection !== undefined),
    ).toBe(true);
    const source = admitted[0];
    if (source === undefined) {
      throw new Error("layered purge fixture requires one source");
    }
    const deletion = deleteRequest({
      memoryId: source.memory_id,
      revisionId: source.current_revision_id,
      idempotencyKey: "memory-delete-layered-context-001",
      approvalId: "approval_delete_layered_context",
    });
    approvals.approve(deletion);
    const deleted = await kernel.memoryDelete(deletion);
    if (deleted.status !== "OK") {
      throw new Error("layered Context delete must tombstone");
    }
    expect(await kernel.memoryContextCompile(contextRequest)).toMatchObject({
      status: "FAILED",
      error: { code: "INCOMPLETE_PURGE" },
    });
    const purgeJobId = (deleted.data as { purge_job_id: string })
      .purge_job_id;
    expect(
      await storage.runPurge({ purge_job_id: purgeJobId }),
    ).toMatchObject({
      completed: true,
      residual_hashes: [],
    });
    const replay = await kernel.memoryContextCompile(contextRequest);
    expect(replay.status).toBe("OK");
    if (replay.status !== "OK") {
      throw new Error("redacted frozen Context must remain replayable");
    }
    const replayItems = (
      replay.data as {
        context_slice: {
          items: Array<{
            projection?: { source_revision_ids: string[] };
            content: { storage: string; text?: string };
          }>;
        };
      }
    ).context_slice.items;
    const redactedDescendants = replayItems.filter(
      (item) =>
        item.projection?.source_revision_ids.includes(
          source.current_revision_id,
        ) ?? false,
    );
    expect(redactedDescendants.length).toBeGreaterThan(0);
    expect(
      redactedDescendants.every(
        (item) =>
          item.content.storage === "inline" &&
          item.content.text === "[PURGED]",
      ),
    ).toBe(true);

    const nextRequest = {
      ...contextRequest,
      envelope: {
        ...contextRequest.envelope,
        request_id: "request_layered_context_after_purge",
      },
      recall: {
        ...contextRequest.recall,
        request_id: "request_layered_context_after_purge",
      },
    };
    const next = await kernel.memoryContextCompile(nextRequest);
    expect(["OK", "DEGRADED"]).toContain(next.status);
    if (next.status !== "OK" && next.status !== "DEGRADED") {
      throw new Error("remaining canonical L1 should compile");
    }
    const nextItems = (
      next.data as {
        context_slice: {
          items: Array<{
            revision_id: string;
            projection?: { source_revision_ids: string[] };
          }>;
        };
      }
    ).context_slice.items;
    expect(
      nextItems.some(
        (item) =>
          item.revision_id === source.current_revision_id ||
          item.projection?.source_revision_ids.includes(
            source.current_revision_id,
          ),
      ),
    ).toBe(false);
    await storage.close();
  });
});
