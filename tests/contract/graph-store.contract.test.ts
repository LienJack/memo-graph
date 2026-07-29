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

import { describe, expect, it } from "vitest";

import {
  GraphBackendIdentitySchema,
  GraphDeliveryReceiptSchema,
  GraphProcessHealthSchema,
  GraphQueryResultSchema,
  GraphQuerySchema,
  GraphScopeCheckpointSchema,
  GraphScopeSnapshotSchema,
  buildGraphPathEvidence,
  buildGraphScopeSnapshot,
} from "../../packages/contracts/src/index.js";
import {
  GraphProcessHost,
} from "../../packages/graph-projection/src/index.js";
import {
  HASH_A,
  HASH_B,
  LATER,
  NOW,
  USER_SCOPE,
} from "../helpers/examples.js";

const HASH_C = `sha256:${"c".repeat(64)}` as const;
const HASH_D = `sha256:${"d".repeat(64)}` as const;

const BACKEND_IDENTITY = {
  schema_version: "1.0.0",
  backend: "ladybugdb",
  package_name: "@ladybugdb/core",
  package_version: "0.18.3",
  storage_version: "42",
  platform: "darwin",
  architecture: "arm64",
  native_binary_hash: HASH_A,
  dependency_lock_hash: HASH_B,
} as const;

const TRANSFORM = {
  name: "deterministic-g3-projection",
  version: "1.0.0",
} as const;

const FRONTIER = {
  schema_version: "1.0.0",
  ledger_epoch: 10,
  tombstone_epoch: 2,
  projection_epoch: 4,
  transform: TRANSFORM,
  source_frontier_hash: HASH_A,
  projection_frontier_hash: HASH_B,
} as const;

async function installedBackendIdentity() {
  const require = createRequire(import.meta.url);
  const entry = require.resolve("@ladybugdb/core");
  const binary = await readFile(join(dirname(entry), "lbugjs.node"));
  const lockfile = await readFile(
    new URL("../../pnpm-lock.yaml", import.meta.url),
  );
  return GraphBackendIdentitySchema.parse({
    schema_version: "1.0.0",
    backend: "ladybugdb",
    package_name: "@ladybugdb/core",
    package_version: "0.18.3",
    storage_version: "42",
    platform: process.platform,
    architecture: process.arch,
    native_binary_hash:
      `sha256:${createHash("sha256").update(binary).digest("hex")}`,
    dependency_lock_hash:
      `sha256:${createHash("sha256").update(lockfile).digest("hex")}`,
  });
}

const VALIDITY = {
  valid_from: NOW,
  valid_to: LATER,
  recorded_at: NOW,
} as const;

const NODE_A = {
  schema_version: "1.0.0",
  graph_node_id: "graph_node_a",
  revision_id: "revision_a",
  projection_revision_id: "projection_revision_a",
  principal_id: "user_local",
  scope: USER_SCOPE,
  abstraction: "l2_topic",
  projection_type: "topic",
  lifecycle: "active",
  validity: VALIDITY,
  ledger_epoch: 10,
  tombstone_epoch: 2,
  projection_epoch: 4,
  content_hash: HASH_A,
  payload_hash: HASH_B,
  transform: TRANSFORM,
  evidence_ids: ["evidence_a"],
  lineage_revision_ids: ["revision_source_a"],
} as const;

const NODE_B = {
  ...NODE_A,
  graph_node_id: "graph_node_b",
  revision_id: "revision_b",
  projection_revision_id: "projection_revision_b",
  abstraction: "l2_scenario",
  projection_type: "scenario",
  content_hash: HASH_C,
  payload_hash: HASH_D,
  evidence_ids: ["evidence_b"],
  lineage_revision_ids: ["revision_source_b"],
} as const;

