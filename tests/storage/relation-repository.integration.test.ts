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
  ConsolidationService,
} from "../../packages/memory-kernel/src/index.js";

import {
  projectionFrontier,
  relationProjection,
  seedLayeredProjectionSources,
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
      principal_id: "user_local",
      scope: { kind: "workspace", id: "workspace_local" },
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
      fanout_observed_count: 1,
      fanout_retained_count: 1,
      fanout_truncated_count: 0,
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
      principal_id: "user_local",
      scope: { kind: "workspace", id: "workspace_local" },
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
    ).toEqual({
      hits: [],
      truncated: false,
      fanout_observed_count: 0,
      fanout_retained_count: 0,
      fanout_truncated_count: 0,
    });
    await storage.close();
  });

  it("reports exact fanout observations and dropped adjacency rows", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("relation-fanout"),
    });
    const admitted = await seedLayeredProjectionSources(storage, {
      prefix: "relation_fanout",
    });
    await new ConsolidationService({ storage }).drain({
      worker_id: "relation_fanout_worker",
      claimed_at: "2026-07-28T12:10:00.000Z",
      lease_expires_at: "2026-07-28T12:11:00.000Z",
    });
    const middle = admitted[1];
    if (middle === undefined) {
      throw new Error("fanout fixture requires a middle source");
    }
    const traversal = await storage.traverseRelations({
      principal_id: "user_local",
      scope: { kind: "workspace", id: "workspace_local" },
      start_revision_ids: [middle.current_revision_id],
      direction: "both",
      max_depth: 1,
      max_fanout: 1,
      as_of: "2026-07-28T12:12:00.000Z",
    });

    expect(traversal).toMatchObject({
      truncated: true,
      fanout_observed_count: 2,
      fanout_retained_count: 1,
      fanout_truncated_count: 1,
    });
    expect(traversal.hits).toHaveLength(1);
    await storage.close();
  });
});
