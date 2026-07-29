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
});
