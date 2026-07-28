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
} from "../../packages/memory-kernel/src/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";

import {
  memoryCandidate,
  memoryProposal,
} from "../helpers/governance-examples.js";
import { inlineEpisode } from "../helpers/storage-examples.js";

const cleanupPaths: string[] = [];
const RAW_SCOPE = {
  kind: "workspace",
  id: "workspace_local",
} as const;
const SCOPE = ScopeSchema.parse(RAW_SCOPE);

function temporaryRoot(prefix: string): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-graph-${prefix}-`)),
  );
  cleanupPaths.push(root);
  return root;
}

async function seedRichSources(storage: SqliteStorageClient): Promise<void> {
  const definitions = [
    {
      suffix: "semantic_a",
      kind: "semantic" as const,
      text: "SQLite is authoritative.",
      validFrom: "2026-07-28T11:00:00.000Z",
    },
    {
      suffix: "semantic_b",
      kind: "semantic" as const,
      text: "  sqlite   is authoritative.  ",
      validFrom: "2026-07-28T11:10:00.000Z",
    },
    {
      suffix: "episode",
      kind: "episodic" as const,
      text: "A stale derived view was suppressed before refresh.",
      validFrom: "2026-07-28T11:20:00.000Z",
    },
    {
      suffix: "procedure",
      kind: "procedural" as const,
      text: "Revalidate exact source revisions before Context use.",
      validFrom: "2026-07-28T11:30:00.000Z",
    },
  ] as const;
  for (const definition of definitions) {
    const evidenceId = `evidence_rich_${definition.suffix}`;
    const candidate = memoryCandidate({
      candidateId: `candidate_rich_${definition.suffix}`,
      logicalKey: `projection.rich.${definition.suffix}`,
      kind: definition.kind,
      scope: RAW_SCOPE,
      text: definition.text,
      evidenceIds: [evidenceId],
      validFrom: definition.validFrom,
    });
    await storage.commitEpisode(
      inlineEpisode({
        episodeId: `episode_rich_${definition.suffix}`,
        evidenceId,
        idempotencyKey: `commit:rich:${definition.suffix}:0001`,
        text: definition.text.trim(),
      }),
    );
    await storage.admitMemory({
      request: memoryProposal({
        candidate,
        idempotencyKey: `memory-rich-${definition.suffix}-0001`,
        requestId: `request_rich_${definition.suffix}`,
      }),
      evaluation: {
        decision: "activate",
        reason: "Rich projection fixtures require governed sources.",
      },
    });
  }
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target !== undefined) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

describe("deterministic projection rebuild", () => {
  it("matches incremental output, exact lineage, and restart state", async () => {
    const incrementalRoot = temporaryRoot("projection-incremental");
    const rebuildRoot = temporaryRoot("projection-rebuild");
    let incremental = await SqliteStorageClient.open({
      dataRoot: incrementalRoot,
    });
    let rebuilt = await SqliteStorageClient.open({
      dataRoot: rebuildRoot,
    });
    await seedRichSources(incremental);
    await seedRichSources(rebuilt);

    const incrementalService = new ConsolidationService({
      storage: incremental,
    });
    expect(
      await incrementalService.drain({
        worker_id: "projection_incremental_worker",
        claimed_at: "2026-07-28T12:10:00.000Z",
        lease_expires_at: "2026-07-28T12:11:00.000Z",
      }),
    ).toMatchObject({ claimed: 4, processed: 4, failed: 0 });
    const incrementalSnapshot = await incrementalService.rebuild({
      principal_id: "user_local",
      scope: SCOPE,
      as_of: "2026-07-28T12:10:30.000Z",
      idempotency_key: "projection-incremental-verify-0001",
      rebuild_receipt_id: "projection_incremental_receipt_0001",
    });

    const rebuildService = new ConsolidationService({ storage: rebuilt });
    const fullSnapshot = await rebuildService.rebuild({
      principal_id: "user_local",
      scope: SCOPE,
      as_of: "2026-07-28T12:10:00.000Z",
      idempotency_key: "projection-full-rebuild-0001",
      rebuild_receipt_id: "projection_full_rebuild_receipt_0001",
    });
    expect(fullSnapshot.applied).toBe(true);
    expect(
      [...new Set(
        fullSnapshot.projections.map(
          (projection) => projection.projection_type,
        ),
      )].sort(),
    ).toEqual(["core", "procedure", "relation", "scenario", "topic"]);
    for (const projection of fullSnapshot.projections) {
      expect(projection.source_revisions.length).toBeGreaterThan(0);
      expect(projection.evidence_ids).toEqual(
        [...new Set(
          projection.source_revisions.flatMap(
            (source) => source.evidence_ids,
          ),
        )].sort(),
      );
    }
    expect(fullSnapshot.structural_digest).toBe(
      incrementalSnapshot.structural_digest,
    );
    expect(fullSnapshot.projections).toEqual(
      incrementalSnapshot.projections,
    );

    await incremental.close();
    await rebuilt.close();
    incremental = await SqliteStorageClient.open({
      dataRoot: incrementalRoot,
    });
    rebuilt = await SqliteStorageClient.open({ dataRoot: rebuildRoot });
    const incrementalAfterRestart = await incremental.queryProjections({
      principal_id: "user_local",
      scope: SCOPE,
      as_of: "2026-07-28T12:11:00.000Z",
      limit: 1_000,
    });
    const rebuiltAfterRestart = await rebuilt.queryProjections({
      principal_id: "user_local",
      scope: SCOPE,
      as_of: "2026-07-28T12:11:00.000Z",
      limit: 1_000,
    });
    expect(rebuiltAfterRestart.items).toEqual(
      incrementalAfterRestart.items,
    );
    expect(rebuiltAfterRestart.frontier).toEqual(
      incrementalAfterRestart.frontier,
    );
    await incremental.close();
    await rebuilt.close();
  });
});
