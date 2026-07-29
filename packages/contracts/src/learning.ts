import { z } from "zod";

import { canonicalSha256Omitting } from "./canonical-json.js";
import {
  AuthoritySchema,
  CanonicalHashSchema,
  ContractVersionSchema,
  IdentifierSchema,
  NonEmptyReasonSchema,
  ScopeSchema,
  SensitivitySchema,
  UtcTimestampSchema,
  scopeKey,
} from "./common.js";
import {
  LaneLimitOverridesSchema,
  RecallLaneSchema,
} from "./projections.js";

const GitCommitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const StableCodeSchema = z.string().trim().min(1).max(200);

function addDuplicateIssue(
  values: readonly string[],
  context: z.RefinementCtx,
  path: PropertyKey[],
  message: string,
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", path, message });
  }
}

function addCanonicalScopeSetIssues(
  scopes: readonly z.infer<typeof ScopeSchema>[],
  context: z.RefinementCtx,
  path: PropertyKey[],
): void {
  const keys = scopes.map(scopeKey);
  addDuplicateIssue(keys, context, path, "scope set must be unique");
  const sorted = [...keys].sort();
  if (keys.some((key, index) => key !== sorted[index])) {
    context.addIssue({
      code: "custom",
      path,
      message: "scope set must use canonical scope-key order",
    });
  }
}

function addUniqueIdentifierIssues(
  values: readonly string[],
  context: z.RefinementCtx,
  path: PropertyKey[],
  label: string,
): void {
  addDuplicateIssue(values, context, path, `${label} must be unique`);
}

function addSealIssue(
  value: Record<string, unknown>,
  field: string,
  context: z.RefinementCtx,
): void {
  if (value[field] !== canonicalSha256Omitting(value, [field])) {
    context.addIssue({
      code: "custom",
      path: [field],
      message: `${field} must bind the canonical artifact`,
    });
  }
}

export const LearningOutcomeSchema = z.enum([
  "succeeded",
  "failed",
  "partial",
]);

export const LearningObservationSchema = z
  .object({
    observation_id: IdentifierSchema,
    kind: z.enum(["feedback", "error", "gap", "offline_evaluation"]),
    polarity: z.enum(["positive", "negative", "conflicting", "neutral"]),
    code: StableCodeSchema,
    evidence_id: IdentifierSchema.nullable(),
  })
  .strict();

export const LearningTraceStepRetentionSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("reference"),
      evidence_id: IdentifierSchema,
      content_hash: CanonicalHashSchema,
      media_type: z.string().trim().min(1).max(160),
    })
    .strict(),
  z
    .object({
      mode: z.literal("redacted"),
      content_hash: CanonicalHashSchema.nullable(),
      media_type: z.string().trim().min(1).max(160),
      reason_code: StableCodeSchema,
    })
    .strict(),
]);

export const LearningTraceStepSchema = z
  .object({
    step_id: IdentifierSchema,
    ordinal: z.number().int().nonnegative(),
    kind: z.enum(["model", "tool", "evidence", "control"]),
    retention: LearningTraceStepRetentionSchema,
    step_hash: CanonicalHashSchema,
  })
  .strict();

