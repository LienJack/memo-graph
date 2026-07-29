import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ContextSliceSchema,
  canonicalSha256,
  canonicalSha256Omitting,
} from "../../packages/contracts/src/index.js";
import {
  LearningCandidateBuilder,
  LearningTraceRecorder,
  selectSmallestCandidateOption,
  type LearningLabStorage,
} from "../../packages/learning-lab/src/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import {
  HASH_A,
  HASH_B,
  NOW,
  USER_SCOPE,
} from "../helpers/examples.js";
import { LEARNING_WORKSPACE_SCOPE } from "../helpers/learning-examples.js";
import { inlineEpisode } from "../helpers/storage-examples.js";

const cleanupPaths: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-graph-${prefix}-`)),
  );
  cleanupPaths.push(root);
  return root;
}

function replayOnlyStorage(
  storage: SqliteStorageClient,
): LearningLabStorage {
  const rejectMutableRead = async (): Promise<never> => {
    throw new Error("mutable learning state must not be read before replay");
  };
  return {
    replayLearningLedger:
      storage.replayLearningLedger.bind(storage),
    readLearningLedger: storage.readLearningLedger.bind(storage),
    getEvidence: rejectMutableRead,
    getGovernedMemory: rejectMutableRead,
    writeLearningLedger: rejectMutableRead,
  };
}

function contextSlice(id = "context_learning_runtime_1") {
  const input = {
    schema_version: "1.0.0",
    context_slice_id: id,
    request_id: `request_${id}`,
    compiler_version: "1.0.0",
    created_at: NOW,
    token_budget: 1_800,
    token_used: 0,
    items: [],
    frozen_hash: HASH_A,
  };
  return ContextSliceSchema.parse({
    ...input,
    frozen_hash: canonicalSha256Omitting(input, ["frozen_hash"]),
  });
}

function traceInput(
  overrides: Record<string, unknown> = {},
) {
  return {
    schema_version: "1.0.0",
    idempotency_key: "learning-trace-runtime-001",
    trace_id: "trace_learning_runtime_1",
    episode_id: "episode_learning_runtime_1",
    task_spec: {
      task_id: "task_learning_runtime_1",
      goal_hash: HASH_A,
      input_hash: HASH_B,
      success_criteria_hash: HASH_A,
    },
    principal_id: "user_local",
    scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
    context_slice: contextSlice(),
    trajectory: [
      {
        step_id: "step_learning_runtime_1",
        kind: "tool",
        evidence_id: "evidence_learning_runtime_1",
        evidence_scope: LEARNING_WORKSPACE_SCOPE,
      },
    ],
    outcome: {
      status: "failed",
      required_task_units_completed: [],
      output_hash: HASH_B,
    },
    observations: [
      {
        observation_id: "observation_positive_1",
        kind: "feedback",
        polarity: "positive",
        code: "PARTIAL_PROGRESS",
        evidence_id: "evidence_learning_runtime_1",
      },
      {
        observation_id: "observation_negative_1",
        kind: "error",
        polarity: "negative",
        code: "TOOL_RESULT_INCOMPLETE",
        evidence_id: "evidence_learning_runtime_1",
      },
      {
        observation_id: "observation_conflicting_1",
        kind: "gap",
        polarity: "conflicting",
        code: "USER_EXPECTATION_CONFLICT",
        evidence_id: "evidence_learning_runtime_1",
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
      input_tokens: 10,
      output_tokens: 5,
      latency_ms: 2,
      side_effect_ids: [],
    },
    control_epoch: 0,
    captured_at: NOW,
    ...overrides,
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

describe("Learning Lab trace recorder and candidate ordering", () => {
  it("records one replayable sealed trace and preserves distinct observations", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("learning-trace-runtime"),
    });
    try {
      await storage.commitEpisode(
        inlineEpisode({
          episodeId: "episode_learning_runtime_1",
          evidenceId: "evidence_learning_runtime_1",
          idempotencyKey: "episode-learning-runtime-001",
        }),
      );
      const recorder = new LearningTraceRecorder({ storage });
      const first = await recorder.record(traceInput());
      expect(first.status).toBe("recorded");
      if (first.status !== "recorded") {
        throw new Error("complete trace fixture must record");
      }
      expect(first.trace.observations.map((item) => item.polarity)).toEqual([
        "positive",
        "negative",
        "conflicting",
      ]);
      expect(first.trace.trajectory[0]?.retention).toMatchObject({
        mode: "reference",
        evidence_id: "evidence_learning_runtime_1",
      });
      expect(first.replayed).toBe(false);

      const replay = await new LearningTraceRecorder({
        storage: replayOnlyStorage(storage),
      }).record(traceInput());
      expect(replay).toMatchObject({
        status: "recorded",
        replayed: true,
        trace: { trace_hash: first.trace.trace_hash },
      });
      await expect(
        recorder.record(
          traceInput({
            observations: [
              {
                observation_id: "observation_changed",
                kind: "error",
                polarity: "negative",
                code: "CHANGED_UNDER_SAME_KEY",
                evidence_id: "evidence_learning_runtime_1",
              },
            ],
          }),
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    } finally {
      await storage.close();
    }
  });

  it("seals trajectory order and uses the deterministic smallest-change order", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("learning-trace-order"),
    });
    try {
      await storage.commitEpisode(
        inlineEpisode({
          episodeId: "episode_learning_runtime_1",
          evidenceId: "evidence_learning_runtime_1",
          idempotencyKey: "episode-learning-order-001",
        }),
      );
      await storage.commitEpisode(
        inlineEpisode({
          episodeId: "episode_learning_runtime_2",
          evidenceId: "evidence_learning_runtime_2",
          idempotencyKey: "episode-learning-order-002",
        }),
      );
      const steps = [
        {
          step_id: "step_learning_runtime_1",
          kind: "tool",
          evidence_id: "evidence_learning_runtime_1",
          evidence_scope: LEARNING_WORKSPACE_SCOPE,
        },
        {
          step_id: "step_learning_runtime_2",
          kind: "evidence",
          evidence_id: "evidence_learning_runtime_2",
          evidence_scope: LEARNING_WORKSPACE_SCOPE,
        },
      ];
      const recorder = new LearningTraceRecorder({ storage });
      const ordered = await recorder.record(
        traceInput({
          idempotency_key: "learning-trace-order-001",
          trace_id: "trace_learning_order_1",
          trajectory: steps,
        }),
      );
      const reversed = await recorder.record(
        traceInput({
          idempotency_key: "learning-trace-order-002",
          trace_id: "trace_learning_order_2",
          context_slice: contextSlice("context_learning_order_2"),
          trajectory: [...steps].reverse(),
        }),
      );
      expect(ordered.status).toBe("recorded");
      expect(reversed.status).toBe("recorded");
      if (ordered.status === "recorded" && reversed.status === "recorded") {
        expect(reversed.trace.trace_hash).not.toBe(ordered.trace.trace_hash);
      }

      expect(
        selectSmallestCandidateOption([
          {
            kind: "prompt",
            artifact_ref: "prompt_candidate_1",
            artifact_hash: HASH_A,
          },
          {
            kind: "retrieval_policy",
            target_key: "default_recall",
            requested_lanes: ["recent_l1"],
            limits: { max_candidates_per_lane: 10 },
          },
          {
            kind: "procedure",
            memory_id: "memory_procedure_1",
            revision_id: "revision_procedure_1",
            content_hash: HASH_A,
          },
          {
            kind: "memory",
            memory_id: "memory_fact_1",
            revision_id: "revision_fact_1",
            content_hash: HASH_B,
          },
        ]).kind,
      ).toBe("memory");
      expect(
        selectSmallestCandidateOption([
          {
            kind: "retrieval_policy",
            target_key: "default_recall",
            requested_lanes: ["recent_l1"],
            limits: { max_candidates_per_lane: 10 },
          },
          {
            kind: "procedure",
            memory_id: "memory_procedure_1",
            revision_id: "revision_procedure_1",
            content_hash: HASH_A,
          },
        ]).kind,
      ).toBe("procedure");
      expect(
        selectSmallestCandidateOption([
          {
            kind: "prompt",
            artifact_ref: "prompt_candidate_1",
            artifact_hash: HASH_A,
          },
          {
            kind: "retrieval_policy",
            target_key: "default_recall",
            requested_lanes: ["recent_l1"],
            limits: { max_candidates_per_lane: 10 },
          },
        ]).kind,
      ).toBe("retrieval_policy");
      expect(
        selectSmallestCandidateOption([
          {
            kind: "scenario_pattern",
            artifact_ref: "scenario_candidate_1",
            artifact_hash: HASH_A,
          },
          {
            kind: "core_projection",
            artifact_ref: "core_candidate_1",
            artifact_hash: HASH_B,
          },
        ]).kind,
      ).toBe("core_projection");
      expect(
        selectSmallestCandidateOption([
          { kind: "model" },
          { kind: "code" },
          { kind: "skill" },
        ]).kind,
      ).toBe("skill");

      const currentPolicy = {
        allowed_lanes: ["recent_l1", "topic", "scenario_procedure"],
        limits: {
          max_candidates_per_lane: 100,
          relation_max_depth: 2,
          relation_max_fanout: 20,
          max_concurrent_lanes: 3,
        },
      } as const;
      const candidateTrace = await recorder.record(
        traceInput({
          idempotency_key: "learning-trace-candidate-type-001",
          trace_id: "trace_learning_candidate_type_1",
          context_slice: contextSlice("context_learning_candidate_type_1"),
          trajectory: steps,
          retrieval_configuration_hash: canonicalSha256(currentPolicy),
        }),
      );
      expect(candidateTrace.status).toBe("recorded");
      const builder = new LearningCandidateBuilder({ storage });
      const commonProposal = {
        schema_version: "1.0.0",
        principal_id: "user_local",
        scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
        trace_ids: ["trace_learning_candidate_type_1"],
        evidence_ids: [
          "evidence_learning_runtime_1",
          "evidence_learning_runtime_2",
        ],
        base_release_ids: [],
        active_base_release_id: null,
        current_retrieval_policy: currentPolicy,
        expected_improvement_ids: ["reduce_context_pollution"],
        protected_invariant_ids: ["scope_isolation", "no_resurrection"],
        authority: "inferred",
        sensitivity: "internal",
        impact: "medium",
        confidence: 0.9,
        evaluation_contract_hash: HASH_A,
        rollback_target_release_id: null,
        proposed_at: NOW,
        proposed_by: "learning_lab",
        control_epoch: 0,
      };
      const evaluationOnly = await builder.propose({
        ...commonProposal,
        idempotency_key: "learning-evaluation-only-candidate-001",
        candidate_id: "candidate_evaluation_only_1",
        requires_user_confirmation: true,
        options: [
          {
            kind: "prompt",
            artifact_ref: "prompt_candidate_1",
            artifact_hash: HASH_A,
          },
        ],
      });
      expect(evaluationOnly).toMatchObject({
        status: "proposed",
        candidate: {
          candidate_type: "prompt",
          release_capability: "evaluation_only",
          release_slot: null,
        },
      });
      expect(
        await new LearningCandidateBuilder({
          storage: replayOnlyStorage(storage),
        }).propose({
          ...commonProposal,
          idempotency_key: "learning-evaluation-only-candidate-001",
          candidate_id: "candidate_evaluation_only_1",
          requires_user_confirmation: true,
          options: [
            {
              kind: "prompt",
              artifact_ref: "prompt_candidate_1",
              artifact_hash: HASH_A,
            },
          ],
        }),
      ).toMatchObject({
        status: "proposed",
        replayed: true,
        candidate: { candidate_id: "candidate_evaluation_only_1" },
      });
      const unsupported = await builder.propose({
        ...commonProposal,
        idempotency_key: "learning-unsupported-candidate-001",
        candidate_id: "candidate_unsupported_1",
        requires_user_confirmation: false,
        options: [{ kind: "skill" }],
      });
      expect(unsupported).toMatchObject({
        status: "stopped",
        reason_code: "UNSUPPORTED_CANDIDATE_TYPE",
      });
    } finally {
      await storage.close();
    }
  });
});
