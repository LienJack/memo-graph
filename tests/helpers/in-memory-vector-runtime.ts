import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  VectorScopeSnapshotSchema,
  canonicalJson,
  canonicalSha256,
  type VectorScopeSnapshot,
} from "../../packages/contracts/src/index.js";
import type {
  VectorProjectionRuntimeFactory,
} from "../../packages/vector-retrieval/src/index.js";

function deterministicVector(text: string): number[] {
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
}