export const LearningTraceSchema = z
  .object({
    schema_version: ContractVersionSchema,
    trace_id: IdentifierSchema,
    episode_id: IdentifierSchema,
    task_spec: z
      .object({
        task_id: IdentifierSchema,
        goal_hash: CanonicalHashSchema,
        input_hash: CanonicalHashSchema,
        success_criteria_hash: CanonicalHashSchema,
      })
      .strict(),
    principal_id: IdentifierSchema,
    scopes: z.array(ScopeSchema).min(1),
    context: z
      .object({
        context_slice_id: IdentifierSchema,
        frozen_hash: CanonicalHashSchema,
        frontier_hash: CanonicalHashSchema,
        compiler_version: ContractVersionSchema,
      })
      .strict(),
    trajectory: z.array(LearningTraceStepSchema).min(1),
    outcome: z
      .object({
        status: LearningOutcomeSchema,
        required_task_units_completed: z.array(IdentifierSchema),
        output_hash: CanonicalHashSchema.nullable(),
      })
      .strict(),
    observations: z.array(LearningObservationSchema).min(1),
    active_release_set_hash: CanonicalHashSchema,
    retrieval_configuration_hash: CanonicalHashSchema,
    runtime: z
      .object({
        runtime_version: ContractVersionSchema,
        compiler_version: ContractVersionSchema,
        model_provider: IdentifierSchema,
        model_id: IdentifierSchema,
        toolset_hash: CanonicalHashSchema,
        dependency_lock_hash: CanonicalHashSchema,
      })
      .strict(),
    costs: z
      .object({
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative(),
        latency_ms: z.number().nonnegative().finite(),
        side_effect_ids: z.array(IdentifierSchema),
      })
      .strict(),
    control_epoch: z.number().int().nonnegative(),
    captured_at: UtcTimestampSchema,
    trace_hash: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    addCanonicalScopeSetIssues(value.scopes, context, ["scopes"]);
    addUniqueIdentifierIssues(
      value.trajectory.map((step) => step.step_id),
      context,
      ["trajectory"],
      "trace step identifiers",
    );
    addUniqueIdentifierIssues(
      value.trajectory.flatMap((step) =>
        step.retention.mode === "reference"
          ? [step.retention.evidence_id]
          : [],
      ),
      context,
      ["trajectory"],
      "trace evidence references",
    );
    addUniqueIdentifierIssues(
      value.observations.map((observation) => observation.observation_id),
      context,
      ["observations"],
      "observation identifiers",
    );
    addUniqueIdentifierIssues(
      value.costs.side_effect_ids,
      context,
      ["costs", "side_effect_ids"],
      "side-effect identifiers",
    );
    for (const [index, step] of value.trajectory.entries()) {
      if (step.ordinal !== index) {
        context.addIssue({
          code: "custom",
          path: ["trajectory", index, "ordinal"],
          message: "trace step ordinals must be contiguous and ordered",
        });
      }
    }
    addSealIssue(value, "trace_hash", context);
  });

export const CandidateTypeSchema = z.enum([
  "memory",
  "procedure",
  "retrieval_policy",
  "prompt",
  "core_projection",
  "scenario_pattern",
]);

export const ReleaseCapableCandidateTypeSchema = z.enum([
  "memory",
  "procedure",
  "retrieval_policy",
]);

export const ReleaseCapabilitySchema = z.enum([
  "release_capable",
  "evaluation_only",
]);

export const CandidateStateSchema = z.enum([
  "proposed",
  "quarantined",
  "evaluating",
  "approved_for_canary",
  "canary",
  "rejected",
  "released",
  "rolled_back",
]);

export const ReleaseSlotSchema = z
  .object({
    principal_id: IdentifierSchema,
    candidate_type: ReleaseCapableCandidateTypeSchema,
    scopes: z.array(ScopeSchema).min(1),
    target_key: IdentifierSchema,
    slot_hash: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    addCanonicalScopeSetIssues(value.scopes, context, ["scopes"]);
    addSealIssue(value, "slot_hash", context);
  });

export const CandidateTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("memory"),
      memory_id: IdentifierSchema,
      revision_id: IdentifierSchema,
      content_hash: CanonicalHashSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("procedure"),
      memory_id: IdentifierSchema,
      revision_id: IdentifierSchema,
      content_hash: CanonicalHashSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("retrieval_policy"),
      requested_lanes: z.array(RecallLaneSchema),
      limits: LaneLimitOverridesSchema,
    })
    .strict()
    .superRefine((value, context) => {
      addDuplicateIssue(
        value.requested_lanes,
        context,
        ["requested_lanes"],
        "retrieval-policy lanes must be unique",
      );
      for (const lane of value.requested_lanes) {
        if (lane === "relation_graph" || lane === "semantic_vector") {
          context.addIssue({
            code: "custom",
            path: ["requested_lanes"],
            message:
              "M5 retrieval-policy candidates cannot enable graph or vector lanes",
          });
        }
      }
    }),
  z
    .object({
      kind: z.literal("evaluation_only"),
      artifact_type: z.enum([
        "prompt",
        "core_projection",
        "scenario_pattern",
      ]),
      artifact_ref: IdentifierSchema,
      artifact_hash: CanonicalHashSchema,
    })
    .strict(),
]);