const EDGE = {
  schema_version: "1.0.0",
  graph_edge_id: "graph_edge_a_b",
  relation_id: "relation_a_b",
  relation_revision_id: "relation_revision_a_b",
  projection_revision_id: "projection_relation_a_b",
  source_revision_id: NODE_A.revision_id,
  target_revision_id: NODE_B.revision_id,
  relation_type: "supports",
  direction: "directed",
  principal_id: "user_local",
  scope: USER_SCOPE,
  validity: VALIDITY,
  ledger_epoch: 10,
  tombstone_epoch: 2,
  projection_epoch: 4,
  content_hash: HASH_C,
  payload_hash: HASH_D,
  transform: TRANSFORM,
  evidence_ids: ["evidence_a", "evidence_b"],
  lineage_revision_ids: ["revision_source_a", "revision_source_b"],
} as const;

const EDGE_2 = {
  ...EDGE,
  graph_edge_id: "graph_edge_b_a",
  relation_id: "relation_b_a",
  relation_revision_id: "relation_revision_b_a",
  projection_revision_id: "projection_relation_b_a",
  source_revision_id: NODE_B.revision_id,
  target_revision_id: NODE_A.revision_id,
  relation_type: "depends_on",
} as const;

function snapshot(
  nodes: readonly unknown[] = [NODE_A, NODE_B],
  edges: readonly unknown[] = [EDGE],
) {
  return {
    schema_version: "1.0.0",
    backend: "ladybugdb",
    principal_id: "user_local",
    scope: USER_SCOPE,
    frontier: FRONTIER,
    nodes: [...nodes],
    edges: [...edges],
  } as const;
}

