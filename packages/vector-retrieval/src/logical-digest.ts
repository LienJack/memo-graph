import {
  VectorScopeSnapshotSchema,
  buildVectorScopeSnapshot,
  type VectorScopeSnapshot,
} from "@memo-graph/contracts";

export function normalizeVectorScopeSnapshot(
  input: unknown,
): VectorScopeSnapshot {
  if (
    typeof input === "object" &&
    input !== null &&
    "logical_digest" in input
  ) {
    const parsed = VectorScopeSnapshotSchema.parse(input);
    return buildVectorScopeSnapshot({
      schema_version: parsed.schema_version,
      principal_id: parsed.principal_id,
      scope: parsed.scope,
      embedding_epoch_id: parsed.embedding_epoch_id,
      generation_id: parsed.generation_id,
      frontier: parsed.frontier,
      records: parsed.records,
    });
  }
  return buildVectorScopeSnapshot(
    input as Parameters<typeof buildVectorScopeSnapshot>[0],
  );
}

export function vectorLogicalDigest(
  input: unknown,
): VectorScopeSnapshot["logical_digest"] {
  return normalizeVectorScopeSnapshot(input).logical_digest;
}

export function parseVectorScopeSnapshot(
  input: unknown,
): VectorScopeSnapshot {
  return VectorScopeSnapshotSchema.parse(input);
}
