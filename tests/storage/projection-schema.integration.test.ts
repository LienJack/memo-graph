import {
  cpSync,
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
  ProjectionRevisionSchema,
  canonicalSha256,
} from "../../packages/contracts/src/index.js";
import { prepareDataRoot } from "../../packages/storage-sqlite/src/data-root.js";
import { StorageDatabase } from "../../packages/storage-sqlite/src/database.js";
import { projectionSourceReason } from "../../packages/storage-sqlite/src/governed-memory-reader.js";

import {
  projectionFrontier,
  relationProjection,
  seedProjectionSources,
  topicProjection,
} from "../helpers/projection-examples.js";

const cleanupPaths: string[] = [];

function projectionVariant(
  base: ReturnType<typeof topicProjection>,
  options: {
    id: string;
    projectionType?: "scenario" | "topic";
    text: string;
  },
) {
  const projectionType = options.projectionType ?? "topic";
  const content = {
    storage: "inline",
    text: options.text,
    media_type: "text/plain",
  } as const;
  return ProjectionRevisionSchema.parse({
    ...base,
    projection_id: options.id,
    projection_revision_id: `${options.id}_revision_1`,
    projection_type: projectionType,
    abstraction:
      projectionType === "scenario" ? "l2_scenario" : "l2_topic",
    payload:
      projectionType === "scenario"
        ? {
            kind: "scenario",
            key: options.id,
            trigger: options.id,
            preconditions: [],
            outcomes: [options.text],
          }
        : {
            kind: "topic",
            key: options.id,
            summary: options.text,
            open_items: [],
          },
    content,
    content_hash: canonicalSha256(content),
  });
}

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

