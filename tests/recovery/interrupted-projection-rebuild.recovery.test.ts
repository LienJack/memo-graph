import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  ScopeSchema,
  canonicalSha256,
} from "../../packages/contracts/src/index.js";
import {
  ConsolidationService,
} from "../../packages/memory-kernel/src/index.js";
import {
  OperationalRepairInputSchema,
  SqliteStorageClient,
} from "@memo-graph/storage-sqlite";

import {
  memoryCandidate,
  memoryProposal,
  revisionCommand,
} from "../helpers/governance-examples.js";
import { inlineEpisode } from "../helpers/storage-examples.js";

const cleanupPaths: string[] = [];
const SCOPE = {
  kind: "workspace",
  id: ScopeSchema.parse({
    kind: "workspace",
    id: "workspace_local",
  }).id,
} as const;
const UNRELATED_SCOPE = {
  kind: "workspace",
  id: ScopeSchema.parse({
    kind: "workspace",
    id: "workspace_unrelated_repair",
  }).id,
} as const;
const STARTED_AT = "2026-07-30T12:00:00.000Z";
const COMPLETED_AT = "2026-07-30T12:01:00.000Z";

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

async function seedCurrentRevision(
  storage: SqliteStorageClient,
): Promise<{ oldRevision: string; currentRevision: string }> {
  await storage.commitEpisode(
    inlineEpisode({
      text: "Projection repair uses canonical source revision one.",
    }),
  );
  const first = await storage.admitMemory({
    request: memoryProposal({
      candidate: memoryCandidate({
        candidateId: "candidate_repair_original",
        logicalKey: "repair.current.revision",
        scope: SCOPE,
        text: "Projection repair uses canonical source revision one.",
      }),
      idempotencyKey: "repair-proposal-original",
      requestId: "request_repair_original",
    }),
    evaluation: {
      decision: "activate",
      reason: "The original canonical revision is eligible.",
    },
  });
  await storage.drainFtsOutbox();
  const replacement = memoryCandidate({
    candidateId: "candidate_repair_replacement",
    logicalKey: "repair.current.revision",
    scope: SCOPE,
    text: "Projection repair uses canonical current revision two.",
  });
  const corrected = await storage.applyMemoryRevision(
    revisionCommand({
      memoryId: first.memory_id,
      expectedRevisionId: first.current_revision_id,
      candidate: replacement,
      idempotencyKey: "repair-correction-current",
    }),
  );
  return {
    oldRevision: first.current_revision_id,
    currentRevision: corrected.current_revision_id,
  };
}

