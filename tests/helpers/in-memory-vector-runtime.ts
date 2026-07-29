import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  VectorScopeSnapshotSchema,
  VectorQuerySchema,
  VectorQueryResultSchema,
  canonicalJson,
  canonicalSha256,
  type VectorQuery,
  type VectorScopeSnapshot,
} from "../../packages/contracts/src/index.js";
import type {
  VectorProjectionRuntimeFactory,
  SemanticVectorRuntimeFactory,
} from "../../packages/vector-retrieval/src/index.js";

export function deterministicVector(text: string): number[] {
  const hash = canonicalSha256({ text }).slice("sha256:".length);
  const values = Array.from({ length: 384 }, (_unused, index) => {
    const nibble = Number.parseInt(hash[index % hash.length] ?? "0", 16);
    return nibble - 7.5;
  });
  const norm = Math.sqrt(
    values.reduce((sum, value) => sum + value ** 2, 0),
  );
  return values.map((value) => value / norm);
}

export class InMemoryVectorRuntimeFactory {
  readonly snapshots = new Map<string, VectorScopeSnapshot>();
  readonly queries: VectorQuery[] = [];
  onReplace:
    | ((snapshot: VectorScopeSnapshot) => Promise<void>)
    | undefined;

  runtimeFactory(): VectorProjectionRuntimeFactory {
    return {
      open: async (input) => {
        let snapshot: VectorScopeSnapshot | null =
          this.snapshots.get(input.dataRoot) ?? null;
        let closed = false;
        await mkdir(input.dataRoot, { recursive: true });
        return {
          embedPassages: async (passages) => {
            if (closed) {
              throw new Error("vector runtime is closed");
            }
            return passages.map(deterministicVector);
          },
          replaceScope: async (candidate) => {
            if (closed) {
              throw new Error("vector runtime is closed");
            }
            snapshot = VectorScopeSnapshotSchema.parse(candidate);
            this.snapshots.set(input.dataRoot, snapshot);
            await writeFile(
              join(input.dataRoot, "vector.snapshot.json"),
              canonicalJson(snapshot),
              { encoding: "utf8", flag: "wx" },
            );
            await this.onReplace?.(snapshot);
            return snapshot;
          },
          readScopeSnapshot: async () => snapshot,
          close: async () => {
            closed = true;
          },
        };
      },
    };
  }

  queryRuntimeFactory(options: {
    snapshotSource?: "disk" | "memory";
  } = {}): SemanticVectorRuntimeFactory {
    return {
      open: async (input) => {
        const snapshot =
          options.snapshotSource === "memory"
            ? VectorScopeSnapshotSchema.parse(
                [...this.snapshots.values()].find(
                  (candidate) =>
                    candidate.principal_id === input.principalId &&
                    canonicalJson(candidate.scope) ===
                      canonicalJson(input.scope) &&
                    candidate.embedding_epoch_id ===
                      input.expectedEpoch.epoch_id,
                ),
              )
            : VectorScopeSnapshotSchema.parse(
                JSON.parse(
                  await readFile(
                    join(input.dataRoot, "vector.snapshot.json"),
                    "utf8",
                  ),
                ),
              );
        let closed = false;
        return {
          query: async (queryInput) => {
            if (closed) {
              throw new Error("vector runtime is closed");
            }
            const query = VectorQuerySchema.parse(queryInput);
            this.queries.push(query);
            const queryVector = deterministicVector(query.query);
            const hits = snapshot.records
              .map((record) => ({
                revision_id: record.revision_id,
                source_content_hash: record.source_content_hash,
                distance: Math.max(
                  0,
                  Math.min(
                    2,
                    1 - record.vector.reduce(
                      (sum, component, index) =>
                        sum +
                        component * (queryVector[index] ?? 0),
                      0,
                    ),
                  ),
                ),
              }))
              .sort(
                (left, right) =>
                  left.distance - right.distance ||
                  left.revision_id.localeCompare(right.revision_id),
              )
              .slice(0, query.top_k)
              .map((hit, index) => ({
                ...hit,
                rank: index + 1,
              }));
            return VectorQueryResultSchema.parse({
              schema_version: "1.0.0",
              request_id: query.request_id,
              status: hits.length === 0
                ? "no_match" as const
                : "complete" as const,
              embedding_epoch_id: snapshot.embedding_epoch_id,
              generation_id: snapshot.generation_id,
              source_frontier_hash:
                snapshot.frontier.source_frontier_hash,
              hits,
              complete: true,
              reason_codes: [],
            });
          },
          close: async () => {
            closed = true;
          },
        };
      },
    };
  }
}
