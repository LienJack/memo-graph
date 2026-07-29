import { describe, expect, it } from "vitest";

import {
  CandidateChangeSchema,
  CandidateStateSchema,
  CandidateTransitionSchema,
  CanaryAuthorizationSchema,
  EvaluationArmSchema,
  EvaluationCaseResultSetSchema,
  LearningTraceSchema,
  LearningReleaseVersionSchema,
  PostCanaryApprovalSchema,
  ReleasePointerSchema,
  ReleaseSlotSchema,
  canonicalSha256,
  canonicalSha256Omitting,
} from "../../packages/contracts/src/index.js";
import { HASH_A, HASH_B, LATER, NOW, USER_SCOPE } from "../helpers/examples.js";

const WORKSPACE_SCOPE = {
  kind: "workspace",
  id: "workspace_local",
} as const;

function validTrace() {
  const trace = {
    schema_version: "1.0.0",
    trace_id: "trace_1",
    episode_id: "episode_1",
    task_spec: {
      task_id: "task_1",
      goal_hash: HASH_A,
      input_hash: HASH_B,
      success_criteria_hash: HASH_A,
    },
    principal_id: "user_local",
    scopes: [USER_SCOPE, WORKSPACE_SCOPE],
    context: {
      context_slice_id: "context_1",
      frozen_hash: HASH_A,
      frontier_hash: HASH_B,
      compiler_version: "1.0.0",
    },
    trajectory: [
      {
        step_id: "step_1",
        ordinal: 0,
        kind: "tool",
        retention: {
          mode: "reference",
          evidence_id: "evidence_tool_1",
          content_hash: HASH_A,
          media_type: "application/json",
        },
        step_hash: HASH_B,
      },
      {
        step_id: "step_2",
        ordinal: 1,
        kind: "model",
        retention: {
          mode: "redacted",
          content_hash: HASH_B,
          media_type: "text/plain",
          reason_code: "SENSITIVE_NOT_RETAINED",
        },
        step_hash: HASH_A,
      },
    ],
    outcome: {
      status: "failed",
      required_task_units_completed: ["task_unit_observed"],
      output_hash: HASH_B,
    },
    observations: [
      {
        observation_id: "observation_feedback_1",
        kind: "feedback",
        polarity: "negative",
        code: "USER_REJECTED_RESULT",
        evidence_id: "evidence_feedback_1",
      },
      {
        observation_id: "observation_gap_1",
        kind: "gap",
        polarity: "conflicting",
        code: "RETRIEVAL_NOISE",
        evidence_id: null,
      },
    ],
    active_release_set_hash: HASH_A,
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
      input_tokens: 120,
      output_tokens: 30,
      latency_ms: 12,
      side_effect_ids: [],
    },
    control_epoch: 0,
    captured_at: NOW,
    trace_hash: HASH_A,
  };
  return {
    ...trace,
    trace_hash: canonicalSha256Omitting(trace, ["trace_hash"]),
  };
}

function validReleaseSlot() {
  const slot = {
    principal_id: "user_local",
    candidate_type: "retrieval_policy",
    scopes: [USER_SCOPE, WORKSPACE_SCOPE],
    target_key: "default_recall",
    slot_hash: HASH_A,
  };
  return {
    ...slot,
    slot_hash: canonicalSha256Omitting(slot, ["slot_hash"]),
  };
}

function validCandidate() {
  const slot = validReleaseSlot();
  const candidate = {
    schema_version: "1.0.0",
    candidate_id: "candidate_1",
    candidate_type: "retrieval_policy",
    release_capability: "release_capable",
    principal_id: "user_local",
    scopes: slot.scopes,
    release_slot: slot,
    target: {
      kind: "retrieval_policy",
      requested_lanes: ["recent_l1"],
      limits: {
        max_candidates_per_lane: 10,
      },
    },
    base_release_ids: [],
    active_base_release_id: null,
    trace_ids: ["trace_1"],
    evidence_ids: ["evidence_feedback_1"],
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
    reason: "Narrow the noisy retrieval lane for this exact scope set.",
    candidate_hash: HASH_A,
  };
  return {
    ...candidate,
    candidate_hash: canonicalSha256Omitting(candidate, ["candidate_hash"]),
  };
}