describe("graph projection contracts", () => {
  it("builds one canonical logical snapshot independent of physical order", () => {
    const forward = buildGraphScopeSnapshot(snapshot());
    const reversed = buildGraphScopeSnapshot(
      snapshot([NODE_B, NODE_A], [EDGE_2, EDGE]),
    );
    const forwardWithTwoEdges = buildGraphScopeSnapshot(
      snapshot([NODE_A, NODE_B], [EDGE, EDGE_2]),
    );

    expect(forwardWithTwoEdges).toEqual(reversed);
    expect(forward.nodes.map((node) => node.revision_id)).toEqual([
      "revision_b",
      "revision_a",
    ]);
    expect(forward.logical_digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(GraphScopeSnapshotSchema.parse(forward)).toEqual(forward);
  });

  it("changes the logical digest when governed graph meaning changes", () => {
    const original = buildGraphScopeSnapshot(snapshot());
    const otherScope = {
      kind: "workspace",
      id: "workspace_other",
    } as const;
    const changedScope = buildGraphScopeSnapshot({
      ...snapshot(
        [
          { ...NODE_A, scope: otherScope },
          { ...NODE_B, scope: otherScope },
        ],
        [{ ...EDGE, scope: otherScope }],
      ),
      scope: otherScope,
    });
    const changedDirection = buildGraphScopeSnapshot(
      snapshot(
        [NODE_A, NODE_B],
        [{ ...EDGE, direction: "undirected" as const }],
      ),
    );
    const changedLineage = buildGraphScopeSnapshot(
      snapshot(
        [
          NODE_A,
          {
            ...NODE_B,
            lineage_revision_ids: ["revision_source_c"],
          },
        ],
        [EDGE],
      ),
    );
    const changedValidity = buildGraphScopeSnapshot(
      snapshot(
        [NODE_A, { ...NODE_B, validity: { ...VALIDITY, valid_to: null } }],
        [EDGE],
      ),
    );
    const changedHash = buildGraphScopeSnapshot(
      snapshot([NODE_A, { ...NODE_B, content_hash: HASH_D }], [EDGE]),
    );

    expect(changedScope.logical_digest).not.toBe(original.logical_digest);
    expect(changedDirection.logical_digest).not.toBe(original.logical_digest);
    expect(changedValidity.logical_digest).not.toBe(original.logical_digest);
    expect(changedHash.logical_digest).not.toBe(original.logical_digest);
    expect(changedLineage.logical_digest).not.toBe(original.logical_digest);
  });

  it("rejects content, duplicate identity, cross-scope state, and dangling edges", () => {
    expect(
      GraphScopeSnapshotSchema.safeParse({
        ...buildGraphScopeSnapshot(snapshot()),
        nodes: [{ ...NODE_A, rendered_content: "secret" }, NODE_B],
      }).success,
    ).toBe(false);
    expect(
      GraphScopeSnapshotSchema.safeParse({
        ...buildGraphScopeSnapshot(snapshot()),
        nodes: [NODE_A, NODE_A],
      }).success,
    ).toBe(false);
    expect(
      GraphScopeSnapshotSchema.safeParse({
        ...buildGraphScopeSnapshot(snapshot()),
        nodes: [
          NODE_A,
          { ...NODE_B, graph_node_id: NODE_A.graph_node_id },
        ],
      }).success,
    ).toBe(false);
    expect(
      GraphScopeSnapshotSchema.safeParse({
        ...buildGraphScopeSnapshot(snapshot()),
        edges: [
          EDGE,
          {
            ...EDGE,
            graph_edge_id: "graph_edge_duplicate_relation",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      GraphScopeSnapshotSchema.safeParse({
        ...buildGraphScopeSnapshot(snapshot()),
        nodes: [
          {
            ...NODE_A,
            evidence_ids: ["evidence_a", "evidence_a"],
          },
          NODE_B,
        ],
      }).success,
    ).toBe(false);
    expect(
      GraphScopeSnapshotSchema.safeParse({
        ...buildGraphScopeSnapshot(snapshot()),
        edges: [
          {
            ...EDGE,
            lineage_revision_ids: [
              "revision_source_a",
              "revision_source_a",
            ],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      GraphScopeSnapshotSchema.safeParse({
        ...buildGraphScopeSnapshot(snapshot()),
        nodes: [
          NODE_A,
          {
            ...NODE_B,
            scope: { kind: "workspace", id: "other_workspace" },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      GraphScopeSnapshotSchema.safeParse({
        ...buildGraphScopeSnapshot(snapshot()),
        edges: [{ ...EDGE, target_revision_id: "revision_missing" }],
      }).success,
    ).toBe(false);
  });

  it("rejects invalid or frontier-mismatched governed state", () => {
    expect(() =>
      buildGraphScopeSnapshot(
        snapshot([
          { ...NODE_A, principal_id: "user_other" },
          NODE_B,
        ]),
      )
    ).toThrow(/exact snapshot principal/u);
    expect(() =>
      buildGraphScopeSnapshot(
        snapshot([
          { ...NODE_A, ledger_epoch: FRONTIER.ledger_epoch + 1 },
          NODE_B,
        ]),
      )
    ).toThrow(/epochs must match/u);
    expect(() =>
      buildGraphScopeSnapshot(
        snapshot([
          {
            ...NODE_A,
            transform: { ...TRANSFORM, version: "2.0.0" },
          },
          NODE_B,
        ]),
      )
    ).toThrow(/transform must match/u);
    expect(() =>
      buildGraphScopeSnapshot(
        snapshot([
          {
            ...NODE_A,
            validity: {
              ...VALIDITY,
              valid_to: "2026-07-27T00:00:00.000Z",
            },
          },
          NODE_B,
        ]),
      )
    ).toThrow(/valid_to must not precede valid_from/u);
    expect(() =>
      buildGraphScopeSnapshot(
        snapshot([
          {
            ...NODE_A,
            lifecycle: "unknown",
          },
          NODE_B,
        ]),
      )
    ).toThrow();
    expect(() =>
      buildGraphScopeSnapshot(
        snapshot([
          {
            ...NODE_A,
            content_hash: "sha256:not-a-valid-hash",
          },
          NODE_B,
        ]),
      )
    ).toThrow();
  });
});

describe("bounded graph query contracts", () => {
  const query = {
    schema_version: "1.0.0",
    query_id: "graph_query_1",
    backend: "ladybugdb",
    principal_id: "user_local",
    scope: USER_SCOPE,
    as_of: NOW,
    frontier: FRONTIER,
    mode: "typed_path",
    start_revision_ids: [NODE_A.revision_id],
    allowed_relation_revision_ids: [EDGE.relation_revision_id],
    relation_pattern: ["supports"],
    max_depth: 2,
    max_fanout: 10,
    max_paths: 4,
    max_results: 4,
    max_relation_allowlist: 100,
    parent_deadline_ms: 75,
  } as const;

  it("accepts only closed bounded query operations", () => {
    expect(GraphQuerySchema.safeParse(query).success).toBe(true);
    for (const requiredBound of [
      "start_revision_ids",
      "max_depth",
      "max_fanout",
      "max_paths",
      "max_results",
      "max_relation_allowlist",
      "parent_deadline_ms",
    ] as const) {
      const unbounded = { ...query } as Record<string, unknown>;
      delete unbounded[requiredBound];
      expect(
        GraphQuerySchema.safeParse(unbounded).success,
        `${requiredBound} must be explicit`,
      ).toBe(false);
    }
    expect(
      GraphQuerySchema.safeParse({ ...query, cypher: "MATCH (n) RETURN n" })
        .success,
    ).toBe(false);
    expect(
      GraphQuerySchema.safeParse({ ...query, database_path: "/tmp/graph" })
        .success,
    ).toBe(false);
    expect(
      GraphQuerySchema.safeParse({
        ...query,
        graph_path: ["revision_untrusted"],
      }).success,
    ).toBe(false);
    expect(
      GraphQuerySchema.safeParse({
        ...query,
        symlink_target: "/outside/data-root",
      }).success,
    ).toBe(false);
    expect(
      GraphQuerySchema.safeParse({ ...query, max_depth: 5 }).success,
    ).toBe(false);
    expect(
      GraphQuerySchema.safeParse({
        ...query,
        max_relation_allowlist: 100_001,
      }).success,
    ).toBe(false);
    expect(
      GraphQuerySchema.safeParse({
        ...query,
        relation_pattern: ["supports", "depends_on", "precedes"],
        max_depth: 2,
      }).success,
    ).toBe(false);
  });

  it("requires exact path identity and honest incomplete outcomes", () => {
    const complete = {
      schema_version: "1.0.0",
      query_id: query.query_id,
      status: "complete",
      query_hash: HASH_A,
      frontier: FRONTIER,
      paths: [
        buildGraphPathEvidence({
          node_revision_ids: [NODE_A.revision_id, NODE_B.revision_id],
          relation_revision_ids: [EDGE.relation_revision_id],
          relation_types: ["supports"],
          depth: 1,
        }),
      ],
      elapsed_ms: 12,
      complete: true,
      reason_codes: [],
      process_outcome: "completed",
    } as const;
    expect(GraphQueryResultSchema.safeParse(complete).success).toBe(true);
    expect(
      GraphQueryResultSchema.safeParse({
        ...complete,
        paths: [
          {
            ...complete.paths[0],
            relation_revision_ids: [],
          },
        ],
      }).success,
    ).toBe(false);
    expect(() =>
      buildGraphPathEvidence({
        node_revision_ids: [
          NODE_A.revision_id,
          NODE_B.revision_id,
          NODE_A.revision_id,
        ],
        relation_revision_ids: ["relation_revision_1", "relation_revision_2"],
        relation_types: ["supports", "depends_on"],
        depth: 2,
      })
    ).toThrow();
    expect(
      GraphQueryResultSchema.safeParse({
        ...complete,
        status: "degraded",
        complete: false,
      }).success,
    ).toBe(false);
    expect(
      GraphQueryResultSchema.safeParse({
        ...complete,
        status: "degraded",
        complete: false,
        reason_codes: ["GRAPH_RESULT_LIMIT"],
        process_outcome: "completed",
      }).success,
    ).toBe(true);
    expect(
      GraphQueryResultSchema.safeParse({
        ...complete,
        process_outcome: "deadline_killed",
      }).success,
    ).toBe(false);
    expect(
      GraphQueryResultSchema.safeParse({
        ...complete,
        bounded_work: [
          {
            boundary: "graph_results",
            configured_limit: 4,
            observed_count: 5,
            retained_count: 4,
            truncated_count: 1,
            complete: false,
            reason_code: "GRAPH_RESULT_LIMIT",
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("graph identity, health, checkpoint, and delivery evidence", () => {
  it("keeps backend identity content-free and exact", () => {
    expect(GraphBackendIdentitySchema.safeParse(BACKEND_IDENTITY).success).toBe(
      true,
    );
    expect(
      GraphBackendIdentitySchema.safeParse({
        ...BACKEND_IDENTITY,
        memory_text: "not allowed",
      }).success,
    ).toBe(false);
  });

  it("requires ready health and checkpoints to carry verified identity", () => {
    expect(
      GraphProcessHealthSchema.safeParse({
        schema_version: "1.0.0",
        status: "ready",
        backend_identity: BACKEND_IDENTITY,
        process_generation: 1,
        restart_count: 0,
        queue_depth: 0,
        active_requests: 0,
        database_path_hash: HASH_C,
        circuit_open_until: null,
        last_failure: null,
      }).success,
    ).toBe(true);
    expect(
      GraphProcessHealthSchema.safeParse({
        schema_version: "1.0.0",
        status: "ready",
        backend_identity: null,
        process_generation: 1,
        restart_count: 0,
        queue_depth: 0,
        active_requests: 0,
        database_path_hash: HASH_C,
        circuit_open_until: null,
        last_failure: null,
      }).success,
    ).toBe(false);

    const checkpoint = {
      schema_version: "1.0.0",
      backend: "ladybugdb",
      principal_id: "user_local",
      scope: USER_SCOPE,
      status: "ready",
      frontier: FRONTIER,
      graph_projection_epoch: 4,
      logical_digest: HASH_C,
      backend_identity: BACKEND_IDENTITY,
      updated_at: NOW,
      last_failure: null,
    } as const;
    expect(GraphScopeCheckpointSchema.safeParse(checkpoint).success).toBe(true);
    expect(
      GraphScopeCheckpointSchema.safeParse({
        ...checkpoint,
        logical_digest: null,
      }).success,
    ).toBe(false);
  });

  it("binds graph delivery receipts to frontier, digest, and counts", () => {
    expect(
      GraphDeliveryReceiptSchema.safeParse({
        schema_version: "1.0.0",
        receipt_id: "graph_delivery_receipt_1",
        job_id: "graph_delivery_job_1",
        operation: "scope_replace",
        backend: "ladybugdb",
        principal_id: "user_local",
        scope: USER_SCOPE,
        status: "applied",
        previous_frontier: null,
        resulting_frontier: FRONTIER,
        logical_digest: HASH_C,
        backend_identity: BACKEND_IDENTITY,
        node_count: 2,
        edge_count: 1,
        duration_ms: 12,
        completed_at: NOW,
        failure_code: null,
      }).success,
    ).toBe(true);
    expect(
      GraphDeliveryReceiptSchema.safeParse({
        schema_version: "1.0.0",
        receipt_id: "graph_delivery_receipt_2",
        job_id: "graph_delivery_job_2",
        operation: "full_rebuild",
        backend: "ladybugdb",
        principal_id: "user_local",
        scope: USER_SCOPE,
        status: "failed",
        previous_frontier: FRONTIER,
        resulting_frontier: FRONTIER,
        logical_digest: HASH_C,
        backend_identity: BACKEND_IDENTITY,
        node_count: 2,
        edge_count: 1,
        duration_ms: 12,
        completed_at: NOW,
        failure_code: null,
      }).success,
    ).toBe(false);
    expect(
      GraphDeliveryReceiptSchema.safeParse({
        schema_version: "1.0.0",
        receipt_id: "graph_delivery_receipt_3",
        job_id: "graph_delivery_job_3",
        operation: "full_rebuild",
        backend: "ladybugdb",
        principal_id: "user_local",
        scope: USER_SCOPE,
        status: "failed",
        previous_frontier: FRONTIER,
        resulting_frontier: FRONTIER,
        logical_digest: HASH_C,
        backend_identity: BACKEND_IDENTITY,
        node_count: 2,
        edge_count: 1,
        duration_ms: 12,
        completed_at: NOW,
        failure_code: "GRAPH_DIGEST_MISMATCH",
      }).success,
    ).toBe(false);
    expect(
      GraphDeliveryReceiptSchema.safeParse({
        schema_version: "1.0.0",
        receipt_id: "graph_delivery_receipt_4",
        job_id: "graph_delivery_job_4",
        operation: "full_rebuild",
        backend: "ladybugdb",
        principal_id: "user_local",
        scope: USER_SCOPE,
        status: "failed",
        previous_frontier: FRONTIER,
        resulting_frontier: null,
        logical_digest: null,
        backend_identity: null,
        node_count: 0,
        edge_count: 0,
        duration_ms: 12,
        completed_at: NOW,
        failure_code: "GRAPH_DIGEST_MISMATCH",
      }).success,
    ).toBe(true);
  });
});

const nativeIt =
  process.platform === "darwin" && process.arch === "arm64"
    ? it
    : it.skip;

describe("process-isolated LadybugDB GraphStore", () => {
  nativeIt(
    "creates, replaces, queries, closes, reopens, and deletes one exact scope",
    async () => {
      const root = await mkdtemp(
        join(await realpath(tmpdir()), "memo-graph-native-contract-"),
      );
      const childEntry = new URL(
        "../../packages/graph-projection/dist/ladybug-process.js",
        import.meta.url,
      );
      const expectedIdentity = await installedBackendIdentity();
      const canonical = buildGraphScopeSnapshot(snapshot());
      const query = GraphQuerySchema.parse({
        schema_version: "1.0.0",
        query_id: "graph_native_contract_query",
        backend: "ladybugdb",
        principal_id: canonical.principal_id,
        scope: canonical.scope,
        as_of: NOW,
        frontier: canonical.frontier,
        mode: "typed_path",
        start_revision_ids: [NODE_A.revision_id],
        allowed_relation_revision_ids: [EDGE.relation_revision_id],
        relation_pattern: ["supports"],
        max_depth: 1,
        max_fanout: 10,
        max_paths: 4,
        max_results: 4,
        max_relation_allowlist: 100,
        parent_deadline_ms: 1_000,
      });
      let graph: GraphProcessHost | null = null;
      try {
        graph = await GraphProcessHost.open({
          dataRoot: root,
          childEntry,
          expectedIdentity,
          requestTimeoutMs: 1_000,
          writeTimeoutMs: 5_000,
        });
        await expect(graph.health()).resolves.toMatchObject({
          status: "ready",
          backend_identity: expectedIdentity,
        });
        let contender: GraphProcessHost | null = null;
        try {
          contender = await GraphProcessHost.open({
            dataRoot: root,
            childEntry,
            expectedIdentity,
            startupTimeoutMs: 1_000,
          });
        } catch {
          // The active read/write native owner must exclude this process.
        } finally {
          await contender?.close();
        }
        expect(contender).toBeNull();
        await expect(
          Promise.all([
            graph.replaceScope(canonical),
            graph.replaceScope(canonical),
          ]),
        ).resolves.toEqual([canonical, canonical]);
        await expect(
          graph.readScopeSnapshot({
            principal_id: canonical.principal_id,
            scope: canonical.scope,
          }),
        ).resolves.toEqual(canonical);
        const queryResult = await graph.queryPaths(query);
        expect(
          queryResult,
          JSON.stringify(queryResult),
        ).toMatchObject({
          status: "complete",
          complete: true,
          paths: [
            {
              node_revision_ids: [
                NODE_A.revision_id,
                NODE_B.revision_id,
              ],
              relation_revision_ids: [EDGE.relation_revision_id],
              relation_types: ["supports"],
              depth: 1,
            },
          ],
        });

        await graph.close();
        graph = await GraphProcessHost.open({
          dataRoot: root,
          childEntry,
          expectedIdentity,
          requestTimeoutMs: 1_000,
          writeTimeoutMs: 5_000,
        });
        await expect(
          graph.readScopeSnapshot({
            principal_id: canonical.principal_id,
            scope: canonical.scope,
          }),
        ).resolves.toEqual(canonical);
        await graph.deleteScope({
          principal_id: canonical.principal_id,
          scope: canonical.scope,
        });
        await expect(
          graph.readScopeSnapshot({
            principal_id: canonical.principal_id,
            scope: canonical.scope,
          }),
        ).resolves.toBeNull();
      } finally {
        await graph?.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
