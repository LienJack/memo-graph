import {
  ApprovalBindingSchema,
  ApprovalGrantSchema,
  CandidateChangeSchema,
  CandidateTransitionSchema,
  CandidateTransitionReceiptSchema,
  CanaryAuthorizationSchema,
  CanaryReceiptSchema,
  CanaryRunSchema,
  EvalReceiptSchema,
  EvaluationCaseResultSetSchema,
  EvaluationCommonIdentitySchema,
  LearningControlReceiptSchema,
  LearningControlSchema,
  LearningReleaseVersionSchema,
  LearningStopReceiptSchema,
  LearningTraceSchema,
  MonitorReceiptSchema,
  MonitorResultSchema,
  PostCanaryApprovalSchema,
  ReleasePointerSchema,
  ReleaseReceiptSchema,
  RollbackReceiptSchema,
  canonicalSha256,
  canonicalSha256Omitting,
  sealReceipt,
  type CandidateChange,
  type CandidateTransition,
  type LearningTrace,
} from "../../packages/contracts/dist/index.js";
import { HASH_A, HASH_B, LATER, NOW, USER_SCOPE } from "./examples.ts";

export const LEARNING_WORKSPACE_SCOPE = {
  kind: "workspace",
  id: "workspace_local",
} as const;

export const EMPTY_LEARNING_FRONTIER_HASH =
  canonicalSha256Omitting(
    {
      controls: [],
      pointers: [],
      frontier_hash: null,
    },
    ["frontier_hash"],
  );

type FixtureOverrides<T> = Partial<Record<keyof T, unknown>>;

