import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import type { GraphStore } from "../../packages/graph-projection/src/index.js";

import {
  CanonicalHashSchema,
  ScopeSchema,
  WorkbenchMemoryMemberSchema,
  canonicalSha256,
} from "../../packages/contracts/src/index.js";
import {
  BackgroundSupervisor,
  InMemoryWorkbenchSnapshotRegistry,
  WorkbenchSnapshotCapacityError,
  openMemoryRuntime,
} from "../../packages/runtime-host/src/index.js";
import { SharedGraphStoreManager } from "../../packages/runtime-host/src/shared-graph-store.js";
import { qualifiedVectorEpoch } from "../helpers/vector-examples.js";

const NOW = Date.parse("2026-08-02T08:00:00.000Z");

function hash(value: unknown) {
  return CanonicalHashSchema.parse(canonicalSha256(value));
}

function members(count: number) {
  return WorkbenchMemoryMemberSchema.array().parse(
    Array.from({ length: count }, (_, index) => ({
      memory_id: `memory_${index}`,
      revision_id: `revision_${index}`,
    })),
  );
}

describe("managed Runtime host registries", () => {
  it("bounds snapshot state and distinguishes eviction, expiry, restart, and invalid session", () => {
    let now = NOW;
    let id = 0;
    const registry = new InMemoryWorkbenchSnapshotRegistry({
      instanceId: "host:one",
      signingKey: randomBytes(32),
      clock: () => now,
      idFactory: () => `snapshot:${++id}`,
      ttlMs: 1_000,
      maxSnapshots: 1,
      maxMembers: 4,
      maxBytes: 16_384,
    });
    const firstSession = registry.session("browser:one");
    const first = firstSession.create({
      query_hash: hash({ query: "first" }),
      frontier_hash: hash({ frontier: 1 }),
      members: members(3),
      page_size: 1,
      omitted_count: 0,
      created_at: new Date(now).toISOString(),
    });
    expect(first.members).toEqual(members(1));
    expect(first.next_cursor).not.toBeNull();
    if (first.next_cursor === null) {
      throw new Error("fixture requires a cursor");
    }
    expect(
      registry.session("browser:other").read(
        first.next_cursor,
        hash({ query: "first" }),
      ),
    ).toEqual({ status: "stale", reason_code: "CURSOR_INVALID" });

    expect(() =>
      firstSession.create({
        query_hash: hash({ query: "too-large" }),
        frontier_hash: hash({ frontier: 1 }),
        members: members(5),
        page_size: 1,
        omitted_count: 0,
        created_at: new Date(now).toISOString(),
      }),
    ).toThrow(WorkbenchSnapshotCapacityError);
    expect(registry.stats().snapshots).toBe(1);

    firstSession.create({
      query_hash: hash({ query: "second" }),
      frontier_hash: hash({ frontier: 2 }),
      members: members(2),
      page_size: 1,
      omitted_count: 0,
      created_at: new Date(now).toISOString(),
    });
    expect(
      firstSession.read(first.next_cursor, hash({ query: "first" })),
    ).toEqual({ status: "stale", reason_code: "SNAPSHOT_EVICTED" });

    const expiring = firstSession.create({
      query_hash: hash({ query: "expiry" }),
      frontier_hash: hash({ frontier: 3 }),
      members: members(2),
      page_size: 1,
      omitted_count: 0,
      created_at: new Date(now).toISOString(),
    });
    if (expiring.next_cursor === null) {
      throw new Error("fixture requires an expiring cursor");
    }
    const restarted = new InMemoryWorkbenchSnapshotRegistry({
      instanceId: "host:two",
      signingKey: randomBytes(32),
      clock: () => now,
    });
    expect(
      restarted
        .session("browser:one")
        .read(expiring.next_cursor, hash({ query: "expiry" })),
    ).toEqual({ status: "stale", reason_code: "SNAPSHOT_RESTARTED" });
    now += 1_001;
    expect(
      firstSession.read(expiring.next_cursor, hash({ query: "expiry" })),
    ).toEqual({ status: "stale", reason_code: "SNAPSHOT_EXPIRED" });
    registry.close();
    restarted.close();
  });

  it("rejects duplicate snapshot identities without corrupting resource accounting", () => {
    const registry = new InMemoryWorkbenchSnapshotRegistry({
      instanceId: "host:one",
      signingKey: randomBytes(32),
      clock: () => NOW,
      idFactory: () => "snapshot:duplicate",
      ttlMs: 1_000,
      maxSnapshots: 2,
      maxMembers: 4,
      maxBytes: 16_384,
    });
    const session = registry.session("browser:one");
    const input = {
      query_hash: hash({ query: "duplicate" }),
      frontier_hash: hash({ frontier: 1 }),
      members: members(2),
      page_size: 1,
      omitted_count: 0,
      created_at: new Date(NOW).toISOString(),
    };

    session.create(input);
    const before = registry.stats();
    expect(() => session.create(input)).toThrow("snapshot identity collision");
    expect(registry.stats()).toEqual(before);
    registry.close();
  });

  it("keeps cursors bounded for maximum accepted host and session identities", () => {
    const registry = new InMemoryWorkbenchSnapshotRegistry({
      instanceId: `h${"i".repeat(159)}`,
      signingKey: randomBytes(32),
      clock: () => NOW,
      idFactory: () => `s${"n".repeat(95)}`,
      ttlMs: 1_000,
    });
    const first = registry.session(`b${"r".repeat(159)}`).create({
      query_hash: hash({ query: "bounded" }),
      frontier_hash: hash({ frontier: 1 }),
      members: members(2),
      page_size: 1,
      omitted_count: 0,
      created_at: new Date(NOW).toISOString(),
    });

    expect(first.next_cursor).not.toBeNull();
    expect(first.next_cursor?.length).toBeLessThanOrEqual(768);
    registry.close();
  });

  it("runs one injected lane at a time and drains without scheduling new work", async () => {
    let inFlight = 0;
    let peak = 0;
    let completed = 0;
    const lane = (name: string) => ({
      name,
      intervalMs: 60_000,
      runOnce: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        completed += 1;
        return { claimed: 1, completed: 1, failed: 0, terminal: 0 };
      },
    });
    const supervisor = new BackgroundSupervisor({
      lanes: [lane("fts"), lane("consolidation")],
      maxConcurrency: 1,
    });
    supervisor.start();
    await supervisor.runDueOnce();
    await new Promise((resolve) => setImmediate(resolve));
    await supervisor.runDueOnce();
    await new Promise((resolve) => setImmediate(resolve));
    expect(peak).toBe(1);
    expect(completed).toBeGreaterThanOrEqual(1);
    expect(await supervisor.drain(100)).toBe(true);
    expect(supervisor.observations().every((lane) => lane.state === "stopped"))
      .toBe(true);
  });

  it("supervises configured Graph and vector lanes without eager optional artifacts", async () => {
    const dataRoot = realpathSync(
      mkdtempSync(join(realpathSync(tmpdir()), "memo-graph-managed-lanes-")),
    );
    const modelRoot = join(dataRoot, "operator-model-cache");
    const opened = await openMemoryRuntime(
      {
        data_root: dataRoot,
        principal_id: "user_local",
        allowed_scopes: [{ kind: "workspace", id: "workspace_local" }],
        allowed_authorities: ["user_stated"],
        graph: {
          enabled: true,
          expected_identity: {
            schema_version: "1.0.0",
            backend: "ladybugdb",
            package_name: "@ladybugdb/core",
            package_version: "0.18.3",
            storage_version: "42",
            platform: process.platform,
            architecture: process.arch,
            native_binary_hash: `sha256:${"1".repeat(64)}`,
            dependency_lock_hash: `sha256:${"2".repeat(64)}`,
          },
          mode: "typed_path",
          relation_pattern: ["supports"],
          direction: "outbound",
        },
        vector: {
          enabled: true,
          model_root: modelRoot,
          expected_epoch: qualifiedVectorEpoch(),
        },
      },
      { mode: "managed" },
    );
    try {
      expect(opened.supervisor?.observations().map((lane) => lane.lane))
        .toEqual([
          "writer_lease",
          "fts",
          "consolidation",
          "graph_projection",
          "vector_projection",
        ]);
      expect(
        existsSync(join(dataRoot, "derived", "graph", "ladybug.lbdb")),
      ).toBe(false);
      expect(existsSync(modelRoot)).toBe(false);
    } finally {
      await opened.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("retries shared Graph startup without letting borrowers own shutdown", async () => {
    let opens = 0;
    let closes = 0;
    const store: GraphStore = {
      health: async () => {
        throw new Error("not used by fixture");
      },
      replaceScope: async () => {
        throw new Error("not used by fixture");
      },
      deleteScope: async () => undefined,
      readScopeSnapshot: async () => null,
      queryPaths: async () => {
        throw new Error("not used by fixture");
      },
      close: async () => {
        closes += 1;
      },
    };
    const manager = new SharedGraphStoreManager(async () => {
      opens += 1;
      if (opens === 1) {
        throw new Error("injected first startup failure");
      }
      return store;
    });
    const borrowed = manager.borrowedStore();
    const scope = ScopeSchema.parse({
      kind: "workspace",
      id: "workspace_local",
    });

    await expect(
      borrowed.readScopeSnapshot({
        principal_id: "user_local",
        scope,
      }),
    ).rejects.toThrow("injected first startup failure");
    await expect(
      borrowed.readScopeSnapshot({
        principal_id: "user_local",
        scope,
      }),
    ).resolves.toBeNull();
    await borrowed.close();
    expect(closes).toBe(0);
    await manager.close();
    expect(opens).toBe(2);
    expect(closes).toBe(1);
  });
});
