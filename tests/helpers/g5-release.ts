import {
  ApprovalBindingSchema,
  ApprovalGrantSchema,
  CanaryAuthorizationSchema,
  CanonicalHashSchema,
  PostCanaryApprovalSchema,
  canonicalJson,
  canonicalSha256,
  canonicalSha256Omitting,
  type ApprovalBinding,
  type ApprovalGrant,
  type CandidateState,
  type CandidateChange,
  type LanePolicy,
  type PostCanaryApproval,
} from "../../packages/contracts/src/index.js";
import {
  CandidateLifecycle,
  G5PartitionLoader,
  LearningCanaryRunner,
  type LearningReleaseInput,
  type LearningReleaseResult,
  type CanaryRunResult,
} from "../../packages/learning-lab/src/index.js";
import type { SqliteStorageClient } from "@memo-graph/storage-sqlite";

import {
  NOW,
  USER_SCOPE,
} from "./examples.js";
import {
  canaryAuthorization,
  canaryInput,
  postCanaryApproval,
  prepareApprovedCandidate,
  TestLearningAuthorityRegistry,
} from "./g5-canary.js";
import {
  G5_FIXTURE_ROOT,
  runG5Evaluation,
} from "./g5-replay.js";
import {
  LEARNING_WORKSPACE_SCOPE,
  learningCandidate,
  learningTrace,
} from "./learning-examples.js";

export const RELEASE_CLOCK = "2026-07-28T12:05:00.000Z";
export const BASE_LANE_POLICY = {
  allowed_lanes: [
    "recent_l1",
    "topic",
    "scenario_procedure",
    "core",
    "relation_sqlite",
  ],
  limits: {
    max_candidates_per_lane: 20,
    relation_max_depth: 2,
    relation_max_fanout: 5,
    max_concurrent_lanes: 2,
  },
} satisfies LanePolicy;

export type ReleaseRequestFixture = LearningReleaseInput;

export const RELEASE_SCOPES = [
  USER_SCOPE,
  LEARNING_WORKSPACE_SCOPE,
] as [typeof USER_SCOPE, typeof LEARNING_WORKSPACE_SCOPE];

export class TestReleaseApprovalRegistry {
  readonly grants = new Map<string, ApprovalGrant>();
  verifyCalls = 0;
  confirmCalls = 0;

  register(approval: PostCanaryApproval): ApprovalBinding {
    const learning = {
      action: approval.action,
      candidate_id: approval.candidate_id,
      release_slot_hash: approval.release_slot_hash,
      base_release_id: approval.base_release_id,
      evaluation_receipt_id: approval.evaluation_receipt_id,
      evaluation_receipt_hash: approval.evaluation_receipt_hash,
      canary_receipt_id: approval.canary_receipt_id,
      canary_receipt_hash: approval.canary_receipt_hash,
      expected_pointer_revision: approval.expected_pointer_revision,
      target_release_id: approval.target_release_id,
      control_epoch: approval.control_epoch,
      effect_manifest_hash: approval.effect_manifest_hash,
    };
    const binding = ApprovalBindingSchema.parse({
      approval_id: approval.approval_id,
      principal_id: approval.principal_id,
      tool:
        approval.action === "release"
          ? "learning_release"
          : "learning_rollback",
      safety_class: "important_mutation",
      scopes: approval.scopes,
      request_hash: approval.request_hash,
      learning,
    });
    const unsigned = {
      schema_version: "1.0.0",
      ...binding,
      issued_at: "2026-07-28T11:59:00.000Z",
      expires_at: "2026-07-28T12:11:00.000Z",
      manifest_hash: canonicalSha256("placeholder"),
    };
    this.grants.set(
      approval.approval_id,
      ApprovalGrantSchema.parse({
        ...unsigned,
        manifest_hash: canonicalSha256Omitting(unsigned, [
          "manifest_hash",
        ]),
      }),
    );
    return binding;
  }

  async verify(binding: ApprovalBinding) {
    this.verifyCalls += 1;
    const grant = this.grants.get(binding.approval_id);
    if (
      grant === undefined ||
      canonicalJson({
        approval_id: grant.approval_id,
        principal_id: grant.principal_id,
        tool: grant.tool,
        safety_class: grant.safety_class,
        scopes: grant.scopes,
        request_hash: grant.request_hash,
        ...(grant.learning === undefined
          ? {}
          : { learning: grant.learning }),
      }) !== canonicalJson(binding)
    ) {
      throw new Error("APPROVAL_INVALID");
    }
    return {
      grant,
      registry_hash: canonicalSha256(
        [...this.grants.keys()].sort(),
      ),
    };
  }

