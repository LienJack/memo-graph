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
  EvidenceRecordSchema,
  canonicalSha256,
} from "../../packages/contracts/src/index.js";
import {
  SqliteStorageClient,
} from "@memo-graph/storage-sqlite";

import {
  memoryCandidate,
  revisionCommand,
} from "../helpers/governance-examples.js";
import {
  projectionFrontier,
  relationProjection,
  seedProjectionSources,
  topicProjection,
} from "../helpers/projection-examples.js";

const cleanupPaths: string[] = [];
const SCOPE = { kind: "workspace", id: "workspace_local" } as const;
const NOW = "2026-07-28T12:03:00.000Z";

function temporaryRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "memo-graph-workbench-impact-")),
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

describe("Memory Workbench correction impact", () => {
  it("previews a complete bounded closure and atomically appends feedback before suppressing it", async () => {
    const dataRoot = temporaryRoot();
    const storage = await SqliteStorageClient.open({ dataRoot });
    const sources = await seedProjectionSources(storage);
    const [source] = sources;
    const health = await storage.health();
    const frontier = projectionFrontier({
      ledgerEpoch: health.ledger_epoch,
      tombstoneEpoch: health.tombstone_epoch,
      projectionEpoch: health.projection_frontier.projection_epoch + 1,
    });
    await storage.applyProjectionBatch({
      principal_id: "user_local",
      scope: SCOPE,
      idempotency_key: "workbench-impact-projections-0001",
      expected_projection_epoch: health.projection_frontier.projection_epoch,
      frontier,
      projections: [
        topicProjection(sources, frontier),
        relationProjection(sources, frontier),
      ],
      applied_at: "2026-07-28T12:02:00.000Z",
    });

    await expect(
      storage.previewWorkbenchCorrection({
        memory_id: source.memory_id,
        principal_id: "user_local",
        scope: SCOPE,
        expected_revision_id: source.revision_id,
        impact_limit: 1,
        sample_limit: 1,
      }),
    ).rejects.toMatchObject({
      code: "CORRECTION_IMPACT_LIMIT_EXCEEDED",
    });

    const preview = await storage.previewWorkbenchCorrection({
      memory_id: source.memory_id,
      principal_id: "user_local",
      scope: SCOPE,
      expected_revision_id: source.revision_id,
      impact_limit: 1_000,
      sample_limit: 1,
    });
    expect(preview.basis).toMatchObject({
      current_revision_id: source.revision_id,
      scope: SCOPE,
    });
    expect(preview.impact).toMatchObject({
      source_revision_id: source.revision_id,
      descendant_count: 2,
      supported_limit: 1_000,
      sample_truncated: true,
      omitted_count: 1,
    });
    expect(preview.impact.sample).toHaveLength(1);

    const feedbackPayload = {
      storage: "inline",
      text: "The canonical memory must describe immediate invalidation.",
      media_type: "text/plain",
    } as const;
    const feedback = EvidenceRecordSchema.parse({
      schema_version: "1.0.0",
      evidence_id: "evidence_workbench_feedback_0001",
      sequence: 0,
      occurred_at: NOW,
      recorded_at: NOW,
      scope: SCOPE,
      actor: { principal_id: "user_local", authority: "user_stated" },
      source: "user_feedback",
      authority: "user_stated",
      sensitivity: "personal",
      payload: feedbackPayload,
      content_hash: canonicalSha256(feedbackPayload),
    });
    const candidate = memoryCandidate({
      candidateId: "candidate_workbench_correction_0001",
      logicalKey: preview.basis.logical_key,
      scope: SCOPE,
      text: "Canonical correction suppresses every sealed descendant.",
      evidenceIds: [feedback.evidence_id],
    });
    const expectedImpact = {
      source_revision_id: preview.impact.source_revision_id,
      descendant_count: preview.impact.descendant_count,
      closure_hash: preview.impact.closure_hash,
      supported_limit: preview.impact.supported_limit,
    } as const;
    const baseCommand = {
      ...revisionCommand({
        memoryId: source.memory_id,
        expectedRevisionId: source.revision_id,
        candidate,
        idempotencyKey: "workbench-correction-invalid-impact-0001",
      }),
      correction_evidence: feedback,
      expected_projection_impact: expectedImpact,
    } as const;

    await expect(
      storage.applyMemoryRevision({
        ...baseCommand,
        expected_projection_impact: {
          ...expectedImpact,
          closure_hash: `sha256:${"0".repeat(64)}`,
        },
      }),
    ).rejects.toMatchObject({
      code: "STALE_PROJECTION_FRONTIER",
    });

    const corrected = await storage.applyMemoryRevision({
      ...baseCommand,
      idempotency_key: "workbench-correction-valid-impact-0001",
    });
    const replayed = await storage.applyMemoryRevision({
      ...baseCommand,
      idempotency_key: "workbench-correction-valid-impact-0001",
    });
    expect(replayed).toEqual({ ...corrected, replayed: true });
    await storage.close();

    const database = new DatabaseSync(join(dataRoot, "ledger", "memory.db"));
    const scalar = (sql: string): number =>
      Number((database.prepare(sql).get() as { count: number }).count);
    expect(
      scalar(
        `SELECT count(*) AS count FROM evidence_events
         WHERE evidence_id = 'evidence_workbench_feedback_0001'`,
      ),
    ).toBe(1);
    expect(
      scalar(
        `SELECT count(*) AS count FROM memory_revisions
         WHERE memory_id = '${source.memory_id}'`,
      ),
    ).toBe(2);
    expect(
      scalar(
        `SELECT count(*) AS count FROM projection_invalidations
         WHERE source_revision_id = '${source.revision_id}'`,
      ),
    ).toBe(2);
    database.close();
  });
});
