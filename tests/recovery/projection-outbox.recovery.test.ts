import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ScopeSchema } from "../../packages/contracts/src/index.js";
import {
  ConsolidationService,
  buildDeterministicProjections,
  projectionStructuralDigest,
} from "../../packages/memory-kernel/src/index.js";
import {
  MAX_PROJECTION_ATTEMPTS,
  SqliteStorageClient,
} from "@memo-graph/storage-sqlite";

import { seedProjectionSources } from "../helpers/projection-examples.js";

const cleanupPaths: string[] = [];
const SCOPE = ScopeSchema.parse({
  kind: "workspace",
  id: "workspace_local",
});

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

describe("projection outbox recovery", () => {
  it("retries after a crash without partial projection writes or drift", async () => {
    const dataRoot = temporaryRoot("projection-recovery");
    let storage = await SqliteStorageClient.open({ dataRoot });
    await seedProjectionSources(storage);
    const failing = new ConsolidationService({
      storage,
      projector: () => {
        throw new Error("simulated projection worker crash");
      },
    });
    expect(
      await failing.drain({
        worker_id: "projection_failing_worker",
        claimed_at: "2026-07-28T12:02:00.000Z",
        lease_expires_at: "2026-07-28T12:03:00.000Z",
      }),
    ).toMatchObject({ claimed: 2, processed: 0, failed: 2 });
    expect(
      (
        await storage.queryProjections({
          principal_id: "user_local",
          scope: SCOPE,
          as_of: "2026-07-28T12:02:30.000Z",
          limit: 100,
        })
      ).items,
    ).toEqual([]);
    expect(
      (await storage.health()).counts.projection_outbox_pending,
    ).toBe(2);
    await storage.close();

    storage = await SqliteStorageClient.open({ dataRoot });
    const healthy = new ConsolidationService({ storage });
    expect(
      await healthy.drain({
        worker_id: "projection_recovery_worker",
        claimed_at: "2026-07-28T12:02:02.000Z",
        lease_expires_at: "2026-07-28T12:03:02.000Z",
      }),
    ).toMatchObject({ claimed: 2, processed: 2, failed: 0 });
    const recovered = await storage.queryProjections({
      principal_id: "user_local",
      scope: SCOPE,
      as_of: "2026-07-28T12:02:30.000Z",
      limit: 100,
    });
    expect(recovered.items.length).toBeGreaterThan(0);
    expect(
      (await storage.health()).counts.projection_outbox_pending,
    ).toBe(0);

    const sources = await storage.listProjectionSources({
      principal_id: "user_local",
      scope: SCOPE,
      as_of: "2026-07-28T12:02:30.000Z",
      include_sensitive: false,
      context_scope: SCOPE,
      limit: 100,
    });
    const input = {
      principal_id: "user_local",
      scope: SCOPE,
      ledger_epoch: sources.ledger_epoch,
      tombstone_epoch: sources.tombstone_epoch,
      projection_epoch: recovered.frontier.projection_epoch,
      sources: sources.items,
    };
    const ordered = buildDeterministicProjections(input);
    const reversed = buildDeterministicProjections({
      ...input,
      sources: [...input.sources].reverse(),
    });
    expect(reversed).toEqual(ordered);
    expect(projectionStructuralDigest(reversed)).toBe(
      projectionStructuralDigest(ordered),
    );
    expect(
      await healthy.drain({
        worker_id: "projection_recovery_worker",
        claimed_at: "2026-07-28T12:03:00.000Z",
        lease_expires_at: "2026-07-28T12:04:00.000Z",
      }),
    ).toMatchObject({ claimed: 0, processed: 0, failed: 0 });
    await storage.close();
  });

  it("persists terminal consolidation attempts across Runtime restart", async () => {
    const dataRoot = temporaryRoot("projection-terminal");
    let storage = await SqliteStorageClient.open({ dataRoot });
    await seedProjectionSources(storage);
    const failing = new ConsolidationService({
      storage,
      projector: () => {
        throw new Error("persistent projection failure");
      },
    });
    for (let attempt = 1; attempt <= MAX_PROJECTION_ATTEMPTS; attempt += 1) {
      const claimedAt = new Date(
        Date.parse("2026-07-28T12:00:00.000Z") + attempt * 2_000,
      );
      const result = await failing.drain({
        worker_id: "projection_terminal_worker",
        claimed_at: claimedAt.toISOString(),
        lease_expires_at: new Date(
          claimedAt.getTime() + 60_000,
        ).toISOString(),
      });
      expect(result.claimed).toBe(2);
      expect(result.terminal).toBe(
        attempt === MAX_PROJECTION_ATTEMPTS ? 2 : 0,
      );
    }
    expect((await storage.health()).counts).toMatchObject({
      projection_outbox_retrying: 0,
      projection_outbox_terminal: 2,
    });
    await storage.close();

    storage = await SqliteStorageClient.open({ dataRoot });
    const afterRestart = await new ConsolidationService({ storage }).drain({
      worker_id: "projection_restarted_worker",
      claimed_at: "2026-07-28T13:00:00.000Z",
      lease_expires_at: "2026-07-28T13:01:00.000Z",
    });
    expect(afterRestart).toMatchObject({
      claimed: 0,
      retrying: 0,
      terminal: 2,
    });
    await storage.close();
  }, 30_000);
});
