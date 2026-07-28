import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import { inlineEpisode } from "../helpers/storage-examples.js";

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
    await storage.close();
  });
});
