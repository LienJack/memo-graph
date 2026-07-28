import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { ScopeSchema } from "../../packages/contracts/src/index.js";
import {
  ConsolidationService,
  MemoryRuntime,
} from "../../packages/memory-kernel/src/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";

import { TestApprovalRegistry } from "../helpers/approval.js";
import {
  memoryCandidate,
  revisionCommand,
} from "../helpers/governance-examples.js";
import { seedProjectionSources } from "../helpers/projection-examples.js";
import {
  PURGE_NOW,
  PURGE_SCOPE,
  deleteRequest,
} from "../helpers/purge-examples.js";
import { inlineEpisode } from "../helpers/storage-examples.js";

const cleanupPaths: string[] = [];
const ORIGINAL_TEXT = "SQLite is the canonical memory authority.";
const PROJECTION_SCOPE = ScopeSchema.parse(PURGE_SCOPE);

function temporaryRoot(prefix: string): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-graph-${prefix}-`)),
  );
  cleanupPaths.push(root);
  return root;
}

function filesUnder(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

function runtime(
  storage: SqliteStorageClient,
  approvals: TestApprovalRegistry,
): MemoryRuntime {
  return new MemoryRuntime({
    storage,
    approvalRegistry: approvals,
    clock: () => PURGE_NOW,
    policy: {
      principal: {
        principal_id: "user_local",
        allowed_scopes: [PURGE_SCOPE],
        allowed_authorities: ["user_stated"],
        destructive_tools_enabled: true,
      },
      default_token_budget: 1_800,
    },
  });
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target !== undefined) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

describe("derived projection invalidation", () => {
  it("suppresses stale descendants in the canonical correction transaction", async () => {
    const dataRoot = temporaryRoot("derived-correction");
    const storage = await SqliteStorageClient.open({ dataRoot });
    const [sourceA] = await seedProjectionSources(storage);
    const service = new ConsolidationService({ storage });
    expect(
      await service.drain({
        worker_id: "projection_worker_initial",
        claimed_at: "2026-07-28T12:02:00.000Z",
        lease_expires_at: "2026-07-28T12:03:00.000Z",
      }),
    ).toMatchObject({ failed: 0, processed: 2 });

    const before = await storage.queryProjections({
      principal_id: "user_local",
      scope: PURGE_SCOPE,
      as_of: "2026-07-28T12:02:30.000Z",
      limit: 100,
    });
    expect(before.items).toHaveLength(1);
    expect(before.items[0]?.content).toMatchObject({
      storage: "inline",
    });
    expect(
      before.items[0]?.content?.storage === "inline"
        ? before.items[0].content.text
        : "",
    ).toContain(ORIGINAL_TEXT);

    await storage.commitEpisode(
      inlineEpisode({
        episodeId: "episode_projection_correction",
        evidenceId: "evidence_projection_correction",
        idempotencyKey: "commit:projection:correction:0001",
        text: "SQLite remains authoritative and corrections are immediate.",
      }),
    );
    const corrected = await storage.applyMemoryRevision(
      revisionCommand({
        memoryId: sourceA.memory_id,
        expectedRevisionId: sourceA.revision_id,
        candidate: memoryCandidate({
          candidateId: "candidate_projection_a_correction",
          logicalKey: "projection.source.a",
          scope: PURGE_SCOPE,
          text: "SQLite remains authoritative and corrections are immediate.",
          evidenceIds: ["evidence_projection_correction"],
        }),
        idempotencyKey: "projection-source-a-correction-0001",
      }),
    );

    const immediatelyVisible = await storage.queryProjections({
      principal_id: "user_local",
      scope: PURGE_SCOPE,
      as_of: "2026-07-28T12:03:00.000Z",
      limit: 100,
    });
    expect(immediatelyVisible.items).toEqual([]);
    expect((await storage.health()).layered_projection_state).toBe(
      "pending",
    );

    expect(
      await service.drain({
        worker_id: "projection_worker_correction",
        claimed_at: "2026-07-28T12:04:00.000Z",
        lease_expires_at: "2026-07-28T12:05:00.000Z",
      }),
    ).toMatchObject({ failed: 0 });
    const after = await storage.queryProjections({
      principal_id: "user_local",
      scope: PURGE_SCOPE,
      as_of: "2026-07-28T12:04:30.000Z",
      limit: 100,
    });
    const rendered = after.items
      .map((projection) =>
        projection.content?.storage === "inline"
          ? projection.content.text
          : "",
      )
      .join("\n");
    expect(rendered).toContain(
      "SQLite remains authoritative and corrections are immediate.",
    );
    expect(rendered).not.toContain(ORIGINAL_TEXT);
    expect(
      after.items.flatMap((projection) =>
        projection.source_revisions.map((source) => source.revision_id),
      ),
    ).toContain(corrected.current_revision_id);
    await storage.close();

    const database = new DatabaseSync(
      join(dataRoot, "ledger", "memory.db"),
    );
    const invalidations = database
      .prepare(
        `SELECT count(*) AS count
         FROM projection_invalidations
         WHERE source_revision_id = ?`,
      )
      .get(sourceA.revision_id) as { count: number };
    expect(invalidations.count).toBeGreaterThan(0);
    database.close();
  });

  it("redacts derived plaintext during purge and cannot rebuild it", async () => {
    const dataRoot = temporaryRoot("derived-purge");
    const storage = await SqliteStorageClient.open({ dataRoot });
    const [sourceA] = await seedProjectionSources(storage);
    const service = new ConsolidationService({ storage });
    await service.drain({
      worker_id: "projection_worker_before_purge",
      claimed_at: "2026-07-28T12:02:00.000Z",
      lease_expires_at: "2026-07-28T12:03:00.000Z",
    });

    const approvals = new TestApprovalRegistry();
    const kernel = runtime(storage, approvals);
    const deletion = deleteRequest({
      memoryId: sourceA.memory_id,
      revisionId: sourceA.revision_id,
      idempotencyKey: "projection-source-a-delete-0001",
      approvalId: "approval_projection_source_a_delete",
    });
    approvals.approve(deletion);
    const deleted = await kernel.memoryDelete(deletion);
    if (deleted.status !== "OK") {
      throw new Error("projection source deletion must succeed");
    }
    expect(
      (
        await storage.queryProjections({
          principal_id: "user_local",
          scope: PURGE_SCOPE,
          as_of: PURGE_NOW,
          limit: 100,
        })
      ).items,
    ).toEqual([]);

    const purgeJobId = (deleted.data as { purge_job_id: string })
      .purge_job_id;
    expect(
      await storage.runPurge({ purge_job_id: purgeJobId }),
    ).toMatchObject({
      completed: true,
      residual_hashes: [],
    });
    await service.drain({
      worker_id: "projection_worker_after_purge",
      claimed_at: "2026-07-28T13:01:00.000Z",
      lease_expires_at: "2026-07-28T13:02:00.000Z",
    });
    const rebuilt = await service.rebuild({
      principal_id: "user_local",
      scope: PROJECTION_SCOPE,
      as_of: "2026-07-28T13:02:00.000Z",
      idempotency_key: "projection-rebuild-after-purge-0001",
      rebuild_receipt_id: "projection_rebuild_after_purge_0001",
    });
    expect(
      rebuilt.projections.flatMap((projection) =>
        projection.source_revisions.map((source) => source.revision_id),
      ),
    ).not.toContain(sourceA.revision_id);
    expect(
      rebuilt.projections
        .map((projection) =>
          projection.content?.storage === "inline"
            ? projection.content.text
            : "",
        )
        .join("\n"),
    ).not.toContain(ORIGINAL_TEXT);
    await storage.close();

    for (const path of filesUnder(dataRoot)) {
      expect(readFileSync(path).includes(Buffer.from(ORIGINAL_TEXT))).toBe(
        false,
      );
    }
  });
});
