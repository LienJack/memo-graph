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
  ContextSliceSchema,
  canonicalSha256,
  canonicalSha256Omitting,
} from "../../packages/contracts/src/index.js";
import { LearningTraceRecorder } from "../../packages/learning-lab/src/index.js";
import { MemoryRuntime } from "../../packages/memory-kernel/src/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import { TestApprovalRegistry } from "../helpers/approval.js";
import {
  HASH_A,
  HASH_B,
  NOW,
  USER_SCOPE,
} from "../helpers/examples.js";
import { LEARNING_WORKSPACE_SCOPE } from "../helpers/learning-examples.js";
import {
  memoryCandidate,
  memoryProposal,
} from "../helpers/governance-examples.js";
import {
  PURGE_NOW,
  deleteRequest,
} from "../helpers/purge-examples.js";
import { inlineEpisode } from "../helpers/storage-examples.js";

const MARKER = "secret-learning-trace-marker-741923";
const cleanupPaths: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-graph-${prefix}-`)),
  );
  cleanupPaths.push(root);
  return root;
}

function inputFor(evidenceId: string, extra: Record<string, unknown> = {}) {
  const contextInput = {
    schema_version: "1.0.0",
    context_slice_id: `context_${evidenceId}`,
    request_id: `request_${evidenceId}`,
    compiler_version: "1.0.0",
    created_at: NOW,
    token_budget: 1_800,
    token_used: 0,
    items: [],
    frozen_hash: HASH_A,
  };
  return {
    schema_version: "1.0.0",
    idempotency_key: `trace-${evidenceId}-001`,
    trace_id: `trace_${evidenceId}`,
    episode_id: `episode_${evidenceId}`,
    task_spec: {
      task_id: `task_${evidenceId}`,
      goal_hash: HASH_A,
      input_hash: HASH_B,
      success_criteria_hash: HASH_A,
    },
    principal_id: "user_local",
    scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
    context_slice: ContextSliceSchema.parse({
      ...contextInput,
      frozen_hash: canonicalSha256Omitting(contextInput, ["frozen_hash"]),
    }),
    trajectory: [
      {
        step_id: `step_${evidenceId}`,
        kind: "evidence",
        evidence_id: evidenceId,
        evidence_scope: LEARNING_WORKSPACE_SCOPE,
      },
    ],
    outcome: {
      status: "failed",
      required_task_units_completed: [],
      output_hash: null,
    },
    observations: [
      {
        observation_id: `observation_${evidenceId}`,
        kind: "gap",
        polarity: "negative",
        code: "PRIVATE_EVIDENCE_GAP",
        evidence_id: evidenceId,
      },
    ],
    active_release_set_hash: canonicalSha256([]),
    retrieval_configuration_hash: HASH_B,
    runtime: {
      runtime_version: "1.0.0",
      compiler_version: "1.0.0",
      model_provider: "local_fixture",
      model_id: "deterministic_model",
      toolset_hash: HASH_A,
      dependency_lock_hash: HASH_B,
    },
    costs: {
      input_tokens: 1,
      output_tokens: 1,
      latency_ms: 1,
      side_effect_ids: [],
    },
    control_epoch: 0,
    captured_at: NOW,
    ...extra,
  };
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target !== undefined) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

describe("Learning Lab trace privacy", () => {
  it("redacts sensitive references and never copies raw marker content into learning rows or errors", async () => {
    const dataRoot = temporaryRoot("learning-trace-sensitive");
    const storage = await SqliteStorageClient.open({ dataRoot });
    try {
      const episode = inlineEpisode({
        episodeId: "episode_evidence_sensitive_learning_1",
        evidenceId: "evidence_sensitive_learning_1",
        idempotencyKey: "episode-sensitive-learning-001",
        text: MARKER,
      });
      await storage.commitEpisode({
        ...episode,
        evidence: episode.evidence.map((evidence) => ({
          ...evidence,
          sensitivity: "sensitive" as const,
        })),
      });
      const recorder = new LearningTraceRecorder({ storage });
      const recorded = await recorder.record(
        inputFor("evidence_sensitive_learning_1"),
      );
      expect(recorded.status).toBe("recorded");
      if (recorded.status === "recorded") {
        expect(recorded.trace.trajectory[0]?.retention).toMatchObject({
          mode: "redacted",
          reason_code: "SENSITIVE_REFERENCE_REDACTED",
        });
        expect(JSON.stringify(recorded.trace)).not.toContain(MARKER);
      }

      let errorText = "";
      try {
        await recorder.record(
          inputFor("evidence_sensitive_learning_1", {
            idempotency_key: "trace-sensitive-extra-001",
            trace_id: "trace_sensitive_extra_1",
            raw_content: MARKER,
          }),
        );
      } catch (error) {
        errorText = String(error);
      }
      expect(errorText).not.toContain(MARKER);
    } finally {
      await storage.close();
    }

    const database = new DatabaseSync(join(dataRoot, "ledger", "memory.db"));
    const learningRows = database
      .prepare("SELECT artifact_json FROM learning_traces")
      .all() as Array<{ artifact_json: string }>;
    database.close();
    expect(JSON.stringify(learningRows)).not.toContain(MARKER);
  });

  it("writes a typed stop and no trace for foreign or missing evidence", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("learning-trace-inaccessible"),
    });
    try {
      await storage.commitEpisode(
        inlineEpisode({
          episodeId: "episode_foreign_learning_1",
          evidenceId: "evidence_foreign_learning_1",
          idempotencyKey: "episode-foreign-learning-001",
          principalId: "other_user",
          scopeId: "other_workspace",
        }),
      );
      await storage.commitEpisode(
        inlineEpisode({
          episodeId: "episode_evidence_purged_learning_1",
          evidenceId: "evidence_purged_learning_1",
          idempotencyKey: "episode-purged-learning-001",
          text: "Evidence that will be physically purged.",
        }),
      );
      const approvals = new TestApprovalRegistry();
      const runtime = new MemoryRuntime({
        storage,
        approvalRegistry: approvals,
        clock: () => PURGE_NOW,
        policy: {
          principal: {
            principal_id: "user_local",
            allowed_scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
            allowed_authorities: ["user_stated"],
            destructive_tools_enabled: true,
          },
          default_token_budget: 1_800,
        },
      });
      const canonicalCandidate = memoryCandidate({
        candidateId: "candidate_purged_learning_trace_1",
        logicalKey: "workspace.learning.trace_purge",
        scope: LEARNING_WORKSPACE_SCOPE,
        sensitivity: "internal",
        text: "Evidence that will be physically purged.",
        evidenceIds: ["evidence_purged_learning_1"],
      });
      const proposed = await runtime.memoryPropose(
        memoryProposal({
          candidate: canonicalCandidate,
          idempotencyKey: "memory-propose-purged-learning-trace-001",
          requestId: "request_memory_propose_purged_learning_trace_001",
        }),
      );
      expect(proposed.status).toBe("OK");
      if (proposed.status !== "OK") {
        throw new Error("purged evidence fixture must first activate");
      }
      const admitted = proposed.data as {
        memory_id: string;
        current_revision_id: string;
      };
      const deletion = deleteRequest({
        memoryId: admitted.memory_id,
        revisionId: admitted.current_revision_id,
        idempotencyKey: "memory-delete-purged-learning-trace-001",
        approvalId: "approval_delete_purged_learning_trace_1",
      });
      approvals.approve(deletion);
      const deleted = await runtime.memoryDelete(deletion);
      expect(deleted.status).toBe("OK");
      if (deleted.status !== "OK") {
        throw new Error("purged evidence fixture must tombstone");
      }
      await storage.runPurge({
        purge_job_id: (deleted.data as { purge_job_id: string }).purge_job_id,
      });
      const recorder = new LearningTraceRecorder({ storage });
      for (const [evidenceId, idempotencyKey] of [
        ["evidence_foreign_learning_1", "trace-foreign-learning-001"],
        ["evidence_missing_learning_1", "trace-missing-learning-001"],
        ["evidence_purged_learning_1", "trace-purged-learning-001"],
      ] as const) {
        const result = await recorder.record(
          inputFor(evidenceId, {
            idempotency_key: idempotencyKey,
            trace_id: `trace_${evidenceId}_attempt`,
          }),
        );
        expect(result).toMatchObject({
          status: "stopped",
          reason_code: "EVIDENCE_INACCESSIBLE",
          receipt: { kind: "learning_stop" },
        });
      }
      const ledger = await storage.readLearningLedger({
        principal_id: "user_local",
        scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
      });
      expect(ledger.traces).toEqual([]);
      expect(ledger.candidates).toEqual([]);
      expect(ledger.receipts.map((receipt) => receipt.kind)).toEqual([
        "learning_stop",
        "learning_stop",
        "learning_stop",
      ]);
    } finally {
      await storage.close();
    }
  });
});