export const CandidateChangeSchema = z
  .object({
    schema_version: ContractVersionSchema,
    candidate_id: IdentifierSchema,
    candidate_type: CandidateTypeSchema,
    release_capability: ReleaseCapabilitySchema,
    principal_id: IdentifierSchema,
    scopes: z.array(ScopeSchema).min(1),
    release_slot: ReleaseSlotSchema.nullable(),
    target: CandidateTargetSchema,
    base_release_ids: z.array(IdentifierSchema),
    active_base_release_id: IdentifierSchema.nullable(),
    trace_ids: z.array(IdentifierSchema).min(1),
    evidence_ids: z.array(IdentifierSchema).min(1),
    expected_improvement_ids: z.array(IdentifierSchema).min(1),
    protected_invariant_ids: z.array(IdentifierSchema).min(1),
    authority: AuthoritySchema,
    sensitivity: SensitivitySchema,
    impact: z.enum(["low", "medium", "high"]),
    confidence: z.number().min(0).max(1),
    requires_user_confirmation: z.boolean(),
    evaluation_contract_hash: CanonicalHashSchema,
    rollback_target_release_id: IdentifierSchema.nullable(),
    proposed_at: UtcTimestampSchema,
    proposed_by: IdentifierSchema,
    reason: NonEmptyReasonSchema,
    candidate_hash: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    addCanonicalScopeSetIssues(value.scopes, context, ["scopes"]);
    for (const [field, entries] of [
      ["base_release_ids", value.base_release_ids],
      ["trace_ids", value.trace_ids],
      ["evidence_ids", value.evidence_ids],
      ["expected_improvement_ids", value.expected_improvement_ids],
      ["protected_invariant_ids", value.protected_invariant_ids],
    ] as const) {
      addUniqueIdentifierIssues(entries, context, [field], field);
    }
    const releaseCapable =
      ReleaseCapableCandidateTypeSchema.safeParse(value.candidate_type)
        .success;
    if (
      releaseCapable !== (value.release_capability === "release_capable")
    ) {
      context.addIssue({
        code: "custom",
        path: ["release_capability"],
        message: "candidate type and release capability must agree",
      });
    }
    if (releaseCapable && value.release_slot === null) {
      context.addIssue({
        code: "custom",
        path: ["release_slot"],
        message: "release-capable candidates require an exact release slot",
      });
    }
    if (!releaseCapable && value.release_slot !== null) {
      context.addIssue({
        code: "custom",
        path: ["release_slot"],
        message: "evaluation-only candidates cannot own a release slot",
      });
    }
    if (
      value.release_slot !== null &&
      (value.release_slot.principal_id !== value.principal_id ||
        value.release_slot.candidate_type !== value.candidate_type ||
        value.release_slot.scopes.length !== value.scopes.length ||
        value.release_slot.scopes.some((scope, index) => {
          const candidateScope = value.scopes[index];
          return (
            candidateScope === undefined ||
            scopeKey(scope) !== scopeKey(candidateScope)
          );
        }))
    ) {
      context.addIssue({
        code: "custom",
        path: ["release_slot"],
        message: "candidate and release-slot principal/type/scopes must match",
      });
    }
    const targetType =
      value.target.kind === "evaluation_only"
        ? value.target.artifact_type
        : value.target.kind;
    if (targetType !== value.candidate_type) {
      context.addIssue({
        code: "custom",
        path: ["target"],
        message: "candidate type and target kind must match",
      });
    }
    const confirmationRequired =
      value.impact === "high" ||
      value.confidence < 0.8 ||
      value.sensitivity === "sensitive" ||
      value.sensitivity === "secret" ||
      value.release_capability === "evaluation_only";
    if (confirmationRequired && !value.requires_user_confirmation) {
      context.addIssue({
        code: "custom",
        path: ["requires_user_confirmation"],
        message:
          "high-impact, low-confidence, sensitive, and broader candidates require confirmation",
      });
    }
    addSealIssue(value, "candidate_hash", context);
  });

