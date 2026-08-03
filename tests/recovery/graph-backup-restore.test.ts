import {
  cp,
  mkdtemp,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DeterministicGraphRebuilder,
  readActiveGraphGeneration,
  type GraphProcessHost,
} from "../../packages/graph-projection/src/index.js";
import { ScopeSchema } from "../../packages/contracts/src/index.js";
import {
  SqliteStorageClient,
  restoreBackupToEmptyDataRoot,
} from "@memo-graph/storage-sqlite";
import {
  applyCompleteGraphProjectionFixture,
  installedGraphBackendIdentity,
} from "../helpers/graph-runtime-examples.js";
import { testRecoveryHeadProvider } from "../helpers/recovery.js";
import {
  projectionFrontier,
} from "../helpers/projection-examples.js";

const roots: string[] = [];
const hosts: GraphProcessHost[] = [];
const childEntry = new URL(
  "../../packages/graph-projection/dist/ladybug-process.js",
  import.meta.url,
);
const MAIN_SCOPE = ScopeSchema.parse({
  kind: "workspace",
  id: "workspace_local",
});

afterEach(async () => {
  await Promise.allSettled(hosts.splice(0).map((host) => host.close()));
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), `memo-graph-${prefix}-`),
  );
  roots.push(root);
  return root;
}

describe("graph backup and restore", () => {
  it("rejects a stale graph copy until restored SQLite is rebuilt and reverified", async () => {
    const sourceRoot = await temporaryRoot("u4-backup-source");
    const recoveryHeadProvider = testRecoveryHeadProvider();
    const identity = await installedGraphBackendIdentity();
    const sourceStorage = await SqliteStorageClient.open({
      dataRoot: sourceRoot,
      recoveryHeadProvider,
    });
    const fixture =
      await applyCompleteGraphProjectionFixture(sourceStorage);
    const sourceRebuild = await new DeterministicGraphRebuilder({
      storage: sourceStorage,
      dataRoot: sourceRoot,
      expectedIdentity: identity,
      workerId: "graph_u4_backup_source_rebuilder",
      clock: () => new Date("2026-07-29T06:30:00.000Z"),
      hostOptions: { childEntry, writeTimeoutMs: 10_000 },
    }).rebuild();
    hosts.push(sourceRebuild.store as GraphProcessHost);
    const staleManifest = await readActiveGraphGeneration(sourceRoot);
    const backup = await sourceStorage.createBackup();
    await sourceRebuild.store.close();
    await sourceStorage.close();

    const restoreParent = await temporaryRoot("u4-backup-target");
    const restoredRoot = join(restoreParent, "restored");
    await restoreBackupToEmptyDataRoot({
      backup,
      dataRoot: restoredRoot,
      recoveryHeadProvider,
    });
    await cp(
      join(sourceRoot, "derived", "graph"),
      join(restoredRoot, "derived", "graph"),
      { recursive: true, force: true },
    );

    const restored = await SqliteStorageClient.open({
      dataRoot: restoredRoot,
      recoveryHeadProvider,
    });
    try {
      await expect(
        restored.graphProjectionCheckpoint({
          principal_id: "user_local",
          scope: { kind: "workspace", id: "workspace_local" },
        }),
      ).resolves.toMatchObject({
        status: "unavailable",
        logical_digest: null,
        backend_identity: null,
      });
      expect(await readActiveGraphGeneration(restoredRoot)).toEqual(
        staleManifest,
      );

      const health = await restored.health();
      const currentFrontier = projectionFrontier({
        ledgerEpoch: health.ledger_epoch,
        tombstoneEpoch: health.tombstone_epoch,
        projectionEpoch:
          health.projection_frontier.projection_epoch + 1,
      });
      const relation = fixture.projections.find(
        (projection) => projection.projection_type === "relation",
      );
      if (relation === undefined) {
        throw new Error("restore fixture relation is missing");
      }
      await restored.applyProjectionBatch({
        principal_id: "user_local",
        scope: { kind: "workspace", id: "workspace_local" },
        idempotency_key: "graph-restored-remove-stale-relation-0001",
        expected_projection_epoch:
          health.projection_frontier.projection_epoch,
        frontier: currentFrontier,
        projections: [],
        retire_projection_revision_ids: [
          relation.projection_revision_id,
        ],
        applied_at: "2026-07-29T06:40:00.000Z",
      });

      const restoredRebuild = await new DeterministicGraphRebuilder({
        storage: restored,
        dataRoot: restoredRoot,
        expectedIdentity: identity,
        workerId: "graph_u4_restored_rebuilder",
        clock: () => new Date("2026-07-29T06:45:00.000Z"),
        hostOptions: { childEntry, writeTimeoutMs: 10_000 },
      }).rebuild();
      hosts.push(restoredRebuild.store as GraphProcessHost);
      expect(restoredRebuild.generation_id).not.toBe(
        staleManifest?.generation_id,
      );
      const snapshot = await restoredRebuild.store.readScopeSnapshot({
        principal_id: "user_local",
        scope: MAIN_SCOPE,
      });
      expect(snapshot?.edges).toEqual([]);
      const canonical = (
        await restored.listGraphProjectionSnapshots()
      ).snapshots[0];
      expect(snapshot).toEqual(canonical);
      await expect(
        restored.graphProjectionCheckpoint({
          principal_id: "user_local",
          scope: { kind: "workspace", id: "workspace_local" },
        }),
      ).resolves.toMatchObject({
        status: "ready",
        logical_digest: canonical?.logical_digest,
        backend_identity: identity,
      });
    } finally {
      await restored.close();
    }
  }, 30_000);
});
