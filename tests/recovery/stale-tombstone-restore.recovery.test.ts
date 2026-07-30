import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ConsolidationService,
  MemoryRuntime,
} from "../../packages/memory-kernel/src/index.js";
import {
  SqliteStorageClient,
  restoreBackupToEmptyDataRoot,
} from "@memo-graph/storage-sqlite";

import { TestApprovalRegistry } from "../helpers/approval.js";
import {
  memoryCandidate,
  memoryProposal,
  revisionCommand,
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
import { testRecoveryHeadProvider } from "../helpers/recovery.js";

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

describe("restore tombstone frontier", () => {
  it("rejects a pre-delete snapshot and publishes only a verified current snapshot", async () => {
    const dataRoot = temporaryRoot("frontier-source");
    const restoreParent = temporaryRoot("frontier-target");
    const staleTarget = join(restoreParent, "stale");
    const unverifiedTarget = join(restoreParent, "unverified");
    const corruptTarget = join(restoreParent, "corrupt");
    const currentTarget = join(restoreParent, "current");
    const recoveryHeadProvider = testRecoveryHeadProvider();
    const storage = await SqliteStorageClient.open({
      dataRoot,
      recoveryHeadProvider,
    });
    await storage.commitEpisode(
      inlineEpisode({ text: "Tombstone frontier marker 7315." }),
    );
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
          candidateId: "candidate_frontier_restore",
          logicalKey: "user.preference.frontier_restore",
          scope: PURGE_SCOPE,
          text: "Tombstone frontier marker 7315.",
        }),
        idempotencyKey: "memory-propose-frontier-restore",
      }),
    );
    if (proposed.status !== "OK") {
      throw new Error("frontier fixture must activate");
    }
    const identity = proposed.data as {
      memory_id: string;
      current_revision_id: string;
    };
    const staleBackup = await storage.createBackup();
    const deletion = deleteRequest({
      memoryId: identity.memory_id,
      revisionId: identity.current_revision_id,
      idempotencyKey: "memory-delete-frontier-restore-001",
      approvalId: "approval_delete_frontier_restore",
    });
    approvals.approve(deletion);
    const deleted = await kernel.memoryDelete(deletion);
    if (deleted.status !== "OK") {
      throw new Error("frontier delete must tombstone");
    }
    const purgeJobId = (deleted.data as { purge_job_id: string })
      .purge_job_id;
    const unverifiedBackup = await storage.createBackup();
    expect(await storage.runPurge({ purge_job_id: purgeJobId })).toMatchObject({
      completed: false,
      state: "partial",
      store_outcomes: expect.arrayContaining([
        expect.objectContaining({
          store: "backups",
          status: "residual",
        }),
      ]),
    });
    const currentBackup = await storage.createBackup();
    await storage.close();

    await expect(
      restoreBackupToEmptyDataRoot({
        backup: staleBackup,
        dataRoot: staleTarget,
        recoveryHeadProvider,
      }),
    ).rejects.toMatchObject({ code: "STALE_RECOVERY_HEAD" });
    expect(existsSync(staleTarget)).toBe(false);

    await expect(
      restoreBackupToEmptyDataRoot({
        backup: unverifiedBackup,
        dataRoot: unverifiedTarget,
        recoveryHeadProvider,
      }),
    ).rejects.toMatchObject({ code: "STALE_RECOVERY_HEAD" });
    expect(existsSync(unverifiedTarget)).toBe(false);

    await expect(
      restoreBackupToEmptyDataRoot({
        backup: {
          ...currentBackup,
          ledger_epoch: currentBackup.ledger_epoch + 1,
        },
        dataRoot: corruptTarget,
        recoveryHeadProvider,
      }),
    ).rejects.toMatchObject({ code: "CORRUPTION" });
    expect(existsSync(corruptTarget)).toBe(false);

    const restored = await restoreBackupToEmptyDataRoot({
      backup: currentBackup,
      dataRoot: currentTarget,
      recoveryHeadProvider,
    });
    expect(restored).toMatchObject({
      minimum_tombstone_epoch: 1,
      health: { tombstone_epoch: 1 },
      verification: {
        integrity_check: "ok",
        foreign_key_violations: 0,
        incomplete_purge_jobs: 1,
      },
    });
    expect(existsSync(currentTarget)).toBe(true);
  });

  it("preserves ready projections and marks a stale frontier for deterministic rebuild", async () => {
    const restoreParent = temporaryRoot("projection-restore-target");
    const readyTarget = join(restoreParent, "ready");
    const pendingTarget = join(restoreParent, "pending");
    const readyRecoveryHeadProvider = testRecoveryHeadProvider(
      "recovery_authority:projection-ready",
    );
    const readyStorage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("projection-ready-source"),
      recoveryHeadProvider: readyRecoveryHeadProvider,
    });
    await seedLayeredProjectionSources(readyStorage);
    const readyConsolidation = new ConsolidationService({
      storage: readyStorage,
    });
    await readyConsolidation.drain({
      worker_id: "projection_restore_ready_worker",
      claimed_at: "2026-07-28T12:10:00.000Z",
      lease_expires_at: "2026-07-28T12:11:00.000Z",
    });
    const readyBackup = await readyStorage.createBackup();
    await readyStorage.close();
    const ready = await restoreBackupToEmptyDataRoot({
      backup: readyBackup,
      dataRoot: readyTarget,
      recoveryHeadProvider: readyRecoveryHeadProvider,
    });
    expect(ready.verification).toMatchObject({
      active_projections_verified: expect.any(Number),
      active_relations_verified: expect.any(Number),
      projection_rebuild_required: false,
    });
    expect(
      ready.verification.active_projections_verified,
    ).toBeGreaterThan(0);
    expect(
      ready.verification.active_relations_verified,
    ).toBeGreaterThan(0);

    const pendingRecoveryHeadProvider = testRecoveryHeadProvider(
      "recovery_authority:projection-pending",
    );
    const pendingSourceStorage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("projection-pending-source"),
      recoveryHeadProvider: pendingRecoveryHeadProvider,
    });
    const admitted = await seedLayeredProjectionSources(
      pendingSourceStorage,
    );
    const pendingConsolidation = new ConsolidationService({
      storage: pendingSourceStorage,
    });
    await pendingConsolidation.drain({
      worker_id: "projection_restore_pending_worker",
      claimed_at: "2026-07-28T12:12:00.000Z",
      lease_expires_at: "2026-07-28T12:13:00.000Z",
    });
    await pendingSourceStorage.commitEpisode(
      inlineEpisode({
        episodeId: "episode_projection_restore_correction",
        evidenceId: "evidence_projection_restore_correction",
        idempotencyKey: "commit:projection-restore-correction:0001",
        text: "Agent memory restore correction is current.",
      }),
    );
    const source = admitted[0];
    if (source === undefined) {
      throw new Error("restore fixture requires one projection source");
    }
    await pendingSourceStorage.applyMemoryRevision(
      revisionCommand({
        memoryId: source.memory_id,
        expectedRevisionId: source.current_revision_id,
        candidate: memoryCandidate({
          candidateId: "candidate_projection_restore_correction",
          logicalKey: "projection.layered_semantic_a",
          scope: PURGE_SCOPE,
          text: "Agent memory restore correction is current.",
          evidenceIds: ["evidence_projection_restore_correction"],
        }),
        idempotencyKey: "projection-restore-correction-0001",
      }),
    );
    const pendingBackup = await pendingSourceStorage.createBackup();
    await pendingSourceStorage.close();

    const pending = await restoreBackupToEmptyDataRoot({
      backup: pendingBackup,
      dataRoot: pendingTarget,
      recoveryHeadProvider: pendingRecoveryHeadProvider,
    });
    expect(pending.verification).toMatchObject({
      active_projections_verified: expect.any(Number),
      active_relations_verified: expect.any(Number),
      projection_rebuild_required: true,
    });
    const pendingStorage = await SqliteStorageClient.open({
      dataRoot: pendingTarget,
      recoveryHeadProvider: pendingRecoveryHeadProvider,
    });
    const pendingRuntime = new MemoryRuntime({
      storage: pendingStorage,
      policy: {
        principal: {
          principal_id: "user_local",
          allowed_scopes: [PURGE_SCOPE],
          allowed_authorities: ["user_stated"],
          destructive_tools_enabled: false,
        },
        lane_policy: {
          allowed_lanes: [
            "recent_l1",
            "topic",
            "scenario_procedure",
            "core",
            "relation_sqlite",
          ],
          limits: {
            max_candidates_per_lane: 20,
            relation_max_depth: 2,
            relation_max_fanout: 5,
            max_concurrent_lanes: 2,
          },
        },
      },
    });
    const recalled = await pendingRuntime.memoryContextCompile({
      envelope: {
        schema_version: "1.0.0",
        request_id: "request_projection_restore_pending",
        tool: "memory_context_compile",
        actor_claim: {
          principal_id: "user_local",
          authority: "user_stated",
        },
        scopes: [PURGE_SCOPE],
        purpose: "verify pending restore fallback",
        reason: "projection reads require canonical revalidation",
        requested_at: PURGE_NOW,
        safety_class: "read_only",
      },
      recall: {
        schema_version: "1.0.0",
        request_id: "request_projection_restore_pending",
        goal: "recall the current corrected source",
        query: "Agent memory restore correction",
        scopes: [PURGE_SCOPE],
        as_of: PURGE_NOW,
        token_budget: 1_800,
        include_sensitive: false,
      },
    });
    expect(recalled.status).toBe("DEGRADED");
    if (recalled.status !== "DEGRADED") {
      throw new Error("pending restore must preserve canonical L1");
    }
    expect(recalled.fallback_lane).toBe("recent_l1");
    expect(
      (
        recalled.data as {
          context_slice: {
            items: Array<{ abstraction: string }>;
          };
        }
      ).context_slice.items.every(
        (item) => item.abstraction === "l1_memory",
      ),
    ).toBe(true);
    await pendingStorage.close();
  });
});