const LEGAL_TRANSITIONS: Readonly<
  Record<z.infer<typeof CandidateStateSchema>, readonly string[]>
> = {
  proposed: ["quarantined", "rejected"],
  quarantined: ["evaluating", "rejected"],
  evaluating: ["approved_for_canary", "rejected"],
  approved_for_canary: ["canary", "rejected"],
  canary: ["released", "rolled_back", "rejected"],
  rejected: [],
  released: ["rolled_back"],
  rolled_back: [],
};

export const CandidateTransitionSchema = z
  .object({
    schema_version: ContractVersionSchema,
    transition_id: IdentifierSchema,
    candidate_id: IdentifierSchema,
    sequence: z.number().int().positive(),
    from_state: CandidateStateSchema,
    to_state: CandidateStateSchema,
    expected_previous_transition_hash: CanonicalHashSchema.nullable(),
    control_epoch: z.number().int().nonnegative(),
    actor_id: IdentifierSchema,
    authority_id: IdentifierSchema.nullable(),
    reason_code: StableCodeSchema,
    evidence_receipt_ids: z.array(IdentifierSchema).min(1),
    idempotency_key: z.string().trim().min(8).max(200),
    transitioned_at: UtcTimestampSchema,
    transition_hash: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    addUniqueIdentifierIssues(
      value.evidence_receipt_ids,
      context,
      ["evidence_receipt_ids"],
      "transition evidence receipt identifiers",
    );
    if (!LEGAL_TRANSITIONS[value.from_state].includes(value.to_state)) {
      context.addIssue({
        code: "custom",
        path: ["to_state"],
        message: `illegal candidate transition ${value.from_state} -> ${value.to_state}`,
      });
    }
    addSealIssue(value, "transition_hash", context);
  });

export const EvaluationPartitionSchema = z.enum([
  "calibration",
  "holdout",
  "transfer",
]);

export const EvaluationArmSchema = z.enum([
  "no_candidate",
  "current",
  "candidate",
]);

export const EvaluationCommonIdentitySchema = z
  .object({
    schema_version: ContractVersionSchema,
    run_id: IdentifierSchema,
    candidate_id: IdentifierSchema,
    base_release_id: IdentifierSchema.nullable(),
    current_release_id: IdentifierSchema.nullable(),
    implementation_commit: GitCommitSchema,
    implementation_tree: GitCommitSchema,
    dependency_lock_hash: CanonicalHashSchema,
    migration_set_hash: CanonicalHashSchema,
    runtime_identity_hash: CanonicalHashSchema,
    accepted_g3r_commit: GitCommitSchema,
    accepted_g4a_commit: GitCommitSchema,
    accepted_g4b_commit: GitCommitSchema,
    retrieval_configuration_hash: CanonicalHashSchema,
    corpus_hash: CanonicalHashSchema,
    partition_manifest_hash: CanonicalHashSchema,
    scorer_hash: CanonicalHashSchema,
    thresholds_hash: CanonicalHashSchema,
    seed: z.number().int().nonnegative(),
    environment_hash: CanonicalHashSchema,
    common_identity_hash: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    addSealIssue(value, "common_identity_hash", context);
  });

