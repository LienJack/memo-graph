import {
  mkdtemp,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import {
  memoryCandidate,
  memoryProposal,
  revisionCommand,
} from "../helpers/governance-examples.js";
import { seedProjectionSources } from "../helpers/projection-examples.js";
import {
  VECTOR_NOW,
  VECTOR_SCOPE,
  qualifiedVectorEpoch,
} from "../helpers/vector-examples.js";
import {
  VECTOR_CONTROL_NOW,
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

describe("vector correction coupling", () => {
  it("commits canonical correction and vector invalidation in one observable state", async () => {
    const root = await mkdtemp(
      join(await realpath(tmpdir()), "memo-graph-vector-correction-"),
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
      const source = sources[0];
      const corrected = memoryCandidate({
        candidateId: "candidate_vector_corrected",
        logicalKey: "projection.source.a",
        scope: { kind: "workspace", id: "workspace_local" },
        text: "SQLite remains authority after correction.",
        evidenceIds: ["evidence_projection_a"],
      });
      const correction = await client.applyMemoryRevision(
        revisionCommand({
          memoryId: source.memory_id,
          expectedRevisionId: source.revision_id,
          candidate: corrected,
          idempotencyKey: "vector-correction-0001",
        }),
      );
      expect(await client.vectorProjectionStatus()).toMatchObject({
        mode: "evaluating",
        outbox_pending: 1,
      });
      await expect(
        client.vectorProjectionCheckpoint({
          principal_id: "user_local",
          scope: { kind: "workspace", id: "workspace_local" },
        }),
      ).resolves.toMatchObject({
        state: "pending",
        active_epoch_id: null,
        frontier: {
          ledger_epoch: correction.receipt.resulting_epoch,
        },
      });
    } finally {
      await client.close();
    }
  });

  it("suppresses an old published hit immediately and recalls only the rebuilt successor", async () => {
    const root = await mkdtemp(
      join(
        await realpath(tmpdir()),
        "memo-graph-vector-correction-recall-",
      ),
    );
    roots.push(root);
    const harness = await openGovernedVectorHarness({
      dataRoot: root,
    });
    try {
      const source = harness.sources[0];
      const initial = await harness.recall();
      expect(
        initial.candidates.some(
          (candidate) =>
            candidate.kind === "memory" &&
            candidate.memory.revision_id === source.revision_id,
        ),
      ).toBe(true);

      const correctedCandidate = memoryCandidate({
        candidateId: "candidate_vector_corrected_recall",
        logicalKey: "projection.source.a",
        scope: VECTOR_SCOPE,
        text: "SQLite remains authority after governed correction.",
        evidenceIds: source.evidence_ids,
      });
      const corrected = await harness.storage.applyMemoryRevision(
        revisionCommand({
          memoryId: source.memory_id,
          expectedRevisionId: source.revision_id,
          candidate: correctedCandidate,
          idempotencyKey: "vector-correction-recall-0001",
        }),
      );
      const immediate = await harness.recall();
      expect(immediate.status).toBe("DEGRADED");
      expect(immediate.candidates).toEqual([]);
      expect(JSON.stringify(immediate)).not.toContain(
        source.revision_id,
      );
      expect(
        immediate.telemetry.find(
          (item) => item.lane === "semantic_vector",
        ),
      ).toMatchObject({
        status: "degraded",
        reason_codes: ["VECTOR_SCOPE_PENDING"],
      });

      await harness.projector.drain({
        worker_id: "vector_correction_replacement",
        claimed_at: "2026-07-29T06:31:00.000Z",
        lease_expires_at: "2026-07-29T06:32:00.000Z",
        completed_at: "2026-07-29T06:31:05.000Z",
        retry_at: "2026-07-29T06:32:05.000Z",
      });
      const rebuilt = await harness.recall();
      expect(rebuilt.status).toBe("OK");
      expect(
        rebuilt.candidates.some(
          (candidate) =>
            candidate.kind === "memory" &&
            candidate.memory.revision_id ===
              corrected.current_revision_id,
        ),
      ).toBe(true);
      expect(JSON.stringify(rebuilt)).not.toContain(source.revision_id);
    } finally {
      await harness.storage.close();
    }
  });

  it("keeps a pinned source eligible without changing vector scope authority", async () => {
    const root = await mkdtemp(
      join(
        await realpath(tmpdir()),
        "memo-graph-vector-pin-recall-",
      ),
    );
    roots.push(root);
    const harness = await openGovernedVectorHarness({
      dataRoot: root,
    });
    try {
      const source = harness.sources[0];
      const request = {
        envelope: {
          schema_version: "1.0.0",
          request_id: "request_vector_pin_u6",
          tool: "memory_pin" as const,
          safety_class: "important_mutation" as const,
          actor_claim: {
            principal_id: "user_local",
            authority: "user_stated" as const,
          },
          scopes: [VECTOR_SCOPE],
          purpose: "Preserve an eligible governed memory",
          reason: "Pin retention without granting authority",
          requested_at: VECTOR_CONTROL_NOW,
          idempotency_key: "vector-pin-u6-0001",
          expected_revision_id: source.revision_id,
          approval_id: "approval_vector_pin_u6",
          dry_run: false,
        },
        memory_id: source.memory_id,
        pinned: true,
      };
      harness.approvals.approve(request);
      const pinned = await harness.memoryRuntime.memoryPin(request);
      expect(pinned, JSON.stringify(pinned)).toMatchObject({
        status: "OK",
        data: {
          outcome: "PINNED",
          memory_id: source.memory_id,
        },
      });

      const recalled = await harness.recall();
      expect(recalled.status).toBe("OK");
      expect(
        recalled.candidates.some(
          (candidate) =>
            candidate.kind === "memory" &&
            candidate.memory.revision_id === source.revision_id,
        ),
      ).toBe(true);
      await expect(
        harness.storage.vectorProjectionCheckpoint({
          principal_id: "user_local",
          scope: VECTOR_SCOPE,
        }),
      ).resolves.toMatchObject({
        state: "published",
      });
    } finally {
      await harness.storage.close();
    }
  });

  it("suppresses semantic recall while an exact-scope logical conflict is open", async () => {
    const root = await mkdtemp(
      join(
        await realpath(tmpdir()),
        "memo-graph-vector-conflict-recall-",
      ),
    );
    roots.push(root);
    const harness = await openGovernedVectorHarness({
      dataRoot: root,
    });
    try {
      const source = harness.sources[0];
      const conflict = await harness.storage.admitMemory({
        request: memoryProposal({
          candidate: memoryCandidate({
            candidateId: "candidate_vector_open_conflict",
            logicalKey: "projection.source.a",
            scope: VECTOR_SCOPE,
            text:
              "A conflicting candidate must never inherit vector authority.",
            evidenceIds: source.evidence_ids,
          }),
          idempotencyKey: "vector-open-conflict-0001",
          requestId: "request_vector_open_conflict",
        }),
        evaluation: {
          decision: "activate",
          reason: "Exercise governed conflict suppression.",
        },
      });
      expect(conflict.outcome).toBe("CONFLICT");

      const recalled = await harness.recall();
      expect(recalled.status).toBe("DEGRADED");
      expect(recalled.candidates).toEqual([]);
      expect(JSON.stringify(recalled)).not.toContain(
        source.revision_id,
      );
      await expect(
        harness.storage.vectorProjectionCheckpoint({
          principal_id: "user_local",
          scope: VECTOR_SCOPE,
        }),
      ).resolves.toMatchObject({
        state: "pending",
      });
    } finally {
      await harness.storage.close();
    }
  });

  it("suppresses an expired vector scope at the temporal frontier before rebuild", async () => {
    const root = await mkdtemp(
      join(
        await realpath(tmpdir()),
        "memo-graph-vector-expiry-recall-",
      ),
    );
    roots.push(root);
    let expiringRevisionId = "";
    const harness = await openGovernedVectorHarness({
      dataRoot: root,
      beforeVectorConfigure: async ({ storage, sources }) => {
        const source = sources[0];
        const revised = await storage.applyMemoryRevision(
          revisionCommand({
            memoryId: source.memory_id,
            expectedRevisionId: source.revision_id,
            candidate: memoryCandidate({
              candidateId: "candidate_vector_expiring",
              logicalKey: "projection.source.a",
              scope: VECTOR_SCOPE,
              text: "This vector source expires at its sealed frontier.",
              evidenceIds: source.evidence_ids,
              validTo: "2026-07-29T06:20:00.000Z",
            }),
            idempotencyKey: "vector-expiring-revision-0001",
          }),
        );
        expiringRevisionId = revised.current_revision_id;
      },
    });
    try {
      const beforeExpiry = await harness.orchestrator.recall({
        principal_id: "user_local",
        scope: VECTOR_SCOPE,
        query: "sealed frontier",
        as_of: "2026-07-29T06:10:00.000Z",
        include_sensitive: false,
        lane_policy: {
          allowed_lanes: ["semantic_vector"],
          limits: {
            max_candidates_per_lane: 20,
            relation_max_depth: 2,
            relation_max_fanout: 5,
            max_concurrent_lanes: 2,
            vector_top_k: 20,
            vector_query_timeout_ms: 50,
            vector_max_response_bytes: 65_536,
          },
        },
      });
      expect(
        beforeExpiry.candidates.some(
          (candidate) =>
            candidate.kind === "memory" &&
            candidate.memory.revision_id === expiringRevisionId,
        ),
      ).toBe(true);

      const sweep = await harness.storage.runVectorTemporalSweep({
        as_of: "2026-07-29T06:30:00.000Z",
        limit: 100,
      });
      expect(sweep).toMatchObject({
        truncated: false,
        checkpoints: [
          expect.objectContaining({
            state: "pending",
          }),
        ],
      });
      const expired = await harness.recall();
      expect(expired.status).toBe("DEGRADED");
      expect(expired.candidates).toEqual([]);
      expect(JSON.stringify(expired)).not.toContain(
        expiringRevisionId,
      );
    } finally {
      await harness.storage.close();
    }
  });
});
