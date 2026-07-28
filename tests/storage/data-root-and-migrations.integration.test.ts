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

    expect(health.schema_version).toBe("0009");
    expect(health.journal_mode).toBe("wal");
    expect(health.foreign_keys).toBe(true);
    expect(health.migrations).toHaveLength(9);
    expect(health.migrations.every((migration) =>
      /^sha256:[a-f0-9]{64}$/.test(migration.hash),
    )).toBe(true);
    expect(statSync(dataRoot).mode & 0o777).toBe(0o700);
    expect(statSync(join(dataRoot, "ledger", "memory.db")).mode & 0o777).toBe(
      0o600,
    );
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
