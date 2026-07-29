import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MemoryRuntime } from "../../packages/memory-kernel/src/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";

import { TestApprovalRegistry } from "../helpers/approval.js";
import { NOW } from "../helpers/examples.js";
import {
  memoryCandidate,
  memoryProposal,
} from "../helpers/governance-examples.js";
import { inlineEpisode } from "../helpers/storage-examples.js";

const WORKSPACE_SCOPE = {
  kind: "workspace",
  id: "workspace_local",
} as const;
const cleanupPaths: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-graph-${prefix}-`)),
  );
  cleanupPaths.push(root);
  return root;
}

function readEnvelope<const T extends string>(tool: T, suffix: string) {
  return {
    schema_version: "1.0.0",
    request_id: `request_${suffix}`,
    tool,
    actor_claim: {
      principal_id: "user_local",
      authority: "user_stated",
    },
    scopes: [WORKSPACE_SCOPE],
    purpose: "continue governed memory service while learning is paused",
    reason: "learning control must not interrupt the core memory runtime",
    requested_at: NOW,
    safety_class: "read_only",
  } as const;
}

function createRuntime(
  storage: SqliteStorageClient,
  approvals: TestApprovalRegistry,
) {
  return new MemoryRuntime({
    storage,
    approvalRegistry: approvals,
    clock: () => NOW,
    policy: {
      principal: {
        principal_id: "user_local",
        allowed_scopes: [WORKSPACE_SCOPE],
        allowed_authorities: ["user_stated", "tool_result"],
        destructive_tools_enabled: false,
      },
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

describe("learning pause runtime continuity", () => {
  it("keeps explicit memory reads and writes available while learning stays stopped", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("learning-pause-continuity"),
    });
    try {
      const approvals = new TestApprovalRegistry();
      const runtime = createRuntime(storage, approvals);
      const episode = inlineEpisode({
        evidenceId: "evidence_continuity_1",
        text: "Core governed memory remains available.",
      });
      await storage.commitEpisode({
        idempotencyKey: episode.idempotencyKey,
        episode: episode.episode,
        evidence: episode.evidence,
        blobs: [],
      });
      await storage.drainFtsOutbox();
      const proposed = await runtime.memoryPropose(
        memoryProposal({
          candidate: memoryCandidate({
            candidateId: "candidate_continuity_1",
            logicalKey: "workspace.continuity",
            scope: WORKSPACE_SCOPE,
            evidenceIds: ["evidence_continuity_1"],
          }),
          idempotencyKey: "memory-propose-continuity-001",
          requestId: "request_continuity_propose",
          scope: WORKSPACE_SCOPE,
        }),
      );
      expect(proposed).toMatchObject({ status: "OK" });
      if (proposed.status !== "OK") {
        throw new Error("continuity memory must be admitted");
      }
      const admitted = proposed.data as {
        memory_id: string;
        current_revision_id: string;
      };

      const controlFrontier =
        (await runtime.learningInspection()).action_frontier;
      const pauseRequest = {
        envelope: {
          ...readEnvelope("learning_pause", "continuity_pause"),
          safety_class: "important_mutation",
          idempotency_key: "learning-continuity-pause-001",
          expected_revision_id: null,
          approval_id: "approval_continuity_pause",
          dry_run: false,
        },
        expected_control_epoch:
          controlFrontier.expected_control_epoch,
        expected_frontier_hash:
          controlFrontier.expected_frontier_hash,
        runtime_identity_hash:
          controlFrontier.runtime_identity_hash,
        configuration_hash:
          controlFrontier.configuration_hash,
        corpus_hash: controlFrontier.corpus_hash,
      } as const;
      approvals.approve(pauseRequest);
      expect(await runtime.learningPause(pauseRequest)).toMatchObject({
        status: "OK",
      });

      expect(
        await runtime.memorySearch({
          envelope: readEnvelope("memory_search", "continuity_search"),
          query: "Core governed memory",
          limit: 10,
          include_sensitive: false,
        }),
      ).toMatchObject({ status: "OK" });
      expect(
        await runtime.memoryGet({
          envelope: readEnvelope("memory_get", "continuity_get"),
          evidence_id: "evidence_continuity_1",
          scope: WORKSPACE_SCOPE,
        }),
      ).toMatchObject({ status: "OK" });
      expect(
        await runtime.memoryContextCompile({
          envelope: readEnvelope(
            "memory_context_compile",
            "continuity_compile",
          ),
          recall: {
            schema_version: "1.0.0",
            request_id: "request_continuity_compile",
            goal: "restore governed memory",
            query: "Core governed memory",
            scopes: [WORKSPACE_SCOPE],
            as_of: NOW,
            token_budget: 1_800,
            include_sensitive: false,
          },
        }),
      ).toMatchObject({ status: "OK" });

      const second = inlineEpisode({
        episodeId: "episode_continuity_2",
        evidenceId: "evidence_continuity_2",
        idempotencyKey: "commit:episode_continuity_2:0001",
      });
      expect(
        await runtime.memoryEpisodeCommit({
          envelope: {
            ...readEnvelope(
              "memory_episode_commit",
              "continuity_commit",
            ),
            safety_class: "proposal",
            idempotency_key: second.idempotencyKey,
          },
          episode: second.episode,
          evidence: second.evidence,
          blobs: [],
        }),
      ).toMatchObject({ status: "OK" });
      const pinRequest = {
        envelope: {
          ...readEnvelope("memory_pin", "continuity_pin"),
          safety_class: "important_mutation",
          idempotency_key: "memory-pin-continuity-001",
          expected_revision_id: admitted.current_revision_id,
          approval_id: "approval_continuity_pin",
          dry_run: false,
        },
        memory_id: admitted.memory_id,
        pinned: true,
      } as const;
      approvals.approve(pinRequest);
      expect(await runtime.memoryPin(pinRequest)).toMatchObject({
        status: "OK",
        data: {
          outcome: "PINNED",
          memory_id: admitted.memory_id,
        },
      });

      expect(
        await runtime.memoryFeedback({
          envelope: {
            ...readEnvelope("memory_feedback", "continuity_feedback"),
            safety_class: "proposal",
            idempotency_key: "memory-feedback-continuity-001",
          },
          feedback: {
            task_id: "task_continuity_1",
            context_slice_id: "context_continuity_1",
            outcome: "partial",
            evidence_ids: ["evidence_continuity_1"],
            error_codes: ["LEARNING_PAUSED_DURING_TASK"],
            gap_codes: [],
            observed_at: NOW,
          },
        }),
      ).toMatchObject({
        status: "OK",
        data: {
          reason_code: "LEARNING_PAUSED",
          candidate_published: false,
          pointer_changed: false,
        },
      });
    } finally {
      await storage.close();
    }
  });
});
