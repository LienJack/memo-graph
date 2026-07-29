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
  GraphBackendIdentitySchema,
  GraphDeliveryReceiptSchema,
  ScopeSchema,
  canonicalSha256,
} from "../../packages/contracts/src/index.js";
import {
  ConsolidationService,
} from "../../packages/memory-kernel/src/index.js";
import {
  SqliteStorageClient,
  restoreBackupToEmptyDataRoot,
} from "@memo-graph/storage-sqlite";
import {
  seedLayeredProjectionSources,
  projectionFrontier,
} from "../helpers/projection-examples.js";

const cleanupPaths: string[] = [];
const MAIN_SCOPE = ScopeSchema.parse({
  kind: "workspace",
  id: "workspace_local",
});
const OTHER_SCOPE = ScopeSchema.parse({
  kind: "workspace",
  id: "workspace_other",
});
const BACKEND_IDENTITY = GraphBackendIdentitySchema.parse({
  schema_version: "1.0.0",
  backend: "ladybugdb",
  package_name: "@ladybugdb/core",
  package_version: "0.18.3",
  storage_version: "42",
  platform: "darwin",
  architecture: "arm64",
  native_binary_hash: `sha256:${"a".repeat(64)}`,
  dependency_lock_hash: `sha256:${"b".repeat(64)}`,
});

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

async function projectedStorage(prefix: string) {
  const dataRoot = temporaryRoot(prefix);
  const storage = await SqliteStorageClient.open({ dataRoot });
  await seedLayeredProjectionSources(storage, { prefix });
  const consolidation = new ConsolidationService({ storage });
  await consolidation.drain({
    worker_id: `${prefix}_projection_worker`,
    claimed_at: "2026-07-29T01:00:00.000Z",
    lease_expires_at: "2026-07-29T01:01:00.000Z",
  });
  return { dataRoot, storage };
}

async function claimOne(
  storage: SqliteStorageClient,
  options: {
    worker_id: string;
    claimed_at: string;
    lease_expires_at: string;
  },
) {
  const claimed = await storage.claimGraphProjectionJobs({
    ...options,
    limit: 1,
  });
  const job = claimed.jobs[0];
  if (
    job === undefined ||
    job.target_frontier === null ||
    job.expected_logical_digest === null ||
    job.lease_token === null
  ) {
    throw new Error("graph projection fixture requires one ready leased job");
  }
  return {
    ...job,
    target_frontier: job.target_frontier,
    expected_logical_digest: job.expected_logical_digest,
    lease_token: job.lease_token,
  };
}

function appliedReceipt(
  job: Awaited<ReturnType<typeof claimOne>>,
  counts: { nodes: number; edges: number },
  completedAt = "2026-07-29T01:04:00.000Z",
) {
  return GraphDeliveryReceiptSchema.parse({
    schema_version: "1.0.0",
    receipt_id: `graph-receipt:${canonicalSha256({
      job_id: job.job_id,
      attempt: job.attempts,
    }).slice("sha256:".length, 48)}`,
    job_id: job.job_id,
    operation: job.operation,
    backend: job.backend,
    principal_id: job.principal_id,
    scope: job.scope,
    status: "applied",
    previous_frontier: null,
    resulting_frontier: job.target_frontier,
    logical_digest: job.expected_logical_digest,
    backend_identity: BACKEND_IDENTITY,
    node_count: counts.nodes,
    edge_count: counts.edges,
    duration_ms: 12,
    completed_at: completedAt,
    failure_code: null,
  });
}