function validCaseResult(arm: "no_candidate" | "current" | "candidate") {
  const result = {
    schema_version: "1.0.0",
    eval_result_id: `eval_${arm}`,
    run_id: "run_1",
    case_id: "case_1",
    partition: "holdout",
    arm,
    common_identity_hash: HASH_A,
    passed_required_task_units: ["unit_1"],
    failed_required_task_units: [],
    error_codes: [],
    negative_transfer_units: [],
    context: {
      token_budget: 1_800,
      token_used: 120,
      pollution_count: 0,
      selected_item_ids: ["memory_1"],
    },
    latency_ms: 10,
    side_effect_ids: [],
    violation_codes: [],
    critical_failure_codes: [],
    evaluated_at: NOW,
    result_hash: HASH_A,
  };
  return {
    ...result,
    result_hash: canonicalSha256Omitting(result, ["result_hash"]),
  };
}

describe("governed learning contracts", () => {
  it("accepts a complete sealed privacy-minimal trace", () => {
    expect(LearningTraceSchema.parse(validTrace()).trace_id).toBe("trace_1");
  });

  it.each([
    "task_spec",
    "context",
    "trajectory",
    "observations",
    "active_release_set_hash",
    "retrieval_configuration_hash",
    "runtime",
    "costs",
  ])("rejects a trace missing %s", (field) => {
    const trace = { ...validTrace() } as Record<string, unknown>;
    delete trace[field];
    expect(LearningTraceSchema.safeParse(trace).success).toBe(false);
  });

  it("rejects raw payloads and invalid trajectory ordering", () => {
    const trace = validTrace();
    expect(
      LearningTraceSchema.safeParse({
        ...trace,
        trajectory: [
          {
            ...trace.trajectory[0],
            raw_content: "secret marker",
          },
          trace.trajectory[1],
        ],
      }).success,
    ).toBe(false);
    expect(
      LearningTraceSchema.safeParse({
        ...trace,
        trajectory: [
          trace.trajectory[1],
          trace.trajectory[0],
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate scopes, steps, and evidence observations", () => {
    const trace = validTrace();
    expect(
      LearningTraceSchema.safeParse({
        ...trace,
        scopes: [USER_SCOPE, USER_SCOPE],
      }).success,
    ).toBe(false);
    expect(
      LearningTraceSchema.safeParse({
        ...trace,
        trajectory: [trace.trajectory[0], trace.trajectory[0]],
      }).success,
    ).toBe(false);
    expect(
      LearningTraceSchema.safeParse({
        ...trace,
        observations: [trace.observations[0], trace.observations[0]],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate evidence references even when the trace is resealed", () => {
    const trace = validTrace();
    const duplicateEvidenceTrace = {
      ...trace,
      trajectory: [
        trace.trajectory[0],
        {
          ...trace.trajectory[0],
          step_id: "step_2",
          ordinal: 1,
          step_hash: HASH_A,
        },
      ],
    };
    expect(
      LearningTraceSchema.safeParse({
        ...duplicateEvidenceTrace,
        trace_hash: canonicalSha256Omitting(duplicateEvidenceTrace, [
          "trace_hash",
        ]),
      }).success,
    ).toBe(false);
  });

  it("rejects a trace whose canonical seal no longer matches", () => {
    expect(
      LearningTraceSchema.safeParse({
        ...validTrace(),
        control_epoch: 1,
      }).success,
    ).toBe(false);
  });

  it("freezes exact arm and state vocabularies", () => {
    expect(EvaluationArmSchema.options).toEqual([
      "no_candidate",
      "current",
      "candidate",
    ]);
    expect(EvaluationArmSchema.safeParse("transcript_baseline").success).toBe(
      false,
    );
    expect(EvaluationArmSchema.safeParse("fts_baseline").success).toBe(false);
    expect(CandidateStateSchema.safeParse("approved").success).toBe(false);
    expect(CandidateStateSchema.options).toEqual([
      "proposed",
      "quarantined",
      "evaluating",
      "approved_for_canary",
      "canary",
      "rejected",
      "released",
      "rolled_back",
    ]);
  });

  it("accepts only an immutable release-capable bounded candidate", () => {
    expect(CandidateChangeSchema.parse(validCandidate()).candidate_type).toBe(
      "retrieval_policy",
    );
    expect(
      CandidateChangeSchema.safeParse({
        ...validCandidate(),
        status: "released",
      }).success,
    ).toBe(false);
    expect(
      CandidateChangeSchema.safeParse({
        ...validCandidate(),
        target: {
          kind: "retrieval_policy",
          requested_lanes: ["semantic_vector"],
          limits: {},
        },
      }).success,
    ).toBe(false);
    expect(
      CandidateChangeSchema.safeParse({
        ...validCandidate(),
        candidate_type: "code",
      }).success,
    ).toBe(false);
  });

  it("requires exact canonical release-slot identity", () => {
    const slot = validReleaseSlot();
    expect(ReleaseSlotSchema.parse(slot).slot_hash).toBe(
      canonicalSha256Omitting(slot, ["slot_hash"]),
    );
    expect(
      ReleaseSlotSchema.safeParse({
        ...slot,
        scopes: [...slot.scopes].reverse(),
      }).success,
    ).toBe(false);
  });

  it("requires all three comparable arms under one common identity", () => {
    const set = {
      run_id: "run_1",
      case_id: "case_1",
      partition: "holdout",
      common_identity_hash: HASH_A,
      results: [
        validCaseResult("no_candidate"),
        validCaseResult("current"),
        validCaseResult("candidate"),
      ],
      result_set_hash: HASH_A,
    };
    const sealed = {
      ...set,
      result_set_hash: canonicalSha256Omitting(set, ["result_set_hash"]),
    };
    expect(EvaluationCaseResultSetSchema.parse(sealed).results).toHaveLength(3);
    expect(
      EvaluationCaseResultSetSchema.safeParse({
        ...sealed,
        results: sealed.results.slice(1),
      }).success,
    ).toBe(false);
    expect(
      EvaluationCaseResultSetSchema.safeParse({
        ...sealed,
        results: [
          sealed.results[0],
          sealed.results[1],
          {
            ...sealed.results[2],
            common_identity_hash: HASH_B,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("separates pre-canary authorization from post-canary approval", () => {
    const authorization = {
      schema_version: "1.0.0",
      authorization_id: "canary_authorization_1",
      principal_id: "user_local",
      tool: "learning_canary",
      safety_class: "important_mutation",
      scopes: [USER_SCOPE, WORKSPACE_SCOPE],
      candidate_id: "candidate_1",
      release_slot_hash: validReleaseSlot().slot_hash,
      base_release_id: null,
      evaluation_receipt_id: "receipt_eval_1",
      evaluation_receipt_hash: HASH_A,
      canary_manifest_id: "canary_manifest_1",
      canary_manifest_hash: HASH_B,
      case_hashes: [HASH_A, HASH_B, canonicalSha256("canary_case_3")],
      maximum_exposures: 3,
      deadline_at: LATER,
      control_epoch: 0,
      request_hash: HASH_A,
      issued_at: NOW,
      expires_at: LATER,
      authorization_hash: HASH_A,
    };
    const sealedAuthorization = {
      ...authorization,
      authorization_hash: canonicalSha256Omitting(authorization, [
        "authorization_hash",
      ]),
    };
    expect(
      CanaryAuthorizationSchema.parse(sealedAuthorization).maximum_exposures,
    ).toBe(3);
    expect(
      CanaryAuthorizationSchema.safeParse({
        ...sealedAuthorization,
        canary_receipt_id: "receipt_that_does_not_exist_yet",
      }).success,
    ).toBe(false);

    const approval = {
      schema_version: "1.0.0",
      approval_id: "release_approval_1",
      principal_id: "user_local",
      action: "release",
      scopes: [USER_SCOPE, WORKSPACE_SCOPE],
      candidate_id: "candidate_1",
      release_slot_hash: validReleaseSlot().slot_hash,
      base_release_id: null,
      evaluation_receipt_id: "receipt_eval_1",
      evaluation_receipt_hash: HASH_A,
      canary_receipt_id: "receipt_canary_1",
      canary_receipt_hash: HASH_B,
      expected_pointer_revision: 0,
      target_release_id: null,
      control_epoch: 0,
      request_hash: HASH_A,
      effect_manifest_hash: HASH_B,
      issued_at: NOW,
      expires_at: LATER,
      approval_hash: HASH_A,
    };
    const sealedApproval = {
      ...approval,
      approval_hash: canonicalSha256Omitting(approval, ["approval_hash"]),
    };
    expect(PostCanaryApprovalSchema.parse(sealedApproval).action).toBe(
      "release",
    );
    expect(
      PostCanaryApprovalSchema.safeParse({
        ...sealedApproval,
        canary_receipt_id: undefined,
      }).success,
    ).toBe(false);

    const rollbackApproval = {
      ...approval,
      approval_id: "rollback_approval_1",
      action: "rollback",
      target_release_id: null,
      expected_pointer_revision: 1,
    };
    expect(
      PostCanaryApprovalSchema.safeParse({
        ...rollbackApproval,
        approval_hash: canonicalSha256Omitting(rollbackApproval, [
          "approval_hash",
        ]),
      }).success,
    ).toBe(true);

    const rollbackVersion = {
      schema_version: "1.0.0",
      release_id: "rollback_version_1",
      action: "rollback",
      release_slot_hash: validReleaseSlot().slot_hash,
      candidate_id: "candidate_1",
      previous_release_id: "release_1",
      restored_release_id: null,
      evaluation_receipt_id: "receipt_eval_1",
      canary_receipt_id: "receipt_canary_1",
      approval_id: "rollback_approval_1",
      monitor_contract_hash: HASH_A,
      configuration_hash: HASH_B,
      activated_at: NOW,
      release_hash: HASH_A,
    };
    expect(
      LearningReleaseVersionSchema.safeParse({
        ...rollbackVersion,
        release_hash: canonicalSha256Omitting(rollbackVersion, [
          "release_hash",
        ]),
      }).success,
    ).toBe(true);
  });

  it("keeps release pointers guarded and content-free", () => {
    const pointerInput = {
      schema_version: "1.0.0",
      release_slot_hash: validReleaseSlot().slot_hash,
      active_release_id: null,
      pointer_revision: 0,
      updated_at: NOW,
      pointer_hash: HASH_A,
    };
    const pointer = ReleasePointerSchema.parse({
      ...pointerInput,
      pointer_hash: canonicalSha256Omitting(pointerInput, ["pointer_hash"]),
    });
    expect(pointer.active_release_id).toBeNull();
    expect(
      ReleasePointerSchema.safeParse({
        ...pointer,
        content: "must not be retained",
      }).success,
    ).toBe(false);
  });

  it("binds candidate transitions to exact prior state and evidence", () => {
    const transition = {
      schema_version: "1.0.0",
      transition_id: "transition_1",
      candidate_id: "candidate_1",
      sequence: 1,
      from_state: "proposed",
      to_state: "quarantined",
      expected_previous_transition_hash: null,
      control_epoch: 0,
      actor_id: "learning_lab",
      authority_id: null,
      reason_code: "EVIDENCE_COMPLETE",
      evidence_receipt_ids: ["receipt_trace_1"],
      idempotency_key: "transition-request-001",
      transitioned_at: NOW,
      transition_hash: HASH_A,
    };
    const sealed = {
      ...transition,
      transition_hash: canonicalSha256Omitting(transition, ["transition_hash"]),
    };
    expect(CandidateTransitionSchema.parse(sealed).sequence).toBe(1);
    expect(
      CandidateTransitionSchema.safeParse({
        ...sealed,
        from_state: "proposed",
        to_state: "released",
      }).success,
    ).toBe(false);
  });
});
