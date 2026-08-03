import {
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteStorageClient } from "@memo-graph/storage-sqlite";

import { inlineEpisode } from "../helpers/storage-examples.js";

const cleanupPaths: string[] = [];

function temporaryRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "memo-graph-wal-recovery-")),
  );
  cleanupPaths.push(root);
  return join(root, "data");
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target !== undefined) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

describe("WAL checkpoint evidence", () => {
  it("reports a blocked checkpoint and converges after the long reader exits", async () => {
    const dataRoot = temporaryRoot();
    const databasePath = join(dataRoot, "ledger", "memory.db");
    const walPath = `${databasePath}-wal`;
    const storage = await SqliteStorageClient.open({ dataRoot });
    let reader: Database.Database | undefined;
    try {
      await storage.commitEpisode(
        inlineEpisode({
          episodeId: "episode_wal_1",
          evidenceId: "evidence_wal_1",
          idempotencyKey: "commit:wal:1",
        }),
      );
      await storage.checkpoint();
      await storage.drainFtsOutbox();
      reader = new Database(databasePath, {
        readonly: true,
        fileMustExist: true,
      });
      reader.exec("BEGIN");
      expect(
        reader.prepare("SELECT COUNT(*) AS count FROM evidence_fts").get(),
      ).toMatchObject({ count: 1 });

      for (let index = 2; index <= 5; index += 1) {
        await storage.commitEpisode(
          inlineEpisode({
            episodeId: `episode_wal_${index}`,
            evidenceId: `evidence_wal_${index}`,
            idempotencyKey: `commit:wal:${index}`,
          }),
        );
      }
      expect(statSync(walPath).size).toBeGreaterThan(0);
      expect(
        reader.prepare("SELECT COUNT(*) AS count FROM episodes").get(),
      ).toMatchObject({ count: 1 });

      const blocked = await storage.checkpoint();
      const blockedHealth = await storage.health();
      expect(blocked.busy).toBeGreaterThan(0);
      expect(blocked.log).toBeGreaterThan(blocked.checkpointed);
      expect(blockedHealth.checkpoint_counters).toMatchObject({
        busy: blocked.busy,
        log: blocked.log,
        checkpointed: blocked.checkpointed,
        attempts: 3,
      });

      reader.exec("COMMIT");
      reader.close();
      reader = undefined;

      const converged = await storage.checkpoint();
      expect(converged.busy).toBe(0);
      expect(converged.log).toBe(0);
      expect(converged.checkpointed).toBe(0);
      expect(statSync(walPath).size).toBe(0);
      expect((await storage.health()).checkpoint_counters).toMatchObject({
        busy: 0,
        attempts: 1,
      });
    } finally {
      if (reader !== undefined) {
        reader.exec("ROLLBACK");
        reader.close();
      }
      await storage.close();
    }
  });
});
