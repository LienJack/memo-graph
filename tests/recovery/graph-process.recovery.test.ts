import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

import { afterEach, describe, expect, it } from "vitest";

import {
  GraphProcessHost,
  type GraphProcessHostOptions,
} from "../../packages/graph-projection/src/index.js";
import {
  GraphBackendIdentitySchema,
  buildGraphScopeSnapshot,
  canonicalSha256,
} from "../../packages/contracts/src/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import {
  HASH_A,
  HASH_B,
  LATER,
  NOW,
  USER_SCOPE,
} from "../helpers/examples.js";

const roots: string[] = [];
const hosts: GraphProcessHost[] = [];

afterEach(async () => {
  await Promise.allSettled(hosts.splice(0).map((host) => host.close()));
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "memo-graph-u2-recovery-"),
  );
  roots.push(root);
  return root;
}

const IDENTITY = GraphBackendIdentitySchema.parse({
  schema_version: "1.0.0",
  backend: "ladybugdb",
  package_name: "@ladybugdb/core",
  package_version: "0.18.3",
  storage_version: "42",
  platform: process.platform,
  architecture: process.arch,
  native_binary_hash: HASH_A,
  dependency_lock_hash: HASH_B,
});

async function installedBackendIdentity() {
  const require = createRequire(import.meta.url);
  const entry = require.resolve("@ladybugdb/core");
  const binary = await readFile(join(dirname(entry), "lbugjs.node"));
  const lockfile = await readFile(
    new URL("../../pnpm-lock.yaml", import.meta.url),
  );
  return GraphBackendIdentitySchema.parse({
    ...IDENTITY,
    native_binary_hash:
      `sha256:${createHash("sha256").update(binary).digest("hex")}`,
    dependency_lock_hash:
      `sha256:${createHash("sha256").update(lockfile).digest("hex")}`,
  });
}

const FRONTIER = {
  schema_version: "1.0.0",
  ledger_epoch: 1,
  tombstone_epoch: 0,
  projection_epoch: 1,
  transform: { name: "graph-test", version: "1.0.0" },
  source_frontier_hash: HASH_A,
  projection_frontier_hash: HASH_B,
} as const;

function query(queryId: string) {
  return {
    schema_version: "1.0.0",
    query_id: queryId,
    backend: "ladybugdb",
    principal_id: "user_local",
    scope: USER_SCOPE,
    as_of: NOW,
    frontier: FRONTIER,
    mode: "typed_path",
    start_revision_ids: ["revision_1"],
    allowed_relation_revision_ids: ["relation_revision_1"],
    relation_pattern: ["supports"],
    max_depth: 1,
    max_fanout: 10,
    max_paths: 4,
    max_results: 4,
    max_relation_allowlist: 100,
    parent_deadline_ms: 75,
  } as const;
}

function snapshot(graphNodeId = "graph_node_1") {
  return buildGraphScopeSnapshot({
    schema_version: "1.0.0",
    backend: "ladybugdb",
    principal_id: "user_local",
    scope: USER_SCOPE,
    frontier: FRONTIER,
    nodes: [
      {
        schema_version: "1.0.0",
        graph_node_id: graphNodeId,
        revision_id: "revision_1",
        projection_revision_id: "projection_revision_1",
        principal_id: "user_local",
        scope: USER_SCOPE,
        abstraction: "l2_topic",
        projection_type: "topic",
        lifecycle: "active",
        validity: {
          valid_from: NOW,
          valid_to: LATER,
          recorded_at: NOW,
        },
        ledger_epoch: 1,
        tombstone_epoch: 0,
        projection_epoch: 1,
        content_hash: HASH_A,
        payload_hash: HASH_B,
        transform: FRONTIER.transform,
        evidence_ids: ["evidence_1"],
        lineage_revision_ids: ["revision_source_1"],
      },
    ],
    edges: [],
  });
}