export const EvalResultSchema = z
  .object({
    schema_version: ContractVersionSchema,
    eval_result_id: IdentifierSchema,
    run_id: IdentifierSchema,
    case_id: IdentifierSchema,
    partition: EvaluationPartitionSchema,
    arm: EvaluationArmSchema,
    common_identity_hash: CanonicalHashSchema,
    passed_required_task_units: z.array(IdentifierSchema),
    failed_required_task_units: z.array(IdentifierSchema),
    error_codes: z.array(StableCodeSchema),
    negative_transfer_units: z.array(IdentifierSchema),
    context: z
      .object({
        token_budget: z.number().int().positive(),
        token_used: z.number().int().nonnegative(),
        pollution_count: z.number().int().nonnegative(),
        selected_item_ids: z.array(IdentifierSchema),
      })
      .strict(),
    latency_ms: z.number().nonnegative().finite(),
    side_effect_ids: z.array(IdentifierSchema),
    violation_codes: z.array(StableCodeSchema),
    critical_failure_codes: z.array(StableCodeSchema),
    evaluated_at: UtcTimestampSchema,
    result_hash: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    for (const [field, entries] of [
      ["passed_required_task_units", value.passed_required_task_units],
      ["failed_required_task_units", value.failed_required_task_units],
      ["error_codes", value.error_codes],
      ["negative_transfer_units", value.negative_transfer_units],
      ["selected_item_ids", value.context.selected_item_ids],
      ["side_effect_ids", value.side_effect_ids],
      ["violation_codes", value.violation_codes],
      ["critical_failure_codes", value.critical_failure_codes],
    ] as const) {
      addDuplicateIssue(entries, context, [field], `${field} must be unique`);
    }
    if (value.context.token_used > value.context.token_budget) {
      context.addIssue({
        code: "custom",
        path: ["context", "token_used"],
        message: "evaluation Context cannot exceed its token budget",
      });
    }
    addSealIssue(value, "result_hash", context);
  });

export const EvaluationCaseResultSetSchema = z
  .object({
    run_id: IdentifierSchema,
    case_id: IdentifierSchema,
    partition: EvaluationPartitionSchema,
    common_identity_hash: CanonicalHashSchema,
    results: z.array(EvalResultSchema).length(3),
    result_set_hash: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const arms = value.results.map((result) => result.arm);
    const expected = [...EvaluationArmSchema.options].sort();
    const actual = [...new Set(arms)].sort();
    if (
      actual.length !== expected.length ||
      actual.some((arm, index) => arm !== expected[index])
    ) {
      context.addIssue({
        code: "custom",
        path: ["results"],
        message: "every evaluation case requires the exact three arms",
      });
    }
    for (const [index, result] of value.results.entries()) {
      if (
        result.run_id !== value.run_id ||
        result.case_id !== value.case_id ||
        result.partition !== value.partition ||
        result.common_identity_hash !== value.common_identity_hash
      ) {
        context.addIssue({
          code: "custom",
          path: ["results", index],
          message: "all evaluation arms must share the exact common identity",
        });
      }
    }
    addSealIssue(value, "result_set_hash", context);
  });

export const CanaryAuthorizationSchema = z
  .object({
    schema_version: ContractVersionSchema,
    authorization_id: IdentifierSchema,
    principal_id: IdentifierSchema,
    tool: z.literal("learning_canary"),
    safety_class: z.literal("important_mutation"),
    scopes: z.array(ScopeSchema).min(1),
    candidate_id: IdentifierSchema,
    release_slot_hash: CanonicalHashSchema,
    base_release_id: IdentifierSchema.nullable(),
    evaluation_receipt_id: IdentifierSchema,
    evaluation_receipt_hash: CanonicalHashSchema,
    canary_manifest_id: IdentifierSchema,
    canary_manifest_hash: CanonicalHashSchema,
    case_hashes: z.array(CanonicalHashSchema).length(3),
    maximum_exposures: z.literal(3),
    deadline_at: UtcTimestampSchema,
    control_epoch: z.number().int().nonnegative(),
    request_hash: CanonicalHashSchema,
    issued_at: UtcTimestampSchema,
    expires_at: UtcTimestampSchema,
    authorization_hash: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    addCanonicalScopeSetIssues(value.scopes, context, ["scopes"]);
    addDuplicateIssue(
      value.case_hashes,
      context,
      ["case_hashes"],
      "canary case hashes must be unique",
    );
    if (
      Date.parse(value.deadline_at) > Date.parse(value.expires_at) ||
      Date.parse(value.expires_at) <= Date.parse(value.issued_at)
    ) {
      context.addIssue({
        code: "custom",
        path: ["expires_at"],
        message:
          "canary authorization must remain valid through its bounded deadline",
      });
    }
    addSealIssue(value, "authorization_hash", context);
  });

