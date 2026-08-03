import {
  mkdtemp,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { afterEach, describe, expect, it } from "vitest";

import {
  VectorProcessHost,
  type VectorProcessHostOptions,
} from "../../packages/vector-retrieval/src/index.js";
import {
  buildVectorEmbeddingEpoch,
  buildVectorScopeSnapshot,
} from "../../packages/contracts/src/index.js";

const roots: string[] = [];
const hosts: VectorProcessHost[] = [];
const H = (character: string): `sha256:${string}` =>
  `sha256:${character.repeat(64)}`;

afterEach(async () => {
  await Promise.allSettled(hosts.splice(0).map((host) => host.close()));
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), prefix),
  );
  roots.push(root);
  return root;
}

function epoch() {
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
        { path: "config.json", sha256: H("a") },
        { path: "onnx/model_int8.onnx", sha256: H("b") },
        { path: "tokenizer.json", sha256: H("c") },
        { path: "tokenizer_config.json", sha256: H("d") },
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
    dependency_lock_hash: H("e"),
  });
}

function snapshot(epochId: string) {
  return buildVectorScopeSnapshot({
    schema_version: "1.0.0",
    principal_id: "principal_local",
    scope: { kind: "workspace", id: "workspace_local" },
    embedding_epoch_id: epochId,
    generation_id: "generation_1",
    frontier: {
      ledger_epoch: 2,
      tombstone_epoch: 1,
      source_frontier_hash: H("1"),
      next_validity_transition_at: null,
    },
    records: [
      {
        schema_version: "1.0.0",
        revision_id: "revision_1",
        source_content_hash: H("2"),
        vector: Array.from(
          { length: 384 },
          () => 1 / Math.sqrt(384),
        ),
      },
    ],
  });
}

async function host(
  overrides: Partial<VectorProcessHostOptions> = {},
): Promise<VectorProcessHost> {
  const candidateEpoch = epoch();
  const opened = await VectorProcessHost.open({
    dataRoot: await tempRoot("memo-graph-vector-host-"),
    modelRoot: await tempRoot("memo-graph-vector-model-"),
    principalId: "principal_local",
    scope: { kind: "workspace", id: "workspace_local" },
    expectedEpoch: candidateEpoch,
    childEntry: new URL(
      "../fixtures/vector-process-child.mjs",
      import.meta.url,
    ),
    requestTimeoutMs: 75,
    startupTimeoutMs: 2_000,
    restartPolicy: {
      maxRestarts: 3,
      windowMs: 1_000,
      cooldownMs: 250,
    },
    ...overrides,
  });
  hosts.push(opened);
  return opened;
}

describe("vector child process recovery", () => {
  it("round-trips a scope snapshot and vector query", async () => {
    const candidateEpoch = epoch();
    const runtime = await host({ expectedEpoch: candidateEpoch });
    const stored = await runtime.replaceScope(
      snapshot(candidateEpoch.epoch_id),
    );
    expect(await runtime.readScopeSnapshot()).toEqual(stored);
    await expect(
      runtime.query({
        schema_version: "1.0.0",
        request_id: "request_1",
        principal_id: "principal_local",
        scope: { kind: "workspace", id: "workspace_local" },
        query: "semantic query",
        embedding_epoch_id: candidateEpoch.epoch_id,
        generation_id: "generation_1",
        source_frontier_hash: H("1"),
        top_k: 10,
        parent_deadline_ms: 75,
        max_response_bytes: 1_048_576,
      }),
    ).resolves.toMatchObject({
      status: "complete",
      complete: true,
      hits: [{ revision_id: "revision_1", rank: 1 }],
    });
    const foreignSnapshot = buildVectorScopeSnapshot({
      schema_version: stored.schema_version,
      principal_id: "principal_foreign",
      scope: stored.scope,
      embedding_epoch_id: stored.embedding_epoch_id,
      generation_id: stored.generation_id,
      frontier: stored.frontier,
      records: stored.records,
    });
    await expect(
      runtime.replaceScope(foreignSnapshot),
    ).rejects.toMatchObject({
      category: "PROTOCOL_INVALID",
    });
    await expect(
      runtime.query({
        schema_version: "1.0.0",
        request_id: "request_foreign",
        principal_id: "principal_foreign",
        scope: { kind: "workspace", id: "workspace_local" },
        query: "semantic query",
        embedding_epoch_id: candidateEpoch.epoch_id,
        generation_id: "generation_1",
        source_frontier_hash: H("1"),
        top_k: 10,
        parent_deadline_ms: 75,
        max_response_bytes: 1_048_576,
      }),
    ).resolves.toMatchObject({
      status: "degraded",
      failure_category: "PROTOCOL_INVALID",
    });
  });

  it("returns typed fallback within p95 100 ms for 100 stuck calls", async () => {
    const candidateEpoch = epoch();
    const runtime = await host({
      expectedEpoch: candidateEpoch,
      restartPolicy: {
        maxRestarts: 200,
        windowMs: 60_000,
        cooldownMs: 250,
      },
    });
    const samples: number[] = [];
    for (let index = 0; index < 100; index += 1) {
      const started = performance.now();
      const result = await runtime.query({
        schema_version: "1.0.0",
        request_id: `request_timeout_${index}`,
        principal_id: "principal_local",
        scope: { kind: "workspace", id: "workspace_local" },
        query: "__test_hang__",
        embedding_epoch_id: candidateEpoch.epoch_id,
        generation_id: "generation_1",
        source_frontier_hash: H("1"),
        top_k: 10,
        parent_deadline_ms: 25,
        max_response_bytes: 1_048_576,
      });
      samples.push(performance.now() - started);
      expect(result).toMatchObject({
        status: "degraded",
        complete: false,
        failure_category: "PROCESS_TIMEOUT",
      });
      await expect(runtime.waitUntilHealthy(2_000)).resolves.toBe(true);
    }
    samples.sort((left, right) => left - right);
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1] ?? Infinity;
    expect(p95).toBeLessThanOrEqual(100);
  }, 60_000);

  it("kills a failed child, replaces it outside the request, and closes it", async () => {
    const runtime = await host();
    const previousPid = runtime.processId();
    expect(previousPid).not.toBeNull();
    if (previousPid === null) {
      throw new Error("vector child process did not start");
    }
    process.kill(previousPid, "SIGKILL");
    expect(await runtime.waitUntilHealthy(2_000)).toBe(true);
    expect(runtime.processId()).not.toBe(previousPid);
    const replacementPid = runtime.processId();
    await runtime.close();
    expect(runtime.processId()).toBeNull();
    if (replacementPid !== null) {
      expect(() => process.kill(replacementPid, 0)).toThrow();
    }
  });

  it("enters cooldown after repeated child failures", async () => {
    const runtime = await host({
      restartPolicy: {
        maxRestarts: 1,
        windowMs: 1_000,
        cooldownMs: 250,
      },
    });
    const firstPid = runtime.processId();
    if (firstPid === null) {
      throw new Error("vector child process did not start");
    }
    process.kill(firstPid, "SIGKILL");
    expect(await runtime.waitUntilHealthy(2_000)).toBe(true);
    const secondPid = runtime.processId();
    if (secondPid === null) {
      throw new Error("vector child process was not replaced");
    }
    process.kill(secondPid, "SIGKILL");
    const deadline = performance.now() + 2_000;
    while (
      runtime.processHealth().status !== "cooldown" &&
      performance.now() <= deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(runtime.processHealth().status).toBe("cooldown");
  });
});
