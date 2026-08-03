import { describe, expect, it } from "vitest";

import {
  VectorEmbeddingEpochSchema,
  VectorQueryResultSchema,
  VectorQuerySchema,
  VectorScopeSnapshotSchema,
  VectorSelectionEvidenceSchema,
  buildVectorEmbeddingEpoch,
  buildVectorScopeSnapshot,
  canonicalSha256Omitting,
} from "../../packages/contracts/src/index.js";

const H = (character: string): `sha256:${string}` =>
  `sha256:${character.repeat(64)}`;

function epochInput() {
  return {
    schema_version: "1.0.0" as const,
    runtime: {
      package_name: "@huggingface/transformers" as const,
      package_version: "4.2.0",
    },
    sqlite_binding: {
      package_name: "better-sqlite3" as const,
      package_version: "13.0.1",
    },
    model: {
      repository: "Xenova/multilingual-e5-small" as const,
      revision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78",
      files: [
        { path: "config.json" as const, sha256: H("a") },
        {
          path: "onnx/model_int8.onnx" as const,
          sha256: H("b"),
        },
        { path: "tokenizer.json" as const, sha256: H("c") },
        {
          path: "tokenizer_config.json" as const,
          sha256: H("d"),
        },
      ],
      onnx_artifact: "onnx/model_int8.onnx" as const,
      dimensions: 384 as const,
      dtype: "int8" as const,
      pooling: "mean" as const,
      normalization: "l2" as const,
      query_prefix: "query: " as const,
      passage_prefix: "passage: " as const,
      max_tokens: 512 as const,
    },
    index: {
      package_name: "sqlite-vec" as const,
      package_version: "0.1.9",
      algorithm: "flat" as const,
      metric: "cosine" as const,
    },
    projection_schema_version: "1.0.0" as const,
    dependency_lock_hash: H("e"),
  };
}

function vector(value = 1 / Math.sqrt(384)): number[] {
  return Array.from({ length: 384 }, () => value);
}

describe("vector adoption contracts", () => {
  it("builds one immutable pinned embedding epoch", () => {
    const epoch = buildVectorEmbeddingEpoch(epochInput());
    expect(VectorEmbeddingEpochSchema.parse(epoch)).toEqual(epoch);
    expect(epoch.epoch_id).toBe(
      canonicalSha256Omitting(epoch, ["epoch_id"]),
    );

    expect(() =>
      VectorEmbeddingEpochSchema.parse({
        ...epoch,
        model: {
          ...epoch.model,
          files: epoch.model.files.map((file) =>
            file.path === "tokenizer.json"
              ? { ...file, sha256: H("f") }
              : file,
          ),
        },
      }),
    ).toThrow();
    expect(() =>
      buildVectorEmbeddingEpoch({
        ...epochInput(),
        model: {
          ...epochInput().model,
          dimensions: 768 as 384,
        },
      }),
    ).toThrow();
  });

  it("builds a canonical non-content vector snapshot", () => {
    const epoch = buildVectorEmbeddingEpoch(epochInput());
    const input = {
      schema_version: "1.0.0" as const,
      principal_id: "principal_local",
      scope: { kind: "workspace" as const, id: "workspace_local" },
      embedding_epoch_id: epoch.epoch_id,
      generation_id: "generation_1",
      frontier: {
        ledger_epoch: 4,
        tombstone_epoch: 2,
        source_frontier_hash: H("1"),
        next_validity_transition_at: null,
      },
      records: [
        {
          schema_version: "1.0.0" as const,
          revision_id: "revision_b",
          source_content_hash: H("2"),
          vector: vector(),
        },
        {
          schema_version: "1.0.0" as const,
          revision_id: "revision_a",
          source_content_hash: H("3"),
          vector: vector(-1 / Math.sqrt(384)),
        },
      ],
    };
    const snapshot = buildVectorScopeSnapshot(input);
    expect(snapshot.records.map((record) => record.revision_id)).toEqual([
      "revision_a",
      "revision_b",
    ]);
    expect(VectorScopeSnapshotSchema.parse(snapshot)).toEqual(snapshot);

    expect(() =>
      VectorScopeSnapshotSchema.parse({
        ...snapshot,
        records: [
          {
            ...snapshot.records[0],
            content: "forbidden rendered memory",
          },
        ],
      }),
    ).toThrow();
    const [firstRecord] = input.records;
    expect(firstRecord).toBeDefined();
    if (firstRecord === undefined) {
      throw new Error("fixture must include a vector record");
    }
    expect(() =>
      buildVectorScopeSnapshot({
        ...input,
        records: [
          {
            ...firstRecord,
            vector: Array.from({ length: 383 }, () => 0),
          },
        ],
      }),
    ).toThrow();
  });

  it("bounds vector queries and distinguishes complete no-match from degradation", () => {
    const epoch = buildVectorEmbeddingEpoch(epochInput());
    const query = {
      schema_version: "1.0.0",
      request_id: "request_1",
      principal_id: "principal_local",
      scope: { kind: "workspace", id: "workspace_local" },
      query: "irrecoverable forgetting",
      embedding_epoch_id: epoch.epoch_id,
      generation_id: "generation_1",
      source_frontier_hash: H("1"),
      top_k: 10,
      parent_deadline_ms: 75,
      max_response_bytes: 1_048_576,
    };
    expect(VectorQuerySchema.parse(query)).toEqual(query);
    expect(() =>
      VectorQuerySchema.parse({
        ...query,
        top_k: 101,
      }),
    ).toThrow();
    expect(() =>
      VectorQuerySchema.parse({
        ...query,
        model_url: "https://example.invalid/model",
      }),
    ).toThrow();

    expect(
      VectorQueryResultSchema.parse({
        schema_version: "1.0.0",
        request_id: query.request_id,
        status: "no_match",
        embedding_epoch_id: epoch.epoch_id,
        generation_id: "generation_1",
        source_frontier_hash: H("1"),
        hits: [],
        complete: true,
        reason_codes: [],
      }).status,
    ).toBe("no_match");
    expect(() =>
      VectorQueryResultSchema.parse({
        schema_version: "1.0.0",
        request_id: query.request_id,
        status: "degraded",
        embedding_epoch_id: epoch.epoch_id,
        generation_id: "generation_1",
        source_frontier_hash: H("1"),
        hits: [],
        complete: false,
        reason_codes: [],
      }),
    ).toThrow();
  });

  it("binds selection evidence to semantic_vector only", () => {
    const evidence = VectorSelectionEvidenceSchema.parse({
      schema_version: "1.0.0",
      embedding_epoch_id: H("a"),
      generation_id: "generation_1",
      source_frontier_hash: H("b"),
      distance: 0.125,
      rank: 1,
      canonical_revalidated: true,
    });
    expect(evidence.canonical_revalidated).toBe(true);
  });
});
