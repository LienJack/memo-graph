import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  VectorScopeProjector,
  vectorGenerationLayout,
} from "../../packages/vector-retrieval/src/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import {
  InMemoryVectorRuntimeFactory,
} from "../helpers/in-memory-vector-runtime.js";
import { seedProjectionSources } from "../helpers/projection-examples.js";
import {
  VECTOR_NOW,
  VECTOR_SCOPE,
  qualifiedVectorEpoch,
} from "../helpers/vector-examples.js";
import {
  VECTOR_RECALL_AS_OF,
  openGovernedVectorHarness,
} from "../helpers/governed-vector-harness.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

async function regularFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await regularFiles(path));
    } else if (entry.isFile() && (await stat(path)).size <= 2_000_000) {
      files.push(path);
    }
  }
  return files;
}

describe("vector physical content boundary", () => {
  it("stores only hashed identity, vector values, and content-free metadata", async () => {
    const root = await mkdtemp(
      join(await realpath(tmpdir()), "memo-graph-vector-residual-"),
    );
    roots.push(root);
    const storage = await SqliteStorageClient.open({ dataRoot: root });
    try {
      await seedProjectionSources(storage);
      const epoch = qualifiedVectorEpoch();
      await storage.registerVectorEmbeddingEpoch({
        epoch,
        registered_at: VECTOR_NOW,
      });
      await storage.configureVectorProjection({
        mode: "evaluating",
        epoch_id: epoch.epoch_id,
        configured_at: VECTOR_NOW,
      });
      const runtime = new InMemoryVectorRuntimeFactory();
      const projector = new VectorScopeProjector({
        storage,
        dataRoot: root,
        modelRoot: join(root, "models"),
        epoch,
        runtimeFactory: runtime.runtimeFactory(),
      });
      await projector.drain({
        worker_id: "vector_residual_worker",
        claimed_at: "2026-07-29T06:00:01.000Z",
        lease_expires_at: "2026-07-29T06:01:00.000Z",
        completed_at: "2026-07-29T06:00:05.000Z",
        retry_at: "2026-07-29T06:01:05.000Z",
      });
      const checkpoint = await storage.vectorProjectionCheckpoint({
        principal_id: "user_local",
        scope: VECTOR_SCOPE,
      });
      const layout = await vectorGenerationLayout({
        dataRoot: root,
        principalId: "user_local",
        scope: VECTOR_SCOPE,
        epochId: epoch.epoch_id,
        generationId: checkpoint.desired_generation_id,
      });
      expect(layout.activeRoot).not.toContain("user_local");
      expect(layout.activeRoot).not.toContain("workspace_local");
      const files = await regularFiles(layout.vectorRoot);
      const rendered = (
        await Promise.all(
          files.map((file) => readFile(file, "utf8")),
        )
      ).join("\n");
      for (const forbidden of [
        "SQLite is the canonical memory authority.",
        "Derived views must revalidate exact source revisions.",
        "evidence_projection_a",
        "evidence_projection_b",
      ]) {
        expect(rendered).not.toContain(forbidden);
      }
      expect(rendered).not.toContain('"text"');
      expect(rendered).not.toContain('"content"');
    } finally {
      await storage.close();
    }
  });

  it("persists only a query hash and never the raw semantic query text", async () => {
    const root = await mkdtemp(
      join(
        await realpath(tmpdir()),
        "memo-graph-vector-query-residual-",
      ),
    );
    roots.push(root);
    const harness = await openGovernedVectorHarness({
      dataRoot: root,
    });
    const uniqueQuery =
      "UNIQUE_VECTOR_QUERY_MUST_NOT_PERSIST_5f8a91";
    try {
      const compiled = await harness.memoryRuntime.memoryContextCompile({
        envelope: {
          schema_version: "1.0.0",
          request_id: "request_vector_query_residual",
          tool: "memory_context_compile",
          safety_class: "read_only",
          actor_claim: {
            principal_id: "user_local",
            authority: "user_stated",
          },
          scopes: [VECTOR_SCOPE],
          purpose: "Prove semantic query text remains ephemeral",
          reason: "Persist content-free vector telemetry only",
          requested_at: VECTOR_RECALL_AS_OF,
        },
        recall: {
          schema_version: "1.0.0",
          request_id: "request_vector_query_residual",
          goal: "Restore governed context without query retention",
          query: uniqueQuery,
          scopes: [VECTOR_SCOPE],
          as_of: VECTOR_RECALL_AS_OF,
          token_budget: 1_800,
          include_sensitive: false,
          lane_overrides: {
            requested_lanes: ["semantic_vector"],
            limits: {
              max_candidates_per_lane: 20,
              vector_top_k: 20,
              vector_query_timeout_ms: 50,
              vector_max_response_bytes: 65_536,
              max_concurrent_lanes: 1,
            },
          },
        },
      });
      expect(["OK", "DEGRADED"]).toContain(compiled.status);
      expect(JSON.stringify(compiled)).not.toContain(uniqueQuery);
    } finally {
      await harness.storage.close();
    }

    const rendered = (
      await Promise.all(
        (await regularFiles(
          join(root, "derived", "vector"),
        )).map((file) =>
          readFile(file, "utf8")
        ),
      )
    ).join("\n");
    expect(rendered).not.toContain(uniqueQuery);
  });
});
