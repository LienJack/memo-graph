import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  SqliteStorageClient,
} from "@memo-graph/storage-sqlite";
import {
  blobEpisode,
  inlineEpisode,
  resealEpisode,
} from "../helpers/storage-examples.js";

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

describe("authoritative evidence ledger", () => {
  it("commits one sealed episode and returns the identical durable receipt", async () => {
    const dataRoot = temporaryRoot("commit");
    const storage = await SqliteStorageClient.open({ dataRoot });
    const command = inlineEpisode({});

    const first = await storage.commitEpisode(command);
    const second = await storage.commitEpisode(command);
    const health = await storage.health();
    await storage.close();

    expect(first).toEqual(second);
    expect(first.state).toBe("projection_pending");
    expect(first.resulting_epoch).toBe(1);
    expect(first.projection_jobs).toHaveLength(1);
    expect(health.counts).toMatchObject({
      episodes: 1,
      evidence_events: 1,
      mutation_receipts: 1,
      idempotency_keys: 1,
    });
  });

  it("rejects an idempotency key reused with different content", async () => {
    const dataRoot = temporaryRoot("conflict");
    const storage = await SqliteStorageClient.open({ dataRoot });
    const first = inlineEpisode({ idempotencyKey: "commit:shared:0001" });
    const changed = inlineEpisode({
      episodeId: "episode_storage_2",
      evidenceId: "evidence_storage_2",
      idempotencyKey: "commit:shared:0001",
      text: "Different content must not reuse an idempotency key.",
    });

    await storage.commitEpisode(first);
    await expect(storage.commitEpisode(changed)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await storage.close();
  });

  it("serializes concurrent commits through one writer", async () => {
    const dataRoot = temporaryRoot("queue");
    const storage = await SqliteStorageClient.open({ dataRoot });
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        storage.commitEpisode(
          inlineEpisode({
            episodeId: `episode_queue_${index}`,
            evidenceId: `evidence_queue_${index}`,
            idempotencyKey: `commit:queue:${index}`,
            text: `Queued evidence ${index}`,
          }),
        ),
      ),
    );

    const health = await storage.health();
    expect(health.ledger_epoch).toBe(20);
    expect(health.counts.episodes).toBe(20);
    expect(health.writer_queue.completed).toBe(20);
    await storage.close();
  });

  it("maps busy writer contention to a retryable storage error", async () => {
    const dataRoot = temporaryRoot("busy");
    const lockOwner = await SqliteStorageClient.open({
      dataRoot,
      testOperations: true,
    });
    const storage = await SqliteStorageClient.open({
      dataRoot,
      busyTimeoutMs: 30,
      testOperations: true,
    });
    const held = lockOwner.holdWriteLockForTest(180);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const pending = storage.commitEpisode(inlineEpisode({}));

    await expect(pending).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
      retryable: true,
    });
    await held;

    await expect(storage.commitEpisode(inlineEpisode({}))).resolves.toMatchObject({
      resulting_epoch: 1,
    });
    await lockOwner.close();
    await storage.close();
  });

  it("rejects invalid content and episode seals before mutation", async () => {
    const dataRoot = temporaryRoot("hashes");
    const storage = await SqliteStorageClient.open({ dataRoot });
    const command = inlineEpisode({});
    const changedEvidence = {
      ...command,
      evidence: [
        {
          ...command.evidence[0],
          content_hash: `sha256:${"a".repeat(64)}`,
        },
      ],
    };
    const changedEpisode = {
      ...command,
      idempotencyKey: "commit:changed-seal:0001",
      episode: resealEpisode({
        ...command.episode,
        event_ids: ["missing_evidence"],
      }),
    };

    await expect(storage.commitEpisode(changedEvidence)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(storage.commitEpisode(changedEpisode)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect((await storage.health()).counts.evidence_events).toBe(0);
    await storage.close();
  });

  it("rejects secret evidence until application encryption exists", async () => {
    const dataRoot = temporaryRoot("secret");
    const storage = await SqliteStorageClient.open({ dataRoot });
    const command = inlineEpisode({});
    const secret = {
      ...command,
      evidence: command.evidence.map((record) => ({
        ...record,
        sensitivity: "secret",
      })),
    };

    await expect(storage.commitEpisode(secret)).rejects.toMatchObject({
      code: "ENCRYPTION_REQUIRED",
    });
    expect((await storage.health()).ledger_epoch).toBe(0);
    await storage.close();
  });

  it("enforces append-only canonical tables inside SQLite", async () => {
    const dataRoot = temporaryRoot("append-only");
    const storage = await SqliteStorageClient.open({ dataRoot });
    await storage.commitEpisode(inlineEpisode({}));
    await storage.close();

    const database = new DatabaseSync(join(dataRoot, "ledger", "memory.db"));
    expect(() =>
      database.exec(
        "UPDATE evidence_events SET source = 'import' WHERE evidence_id = 'evidence_storage_1'",
      ),
    ).toThrow(/APPEND_ONLY/);
    expect(() =>
      database.exec(
        "DELETE FROM episodes WHERE episode_id = 'episode_storage_1'",
      ),
    ).toThrow(/APPEND_ONLY/);
    database.close();
  });

  it("writes verified content-addressed blobs and detects corruption", async () => {
    const dataRoot = temporaryRoot("blob");
    const bytes = new TextEncoder().encode("binary artifact payload");
    const command = blobEpisode({ bytes });

    const storage = await SqliteStorageClient.open({ dataRoot });
    await storage.commitEpisode(command);
    await storage.close();

    const digest = command.blobs[0]?.content_hash.slice("sha256:".length);
    expect(digest).toBeDefined();
    const blobPath = join(dataRoot, "blobs", digest as string);
    expect(readFileSync(blobPath)).toEqual(Buffer.from(bytes));
    expect(statMode(blobPath)).toBe(0o600);

    writeFileSync(blobPath, "corrupt", "utf8");

    const reopened = await SqliteStorageClient.open({ dataRoot });
    await expect(
      reopened.commitEpisode({
        ...command,
        idempotencyKey: "commit:blob-corruption:0002",
        episode: resealEpisode({
          ...command.episode,
          episode_id: "episode_blob_2",
        }),
      }),
    ).rejects.toMatchObject({
      code: "CORRUPTION",
    });
    await reopened.close();
  });
});

function statMode(path: string): number {
  return statSync(path).mode & 0o777;
}