  async confirmUnchanged(verified: { grant: ApprovalGrant }) {
    this.confirmCalls += 1;
    if (
      this.grants.get(verified.grant.approval_id)?.manifest_hash !==
        verified.grant.manifest_hash
    ) {
      throw new Error("APPROVAL_INVALID");
    }
  }
}

export async function preparePassedCanary(options: {
  storage: SqliteStorageClient;
  suffix: string;
  candidate?: CandidateChange;
}): Promise<{
  authority: TestLearningAuthorityRegistry;
  candidate: CandidateChange;
  canary: CanaryRunResult;
  evaluation: Awaited<
    ReturnType<typeof prepareApprovedCandidate>
  >["evaluation"];
}> {
  let prepared: Awaited<ReturnType<typeof prepareApprovedCandidate>>;
  const candidate = options.candidate ?? learningCandidate();
  if (options.candidate === undefined) {
    prepared = await prepareApprovedCandidate({
      storage: options.storage,
      runId: `run_g5_release_${options.suffix}`,
      evaluationKey: `g5-release-evaluation-${options.suffix}-001`,
    });
  } else {
    const trace = learningTrace({
      trace_id: candidate.trace_ids[0],
    });
    const traceCommand = {
      kind: "trace" as const,
      idempotency_key: `g5-release-trace-${options.suffix}-001`,
      trace,
    };
    await options.storage.writeLearningLedger({
      ...traceCommand,
      request_hash: canonicalSha256Omitting(traceCommand, [
        "request_hash",
      ]),
    });
    const candidateCommand = {
      kind: "candidate" as const,
      idempotency_key: `g5-release-candidate-${options.suffix}-001`,
      candidate,
    };
    await options.storage.writeLearningLedger({
      ...candidateCommand,
      request_hash: canonicalSha256Omitting(candidateCommand, [
        "request_hash",
      ]),
    });
    const evaluation = await runG5Evaluation({
      storage: options.storage,
      idempotencyKey:
        `g5-release-evaluation-${options.suffix}-001`,
      runId: `run_g5_release_${options.suffix}`,
      candidate,
    });
    const lifecycle = new CandidateLifecycle({
      storage: options.storage,
    });
    let state: CandidateState = "proposed";
    let sequence = 0;
    let transitionHash: string | null = null;
    let latest:
      | Awaited<ReturnType<CandidateLifecycle["transition"]>>
      | undefined;
    for (const [index, toState] of (
      [
        "quarantined",
        "evaluating",
        "approved_for_canary",
      ] as const
    ).entries()) {
      latest = await lifecycle.transition({
        schema_version: "1.0.0",
        idempotency_key:
          `g5-release-lifecycle-${options.suffix}-${index + 1}`,
        principal_id: "user_local",
        scopes: RELEASE_SCOPES,
        candidate_id: candidate.candidate_id,
        expected_state: state,
        expected_sequence: sequence,
        expected_previous_transition_hash: transitionHash,
        to_state: toState,
        control_epoch: 0,
        actor_id: "learning_evaluator",
        authority_id: null,
        evidence_receipt_ids: [evaluation.receipt.receipt_id],
        reason_code: "G5_EVALUATION_COMPLETE",
        transitioned_at: NOW,
      });
      state = toState;
      sequence = latest.transition.sequence;
      transitionHash = latest.transition.transition_hash;
    }
    if (latest === undefined) {
      throw new Error("approved candidate transition required");
    }
    prepared = { evaluation, latest };
  }
  const input = await canaryInput({
    evaluation: prepared.evaluation,
    authorizationId: `authorization_release_${options.suffix}`,
    stableReleaseId: candidate.active_base_release_id,
  });
  const authority = new TestLearningAuthorityRegistry();
  const baseAuthorization = await canaryAuthorization({
      evaluation: prepared.evaluation,
      input,
      overrides: {
        base_release_id: candidate.active_base_release_id,
      },
    });
  const authorizationInput = {
    ...baseAuthorization,
    release_slot_hash:
      candidate.release_slot?.slot_hash ??
      baseAuthorization.release_slot_hash,
    authorization_hash: canonicalSha256("placeholder"),
  };
  authority.canaryAuthorizations.set(
    input.authorization_id,
    CanaryAuthorizationSchema.parse({
      ...authorizationInput,
      authorization_hash: canonicalSha256Omitting(
        authorizationInput,
        ["authorization_hash"],
      ),
    }),
  );
  const runner = new LearningCanaryRunner({
    storage: options.storage,
    partitions: new G5PartitionLoader({
      fixtureRoot: G5_FIXTURE_ROOT,
      clock: () => NOW,
    }),
    authorityRegistry: authority,
    executeCase: (request) => ({
      case_id: request.case_body.case_id,
      stable_comparator_release_id: request.stable_release_id,
      passed: true,
      failure_codes: [],
      initial_state_hash: request.initial_state_hash,
      final_state_hash: request.initial_state_hash,
    }),
    stateProbe: () => prepared.evaluation.identity.environment_hash,
    clock: () => NOW,
  });
  return {
    authority,
    candidate,
    canary: await runner.run(input),
    evaluation: prepared.evaluation,
  };
}

