import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

let temporaryDirectory: string | undefined;

afterEach(async () => {
  if (temporaryDirectory !== undefined) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

describe("better-sqlite3 compatibility probe", () => {
  it("supports WAL, FTS5, transactions, prepared statements, and backup", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "memo-graph-m0-"));
    const databasePath = join(temporaryDirectory, "probe.db");
    const backupPath = join(temporaryDirectory, "probe.backup.db");
    const database = new Database(databasePath);

    try {
      expect(database.pragma("journal_mode = WAL", { simple: true })).toBe(
        "wal",
      );
      const compileOptions = database.pragma("compile_options") as Array<{
        compile_options: string;
      }>;
      expect(
        compileOptions.some(({ compile_options }) =>
          compile_options.includes("ENABLE_FTS5"),
        ),
      ).toBe(true);

      database.exec(`
        CREATE TABLE memory_probe (
          id INTEGER PRIMARY KEY,
          content TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE memory_probe_fts USING fts5(content);
      `);
      const insert = database.prepare(
        "INSERT INTO memory_probe (content) VALUES (?)",
      );
      const insertFts = database.prepare(
        "INSERT INTO memory_probe_fts (content) VALUES (?)",
      );
      const write = database.transaction((content: string) => {
        insert.run(content);
        insertFts.run(content);
      });

      write("governed memory");
      expect(
        database
          .prepare(
            "SELECT content FROM memory_probe_fts WHERE memory_probe_fts MATCH ?",
          )
          .get("governed") as { content: string },
      ).toEqual({ content: "governed memory" });

      const failingWrite = database.transaction(() => {
        insert.run("must roll back");
        throw new Error("probe rollback");
      });
      expect(failingWrite).toThrow("probe rollback");
      expect(
        database.prepare("SELECT count(*) AS count FROM memory_probe").get(),
      ).toEqual({ count: 1 });

      await database.backup(backupPath);
      const backup = new Database(backupPath, { readonly: true });
      try {
        expect(
          backup.prepare("SELECT content FROM memory_probe").all(),
        ).toEqual([{ content: "governed memory" }]);
      } finally {
        backup.close();
      }
    } finally {
      database.close();
    }
  });
});