async function applyNextGraphJob(
  storage: SqliteStorageClient,
  options: {
    worker_id: string;
    claimed_at: string;
    lease_expires_at: string;
    completed_at: string;
  },
) {
  const job = await claimOne(storage, {
    worker_id: options.worker_id,
    claimed_at: options.claimed_at,
    lease_expires_at: options.lease_expires_at,
  });
  const snapshot = await storage.graphScopeSnapshot({
    principal_id: job.principal_id,
    scope: job.scope,
  });
  const receipt = appliedReceipt(job, {
    nodes: snapshot.snapshot.nodes.length,
    edges: snapshot.snapshot.edges.length,
  }, options.completed_at);
  const applied = await storage.applyGraphProjectionJob({
    job_id: job.job_id,
    worker_id: options.worker_id,
    lease_token: job.lease_token,
    receipt,
  });
  return { applied, job, snapshot };
}

describe("SQLite graph projection delivery", () => {
  it("leases exact-scope work, reclaims expiry, and publishes verified ready", async () => {
    const { storage } = await projectedStorage("graph-delivery");
    try {
      const pending = await storage.graphProjectionCheckpoint({
        principal_id: "user_local",
        scope: MAIN_SCOPE,
      });
      expect(pending).toMatchObject({
        status: "pending",
        backend: "ladybugdb",
        principal_id: "user_local",
        scope: MAIN_SCOPE,
        backend_identity: null,
      });
      expect(pending.frontier).not.toBeNull();
      expect(pending.logical_digest).toMatch(/^sha256:[a-f0-9]{64}$/u);

      const snapshot = await storage.graphScopeSnapshot({
        principal_id: "user_local",
        scope: MAIN_SCOPE,
      });
      expect(snapshot.snapshot.logical_digest).toBe(
        pending.logical_digest,
      );
      expect(snapshot.snapshot.nodes.length).toBeGreaterThan(0);
      expect(JSON.stringify(snapshot)).not.toContain(
        "Agent memory must remain governed.",
      );

      const first = await claimOne(storage, {
        worker_id: "graph_worker_a",
        claimed_at: "2026-07-29T01:02:00.000Z",
        lease_expires_at: "2026-07-29T01:03:00.000Z",
      });
      expect(
        await storage.claimGraphProjectionJobs({
          worker_id: "graph_worker_b",
          claimed_at: "2026-07-29T01:02:30.000Z",
          lease_expires_at: "2026-07-29T01:03:30.000Z",
          limit: 1,
        }),
      ).toEqual({ jobs: [] });

      const reclaimed = await claimOne(storage, {
        worker_id: "graph_worker_b",
        claimed_at: "2026-07-29T01:03:30.000Z",
        lease_expires_at: "2026-07-29T01:05:00.000Z",
      });
      expect(reclaimed.job_id).toBe(first.job_id);
      expect(reclaimed.attempts).toBe(first.attempts + 1);
      expect(reclaimed.lease_token).not.toBe(first.lease_token);

      const receipt = appliedReceipt(reclaimed, {
        nodes: snapshot.snapshot.nodes.length,
        edges: snapshot.snapshot.edges.length,
      });
      await expect(
        storage.applyGraphProjectionJob({
          job_id: reclaimed.job_id,
          worker_id: "graph_worker_b",
          lease_token: reclaimed.lease_token,
          receipt: {
            ...receipt,
            receipt_id: "graph_receipt_wrong_operation",
            operation: "full_rebuild",
          },
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      const applied = await storage.applyGraphProjectionJob({
        job_id: reclaimed.job_id,
        worker_id: "graph_worker_b",
        lease_token: reclaimed.lease_token,
        receipt,
      });
      expect(applied).toMatchObject({
        replayed: false,
        job: { status: "applied" },
        checkpoint: {
          status: "ready",
          logical_digest: snapshot.snapshot.logical_digest,
          backend_identity: BACKEND_IDENTITY,
        },
        receipt,
      });
      await expect(
        storage.applyGraphProjectionJob({
          job_id: reclaimed.job_id,
          worker_id: "graph_worker_b",
          lease_token: reclaimed.lease_token,
          receipt,
        }),
      ).resolves.toMatchObject({ replayed: true });
      const reset = await storage.resetGraphProjectionScopes({
        scopes: [{ principal_id: "user_local", scope: MAIN_SCOPE }],
        mode: "pending",
        reset_at: "2026-07-29T01:05:00.000Z",
      });
      const resetJobId = reset.job_ids[0];
      if (resetJobId === undefined) {
        throw new Error("graph reset fixture requires one job");
      }
      await expect(
        storage.applyGraphProjectionJob({
          job_id: resetJobId,
          worker_id: "graph_worker_b",
          lease_token: reclaimed.lease_token,
          receipt,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    } finally {
      await storage.close();
    }
  });

  it("rejects stale publication, preserves scope isolation, and keeps history", async () => {
    const { storage } = await projectedStorage("graph-stale");
    try {
      await applyNextGraphJob(storage, {
        worker_id: "graph_main_ready_worker",
        claimed_at: "2026-07-29T01:50:00.000Z",
        lease_expires_at: "2026-07-29T01:55:00.000Z",
        completed_at: "2026-07-29T01:51:00.000Z",
      });

      const beforeOther = await storage.health();
      await storage.applyProjectionBatch({
        principal_id: "user_local",
        scope: OTHER_SCOPE,
        idempotency_key: "graph-other-scope-projection-0001",
        expected_projection_epoch:
          beforeOther.projection_frontier.projection_epoch,
        frontier: projectionFrontier({
          ledgerEpoch: beforeOther.ledger_epoch,
          tombstoneEpoch: beforeOther.tombstone_epoch,
          projectionEpoch:
            beforeOther.projection_frontier.projection_epoch + 1,
        }),
        projections: [],
        applied_at: "2026-07-29T01:52:00.000Z",
      });
      await applyNextGraphJob(storage, {
        worker_id: "graph_other_ready_worker",
        claimed_at: "2026-07-29T01:53:00.000Z",
        lease_expires_at: "2026-07-29T01:58:00.000Z",
        completed_at: "2026-07-29T01:54:00.000Z",
      });
      const otherReady = await storage.graphProjectionCheckpoint({
        principal_id: "user_local",
        scope: OTHER_SCOPE,
      });
      expect(otherReady.status).toBe("ready");

      const beforeMainRefresh = await storage.health();
      await storage.applyProjectionBatch({
        principal_id: "user_local",
        scope: MAIN_SCOPE,
        idempotency_key: "graph-main-scope-refresh-0001",
        expected_projection_epoch:
          beforeMainRefresh.projection_frontier.projection_epoch,
        frontier: projectionFrontier({
          ledgerEpoch: beforeMainRefresh.ledger_epoch,
          tombstoneEpoch: beforeMainRefresh.tombstone_epoch,
          projectionEpoch:
            beforeMainRefresh.projection_frontier.projection_epoch + 1,
        }),
        projections: [],
        applied_at: "2026-07-29T01:59:00.000Z",
      });
      const snapshot = await storage.graphScopeSnapshot({
        principal_id: "user_local",
        scope: MAIN_SCOPE,
      });
      const job = await claimOne(storage, {
        worker_id: "graph_stale_worker",
        claimed_at: "2026-07-29T02:00:00.000Z",
        lease_expires_at: "2026-07-29T02:05:00.000Z",
      });
      const firstReset = await storage.resetGraphProjectionScopes({
        scopes: [
          { principal_id: "user_local", scope: MAIN_SCOPE },
        ],
        mode: "pending",
        reset_at: "2026-07-29T02:01:00.000Z",
      });
      const replayedReset = await storage.resetGraphProjectionScopes({
        scopes: [
          { principal_id: "user_local", scope: MAIN_SCOPE },
        ],
        mode: "pending",
        reset_at: "2026-07-29T02:01:00.000Z",
      });
      expect(replayedReset.job_ids).toEqual(firstReset.job_ids);
      expect(firstReset.checkpoints).toHaveLength(1);
      expect(
        await storage.graphProjectionCheckpoint({
          principal_id: "user_local",
          scope: OTHER_SCOPE,
        }),
      ).toEqual(otherReady);

      await expect(
        storage.applyGraphProjectionJob({
          job_id: job.job_id,
          worker_id: "graph_stale_worker",
          lease_token: job.lease_token,
          receipt: appliedReceipt(job, {
            nodes: snapshot.snapshot.nodes.length,
            edges: snapshot.snapshot.edges.length,
          }, "2026-07-29T02:02:00.000Z"),
        }),
      ).rejects.toMatchObject({
        code: "STALE_PROJECTION_FRONTIER",
      });
      await expect(
        storage.graphProjectionCheckpoint({
          principal_id: "user_local",
          scope: MAIN_SCOPE,
        }),
      ).resolves.toMatchObject({
        status: "pending",
        backend_identity: null,
      });
      const status = await storage.graphProjectionStatus();
      expect(status.scope_states).toBe(2);
      expect(status.ready_scopes).toBe(1);
      expect(status.outbox_pending).toBeGreaterThan(0);
    } finally {
      await storage.close();
    }
  });

  it("rejects non-monotonic or incomplete state and content-bearing commands", async () => {
    const { dataRoot, storage } = await projectedStorage("graph-constraints");
    try {
      const job = await claimOne(storage, {
        worker_id: "graph_constraint_worker",
        claimed_at: "2026-07-29T03:00:00.000Z",
        lease_expires_at: "2026-07-29T03:05:00.000Z",
      });
      expect(() =>
        storage.claimGraphProjectionJobs({
          worker_id: "graph_unbounded_lease_worker",
          claimed_at: "2026-07-29T03:00:00.000Z",
          lease_expires_at: "2026-07-29T03:16:00.001Z",
          limit: 1,
        })
      ).toThrow();
      expect(() =>
        storage.failGraphProjectionJob({
          job_id: job.job_id,
          worker_id: "graph_constraint_worker",
          lease_token: job.lease_token,
          retry_at: "2026-07-29T03:06:00.000Z",
          receipt: {
            schema_version: "1.0.0",
            receipt_id: "graph_receipt_with_content",
            job_id: job.job_id,
            operation: job.operation,
            backend: job.backend,
            principal_id: job.principal_id,
            scope: job.scope,
            status: "failed",
            previous_frontier: job.target_frontier,
            resulting_frontier: null,
            logical_digest: null,
            backend_identity: null,
            node_count: 0,
            edge_count: 0,
            duration_ms: 1,
            completed_at: "2026-07-29T03:01:00.000Z",
            failure_code: "GRAPH_CHILD_EXITED",
            memory_text: "must never enter graph delivery evidence",
          },
        } as never)
      ).toThrow();
      const failedReceipt = GraphDeliveryReceiptSchema.parse({
        schema_version: "1.0.0",
        receipt_id: "graph_receipt_content_free_failure",
        job_id: job.job_id,
        operation: job.operation,
        backend: job.backend,
        principal_id: job.principal_id,
        scope: job.scope,
        status: "failed",
        previous_frontier: job.target_frontier,
        resulting_frontier: null,
        logical_digest: null,
        backend_identity: null,
        node_count: 0,
        edge_count: 0,
        duration_ms: 1,
        completed_at: "2026-07-29T03:01:00.000Z",
        failure_code: "GRAPH_CHILD_EXITED",
      });
      await expect(
        storage.failGraphProjectionJob({
          job_id: job.job_id,
          worker_id: "graph_constraint_worker",
          lease_token: job.lease_token,
          retry_at: "2026-07-29T03:06:00.000Z",
          receipt: failedReceipt,
        }),
      ).resolves.toMatchObject({
        job: {
          status: "failed",
          attempts: 1,
          last_failure: "GRAPH_CHILD_EXITED",
        },
        checkpoint: {
          status: "unavailable",
          last_failure: "GRAPH_CHILD_EXITED",
        },
      });
      await expect(
        storage.claimGraphProjectionJobs({
          worker_id: "graph_retry_worker",
          claimed_at: "2026-07-29T03:05:00.000Z",
          lease_expires_at: "2026-07-29T03:07:00.000Z",
          limit: 1,
        }),
      ).resolves.toEqual({ jobs: [] });
      const retried = await claimOne(storage, {
        worker_id: "graph_retry_worker",
        claimed_at: "2026-07-29T03:06:00.000Z",
        lease_expires_at: "2026-07-29T03:08:00.000Z",
      });
      expect(retried.job_id).toBe(job.job_id);
      expect(retried.attempts).toBe(2);
      await expect(
        storage.resetGraphProjectionScopes({
          scopes: [{ principal_id: "user_local", scope: MAIN_SCOPE }],
          mode: "rebuilding",
          reset_at: "2026-07-29T03:07:00.000Z",
        }),
      ).resolves.toMatchObject({
        checkpoints: [{ status: "rebuilding" }],
      });
      const rebuildSnapshot = await storage.graphScopeSnapshot({
        principal_id: "user_local",
        scope: MAIN_SCOPE,
      });
      await expect(
        storage.applyGraphProjectionJob({
          job_id: retried.job_id,
          worker_id: "graph_retry_worker",
          lease_token: retried.lease_token,
          receipt: appliedReceipt(retried, {
            nodes: rebuildSnapshot.snapshot.nodes.length,
            edges: rebuildSnapshot.snapshot.edges.length,
          }, "2026-07-29T03:07:30.000Z"),
        }),
      ).rejects.toMatchObject({
        code: "STALE_PROJECTION_FRONTIER",
      });
      await expect(
        storage.graphProjectionCheckpoint({
          principal_id: "user_local",
          scope: MAIN_SCOPE,
        }),
      ).resolves.toMatchObject({
        status: "rebuilding",
        backend_identity: null,
      });
      await expect(storage.graphProjectionStatus()).resolves.toMatchObject({
        receipts: 1,
      });
    } finally {
      await storage.close();
    }

    const database = new DatabaseSync(
      join(dataRoot, "ledger", "memory.db"),
    );
    try {
      const invalidHash = `sha256:${"a".repeat(63)}z`;
      database.exec(`
        INSERT INTO graph_projection_write_guard (
          singleton, operation, opened_at
        ) VALUES (1, 'constraint-test', '2026-07-29T03:10:00.000Z');
      `);
      for (const column of [
        "ledger_epoch",
        "tombstone_epoch",
        "projection_epoch",
        "graph_projection_epoch",
      ]) {
        expect(() =>
          database.exec(`
            UPDATE graph_projection_scope_state
            SET ${column} = -1
            WHERE principal_id = 'user_local'
              AND scope_kind = 'workspace'
              AND scope_id = 'workspace_local';
          `)
        ).toThrow();
      }
      expect(() =>
        database.exec(`
          UPDATE graph_projection_outbox_jobs
          SET attempts = 33
          WHERE principal_id = 'user_local'
            AND scope_kind = 'workspace'
            AND scope_id = 'workspace_local';
        `)
      ).toThrow();
      expect(() =>
        database.exec(`
          UPDATE graph_projection_scope_state
          SET last_failure = 'memory content must never enter errors'
          WHERE principal_id = 'user_local'
            AND scope_kind = 'workspace'
            AND scope_id = 'workspace_local';
        `)
      ).toThrow();
      expect(() =>
        database.exec(`
          UPDATE graph_projection_scope_state
          SET status = 'ready',
              frontier_json = NULL,
              logical_digest = NULL,
              backend_identity_json = NULL
          WHERE principal_id = 'user_local'
            AND scope_kind = 'workspace'
            AND scope_id = 'workspace_local';
        `)
      ).toThrow();
      expect(() =>
        database.prepare(`
          UPDATE graph_projection_scope_state
          SET logical_digest = ?
          WHERE principal_id = 'user_local'
            AND scope_kind = 'workspace'
            AND scope_id = 'workspace_local'
        `).run(invalidHash)
      ).toThrow();
      expect(() =>
        database.prepare(`
          UPDATE graph_projection_outbox_jobs
          SET expected_logical_digest = ?
          WHERE principal_id = 'user_local'
            AND scope_kind = 'workspace'
            AND scope_id = 'workspace_local'
        `).run(invalidHash)
      ).toThrow();
      const receiptJob = database.prepare(`
        SELECT job_id
        FROM graph_projection_outbox_jobs
        ORDER BY job_id
        LIMIT 1
      `).get() as { job_id: string } | undefined;
      if (receiptJob === undefined) {
        throw new Error("graph constraint fixture requires an outbox job");
      }
      expect(() =>
        database.prepare(`
          INSERT INTO graph_projection_receipts (
            receipt_id, job_id, backend, principal_id, scope_kind,
            scope_id, status, logical_digest, receipt_json, completed_at
          ) VALUES (
            'graph_receipt_invalid_digest', ?, 'ladybugdb', 'user_local',
            'workspace', 'workspace_local', 'applied', ?, '{}',
            '2026-07-29T03:11:00.000Z'
          )
        `).run(receiptJob.job_id, invalidHash)
      ).toThrow();
      const columns = database
        .prepare("PRAGMA table_info(graph_projection_outbox_jobs)")
        .all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).not.toEqual(
        expect.arrayContaining([
          "content",
          "memory_text",
          "evidence_body",
          "approval",
        ]),
      );
    } finally {
      database.exec(
        "DELETE FROM graph_projection_write_guard WHERE singleton = 1;",
      );
      database.close();
    }
  });

  it("marks restored graph checkpoints unavailable until reverified", async () => {
    const { storage } = await projectedStorage("graph-restore");
    const snapshot = await storage.graphScopeSnapshot({
      principal_id: "user_local",
      scope: MAIN_SCOPE,
    });
    const job = await claimOne(storage, {
      worker_id: "graph_restore_worker",
      claimed_at: "2026-07-29T04:00:00.000Z",
      lease_expires_at: "2026-07-29T04:05:00.000Z",
    });
    await storage.applyGraphProjectionJob({
      job_id: job.job_id,
      worker_id: "graph_restore_worker",
      lease_token: job.lease_token,
      receipt: appliedReceipt(job, {
        nodes: snapshot.snapshot.nodes.length,
        edges: snapshot.snapshot.edges.length,
      }),
    });
    await storage.resetGraphProjectionScopes({
      scopes: [{
        principal_id: "user_local",
        scope: MAIN_SCOPE,
      }],
      mode: "pending",
      reset_at: "2026-07-29T04:10:00.000Z",
    });
    await expect(storage.graphProjectionStatus()).resolves.toMatchObject({
      outbox_pending: 1,
    });
    const backup = await storage.createBackup();
    await storage.close();

    const target = join(
      temporaryRoot("graph-restore-parent"),
      "restored",
    );
    await restoreBackupToEmptyDataRoot({
      backup,
      dataRoot: target,
      minimumTombstoneEpoch: 0,
    });
    const restored = await SqliteStorageClient.open({ dataRoot: target });
    try {
      await expect(
        restored.graphProjectionCheckpoint({
          principal_id: "user_local",
          scope: MAIN_SCOPE,
        }),
      ).resolves.toMatchObject({
        status: "unavailable",
        logical_digest: null,
        backend_identity: null,
        last_failure: "GRAPH_SCOPE_STALE",
      });
      await expect(restored.graphProjectionStatus()).resolves.toMatchObject({
        outbox_pending: 0,
      });
      await expect(
        restored.claimGraphProjectionJobs({
          worker_id: "graph_restore_stale_job_probe",
          claimed_at: "2026-07-29T04:20:00.000Z",
          lease_expires_at: "2026-07-29T04:25:00.000Z",
          limit: 10,
        }),
      ).resolves.toEqual({ jobs: [] });
    } finally {
      await restored.close();
    }
  });
});
