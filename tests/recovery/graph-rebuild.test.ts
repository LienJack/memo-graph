import {
  mkdtemp,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DeterministicGraphRebuilder,
  graphGlobalLogicalDigest,
  type GraphProcessHost,
} from "../../packages/graph-projection/src/index.js";
import {
  SqliteStorageClient,
} from "@memo-graph/storage-sqlite";

import {
  applyCompleteGraphProjectionFixture,
  installedGraphBackendIdentity,
} from "../helpers/graph-runtime-examples.js";

const roots: string[] = [];
const hosts: GraphProcessHost[] = [];
const childEntry = new URL(
  "../../packages/graph-projection/dist/ladybug-process.js",
  import.meta.url,
);

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "memo-graph-u6-full-rebuild-"),
  );
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.allSettled(hosts.splice(0).map((host) => host.close()));
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

describe("graph deletion and rebuild", () => {
  it("rebuilds from SQLite after complete graph-file deletion without changing authority", async () => {
    const dataRoot = await temporaryRoot();
    const storage = await SqliteStorageClient.open({ dataRoot });
    const identity = await installedGraphBackendIdentity();
    try {
      await applyCompleteGraphProjectionFixture(storage);
      const expected = (
        await storage.listGraphProjectionSnapshots()
      ).snapshots;
      const expectedDigest = graphGlobalLogicalDigest(expected);
      const first = await new DeterministicGraphRebuilder({
        storage,
        dataRoot,
        expectedIdentity: identity,
        workerId: "graph_u6_rebuild_before_delete",
        clock: () => new Date("2026-07-29T10:10:00.000Z"),
        hostOptions: { childEntry, writeTimeoutMs: 10_000 },
      }).rebuild();
      hosts.push(first.store as GraphProcessHost);
      await first.store.close();

      await rm(join(dataRoot, "derived", "graph"), {
        recursive: true,
        force: true,
      });
      await storage.markGraphRestoreUnavailable({
        restored_at: "2026-07-29T10:11:00.000Z",
      });
      await expect(storage.health()).resolves.toMatchObject({
        schema_version: "0012",
        journal_mode: "wal",
      });

      const rebuilt = await new DeterministicGraphRebuilder({
        storage,
        dataRoot,
        expectedIdentity: identity,
        workerId: "graph_u6_rebuild_after_delete",
        clock: () => new Date("2026-07-29T10:12:00.000Z"),
        hostOptions: { childEntry, writeTimeoutMs: 10_000 },
      }).rebuild();
      hosts.push(rebuilt.store as GraphProcessHost);
      expect(rebuilt.global_logical_digest).toBe(expectedDigest);
      expect(rebuilt.scope_count).toBe(expected.length);
      expect(
        graphGlobalLogicalDigest(
          (await storage.listGraphProjectionSnapshots()).snapshots,
        ),
      ).toBe(expectedDigest);
    } finally {
      await storage.close();
    }
  }, 30_000);
});
