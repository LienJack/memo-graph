import {
  GraphBackendIdentitySchema,
  GraphProcessHealthSchema,
  type GraphQuery,
  type GraphScopeSnapshot,
  type Scope,
} from "../../packages/contracts/src/index.js";
import {
  ExactScopeGraphProjector,
  queryGraphSnapshotReference,
  type GraphStore,
} from "../../packages/graph-projection/src/index.js";
import type {
  SqliteStorageClient,
} from "@memo-graph/storage-sqlite";

export const TEST_GRAPH_IDENTITY = GraphBackendIdentitySchema.parse({
  schema_version: "1.0.0",
  backend: "ladybugdb",
  package_name: "@ladybugdb/core",
  package_version: "0.18.3",
  storage_version: "42",
  platform: process.platform,
  architecture: process.arch,
  native_binary_hash: `sha256:${"a".repeat(64)}`,
  dependency_lock_hash: `sha256:${"b".repeat(64)}`,
});

function key(principalId: string, scope: Scope): string {
  return `${principalId}:${scope.kind}:${scope.id}`;
}

export class InMemoryGraphStore implements GraphStore {
  readonly snapshots = new Map<string, GraphScopeSnapshot>();
  queryCount = 0;

  async health() {
    return GraphProcessHealthSchema.parse({
      schema_version: "1.0.0",
      status: "ready",
      backend_identity: TEST_GRAPH_IDENTITY,
      process_generation: 1,
      restart_count: 0,
      queue_depth: 0,
      active_requests: 0,
      database_path_hash: `sha256:${"c".repeat(64)}`,
      circuit_open_until: null,
      last_failure: null,
    });
  }

  async replaceScope(input: unknown): Promise<GraphScopeSnapshot> {
    const snapshot = input as GraphScopeSnapshot;
    this.snapshots.set(
      key(snapshot.principal_id, snapshot.scope),
      snapshot,
    );
    return snapshot;
  }

  async deleteScope(input: {
    principal_id: string;
    scope: Scope;
  }): Promise<void> {
    this.snapshots.delete(key(input.principal_id, input.scope));
  }

  async readScopeSnapshot(input: {
    principal_id: string;
    scope: Scope;
  }): Promise<GraphScopeSnapshot | null> {
    return this.snapshots.get(key(input.principal_id, input.scope)) ?? null;
  }

  async queryPaths(input: unknown) {
    const query = input as GraphQuery;
    const snapshot = this.snapshots.get(
      key(query.principal_id, query.scope),
    );
    if (snapshot === undefined) {
      throw new Error("in-memory graph scope is missing");
    }
    this.queryCount += 1;
    return queryGraphSnapshotReference({ snapshot, query });
  }

  async close(): Promise<void> {
    this.snapshots.clear();
  }
}

export async function projectAllReady(options: {
  storage: SqliteStorageClient;
  store: GraphStore;
  workerId: string;
  completedAt?: string;
}) {
  return await new ExactScopeGraphProjector({
    storage: options.storage,
    store: options.store,
    workerId: options.workerId,
    clock: () =>
      new Date(options.completedAt ?? "2026-07-29T10:00:00.000Z"),
  }).drain();
}