describe("layered projection storage", () => {
  it.each([
    ["NOT_FOUND", "SOURCE_MISSING"],
    ["WRONG_PRINCIPAL", "SOURCE_PRINCIPAL_MISMATCH"],
    ["WRONG_SCOPE", "SOURCE_SCOPE_MISMATCH"],
    ["SUPERSEDED", "SOURCE_SUPERSEDED"],
    ["CANDIDATE_ONLY", "SOURCE_INACTIVE"],
    ["QUARANTINED", "SOURCE_INACTIVE"],
    ["REVOKED", "SOURCE_REVOKED"],
    ["TOMBSTONED", "SOURCE_TOMBSTONED"],
    ["NO_LIVE_EVIDENCE", "SOURCE_NO_LIVE_EVIDENCE"],
    ["NO_ACTIVATION", "SOURCE_NO_ACTIVATION"],
    ["NOT_YET_VALID", "SOURCE_NOT_YET_VALID"],
    ["EXPIRED", "SOURCE_EXPIRED"],
    ["OPEN_CONFLICT", "SOURCE_CONFLICT"],
    ["USAGE_BLOCKED", "SOURCE_USAGE_BLOCKED"],
    ["SENSITIVE_EXCLUDED", "SOURCE_SENSITIVE_EXCLUDED"],
    ["SECRET_EXCLUDED", "SOURCE_SECRET_EXCLUDED"],
    ["CONTENT_NOT_INLINE", "SOURCE_INACTIVE"],
    ["CORRUPT_LINEAGE", "SOURCE_INVALIDATED"],
  ] as const)(
    "maps canonical eligibility reason %s to stable exact-source reason %s",
    (input, expected) => {
      expect(projectionSourceReason(input)).toBe(expected);
    },
  );

  it("upgrades an existing M2 database and exposes the empty frontier", async () => {
    const dataRoot = temporaryRoot("projection-upgrade");
    const migrationRoot = temporaryRoot("projection-migrations");
    for (let version = 1; version <= 7; version += 1) {
      const prefix = String(version).padStart(4, "0");
      const source = join(process.cwd(), "migrations");
      const name = (
        await import("node:fs")
      ).readdirSync(source).find((entry) => entry.startsWith(`${prefix}-`));
      if (name === undefined) {
        throw new Error(`missing migration ${prefix}`);
      }
      cpSync(join(source, name), join(migrationRoot, name));
    }

    const m2 = new StorageDatabase({
      layout: prepareDataRoot(dataRoot),
      migrationsDir: migrationRoot,
      busyTimeoutMs: 5_000,
    });
    expect(m2.health().schema_version).toBe("0007");
    m2.close();

    cpSync(
      join(process.cwd(), "migrations", "0008-layered-projections.sql"),
      join(migrationRoot, "0008-layered-projections.sql"),
    );
    cpSync(
      join(
        process.cwd(),
        "migrations",
        "0009-projection-purge-redaction.sql",
      ),
      join(migrationRoot, "0009-projection-purge-redaction.sql"),
    );
    const upgraded = new StorageDatabase({
      layout: prepareDataRoot(dataRoot),
      migrationsDir: migrationRoot,
      busyTimeoutMs: 5_000,
    });
    const health = upgraded.health();
    upgraded.close();

    expect(health.schema_version).toBe("0009");
    expect(health.migrations).toHaveLength(9);
    expect(health.layered_projection_state).toBe("ready");
    expect(health.projection_frontier).toMatchObject({
      ledger_epoch: 0,
      tombstone_epoch: 0,
      projection_epoch: 0,
      transform_versions: [],
    });
    expect(health.counts).toMatchObject({
      projection_objects: 0,
      projection_revisions: 0,
      projection_sources: 0,
      relation_objects: 0,
      relation_revisions: 0,
      projection_outbox_pending: 0,
      projection_rebuild_receipts: 0,
    });
  });

  it("atomically applies and replays one exact-lineage projection batch", async () => {
    const dataRoot = temporaryRoot("projection-apply");
    const storage = await SqliteStorageClient.open({ dataRoot });
    const sources = await seedProjectionSources(storage);
    const health = await storage.health();
    const frontier = projectionFrontier({
      ledgerEpoch: health.ledger_epoch,
      tombstoneEpoch: health.tombstone_epoch,
      projectionEpoch: 1,
    });
    const command = {
      principal_id: "user_local",
      scope: { kind: "workspace", id: "workspace_local" } as const,
      idempotency_key: "projection-batch-0001",
      expected_projection_epoch: 0,
      projections: [topicProjection(sources, frontier)],
      applied_at: "2026-07-28T12:05:00.000Z",
    };

    const first = await storage.applyProjectionBatch(command);
    const replay = await storage.applyProjectionBatch(command);
    const query = await storage.queryProjections({
      principal_id: "user_local",
      scope: { kind: "workspace", id: "workspace_local" },
      projection_types: ["topic"],
      as_of: "2026-07-28T12:06:00.000Z",
      limit: 20,
    });
    const after = await storage.health();
    await storage.close();

    expect(first).toMatchObject({
      replayed: false,
      projection_epoch: 1,
      projection_revision_ids: [
        "projection_revision_topic_runtime_1",
      ],
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(query.items).toEqual([command.projections[0]]);
    expect(query.frontier.projection_epoch).toBe(1);
    expect(after.projection_frontier).toEqual(query.frontier);
    expect(after.counts).toMatchObject({
      projection_objects: 1,
      projection_revisions: 1,
      projection_sources: 2,
    });
  });

  it("validates exact mixed L1/L2 source revision identities in one complete batch", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("projection-exact-sources"),
    });
    const sources = await seedProjectionSources(storage);
    const health = await storage.health();
    const frontier = projectionFrontier({
      ledgerEpoch: health.ledger_epoch,
      tombstoneEpoch: health.tombstone_epoch,
      projectionEpoch: 1,
    });
    const projection = topicProjection(sources, frontier);
    await storage.applyProjectionBatch({
      principal_id: "user_local",
      scope: { kind: "workspace", id: "workspace_local" },
      idempotency_key: "projection-exact-sources-0001",
      expected_projection_epoch: 0,
      projections: [projection],
      applied_at: "2026-07-28T12:05:00.000Z",
    });
    const exact = await storage.validateProjectionSources({
      principal_id: "user_local",
      scope: { kind: "workspace", id: "workspace_local" },
      as_of: "2026-07-28T12:06:00.000Z",
      include_sensitive: false,
      context_scope: { kind: "workspace", id: "workspace_local" },
      revision_ids: [
        sources[0].revision_id,
        projection.projection_revision_id,
        "revision_missing_exact_source",
      ],
    });
    expect(exact).toMatchObject({
      requested_count: 3,
      complete: true,
      results: [
        {
          revision_id: sources[0].revision_id,
          status: "eligible",
          source: { abstraction: "l1_memory" },
        },
        {
          revision_id: projection.projection_revision_id,
          status: "eligible",
          source: { abstraction: "l2_topic" },
        },
        {
          revision_id: "revision_missing_exact_source",
          status: "ineligible",
          reason_code: "SOURCE_MISSING",
        },
      ],
    });
    expect(
      (
        await storage.validateProjectionSources({
          principal_id: "user_other",
          scope: { kind: "workspace", id: "workspace_local" },
          as_of: "2026-07-28T12:06:00.000Z",
          revision_ids: [sources[0].revision_id],
        })
      ).results[0],
    ).toMatchObject({
      status: "ineligible",
      reason_code: "SOURCE_PRINCIPAL_MISMATCH",
    });
    expect(
      (
        await storage.validateProjectionSources({
          principal_id: "user_local",
          scope: { kind: "workspace", id: "workspace_other" },
          as_of: "2026-07-28T12:06:00.000Z",
          revision_ids: [sources[0].revision_id],
        })
      ).results[0],
    ).toMatchObject({
      status: "ineligible",
      reason_code: "SOURCE_SCOPE_MISMATCH",
    });
    const chunkedIds = Array.from(
      { length: 1_001 },
      (_, index) =>
        `revision_chunked_missing_${String(index).padStart(4, "0")}`,
    );
    const chunked = await storage.validateProjectionSources({
      principal_id: "user_local",
      scope: { kind: "workspace", id: "workspace_local" },
      as_of: "2026-07-28T12:06:00.000Z",
      revision_ids: chunkedIds,
    });
    expect(chunked).toMatchObject({
      requested_count: 1_001,
      complete: true,
      requested_revision_ids: chunkedIds,
    });
    expect(chunked.results).toHaveLength(1_001);
    expect(
      chunked.results.every(
        (result) =>
          result.status === "ineligible" &&
          result.reason_code === "SOURCE_MISSING",
      ),
    ).toBe(true);
    await storage.close();
  });

  it("persists independent exact-scope frontiers while the global epoch advances", async () => {
    const dataRoot = temporaryRoot("projection-scope-frontiers");
    const storage = await SqliteStorageClient.open({ dataRoot });
    const scopeA = { kind: "workspace", id: "workspace_a" } as const;
    const scopeB = { kind: "workspace", id: "workspace_b" } as const;
    const initial = await storage.health();
    const frontierA = projectionFrontier({
      ledgerEpoch: initial.ledger_epoch,
      tombstoneEpoch: initial.tombstone_epoch,
      projectionEpoch: 1,
    });
    await storage.applyProjectionBatch({
      principal_id: "user_local",
      scope: scopeA,
      idempotency_key: "projection-scope-a-empty-0001",
      expected_projection_epoch: 0,
      frontier: frontierA,
      projections: [],
      applied_at: "2026-07-28T12:05:00.000Z",
    });
    const frontierB = projectionFrontier({
      ledgerEpoch: initial.ledger_epoch,
      tombstoneEpoch: initial.tombstone_epoch,
      projectionEpoch: 2,
    });
    await storage.applyProjectionBatch({
      principal_id: "user_local",
      scope: scopeB,
      idempotency_key: "projection-scope-b-empty-0001",
      expected_projection_epoch: 1,
      frontier: frontierB,
      projections: [],
      applied_at: "2026-07-28T12:05:01.000Z",
    });

    const [storedA, storedB, after] = await Promise.all([
      storage.projectionScopeFrontier({
        principal_id: "user_local",
        scope: scopeA,
      }),
      storage.projectionScopeFrontier({
        principal_id: "user_local",
        scope: scopeB,
      }),
      storage.health(),
    ]);
    expect(storedA).toMatchObject({
      status: "ready",
      projection_epoch: 1,
      source_frontier_hash: frontierA.source_frontier_hash,
      projection_frontier_hash: frontierA.projection_frontier_hash,
    });
    expect(storedB).toMatchObject({
      status: "ready",
      projection_epoch: 2,
      source_frontier_hash: frontierB.source_frontier_hash,
      projection_frontier_hash: frontierB.projection_frontier_hash,
    });
    expect(after.projection_frontier.projection_epoch).toBe(2);
    await storage.close();

    const database = new DatabaseSync(
      join(dataRoot, "ledger", "memory.db"),
    );
    database.exec(
      `INSERT INTO projection_write_guard (
         singleton, operation, opened_at
       ) VALUES (1, 'test-regression', '2026-07-28T12:06:00.000Z')`,
    );
    expect(() =>
      database.exec(
        `UPDATE layered_projection_scope_state
         SET projection_epoch = 0
         WHERE principal_id = 'user_local'
           AND scope_kind = 'workspace'
           AND scope_id = 'workspace_a'`,
      ),
    ).toThrow(/PROJECTION_TRANSACTION_REQUIRED/);
    database.exec(
      "DELETE FROM projection_write_guard WHERE singleton = 1",
    );
    database.close();
  });

  it("pages stable projection tuples and binds cursors to query and scope state", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("projection-pages"),
    });
    const sources = await seedProjectionSources(storage);
    const health = await storage.health();
    const frontier = projectionFrontier({
      ledgerEpoch: health.ledger_epoch,
      tombstoneEpoch: health.tombstone_epoch,
      projectionEpoch: 1,
    });
    const base = topicProjection(sources, frontier);
    const relationBase = relationProjection(sources, frontier);
    const exactRelation = ProjectionRevisionSchema.parse({
      ...relationBase,
      projection_id: "projection_relation_z",
      projection_revision_id: "projection_relation_z_revision_1",
    });
    const projections = [
      projectionVariant(base, {
        id: "projection_topic_z",
        text: "topic z",
      }),
      projectionVariant(base, {
        id: "projection_scenario_a",
        projectionType: "scenario",
        text: "scenario a",
      }),
      projectionVariant(base, {
        id: "projection_topic_a",
        text: "topic a",
      }),
      exactRelation,
    ];
    await storage.applyProjectionBatch({
      principal_id: "user_local",
      scope: { kind: "workspace", id: "workspace_local" },
      idempotency_key: "projection-pages-apply-0001",
      expected_projection_epoch: 0,
      projections,
      applied_at: "2026-07-28T12:05:00.000Z",
    });

    const first = await storage.queryProjectionPage({
      principal_id: "user_local",
      scope: { kind: "workspace", id: "workspace_local" },
      projection_types: ["topic", "scenario"],
      as_of: "2026-07-28T12:06:00.000Z",
      limit: 1,
    });
    const second = await storage.queryProjectionPage({
      principal_id: "user_local",
      scope: { kind: "workspace", id: "workspace_local" },
      projection_types: ["topic", "scenario"],
      as_of: "2026-07-28T12:06:00.000Z",
      limit: 1,
      cursor: first.next_cursor ?? undefined,
    });
    const third = await storage.queryProjectionPage({
      principal_id: "user_local",
      scope: { kind: "workspace", id: "workspace_local" },
      projection_types: ["topic", "scenario"],
      as_of: "2026-07-28T12:06:00.000Z",
      limit: 1,
      cursor: second.next_cursor ?? undefined,
    });
    expect([
      first.items[0]?.projection_id,
      second.items[0]?.projection_id,
      third.items[0]?.projection_id,
    ]).toEqual([
      "projection_scenario_a",
      "projection_topic_a",
      "projection_topic_z",
    ]);
    expect(first).toMatchObject({
      examined_count: 1,
      total_count: 3,
      exhausted: false,
    });
    expect(third).toMatchObject({
      examined_count: 1,
      total_count: 3,
      next_cursor: null,
      exhausted: true,
    });

    await expect(
      storage.queryProjectionPage({
        principal_id: "user_local",
        scope: { kind: "workspace", id: "workspace_local" },
        projection_types: ["topic"],
        as_of: "2026-07-28T12:06:00.000Z",
        limit: 1,
        cursor: first.next_cursor ?? undefined,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    for (const changedIdentity of [
      {
        principal_id: "user_other",
        scope: { kind: "workspace", id: "workspace_local" } as const,
      },
      {
        principal_id: "user_local",
        scope: { kind: "workspace", id: "workspace_other" } as const,
      },
    ]) {
      await expect(
        storage.queryProjectionPage({
          ...changedIdentity,
          projection_types: ["topic", "scenario"],
          as_of: "2026-07-28T12:06:00.000Z",
          limit: 1,
          cursor: first.next_cursor ?? undefined,
        }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    expect(
      (
        await storage.queryProjectionPage({
          principal_id: "user_local",
          scope: { kind: "workspace", id: "workspace_local" },
          projection_types: ["relation"],
          projection_revision_ids: [
            exactRelation.projection_revision_id,
          ],
          as_of: "2026-07-28T12:06:00.000Z",
          limit: 1,
        })
      ).items.map((item) => item.projection_revision_id),
    ).toEqual([exactRelation.projection_revision_id]);

    const nextFrontier = projectionFrontier({
      ledgerEpoch: health.ledger_epoch,
      tombstoneEpoch: health.tombstone_epoch,
      projectionEpoch: 2,
    });
    await storage.applyProjectionBatch({
      principal_id: "user_local",
      scope: { kind: "workspace", id: "workspace_local" },
      idempotency_key: "projection-pages-frontier-0002",
      expected_projection_epoch: 1,
      frontier: nextFrontier,
      projections: [],
      applied_at: "2026-07-28T12:07:00.000Z",
    });
    await expect(
      storage.queryProjectionPage({
        principal_id: "user_local",
        scope: { kind: "workspace", id: "workspace_local" },
        projection_types: ["topic", "scenario"],
        as_of: "2026-07-28T12:06:00.000Z",
        limit: 1,
        cursor: first.next_cursor ?? undefined,
      }),
    ).rejects.toMatchObject({ code: "STALE_PROJECTION_FRONTIER" });
    await storage.close();
  });

  it("rejects stale frontiers, foreign scope, and immutable row mutation", async () => {
    const dataRoot = temporaryRoot("projection-invalid");
    const storage = await SqliteStorageClient.open({ dataRoot });
    const sources = await seedProjectionSources(storage);
    const health = await storage.health();
    const frontier = projectionFrontier({
      ledgerEpoch: health.ledger_epoch,
      tombstoneEpoch: health.tombstone_epoch,
      projectionEpoch: 1,
    });
    const projection = topicProjection(sources, frontier);
    await storage.applyProjectionBatch({
      principal_id: "user_local",
      scope: { kind: "workspace", id: "workspace_local" },
      idempotency_key: "projection-batch-valid-0001",
      expected_projection_epoch: 0,
      projections: [projection],
      applied_at: "2026-07-28T12:05:00.000Z",
    });

    await expect(
      storage.applyProjectionBatch({
        principal_id: "user_local",
        scope: { kind: "workspace", id: "workspace_local" },
        idempotency_key: "projection-batch-stale-0002",
        expected_projection_epoch: 0,
        projections: [
          {
            ...projection,
            projection_id: "projection_stale",
            projection_revision_id: "projection_revision_stale_1",
          },
        ],
        applied_at: "2026-07-28T12:05:01.000Z",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const nextFrontier = projectionFrontier({
      ledgerEpoch: health.ledger_epoch,
      tombstoneEpoch: health.tombstone_epoch,
      projectionEpoch: 2,
    });
    await expect(
      storage.applyProjectionBatch({
        principal_id: "user_local",
        scope: { kind: "workspace", id: "workspace_local" },
        idempotency_key: "projection-batch-foreign-0003",
        expected_projection_epoch: 1,
        projections: [
          {
            ...projection,
            projection_id: "projection_foreign",
            projection_revision_id: "projection_revision_foreign_1",
            source_revisions: [
              {
                ...sources[0],
                memory_id: "memory_outside_authoritative_lineage",
              },
              sources[1],
            ],
            frontier: nextFrontier,
            transform: nextFrontier.transform,
          },
        ],
        applied_at: "2026-07-28T12:05:02.000Z",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      storage.applyProjectionBatch({
        principal_id: "user_local",
        scope: { kind: "workspace", id: "workspace_other" },
        idempotency_key: "projection-batch-retire-other-0004",
        expected_projection_epoch: 1,
        frontier: nextFrontier,
        projections: [],
        retire_projection_revision_ids: [
          projection.projection_revision_id,
        ],
        applied_at: "2026-07-28T12:05:03.000Z",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await storage.close();

    const database = new DatabaseSync(
      join(dataRoot, "ledger", "memory.db"),
    );
    expect(() =>
      database.exec(
        `UPDATE projection_revisions
         SET content_hash = 'sha256:${"f".repeat(64)}'`,
      ),
    ).toThrow(/APPEND_ONLY/);
    expect(() =>
      database.exec("DELETE FROM projection_revision_sources"),
    ).toThrow(/APPEND_ONLY/);
    database.close();
  });

  it("runtime-decodes malformed projection worker operations", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("projection-decode"),
    });
    expect(() =>
      storage.applyProjectionBatch({
        principal_id: "user_local",
        scope: { kind: "workspace", id: "workspace_local" },
        idempotency_key: "projection-invalid",
        expected_projection_epoch: -1,
        projections: [],
        applied_at: "not-a-time",
      }),
    ).toThrow();
    await storage.close();
  });

  it("claims, retries, applies, invalidates, and receipts projection work", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("projection-outbox"),
    });
    const sources = await seedProjectionSources(storage);
    const health = await storage.health();
    const frontier = projectionFrontier({
      ledgerEpoch: health.ledger_epoch,
      tombstoneEpoch: health.tombstone_epoch,
      projectionEpoch: 1,
    });
    const seededJobs = await storage.claimProjectionJobs({
      worker_id: "projection_setup_worker",
      claimed_at: "2026-07-28T12:01:00.000Z",
      lease_expires_at: "2026-07-28T12:02:00.000Z",
      limit: 10,
    });
    for (const seededJob of seededJobs.jobs) {
      await storage.completeProjectionJob({
        job_id: seededJob.job_id,
        worker_id: "projection_setup_worker",
        completed_at: "2026-07-28T12:01:30.000Z",
      });
    }
    const job = {
      job_id: "projection_job_topic_1",
      kind: "refresh",
      aggregate_id: "projection_topic_runtime",
      principal_id: "user_local",
      scope: { kind: "workspace", id: "workspace_local" },
      source_revision_ids: sources.map((source) => source.revision_id),
      available_at: "2026-07-28T12:02:00.000Z",
      created_at: "2026-07-28T12:01:00.000Z",
    } as const;

    expect((await storage.enqueueProjectionJob(job)).replayed).toBe(false);
    expect((await storage.enqueueProjectionJob(job)).replayed).toBe(true);
    const firstClaim = await storage.claimProjectionJobs({
      worker_id: "projection_worker_1",
      claimed_at: "2026-07-28T12:03:00.000Z",
      lease_expires_at: "2026-07-28T12:04:00.000Z",
      limit: 10,
    });
    expect(firstClaim.jobs).toEqual([
      expect.objectContaining({
        job_id: job.job_id,
        status: "processing",
        attempts: 1,
      }),
    ]);
    expect(
      (
        await storage.failProjectionJob({
          job_id: job.job_id,
          worker_id: "projection_worker_1",
          error_code: "TRANSFORM_FAILED",
          retry_at: "2026-07-28T12:05:00.000Z",
          failed_at: "2026-07-28T12:03:30.000Z",
        })
      ).job,
    ).toMatchObject({
      status: "failed",
      last_error_code: "TRANSFORM_FAILED",
    });
    expect(
      (
        await storage.claimProjectionJobs({
          worker_id: "projection_worker_1",
          claimed_at: "2026-07-28T12:04:30.000Z",
          lease_expires_at: "2026-07-28T12:05:30.000Z",
          limit: 10,
        })
      ).jobs,
    ).toEqual([]);
    const retry = await storage.claimProjectionJobs({
      worker_id: "projection_worker_1",
      claimed_at: "2026-07-28T12:05:00.000Z",
      lease_expires_at: "2026-07-28T12:06:00.000Z",
      limit: 10,
    });
    expect(retry.jobs[0]).toMatchObject({
      job_id: job.job_id,
      status: "processing",
      attempts: 2,
    });

    const projection = topicProjection(sources, frontier);
    await storage.applyProjectionBatch({
      principal_id: "user_local",
      scope: { kind: "workspace", id: "workspace_local" },
      idempotency_key: "projection-batch-outbox-0001",
      expected_projection_epoch: 0,
      projections: [projection],
      applied_at: "2026-07-28T12:05:30.000Z",
      claimed_job: {
        job_id: job.job_id,
        worker_id: "projection_worker_1",
      },
    });
    expect((await storage.health()).counts.projection_outbox_pending).toBe(0);

    const invalidated = await storage.invalidateProjectionDescendants({
      source_revision_ids: [sources[0].revision_id],
      reason: "The canonical source was superseded.",
      invalidated_at: "2026-07-28T12:07:00.000Z",
    });
    expect(invalidated).toEqual({
      projection_ids: [projection.projection_id],
      projection_revision_ids: [projection.projection_revision_id],
    });
    expect(
      (
        await storage.queryProjections({
          principal_id: "user_local",
          scope: { kind: "workspace", id: "workspace_local" },
          as_of: "2026-07-28T12:08:00.000Z",
          limit: 20,
        })
      ).items,
    ).toEqual([]);

    const rebuildReceipt = {
      rebuild_receipt_id: "projection_rebuild_receipt_1",
      mode: "incremental",
      projection_epoch: 1,
      structural_digest: canonicalSha256({
        projections: [projection.projection_revision_id],
        invalidated: true,
      }),
      projection_count: 1,
      relation_count: 0,
      completed_at: "2026-07-28T12:08:30.000Z",
    } as const;
    expect(
      (await storage.recordProjectionRebuild(rebuildReceipt)).replayed,
    ).toBe(false);
    expect(
      (await storage.recordProjectionRebuild(rebuildReceipt)).replayed,
    ).toBe(true);
    await storage.close();
  });
});
