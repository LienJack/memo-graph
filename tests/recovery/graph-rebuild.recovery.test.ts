import {
  readFile,
  writeFile,
  mkdtemp,
  realpath,
  rm,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildGraphScopeSnapshot,
} from "../../packages/contracts/src/index.js";
import {
  DeterministicGraphRebuilder,
  GraphProcessHost,
  graphGlobalLogicalDigest,
  prepareGraphDatabasePath,
  quarantineGraphGeneration,
  readActiveGraphGeneration,
} from "../../packages/graph-projection/src/index.js";
import {
  SqliteStorageClient,
} from "@memo-graph/storage-sqlite";
import {
  applyCompleteGraphProjectionFixture,
  installedGraphBackendIdentity,
} from "../helpers/graph-runtime-examples.js";
import {
  projectionFrontier,
} from "../helpers/projection-examples.js";

const roots: string[] = [];
const hosts: GraphProcessHost[] = [];
const childEntry = new URL(
  "../../packages/graph-projection/dist/ladybug-process.js",
  import.meta.url,
);

afterEach(async () => {
  await Promise.allSettled(hosts.splice(0).map((host) => host.close()));
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "memo-graph-u4-rebuild-"),
  );
  roots.push(root);
  return root;
}

async function projectedStorage(dataRoot: string) {
  const storage = await SqliteStorageClient.open({ dataRoot });
  await applyCompleteGraphProjectionFixture(storage);
  const health = await storage.health();
  const otherFrontier = projectionFrontier({
    ledgerEpoch: health.ledger_epoch,
    tombstoneEpoch: health.tombstone_epoch,
    projectionEpoch: health.projection_frontier.projection_epoch + 1,
  });
  await storage.applyProjectionBatch({
    principal_id: "user_local",
    scope: { kind: "workspace", id: "workspace_other" },
    idempotency_key: "graph-rebuild-other-scope-0001",
    expected_projection_epoch:
      health.projection_frontier.projection_epoch,
    frontier: otherFrontier,
    projections: [],
    applied_at: "2026-07-29T05:30:00.000Z",
  });
  return storage;
}

