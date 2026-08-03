import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import { inlineEpisode } from "../helpers/storage-examples.js";
import { testProviderForDataRoot } from "../setup/recovery-provider.js";

const cleanupPaths: string[] = [];

function temporaryRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "memo-graph-restart-")),
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

describe("writer restart", () => {
  it("returns the durable receipt after a crash between commit and response", async () => {
    const dataRoot = temporaryRoot();
    const storage = await SqliteStorageClient.open({
      dataRoot,
      testFaults: {
        exitAfterCommitBeforeResponseOnce: true,
      },
    });
    const recoveryProvider = testProviderForDataRoot(dataRoot);
    const generationBefore =
      recoveryProvider.readCurrent()?.payload.generation ?? 0;
    const command = inlineEpisode({});

    await expect(storage.commitEpisode(command)).rejects.toMatchObject({
      code: "WORKER_CRASHED",
    });

    const recovered = await storage.commitEpisode(command);
    const repeated = await storage.commitEpisode(command);
    const health = await storage.health();

    expect(recovered).toEqual(repeated);
    expect(health.counts).toMatchObject({
      episodes: 1,
      evidence_events: 1,
      mutation_receipts: 1,
      idempotency_keys: 1,
    });
    expect(recoveryProvider.readCurrent()?.payload.generation).toBe(
      generationBefore + 1,
    );
    await storage.close();

    const database = new DatabaseSync(
      join(dataRoot, "ledger", "memory.db"),
      { readOnly: true },
    );
    expect(
      (
        database
          .prepare(
            "SELECT count(*) AS count FROM recovery_anchored_effects",
          )
          .get() as { count: number }
      ).count,
    ).toBe(1);
    database.close();
  });

  it("late-replays A after B without another recovery effect or head advance", async () => {
    const dataRoot = temporaryRoot();
    const storage = await SqliteStorageClient.open({ dataRoot });
    const recoveryProvider = testProviderForDataRoot(dataRoot);
    const commandA = inlineEpisode({
      episodeId: "episode_replay_a",
      evidenceId: "evidence_replay_a",
      idempotencyKey: "commit:late-replay:a",
    });
    const commandB = inlineEpisode({
      episodeId: "episode_replay_b",
      evidenceId: "evidence_replay_b",
      idempotencyKey: "commit:late-replay:b",
    });
    const firstA = await storage.commitEpisode(commandA);
    await storage.commitEpisode(commandB);
    const generationAfterB =
      recoveryProvider.readCurrent()?.payload.generation;
    const replayA = await storage.commitEpisode(commandA);
    expect(replayA).toEqual(firstA);
    expect(recoveryProvider.readCurrent()?.payload.generation).toBe(
      generationAfterB,
    );
    await storage.close();

    const database = new DatabaseSync(
      join(dataRoot, "ledger", "memory.db"),
      { readOnly: true },
    );
    expect(
      (
        database
          .prepare(
            "SELECT count(*) AS count FROM recovery_anchored_effects",
          )
          .get() as { count: number }
      ).count,
    ).toBe(2);
    database.close();
  });
});
