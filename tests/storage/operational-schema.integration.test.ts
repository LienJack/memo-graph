import {
  cpSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import { prepareDataRoot } from "../../packages/storage-sqlite/src/data-root.js";
import { StorageDatabase } from "../../packages/storage-sqlite/src/database.js";
import {
  applyMigrations,
  type OperationalMigrationFailurePoint,
} from "../../packages/storage-sqlite/src/migrations.js";
import { canonicalSha256 } from "../../packages/contracts/src/index.js";
import { inlineEpisode } from "../helpers/storage-examples.js";

const cleanupPaths: string[] = [];
const operationalMigrationFailurePoints = [
  "plaintext_guard",
  "encrypted_storage_schema",
  "purge_registry",
  "operational_authority",
  "release_control",
  "commit",
] as const;

function temporaryRoot(prefix: string): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-graph-${prefix}-`)),
  );
  cleanupPaths.push(root);
  return root;
}

function copyMigrationsThrough(target: string, maximumVersion: number): void {
  for (const name of readdirSync(join(process.cwd(), "migrations")).sort()) {
    const version = Number(name.slice(0, 4));
    if (Number.isInteger(version) && version <= maximumVersion) {
      cpSync(join(process.cwd(), "migrations", name), join(target, name));
    }
  }
}

function legacyStorage(
  dataRoot: string,
  migrationsDir: string,
): StorageDatabase {
  return new StorageDatabase({
    layout: prepareDataRoot(dataRoot),
    migrationsDir,
    busyTimeoutMs: 5_000,
  });
}

function applyLegacyMigrationsWithFault(input: {
  dataRoot: string;
  migrationsDir: string;
  failurePoint: OperationalMigrationFailurePoint;
}): void {
  const database = new Database(
    join(input.dataRoot, "ledger", "memory.db"),
  );
  try {
    database.pragma("foreign_keys = ON");
    applyMigrations(database, input.migrationsDir, {
      operationalFailure: (point) => {
        if (point === input.failurePoint) {
          throw new Error(`test migration interruption:${point}`);
        }
      },
    });
  } finally {
    database.close();
  }
}

function canonicalSnapshot(dataRoot: string): {
  evidence: unknown;
  counts: unknown;
  frontier: unknown;
} {
  const database = new DatabaseSync(
    join(dataRoot, "ledger", "memory.db"),
    { readOnly: true },
  );
  try {
    return {
      evidence: database
        .prepare(
          `SELECT evidence_id, content_hash, payload_storage, payload_inline,
                  payload_blob_hash, purged_at
           FROM evidence_events
           ORDER BY evidence_id`,
        )
        .all(),
      counts: database
        .prepare(
          `SELECT
             (SELECT count(*) FROM evidence_events) AS evidence_events,
             (SELECT count(*) FROM episodes) AS episodes,
             (SELECT count(*) FROM mutation_receipts) AS mutation_receipts,
             (SELECT count(*) FROM outbox_jobs) AS outbox_jobs`,
        )
        .get(),
      frontier: database
        .prepare(
          `SELECT ledger_epoch, updated_at
           FROM ledger_state
           WHERE singleton = 1`,
        )
        .get(),
    };
  } finally {
    database.close();
  }
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target !== undefined) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

describe("0015 operational hardening schema", () => {
  it("adds bounded encrypted-content, key, rotation, artifact, and receipt state", async () => {
    const dataRoot = temporaryRoot("operational-schema");
    const storage = await SqliteStorageClient.open({ dataRoot });
    const health = await storage.health();
    await storage.close();

    expect(health.schema_version).toBe("0020");
    expect(health.migrations).toHaveLength(20);
    expect(health.counts).toMatchObject({
      encryption_keys: 0,
      encrypted_contents: 0,
      secret_nonce_reservations: 0,
      key_rotations: 0,
      encrypted_artifact_operations: 0,
      operational_receipts: 0,
      artifact_store_registry: expect.any(Number),
    });

    const database = new DatabaseSync(
      join(dataRoot, "ledger", "memory.db"),
      { readOnly: true },
    );
    const tables = (
      database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
        )
        .all() as Array<{ name: string }>
    ).map(({ name }) => name);
    const indexes = (
      database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'index' ORDER BY name",
        )
        .all() as Array<{ name: string }>
    ).map(({ name }) => name);
    database.close();

    expect(tables).toEqual(
      expect.arrayContaining([
        "encryption_keys",
        "secret_nonce_reservations",
        "encrypted_contents",
        "encrypted_content_owners",
        "key_rotations",
        "key_rotation_items",
        "encrypted_artifact_operations",
        "artifact_store_registry",
        "artifact_purge_frontiers",
        "operational_receipts",
      ]),
    );
    expect(indexes).toEqual(
      expect.arrayContaining([
        "encryption_keys_one_current",
        "encryption_keys_one_rotating_to",
        "secret_nonce_reservations_key_nonce",
      ]),
    );
  });

  it("upgrades an accepted 0017 ledger to the purge saga without rewriting canonical rows", () => {
    const dataRoot = temporaryRoot("purge-saga-upgrade");
    const migrationRoot = temporaryRoot("purge-saga-migrations");
    copyMigrationsThrough(migrationRoot, 17);
    const before = legacyStorage(dataRoot, migrationRoot);
    const input = inlineEpisode({
      episodeId: "episode_before_0018",
      evidenceId: "evidence_before_0018",
      idempotencyKey: "commit-before-0018-purge-saga",
      text: "canonical row survives the additive purge saga migration",
    });
    const receipt = before.commitEpisode(input).receipt;
    const beforeSnapshot = canonicalSnapshot(dataRoot);
    before.close();

    copyMigrationsThrough(migrationRoot, 18);
    const upgraded = legacyStorage(dataRoot, migrationRoot);
    const health = upgraded.health();
    const replay = upgraded.commitEpisode(input).receipt;
    upgraded.close();

    expect(health.schema_version).toBe("0018");
    expect(replay).toEqual(receipt);
    expect(canonicalSnapshot(dataRoot)).toEqual(beforeSnapshot);
    const database = new DatabaseSync(
      join(dataRoot, "ledger", "memory.db"),
      { readOnly: true },
    );
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      database
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE type = 'table'
             AND name IN (
               'purge_blob_deletion_intents',
               'purge_physical_maintenance'
             )
           ORDER BY name`,
        )
        .all(),
    ).toEqual([
      { name: "purge_blob_deletion_intents" },
      { name: "purge_physical_maintenance" },
    ]);
    database.close();
  });

  it("quarantines an unscoped pre-0019 projection repair", () => {
    const dataRoot = temporaryRoot("legacy-unscoped-repair");
    const migrationRoot = temporaryRoot("legacy-unscoped-repair-migrations");
    copyMigrationsThrough(migrationRoot, 18);
    legacyStorage(dataRoot, migrationRoot).close();
    const operationId = "legacy_unscoped_projection_repair_1";
    const completedOperationId =
      "legacy_unscoped_completed_projection_repair_1";
    const database = new DatabaseSync(join(dataRoot, "ledger", "memory.db"));
    database
      .prepare(
        `INSERT INTO operational_repair_jobs (
           operation_id, repair_kind, request_hash, state,
           source_frontier_hash, artifact_count, relation_count,
           ledger_epoch, result_hash, started_at, completed_at
         ) VALUES (?, 'layered_projection', ?, 'rebuilding', ?,
                   NULL, NULL, NULL, NULL, ?, NULL)`,
      )
      .run(
        operationId,
        canonicalSha256("legacy unscoped repair request"),
        canonicalSha256("legacy unscoped repair frontier"),
        "2026-07-30T00:00:00.000Z",
      );
    database
      .prepare(
        `INSERT INTO operational_repair_jobs (
           operation_id, repair_kind, request_hash, state,
           source_frontier_hash, artifact_count, relation_count,
           ledger_epoch, result_hash, started_at, completed_at
         ) VALUES (?, 'sqlite_relations', ?, 'completed', ?,
                   2, 3, 4, ?, ?, ?)` ,
      )
      .run(
        completedOperationId,
        canonicalSha256("legacy completed repair request"),
        canonicalSha256("legacy completed repair frontier"),
        canonicalSha256("legacy completed repair result"),
        "2026-07-30T00:00:00.000Z",
        "2026-07-30T00:01:00.000Z",
      );
    database.close();

    copyMigrationsThrough(migrationRoot, 19);
    const upgraded = legacyStorage(dataRoot, migrationRoot);
    expect(
      upgraded.inspectOperationalRepair({ operation_id: operationId }),
    ).toMatchObject({
      operation_id: operationId,
      repair_kind: "layered_projection",
      principal_id: null,
      scope: null,
      state: "blocked",
      artifact_count: 0,
      relation_count: 0,
    });
    expect(
      upgraded.inspectOperationalRepair({
        operation_id: completedOperationId,
      }),
    ).toMatchObject({
      operation_id: completedOperationId,
      repair_kind: "sqlite_relations",
      principal_id: null,
      scope: null,
      state: "completed",
      artifact_count: 2,
      relation_count: 3,
    });
    expect(() =>
      upgraded.prepareOperationalRepair({
        operation_id: completedOperationId,
        repair_kind: "sqlite_relations",
        source: "canonical_sqlite",
        principal_id: "principal:legacy-repair",
        scope: { kind: "workspace", id: "workspace:legacy-repair" },
        expected_frontier_hash: canonicalSha256(
          "legacy completed repair frontier",
        ),
        started_at: "2026-07-30T00:00:00.000Z",
        completed_at: "2026-07-30T00:01:00.000Z",
      }),
    ).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
    upgraded.close();
  });

  it("preserves an accepted non-secret 0014 database through forward upgrade", async () => {
    const dataRoot = temporaryRoot("operational-upgrade");
    const migrationRoot = temporaryRoot("operational-migrations");
    copyMigrationsThrough(migrationRoot, 14);
    const before = legacyStorage(dataRoot, migrationRoot);
    const receipt = before.commitEpisode(
      inlineEpisode({
        episodeId: "episode_before_0015",
        evidenceId: "evidence_before_0015",
        idempotencyKey: "commit-before-0015-operational",
        text: "non-secret canonical row survives operational migration",
      }),
    ).receipt;
    const beforeHealth = before.health();
    before.close();

    copyMigrationsThrough(migrationRoot, 15);
    const upgraded = legacyStorage(dataRoot, migrationRoot);
    const afterHealth = upgraded.health();
    const replay = upgraded.commitEpisode(
      inlineEpisode({
        episodeId: "episode_before_0015",
        evidenceId: "evidence_before_0015",
        idempotencyKey: "commit-before-0015-operational",
        text: "non-secret canonical row survives operational migration",
      }),
    ).receipt;
    upgraded.close();

    expect(afterHealth.schema_version).toBe("0015");
    expect(afterHealth.ledger_epoch).toBe(beforeHealth.ledger_epoch);
    expect(afterHealth.latest_receipt_hash).toBe(
      beforeHealth.latest_receipt_hash,
    );
    expect(afterHealth.counts.evidence_events).toBe(
      beforeHealth.counts.evidence_events,
    );
    expect(replay).toEqual(receipt);
  });

  it("fails before serving if a pre-0015 database contains secret plaintext", async () => {
    const dataRoot = temporaryRoot("operational-secret-guard");
    const migrationRoot = temporaryRoot("operational-secret-migrations");
    copyMigrationsThrough(migrationRoot, 14);
    const before = legacyStorage(dataRoot, migrationRoot);
    before.close();

    const database = new DatabaseSync(join(dataRoot, "ledger", "memory.db"));
    database.exec("PRAGMA foreign_keys = ON");
    database
      .prepare(
        `INSERT INTO evidence_events (
           evidence_id, sequence, occurred_at, recorded_at, scope_kind, scope_id,
           principal_id, actor_authority, source, authority, sensitivity,
           payload_storage, payload_inline, payload_blob_hash, media_type,
           content_hash, schema_version
         ) VALUES (?, 0, ?, ?, 'workspace', 'workspace:test', 'principal:test',
           'user_stated', 'conversation_turn', 'user_stated', 'secret',
           'inline', ?, NULL, 'text/plain', ?, '1.0.0')`,
      )
      .run(
        "evidence:legacy-secret",
        "2026-07-30T00:00:00.000Z",
        "2026-07-30T00:00:00.000Z",
        "legacy-secret-plaintext-marker",
        `sha256:${"a".repeat(64)}`,
      );
    database.close();

    copyMigrationsThrough(migrationRoot, 15);
    const migrationDatabase = new Database(
      join(dataRoot, "ledger", "memory.db"),
    );
    try {
      expect(() =>
        applyMigrations(migrationDatabase, migrationRoot),
      ).toThrowError(
        expect.objectContaining({ code: "MIGRATION_DRIFT" }),
      );
    } finally {
      migrationDatabase.close();
    }
  });

  it.each(operationalMigrationFailurePoints)(
    "recovers atomically when interrupted at the %s boundary",
    async (failurePoint) => {
      const dataRoot = temporaryRoot(
        `operational-migration-${failurePoint}`,
      );
      const migrationRoot = temporaryRoot(
        `operational-migration-files-${failurePoint}`,
      );
      copyMigrationsThrough(migrationRoot, 14);
      const before = legacyStorage(dataRoot, migrationRoot);
      const input = inlineEpisode({
        episodeId: `episode_before_0015_${failurePoint}`,
        evidenceId: `evidence_before_0015_${failurePoint}`,
        idempotencyKey: `commit-before-0015-${failurePoint}`,
        text: `canonical identity survives ${failurePoint}`,
      });
      const receipt = before.commitEpisode(input).receipt;
      before.close();
      const expected = canonicalSnapshot(dataRoot);

      copyMigrationsThrough(migrationRoot, 15);
      expect(() =>
        applyLegacyMigrationsWithFault({
          dataRoot,
          migrationsDir: migrationRoot,
          failurePoint,
        }),
      ).toThrowError(`test migration interruption:${failurePoint}`);

      const interrupted = new DatabaseSync(
        join(dataRoot, "ledger", "memory.db"),
        { readOnly: true },
      );
      const appliedVersion = (
        interrupted
          .prepare(
            `SELECT max(version) AS version
             FROM schema_migrations`,
          )
          .get() as { version: string }
      ).version;
      const operationalTableCount = (
        interrupted
          .prepare(
            `SELECT count(*) AS count
             FROM sqlite_schema
             WHERE type = 'table'
               AND name = 'encryption_keys'`,
          )
          .get() as { count: number }
      ).count;
      interrupted.close();

      if (failurePoint === "commit") {
        expect(appliedVersion).toBe("0015");
        expect(operationalTableCount).toBe(1);
      } else {
        expect(appliedVersion).toBe("0014");
        expect(operationalTableCount).toBe(0);
      }
      expect(canonicalSnapshot(dataRoot)).toEqual(expected);

      const recovered = legacyStorage(dataRoot, migrationRoot);
      const health = recovered.health();
      const replay = recovered.commitEpisode(input).receipt;
      recovered.close();

      expect(health.schema_version).toBe("0015");
      expect(replay).toEqual(receipt);
      expect(canonicalSnapshot(dataRoot)).toEqual(expected);

      const verified = new DatabaseSync(
        join(dataRoot, "ledger", "memory.db"),
        { readOnly: true },
      );
      expect(verified.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      verified.close();
    },
  );
});
