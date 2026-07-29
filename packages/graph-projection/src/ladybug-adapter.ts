import { createHash } from "node:crypto";
import {
  readFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

import {
  GraphBackendIdentitySchema,
  GraphQueryResultSchema,
  GraphQuerySchema,
  GraphScopeSnapshotSchema,
  buildGraphPathEvidence,
  canonicalJson,
  canonicalSha256,
  scopeKey,
  type GraphBackendIdentity,
  type GraphQueryResult,
  type GraphScopeSnapshot,
  type Scope,
} from "@memo-graph/contracts";
import { z } from "zod";

import {
  GraphStoreError,
} from "./graph-store.js";
import {
  normalizeGraphScopeSnapshot,
} from "./logical-digest.js";

const LADYBUG_MODULE_NAME = "@ladybugdb/core";

type LadybugRow = Record<string, unknown>;

type LadybugQueryResult = {
  getAll(): Promise<LadybugRow[]>;
  close(): void;
};

type LadybugDatabase = {
  init(): Promise<void>;
  close(): Promise<void>;
};

type LadybugConnection = {
  init(): Promise<void>;
  query(statement: string): Promise<
    LadybugQueryResult | LadybugQueryResult[]
  >;
  setMaxNumThreadForExec(threads: number): void;
  setQueryTimeout(timeoutMs: number): void;
  close(): Promise<void>;
};

type LadybugModule = {
  Database: new (path: string) => LadybugDatabase;
  Connection: new (
    database: LadybugDatabase,
    threads?: number,
  ) => LadybugConnection;
  VERSION: string;
  STORAGE_VERSION: string | number;
};

const LadybugModuleSchema = z
  .object({
    Database: z.custom<LadybugModule["Database"]>(
      (value) => typeof value === "function",
    ),
    Connection: z.custom<LadybugModule["Connection"]>(
      (value) => typeof value === "function",
    ),
    VERSION: z.string().trim().min(1),
    STORAGE_VERSION: z.union([
      z.string().trim().min(1),
      z.number().int().nonnegative(),
    ]),
  })
  .passthrough();

const NativePathRowSchema = z
  .object({
    nodes: z.array(
      z.object({
        revision_id: z.string(),
        scope_key: z.string(),
      }).passthrough(),
    ),
    relations: z.array(
      z.object({
        relation_revision_id: z.string(),
        relation_type: z.string(),
        scope_key: z.string(),
      }).passthrough(),
    ),
    depth: z.union([
      z.number().int().nonnegative(),
      z.bigint().nonnegative().transform(Number),
    ]),
  })
  .passthrough();

function quoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function nullableQuoted(value: string | null): string {
  return value === null ? "NULL" : quoted(value);
}

function stringList(values: readonly string[]): string {
  return `[${values.map(quoted).join(",")}]`;
}

function nodeKey(options: {
  principal_id: string;
  scope: Scope;
  revision_id: string;
}): string {
  return `${options.principal_id}:${scopeKey(options.scope)}:${options.revision_id}`;
}

function graphScopeKey(options: {
  principal_id: string;
  scope: Scope;
}): string {
  return `${options.principal_id}:${scopeKey(options.scope)}`;
}

async function loadLadybugModule(): Promise<LadybugModule> {
  try {
    const imported = await import(LADYBUG_MODULE_NAME) as {
      default?: unknown;
    } & Record<string, unknown>;
    const candidate =
      imported.default === undefined ? imported : imported.default;
    return LadybugModuleSchema.parse(candidate) as LadybugModule;
  } catch (error) {
    throw new GraphStoreError(
      "GRAPH_OPTIONAL_DEPENDENCY_MISSING",
      { cause: error },
    );
  }
}

async function nativeBinaryHash(): Promise<string> {
  const require = createRequire(import.meta.url);
  const entry = require.resolve(LADYBUG_MODULE_NAME);
  const binary = join(dirname(entry), "lbugjs.node");
  const bytes = await readFile(binary);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export async function inspectLadybugBackendIdentity(
  dependencyLockHash: string,
): Promise<GraphBackendIdentity> {
  const ladybug = await loadLadybugModule();
  return GraphBackendIdentitySchema.parse({
    schema_version: "1.0.0",
    backend: "ladybugdb",
    package_name: LADYBUG_MODULE_NAME,
    package_version: ladybug.VERSION,
    storage_version: String(ladybug.STORAGE_VERSION),
    platform: process.platform,
    architecture: process.arch,
    native_binary_hash: await nativeBinaryHash(),
    dependency_lock_hash: dependencyLockHash,
  });
}

async function closeResults(
  result: LadybugQueryResult | LadybugQueryResult[],
): Promise<LadybugRow[][]> {
  const results = Array.isArray(result) ? result : [result];
  const rows: LadybugRow[][] = [];
  try {
    for (const item of results) {
      rows.push(await item.getAll());
    }
    return rows;
  } finally {
    for (const item of results) {
      item.close();
    }
  }
}

export class LadybugGraphAdapter {
  readonly #database: LadybugDatabase;
  readonly #connection: LadybugConnection;
  readonly identity: GraphBackendIdentity;
  readonly #testHooks: {
    adversarial_native_query: boolean;
    adversarial_native_write: boolean;
  };
  #closed = false;
  #operationChain: Promise<void> = Promise.resolve();

  private constructor(options: {
    database: LadybugDatabase;
    connection: LadybugConnection;
    identity: GraphBackendIdentity;
    testHooks: {
      adversarial_native_query: boolean;
      adversarial_native_write: boolean;
    };
  }) {
    this.#database = options.database;
    this.#connection = options.connection;
    this.identity = options.identity;
    this.#testHooks = options.testHooks;
  }

  static async open(options: {
    databasePath: string;
    dependencyLockHash: string;
    expectedIdentity: GraphBackendIdentity;
    testHooks?: {
      adversarial_native_query: boolean;
      adversarial_native_write: boolean;
    };
  }): Promise<LadybugGraphAdapter> {
    const ladybug = await loadLadybugModule();
    const identity = await inspectLadybugBackendIdentity(
      options.dependencyLockHash,
    );
    if (
      canonicalJson(identity) !==
      canonicalJson(GraphBackendIdentitySchema.parse(options.expectedIdentity))
    ) {
      throw new GraphStoreError("GRAPH_IDENTITY_MISMATCH");
    }
    const database = new ladybug.Database(options.databasePath);
    const connection = new ladybug.Connection(database, 1);
    try {
      await database.init();
      connection.setMaxNumThreadForExec(1);
      connection.setQueryTimeout(5_000);
      await connection.init();
      return new LadybugGraphAdapter({
        database,
        connection,
        identity,
        testHooks: options.testHooks ?? {
          adversarial_native_query: false,
          adversarial_native_write: false,
        },
      });
    } catch (error) {
      await Promise.allSettled([
        connection.close(),
        database.close(),
      ]);
      throw new GraphStoreError("GRAPH_PROCESS_START_FAILED", {
        cause: error,
        retryable: true,
      });
    }
  }

  async initialize(): Promise<void> {
    await this.#serialized(async () => {
      await this.#execute(`
        CREATE NODE TABLE IF NOT EXISTS GraphRevision(
          node_key STRING PRIMARY KEY,
          graph_node_id STRING,
          revision_id STRING,
          projection_revision_id STRING,
          principal_id STRING,
          scope_key STRING,
          scope_kind STRING,
          scope_id STRING,
          abstraction STRING,
          projection_type STRING,
          lifecycle STRING,
          valid_from STRING,
          valid_to STRING,
          recorded_at STRING,
          ledger_epoch INT64,
          tombstone_epoch INT64,
          projection_epoch INT64,
          content_hash STRING,
          payload_hash STRING,
          transform_name STRING,
          transform_version STRING,
          evidence_ids_json STRING,
          lineage_revision_ids_json STRING
        );
        CREATE REL TABLE IF NOT EXISTS GraphLink(
          FROM GraphRevision TO GraphRevision,
          graph_edge_id STRING,
          relation_id STRING,
          relation_revision_id STRING,
          projection_revision_id STRING,
          relation_type STRING,
          direction STRING,
          principal_id STRING,
          scope_key STRING,
          valid_from STRING,
          valid_to STRING,
          recorded_at STRING,
          ledger_epoch INT64,
          tombstone_epoch INT64,
          projection_epoch INT64,
          content_hash STRING,
          payload_hash STRING,
          transform_name STRING,
          transform_version STRING,
          evidence_ids_json STRING,
          lineage_revision_ids_json STRING
        );
        CREATE NODE TABLE IF NOT EXISTS GraphScope(
          scope_key STRING PRIMARY KEY,
          principal_id STRING,
          scope_kind STRING,
          scope_id STRING,
          logical_digest STRING,
          snapshot_json STRING
        );
      `);
    });
  }

  async replaceScope(input: unknown): Promise<GraphScopeSnapshot> {
    const snapshot = normalizeGraphScopeSnapshot(input);
    return this.#serialized(async () => {
      const key = graphScopeKey(snapshot);
      await this.#transaction(async () => {
        await this.#execute(`
          MATCH (source:GraphRevision)-[edge:GraphLink]->(target:GraphRevision)
          WHERE edge.scope_key = ${quoted(key)}
          DELETE edge;
        `);
        await this.#execute(`
          MATCH (node:GraphRevision)
          WHERE node.scope_key = ${quoted(key)}
          DELETE node;
        `);
        await this.#execute(`
          MATCH (scope:GraphScope)
          WHERE scope.scope_key = ${quoted(key)}
          DELETE scope;
        `);
        if (
          this.#testHooks.adversarial_native_write &&
          snapshot.nodes.some(
            (node) =>
              node.graph_node_id ===
                "graph_node_adversarial_native_write",
          )
        ) {
          this.#connection.setQueryTimeout(5_000);
          await this.#execute(
            "UNWIND range(1, 1000000) AS value RETURN sum(value);",
          );
        }
        if (
          this.#testHooks.adversarial_native_write &&
          snapshot.nodes.some(
            (node) =>
              node.graph_node_id ===
                "graph_node_transaction_rollback",
          )
        ) {
          throw new GraphStoreError("GRAPH_UNKNOWN_WORK");
        }
        for (const node of snapshot.nodes) {
          await this.#execute(`
            CREATE (:GraphRevision {
              node_key: ${quoted(nodeKey(node))},
              graph_node_id: ${quoted(node.graph_node_id)},
              revision_id: ${quoted(node.revision_id)},
              projection_revision_id: ${nullableQuoted(node.projection_revision_id)},
              principal_id: ${quoted(node.principal_id)},
              scope_key: ${quoted(key)},
              scope_kind: ${quoted(node.scope.kind)},
              scope_id: ${quoted(node.scope.id)},
              abstraction: ${quoted(node.abstraction)},
              projection_type: ${nullableQuoted(node.projection_type)},
              lifecycle: ${quoted(node.lifecycle)},
              valid_from: ${quoted(node.validity.valid_from)},
              valid_to: ${nullableQuoted(node.validity.valid_to)},
              recorded_at: ${quoted(node.validity.recorded_at)},
              ledger_epoch: ${node.ledger_epoch},
              tombstone_epoch: ${node.tombstone_epoch},
              projection_epoch: ${node.projection_epoch},
              content_hash: ${quoted(node.content_hash)},
              payload_hash: ${quoted(node.payload_hash)},
              transform_name: ${quoted(node.transform.name)},
              transform_version: ${quoted(node.transform.version)},
              evidence_ids_json: ${quoted(canonicalJson(node.evidence_ids))},
              lineage_revision_ids_json:
                ${quoted(canonicalJson(node.lineage_revision_ids))}
            });
          `);
        }
        for (const edge of snapshot.edges) {
          await this.#execute(`
            MATCH (source:GraphRevision), (target:GraphRevision)
            WHERE source.node_key = ${quoted(nodeKey({
              principal_id: edge.principal_id,
              scope: edge.scope,
              revision_id: edge.source_revision_id,
            }))}
              AND target.node_key = ${quoted(nodeKey({
                principal_id: edge.principal_id,
                scope: edge.scope,
                revision_id: edge.target_revision_id,
              }))}
            CREATE (source)-[:GraphLink {
              graph_edge_id: ${quoted(edge.graph_edge_id)},
              relation_id: ${quoted(edge.relation_id)},
              relation_revision_id: ${quoted(edge.relation_revision_id)},
              projection_revision_id: ${quoted(edge.projection_revision_id)},
              relation_type: ${quoted(edge.relation_type)},
              direction: ${quoted(edge.direction)},
              principal_id: ${quoted(edge.principal_id)},
              scope_key: ${quoted(key)},
              valid_from: ${quoted(edge.validity.valid_from)},
              valid_to: ${nullableQuoted(edge.validity.valid_to)},
              recorded_at: ${quoted(edge.validity.recorded_at)},
              ledger_epoch: ${edge.ledger_epoch},
              tombstone_epoch: ${edge.tombstone_epoch},
              projection_epoch: ${edge.projection_epoch},
              content_hash: ${quoted(edge.content_hash)},
              payload_hash: ${quoted(edge.payload_hash)},
              transform_name: ${quoted(edge.transform.name)},
              transform_version: ${quoted(edge.transform.version)},
              evidence_ids_json: ${quoted(canonicalJson(edge.evidence_ids))},
              lineage_revision_ids_json:
                ${quoted(canonicalJson(edge.lineage_revision_ids))}
            }]->(target);
          `);
        }
        await this.#execute(`
          CREATE (:GraphScope {
            scope_key: ${quoted(key)},
            principal_id: ${quoted(snapshot.principal_id)},
            scope_kind: ${quoted(snapshot.scope.kind)},
            scope_id: ${quoted(snapshot.scope.id)},
            logical_digest: ${quoted(snapshot.logical_digest)},
            snapshot_json: ${quoted(canonicalJson(snapshot))}
          });
        `);
      });
      const readBack = await this.#readScopeSnapshot(snapshot);
      if (
        readBack === null ||
        readBack.logical_digest !== snapshot.logical_digest
      ) {
        throw new GraphStoreError("GRAPH_DIGEST_MISMATCH");
      }
      return readBack;
    });
  }

  async deleteScope(input: {
    principal_id: string;
    scope: Scope;
  }): Promise<void> {
    await this.#serialized(async () => {
      const key = graphScopeKey(input);
      await this.#transaction(async () => {
        await this.#execute(`
          MATCH (source:GraphRevision)-[edge:GraphLink]->(target:GraphRevision)
          WHERE edge.scope_key = ${quoted(key)}
          DELETE edge;
        `);
        await this.#execute(`
          MATCH (node:GraphRevision)
          WHERE node.scope_key = ${quoted(key)}
          DELETE node;
        `);
        await this.#execute(`
          MATCH (scope:GraphScope)
          WHERE scope.scope_key = ${quoted(key)}
          DELETE scope;
        `);
      });
    });
  }

  async readScopeSnapshot(input: {
    principal_id: string;
    scope: Scope;
  }): Promise<GraphScopeSnapshot | null> {
    return this.#serialized(() => this.#readScopeSnapshot(input));
  }

  async queryPaths(input: unknown): Promise<GraphQueryResult> {
    const query = GraphQuerySchema.parse(input);
    return this.#serialized(async () => {
      const startedAt = performance.now();
      if (
        this.#testHooks.adversarial_native_query &&
        query.query_id.startsWith("adversarial_native_query_")
      ) {
        this.#connection.setQueryTimeout(5_000);
        await this.#execute(
          "UNWIND range(1, 1000000) AS value RETURN sum(value);",
        );
      }
      this.#connection.setQueryTimeout(query.parent_deadline_ms);
      const key = graphScopeKey(query);
      const nativePathLimit = Math.min(
        query.max_paths + 1,
        query.max_results + 1,
        query.max_fanout * query.start_revision_ids.length + 1,
      );
      const rows = await this.#rows(`
        MATCH path =
          (start:GraphRevision)-[:GraphLink*1..${query.max_depth}]->
          (target:GraphRevision)
        WHERE start.scope_key = ${quoted(key)}
          AND target.scope_key = ${quoted(key)}
          AND start.revision_id IN ${stringList(query.start_revision_ids)}
        RETURN
          nodes(path) AS nodes,
          relationships(path) AS relations,
          length(path) AS depth
        LIMIT ${nativePathLimit};
      `);
      const allowedRelationRevisionIds = new Set<string>(
        query.allowed_relation_revision_ids,
      );
      const uniquePaths = new Map<string, ReturnType<
        typeof buildGraphPathEvidence
      >>();
      for (const rowInput of rows) {
        const row = NativePathRowSchema.parse(rowInput);
        const nodeRevisionIds = row.nodes.map((node) => node.revision_id);
        const relationRevisionIds = row.relations.map(
          (relation) => relation.relation_revision_id,
        );
        const relationTypes = row.relations.map(
          (relation) => relation.relation_type,
        );
        if (
          row.depth > query.max_depth ||
          row.nodes.some((node) => node.scope_key !== key) ||
          row.relations.some((relation) => relation.scope_key !== key) ||
          relationTypes.some(
            (relationType, index) =>
              relationType !== query.relation_pattern[index],
          ) ||
          relationRevisionIds.some(
            (relationRevisionId) =>
              !allowedRelationRevisionIds.has(relationRevisionId),
          )
        ) {
          continue;
        }
        const path = buildGraphPathEvidence({
          node_revision_ids: nodeRevisionIds,
          relation_revision_ids: relationRevisionIds,
          relation_types: relationTypes,
          depth: row.depth,
        });
        uniquePaths.set(path.path_hash, path);
      }
      let paths = [...uniquePaths.values()].sort(
        (left, right) =>
          left.depth - right.depth ||
          left.path_hash.localeCompare(right.path_hash),
      );
      if (query.mode === "shortest_path" && paths[0] !== undefined) {
        const shortestDepth = paths[0].depth;
        paths = paths.filter((path) => path.depth === shortestDepth);
      }
      const observedCount = paths.length;
      const retainedLimit = Math.min(
        query.max_paths,
        query.max_results,
      );
      const truncated = rows.length >= nativePathLimit ||
        rows.length > query.max_paths ||
        observedCount > retainedLimit;
      paths = paths.slice(0, retainedLimit);
      const elapsedMs = performance.now() - startedAt;
      return GraphQueryResultSchema.parse({
        schema_version: "1.0.0",
        query_id: query.query_id,
        status: truncated ? "degraded" : "complete",
        query_hash: canonicalSha256(query),
        frontier: query.frontier,
        paths,
        elapsed_ms: elapsedMs,
        complete: !truncated,
        reason_codes: truncated ? ["GRAPH_RESULT_LIMIT"] : [],
        process_outcome: "completed",
        bounded_work: [
          {
            boundary: "graph_results",
            configured_limit: retainedLimit,
            observed_count: Math.max(observedCount, rows.length),
            retained_count: paths.length,
            truncated_count:
              Math.max(0, Math.max(observedCount, rows.length) - paths.length),
            complete: !truncated,
            ...(truncated
              ? { reason_code: "GRAPH_RESULT_LIMIT" }
              : {}),
          },
          {
            boundary: "graph_wall_clock",
            configured_limit: query.parent_deadline_ms,
            observed_count: Math.ceil(elapsedMs),
            retained_count: Math.min(
              Math.ceil(elapsedMs),
              query.parent_deadline_ms,
            ),
            truncated_count: Math.max(
              0,
              Math.ceil(elapsedMs) - query.parent_deadline_ms,
            ),
            complete: elapsedMs <= query.parent_deadline_ms,
            ...(elapsedMs > query.parent_deadline_ms
              ? { reason_code: "GRAPH_DEADLINE_EXCEEDED" }
              : {}),
          },
        ],
      });
    });
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#operationChain.catch(() => undefined);
    await Promise.allSettled([
      this.#connection.close(),
      this.#database.close(),
    ]);
  }

  async #readScopeSnapshot(input: {
    principal_id: string;
    scope: Scope;
  }): Promise<GraphScopeSnapshot | null> {
    const rows = await this.#rows(`
      MATCH (scope:GraphScope)
      WHERE scope.scope_key = ${quoted(graphScopeKey(input))}
      RETURN scope.snapshot_json AS snapshot_json
      LIMIT 1;
    `);
    const row = z
      .object({ snapshot_json: z.string() })
      .passthrough()
      .optional()
      .parse(rows[0]);
    if (row === undefined) {
      return null;
    }
    return GraphScopeSnapshotSchema.parse(
      JSON.parse(row.snapshot_json) as unknown,
    );
  }

  async #transaction(work: () => Promise<void>): Promise<void> {
    await this.#execute("BEGIN TRANSACTION;");
    try {
      await work();
      await this.#execute("COMMIT;");
    } catch (error) {
      await this.#execute("ROLLBACK;").catch(() => undefined);
      throw error;
    }
  }

  async #execute(statement: string): Promise<void> {
    await closeResults(await this.#connection.query(statement));
  }

  async #rows(statement: string): Promise<LadybugRow[]> {
    const results = await closeResults(
      await this.#connection.query(statement),
    );
    return results.flat();
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed) {
      return Promise.reject(
        new GraphStoreError("GRAPH_CHILD_EXITED"),
      );
    }
    const result = this.#operationChain.then(operation);
    this.#operationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