async function host(
  overrides: Partial<GraphProcessHostOptions> = {},
): Promise<GraphProcessHost> {
  const opened = await GraphProcessHost.open({
    dataRoot: await tempRoot(),
    expectedIdentity: IDENTITY,
    childEntry: new URL(
      "../fixtures/graph-process-child.mjs",
      import.meta.url,
    ),
    requestTimeoutMs: 75,
    startupTimeoutMs: 2_000,
    restartPolicy: {
      maxRestarts: 3,
      windowMs: 1_000,
      cooldownMs: 250,
    },
    ...overrides,
  });
  hosts.push(opened);
  return opened;
}

async function waitForProcessStatus(
  graph: GraphProcessHost,
  status: "starting",
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (
    graph.processHealth().status !== status &&
    performance.now() <= deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(graph.processHealth().status).toBe(status);
}

async function waitForQueueDepth(
  graph: GraphProcessHost,
  expectedDepth: number,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (
    graph.processHealth().queue_depth !== expectedDepth &&
    performance.now() <= deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(graph.processHealth().queue_depth).toBe(expectedDepth);
}

describe("graph child process recovery", () => {
  it("rejects every mismatched backend identity field before ready", async () => {
    const mismatches = [
      { ...IDENTITY, package_version: "0.18.4" },
      { ...IDENTITY, storage_version: "999" },
      {
        ...IDENTITY,
        platform: process.platform === "darwin" ? "linux" : "darwin",
      },
      {
        ...IDENTITY,
        architecture: process.arch === "arm64" ? "x64" : "arm64",
      },
      {
        ...IDENTITY,
        native_binary_hash:
          `sha256:${"c".repeat(64)}`,
      },
    ].map((identity) => GraphBackendIdentitySchema.parse(identity));
    for (const identityOverride of mismatches) {
      await expect(
        host({
          testHooks: {
            identityOverride,
          },
        }),
      ).rejects.toMatchObject({
        code: "GRAPH_IDENTITY_MISMATCH",
      });
    }
  });

  it("returns within the host deadline and replaces the killed child", async () => {
    const graph = await host({
      restartPolicy: {
        maxRestarts: 100,
        windowMs: 60_000,
        cooldownMs: 250,
      },
    });
    const samples: number[] = [];
    for (let index = 0; index < 100; index += 1) {
      const started = performance.now();
      const result = await graph.queryPaths(query(`query_timeout_${index}`));
      samples.push(performance.now() - started);
      expect(result).toMatchObject({
        status: "unavailable",
        complete: false,
        process_outcome: "deadline_killed",
        reason_codes: ["GRAPH_DEADLINE_EXCEEDED"],
      });
      await expect(graph.waitUntilHealthy(2_000)).resolves.toBe(true);
    }
    samples.sort((left, right) => left - right);
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1] ?? Infinity;
    expect(p95).toBeLessThanOrEqual(100);

    const replacementStarted = performance.now();
    expect(await graph.waitUntilHealthy(2_000)).toBe(true);
    expect(performance.now() - replacementStarted).toBeLessThanOrEqual(2_000);
  }, 60_000);

  it("includes replacement readiness in the parent query deadline", async () => {
    const graph = await host({
      requestTimeoutMs: 75,
      testHooks: {
        startupDelayMs: 250,
      },
    });
    const childPid = graph.processId();
    if (childPid === null) {
      throw new Error("graph child must be running before restart test");
    }
    process.kill(childPid, "SIGKILL");
    await waitForProcessStatus(graph, "starting");

    const started = performance.now();
    const result = await graph.queryPaths(
      query("query_during_replacement_startup"),
    );
    const elapsed = performance.now() - started;

    expect(result).toMatchObject({
      status: "unavailable",
      complete: false,
      process_outcome: "deadline_killed",
      reason_codes: ["GRAPH_DEADLINE_EXCEEDED"],
    });
    expect(elapsed).toBeLessThanOrEqual(100);
    await expect(graph.waitUntilHealthy(2_000)).resolves.toBe(true);
  });

  it("rejects requests beyond the parent pending-request bound", async () => {
    const graph = await host({
      maxConcurrentRequests: 1,
    });
    const first = graph.queryPaths(query("query_timeout_admission"));
    await waitForQueueDepth(graph, 1);

    const overflow = await graph.queryPaths(
      query("query_overflow_admission"),
    );
    expect(overflow).toMatchObject({
      status: "unavailable",
      complete: false,
      process_outcome: "store_error",
      reason_codes: ["GRAPH_REQUEST_LIMIT_EXCEEDED"],
    });
    expect(graph.processHealth().queue_depth).toBe(1);
    await expect(first).resolves.toMatchObject({
      status: "unavailable",
      reason_codes: ["GRAPH_DEADLINE_EXCEEDED"],
    });
  });

  it("does not replace a healthy generation when a prior exit arrives late", async () => {
    const graph = await host({
      testHooks: {
        exitRestartDelayMs: 100,
      },
    });
    let replacementPid: number | null = null;
    try {
      await expect(
        graph.queryPaths(query("query_timeout_late_exit")),
      ).resolves.toMatchObject({
        status: "unavailable",
        reason_codes: ["GRAPH_DEADLINE_EXCEEDED"],
      });
      expect(await graph.waitUntilHealthy(2_000)).toBe(true);
      await expect(
        graph.queryPaths(query("query_after_prior_exit")),
      ).resolves.toMatchObject({
        status: "complete",
      });
      replacementPid = graph.processId();
      expect(replacementPid).not.toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(graph.processId()).toBe(replacementPid);
      expect(graph.processHealth()).toMatchObject({
        status: "ready",
        restart_count: 1,
      });
    } finally {
      if (
        replacementPid !== null &&
        graph.processId() !== replacementPid
      ) {
        try {
          process.kill(replacementPid, "SIGKILL");
        } catch {
          // The leaked-process guard is best-effort on a failing regression.
        }
      }
    }
  });

  it("discards duplicate responses and keeps the next request isolated", async () => {
    const graph = await host();
    await expect(
      graph.queryPaths(query("query_duplicate")),
    ).resolves.toMatchObject({
      status: "complete",
      query_hash: canonicalSha256(query("query_duplicate")),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(graph.health()).resolves.toMatchObject({
      status: "ready",
    });
    await expect(
      graph.queryPaths(query("query_late")),
    ).resolves.toMatchObject({
      status: "unavailable",
      complete: false,
      process_outcome: "deadline_killed",
    });
    await expect(graph.waitUntilHealthy(2_000)).resolves.toBe(true);
    await expect(
      graph.queryPaths(query("query_after_discard")),
    ).resolves.toMatchObject({
      status: "complete",
      query_hash: canonicalSha256(query("query_after_discard")),
    });
  });

  it("quarantines malformed and oversized child responses", async () => {
    for (const queryId of ["query_malformed", "query_oversized"]) {
      const graph = await host();
      await expect(graph.queryPaths(query(queryId))).resolves.toMatchObject({
        status: "unavailable",
        complete: false,
        process_outcome: "protocol_error",
        reason_codes: ["GRAPH_PROTOCOL_INVALID"],
      });
      await expect(graph.waitUntilHealthy(2_000)).resolves.toBe(true);
    }
  });

  it("recovers from query and uncommitted-write crashes without losing the prior digest", async () => {
    const graph = await host();
    const committed = snapshot();
    await graph.replaceScope(committed);
    await expect(
      graph.queryPaths(query("query_crash")),
    ).resolves.toMatchObject({
      status: "unavailable",
      complete: false,
      process_outcome: "child_exited",
    });
    await expect(graph.waitUntilHealthy(2_000)).resolves.toBe(true);

    await expect(
      graph.replaceScope(snapshot("graph_node_crash_write")),
    ).rejects.toMatchObject({
      code: "GRAPH_CHILD_EXITED",
    });
    await expect(graph.waitUntilHealthy(2_000)).resolves.toBe(true);
    await expect(
      graph.readScopeSnapshot({
        principal_id: committed.principal_id,
        scope: committed.scope,
      }),
    ).resolves.toEqual(committed);
  });

  it("opens a bounded circuit and leaves SQLite responsive", async () => {
    const sqliteRoot = await tempRoot();
    const sqlite = await SqliteStorageClient.open({ dataRoot: sqliteRoot });
    const graph = await host({
      restartPolicy: {
        maxRestarts: 2,
        windowMs: 2_000,
        cooldownMs: 500,
      },
    });
    try {
      for (let index = 0; index < 3; index += 1) {
        await graph.queryPaths(query(`query_crash_${index}`));
        if (index < 2) {
          await graph.waitUntilHealthy(2_000).catch(() => false);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(graph.processHealth()).toMatchObject({
        status: "circuit_open",
      });
      await expect(sqlite.health()).resolves.toMatchObject({
        schema_version: "0015",
        journal_mode: "wal",
        foreign_keys: true,
      });
    } finally {
      await sqlite.close();
    }
  });

  it("closes the child without leaving an orphan or payload diagnostics", async () => {
    const diagnostics: unknown[] = [];
    const graph = await host({
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const childPid = graph.processId();
    expect(childPid).toBeTypeOf("number");
    await graph.queryPaths(query("query_diagnostics"));
    await graph.close();
    hosts.splice(hosts.indexOf(graph), 1);
    if (childPid !== null) {
      expect(() => process.kill(childPid, 0)).toThrow();
    }
    expect(JSON.stringify(diagnostics)).not.toContain("memory content");
    expect(JSON.stringify(diagnostics)).not.toContain("MATCH (");
  });
});

const nativeIt =
  process.platform === "darwin" && process.arch === "arm64"
    ? it
    : it.skip;

describe("native graph child recovery", () => {
  nativeIt(
    "kills 100 adversarial native queries by deadline and replaces the child",
    async () => {
      const graph = await host({
        childEntry: new URL(
          "../../packages/graph-projection/dist/ladybug-process.js",
          import.meta.url,
        ),
        expectedIdentity: await installedBackendIdentity(),
        testHooks: {
          adversarialNativeQuery: true,
        },
        restartPolicy: {
          maxRestarts: 100,
          windowMs: 120_000,
          cooldownMs: 250,
        },
      });
      const samples: number[] = [];
      const replacements: number[] = [];
      for (let index = 0; index < 100; index += 1) {
        const started = performance.now();
        const result = await graph.queryPaths(
          query(`adversarial_native_query_${index}`),
        );
        samples.push(performance.now() - started);
        expect(result).toMatchObject({
          status: "unavailable",
          complete: false,
          process_outcome: "deadline_killed",
          reason_codes: ["GRAPH_DEADLINE_EXCEEDED"],
        });
        const replacementStarted = performance.now();
        await expect(graph.waitUntilHealthy(2_000)).resolves.toBe(true);
        replacements.push(performance.now() - replacementStarted);
      }
      samples.sort((left, right) => left - right);
      replacements.sort((left, right) => left - right);
      const p95 =
        samples[Math.ceil(samples.length * 0.95) - 1] ?? Infinity;
      const maximumReplacementMs = replacements.at(-1) ?? Infinity;
      expect(p95).toBeLessThanOrEqual(100);
      expect(maximumReplacementMs).toBeLessThanOrEqual(2_000);
    },
    120_000,
  );

  nativeIt(
    "kills an uncommitted native write and reopens the prior digest",
    async () => {
      const graph = await host({
        childEntry: new URL(
          "../../packages/graph-projection/dist/ladybug-process.js",
          import.meta.url,
        ),
        expectedIdentity: await installedBackendIdentity(),
        writeTimeoutMs: 100,
        testHooks: {
          adversarialNativeWrite: true,
        },
      });
      const committed = snapshot();
      await graph.replaceScope(committed);
      await expect(
        graph.replaceScope(
          snapshot("graph_node_transaction_rollback"),
        ),
      ).rejects.toMatchObject({
        code: "GRAPH_UNKNOWN_WORK",
      });
      await expect(
        graph.readScopeSnapshot({
          principal_id: committed.principal_id,
          scope: committed.scope,
        }),
      ).resolves.toEqual(committed);
      await expect(
        graph.replaceScope(
          snapshot("graph_node_adversarial_native_write"),
        ),
      ).rejects.toMatchObject({
        code: "GRAPH_DEADLINE_EXCEEDED",
      });
      await expect(graph.waitUntilHealthy(2_000)).resolves.toBe(true);
      await expect(
        graph.readScopeSnapshot({
          principal_id: committed.principal_id,
          scope: committed.scope,
        }),
      ).resolves.toEqual(committed);
    },
    30_000,
  );
});
