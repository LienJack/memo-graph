import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  ContextSliceSchema,
  PurgeReceiptSchema,
  PurgeStoreSchema,
  canonicalJson,
  canonicalSha256,
  canonicalSha256Omitting,
  sealReceipt,
} from "../../packages/contracts/src/index.js";
import {
  ConsolidationService,
  MemoryRuntime,
} from "../../packages/memory-kernel/src/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import { StorageDatabase } from "../../packages/storage-sqlite/src/database.js";
import { prepareDataRoot } from "../../packages/storage-sqlite/src/data-root.js";

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
import {
  blobEpisode,
  inlineEpisode,
} from "../helpers/storage-examples.js";

const cleanupPaths: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-graph-${prefix}-`)),
  );
  cleanupPaths.push(root);
  return root;
}

function copyMigrationsThrough(
  migrationRoot: string,
  lastVersion: number,
): void {
  const source = join(process.cwd(), "migrations");
  const migrations = readdirSync(source).filter((entry) => {
    const version = Number(entry.slice(0, 4));
    return Number.isInteger(version) && version <= lastVersion;
  });
  for (const migration of migrations) {
    cpSync(join(source, migration), join(migrationRoot, migration));
  }
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
  it("requires physical cleanup before replaying a completed 0017 purge receipt", async () => {
    const dataRoot = temporaryRoot("purge-0017-upgrade");
    const migrationRoot = temporaryRoot("purge-0017-migrations");
    copyMigrationsThrough(migrationRoot, 17);

    let storage = await SqliteStorageClient.open({
      dataRoot,
      migrationsDir: migrationRoot,
    });
    await storage.commitEpisode(
      inlineEpisode({
        episodeId: "episode_purge_0017_upgrade",
        evidenceId: "evidence_purge_0017_upgrade",
        idempotencyKey: "commit:purge:0017:upgrade",
        text: "Legacy purge receipt physical-cleanup marker 3041.",
      }),
    );
    const approvals = new TestApprovalRegistry();
    const kernel = runtime(storage, approvals);
    const proposed = await kernel.memoryPropose(
      memoryProposal({
        candidate: memoryCandidate({
          candidateId: "candidate_purge_0017_upgrade",
          logicalKey: "user.preference.purge_0017_upgrade",
          scope: PURGE_SCOPE,
          text: "Legacy purge receipt physical-cleanup marker 3041.",
          evidenceIds: ["evidence_purge_0017_upgrade"],
        }),
        idempotencyKey: "memory-propose-purge-0017-upgrade",
      }),
    );
    if (proposed.status !== "OK") {
      throw new Error("0017 upgrade fixture must activate");
    }
    const identity = proposed.data as {
      memory_id: string;
      current_revision_id: string;
    };
    const deletion = deleteRequest({
      memoryId: identity.memory_id,
      revisionId: identity.current_revision_id,
      idempotencyKey: "memory-delete-purge-0017-upgrade",
      approvalId: "approval_delete_purge_0017_upgrade",
    });
    approvals.approve(deletion);
    const deleted = await kernel.memoryDelete(deletion);
    if (deleted.status !== "OK") {
      throw new Error("0017 upgrade fixture must tombstone");
    }
    const purgeJobId = (deleted.data as { purge_job_id: string })
      .purge_job_id;
    await storage.close();

    const databasePath = join(dataRoot, "ledger", "memory.db");
    const legacy = new DatabaseSync(databasePath);
    const job = legacy
      .prepare(
        `SELECT job.memory_id, job.tombstone_epoch, tombstone.principal_id,
                tombstone.scope_kind, tombstone.scope_id
         FROM purge_jobs AS job
         JOIN memory_tombstones AS tombstone
           ON tombstone.purge_job_id = job.purge_job_id
         WHERE job.purge_job_id = ?`,
      )
      .get(purgeJobId) as {
      memory_id: string;
      tombstone_epoch: number;
      principal_id: string;
      scope_kind: string;
      scope_id: string;
    };
    const checkedAt = "2026-07-30T23:30:00.000Z";
    const outcomes = PurgeStoreSchema.options.map((store) => ({
      store,
      status: "verified" as const,
      residual_hashes: [],
      error_code: null,
      checked_at: checkedAt,
    }));
    const requestHash = canonicalSha256({
      purge_job_id: purgeJobId,
      tombstone_epoch: job.tombstone_epoch,
      attempt: 1,
    });
    const legacyReceipt = PurgeReceiptSchema.parse(
      sealReceipt({
        schema_version: "1.0.0",
        receipt_id: `purge-receipt:${canonicalSha256({
          purge_job_id: purgeJobId,
          attempt: 1,
          outcomes,
        }).slice("sha256:".length, 55)}`,
        created_at: checkedAt,
        state: "purged",
        request_hash: requestHash,
        receipt_hash: `sha256:${"0".repeat(64)}`,
        kind: "purge",
        purge_job_id: purgeJobId,
        target_memory_ids: [job.memory_id],
        tombstone_epoch: job.tombstone_epoch,
        stores_checked: [...PurgeStoreSchema.options],
        store_outcomes: outcomes,
        residual_hashes: [],
        completed: true,
      }),
    );
    legacy.exec("BEGIN IMMEDIATE");
    try {
      const insertOutcome = legacy.prepare(
        `INSERT INTO purge_store_outcomes (
           purge_job_id, store, attempt, status, residual_hashes_json,
           error_code, checked_at
         ) VALUES (?, ?, 1, 'verified', '[]', NULL, ?)`,
      );
      for (const outcome of outcomes) {
        insertOutcome.run(purgeJobId, outcome.store, checkedAt);
      }
      legacy
        .prepare(
          `INSERT INTO purge_receipts (
             receipt_id, purge_job_id, request_hash, receipt_hash, state,
             receipt_json, created_at
           ) VALUES (?, ?, ?, ?, 'purged', ?, ?)`,
        )
        .run(
          legacyReceipt.receipt_id,
          purgeJobId,
          legacyReceipt.request_hash,
          legacyReceipt.receipt_hash,
          canonicalJson(legacyReceipt),
          checkedAt,
        );
      legacy
        .prepare(
          `INSERT INTO receipt_access_scopes (
             receipt_id, receipt_kind, principal_id, scope_kind, scope_id,
             created_at
           ) VALUES (?, 'purge', ?, ?, ?, ?)`,
        )
        .run(
          legacyReceipt.receipt_id,
          job.principal_id,
          job.scope_kind,
          job.scope_id,
          checkedAt,
        );
      legacy
        .prepare(
          `INSERT INTO operator_purge_attempts (
             operation_id, purge_job_id, expected_prior_receipt_id,
             receipt_id, created_at
           ) VALUES (?, ?, NULL, ?, ?)`,
        )
        .run(
          "operator_legacy_original_purge_1",
          purgeJobId,
          legacyReceipt.receipt_id,
          checkedAt,
        );
      legacy
        .prepare(
          `UPDATE purge_jobs
           SET status = 'completed', attempts = 1, updated_at = ?,
               last_error_code = NULL
           WHERE purge_job_id = ?`,
        )
        .run(checkedAt, purgeJobId);
      legacy.exec(`
        CREATE TABLE legacy_physical_cleanup_probe (payload BLOB) STRICT;
        INSERT INTO legacy_physical_cleanup_probe(payload)
          VALUES (randomblob(4194304));
        DELETE FROM legacy_physical_cleanup_probe;
      `);
      legacy.exec("COMMIT");
    } catch (error) {
      legacy.exec("ROLLBACK");
      throw error;
    }
    const legacyFreelist = Number(
      (legacy.prepare("PRAGMA freelist_count").get() as {
        freelist_count: number;
      }).freelist_count,
    );
    expect(legacyFreelist).toBeGreaterThan(0);
    legacy.close();

    cpSync(
      join(process.cwd(), "migrations", "0018-purge-physical-saga.sql"),
      join(migrationRoot, "0018-purge-physical-saga.sql"),
    );
    storage = await SqliteStorageClient.open({
      dataRoot,
      migrationsDir: migrationRoot,
      testFaults: { purgeExitAt: "before_physical_maintenance" },
    });
    const migrated = new DatabaseSync(databasePath);
    expect(
      migrated
        .prepare(
          `SELECT state, receipt_id
           FROM purge_legacy_physical_maintenance
           WHERE purge_job_id = ?`,
        )
        .get(purgeJobId),
    ).toEqual({
      state: "pending",
      receipt_id: legacyReceipt.receipt_id,
    });
    migrated.close();
    await expect(storage.createBackup()).rejects.toMatchObject({
      code: "INCOMPLETE_PURGE",
    });
    await storage.close();
    const restoreVerifier = new StorageDatabase({
      layout: prepareDataRoot(dataRoot),
      migrationsDir: migrationRoot,
      busyTimeoutMs: 5_000,
    });
    expect(() => restoreVerifier.verifyRestoreCandidate()).toThrowError(
      expect.objectContaining({ code: "INCOMPLETE_PURGE" }),
    );
    restoreVerifier.close();
    storage = await SqliteStorageClient.open({
      dataRoot,
      migrationsDir: migrationRoot,
      testFaults: { purgeExitAt: "before_physical_maintenance" },
    });
    const operatorAction = {
      operation_id: "operator_legacy_purge_cleanup_1",
      expected_prior_receipt_id: legacyReceipt.receipt_id,
    };
    await expect(
      storage.runPurge({
        purge_job_id: purgeJobId,
        operator_action: operatorAction,
      }),
    ).rejects.toMatchObject({ code: "WORKER_CRASHED" });

    const interrupted = new DatabaseSync(databasePath);
    expect(
      interrupted
        .prepare(
          `SELECT state, receipt_id
           FROM purge_legacy_physical_maintenance
           WHERE purge_job_id = ?`,
        )
        .get(purgeJobId),
    ).toEqual({
      state: "pending",
      receipt_id: legacyReceipt.receipt_id,
    });
    expect(
      Number(
        (interrupted.prepare("PRAGMA freelist_count").get() as {
          freelist_count: number;
        }).freelist_count,
      ),
    ).toBeGreaterThan(0);
    interrupted.close();

    expect(
      await storage.runPurge({
        purge_job_id: purgeJobId,
        operator_action: operatorAction,
      }),
    ).toEqual(legacyReceipt);
    expect(
      await storage.runPurge({
        purge_job_id: purgeJobId,
        operator_action: operatorAction,
      }),
    ).toEqual(legacyReceipt);
    await storage.close();

    const completed = new DatabaseSync(databasePath);
    expect(
      completed
        .prepare(
          `SELECT state FROM purge_legacy_physical_maintenance
           WHERE purge_job_id = ?`,
        )
        .get(purgeJobId),
    ).toEqual({ state: "completed" });
    expect(
      Number(
        (completed.prepare("PRAGMA freelist_count").get() as {
          freelist_count: number;
        }).freelist_count,
      ),
    ).toBe(0);
    expect(
      completed
        .prepare(
          `SELECT purge_job_id, expected_prior_receipt_id, receipt_id
           FROM operator_legacy_purge_cleanup_attempts
           WHERE operation_id = ?`,
        )
        .get(operatorAction.operation_id),
    ).toEqual({
      purge_job_id: purgeJobId,
      expected_prior_receipt_id: legacyReceipt.receipt_id,
      receipt_id: legacyReceipt.receipt_id,
    });
    expect(
      completed
        .prepare(
          `SELECT purge_job_id, expected_prior_receipt_id, receipt_id
           FROM operator_purge_attempts WHERE operation_id = ?`,
        )
        .get("operator_legacy_original_purge_1"),
    ).toEqual({
      purge_job_id: purgeJobId,
      expected_prior_receipt_id: null,
      receipt_id: legacyReceipt.receipt_id,
    });
    completed.close();
  });

  it("recovers a durable blob intent without publishing an early receipt", async () => {
    const dataRoot = temporaryRoot("purge-blob-intent");
    const episode = blobEpisode({
      bytes: Buffer.from("durable purge blob intent 9217", "utf8"),
      episodeId: "episode_purge_blob_intent",
      evidenceId: "evidence_purge_blob_intent",
    });
    const blob = episode.blobs[0];
    if (blob === undefined) {
      throw new Error("blob intent fixture requires one blob");
    }
    let storage = await SqliteStorageClient.open({ dataRoot });
    await storage.commitEpisode(episode);
    const approvals = new TestApprovalRegistry();
    const kernel = runtime(storage, approvals);
    const proposed = await kernel.memoryPropose(
      memoryProposal({
        candidate: memoryCandidate({
          candidateId: "candidate_purge_blob_intent",
          logicalKey: "user.preference.purge_blob_intent",
          scope: PURGE_SCOPE,
          text: "durable purge blob intent",
          evidenceIds: ["evidence_purge_blob_intent"],
        }),
        idempotencyKey: "memory-propose-purge-blob-intent",
      }),
    );
    if (proposed.status !== "OK") {
      throw new Error("blob intent fixture must activate");
    }
    const identity = proposed.data as {
      memory_id: string;
      current_revision_id: string;
    };
    const deletion = deleteRequest({
      memoryId: identity.memory_id,
      revisionId: identity.current_revision_id,
      idempotencyKey: "memory-delete-purge-blob-intent",
      approvalId: "approval_delete_purge_blob_intent",
    });
    approvals.approve(deletion);
    const deleted = await kernel.memoryDelete(deletion);
    if (deleted.status !== "OK") {
      throw new Error("blob intent fixture must tombstone");
    }
    const purgeJobId = (deleted.data as { purge_job_id: string })
      .purge_job_id;
    await storage.close();

    storage = await SqliteStorageClient.open({
      dataRoot,
      testFaults: { purgeExitAt: "after_blob_unlink" },
    });
    await expect(
      storage.runPurge({ purge_job_id: purgeJobId }),
    ).rejects.toMatchObject({ code: "WORKER_CRASHED" });

    const databasePath = join(dataRoot, "ledger", "memory.db");
    const database = new DatabaseSync(databasePath);
    expect(
      database
        .prepare(
          `SELECT state FROM purge_blob_deletion_intents
           WHERE purge_job_id = ?`,
        )
        .get(purgeJobId),
    ).toEqual({ state: "pending" });
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM purge_receipts WHERE purge_job_id = ?",
        )
        .get(purgeJobId),
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM artifacts WHERE content_hash = ?",
        )
        .get(blob.content_hash),
    ).toEqual({ count: 0 });
    database.close();
    expect(
      existsSync(
        join(
          dataRoot,
          "blobs",
          blob.content_hash.slice("sha256:".length),
        ),
      ),
    ).toBe(false);

    expect(
      await storage.runPurge({ purge_job_id: purgeJobId }),
    ).toMatchObject({
      completed: true,
      state: "purged",
      residual_hashes: [],
    });
    await storage.close();
    const completedDatabase = new DatabaseSync(databasePath);
    expect(
      completedDatabase
        .prepare(
          `SELECT state FROM purge_blob_deletion_intents
           WHERE purge_job_id = ?`,
        )
        .get(purgeJobId),
    ).toEqual({ state: "completed" });
    completedDatabase.close();
  });

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
    const priorPurgeReceipt = await storage.inspectPurgeReceipt({
      purge_job_id: purgeJobId,
    });
    const operatorAction = {
      operation_id: "operator_action:purge_recovery:0001",
      expected_prior_receipt_id: priorPurgeReceipt?.receipt_id ?? null,
    } as const;
    const completed = await storage.runPurge({
      purge_job_id: purgeJobId,
      operator_action: operatorAction,
    });
    await storage.close();
    storage = await SqliteStorageClient.open({ dataRoot });
    const replayed = await storage.runPurge({
      purge_job_id: purgeJobId,
      operator_action: operatorAction,
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