export const PostCanaryApprovalSchema = z
  .object({
    schema_version: ContractVersionSchema,
    approval_id: IdentifierSchema,
    principal_id: IdentifierSchema,
    action: z.enum(["release", "rollback"]),
    scopes: z.array(ScopeSchema).min(1),
    candidate_id: IdentifierSchema,
    release_slot_hash: CanonicalHashSchema,
    base_release_id: IdentifierSchema.nullable(),
    evaluation_receipt_id: IdentifierSchema,
    evaluation_receipt_hash: CanonicalHashSchema,
    canary_receipt_id: IdentifierSchema,
    canary_receipt_hash: CanonicalHashSchema,
    expected_pointer_revision: z.number().int().nonnegative(),
    target_release_id: IdentifierSchema.nullable(),
    control_epoch: z.number().int().nonnegative(),
    request_hash: CanonicalHashSchema,
    effect_manifest_hash: CanonicalHashSchema,
    issued_at: UtcTimestampSchema,
    expires_at: UtcTimestampSchema,
    approval_hash: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    addCanonicalScopeSetIssues(value.scopes, context, ["scopes"]);
    if (Date.parse(value.expires_at) <= Date.parse(value.issued_at)) {
      context.addIssue({
        code: "custom",
        path: ["expires_at"],
        message: "post-canary approval expiry must follow issuance",
      });
    }
    if (value.action === "release" && value.target_release_id !== null) {
      context.addIssue({
        code: "custom",
        path: ["target_release_id"],
        message:
          "release approvals do not name a rollback target; rollback may name a release or the explicit null base",
      });
    }
    addSealIssue(value, "approval_hash", context);
  });

export const LearningApprovalDetailsSchema = z
  .object({
    action: z.enum(["release", "rollback"]),
    candidate_id: IdentifierSchema,
    release_slot_hash: CanonicalHashSchema,
    base_release_id: IdentifierSchema.nullable(),
    evaluation_receipt_id: IdentifierSchema,
    evaluation_receipt_hash: CanonicalHashSchema,
    canary_receipt_id: IdentifierSchema,
    canary_receipt_hash: CanonicalHashSchema,
    expected_pointer_revision: z.number().int().nonnegative(),
    target_release_id: IdentifierSchema.nullable(),
    control_epoch: z.number().int().nonnegative(),
    effect_manifest_hash: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === "release" && value.target_release_id !== null) {
      context.addIssue({
        code: "custom",
        path: ["target_release_id"],
        message:
          "release approvals do not name a rollback target; rollback may name a release or the explicit null base",
      });
    }
  });

export const CanaryManifestSchema = z
  .object({
    schema_version: ContractVersionSchema,
    canary_manifest_id: IdentifierSchema,
    candidate_id: IdentifierSchema,
    stable_release_id: IdentifierSchema.nullable(),
    case_ids: z.array(IdentifierSchema).length(3),
    case_hashes: z.array(CanonicalHashSchema).length(3),
    maximum_exposures_per_case: z.literal(1),
    maximum_duration_ms: z.number().int().positive().max(600_000),
    promote_metric_ids: z.array(IdentifierSchema).min(1),
    abort_metric_ids: z.array(IdentifierSchema).min(1),
    environment_hash: CanonicalHashSchema,
    configuration_hash: CanonicalHashSchema,
    runtime_identity_hash: CanonicalHashSchema,
    control_epoch: z.number().int().nonnegative(),
    manifest_hash: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    addUniqueIdentifierIssues(
      value.case_ids,
      context,
      ["case_ids"],
      "canary case identifiers",
    );
    addDuplicateIssue(
      value.case_hashes,
      context,
      ["case_hashes"],
      "canary case hashes must be unique",
    );
    addSealIssue(value, "manifest_hash", context);
  });

export const CanaryRunSchema = z
  .object({
    schema_version: ContractVersionSchema,
    canary_run_id: IdentifierSchema,
    candidate_id: IdentifierSchema,
    authorization_id: IdentifierSchema,
    canary_manifest_hash: CanonicalHashSchema,
    stable_release_id: IdentifierSchema.nullable(),
    started_at: UtcTimestampSchema,
    deadline_at: UtcTimestampSchema,
    control_epoch: z.number().int().nonnegative(),
    status: z.enum(["running", "passed", "failed", "aborted", "frozen"]),
    exposure_count: z.number().int().min(0).max(3),
    run_hash: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.deadline_at) <= Date.parse(value.started_at)) {
      context.addIssue({
        code: "custom",
        path: ["deadline_at"],
        message: "canary deadline must follow its start",
      });
    }
    addSealIssue(value, "run_hash", context);
  });

