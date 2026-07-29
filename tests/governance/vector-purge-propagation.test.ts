import {
  mkdtemp,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import { seedProjectionSources } from "../helpers/projection-examples.js";
import {
  VECTOR_NOW,
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

describe("vector purge and source boundary", () => {
  it("lists only governed non-sensitive exact-scope sources for rebuild", async () => {
    const root = await mkdtemp(
      join(await realpath(tmpdir()), "memo-graph-vector-purge-"),
    );
    roots.push(root);
    const client = await SqliteStorageClient.open({ dataRoot: root });
    try {
      const sources = await seedProjectionSources(client);
      const epoch = qualifiedVectorEpoch();
      await client.registerVectorEmbeddingEpoch({
        epoch,
        registered_at: VECTOR_NOW,
      });
      await client.configureVectorProjection({
        mode: "evaluating",
        epoch_id: epoch.epoch_id,
        configured_at: VECTOR_NOW,
      });
      const listed = await client.listProjectionSources({
        principal_id: "user_local",
        scope: { kind: "workspace", id: "workspace_local" },
        as_of: VECTOR_NOW,
        include_sensitive: false,
        context_scope: null,
        limit: 1_000,
      });
      expect(listed.items.map((item) => item.revision_id).sort()).toEqual(
        sources.map((source) => source.revision_id).sort(),
      );
      expect(
        listed.items.every((item) =>
          !["sensitive", "secret"].includes(item.sensitivity)
        ),
      ).toBe(true);
    } finally {
      await client.close();
    }
  });
});
