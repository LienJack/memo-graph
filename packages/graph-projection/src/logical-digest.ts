import {
  buildGraphScopeSnapshot,
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
