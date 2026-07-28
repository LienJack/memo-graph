import {
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  SqliteStorageClient,
  restoreBackupToEmptyDataRoot,
} from "@memo-graph/storage-sqlite";
import { blobEpisode, inlineEpisode } from "../helpers/storage-examples.js";

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

describe("FTS projection and backup", () => {
  it("degrades while pending, then searches within the exact scope", async () => {
    const dataRoot = temporaryRoot("fts");
    const storage = await SqliteStorageClient.open({ dataRoot });
    await storage.commitEpisode(
      inlineEpisode({ text: "Governed context survives later sessions." }),
    );

    const pending = await storage.searchEvidence({
      query: "governed",
      principal_id: "user_local",
      scope: { kind: "workspace", id: "workspace_local" },
      limit: 10,
    });
    expect(pending).toMatchObject({
      status: "DEGRADED",
      reason_code: "FTS_PENDING",
    });

    expect(await storage.drainFtsOutbox()).toMatchObject({
      processed: 1,
      failed: 0,
    });

    const found = await storage.searchEvidence({
      query: "governed",
      principal_id: "user_local",
      scope: { kind: "workspace", id: "workspace_local" },
      limit: 10,
    });
    const excluded = await storage.searchEvidence({
      query: "governed",
      principal_id: "user_local",
      scope: { kind: "workspace", id: "different_workspace" },
      limit: 10,
    });
    const excludedPrincipal = await storage.searchEvidence({
      query: "governed",
      principal_id: "another_user",
      scope: { kind: "workspace", id: "workspace_local" },
      limit: 10,
    });

    expect(found.status).toBe("OK");
    expect(found.items.map((item) => item.evidence_id)).toEqual([
      "evidence_storage_1",
    ]);
    expect(excluded).toMatchObject({ status: "NO_MATCH", items: [] });
    expect(excludedPrincipal).toMatchObject({
      status: "NO_MATCH",
      items: [],
    });
    await storage.close();
  });

  it("rebuilds FTS without changing the canonical frontier", async () => {
    const dataRoot = temporaryRoot("rebuild");
    const storage = await SqliteStorageClient.open({ dataRoot });
    await storage.commitEpisode(inlineEpisode({}));
    await storage.drainFtsOutbox();
    const before = await storage.health();

    const rebuilt = await storage.rebuildFts();
    const after = await storage.health();

    expect(rebuilt.indexed).toBe(1);
    expect(after.ledger_epoch).toBe(before.ledger_epoch);
    expect(after.counts.evidence_events).toBe(before.counts.evidence_events);
    await storage.close();
  });

  it("reports a missing FTS projection as degraded and rebuilds it", async () => {
    const dataRoot = temporaryRoot("missing-fts");
    const storage = await SqliteStorageClient.open({ dataRoot });
    await storage.commitEpisode(inlineEpisode({}));
    await storage.drainFtsOutbox();
    await storage.close();

    const database = new DatabaseSync(
      join(dataRoot, "ledger", "memory.db"),
    );
    database.exec("DROP TABLE evidence_fts");
    database.close();

    const reopened = await SqliteStorageClient.open({ dataRoot });
    await expect(
      reopened.searchEvidence({
        query: "governed",
        principal_id: "user_local",
        scope: { kind: "workspace", id: "workspace_local" },
        limit: 10,
      }),
    ).resolves.toMatchObject({
      status: "DEGRADED",
      reason_code: "FTS_UNAVAILABLE",
    });
    await expect(reopened.rebuildFts()).resolves.toMatchObject({ indexed: 1 });
    await expect(
      reopened.searchEvidence({
        query: "governed",
        principal_id: "user_local",
        scope: { kind: "workspace", id: "workspace_local" },
        limit: 10,
      }),
    ).resolves.toMatchObject({ status: "OK" });
    await reopened.close();
  });

  it("runs an explicit bounded checkpoint", async () => {
    const dataRoot = temporaryRoot("checkpoint");
    const storage = await SqliteStorageClient.open({ dataRoot });
    await storage.commitEpisode(inlineEpisode({}));
    await expect(storage.checkpoint()).resolves.toMatchObject({
      busy: 0,
    });
    await storage.close();
  });

  it("keeps the caller event loop responsive during blocking worker work", async () => {
    const dataRoot = temporaryRoot("worker");
    const storage = await SqliteStorageClient.open({
      dataRoot,
      testOperations: true,
    });
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 10);

    await storage.blockWorkerForTest(160);
    clearInterval(timer);

    expect(ticks).toBeGreaterThanOrEqual(5);
    await storage.close();
  });

  it("backs up SQLite and blobs and restores them to an empty data root", async () => {
    const dataRoot = temporaryRoot("backup");
    const restoreParent = temporaryRoot("restore-parent");
    const restoredRoot = join(restoreParent, "restored");
    const storage = await SqliteStorageClient.open({ dataRoot });
    const receipt = await storage.commitEpisode(
      blobEpisode({
        bytes: new TextEncoder().encode("artifact included in backup"),
      }),
    );
    const backup = await storage.createBackup();
    await storage.close();
    const restored = await restoreBackupToEmptyDataRoot({
      backup,
      dataRoot: restoredRoot,
      minimumTombstoneEpoch: 0,
    });

    expect(backup.integrity_check).toBe("ok");
    expect(backup.ledger_epoch).toBe(receipt.resulting_epoch);
    expect(backup.tombstone_epoch).toBe(0);
    expect(backup.latest_receipt_hash).toBe(receipt.receipt_hash);
    expect(backup.blob_hashes).toHaveLength(1);
    expect(statSync(backup.path).mode & 0o777).toBe(0o600);
    expect(restored.health.ledger_epoch).toBe(receipt.resulting_epoch);
    expect(restored.health.counts.evidence_events).toBe(1);
    expect(restored.verified_blobs).toBe(1);
    expect(restored.verification).toMatchObject({
      integrity_check: "ok",
      foreign_key_violations: 0,
      incomplete_purge_jobs: 0,
    });
  });

  it("never emits content or search queries in diagnostics", async () => {
    const dataRoot = temporaryRoot("diagnostics");
    const diagnostics: unknown[] = [];
    const secret = "do-not-log-this-memory-content";
    const query = "do-not-log-this-query";
    const storage = await SqliteStorageClient.open({
      dataRoot,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    await storage.commitEpisode(inlineEpisode({ text: secret }));
    await storage.searchEvidence({
      query,
      principal_id: "user_local",
      scope: { kind: "workspace", id: "workspace_local" },
      limit: 10,
    });
    await storage.close();

    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(query);
    expect(serialized).toContain("commit_episode");
    expect(serialized).toContain("search_evidence");
  });
});