export function learningTrace(
  overrides: FixtureOverrides<LearningTrace> = {},
): LearningTrace {
  const input = {
    schema_version: "1.0.0",
    trace_id: "trace_storage_1",
    episode_id: "episode_storage_1",
    task_spec: {
      task_id: "task_storage_1",
      goal_hash: HASH_A,
      input_hash: HASH_B,
      success_criteria_hash: HASH_A,
    },
    principal_id: "user_local",
    scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
    context: {
      context_slice_id: "context_storage_1",
      frozen_hash: HASH_A,
      frontier_hash: HASH_B,
      compiler_version: "1.0.0",
    },
    trajectory: [
      {
        step_id: "step_storage_1",
        ordinal: 0,
        kind: "tool",
        retention: {
          mode: "reference",
          evidence_id: "evidence_storage_1",
          content_hash: HASH_A,
          media_type: "application/json",
        },
        step_hash: HASH_B,
      },
    ],
    outcome: {
      status: "failed",
      required_task_units_completed: [],
      output_hash: HASH_B,
    },
    observations: [
      {
        observation_id: "observation_storage_1",
        kind: "feedback",
        polarity: "negative",
        code: "USER_REJECTED_RESULT",
        evidence_id: "evidence_storage_1",
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
      input_tokens: 10,
      output_tokens: 5,
      latency_ms: 2,
      side_effect_ids: [],
    },
    control_epoch: 0,
    captured_at: NOW,
    trace_hash: HASH_A,
    ...overrides,
  };
  return LearningTraceSchema.parse({
    ...input,
    trace_hash: canonicalSha256Omitting(input, ["trace_hash"]),
  });
}

function releaseSlot() {
  const slot = {
    principal_id: "user_local",
    candidate_type: "retrieval_policy",
    scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
    target_key: "default_recall",
    slot_hash: HASH_A,
  } as const;
  return {
    ...slot,
    slot_hash: canonicalSha256Omitting(slot, ["slot_hash"]),
  };
}

export function learningCandidate(
  overrides: FixtureOverrides<CandidateChange> = {},
): CandidateChange {
  const slot = releaseSlot();
  const input = {
    schema_version: "1.0.0",
    candidate_id: "candidate_storage_1",
    candidate_type: "retrieval_policy",
    release_capability: "release_capable",
    principal_id: "user_local",
    scopes: slot.scopes,
    release_slot: slot,
    target: {
      kind: "retrieval_policy",
      requested_lanes: ["recent_l1"],
      limits: { max_candidates_per_lane: 10 },
    },
    base_release_ids: [],
    active_base_release_id: null,
    trace_ids: ["trace_storage_1"],
    evidence_ids: ["evidence_storage_1"],
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
    reason: "Narrow one exact retrieval lane.",
    candidate_hash: HASH_A,
    ...overrides,
  };
  return CandidateChangeSchema.parse({
    ...input,
    candidate_hash: canonicalSha256Omitting(input, ["candidate_hash"]),
  });
}

export function learningMemoryCandidate(options: {
  memoryId: string;
  revisionId: string;
  contentHash: string;
}): CandidateChange {
  const base = learningCandidate();
  const slotInput = {
    principal_id: "user_local",
    candidate_type: "memory",
    scopes: base.scopes,
    target_key: options.memoryId,
    slot_hash: HASH_A,
  } as const;
  const slot = {
    ...slotInput,
    slot_hash: canonicalSha256Omitting(slotInput, ["slot_hash"]),
  };
  const input = {
    ...base,
    candidate_id: "candidate_storage_memory_1",
    candidate_type: "memory",
    release_slot: slot,
    target: {
      kind: "memory",
      memory_id: options.memoryId,
      revision_id: options.revisionId,
      content_hash: options.contentHash,
    },
    candidate_hash: HASH_A,
  };
  return CandidateChangeSchema.parse({
    ...input,
    candidate_hash: canonicalSha256Omitting(input, ["candidate_hash"]),
  });
}

export function learningTransition(
  overrides: FixtureOverrides<CandidateTransition> = {},
): CandidateTransition {
  const input = {
    schema_version: "1.0.0",
    transition_id: "transition_storage_1",
    candidate_id: "candidate_storage_1",
    sequence: 1,
    from_state: "proposed",
    to_state: "quarantined",
    expected_previous_transition_hash: null,
    control_epoch: 0,
    actor_id: "learning_lab",
    authority_id: null,
    reason_code: "EVIDENCE_COMPLETE",
    evidence_receipt_ids: ["receipt_storage_1"],
    idempotency_key: "transition-storage-001",
    transitioned_at: NOW,
    transition_hash: HASH_A,
    ...overrides,
  };
  return CandidateTransitionSchema.parse({
    ...input,
    transition_hash: canonicalSha256Omitting(input, ["transition_hash"]),
  });
}

export function learningTransitionChain(): CandidateTransition[] {
  const states = [
    ["proposed", "quarantined"],
    ["quarantined", "evaluating"],
    ["evaluating", "approved_for_canary"],
    ["approved_for_canary", "canary"],
  ] as const;
  const transitions: CandidateTransition[] = [];
  for (const [index, [fromState, toState]] of states.entries()) {
    const previous = transitions.at(-1);
    transitions.push(
      learningTransition({
        transition_id: `transition_storage_${index + 1}`,
        sequence: index + 1,
        from_state: fromState,
        to_state: toState,
        expected_previous_transition_hash:
          previous?.transition_hash ?? null,
        idempotency_key: `transition-storage-${String(index + 1).padStart(
          3,
          "0",
        )}`,
        ...(toState === "canary"
          ? {
              authority_id: "authorization_storage_1",
              evidence_receipt_ids: [
                "receipt_eval_storage_1",
                "receipt_canary_storage_1",
              ],
            }
          : {}),
      }),
    );
  }
  return transitions;
}

export function learningTransitionReceipt(
  transition: CandidateTransition = learningTransition(),
) {
  return CandidateTransitionReceiptSchema.parse(
    sealReceipt({
      schema_version: "1.0.0",
      receipt_id: `receipt_${transition.transition_id}`,
      created_at: transition.transitioned_at,
      state: "durable",
      request_hash: HASH_A,
      kind: "learning_transition",
      candidate_id: transition.candidate_id,
      transition_id: transition.transition_id,
      sequence: transition.sequence,
      from_state: transition.from_state,
      to_state: transition.to_state,
      authority_id: transition.authority_id,
      evidence_receipt_ids: transition.evidence_receipt_ids,
      control_epoch: transition.control_epoch,
    }),
  );
}

export function learningStopReceipt() {
  return LearningStopReceiptSchema.parse(
    sealReceipt({
      schema_version: "1.0.0",
      receipt_id: "receipt_learning_stop_storage_1",
      created_at: NOW,
      state: "durable",
      request_hash: HASH_A,
      kind: "learning_stop",
      principal_id: "user_local",
      trace_id: null,
      candidate_id: null,
      control_epoch: 0,
      reason_code: "INCOMPLETE_PROVENANCE",
    }),
  );
}

export function learningEvaluationIdentity() {
  const input = {
    schema_version: "1.0.0",
    run_id: "run_storage_1",
    candidate_id: "candidate_storage_1",
    base_release_id: null,
    current_release_id: null,
    implementation_commit: "a".repeat(40),
    implementation_tree: "b".repeat(40),
    dependency_lock_hash: HASH_A,
    migration_set_hash: HASH_B,
    runtime_identity_hash: HASH_A,
    accepted_g3r_commit: "c".repeat(40),
    accepted_g4a_commit: "d".repeat(40),
    accepted_g4b_commit: "e".repeat(40),
    retrieval_configuration_hash: HASH_B,
    corpus_hash: HASH_A,
    partition_manifest_hash: HASH_B,
    scorer_hash: HASH_A,
    thresholds_hash: HASH_B,
    seed: 7,
    environment_hash: HASH_A,
    common_identity_hash: HASH_A,
  };
  return EvaluationCommonIdentitySchema.parse({
    ...input,
    common_identity_hash: canonicalSha256Omitting(input, [
      "common_identity_hash",
    ]),
  });
}

export function learningResultSet(
  partition: "calibration" | "holdout" | "transfer" = "holdout",
) {
  const identity = learningEvaluationIdentity();
  const results = (["no_candidate", "current", "candidate"] as const).map(
    (arm) => {
      const result = {
        schema_version: "1.0.0",
        eval_result_id: `eval_storage_${partition}_${arm}`,
        run_id: identity.run_id,
        case_id: `case_storage_${partition}_1`,
        partition,
        arm,
        common_identity_hash: identity.common_identity_hash,
        passed_required_task_units: ["unit_1"],
        failed_required_task_units: [],
        error_codes: [],
        negative_transfer_units: [],
        context: {
          token_budget: 1_800,
          token_used: 100,
          pollution_count: 0,
          selected_item_ids: ["memory_1"],
        },
        latency_ms: 2,
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
    },
  );
  const resultSet = {
    run_id: identity.run_id,
    case_id: `case_storage_${partition}_1`,
    partition,
    common_identity_hash: identity.common_identity_hash,
    results,
    result_set_hash: HASH_A,
  };
  return EvaluationCaseResultSetSchema.parse({
    ...resultSet,
    result_set_hash: canonicalSha256Omitting(resultSet, ["result_set_hash"]),
  });
}

export function learningPartitionSeals() {
  return (["calibration", "holdout", "transfer"] as const).map(
    (partition) => ({
      seal_id: `seal_storage_${partition}`,
      partition,
      manifest_hash: canonicalSha256({ partition, kind: "manifest" }),
      case_hashes: [0, 1, 2].map((caseIndex) =>
        canonicalSha256({ partition, caseIndex }),
      ),
      oracle_hashes: [0, 1, 2].map((caseIndex) =>
        canonicalSha256({ partition, oracle: caseIndex }),
      ),
      sealed_at: NOW,
    }),
  );
}

export function learningEvalReceipt() {
  const resultSets = (
    ["calibration", "holdout", "transfer"] as const
  ).map(learningResultSet);
  return EvalReceiptSchema.parse(
    sealReceipt({
      schema_version: "1.0.0",
      receipt_id: "receipt_eval_storage_1",
      created_at: NOW,
      state: "durable",
      request_hash: HASH_A,
      kind: "evaluation",
      candidate_id: "candidate_storage_1",
      run_id: "run_storage_1",
      evaluation_version: "1.0.0",
      fixture_manifest_hash: HASH_A,
      thresholds_hash: HASH_B,
      common_identity_hash:
        learningEvaluationIdentity().common_identity_hash,
      baseline_release_id: null,
      result_set_hashes: resultSets.map((result) => result.result_set_hash),
      passed: true,
      invalidated: false,
      failed_case_ids: [],
      quarantined_case_ids: [],
      contamination_event_ids: [],
    }),
  );
}

export function learningCanaryAuthorization() {
  const input = {
    schema_version: "1.0.0",
    authorization_id: "authorization_storage_1",
    principal_id: "user_local",
    tool: "learning_canary",
    safety_class: "important_mutation",
    scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
    candidate_id: "candidate_storage_1",
    release_slot_hash: learningCandidate().release_slot?.slot_hash ?? HASH_A,
    base_release_id: null,
    evaluation_receipt_id: "receipt_eval_storage_1",
    evaluation_receipt_hash: learningEvalReceipt().receipt_hash,
    canary_manifest_id: "canary_manifest_storage_1",
    canary_manifest_hash: HASH_B,
    case_hashes: [
      canonicalSha256("canary-1"),
      canonicalSha256("canary-2"),
      canonicalSha256("canary-3"),
    ],
    maximum_exposures: 3,
    deadline_at: LATER,
    control_epoch: 0,
    request_hash: HASH_A,
    issued_at: NOW,
    expires_at: LATER,
    authorization_hash: HASH_A,
  };
  return CanaryAuthorizationSchema.parse({
    ...input,
    authorization_hash: canonicalSha256Omitting(input, [
      "authorization_hash",
    ]),
  });
}

export function learningCanaryRun() {
  const input = {
    schema_version: "1.0.0",
    canary_run_id: "canary_run_storage_1",
    candidate_id: "candidate_storage_1",
    authorization_id: "authorization_storage_1",
    canary_manifest_hash: HASH_B,
    stable_release_id: null,
    started_at: NOW,
    deadline_at: LATER,
    control_epoch: 0,
    status: "passed",
    exposure_count: 3,
    run_hash: HASH_A,
  };
  return CanaryRunSchema.parse({
    ...input,
    run_hash: canonicalSha256Omitting(input, ["run_hash"]),
  });
}

export function learningCanaryReceipt() {
  const authorization = learningCanaryAuthorization();
  return CanaryReceiptSchema.parse(
    sealReceipt({
      schema_version: "1.0.0",
      receipt_id: "receipt_canary_storage_1",
      created_at: NOW,
      state: "durable",
      request_hash: HASH_A,
      kind: "learning_canary",
      candidate_id: "candidate_storage_1",
      authorization_id: authorization.authorization_id,
      authorization_hash: authorization.authorization_hash,
      evaluation_receipt_id: "receipt_eval_storage_1",
      canary_manifest_hash: HASH_B,
      exposures: 3,
      passed: true,
      failure_codes: [],
      control_epoch: 0,
    }),
  );
}

export function verifiedLearningApproval(
  options:
    | { tool: "learning_pause" | "learning_resume"; requestHash: string }
    | {
        tool: "learning_release" | "learning_rollback";
        requestHash: string;
        learning:
          | ReturnType<typeof releaseApprovalDetails>
          | ReturnType<typeof rollbackApprovalDetails>;
      },
) {
  const binding = ApprovalBindingSchema.parse({
    approval_id: `approval_${options.tool}_storage_1`,
    principal_id: "user_local",
    tool: options.tool,
    safety_class: "important_mutation",
    scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
    request_hash: options.requestHash,
    ...("learning" in options ? { learning: options.learning } : {}),
  });
  const unsigned = {
    schema_version: "1.0.0",
    ...binding,
    issued_at: NOW,
    expires_at: LATER,
    manifest_hash: HASH_A,
  };
  return {
    binding,
    approval: {
      grant: ApprovalGrantSchema.parse({
        ...unsigned,
        manifest_hash: canonicalSha256Omitting(unsigned, ["manifest_hash"]),
      }),
      registry_hash: HASH_B,
      verified_at: NOW,
    },
  };
}

export function learningControl(
  status: "active" | "paused" = "paused",
  overrides: Record<string, unknown> = {},
) {
  return LearningControlSchema.parse({
    schema_version: "1.0.0",
    principal_id: "user_local",
    status,
    control_epoch: 1,
    reason_code: "USER_REQUESTED",
    actor_id: "user_local",
    changed_at: NOW,
    frontier_hash: HASH_B,
    runtime_identity_hash: HASH_A,
    configuration_hash: HASH_B,
    corpus_hash: HASH_A,
    ...overrides,
  });
}

export function learningControlReceipt(
  action: "pause" | "resume" = "pause",
  overrides: Record<string, unknown> = {},
) {
  return LearningControlReceiptSchema.parse(
    sealReceipt({
      schema_version: "1.0.0",
      receipt_id: `receipt_control_${action}_storage_1`,
      created_at: NOW,
      state: "durable",
      request_hash: HASH_A,
      kind: "learning_control",
      principal_id: "user_local",
      action,
      previous_epoch: 0,
      resulting_epoch: 1,
      previous_frontier_hash: EMPTY_LEARNING_FRONTIER_HASH,
      frontier_hash: HASH_B,
      runtime_identity_hash: HASH_A,
      configuration_hash: HASH_B,
      corpus_hash: HASH_A,
      reason_code: "USER_REQUESTED",
      ...overrides,
    }),
  );
}

export function releaseApprovalDetails() {
  return {
    action: "release" as const,
    candidate_id: "candidate_storage_1",
    release_slot_hash: learningCandidate().release_slot?.slot_hash ?? HASH_A,
    base_release_id: null,
    evaluation_receipt_id: "receipt_eval_storage_1",
    evaluation_receipt_hash: learningEvalReceipt().receipt_hash,
    canary_receipt_id: "receipt_canary_storage_1",
    canary_receipt_hash: learningCanaryReceipt().receipt_hash,
    expected_pointer_revision: 0,
    target_release_id: null,
    control_epoch: 0,
    effect_manifest_hash: HASH_B,
  };
}

export function rollbackApprovalDetails() {
  return {
    action: "rollback" as const,
    candidate_id: "candidate_storage_1",
    release_slot_hash: learningCandidate().release_slot?.slot_hash ?? HASH_A,
    base_release_id: "release_storage_1",
    evaluation_receipt_id: "receipt_eval_storage_1",
    evaluation_receipt_hash: learningEvalReceipt().receipt_hash,
    canary_receipt_id: "receipt_canary_storage_1",
    canary_receipt_hash: learningCanaryReceipt().receipt_hash,
    expected_pointer_revision: 1,
    target_release_id: null,
    control_epoch: 0,
    effect_manifest_hash: HASH_A,
  };
}

export function postCanaryApproval() {
  const details = releaseApprovalDetails();
  const input = {
    schema_version: "1.0.0",
    approval_id: "approval_learning_release_storage_1",
    principal_id: "user_local",
    ...details,
    scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
    request_hash: HASH_A,
    issued_at: NOW,
    expires_at: LATER,
    approval_hash: HASH_A,
  };
  return PostCanaryApprovalSchema.parse({
    ...input,
    approval_hash: canonicalSha256Omitting(input, ["approval_hash"]),
  });
}

export function postCanaryRollbackApproval() {
  const details = rollbackApprovalDetails();
  const input = {
    schema_version: "1.0.0",
    approval_id: "approval_learning_rollback_storage_1",
    principal_id: "user_local",
    ...details,
    scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
    request_hash: HASH_B,
    issued_at: NOW,
    expires_at: LATER,
    approval_hash: HASH_A,
  };
  return PostCanaryApprovalSchema.parse({
    ...input,
    approval_hash: canonicalSha256Omitting(input, ["approval_hash"]),
  });
}

export function learningReleaseVersion() {
  const input = {
    schema_version: "1.0.0",
    release_id: "release_storage_1",
    action: "release",
    release_slot_hash: learningCandidate().release_slot?.slot_hash ?? HASH_A,
    candidate_id: "candidate_storage_1",
    previous_release_id: null,
    restored_release_id: null,
    evaluation_receipt_id: "receipt_eval_storage_1",
    canary_receipt_id: "receipt_canary_storage_1",
    approval_id: "approval_learning_release_storage_1",
    monitor_contract_hash: HASH_A,
    configuration_hash: HASH_B,
    activated_at: NOW,
    release_hash: HASH_A,
  };
  return LearningReleaseVersionSchema.parse({
    ...input,
    release_hash: canonicalSha256Omitting(input, ["release_hash"]),
  });
}

export function learningReleasePointer() {
  const input = {
    schema_version: "1.0.0",
    release_slot_hash: learningCandidate().release_slot?.slot_hash ?? HASH_A,
    active_release_id: "release_storage_1",
    pointer_revision: 1,
    updated_at: NOW,
    pointer_hash: HASH_A,
  };
  return ReleasePointerSchema.parse({
    ...input,
    pointer_hash: canonicalSha256Omitting(input, ["pointer_hash"]),
  });
}

export function learningRollbackVersion() {
  const input = {
    schema_version: "1.0.0",
    release_id: "release_rollback_storage_1",
    action: "rollback",
    release_slot_hash: learningCandidate().release_slot?.slot_hash ?? HASH_A,
    candidate_id: "candidate_storage_1",
    previous_release_id: "release_storage_1",
    restored_release_id: null,
    evaluation_receipt_id: "receipt_eval_storage_1",
    canary_receipt_id: "receipt_canary_storage_1",
    approval_id: "approval_learning_rollback_storage_1",
    monitor_contract_hash: HASH_A,
    configuration_hash: HASH_A,
    activated_at: LATER,
    release_hash: HASH_A,
  };
  return LearningReleaseVersionSchema.parse({
    ...input,
    release_hash: canonicalSha256Omitting(input, ["release_hash"]),
  });
}

export function learningRollbackPointer() {
  const input = {
    schema_version: "1.0.0",
    release_slot_hash: learningCandidate().release_slot?.slot_hash ?? HASH_A,
    active_release_id: null,
    pointer_revision: 2,
    updated_at: LATER,
    pointer_hash: HASH_A,
  };
  return ReleasePointerSchema.parse({
    ...input,
    pointer_hash: canonicalSha256Omitting(input, ["pointer_hash"]),
  });
}

export function learningReleaseReceipt() {
  return ReleaseReceiptSchema.parse(
    sealReceipt({
      schema_version: "1.0.0",
      receipt_id: "receipt_release_storage_1",
      created_at: NOW,
      state: "durable",
      request_hash: HASH_A,
      kind: "release",
      release_id: "release_storage_1",
      release_slot_hash: learningCandidate().release_slot?.slot_hash ?? HASH_A,
      candidate_id: "candidate_storage_1",
      previous_release_id: null,
      evaluation_receipt_id: "receipt_eval_storage_1",
      canary_receipt_id: "receipt_canary_storage_1",
      approval_id: "approval_learning_release_storage_1",
      approval_hash: postCanaryApproval().approval_hash,
      resulting_pointer_revision: 1,
      control_epoch: 0,
      retrieval_configuration_hash: HASH_B,
    }),
  );
}

export function learningRollbackReceipt() {
  return RollbackReceiptSchema.parse(
    sealReceipt({
      schema_version: "1.0.0",
      receipt_id: "receipt_rollback_storage_1",
      created_at: LATER,
      state: "durable",
      request_hash: HASH_B,
      kind: "rollback",
      release_id: "release_rollback_storage_1",
      rolled_back_release_id: "release_storage_1",
      restored_release_id: null,
      approval_id: "approval_learning_rollback_storage_1",
      approval_hash: postCanaryRollbackApproval().approval_hash,
      monitor_receipt_id: "receipt_monitor_storage_1",
      resulting_pointer_revision: 2,
      control_epoch: 0,
      restored_configuration_hash: HASH_A,
      reason: "Operator requested an exact rollback to the null base.",
    }),
  );
}

export function learningMonitorResult() {
  const input = {
    schema_version: "1.0.0",
    monitor_id: "monitor_storage_1",
    release_id: "release_storage_1",
    pointer_revision: 1,
    canary_receipt_id: "receipt_canary_storage_1",
    replayed_case_ids: ["canary_1", "canary_2", "canary_3"],
    passed: true,
    failure_codes: [],
    rollback_required: false,
    monitored_at: NOW,
    monitor_hash: HASH_A,
  };
  return MonitorResultSchema.parse({
    ...input,
    monitor_hash: canonicalSha256Omitting(input, ["monitor_hash"]),
  });
}

export function learningMonitorReceipt() {
  return MonitorReceiptSchema.parse(
    sealReceipt({
      schema_version: "1.0.0",
      receipt_id: "receipt_monitor_storage_1",
      created_at: NOW,
      state: "durable",
      request_hash: HASH_A,
      kind: "learning_monitor",
      release_id: "release_storage_1",
      pointer_revision: 1,
      canary_receipt_id: "receipt_canary_storage_1",
      monitor_contract_hash: HASH_A,
      replayed_case_ids: ["canary_1", "canary_2", "canary_3"],
      passed: true,
      failure_codes: [],
      rollback_required: false,
    }),
  );
}
