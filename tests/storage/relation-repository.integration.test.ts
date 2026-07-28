import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteStorageClient } from "@memo-graph/storage-sqlite";

import {
  projectionFrontier,
  relationProjection,
  seedProjectionSources,
} from "../helpers/projection-examples.js";

const cleanupPaths: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-graph-${prefix}-`)),
  );
  cleanupPaths.push(root);
  return root;
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target !== undefined) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

describe("SQLite relation repository", () => {
  it("stores typed adjacency and traverses only the requested direction", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("relation-direction"),
    });
    const sources = await seedProjectionSources(storage);
    const health = await storage.health();
    const frontier = projectionFrontier({
      ledgerEpoch: health.ledger_epoch,
      tombstoneEpoch: health.tombstone_epoch,
      projectionEpoch: 1,
    });
    const relation = relationProjection(sources, frontier);
    await storage.applyProjectionBatch({
      idempotency_key: "relation-batch-0001",
      expected_projection_epoch: 0,
      projections: [relation],
      applied_at: "2026-07-28T12:05:00.000Z",
    });

    const outbound = await storage.traverseRelations({
      principal_id: "user_local",
      scope: { kind: "workspace", id: "workspace_local" },
      start_revision_ids: [sources[0].revision_id],
      direction: "outbound",
      relation_types: ["supports"],
      max_depth: 2,
      max_fanout: 10,
      as_of: "2026-07-28T12:06:00.000Z",
    });
    const inbound = await storage.traverseRelations({
      principal_id: "user_local",
      scope: { kind: "workspace", id: "workspace_local" },
      start_revision_ids: [sources[0].revision_id],
      direction: "inbound",
      relation_types: ["supports"],
      max_depth: 2,
      max_fanout: 10,
      as_of: "2026-07-28T12:06:00.000Z",
    });
    await storage.close();

    expect(outbound).toMatchObject({
      truncated: false,
      hits: [
        {
          depth: 1,
          from_revision_id: sources[0].revision_id,
          to_revision_id: sources[1].revision_id,
          relation_revision_id: relation.projection_revision_id,
          relation_type: "supports",
        },
      ],
    });
    expect(inbound.hits).toEqual([]);
  });

  it("never crosses principal or exact scope through adjacency", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("relation-scope"),
    });
    const sources = await seedProjectionSources(storage);
    const health = await storage.health();
    const frontier = projectionFrontier({
      ledgerEpoch: health.ledger_epoch,
      tombstoneEpoch: health.tombstone_epoch,
      projectionEpoch: 1,
    });
    await storage.applyProjectionBatch({
      idempotency_key: "relation-batch-scope-0001",
      expected_projection_epoch: 0,
      projections: [relationProjection(sources, frontier)],
      applied_at: "2026-07-28T12:05:00.000Z",
    });

    expect(
      await storage.traverseRelations({
        principal_id: "user_local",
        scope: { kind: "workspace", id: "another_workspace" },
        start_revision_ids: [sources[0].revision_id],
        direction: "both",
        relation_types: ["supports"],
        max_depth: 2,
        max_fanout: 10,
        as_of: "2026-07-28T12:06:00.000Z",
      }),
    ).toEqual({ hits: [], truncated: false });
    await storage.close();
  });
});
