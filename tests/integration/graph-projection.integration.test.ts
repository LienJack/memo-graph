import {
  mkdtemp,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  GraphProcessHost,
  ExactScopeGraphProjector,
  DeterministicGraphRebuilder,
  queryGraphSnapshotReference,
  type GraphStore,
} from "../../packages/graph-projection/src/index.js";
import {
  GraphQuerySchema,
  ScopeSchema,
  buildGraphScopeSnapshot,
  canonicalJson,
} from "../../packages/contracts/src/index.js";
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
import { NOW } from "../helpers/examples.js";

const roots: string[] = [];
const hosts: GraphProcessHost[] = [];
const MAIN_SCOPE = ScopeSchema.parse({
  kind: "workspace",
  id: "workspace_local",
});
const OTHER_SCOPE = ScopeSchema.parse({
  kind: "workspace",
  id: "workspace_other",
});

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
    join(await realpath(tmpdir()), "memo-graph-u4-projector-"),
  );
  roots.push(root);
  return root;
}

describe("exact-scope graph projector", () => {
  it("projects minimal envelopes, matches the SQLite reference, and replaces only one scope", async () => {
    const dataRoot = await temporaryRoot();
    const storage = await SqliteStorageClient.open({ dataRoot });
    const identity = await installedGraphBackendIdentity();
    const host = await GraphProcessHost.open({
      dataRoot,
      expectedIdentity: identity,
      childEntry: new URL(
        "../../packages/graph-projection/dist/ladybug-process.js",
        import.meta.url,
      ),
      requestTimeoutMs: 250,
      writeTimeoutMs: 10_000,
    }).catch((error: unknown) => {
      throw new Error("U4 graph host failed to open", { cause: error });
    });
    hosts.push(host);
    try {
      const fixture =
        await applyCompleteGraphProjectionFixture(storage);
      const beforeOther = await storage.health();
      const otherFrontier = projectionFrontier({
        ledgerEpoch: beforeOther.ledger_epoch,
        tombstoneEpoch: beforeOther.tombstone_epoch,
        projectionEpoch:
          beforeOther.projection_frontier.projection_epoch + 1,
      });
      await storage.applyProjectionBatch({
        principal_id: "user_local",
        scope: { kind: "workspace", id: "workspace_other" },
        idempotency_key: "graph-other-empty-scope-0001",
        expected_projection_epoch:
          beforeOther.projection_frontier.projection_epoch,
        frontier: otherFrontier,
        projections: [],
        applied_at: "2026-07-29T05:01:00.000Z",
      });

      const projector = new ExactScopeGraphProjector({
        storage,
        store: host,
        workerId: "graph_u4_projector",
        clock: () => new Date("2026-07-29T05:10:00.000Z"),
      });
      const initialDrain = await projector.drain().catch((error: unknown) => {
        throw new Error("U4 initial graph drain failed", { cause: error });
      });
      expect(initialDrain).toMatchObject({
        claimed: 2,
        applied: 2,
        failed: 0,
        stale: 0,
        abandoned: 0,
      });

      const main = await host.readScopeSnapshot({
        principal_id: "user_local",
        scope: MAIN_SCOPE,
      });
      const other = await host.readScopeSnapshot({
        principal_id: "user_local",
        scope: OTHER_SCOPE,
      });
      expect(main).not.toBeNull();
      expect(main?.nodes).toHaveLength(7);
      expect(main?.edges).toHaveLength(1);
      expect(
        new Set(main?.nodes.map((node) => node.projection_type)),
      ).toEqual(
        new Set([
          null,
          "topic",
          "scenario",
          "procedure",
          "relation",
          "core",
        ]),
      );
      const serialized = canonicalJson(main);
      for (const prohibited of [
        "SQLite remains authoritative.",
        "A canonical frontier changes.",
        "Rebuild from canonical SQLite.",
        "Authority supports exact revalidation.",
        "Canonical state outranks derived graph state.",
      ]) {
        expect(serialized).not.toContain(prohibited);
      }
      expect(
        await storage.graphProjectionCheckpoint({
          principal_id: "user_local",
          scope: { kind: "workspace", id: "workspace_local" },
        }),
      ).toMatchObject({
        status: "ready",
        logical_digest: main?.logical_digest,
      });

      const relation = fixture.projections.find(
        (projection) => projection.projection_type === "relation",
      );
      if (main === null || relation === undefined) {
        throw new Error("graph fixture relation is missing");
      }
      const query = GraphQuerySchema.parse({
        schema_version: "1.0.0",
        query_id: "graph_u4_reference_query",
        backend: "ladybugdb",
        principal_id: "user_local",
        scope: { kind: "workspace", id: "workspace_local" },
        as_of: NOW,
        frontier: fixture.frontier,
        mode: "typed_path",
        start_revision_ids: [fixture.sources[0].revision_id],
        allowed_relation_revision_ids: [
          relation.projection_revision_id,
        ],
        relation_pattern: ["supports"],
        max_depth: 1,
        max_fanout: 10,
        max_paths: 10,
        max_results: 10,
        max_relation_allowlist: 100,
        parent_deadline_ms: 250,
      });
      const native = await host.queryPaths(query);
      const reference = queryGraphSnapshotReference({
        snapshot: main,
        query,
      });
      expect(native.paths).toEqual(reference.paths);
      expect(native.complete).toBe(reference.complete);

      const beforeReplacement = await storage.health();
      const replacementFrontier = projectionFrontier({
        ledgerEpoch: beforeReplacement.ledger_epoch,
        tombstoneEpoch: beforeReplacement.tombstone_epoch,
        projectionEpoch:
          beforeReplacement.projection_frontier.projection_epoch + 1,
      });
      await storage.applyProjectionBatch({
        principal_id: "user_local",
        scope: { kind: "workspace", id: "workspace_local" },
        idempotency_key: "graph-main-remove-relation-0001",
        expected_projection_epoch:
          beforeReplacement.projection_frontier.projection_epoch,
        frontier: replacementFrontier,
        projections: [],
        retire_projection_revision_ids: [
          relation.projection_revision_id,
        ],
        applied_at: "2026-07-29T05:11:00.000Z",
      });
      const replacementProjector = new ExactScopeGraphProjector({
        storage,
        store: host,
        workerId: "graph_u4_replacement_projector",
        clock: () => new Date("2026-07-29T05:12:00.000Z"),
      });
      await expect(replacementProjector.drain()).resolves.toMatchObject({
        claimed: 1,
        applied: 1,
      });
      const replaced = await host.readScopeSnapshot({
        principal_id: "user_local",
        scope: MAIN_SCOPE,
      });
      expect(replaced?.edges).toEqual([]);
      expect(replaced?.nodes).toHaveLength(6);
      expect(
        await host.readScopeSnapshot({
          principal_id: "user_local",
          scope: OTHER_SCOPE,
        }),
      ).toEqual(other);
    } finally {
      await storage.close();
    }
  });

  it("replays idempotently after graph commit but before SQLite checkpoint", async () => {
    const dataRoot = await temporaryRoot();
    const storage = await SqliteStorageClient.open({ dataRoot });
    const identity = await installedGraphBackendIdentity();
    const diagnostics: unknown[] = [];
    const firstHost = await GraphProcessHost.open({
      dataRoot,
      expectedIdentity: identity,
      childEntry: new URL(
        "../../packages/graph-projection/dist/ladybug-process.js",
        import.meta.url,
      ),
      writeTimeoutMs: 10_000,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    hosts.push(firstHost);
    try {
      await applyCompleteGraphProjectionFixture(storage);
      const firstProjector = new ExactScopeGraphProjector({
        storage,
        store: firstHost,
        workerId: "graph_u4_crash_worker_a",
        leaseMs: 60_000,
        clock: () => new Date("2026-07-29T07:00:00.000Z"),
      });
      const firstJob = (await firstProjector.claim())[0];
      if (firstJob === undefined) {
        throw new Error("graph crash fixture job is missing");
      }
      const prepared = await firstProjector.prepare(firstJob);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const childPid = firstHost.processId();
      if (childPid === null) {
        throw new Error("graph crash fixture child is missing");
      }
      process.kill(childPid, "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            outcome: "exit",
            error_code: "GRAPH_CHILD_EXITED",
          }),
        ]),
      );
      const rebuilt = await new DeterministicGraphRebuilder({
        storage,
        dataRoot,
        expectedIdentity: identity,
        workerId: "graph_u4_crash_rebuilder",
        clock: () => new Date("2026-07-29T07:01:30.000Z"),
        hostOptions: {
          childEntry: new URL(
            "../../packages/graph-projection/dist/ladybug-process.js",
            import.meta.url,
          ),
          writeTimeoutMs: 10_000,
        },
      }).rebuild({ previousStore: firstHost });
      hosts.push(rebuilt.store as GraphProcessHost);
      const replayProjector = new ExactScopeGraphProjector({
        storage,
        store: rebuilt.store,
        workerId: "graph_u4_crash_worker_b",
        leaseMs: 60_000,
        clock: () => new Date("2026-07-29T07:02:00.000Z"),
      });
      const replayJob = (await replayProjector.claim())[0];
      if (replayJob === undefined) {
        throw new Error("graph crash replay job is missing");
      }
      expect(replayJob.job_id).toBe(firstJob.job_id);
      expect(replayJob.attempts).toBe(firstJob.attempts + 1);
      const replayPrepared = await replayProjector.prepare(replayJob);
      const committed = await replayProjector.commit(replayPrepared);
      expect(committed).toMatchObject({
        replayed: false,
        job: { status: "applied", attempts: 2 },
        checkpoint: {
          status: "ready",
          logical_digest: replayPrepared.snapshot.logical_digest,
        },
      });
      await expect(
        replayProjector.commit(replayPrepared),
      ).resolves.toMatchObject({ replayed: true });
      await expect(
        firstProjector.commit(prepared),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    } finally {
      await storage.close();
    }
  }, 15_000);

  it("abandons stale work before dispatch and cannot publish after a post-write frontier change", async () => {
    const dataRoot = await temporaryRoot();
    const storage = await SqliteStorageClient.open({ dataRoot });
    const identity = await installedGraphBackendIdentity();
    const host = await GraphProcessHost.open({
      dataRoot,
      expectedIdentity: identity,
      childEntry: new URL(
        "../../packages/graph-projection/dist/ladybug-process.js",
        import.meta.url,
      ),
      writeTimeoutMs: 10_000,
    });
    hosts.push(host);
    try {
      await applyCompleteGraphProjectionFixture(storage);
      const beforeWrite = new ExactScopeGraphProjector({
        storage,
        store: host,
        workerId: "graph_u4_before_write_worker",
        clock: () => new Date("2026-07-29T07:10:00.000Z"),
      });
      const staleBefore = (await beforeWrite.claim())[0];
      if (staleBefore === undefined) {
        throw new Error("graph pre-dispatch stale job is missing");
      }
      await storage.resetGraphProjectionScopes({
        scopes: [{
          principal_id: "user_local",
          scope: { kind: "workspace", id: "workspace_local" },
        }],
        mode: "pending",
        reset_at: "2026-07-29T07:10:30.000Z",
      });
      await expect(beforeWrite.project(staleBefore)).resolves.toMatchObject({
        outcome: "stale",
        code: "GRAPH_SCOPE_STALE",
      });
      expect(
        await host.readScopeSnapshot({
          principal_id: "user_local",
          scope: MAIN_SCOPE,
        }),
      ).toBeNull();

      const health = await storage.health();
      const refreshedFrontier = projectionFrontier({
        ledgerEpoch: health.ledger_epoch,
        tombstoneEpoch: health.tombstone_epoch,
        projectionEpoch:
          health.projection_frontier.projection_epoch + 1,
      });
      await storage.applyProjectionBatch({
        principal_id: "user_local",
        scope: { kind: "workspace", id: "workspace_local" },
        idempotency_key: "graph-u4-stale-after-write-refresh-0001",
        expected_projection_epoch:
          health.projection_frontier.projection_epoch,
        frontier: refreshedFrontier,
        projections: [],
        applied_at: "2026-07-29T07:11:00.000Z",
      });
      const afterWrite = new ExactScopeGraphProjector({
        storage,
        store: host,
        workerId: "graph_u4_after_write_worker",
        clock: () => new Date("2026-07-29T07:12:00.000Z"),
      });
      const writtenJob = (await afterWrite.claim())[0];
      if (writtenJob === undefined) {
        throw new Error("graph post-write stale job is missing");
      }
      const written = await afterWrite.prepare(writtenJob);
      const nextHealth = await storage.health();
      const changedFrontier = projectionFrontier({
        ledgerEpoch: nextHealth.ledger_epoch,
        tombstoneEpoch: nextHealth.tombstone_epoch,
        projectionEpoch:
          nextHealth.projection_frontier.projection_epoch + 1,
      });
      await storage.applyProjectionBatch({
        principal_id: "user_local",
        scope: { kind: "workspace", id: "workspace_local" },
        idempotency_key: "graph-u4-frontier-changed-after-write-0001",
        expected_projection_epoch:
          nextHealth.projection_frontier.projection_epoch,
        frontier: changedFrontier,
        projections: [],
        applied_at: "2026-07-29T07:13:00.000Z",
      });
      await expect(afterWrite.commit(written)).rejects.toMatchObject({
        code: "CONFLICT",
      });
      await expect(
        storage.graphProjectionCheckpoint({
          principal_id: "user_local",
          scope: { kind: "workspace", id: "workspace_local" },
        }),
      ).resolves.toMatchObject({
        status: "pending",
        backend_identity: null,
      });
      const finalProjector = new ExactScopeGraphProjector({
        storage,
        store: host,
        workerId: "graph_u4_final_worker",
        clock: () => new Date("2026-07-29T07:14:00.000Z"),
      });
      await expect(finalProjector.drain()).resolves.toMatchObject({
        claimed: 1,
        applied: 1,
      });
    } finally {
      await storage.close();
    }
  });

  it("records digest mismatch without publishing graph readiness", async () => {
    const dataRoot = await temporaryRoot();
    const storage = await SqliteStorageClient.open({ dataRoot });
    const identity = await installedGraphBackendIdentity();
    const host = await GraphProcessHost.open({
      dataRoot,
      expectedIdentity: identity,
      childEntry: new URL(
        "../../packages/graph-projection/dist/ladybug-process.js",
        import.meta.url,
      ),
      writeTimeoutMs: 10_000,
    });
    hosts.push(host);
    try {
      await applyCompleteGraphProjectionFixture(storage);
      const mismatchingStore: GraphStore = {
        health: () => host.health(),
        deleteScope: (input) => host.deleteScope(input),
        readScopeSnapshot: (input) => host.readScopeSnapshot(input),
        queryPaths: (input) => host.queryPaths(input),
        close: () => host.close(),
        replaceScope: async (input) => {
          const written = await host.replaceScope(input);
          return buildGraphScopeSnapshot({
            schema_version: "1.0.0",
            backend: written.backend,
            principal_id: written.principal_id,
            scope: written.scope,
            frontier: written.frontier,
            nodes: [],
            edges: [],
          });
        },
      };
      const projector = new ExactScopeGraphProjector({
        storage,
        store: mismatchingStore,
        workerId: "graph_u4_digest_mismatch_worker",
        clock: () => new Date("2026-07-29T07:20:00.000Z"),
      });
      const job = (await projector.claim())[0];
      if (job === undefined) {
        throw new Error("graph digest mismatch job is missing");
      }
      await expect(projector.project(job)).resolves.toMatchObject({
        outcome: "failed",
        code: "GRAPH_DIGEST_MISMATCH",
      });
      await expect(
        storage.graphProjectionCheckpoint({
          principal_id: "user_local",
          scope: { kind: "workspace", id: "workspace_local" },
        }),
      ).resolves.toMatchObject({
        status: "unavailable",
        logical_digest: null,
        backend_identity: null,
        last_failure: "GRAPH_DIGEST_MISMATCH",
      });
    } finally {
      await storage.close();
    }
  });
});