export const LearningReleaseVersionSchema = z
  .object({
    schema_version: ContractVersionSchema,
    release_id: IdentifierSchema,
    action: z.enum(["release", "rollback"]),
    release_slot_hash: CanonicalHashSchema,
    candidate_id: IdentifierSchema,
    previous_release_id: IdentifierSchema.nullable(),
    restored_release_id: IdentifierSchema.nullable(),
    evaluation_receipt_id: IdentifierSchema,
    canary_receipt_id: IdentifierSchema,
    approval_id: IdentifierSchema,
    monitor_contract_hash: CanonicalHashSchema,
    configuration_hash: CanonicalHashSchema,
    activated_at: UtcTimestampSchema,
    release_hash: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === "release" && value.restored_release_id !== null) {
      context.addIssue({
        code: "custom",
        path: ["restored_release_id"],
        message:
          "release versions do not name a rollback target; rollback may restore a release or the explicit null base",
      });
    }
    addSealIssue(value, "release_hash", context);
  });

export const ReleasePointerSchema = z
  .object({
    schema_version: ContractVersionSchema,
    release_slot_hash: CanonicalHashSchema,
    active_release_id: IdentifierSchema.nullable(),
    pointer_revision: z.number().int().nonnegative(),
    updated_at: UtcTimestampSchema,
    pointer_hash: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    addSealIssue(value, "pointer_hash", context);
  });

export const MonitorResultSchema = z
  .object({
    schema_version: ContractVersionSchema,
    monitor_id: IdentifierSchema,
    release_id: IdentifierSchema,
    pointer_revision: z.number().int().nonnegative(),
    canary_receipt_id: IdentifierSchema,
    replayed_case_ids: z.array(IdentifierSchema).length(3),
    passed: z.boolean(),
    failure_codes: z.array(StableCodeSchema),
    rollback_required: z.boolean(),
    monitored_at: UtcTimestampSchema,
    monitor_hash: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    addUniqueIdentifierIssues(
      value.replayed_case_ids,
      context,
      ["replayed_case_ids"],
      "monitor replay case identifiers",
    );
    if (value.passed === value.rollback_required) {
      context.addIssue({
        code: "custom",
        path: ["rollback_required"],
        message: "failed monitoring must require rollback and passed monitoring must not",
      });
    }
    addSealIssue(value, "monitor_hash", context);
  });

export const LearningControlSchema = z
  .object({
    schema_version: ContractVersionSchema,
    principal_id: IdentifierSchema,
    status: z.enum(["active", "paused"]),
    control_epoch: z.number().int().nonnegative(),
    reason_code: StableCodeSchema,
    actor_id: IdentifierSchema,
    changed_at: UtcTimestampSchema,
    frontier_hash: CanonicalHashSchema,
    runtime_identity_hash: CanonicalHashSchema,
    configuration_hash: CanonicalHashSchema,
    corpus_hash: CanonicalHashSchema,
  })
  .strict();

export const LearningInspectionSchema = z
  .object({
    schema_version: ContractVersionSchema,
    principal_id: IdentifierSchema,
    storage_frontier: z
      .object({
        control_epoch: z.number().int().nonnegative(),
        release_revision: z.number().int().nonnegative(),
        frontier_hash: CanonicalHashSchema,
      })
      .strict(),
    control: LearningControlSchema.nullable(),
    candidates: z.array(
      z
        .object({
          candidate_id: IdentifierSchema,
          candidate_hash: CanonicalHashSchema,
          candidate_type: CandidateTypeSchema,
          release_capability: ReleaseCapabilitySchema,
          state: CandidateStateSchema,
          sequence: z.number().int().nonnegative(),
          transition_hash: CanonicalHashSchema.nullable(),
          release_slot_hash: CanonicalHashSchema.nullable(),
        })
        .strict(),
    ),
    releases: z.array(
      z
        .object({
          release_id: IdentifierSchema,
          release_hash: CanonicalHashSchema,
          action: z.enum(["release", "rollback"]),
          candidate_id: IdentifierSchema,
          configuration_hash: CanonicalHashSchema,
        })
        .strict(),
    ),
    pointers: z.array(ReleasePointerSchema),
    receipts: z.array(
      z
        .object({
          receipt_id: IdentifierSchema,
          kind: StableCodeSchema,
          state: StableCodeSchema,
          receipt_hash: CanonicalHashSchema,
          created_at: UtcTimestampSchema,
        })
        .strict(),
    ),
    limitations: z.array(StableCodeSchema),
  })
  .strict();