export function releaseRequest(options: {
  suffix: string;
  approvalId?: string;
  failurePoint?: ReleaseRequestFixture["test_failure_point"];
  candidateId?: string;
  operatorLanePolicy?: LanePolicy | null;
  baseConfigurationHash?: string;
}): ReleaseRequestFixture {
  const operatorLanePolicy =
    options.operatorLanePolicy === undefined
      ? BASE_LANE_POLICY
      : options.operatorLanePolicy;
  return {
    schema_version: "1.0.0",
    action: "release",
    idempotency_key: `learning-release-${options.suffix}-001`,
    principal_id: "user_local",
    scopes: RELEASE_SCOPES,
    candidate_id: options.candidateId ?? "candidate_storage_1",
    approval_id:
      options.approvalId ?? `post_canary_release_${options.suffix}`,
    target_release_id: null,
    operator_lane_policy: operatorLanePolicy,
    base_configuration_hash:
      options.baseConfigurationHash ??
      canonicalSha256(
        operatorLanePolicy ?? { kind: "canonical_memory_base" },
      ),
    monitor_contract_hash: canonicalSha256("g5-monitor-contract"),
    monitor_receipt_id: null,
    reason: "Publish the exact canary-qualified retrieval policy.",
    activated_at: RELEASE_CLOCK,
    ...(options.failurePoint === undefined
      ? {}
      : { test_failure_point: options.failurePoint }),
  };
}

export function rollbackRequest(options: {
  suffix: string;
  released: LearningReleaseResult;
  operatorLanePolicy?: LanePolicy | null;
  baseConfigurationHash?: string;
  targetReleaseId?: string | null;
  monitorReceiptId?: string | null;
}): ReleaseRequestFixture {
  const operatorLanePolicy =
    options.operatorLanePolicy === undefined
      ? BASE_LANE_POLICY
      : options.operatorLanePolicy;
  return {
    schema_version: "1.0.0",
    action: "rollback",
    idempotency_key: `learning-rollback-${options.suffix}-001`,
    principal_id: options.released.request.principal_id,
    scopes: [...options.released.request.scopes],
    candidate_id: options.released.release.candidate_id,
    approval_id: `post_canary_rollback_${options.suffix}`,
    target_release_id: options.targetReleaseId ?? null,
    operator_lane_policy: operatorLanePolicy,
    base_configuration_hash:
      options.baseConfigurationHash ??
      canonicalSha256(
        operatorLanePolicy ?? { kind: "canonical_memory_base" },
      ),
    monitor_contract_hash:
      options.released.release.monitor_contract_hash,
    monitor_receipt_id: options.monitorReceiptId ?? null,
    reason: "Restore the exact named safe release pointer.",
    activated_at: "2026-07-28T12:06:00.000Z",
  };
}

export function learnedPolicyFor(candidate: CandidateChange) {
  if (candidate.target.kind !== "retrieval_policy") {
    throw new Error("retrieval-policy candidate required");
  }
  return {
    allowed_lanes: BASE_LANE_POLICY.allowed_lanes.filter((lane) =>
      candidate.target.kind === "retrieval_policy" &&
      candidate.target.requested_lanes.includes(lane)
    ),
    limits: {
      ...BASE_LANE_POLICY.limits,
      ...candidate.target.limits,
    },
  };
}

export function releaseEffectManifest(options: {
  request: ReleaseRequestFixture;
  candidate: CandidateChange;
  baseReleaseId: string | null;
  resultingConfigurationHash: string;
}) {
  return canonicalSha256({
    schema_version: options.request.schema_version,
    action: options.request.action,
    candidate_id: options.candidate.candidate_id,
    candidate_hash: options.candidate.candidate_hash,
    release_slot_hash: options.candidate.release_slot?.slot_hash,
    base_release_id: options.baseReleaseId,
    target_release_id: options.request.target_release_id,
    base_configuration_hash:
      options.request.base_configuration_hash,
    resulting_configuration_hash:
      options.resultingConfigurationHash,
    target: options.candidate.target,
  });
}

