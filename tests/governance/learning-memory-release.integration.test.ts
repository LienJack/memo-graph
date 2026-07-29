import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CandidateChangeSchema,
  ReleaseSlotSchema,
  canonicalSha256,
  canonicalSha256Omitting,
} from "../../packages/contracts/src/index.js";
import {
  MemoryRuntime,
} from "../../packages/memory-kernel/src/index.js";
import {
  LearningReleaseManager,
} from "../../packages/learning-lab/src/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";

import { TestApprovalRegistry } from "../helpers/approval.js";
import {
  authorizeRelease,
  authorizeRollback,
  preparePassedCanary,
  releaseRequest,
  rollbackRequest,
  RELEASE_SCOPES,
  TestReleaseApprovalRegistry,
} from "../helpers/g5-release.js";
import {
  memoryCandidate,
  memoryProposal,
} from "../helpers/governance-examples.js";
import {
  learningCandidate,
} from "../helpers/learning-examples.js";
import { inlineEpisode } from "../helpers/storage-examples.js";

const cleanupPaths: string[] = [];

function temporaryRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "memo-graph-memory-release-")),
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

describe("canonical memory learning release adapter", () => {
  it("keeps immutable source content canonical and appends the activation successor atomically", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot(),
    });
    try {
      const candidate = memoryCandidate({
        candidateId: "candidate_learning_memory_source",
        logicalKey: "learning.memory.source",
        kind: "procedural",
        scope: { kind: "workspace", id: "workspace_local" },
        text: "Use the canonical release adapter.",
        evidenceIds: ["evidence_learning_memory_source"],
      });
      await storage.commitEpisode(
        inlineEpisode({
          episodeId: "episode_learning_memory_source",
          evidenceId: "evidence_learning_memory_source",
          idempotencyKey: "commit:learning-memory-source:0001",
          text: "Use the canonical release adapter.",
        }),
      );
      const admitted = await storage.admitMemory({
        request: memoryProposal({
          candidate,
          idempotencyKey: "memory-learning-source-0001",
          requestId: "request_learning_memory_source",
        }),
        evaluation: {
          decision: "candidate_only",
          reason: "Learning release must own the activation.",
        },
      });
      const before = await storage.getGovernedMemory({
        memory_id: admitted.memory_id,
        principal_id: "user_local",
        scope: candidate.scope,
        as_of: "2026-07-28T12:00:00.000Z",
        include_sensitive: true,
        context_scope: candidate.scope,
      });
      expect(before).toMatchObject({
        eligible: false,
        revision_id: admitted.current_revision_id,
      });

      const slotInput = {
        principal_id: "user_local",
        candidate_type: "procedure" as const,
        scopes: RELEASE_SCOPES,
        target_key: "default_procedure",
        slot_hash: canonicalSha256("placeholder"),
      };
      const slot = ReleaseSlotSchema.parse({
        ...slotInput,
        slot_hash: canonicalSha256Omitting(slotInput, ["slot_hash"]),
      });
      const baseLearningCandidate = learningCandidate();
      const learningInput = {
        ...baseLearningCandidate,
        candidate_type: "procedure" as const,
        release_slot: slot,
        target: {
          kind: "procedure" as const,
          memory_id: admitted.memory_id,
          revision_id: admitted.current_revision_id,
          content_hash: candidate.content_hash,
        },
        candidate_hash: canonicalSha256("placeholder"),
      };
      const governedCandidate = CandidateChangeSchema.parse({
        ...learningInput,
        candidate_hash: canonicalSha256Omitting(learningInput, [
          "candidate_hash",
        ]),
      });
      const prepared = await preparePassedCanary({
        storage,
        suffix: "canonical-memory",
        candidate: governedCandidate,
      });
      const request = releaseRequest({
        suffix: "canonical-memory",
        candidateId: governedCandidate.candidate_id,
        operatorLanePolicy: null,
        baseConfigurationHash: canonicalSha256({
          memory_id: admitted.memory_id,
          revision_id: admitted.current_revision_id,
          lifecycle: "candidate",
        }),
      });
      const approvals = new TestReleaseApprovalRegistry();
      authorizeRelease({ request, prepared, approvals });
      const released = await new LearningReleaseManager({
        storage,
        authorityRegistry: prepared.authority,
        approvalRegistry: approvals,
        clock: () => "2026-07-28T12:05:00.000Z",
      }).apply(request);
      expect(released.release).toMatchObject({
        action: "release",
        candidate_id: governedCandidate.candidate_id,
      });
      const afterLedger = await storage.readLearningLedger({
        principal_id: request.principal_id,
        scopes: request.scopes,
        candidate_id: request.candidate_id,
      });
      expect(afterLedger.pointers[0]?.active_release_id).toBe(
        released.release.release_id,
      );
      const active = await storage.getGovernedMemory({
        memory_id: admitted.memory_id,
        principal_id: "user_local",
        scope: candidate.scope,
        as_of: "2026-07-28T12:06:00.000Z",
        include_sensitive: true,
        context_scope: candidate.scope,
      });
      if (active === null || !active.eligible) {
        throw new Error("canonical release successor must be eligible");
      }
      expect(active.item.revision_id).not.toBe(
        admitted.current_revision_id,
      );
      expect(active.item.content_hash).toBe(candidate.content_hash);
      expect(
        await storage.contentReferenceCounts({
          content_hash: candidate.content_hash,
        }),
      ).toMatchObject({
        memory_revisions: 2,
      });

      const rollback = rollbackRequest({
        suffix: "canonical-memory",
        released,
        operatorLanePolicy: null,
        baseConfigurationHash: request.base_configuration_hash,
      });
      authorizeRollback({
        request: rollback,
        prepared,
        released,
        approvals,
      });
      const rolledBack = await new LearningReleaseManager({
        storage,
        authorityRegistry: prepared.authority,
        approvalRegistry: approvals,
        clock: () => "2026-07-28T12:06:00.000Z",
      }).apply(rollback);
      expect(rolledBack.pointer).toMatchObject({
        active_release_id: null,
        pointer_revision: 2,
      });
      const restored = await storage.getGovernedMemory({
        memory_id: admitted.memory_id,
        principal_id: "user_local",
        scope: candidate.scope,
        as_of: "2026-07-28T12:07:00.000Z",
        include_sensitive: true,
        context_scope: candidate.scope,
      });
      expect(restored).toMatchObject({
        eligible: false,
        revision_id: expect.not.stringMatching(
          admitted.current_revision_id,
        ),
      });
      expect(
        await storage.contentReferenceCounts({
          content_hash: candidate.content_hash,
        }),
      ).toMatchObject({
        memory_revisions: 3,
      });
    } finally {
      await storage.close();
    }
  });

  it("refuses rollback after the canonical memory target is revoked", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot(),
    });
    try {
      const candidate = memoryCandidate({
        candidateId: "candidate_learning_memory_revoked",
        logicalKey: "learning.memory.revoked",
        kind: "procedural",
        scope: { kind: "workspace", id: "workspace_local" },
        text: "Never resurrect a revoked learning target.",
        evidenceIds: ["evidence_learning_memory_revoked"],
      });
      await storage.commitEpisode(
        inlineEpisode({
          episodeId: "episode_learning_memory_revoked",
          evidenceId: "evidence_learning_memory_revoked",
          idempotencyKey: "commit:learning-memory-revoked:0001",
          text: "Never resurrect a revoked learning target.",
        }),
      );
      const admitted = await storage.admitMemory({
        request: memoryProposal({
          candidate,
          idempotencyKey: "memory-learning-revoked-0001",
          requestId: "request_learning_memory_revoked",
        }),
        evaluation: {
          decision: "candidate_only",
          reason: "Learning release must own the activation.",
        },
      });
      const slotInput = {
        principal_id: "user_local",
        candidate_type: "procedure" as const,
        scopes: RELEASE_SCOPES,
        target_key: "default_procedure",
        slot_hash: canonicalSha256("placeholder"),
      };
      const slot = ReleaseSlotSchema.parse({
        ...slotInput,
        slot_hash: canonicalSha256Omitting(slotInput, ["slot_hash"]),
      });
      const baseLearningCandidate = learningCandidate();
      const learningInput = {
        ...baseLearningCandidate,
        candidate_id: "candidate_learning_memory_revoked_release",
        candidate_type: "procedure" as const,
        release_slot: slot,
        target: {
          kind: "procedure" as const,
          memory_id: admitted.memory_id,
          revision_id: admitted.current_revision_id,
          content_hash: candidate.content_hash,
        },
        candidate_hash: canonicalSha256("placeholder"),
      };
      const governedCandidate = CandidateChangeSchema.parse({
        ...learningInput,
        candidate_hash: canonicalSha256Omitting(learningInput, [
          "candidate_hash",
        ]),
      });
      const prepared = await preparePassedCanary({
        storage,
        suffix: "canonical-memory-revoked",
        candidate: governedCandidate,
      });
      const request = releaseRequest({
        suffix: "canonical-memory-revoked",
        candidateId: governedCandidate.candidate_id,
        operatorLanePolicy: null,
        baseConfigurationHash: canonicalSha256({
          memory_id: admitted.memory_id,
          revision_id: admitted.current_revision_id,
          lifecycle: "candidate",
        }),
      });
      const approvals = new TestReleaseApprovalRegistry();
      authorizeRelease({ request, prepared, approvals });
      const released = await new LearningReleaseManager({
        storage,
        authorityRegistry: prepared.authority,
        approvalRegistry: approvals,
        clock: () => "2026-07-28T12:05:00.000Z",
      }).apply(request);
      const active = await storage.getGovernedMemory({
        memory_id: admitted.memory_id,
        principal_id: "user_local",
        scope: candidate.scope,
        as_of: "2026-07-28T12:06:00.000Z",
        include_sensitive: true,
        context_scope: candidate.scope,
      });
      if (active === null || !active.eligible) {
        throw new Error("released target must be active before revocation");
      }

      const revoke = {
        envelope: {
          schema_version: "1.0.0",
          request_id: "request_learning_memory_revoke_after_release",
          tool: "memory_revoke" as const,
          safety_class: "important_mutation" as const,
          actor_claim: {
            principal_id: "user_local",
            authority: "user_stated" as const,
          },
          scopes: [candidate.scope],
          purpose: "Prove learning rollback cannot resurrect revoked memory",
          reason: "Revoke the active canonical target before rollback",
          requested_at: "2026-07-28T12:06:00.000Z",
          idempotency_key: "learning-memory-revoke-after-release-001",
          expected_revision_id: active.item.revision_id,
          approval_id: "approval_learning_memory_revoke_after_release",
          dry_run: false,
        },
        memory_id: admitted.memory_id,
      };
      const governanceApprovals = new TestApprovalRegistry();
      governanceApprovals.approve(revoke);
      const runtime = new MemoryRuntime({
        storage,
        approvalRegistry: governanceApprovals,
        clock: () => "2026-07-28T12:06:00.000Z",
        policy: {
          principal: {
            principal_id: "user_local",
            allowed_scopes: [candidate.scope],
            allowed_authorities: ["user_stated"],
            destructive_tools_enabled: true,
          },
          default_token_budget: 1_800,
        },
      });
      await expect(runtime.memoryRevoke(revoke)).resolves.toMatchObject({
        status: "OK",
        data: { outcome: "REVOKED" },
      });

      const rollback = rollbackRequest({
        suffix: "canonical-memory-revoked",
        released,
        operatorLanePolicy: null,
        baseConfigurationHash: request.base_configuration_hash,
      });
      authorizeRollback({
        request: rollback,
        prepared,
        released,
        approvals,
      });
      await expect(
        new LearningReleaseManager({
          storage,
          authorityRegistry: prepared.authority,
          approvalRegistry: approvals,
          clock: () => "2026-07-28T12:07:00.000Z",
        }).apply(rollback),
      ).rejects.toMatchObject({ code: "CANDIDATE_INACCESSIBLE" });

      const ledger = await storage.readLearningLedger({
        principal_id: request.principal_id,
        scopes: request.scopes,
        candidate_id: request.candidate_id,
      });
      expect(ledger.invalid_candidate_ids).toContain(
        governedCandidate.candidate_id,
      );
      expect(ledger.pointers[0]).toMatchObject({
        active_release_id: released.release.release_id,
        pointer_revision: 1,
      });
      expect(ledger.releases).toHaveLength(1);
    } finally {
      await storage.close();
    }
  });
});