export const G5EvidenceEnvelopeSchema = z
  .object({
    schema_version: ContractVersionSchema,
    implementation_commit: GitCommitSchema,
    implementation_tree: GitCommitSchema,
    evidence_commit: GitCommitSchema.nullable(),
    dependency_lock_hash: CanonicalHashSchema,
    migration_set_hash: CanonicalHashSchema,
    runtime_identity_hash: CanonicalHashSchema,
    accepted_g3r_commit: GitCommitSchema,
    accepted_g4a_commit: GitCommitSchema,
    accepted_g4b_commit: GitCommitSchema,
    retrieval_configuration_hash: CanonicalHashSchema,
    fixture_manifest_hash: CanonicalHashSchema,
    thresholds_hash: CanonicalHashSchema,
    evaluation_receipt_id: IdentifierSchema,
    canary_receipt_id: IdentifierSchema,
    release_receipt_id: IdentifierSchema,
    monitor_receipt_id: IdentifierSchema,
    rollback_receipt_id: IdentifierSchema,
    synthetic_only: z.literal(true),
    evidence_hash: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    addSealIssue(value, "evidence_hash", context);
  });

export type CandidateChange = z.infer<typeof CandidateChangeSchema>;
export type CandidateState = z.infer<typeof CandidateStateSchema>;
export type CandidateTarget = z.infer<typeof CandidateTargetSchema>;
export type CandidateTransition = z.infer<typeof CandidateTransitionSchema>;
export type CandidateType = z.infer<typeof CandidateTypeSchema>;
export type CanaryAuthorization = z.infer<typeof CanaryAuthorizationSchema>;
export type CanaryManifest = z.infer<typeof CanaryManifestSchema>;
export type CanaryRun = z.infer<typeof CanaryRunSchema>;
export type EvalResult = z.infer<typeof EvalResultSchema>;
export type EvaluationArm = z.infer<typeof EvaluationArmSchema>;
export type EvaluationCaseResultSet = z.infer<
  typeof EvaluationCaseResultSetSchema
>;
export type EvaluationCommonIdentity = z.infer<
  typeof EvaluationCommonIdentitySchema
>;
export type EvaluationPartition = z.infer<typeof EvaluationPartitionSchema>;
export type G5EvidenceEnvelope = z.infer<typeof G5EvidenceEnvelopeSchema>;
export type LearningApprovalDetails = z.infer<
  typeof LearningApprovalDetailsSchema
>;
export type LearningControl = z.infer<typeof LearningControlSchema>;
export type LearningInspection = z.infer<typeof LearningInspectionSchema>;
export type LearningObservation = z.infer<typeof LearningObservationSchema>;
export type LearningReleaseVersion = z.infer<
  typeof LearningReleaseVersionSchema
>;
export type LearningTrace = z.infer<typeof LearningTraceSchema>;
export type LearningTraceStep = z.infer<typeof LearningTraceStepSchema>;
export type MonitorResult = z.infer<typeof MonitorResultSchema>;
export type PostCanaryApproval = z.infer<typeof PostCanaryApprovalSchema>;
export type ReleaseCapability = z.infer<typeof ReleaseCapabilitySchema>;
export type ReleasePointer = z.infer<typeof ReleasePointerSchema>;
export type ReleaseSlot = z.infer<typeof ReleaseSlotSchema>;
