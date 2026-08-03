import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import {
  existsSync,
  readFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  SqliteVecIndex,
  VectorProcessHost,
  VectorScopeProjector,
  createLocalTransformersEmbedder,
  verifyLocalModelSnapshot,
} from "../../packages/vector-retrieval/src/index.js";
import {
  buildVectorEmbeddingEpoch,
  buildVectorScopeSnapshot,
} from "../../packages/contracts/src/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import { seedProjectionSources } from "../helpers/projection-examples.js";

const roots: string[] = [];
const MODEL_ROOT = process.env.MEMO_GRAPH_G4B_MODEL_ROOT;
const H = (value: string): `sha256:${string}` => `sha256:${value}`;

afterAll(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

async function candidateEpoch() {
  const lockfile = await readFile(
    new URL("../../pnpm-lock.yaml", import.meta.url),
  );
  return buildVectorEmbeddingEpoch({
    schema_version: "1.0.0",
    runtime: {
      package_name: "@huggingface/transformers",
      package_version: "4.2.0",
    },
    sqlite_binding: {
      package_name: "better-sqlite3",
      package_version: "13.0.1",
    },
    model: {
      repository: "Xenova/multilingual-e5-small",
      revision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78",
      files: [
        {
          path: "config.json",
          sha256: H(
            "cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1",
          ),
        },
        {
          path: "onnx/model_int8.onnx",
          sha256: H(
            "4d24e2bc01a447951524466ef533e52944bf48509e6552810bcee1a2711cb02c",
          ),
        },
        {
          path: "tokenizer.json",
          sha256: H(
            "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
          ),
        },
        {
          path: "tokenizer_config.json",
          sha256: H(
            "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b",
          ),
        },
      ],
      onnx_artifact: "onnx/model_int8.onnx",
      dimensions: 384,
      dtype: "int8",
      pooling: "mean",
      normalization: "l2",
      query_prefix: "query: ",
      passage_prefix: "passage: ",
      max_tokens: 512,
    },
    index: {
      package_name: "sqlite-vec",
      package_version: "0.1.9",
      algorithm: "flat",
      metric: "cosine",
    },
    projection_schema_version: "1.0.0",
    dependency_lock_hash: H(
      createHash("sha256").update(lockfile).digest("hex"),
    ),
  });
}

function packageVersion(
  require: NodeJS.Require,
  packageName: string,
): string {
  let current = dirname(require.resolve(packageName));
  while (current !== dirname(current)) {
    const manifestPath = join(current, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(
        readFileSync(manifestPath, "utf8"),
      ) as { name?: unknown; version?: unknown };
      if (
        manifest.name === packageName &&
        typeof manifest.version === "string"
      ) {
        return manifest.version;
      }
    }
    current = dirname(current);
  }
  throw new Error(`package manifest not found: ${packageName}`);
}

describe("qualified vector dependencies", () => {
  it("resolves exact candidate versions and the existing SQLite binding", () => {
    const require = createRequire(
      new URL(
        "../../packages/vector-retrieval/package.json",
        import.meta.url,
      ),
    );
    expect(packageVersion(require, "@huggingface/transformers")).toBe(
      "4.2.0",
    );
    expect(packageVersion(require, "sqlite-vec")).toBe("0.1.9");
    expect(packageVersion(require, "better-sqlite3")).toBe("13.0.1");
    expect(
      require.resolve("better-sqlite3"),
    ).toBe(
      createRequire(
        new URL(
          "../../packages/storage-sqlite/package.json",
          import.meta.url,
        ),
      ).resolve("better-sqlite3"),
    );
  });

  it.runIf(MODEL_ROOT !== undefined)(
    "verifies the exact offline snapshot and emits a normalized 384-vector",
    async () => {
      const epoch = await candidateEpoch();
      await expect(
        verifyLocalModelSnapshot(MODEL_ROOT ?? "", epoch),
      ).resolves.toMatchObject({ epochId: epoch.epoch_id });
      const embedder = await createLocalTransformersEmbedder({
        modelRoot: MODEL_ROOT ?? "",
        epoch,
      });
      const [vector] = await embedder.embedPassages([
        "A memory is erased only after the purge receipt is sealed.",
      ]);
      expect(vector).toHaveLength(384);
      const norm = Math.sqrt(
        (vector ?? []).reduce(
          (sum, component) => sum + component ** 2,
          0,
        ),
      );
      expect(norm).toBeCloseTo(1, 3);
      await embedder.close();
    },
  );

  it.runIf(MODEL_ROOT !== undefined)(
    "rejects an incomplete snapshot even when one expected hash exists",
    async () => {
      const epoch = await candidateEpoch();
      const incompleteRoot = await mkdtemp(
        join(
          await realpath(tmpdir()),
          "memo-graph-incomplete-model-",
        ),
      );
      roots.push(incompleteRoot);
      const modelDirectory = join(
        incompleteRoot,
        "Xenova",
        "multilingual-e5-small",
      );
      await mkdir(modelDirectory, { recursive: true });
      await copyFile(
        join(
          MODEL_ROOT ?? "",
          "Xenova",
          "multilingual-e5-small",
          "config.json",
        ),
        join(modelDirectory, "config.json"),
      );
      await expect(
        verifyLocalModelSnapshot(incompleteRoot, epoch),
      ).rejects.toThrow();
    },
  );

  it.runIf(MODEL_ROOT !== undefined)(
    "starts the real isolated child and reports the complete pinned identity",
    async () => {
      const epoch = await candidateEpoch();
      const dataRoot = await mkdtemp(
        join(await realpath(tmpdir()), "memo-graph-vector-real-child-"),
      );
      roots.push(dataRoot);
      const runtime = await VectorProcessHost.open({
        dataRoot,
        modelRoot: MODEL_ROOT ?? "",
        principalId: "principal_local",
        scope: { kind: "workspace", id: "workspace_local" },
        expectedEpoch: epoch,
        childEntry: new URL(
          "../../packages/vector-retrieval/dist/vector-process.js",
          import.meta.url,
        ),
        startupTimeoutMs: 10_000,
        requestTimeoutMs: 1_000,
      });
      try {
        await expect(runtime.health()).resolves.toMatchObject({
          status: "ready",
          embedding_epoch_id: epoch.epoch_id,
        });
        const [vector] = await runtime.embedPassages([
          "A memory is erased only after its purge receipt is sealed.",
        ]);
        if (vector === undefined) {
          throw new Error("real vector child returned no passage embedding");
        }
        const snapshot = buildVectorScopeSnapshot({
          schema_version: "1.0.0",
          principal_id: "principal_local",
          scope: { kind: "workspace", id: "workspace_local" },
          embedding_epoch_id: epoch.epoch_id,
          generation_id: "generation_1",
          frontier: {
            ledger_epoch: 1,
            tombstone_epoch: 0,
            source_frontier_hash: H("3".repeat(64)),
            next_validity_transition_at: null,
          },
          records: [
            {
              schema_version: "1.0.0",
              revision_id: "revision_real",
              source_content_hash: H("4".repeat(64)),
              vector,
            },
          ],
        });
        await runtime.replaceScope(snapshot);
        await expect(
          runtime.query({
            schema_version: "1.0.0",
            request_id: "request_real",
            principal_id: "principal_local",
            scope: { kind: "workspace", id: "workspace_local" },
            query: "irrecoverable forgetting",
            embedding_epoch_id: epoch.epoch_id,
            generation_id: snapshot.generation_id,
            source_frontier_hash:
              snapshot.frontier.source_frontier_hash,
            top_k: 5,
            parent_deadline_ms: 75,
            max_response_bytes: 1_048_576,
          }),
        ).resolves.toMatchObject({
          status: "complete",
          hits: [{ revision_id: "revision_real", rank: 1 }],
        });
      } finally {
        await runtime.close();
      }
    },
  );

  it.runIf(MODEL_ROOT !== undefined)(
    "projects and publishes a real exact-scope generation through the isolated child",
    async () => {
      const epoch = await candidateEpoch();
      const dataRoot = await mkdtemp(
        join(
          await realpath(tmpdir()),
          "memo-graph-vector-real-projector-",
        ),
      );
      roots.push(dataRoot);
      const storage = await SqliteStorageClient.open({ dataRoot });
      try {
        await seedProjectionSources(storage);
        await storage.registerVectorEmbeddingEpoch({
          epoch,
          registered_at: "2026-07-29T06:00:00.000Z",
        });
        await storage.configureVectorProjection({
          mode: "evaluating",
          epoch_id: epoch.epoch_id,
          configured_at: "2026-07-29T06:00:00.000Z",
        });
        const projector = new VectorScopeProjector({
          storage,
          dataRoot,
          modelRoot: MODEL_ROOT ?? "",
          epoch,
          runtimeFactory: {
            open: (input) =>
              VectorProcessHost.open({
                ...input,
                childEntry: new URL(
                  "../../packages/vector-retrieval/dist/vector-process.js",
                  import.meta.url,
                ),
                startupTimeoutMs: 10_000,
                writeTimeoutMs: 30_000,
                requestTimeoutMs: 1_000,
              }),
          },
        });
        await expect(
          projector.drain({
            worker_id: "vector_real_projector",
            claimed_at: "2026-07-29T06:00:01.000Z",
            lease_expires_at: "2026-07-29T06:01:00.000Z",
            completed_at: "2026-07-29T06:00:10.000Z",
            retry_at: "2026-07-29T06:01:05.000Z",
          }),
        ).resolves.toMatchObject({
          claimed: 1,
          published: 1,
          stale: 0,
          failed: 0,
        });
        await expect(
          storage.vectorProjectionCheckpoint({
            principal_id: "user_local",
            scope: { kind: "workspace", id: "workspace_local" },
          }),
        ).resolves.toMatchObject({
          state: "published",
          active_epoch_id: epoch.epoch_id,
        });
      } finally {
        await storage.close();
      }
    },
  );

  it("inserts, searches, replaces, deletes, rolls back, and reopens sqlite-vec", async () => {
    const epoch = await candidateEpoch();
    const root = await mkdtemp(
      join(await realpath(tmpdir()), "memo-graph-sqlite-vec-"),
    );
    roots.push(root);
    const databasePath = join(root, "vectors.db");
    const index = await SqliteVecIndex.open({
      databasePath,
      dimensions: 384,
    });
    const snapshot = buildVectorScopeSnapshot({
      schema_version: "1.0.0",
      principal_id: "principal_local",
      scope: { kind: "workspace", id: "workspace_local" },
      embedding_epoch_id: epoch.epoch_id,
      generation_id: "generation_1",
      frontier: {
        ledger_epoch: 1,
        tombstone_epoch: 0,
        source_frontier_hash: H("1".repeat(64)),
        next_validity_transition_at: null,
      },
      records: [
        {
          schema_version: "1.0.0",
          revision_id: "revision_1",
          source_content_hash: H("2".repeat(64)),
          vector: Array.from(
            { length: 384 },
            () => 1 / Math.sqrt(384),
          ),
        },
      ],
    });
    await index.replaceScope(snapshot);
    await expect(
      index.search(snapshot.records[0]?.vector ?? [], 10),
    ).resolves.toMatchObject([{ revision_id: "revision_1", rank: 1 }]);
    const digestBefore = (await index.readScopeSnapshot())?.logical_digest;
    await expect(
      index.runInTransaction(async () => {
        await index.deleteScope();
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect((await index.readScopeSnapshot())?.logical_digest).toBe(
      digestBefore,
    );
    await index.close();

    const reopened = await SqliteVecIndex.open({
      databasePath,
      dimensions: 384,
    });
    expect((await reopened.readScopeSnapshot())?.logical_digest).toBe(
      digestBefore,
    );
    await reopened.deleteScope();
    expect(await reopened.readScopeSnapshot()).toBeNull();
    await reopened.close();
  });
});
