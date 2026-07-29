import {
  buildGraphScopeSnapshot,
  canonicalJson,
  canonicalSha256,
  scopeKey,
  type GraphScopeSnapshot,
} from "@memo-graph/contracts";

export function normalizeGraphScopeSnapshot(
  input: unknown,
): GraphScopeSnapshot {
  if (
    typeof input === "object" &&
    input !== null &&
    "logical_digest" in input
  ) {
    const snapshot = {
      ...(input as GraphScopeSnapshot),
    } as Partial<GraphScopeSnapshot>;
    delete snapshot.logical_digest;
    return buildGraphScopeSnapshot(snapshot);
  }
  return buildGraphScopeSnapshot(input);
}

export function graphLogicalDigest(
  input: unknown,
): GraphScopeSnapshot["logical_digest"] {
  return normalizeGraphScopeSnapshot(input).logical_digest;
}

export function normalizeGraphScopeSnapshots(
  input: readonly unknown[],
): GraphScopeSnapshot[] {
  const snapshots = input
    .map((snapshot) => normalizeGraphScopeSnapshot(snapshot))
    .sort((left, right) =>
      canonicalJson([
        left.backend,
        left.principal_id,
        scopeKey(left.scope),
      ]).localeCompare(
        canonicalJson([
          right.backend,
          right.principal_id,
          scopeKey(right.scope),
        ]),
      )
    );
  const identities = snapshots.map((snapshot) =>
    canonicalJson([
      snapshot.backend,
      snapshot.principal_id,
      scopeKey(snapshot.scope),
    ])
  );
  if (new Set(identities).size !== identities.length) {
    throw new Error("graph scope snapshots must have unique identities");
  }
  return snapshots;
}

export function graphGlobalLogicalDigest(
  input: readonly unknown[],
): ReturnType<typeof canonicalSha256> {
  const snapshots = normalizeGraphScopeSnapshots(input);
  return canonicalSha256({
    schema_version: "1.0.0",
    scopes: snapshots.map((snapshot) => ({
      backend: snapshot.backend,
      principal_id: snapshot.principal_id,
      scope: snapshot.scope,
      logical_digest: snapshot.logical_digest,
      node_count: snapshot.nodes.length,
      edge_count: snapshot.edges.length,
    })),
  });
}
