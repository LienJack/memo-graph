import { generateKeyPairSync } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  MemoryRecoveryHeadProvider,
} from "@memo-graph/storage-sqlite";
import type {
  AdmissionObservation,
  SqliteStorageClient,
} from "@memo-graph/storage-sqlite";
import { canonicalSha256 } from "../../packages/contracts/src/index.js";
import workloads from "../../fixtures/g6/resources/workloads.json" with {
  type: "json",
};
import thresholds from "../../fixtures/g6/thresholds.json" with {
  type: "json",
};
import { inlineEpisode } from "../helpers/storage-examples.js";
import { openWithoutTestRecoveryProvider } from "../setup/recovery-provider.js";

const cleanupPaths: string[] = [];
const FIXED_AT = "2026-07-30T12:00:00.000Z";

function temporaryRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${prefix}-`)));
  cleanupPaths.push(root);
  return root;
}

function walBytes(dataRoot: string): number {
  const path = join(dataRoot, "ledger", "memory.db-wal");
  return existsSync(path) ? statSync(path).size : 0;
}

function copyMigrationsThrough(
  migrationRoot: string,
  lastVersion: number,
): void {
  for (const migration of readdirSync(join(process.cwd(), "migrations"))) {
    const version = Number(migration.slice(0, 4));
    if (
      Number.isInteger(version) &&
      version <= lastVersion &&
      migration.endsWith(".sql")
    ) {
      cpSync(
        join(process.cwd(), "migrations", migration),
        join(migrationRoot, migration),
      );
    }
  }
}

async function populatedStorage(
  name: "small" | "expected",
  observation?: AdmissionObservation,
): Promise<{
  dataRoot: string;
  storage: SqliteStorageClient;
}> {
  const workload = workloads.workloads[name];
  const dataRoot = temporaryRoot(`g6-resource-${name}`);
  const migrationRoot = temporaryRoot(`g6-resource-migrations-${name}`);
  copyMigrationsThrough(migrationRoot, 18);
  const bootstrap = await openWithoutTestRecoveryProvider({
    dataRoot,
    migrationsDir: migrationRoot,
    recoveryHeadProvider: null,
  });
  await bootstrap.close();

  const database = new DatabaseSync(
    join(dataRoot, "ledger", "memory.db"),
  );
  database.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
  try {
    const insertEvidence = database.prepare(
      `INSERT INTO evidence_events (
         evidence_id, sequence, occurred_at, recorded_at, scope_kind,
         scope_id, principal_id, actor_authority, source, authority,
         sensitivity, payload_storage, payload_inline,
         payload_blob_hash, media_type, content_hash, schema_version
       ) VALUES (
         ?, ?, ?, ?, 'workspace', 'workspace_g6_resource',
         'user_local', 'evaluation', 'evaluation', 'observed',
         'internal', 'inline', ?, NULL, 'text/plain', ?, '1.0.0'
       )`,
    );
    for (let index = 0; index < workload.evidence_records; index += 1) {
      const text = `g6-${name}-evidence-${index}`;
      insertEvidence.run(
        `evidence_g6_${name}_${index}`,
        index,
        FIXED_AT,
        FIXED_AT,
        text,
        canonicalSha256({
          storage: "inline",
          text,
          media_type: "text/plain",
        }),
      );
    }

    const memoryId = `memory_g6_${name}`;
    const lastRevisionId =
      `revision_g6_${name}_${workload.memory_revisions}`;
    database
      .prepare(
        `INSERT INTO memory_objects (
           memory_id, logical_key_hash, principal_id, scope_kind,
           scope_id, kind, lifecycle, current_revision_id, pinned,
           context_eligible, created_at, updated_at
         ) VALUES (
           ?, ?, 'user_local', 'workspace', 'workspace_g6_resource',
           'semantic', 'active', ?, 0, 1, ?, ?
         )`,
      )
      .run(
        memoryId,
        canonicalSha256(`g6.${name}.memory`),
        lastRevisionId,
        FIXED_AT,
        FIXED_AT,
      );
    const insertRevision = database.prepare(
      `INSERT INTO memory_revisions (
         revision_id, memory_id, revision, abstraction, lifecycle, kind,
         scope_kind, scope_id, authority, sensitivity, valid_from,
         valid_to, recorded_at, inferred, content_storage,
         content_inline, content_blob_hash, media_type, content_hash,
         supersedes_revision_id, transform_name, transform_version,
         created_at, purged_at
       ) VALUES (
         ?, ?, ?, 'l1_memory', ?, 'semantic', 'workspace',
         'workspace_g6_resource', 'observed', 'internal', ?, NULL, ?, 0,
         'inline', ?, NULL, 'text/plain', ?, ?, 'g6_resource_seed',
         '1.0.0', ?, NULL
       )`,
    );
    for (let revision = 1; revision <= workload.memory_revisions; revision += 1) {
      const revisionId = `revision_g6_${name}_${revision}`;
      const content = `g6-${name}-memory-revision-${revision}`;
      insertRevision.run(
        revisionId,
        memoryId,
        revision,
        revision === workload.memory_revisions ? "active" : "superseded",
        FIXED_AT,
        FIXED_AT,
        content,
        canonicalSha256({
          storage: "inline",
          text: content,
          media_type: "text/plain",
        }),
        revision === 1
          ? null
          : `revision_g6_${name}_${revision - 1}`,
        FIXED_AT,
      );
    }
    database
      .prepare(
        `UPDATE ledger_state
         SET ledger_epoch = ?, updated_at = ?
         WHERE singleton = 1`,
      )
      .run(
        workload.evidence_records + workload.memory_revisions,
        FIXED_AT,
      );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }

  cpSync(
    join(
      process.cwd(),
      "migrations",
      "0019-incremental-recovery-frontier.sql",
    ),
    join(migrationRoot, "0019-incremental-recovery-frontier.sql"),
  );

  const keys = generateKeyPairSync("ed25519");
  const recoveryHeadProvider = new MemoryRecoveryHeadProvider({
    authorityKeyId: `g6_resource_recovery_${name}`,
    trustRootVersion: 1,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
  });
  const storage = await openWithoutTestRecoveryProvider({
    dataRoot,
    migrationsDir: migrationRoot,
    recoveryHeadProvider,
    testOperations: true,
    ...(observation === undefined
      ? {}
      : {
          admission: {
            policy: thresholds.admission,
            observe: () => observation,
          },
        }),
  });
  const health = await storage.health();
  expect(health.counts).toMatchObject({
    evidence_events: workload.evidence_records,
    memory_revisions: workload.memory_revisions,
  });
  expect(health.recovery).toMatchObject({
    configured: true,
    state: "ready",
    unresolved_pending_count: 0,
  });
  return { dataRoot, storage };
}

function episode(name: "small" | "expected", index: number) {
  return inlineEpisode({
    episodeId: `episode_g6_${name}_queue_${index}`,
    evidenceId: `evidence_g6_${name}_queue_${index}`,
    idempotencyKey: `commit:g6:${name}:queue:${index}`,
    text: `g6 ${name} queue write ${index}`,
  });
}

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("G6 declared resource workloads", () => {
  for (const name of ["small", "expected"] as const) {
    it(`executes ${name} admission hysteresis against populated SQLite`, async () => {
      const observation: AdmissionObservation = {
        available_bytes:
          thresholds.admission.min_available_bytes_recover,
        wal_bytes: thresholds.admission.max_wal_bytes_recover,
        checkpoint_healthy: true,
        active_maintenance: null,
      };
      const { storage } = await populatedStorage(name, observation);
      await storage.commitEpisode(episode(name, 0));

      observation.wal_bytes =
        thresholds.admission.max_wal_bytes_enter + 1;
      observation.checkpoint_healthy = false;
      await expect(
        storage.commitEpisode(episode(name, 1)),
      ).rejects.toMatchObject({ code: "RESOURCE_PRESSURE" });
      observation.wal_bytes =
        thresholds.admission.max_wal_bytes_recover + 1;
      observation.checkpoint_healthy = true;
      await expect(
        storage.commitEpisode(episode(name, 2)),
      ).rejects.toMatchObject({ code: "RESOURCE_PRESSURE" });
      observation.wal_bytes =
        thresholds.admission.max_wal_bytes_recover;
      await expect(
        storage.commitEpisode(episode(name, 3)),
      ).resolves.toMatchObject({ state: "projection_pending" });
      await storage.close();
    });

    it(`executes ${name} bounded queue against populated SQLite`, async () => {
      const { storage } = await populatedStorage(name);
      const workload = workloads.workloads[name];
      const blocker = storage.blockWorkerForTest(150);
      const writes = Array.from(
        { length: workload.concurrent_requests },
        (_, index) => storage.commitEpisode(episode(name, index)),
      );
      const queued = await storage.health();
      expect(queued.writer_queue.depth).toBeGreaterThan(0);
      expect(queued.writer_queue.depth).toBeLessThanOrEqual(
        thresholds.admission.max_queue_depth,
      );
      expect(queued.writer_queue.oldest_age_ms).toBeGreaterThan(0);
      expect(queued.writer_queue.oldest_age_ms).toBeLessThanOrEqual(
        thresholds.admission.max_queue_age_ms,
      );
      await blocker;
      await Promise.all(writes);
      expect((await storage.health()).writer_queue).toMatchObject({
        depth: 0,
        completed: workload.concurrent_requests,
      });
      await storage.close();
    });

    it(`executes ${name} checkpoint convergence against populated SQLite`, async () => {
      const { dataRoot, storage } = await populatedStorage(name);
      await storage.commitEpisode(episode(name, 0));
      const before = walBytes(dataRoot);
      const checkpoint = await storage.checkpoint();
      const after = walBytes(dataRoot);
      expect(before).toBeGreaterThan(0);
      expect(checkpoint.busy).toBe(0);
      expect(checkpoint.checkpointed).toBeGreaterThanOrEqual(0);
      expect(after).toBeLessThanOrEqual(before);
      expect(after).toBeLessThanOrEqual(
        thresholds.admission.max_wal_bytes_recover,
      );
      const observation = (await storage.health()).admission_observation;
      expect(observation?.available_bytes).toBeGreaterThan(0);
      expect(observation?.wal_bytes).toBe(after);
      await storage.close();
    });

    it(`executes ${name} maintenance exclusion against populated SQLite`, async () => {
      const observation: AdmissionObservation = {
        available_bytes:
          thresholds.admission.min_available_bytes_recover,
        wal_bytes: thresholds.admission.max_wal_bytes_recover,
        checkpoint_healthy: true,
        active_maintenance: "backup",
      };
      const { storage } = await populatedStorage(name, observation);
      await expect(
        storage.commitEpisode(episode(name, 0)),
      ).rejects.toMatchObject({ code: "MAINTENANCE_BLOCKED" });
      await expect(storage.checkpoint()).rejects.toMatchObject({
        code: "MAINTENANCE_BLOCKED",
      });
      observation.active_maintenance = null;
      await expect(storage.checkpoint()).resolves.toMatchObject({
        busy: 0,
      });
      await expect(
        storage.commitEpisode(episode(name, 1)),
      ).resolves.toMatchObject({ state: "projection_pending" });
      await storage.close();
    });
  }
});
