import {
  chmodSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  SqliteStorageClient,
  StorageError,
} from "@memo-graph/storage-sqlite";
import { prepareDataRoot } from "../../packages/storage-sqlite/src/data-root.js";
import { StorageDatabase } from "../../packages/storage-sqlite/src/database.js";
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

describe("data-root and migration contract", () => {
  it("creates a private local layout and records immutable migrations", async () => {
    const dataRoot = temporaryRoot("layout");
    chmodSync(dataRoot, 0o755);

    const storage = await SqliteStorageClient.open({ dataRoot });
    const health = await storage.health();
    await storage.close();

    expect(health.schema_version).toBe("0019");
    expect(health.journal_mode).toBe("wal");
    expect(health.foreign_keys).toBe(true);
    expect(health.migrations).toHaveLength(19);
    expect(health.migrations.every((migration) =>
      /^sha256:[a-f0-9]{64}$/.test(migration.hash),
    )).toBe(true);
    expect(statSync(dataRoot).mode & 0o777).toBe(0o700);
    expect(statSync(join(dataRoot, "ledger", "memory.db")).mode & 0o777).toBe(
      0o600,
    );
  });

  it("adds scope, graph, and vector delivery state without rewriting populated rows", async () => {
    const dataRoot = temporaryRoot("scope-frontier-upgrade");
    const migrationRoot = temporaryRoot("scope-frontier-migrations");
    for (let version = 1; version <= 10; version += 1) {
      const prefix = String(version).padStart(4, "0");
      const name = (
        await import("node:fs")
      ).readdirSync(join(process.cwd(), "migrations")).find((entry) =>
        entry.startsWith(`${prefix}-`)
      );
      if (name === undefined) {
        throw new Error(`missing migration ${prefix}`);
      }
      cpSync(
        join(process.cwd(), "migrations", name),
        join(migrationRoot, name),
      );
    }

    const before = new StorageDatabase({
      layout: prepareDataRoot(dataRoot),
      migrationsDir: migrationRoot,
      busyTimeoutMs: 5_000,
    });
    before.commitEpisode(
      inlineEpisode({
        episodeId: "episode_before_scope_frontier_migration",
        evidenceId: "evidence_before_scope_frontier_migration",
        idempotencyKey: "commit:before:scope-frontier:0001",
        text: "The ledger was populated before migration 0011.",
      }),
    );
    expect(before.health().schema_version).toBe("0010");
    before.close();

    cpSync(
      join(
        process.cwd(),
        "migrations",
        "0011-scope-projection-frontiers.sql",
      ),
      join(migrationRoot, "0011-scope-projection-frontiers.sql"),
    );
    const upgraded = new StorageDatabase({
      layout: prepareDataRoot(dataRoot),
      migrationsDir: migrationRoot,
      busyTimeoutMs: 5_000,
    });
    expect(upgraded.health().schema_version).toBe("0011");
    const oldHealth = upgraded.health();
    const oldFrontier = upgraded.projectionScopeFrontier({
        principal_id: "user_local",
        scope: { kind: "workspace", id: "workspace_local" },
      });
    expect(oldFrontier).toMatchObject({
      status: "pending",
      projection_epoch: 0,
      source_frontier_hash: null,
      projection_frontier_hash: null,
    });
    upgraded.close();

    const databasePath = join(dataRoot, "ledger", "memory.db");
    const beforeGraphMigration = new DatabaseSync(databasePath);
    beforeGraphMigration.exec(`
      INSERT INTO projection_write_guard (
        singleton, operation, opened_at
      ) VALUES (1, 'migration-fixture', '2026-07-29T00:00:00.000Z');
      INSERT INTO layered_projection_scope_state (
        principal_id, scope_kind, scope_id, status, ledger_epoch,
        tombstone_epoch, projection_epoch, source_frontier_hash,
        projection_frontier_hash, transform_versions_json, updated_at,
        error_code
      ) VALUES (
        'user_local', 'workspace', 'workspace_local', 'pending',
        1, 0, 0, NULL, NULL, '[]', '2026-07-29T00:00:00.000Z', NULL
      );
      DELETE FROM projection_write_guard WHERE singleton = 1;
    `);
    const canonicalRowBefore = beforeGraphMigration
      .prepare(
        `SELECT * FROM evidence_events
         WHERE evidence_id = 'evidence_before_scope_frontier_migration'`,
      )
      .get();
    const projectionRowBefore = beforeGraphMigration
      .prepare(
        `SELECT * FROM layered_projection_scope_state
         WHERE principal_id = 'user_local'
           AND scope_kind = 'workspace'
           AND scope_id = 'workspace_local'`,
      )
      .get();
    beforeGraphMigration.close();
    const storedBeforeGraphMigration = new StorageDatabase({
      layout: prepareDataRoot(dataRoot),
      migrationsDir: migrationRoot,
      busyTimeoutMs: 5_000,
    });
    const storedFrontierBefore =
      storedBeforeGraphMigration.projectionScopeFrontier({
        principal_id: "user_local",
        scope: { kind: "workspace", id: "workspace_local" },
      });
    storedBeforeGraphMigration.close();

    cpSync(
      join(
        process.cwd(),
        "migrations",
        "0012-graph-projection-delivery.sql",
      ),
      join(migrationRoot, "0012-graph-projection-delivery.sql"),
    );
    const graphUpgraded = new StorageDatabase({
      layout: prepareDataRoot(dataRoot),
      migrationsDir: migrationRoot,
      busyTimeoutMs: 5_000,
    });
    const graphHealth = graphUpgraded.health();
    expect(graphHealth.schema_version).toBe("0012");
    expect(graphHealth.counts.evidence_events).toBe(
      oldHealth.counts.evidence_events,
    );
    expect(
      graphUpgraded.projectionScopeFrontier({
        principal_id: "user_local",
        scope: { kind: "workspace", id: "workspace_local" },
      }),
    ).toEqual(storedFrontierBefore);
    expect(
      graphUpgraded.graphProjectionCheckpoint({
        principal_id: "user_local",
        scope: { kind: "workspace", id: "workspace_local" },
      }),
    ).toMatchObject({
      status: "disabled",
      frontier: null,
      logical_digest: null,
    });
    graphUpgraded.close();

    cpSync(
      join(
        process.cwd(),
        "migrations",
        "0013-vector-projection-delivery.sql",
      ),
      join(migrationRoot, "0013-vector-projection-delivery.sql"),
    );
    const vectorUpgraded = new StorageDatabase({
      layout: prepareDataRoot(dataRoot),
      migrationsDir: migrationRoot,
      busyTimeoutMs: 5_000,
    });
    const vectorHealth = vectorUpgraded.health();
    expect(vectorHealth.schema_version).toBe("0013");
    expect(vectorHealth.counts.evidence_events).toBe(
      oldHealth.counts.evidence_events,
    );
    expect(vectorUpgraded.vectorProjectionStatus()).toEqual({
      mode: "disabled",
      epoch_id: null,
      registered_epochs: 0,
      scope_states: 0,
      published_scopes: 0,
      pending_scopes: 0,
      degraded_scopes: 0,
      outbox_pending: 0,
      outbox_retrying: 0,
      outbox_terminal: 0,
      receipts: 0,
    });
    expect(
      vectorUpgraded.projectionScopeFrontier({
        principal_id: "user_local",
        scope: { kind: "workspace", id: "workspace_local" },
      }),
    ).toEqual(storedFrontierBefore);
    vectorUpgraded.close();

    const afterVectorMigration = new DatabaseSync(databasePath);
    expect(
      afterVectorMigration
        .prepare(
          `SELECT * FROM evidence_events
           WHERE evidence_id = 'evidence_before_scope_frontier_migration'`,
        )
        .get(),
    ).toEqual(canonicalRowBefore);
    expect(
      afterVectorMigration
        .prepare(
          `SELECT * FROM layered_projection_scope_state
           WHERE principal_id = 'user_local'
             AND scope_kind = 'workspace'
             AND scope_id = 'workspace_local'`,
        )
        .get(),
    ).toEqual(projectionRowBefore);
    afterVectorMigration.close();
  });

  it.each([
    ["relative path", "relative/data"],
    ["filesystem root", "/"],
    ["URL-like path", "file:///tmp/memo-graph"],
    ["removable volume", "/Volumes/memo-graph-untrusted"],
    [
      "cloud-synchronized path",
      "/Users/local/Library/CloudStorage/provider/memo-graph",
    ],
  ])("rejects an unsafe %s", async (_label, dataRoot) => {
    await expect(SqliteStorageClient.open({ dataRoot })).rejects.toMatchObject({
      code: "INVALID_DATA_ROOT",
    });
  });

  it("rejects a symlinked data root", async () => {
    const parent = temporaryRoot("symlink");
    const target = join(parent, "target");
    const link = join(parent, "link");
    mkdirSync(target);
    symlinkSync(target, link);

    await expect(SqliteStorageClient.open({ dataRoot: link })).rejects.toBeInstanceOf(
      StorageError,
    );
    await expect(SqliteStorageClient.open({ dataRoot: link })).rejects.toMatchObject({
      code: "INVALID_DATA_ROOT",
    });
  });

  it("fails closed when an applied migration changes", async () => {
    const dataRoot = temporaryRoot("drift");
    const migrationRoot = temporaryRoot("migrations");
    cpSync(join(process.cwd(), "migrations"), migrationRoot, {
      recursive: true,
    });

    const storage = await SqliteStorageClient.open({
      dataRoot,
      migrationsDir: migrationRoot,
    });
    await storage.close();

    const migration = join(migrationRoot, "0001-evidence-ledger.sql");
    writeFileSync(
      migration,
      `${readFileSync(migration, "utf8")}\n-- unexpected drift\n`,
      "utf8",
    );

    await expect(
      SqliteStorageClient.open({ dataRoot, migrationsDir: migrationRoot }),
    ).rejects.toMatchObject({
      code: "MIGRATION_DRIFT",
    });
  });
});
