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

import { afterEach, describe, expect, it } from "vitest";

import {
  SqliteStorageClient,
  StorageError,
} from "@memo-graph/storage-sqlite";
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

    expect(health.schema_version).toBe("0011");
    expect(health.journal_mode).toBe("wal");
    expect(health.foreign_keys).toBe(true);
    expect(health.migrations).toHaveLength(11);
    expect(health.migrations.every((migration) =>
      /^sha256:[a-f0-9]{64}$/.test(migration.hash),
    )).toBe(true);
    expect(statSync(dataRoot).mode & 0o777).toBe(0o700);
    expect(statSync(join(dataRoot, "ledger", "memory.db")).mode & 0o777).toBe(
      0o600,
    );
  });

  it("adds scope frontier state after 0010 without fabricating populated rows", async () => {
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

    const before = await SqliteStorageClient.open({
      dataRoot,
      migrationsDir: migrationRoot,
    });
    await before.commitEpisode(
      inlineEpisode({
        episodeId: "episode_before_scope_frontier_migration",
        evidenceId: "evidence_before_scope_frontier_migration",
        idempotencyKey: "commit:before:scope-frontier:0001",
        text: "The ledger was populated before migration 0011.",
      }),
    );
    expect((await before.health()).schema_version).toBe("0010");
    await before.close();

    cpSync(
      join(
        process.cwd(),
        "migrations",
        "0011-scope-projection-frontiers.sql",
      ),
      join(migrationRoot, "0011-scope-projection-frontiers.sql"),
    );
    const upgraded = await SqliteStorageClient.open({
      dataRoot,
      migrationsDir: migrationRoot,
    });
    expect((await upgraded.health()).schema_version).toBe("0011");
    expect(
      await upgraded.projectionScopeFrontier({
        principal_id: "user_local",
        scope: { kind: "workspace", id: "workspace_local" },
      }),
    ).toMatchObject({
      status: "pending",
      projection_epoch: 0,
      source_frontier_hash: null,
      projection_frontier_hash: null,
    });
    await upgraded.close();
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