export function authorizeRelease(options: {
  request: ReleaseRequestFixture;
  prepared: Awaited<ReturnType<typeof preparePassedCanary>>;
  approvals: TestReleaseApprovalRegistry;
  baseReleaseId?: string | null;
  expectedPointerRevision?: number;
  requestHash?: `sha256:${string}`;
}): PostCanaryApproval {
  const requestHash =
    options.requestHash ?? canonicalSha256(options.request);
  const configurationHash =
    options.prepared.candidate.target.kind === "retrieval_policy"
      ? canonicalSha256(learnedPolicyFor(options.prepared.candidate))
      : canonicalSha256(options.prepared.candidate.target);
  const unsigned = postCanaryApproval({
    evaluation: options.prepared.evaluation,
    canaryReceiptId: options.prepared.canary.receipt.receipt_id,
    canaryReceiptHash: options.prepared.canary.receipt.receipt_hash,
    approvalId: options.request.approval_id,
    requestHash,
  });
  const input = {
    ...unsigned,
    candidate_id: options.prepared.candidate.candidate_id,
    release_slot_hash:
      options.prepared.candidate.release_slot?.slot_hash ??
      unsigned.release_slot_hash,
    scopes: [...options.request.scopes],
    request_hash: requestHash,
    base_release_id: options.baseReleaseId ?? null,
    expected_pointer_revision:
      options.expectedPointerRevision ?? 0,
    effect_manifest_hash: releaseEffectManifest({
      request: options.request,
      candidate: options.prepared.candidate,
      baseReleaseId: options.baseReleaseId ?? null,
      resultingConfigurationHash: configurationHash,
    }),
    approval_hash: canonicalSha256("placeholder"),
  };
  const approval = PostCanaryApprovalSchema.parse({
    ...input,
    approval_hash: canonicalSha256Omitting(input, ["approval_hash"]),
  });
  options.prepared.authority.postCanaryApprovals.set(
    approval.approval_id,
    approval,
  );
  options.approvals.register(approval);
  return approval;
}

export function authorizeRollback(options: {
  request: ReleaseRequestFixture;
  prepared: Awaited<ReturnType<typeof preparePassedCanary>>;
  released: LearningReleaseResult;
  approvals: TestReleaseApprovalRegistry;
  targetRelease?: LearningReleaseResult;
  requestHash?: `sha256:${string}`;
  controlEpoch?: number;
}): PostCanaryApproval {
  const requestHash =
    options.requestHash ?? canonicalSha256(options.request);
  const resultingConfigurationHash = CanonicalHashSchema.parse(
    options.request.target_release_id === null
      ? options.request.base_configuration_hash
      : options.targetRelease?.release.configuration_hash ??
          options.released.release.configuration_hash,
  );
  const input = {
    schema_version: "1.0.0",
    approval_id: options.request.approval_id,
    principal_id: options.request.principal_id,
    action: "rollback" as const,
    scopes: [...options.request.scopes],
    candidate_id: options.prepared.candidate.candidate_id,
    release_slot_hash:
      options.prepared.candidate.release_slot?.slot_hash ??
      options.released.release.release_slot_hash,
    base_release_id: options.released.release.release_id,
    evaluation_receipt_id:
      options.prepared.evaluation.receipt.receipt_id,
    evaluation_receipt_hash:
      options.prepared.evaluation.receipt.receipt_hash,
    canary_receipt_id:
      options.prepared.canary.receipt.receipt_id,
    canary_receipt_hash:
      options.prepared.canary.receipt.receipt_hash,
    expected_pointer_revision:
      options.released.pointer.pointer_revision,
    target_release_id: options.request.target_release_id,
    control_epoch: options.controlEpoch ?? 0,
    request_hash: requestHash,
    effect_manifest_hash: releaseEffectManifest({
      request: options.request,
      candidate: options.prepared.candidate,
      baseReleaseId: options.released.release.release_id,
      resultingConfigurationHash,
    }),
    issued_at: "2026-07-28T11:59:00.000Z",
    expires_at: "2026-07-28T12:11:00.000Z",
    approval_hash: canonicalSha256("placeholder"),
  };
  const approval = PostCanaryApprovalSchema.parse({
    ...input,
    approval_hash: canonicalSha256Omitting(input, ["approval_hash"]),
  });
  options.prepared.authority.postCanaryApprovals.set(
    approval.approval_id,
    approval,
  );
  options.approvals.register(approval);
  return approval;
}
