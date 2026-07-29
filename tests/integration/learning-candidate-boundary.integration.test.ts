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
  RetrievalReceiptSchema,
  canonicalSha256,
  canonicalSha256Omitting,
  sealReceipt,
} from "../../packages/contracts/src/index.js";
import {
  LearningCandidateBuilder,
  LearningTraceRecorder,
} from "../../packages/learning-lab/src/index.js";
import { MemoryRuntime } from "../../packages/memory-kernel/src/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import { TestApprovalRegistry } from "../helpers/approval.js";
import {
  HASH_A,
  HASH_B,
  NOW,
  USER_SCOPE,
} from "../helpers/examples.js";
import {
  LEARNING_WORKSPACE_SCOPE,
  learningControl,
  learningControlReceipt,
  verifiedLearningApproval,
} from "../helpers/learning-examples.js";
import {
  memoryCandidate,
  memoryProposal,
} from "../helpers/governance-examples.js";
import { inlineEpisode } from "../helpers/storage-examples.js";

const cleanupPaths: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-graph-${prefix}-`)),
  );
  cleanupPaths.push(root);
  return root;
}

function contextSlice() {
  const input = {
    schema_version: "1.0.0",
    context_slice_id: "context_learning_boundary_1",
    request_id: "request_learning_boundary_1",
    compiler_version: "1.0.0",
    created_at: NOW,
    token_budget: 1_800,
    token_used: 0,
    items: [],
    frozen_hash: HASH_A,
    policy_version: "1.0.0",
  };
  return ContextSliceSchema.parse({
    ...input,
    frozen_hash: canonicalSha256Omitting(input, ["frozen_hash"]),
  });
}

function traceInput(extra: Record<string, unknown> = {}) {
  return {
    schema_version: "1.0.0",
    idempotency_key: "learning-boundary-trace-001",
    trace_id: "trace_learning_boundary_1",
    episode_id: "episode_learning_boundary_1",
    task_spec: {
      task_id: "task_learning_boundary_1",
      goal_hash: HASH_A,
      input_hash: HASH_B,
      success_criteria_hash: HASH_A,
    },
    principal_id: "user_local",
    scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
    context_slice: contextSlice(),
    trajectory: [
      {
        step_id: "step_learning_boundary_1",
        kind: "tool",
        evidence_id: "evidence_learning_boundary_1",
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
        observation_id: "observation_learning_boundary_1",
        kind: "gap",
        polarity: "negative",
        code: "RETRIEVAL_TOO_BROAD",
        evidence_id: "evidence_learning_boundary_1",
      },
    ],
    active_release_set_hash: canonicalSha256([]),
    retrieval_configuration_hash: canonicalSha256(
      candidateInput().current_retrieval_policy,
    ),
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
    ...extra,
  };
}

function candidateInput() {
  return {
    schema_version: "1.0.0",
    idempotency_key: "learning-boundary-candidate-001",
    candidate_id: "candidate_learning_boundary_1",
    principal_id: "user_local",
    scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
    trace_ids: ["trace_learning_boundary_1"],
    evidence_ids: ["evidence_learning_boundary_1"],
    base_release_ids: [],
    active_base_release_id: null,
    current_retrieval_policy: {
      allowed_lanes: ["recent_l1", "topic", "scenario_procedure"],
      limits: {
        max_candidates_per_lane: 100,
        relation_max_depth: 2,
        relation_max_fanout: 20,
        max_concurrent_lanes: 3,
      },
    },
    options: [
      {
        kind: "retrieval_policy",
        target_key: "default_recall",
        requested_lanes: ["recent_l1"],
        limits: { max_candidates_per_lane: 10 },
      },
    ],
    expected_improvement_ids: ["reduce_context_pollution"],
    protected_invariant_ids: ["scope_isolation", "no_resurrection"],
    authority: "inferred",
    sensitivity: "internal",
    impact: "medium",
    confidence: 0.9,
    requires_user_confirmation: false,
    evaluation_contract_hash: HASH_A,
    rollback_target_release_id: null,
    proposed_at: NOW,
    proposed_by: "learning_lab",
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

describe("Learning Lab candidate-only boundary", () => {
  it("persists an inactive narrowing candidate without moving pointer, Context, or canonical rows", async () => {
    const dataRoot = temporaryRoot("learning-candidate-boundary");
    const storage = await SqliteStorageClient.open({ dataRoot });
    try {
      await storage.commitEpisode(
        inlineEpisode({
          episodeId: "episode_learning_boundary_1",
          evidenceId: "evidence_learning_boundary_1",
          idempotencyKey: "episode-learning-boundary-001",
        }),
      );
      const runtime = new MemoryRuntime({
        storage,
        approvalRegistry: new TestApprovalRegistry(),
        clock: () => NOW,
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
      const canonicalMemoryCandidate = memoryCandidate({
        candidateId: "candidate_boundary_canonical_1",
        logicalKey: "workspace.learning.boundary_control",
        scope: LEARNING_WORKSPACE_SCOPE,
        sensitivity: "internal",
        text: "Governed context survives a later session.",
        evidenceIds: ["evidence_learning_boundary_1"],
      });
      const canonicalProposal = await runtime.memoryPropose(
        memoryProposal({
          candidate: canonicalMemoryCandidate,
          idempotencyKey: "memory-propose-boundary-canonical-001",
          requestId: "request_memory_propose_boundary_canonical_001",
        }),
      );
      expect(canonicalProposal.status).toBe("OK");
      if (canonicalProposal.status !== "OK") {
        throw new Error("canonical boundary fixture must activate");
      }
      const canonicalTarget = canonicalProposal.data as {
        memory_id: string;
        current_revision_id: string;
      };
      const proceduralMemoryCandidate = memoryCandidate({
        candidateId: "candidate_boundary_procedure_1",
        logicalKey: "workspace.learning.boundary_procedure",
        kind: "procedural",
        scope: LEARNING_WORKSPACE_SCOPE,
        sensitivity: "internal",
        text: "Run the deterministic boundary verification procedure.",
        evidenceIds: ["evidence_learning_boundary_1"],
      });
      const proceduralProposal = await runtime.memoryPropose(
        memoryProposal({
          candidate: proceduralMemoryCandidate,
          idempotencyKey: "memory-propose-boundary-procedure-001",
          requestId: "request_memory_propose_boundary_procedure_001",
        }),
      );
      expect(proceduralProposal.status).toBe("OK");
      if (proceduralProposal.status !== "OK") {
        throw new Error("procedural boundary fixture must activate");
      }
      const proceduralTarget = proceduralProposal.data as {
        memory_id: string;
        current_revision_id: string;
      };
      const slice = contextSlice();
      const request = {
        schema_version: "1.0.0" as const,
        request_id: slice.request_id,
        goal: "Preserve frozen Context while proposing.",
        query: "candidate-only boundary",
        scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
        as_of: NOW,
        token_budget: 1_800,
        include_sensitive: false,
      };
      const requestHash = canonicalSha256(request);
      await storage.recordRecall({
        principal_id: "user_local",
        request,
        receipt: RetrievalReceiptSchema.parse(
          sealReceipt({
            schema_version: "1.0.0",
            receipt_id: "receipt_learning_boundary_recall_1",
            created_at: NOW,
            state: "durable",
            request_hash: requestHash,
            kind: "retrieval",
            context_slice_id: slice.context_slice_id,
            compiler_version: slice.compiler_version,
            policy_version: "1.0.0",
            items: [],
          }),
        ),
        context_slice: slice,
      });
      const databasePath = join(dataRoot, "ledger", "memory.db");
      const beforeDatabase = new DatabaseSync(databasePath);
      const contextBefore = beforeDatabase
        .prepare(
          "SELECT slice_json FROM context_slices WHERE context_slice_id = ?",
        )
        .get(slice.context_slice_id);
      const canonicalBefore = beforeDatabase
        .prepare(
          `SELECT * FROM memory_objects ORDER BY memory_id`,
        )
        .all();
      const revisionsBefore = beforeDatabase
        .prepare(
          `SELECT * FROM memory_revisions ORDER BY revision_id`,
        )
        .all();
      beforeDatabase.close();

      const recorder = new LearningTraceRecorder({ storage });
      const trace = await recorder.record(traceInput());
      expect(trace.status).toBe("recorded");
      const builder = new LearningCandidateBuilder({ storage });
      const proposal = await builder.propose(candidateInput());
      expect(proposal).toMatchObject({
        status: "proposed",
        replayed: false,
        candidate: {
          candidate_type: "retrieval_policy",
          release_capability: "release_capable",
        },
      });
      expect(await builder.propose(candidateInput())).toMatchObject({
        status: "proposed",
        replayed: true,
        candidate: {
          candidate_id: "candidate_learning_boundary_1",
        },
      });
      await expect(
        builder.propose({
          ...candidateInput(),
          base_release_ids: undefined,
        }),
      ).rejects.toBeDefined();
      expect(
        await builder.propose({
          ...candidateInput(),
          idempotency_key: "learning-boundary-memory-candidate-001",
          candidate_id: "candidate_learning_boundary_memory_1",
          options: [
            candidateInput().options[0],
            {
              kind: "memory",
              memory_id: canonicalTarget.memory_id,
              revision_id: canonicalTarget.current_revision_id,
              content_hash: canonicalMemoryCandidate.content_hash,
            },
          ],
        }),
      ).toMatchObject({
        status: "proposed",
        candidate: { candidate_type: "memory" },
      });
      expect(
        await builder.propose({
          ...candidateInput(),
          idempotency_key: "learning-boundary-procedure-candidate-001",
          candidate_id: "candidate_learning_boundary_procedure_1",
          options: [
            candidateInput().options[0],
            {
              kind: "procedure",
              memory_id: proceduralTarget.memory_id,
              revision_id: proceduralTarget.current_revision_id,
              content_hash: proceduralMemoryCandidate.content_hash,
            },
          ],
        }),
      ).toMatchObject({
        status: "proposed",
        candidate: { candidate_type: "procedure" },
      });
      expect(
        await builder.propose({
          ...candidateInput(),
          idempotency_key: "learning-boundary-rollback-mismatch-001",
          candidate_id: "candidate_learning_rollback_mismatch_1",
          rollback_target_release_id: "release_missing_1",
        }),
      ).toMatchObject({
        status: "stopped",
        reason_code: "ROLLBACK_TARGET_MISMATCH",
      });

      const ledger = await storage.readLearningLedger({
        principal_id: "user_local",
        scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
        candidate_id: "candidate_learning_boundary_1",
      });
      expect(ledger.candidate_states).toEqual([
        {
          candidate_id: "candidate_learning_boundary_1",
          state: "proposed",
          sequence: 0,
          transition_hash: null,
        },
      ]);
      expect(ledger.pointers).toEqual([]);

      const afterDatabase = new DatabaseSync(databasePath);
      expect(
        afterDatabase
          .prepare(
            "SELECT slice_json FROM context_slices WHERE context_slice_id = ?",
          )
          .get(slice.context_slice_id),
      ).toEqual(contextBefore);
      expect(
        afterDatabase
          .prepare("SELECT * FROM memory_objects ORDER BY memory_id")
          .all(),
      ).toEqual(canonicalBefore);
      expect(
        afterDatabase
          .prepare("SELECT * FROM memory_revisions ORDER BY revision_id")
          .all(),
      ).toEqual(revisionsBefore);
      afterDatabase.close();
    } finally {
      await storage.close();
    }
  });

  it("stops incomplete and paused work before trace or candidate publication", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("learning-candidate-stop"),
    });
    try {
      const recorder = new LearningTraceRecorder({ storage });
      expect(
        await recorder.record(
          traceInput({
            idempotency_key: "learning-incomplete-trace-001",
            trace_id: "trace_learning_incomplete_1",
            task_spec: null,
            context_slice: null,
          }),
        ),
      ).toMatchObject({
        status: "stopped",
        reason_code: "INCOMPLETE_PROVENANCE",
      });

      const authority = verifiedLearningApproval({
        tool: "learning_pause",
        requestHash: learningControlReceipt().request_hash,
      });
      await storage.writeLearningLedger({
        kind: "control",
        idempotency_key: "learning-boundary-pause-001",
        request_hash: learningControlReceipt().request_hash,
        expected_control_epoch: 0,
        expected_frontier_hash:
          learningControlReceipt().previous_frontier_hash,
        control: learningControl(),
        receipt: learningControlReceipt(),
        approval_binding: authority.binding,
        approval: authority.approval,
      });
      expect(
        await recorder.record(
          traceInput({
            idempotency_key: "learning-paused-trace-001",
            trace_id: "trace_learning_paused_1",
            control_epoch: 1,
          }),
        ),
      ).toMatchObject({
        status: "stopped",
        reason_code: "LEARNING_PAUSED",
      });
      const ledger = await storage.readLearningLedger({
        principal_id: "user_local",
        scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
      });
      expect(ledger.traces).toEqual([]);
      expect(ledger.candidates).toEqual([]);
    } finally {
      await storage.close();
    }
  });
});