async function physicalGraphHash(databasePath: string): Promise<string> {
  const hash = createHash("sha256");
  for (const path of [databasePath, `${databasePath}.wal`]) {
    try {
      hash.update(await readFile(path));
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
  }
  return `sha256:${hash.digest("hex")}`;
}

describe("deterministic graph rebuild", () => {
  it("builds a fresh generation, reopens it, and publishes exact ready checkpoints", async () => {
    const dataRoot = await temporaryRoot();
    const storage = await projectedStorage(dataRoot);
    const identity = await installedGraphBackendIdentity();
    try {
      const expected = (
        await storage.listGraphProjectionSnapshots()
      ).snapshots;
      const rebuilder = new DeterministicGraphRebuilder({
        storage,
        dataRoot,
        expectedIdentity: identity,
        workerId: "graph_u4_rebuilder",
        clock: () => new Date("2026-07-29T06:00:00.000Z"),
        hostOptions: {
          childEntry,
          requestTimeoutMs: 1_000,
          writeTimeoutMs: 10_000,
        },
      });
      const rebuilt = await rebuilder.rebuild();
      hosts.push(rebuilt.store as GraphProcessHost);
      expect(rebuilt.scope_count).toBe(2);
      expect(rebuilt.receipt_ids).toHaveLength(2);
      expect(rebuilt.global_logical_digest).toBe(
        graphGlobalLogicalDigest(expected),
      );
      expect(await readActiveGraphGeneration(dataRoot)).toEqual(
        rebuilt.manifest,
      );
      expect(
        (await prepareGraphDatabasePath(dataRoot)).generationId,
      ).toBe(rebuilt.generation_id);

      for (const snapshot of expected) {
        expect(
          await rebuilt.store.readScopeSnapshot({
            principal_id: snapshot.principal_id,
            scope: snapshot.scope,
          }),
        ).toEqual(snapshot);
        await expect(
          storage.graphProjectionCheckpoint({
            principal_id: snapshot.principal_id,
            scope: snapshot.scope,
          }),
        ).resolves.toMatchObject({
          status: "ready",
          logical_digest: snapshot.logical_digest,
          backend_identity: identity,
        });
      }

      await rebuilt.store.close();
      const reopened = await GraphProcessHost.open({
        dataRoot,
        expectedIdentity: identity,
        childEntry,
        requestTimeoutMs: 1_000,
        writeTimeoutMs: 10_000,
      });
      hosts.push(reopened);
      const reopenedSnapshots = [];
      for (const snapshot of [...expected].reverse()) {
        const readBack = await reopened.readScopeSnapshot({
          principal_id: snapshot.principal_id,
          scope: snapshot.scope,
        });
        expect(readBack).not.toBeNull();
        reopenedSnapshots.push(readBack);
      }
      expect(graphGlobalLogicalDigest(reopenedSnapshots)).toBe(
        rebuilt.global_logical_digest,
      );
    } finally {
      await storage.close();
    }
  }, 30_000);

  it("keeps the prior generation active and quarantines a failed target", async () => {
    const dataRoot = await temporaryRoot();
    const storage = await projectedStorage(dataRoot);
    const identity = await installedGraphBackendIdentity();
    try {
      const first = await new DeterministicGraphRebuilder({
        storage,
        dataRoot,
        expectedIdentity: identity,
        workerId: "graph_u4_first_rebuilder",
        clock: () => new Date("2026-07-29T06:10:00.000Z"),
        hostOptions: { childEntry, writeTimeoutMs: 10_000 },
      }).rebuild();
      hosts.push(first.store as GraphProcessHost);
      await first.store.close();
      const manifestBefore = await readActiveGraphGeneration(dataRoot);

      const invalidIdentity = {
        ...identity,
        storage_version: "999",
      };
      await expect(
        new DeterministicGraphRebuilder({
          storage,
          dataRoot,
          expectedIdentity: invalidIdentity,
          workerId: "graph_u4_failed_rebuilder",
          clock: () => new Date("2026-07-29T06:20:00.000Z"),
          hostOptions: {
            childEntry,
            startupTimeoutMs: 2_000,
          },
        }).rebuild(),
      ).rejects.toBeDefined();
      expect(await readActiveGraphGeneration(dataRoot)).toEqual(
        manifestBefore,
      );
      const checkpoint = await storage.graphProjectionCheckpoint({
        principal_id: "user_local",
        scope: { kind: "workspace", id: "workspace_local" },
      });
      expect(checkpoint).toMatchObject({
        status: "unavailable",
        logical_digest: null,
        backend_identity: null,
      });
    } finally {
      await storage.close();
    }
  }, 30_000);

  it("keeps logical equality independent of scope insertion order and physical bytes", async () => {
    const dataRoot = await temporaryRoot();
    const storage = await projectedStorage(dataRoot);
    const identity = await installedGraphBackendIdentity();
    try {
      const snapshots = (
        await storage.listGraphProjectionSnapshots()
      ).snapshots;
      const forward = await GraphProcessHost.open({
        dataRoot,
        generationId: "order-forward",
        expectedIdentity: identity,
        childEntry,
        writeTimeoutMs: 10_000,
      });
      hosts.push(forward);
      for (const snapshot of snapshots) {
        await forward.replaceScope(snapshot);
      }
      const forwardPath = forward.pathLayout().databasePath;
      await forward.close();

      const reverse = await GraphProcessHost.open({
        dataRoot,
        generationId: "order-reverse",
        expectedIdentity: identity,
        childEntry,
        writeTimeoutMs: 10_000,
      });
      hosts.push(reverse);
      for (const snapshot of [...snapshots].reverse()) {
        await reverse.replaceScope(snapshot);
      }
      const reversePath = reverse.pathLayout().databasePath;
      await reverse.close();

      expect(graphGlobalLogicalDigest(snapshots)).toBe(
        graphGlobalLogicalDigest([...snapshots].reverse()),
      );
      expect(await physicalGraphHash(forwardPath)).not.toBe(
        await physicalGraphHash(reversePath),
      );
    } finally {
      await storage.close();
    }
  }, 30_000);

  it("never publishes a candidate that fails corruption reopen verification", async () => {
    const dataRoot = await temporaryRoot();
    const storage = await projectedStorage(dataRoot);
    const identity = await installedGraphBackendIdentity();
    try {
      const active = await new DeterministicGraphRebuilder({
        storage,
        dataRoot,
        expectedIdentity: identity,
        workerId: "graph_u4_corruption_baseline",
        clock: () => new Date("2026-07-29T06:50:00.000Z"),
        hostOptions: { childEntry, writeTimeoutMs: 10_000 },
      }).rebuild();
      hosts.push(active.store as GraphProcessHost);
      await active.store.close();
      const manifestBefore = await readActiveGraphGeneration(dataRoot);
      const snapshots = (
        await storage.listGraphProjectionSnapshots()
      ).snapshots;

      const candidate = await GraphProcessHost.open({
        dataRoot,
        generationId: "corrupt-candidate",
        expectedIdentity: identity,
        childEntry,
        writeTimeoutMs: 10_000,
      });
      hosts.push(candidate);
      for (const snapshot of snapshots) {
        await candidate.replaceScope(snapshot);
      }
      const candidatePath = candidate.pathLayout().databasePath;
      await candidate.close();
      await writeFile(candidatePath, "corrupt graph candidate", "utf8");
      await expect(
        GraphProcessHost.open({
          dataRoot,
          generationId: "corrupt-candidate",
          expectedIdentity: identity,
          childEntry,
          startupTimeoutMs: 2_000,
        }),
      ).rejects.toBeDefined();
      await quarantineGraphGeneration({
        dataRoot,
        generationId: "corrupt-candidate",
        reasonCode: "GRAPH_STORE_CORRUPT",
      });
      expect(await readActiveGraphGeneration(dataRoot)).toEqual(
        manifestBefore,
      );
    } finally {
      await storage.close();
    }
  }, 30_000);

  it("kills an uncommitted exact-scope replacement without partial graph state", async () => {
    const dataRoot = await temporaryRoot();
    const storage = await projectedStorage(dataRoot);
    const identity = await installedGraphBackendIdentity();
    const host = await GraphProcessHost.open({
      dataRoot,
      generationId: "uncommitted-scope",
      expectedIdentity: identity,
      childEntry,
      writeTimeoutMs: 100,
      testHooks: { adversarialNativeWrite: true },
    });
    hosts.push(host);
    try {
      const committed = (
        await storage.listGraphProjectionSnapshots()
      ).snapshots[0];
      if (committed === undefined || committed.nodes[0] === undefined) {
        throw new Error("uncommitted graph fixture is missing");
      }
      await host.replaceScope(committed);
      const adversarial = buildGraphScopeSnapshot({
        schema_version: committed.schema_version,
        backend: committed.backend,
        principal_id: committed.principal_id,
        scope: committed.scope,
        frontier: committed.frontier,
        nodes: committed.nodes.map((node, index) => ({
          ...node,
          graph_node_id:
            index === 0
              ? "graph_node_adversarial_native_write"
              : node.graph_node_id,
        })),
        edges: committed.edges,
      });
      await expect(host.replaceScope(adversarial)).rejects.toMatchObject({
        code: "GRAPH_DEADLINE_EXCEEDED",
      });
      const recovered = await new DeterministicGraphRebuilder({
        storage,
        dataRoot,
        expectedIdentity: identity,
        workerId: "graph_u4_uncommitted_rebuilder",
        clock: () => new Date("2026-07-29T08:00:00.000Z"),
        hostOptions: { childEntry, writeTimeoutMs: 10_000 },
      }).rebuild({ previousStore: host });
      hosts.push(recovered.store as GraphProcessHost);
      await expect(
        recovered.store.readScopeSnapshot({
          principal_id: committed.principal_id,
          scope: committed.scope,
        }),
      ).resolves.toEqual(committed);
    } finally {
      await storage.close();
    }
  }, 30_000);
});