describe("interrupted canonical projection repair", () => {
  it("resumes FTS repair from canonical state and exposes only the current revision", async () => {
    const dataRoot = temporaryRoot("interrupted-fts-repair");
    let storage = await SqliteStorageClient.open({
      dataRoot,
      testOperations: true,
      testFaults: {
        operationalRepairExitAfterPrepareOnce: true,
      },
    });
    const revisions = await seedCurrentRevision(storage);
    const before = await storage.health();
    const command = OperationalRepairInputSchema.parse({
      operation_id: "repair_fts_interrupted_1",
      repair_kind: "fts",
      source: "canonical_sqlite",
      expected_frontier_hash: canonicalSha256({
        ledger_epoch: before.ledger_epoch,
        tombstone_epoch: before.tombstone_epoch,
        projection_frontier: before.projection_frontier,
      }),
      started_at: STARTED_AT,
      completed_at: COMPLETED_AT,
    });

    await expect(storage.repairFts(command)).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    });
    await expect(
      storage.inspectOperationalRepair({
        operation_id: command.operation_id,
      }),
    ).resolves.toMatchObject({
      state: "rebuilding",
      repair_kind: "fts",
      source: "canonical_sqlite",
    });
    expect((await storage.health()).projection_state).toBe("rebuilding");
    await storage.close();

    storage = await SqliteStorageClient.open({
      dataRoot,
      testOperations: true,
    });
    const completed = await storage.repairFts(command);
    expect(completed).toMatchObject({
      state: "completed",
      repair_kind: "fts",
      source: "canonical_sqlite",
    });
    await storage.commitEpisode(
      inlineEpisode({
        episodeId: "episode_after_completed_operational_repair",
        evidenceId: "evidence_after_completed_operational_repair",
        idempotencyKey: "commit-after-completed-operational-repair",
        text: "A later canonical event cannot alter a replayed repair result.",
      }),
    );
    await expect(
      storage.inspectOperationalRepair({
        operation_id: command.operation_id,
      }),
    ).resolves.toEqual(completed);
    await storage.close();

    const database = new DatabaseSync(
      join(dataRoot, "ledger", "memory.db"),
    );
    const indexed = database
      .prepare(
        `SELECT revision_id FROM memory_fts
         WHERE memory_id = (
           SELECT memory_id FROM memory_revisions WHERE revision_id = ?
         )
         ORDER BY revision_id`,
      )
      .all(revisions.currentRevision) as Array<{ revision_id: string }>;
    expect(indexed).toEqual([
      { revision_id: revisions.currentRevision },
    ]);
    expect(
      indexed.some(
        ({ revision_id }) => revision_id === revisions.oldRevision,
      ),
    ).toBe(false);
    database.close();
  });

  it("records deterministic layered and SQLite-relation repairs and rejects salvage sources", async () => {
    const dataRoot = temporaryRoot("layered-relation-repair");
    let storage = await SqliteStorageClient.open({ dataRoot });
    await seedCurrentRevision(storage);
    await storage.commitEpisode(
      inlineEpisode({
        episodeId: "episode_unrelated_repair_scope",
        evidenceId: "evidence_unrelated_repair_scope",
        idempotencyKey: "commit-unrelated-repair-scope",
        scopeId: UNRELATED_SCOPE.id,
        text: "An unrelated scope must stay ready during scoped repair.",
      }),
    );
    await storage.admitMemory({
      request: memoryProposal({
        candidate: memoryCandidate({
          candidateId: "candidate_unrelated_repair_scope",
          logicalKey: "repair.unrelated.scope",
          scope: UNRELATED_SCOPE,
          evidenceIds: ["evidence_unrelated_repair_scope"],
          text: "An unrelated scope must stay ready during scoped repair.",
        }),
        idempotencyKey: "repair-proposal-unrelated-scope",
        requestId: "request_repair_unrelated_scope",
      }),
      evaluation: {
        decision: "activate",
        reason: "Seed an independently populated repair scope.",
      },
    });
    await new ConsolidationService({ storage }).rebuild({
      principal_id: "user_local",
      scope: UNRELATED_SCOPE,
      as_of: COMPLETED_AT,
      idempotency_key: "repair-unrelated-scope-effect",
      rebuild_receipt_id: "repair_unrelated_scope_receipt_1",
    });
    const unrelatedBefore = await storage.projectionScopeFrontier({
      principal_id: "user_local",
      scope: UNRELATED_SCOPE,
    });
    const health = await storage.health();
    const frontier = canonicalSha256({
      ledger_epoch: health.ledger_epoch,
      tombstone_epoch: health.tombstone_epoch,
      projection_frontier: health.projection_frontier,
    });
    for (const repairKind of [
      "layered_projection",
      "sqlite_relations",
    ] as const) {
      const stateBeforePrepare = await storage.health();
      const command = OperationalRepairInputSchema.parse({
        operation_id: `repair_${repairKind}_1`,
        repair_kind: repairKind,
        source: "canonical_sqlite",
        principal_id: "user_local",
        scope: SCOPE,
        expected_frontier_hash: frontier,
        started_at: STARTED_AT,
        completed_at: COMPLETED_AT,
      });
      await storage.prepareOperationalRepair(command);
      expect(await storage.health()).toMatchObject({
        projection_state: stateBeforePrepare.projection_state,
        layered_projection_state:
          stateBeforePrepare.layered_projection_state,
      });
      await expect(
        storage.projectionScopeFrontier({
          principal_id: "user_local",
          scope: UNRELATED_SCOPE,
        }),
      ).resolves.toEqual(unrelatedBefore);
      await storage.close();
      storage = await SqliteStorageClient.open({ dataRoot });
      await expect(
        storage.inspectOperationalRepair({
          operation_id: command.operation_id,
        }),
      ).resolves.toMatchObject({
        state: "rebuilding",
        repair_kind: repairKind,
      });
      expect(await storage.health()).toMatchObject({
        projection_state: stateBeforePrepare.projection_state,
        layered_projection_state:
          stateBeforePrepare.layered_projection_state,
      });
      await expect(
        storage.projectionScopeFrontier({
          principal_id: "user_local",
          scope: UNRELATED_SCOPE,
        }),
      ).resolves.toEqual(unrelatedBefore);
      const service = new ConsolidationService({ storage });
      const rebuilt = await service.rebuild({
        principal_id: "user_local",
        scope: SCOPE,
        as_of: COMPLETED_AT,
        idempotency_key: `repair-${repairKind}-effect`,
        rebuild_receipt_id: `repair_${repairKind}_receipt_1`,
      });
      const relationCount = rebuilt.projections.filter(
        ({ projection_type }) => projection_type === "relation",
      ).length;
      await expect(
        storage.completeOperationalRepair({
          command: {
            ...command,
            completed_at: "2026-07-30T12:02:00.000Z",
          },
          artifact_count:
            repairKind === "sqlite_relations"
              ? relationCount
              : rebuilt.projections.length,
          relation_count: relationCount,
          ledger_epoch: rebuilt.frontier.ledger_epoch,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(
        storage.completeOperationalRepair({
          command,
          artifact_count:
            (repairKind === "sqlite_relations"
              ? relationCount
              : rebuilt.projections.length) + 1,
          relation_count: relationCount,
          ledger_epoch: rebuilt.frontier.ledger_epoch,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(
        storage.completeOperationalRepair({
          command,
          artifact_count:
            repairKind === "sqlite_relations"
              ? relationCount
              : rebuilt.projections.length,
          relation_count: relationCount,
          ledger_epoch: rebuilt.frontier.ledger_epoch,
        }),
      ).resolves.toMatchObject({
        state: "completed",
        repair_kind: repairKind,
        source: "canonical_sqlite",
      });
    }
    expect(() =>
      OperationalRepairInputSchema.parse({
        operation_id: "repair_salvage_forbidden_1",
        repair_kind: "fts",
        source: "salvage_quarantine",
        expected_frontier_hash: frontier,
        started_at: STARTED_AT,
        completed_at: COMPLETED_AT,
      }),
    ).toThrow();
    await storage.close();
  });
});
