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

import { afterEach, describe, expect, it } from "vitest";

import { SqliteStorageClient } from "@memo-graph/storage-sqlite";
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

    expect(health.schema_version).toBe("0015");
    expect(health.migrations).toHaveLength(15);
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

  it("preserves an accepted non-secret 0014 database through forward upgrade", async () => {
    const dataRoot = temporaryRoot("operational-upgrade");
    const migrationRoot = temporaryRoot("operational-migrations");
    copyMigrationsThrough(migrationRoot, 14);
    const before = await SqliteStorageClient.open({
      dataRoot,
      migrationsDir: migrationRoot,
    });
    const receipt = await before.commitEpisode(
      inlineEpisode({
        episodeId: "episode_before_0015",
        evidenceId: "evidence_before_0015",
        idempotencyKey: "commit-before-0015-operational",
        text: "non-secret canonical row survives operational migration",
      }),
    );
    const beforeHealth = await before.health();
    await before.close();

    copyMigrationsThrough(migrationRoot, 15);
    const upgraded = await SqliteStorageClient.open({
      dataRoot,
      migrationsDir: migrationRoot,
    });
    const afterHealth = await upgraded.health();
    const replay = await upgraded.commitEpisode(
      inlineEpisode({
        episodeId: "episode_before_0015",
        evidenceId: "evidence_before_0015",
        idempotencyKey: "commit-before-0015-operational",
        text: "non-secret canonical row survives operational migration",
      }),
    );
    await upgraded.close();

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
    const before = await SqliteStorageClient.open({
      dataRoot,
      migrationsDir: migrationRoot,
    });
    await before.close();

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
    await expect(
      SqliteStorageClient.open({ dataRoot, migrationsDir: migrationRoot }),
    ).rejects.toMatchObject({ code: "MIGRATION_DRIFT" });
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
      const before = await SqliteStorageClient.open({
        dataRoot,
        migrationsDir: migrationRoot,
      });
      const input = inlineEpisode({
        episodeId: `episode_before_0015_${failurePoint}`,
        evidenceId: `evidence_before_0015_${failurePoint}`,
        idempotencyKey: `commit-before-0015-${failurePoint}`,
        text: `canonical identity survives ${failurePoint}`,
      });
      const receipt = await before.commitEpisode(input);
      await before.close();
      const expected = canonicalSnapshot(dataRoot);

      copyMigrationsThrough(migrationRoot, 15);
      await expect(
        SqliteStorageClient.open({
          dataRoot,
          migrationsDir: migrationRoot,
          testFaults: {
            operationalMigrationExitAt: failurePoint,
          },
        }),
      ).rejects.toMatchObject({ code: "WORKER_CRASHED" });

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

      const recovered = await SqliteStorageClient.open({
        dataRoot,
        migrationsDir: migrationRoot,
      });
      const health = await recovered.health();
      const replay = await recovered.commitEpisode(input);
      await recovered.close();

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
