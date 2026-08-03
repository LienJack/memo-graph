import {
  CanaryAuthorizationSchema,
  CanaryManifestSchema,
  PostCanaryApprovalSchema,
  canonicalSha256,
  canonicalSha256Omitting,
  type CanaryAuthorization,
  type CandidateState,
  type PostCanaryApproval,
} from "../../packages/contracts/dist/index.js";
import {
  CandidateLifecycle,
  G5PartitionLoader,
  type CandidateLifecycleResult,
} from "../../packages/learning-lab/dist/index.js";
import type {
  LearningAuthorityRegistry,
  VerifiedCanaryAuthorization,
  VerifiedPostCanaryApproval,
} from "../../packages/memory-kernel/dist/index.js";
import type { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import {
  HASH_A,
  HASH_B,
  NOW,
  USER_SCOPE,
} from "./examples.ts";
import {
  G5_FIXTURE_ROOT,
  runG5Evaluation,
  seedLearningCandidate,
  type G5ExecutionIdentity,
} from "./g5-replay.ts";
import {
  LEARNING_WORKSPACE_SCOPE,
  learningCandidate,
} from "./learning-examples.ts";

export const CANARY_DEADLINE = "2026-07-28T12:10:00.000Z";
export const CANARY_EXPIRES = "2026-07-28T12:11:00.000Z";
export const CANARY_ISSUED = "2026-07-28T11:59:00.000Z";

export class TestLearningAuthorityRegistry
  implements LearningAuthorityRegistry
{
  readonly canaryAuthorizations = new Map<
    string,
    CanaryAuthorization
  >();
  readonly postCanaryApprovals = new Map<
    string,
    PostCanaryApproval
  >();
  verifyCanaryCalls = 0;
  confirmCanaryCalls = 0;
  verifyPostCanaryCalls = 0;
  confirmPostCanaryCalls = 0;

  async verifyCanaryAuthorization(
    authorizationId: string,
  ): Promise<VerifiedCanaryAuthorization> {
    this.verifyCanaryCalls += 1;
    const authorization =
      this.canaryAuthorizations.get(authorizationId);
    if (authorization === undefined) {
      throw new Error("APPROVAL_REQUIRED");
    }
    return {
      authorization,
      registry_hash: canonicalSha256([
        ...this.canaryAuthorizations.keys(),
      ]),
      verified_at: NOW,
    };
  }

  async confirmCanaryAuthorizationUnchanged(
    _verified: VerifiedCanaryAuthorization,
  ): Promise<void> {
    this.confirmCanaryCalls += 1;
  }

  async verifyPostCanaryApproval(
    approvalId: string,
  ): Promise<VerifiedPostCanaryApproval> {
    this.verifyPostCanaryCalls += 1;
    const approval = this.postCanaryApprovals.get(approvalId);
    if (approval === undefined) {
      throw new Error("APPROVAL_REQUIRED");
    }
    return {
      approval,
      registry_hash: canonicalSha256([
        ...this.postCanaryApprovals.keys(),
      ]),
      verified_at: NOW,
    };
  }

  async confirmPostCanaryApprovalUnchanged(
    _verified: VerifiedPostCanaryApproval,
  ): Promise<void> {
    this.confirmPostCanaryCalls += 1;
  }
}

export async function prepareApprovedCandidate(options: {
  storage: SqliteStorageClient;
  runId: string;
  evaluationKey: string;
  executionIdentity?: G5ExecutionIdentity;
}): Promise<{
  evaluation: Awaited<ReturnType<typeof runG5Evaluation>>;
  latest: CandidateLifecycleResult;
}> {
  await seedLearningCandidate(options.storage);
  const evaluation = await runG5Evaluation({
    storage: options.storage,
    idempotencyKey: options.evaluationKey,
    runId: options.runId,
    ...(options.executionIdentity === undefined
      ? {}
      : { executionIdentity: options.executionIdentity }),
  });
  const lifecycle = new CandidateLifecycle({
    storage: options.storage,
  });
  let expectedState: CandidateState = "proposed";
  let expectedSequence = 0;
  let expectedHash: string | null = null;
  let latest: CandidateLifecycleResult | undefined;
  for (const [index, toState] of (
    [
      "quarantined",
      "evaluating",
      "approved_for_canary",
    ] as const
  ).entries()) {
    latest = await lifecycle.transition({
      schema_version: "1.0.0",
      idempotency_key: `g5-lifecycle-${options.runId}-${index + 1}`,
      principal_id: "user_local",
      scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
      candidate_id: "candidate_storage_1",
      expected_state: expectedState,
      expected_sequence: expectedSequence,
      expected_previous_transition_hash: expectedHash,
      to_state: toState,
      control_epoch: 0,
      actor_id: "learning_evaluator",
      authority_id: null,
      evidence_receipt_ids: [evaluation.receipt.receipt_id],
      reason_code: "G5_EVALUATION_COMPLETE",
      transitioned_at: NOW,
    });
    expectedState = toState;
    expectedSequence = latest.transition.sequence;
    expectedHash = latest.transition.transition_hash;
  }
  if (latest === undefined) {
    throw new Error("approved candidate transition is required");
  }
  return { evaluation, latest };
}

export async function canaryManifest(options: {
  evaluation: Awaited<ReturnType<typeof runG5Evaluation>>;
  stableReleaseId?: string | null;
  controlEpoch?: number;
}) {
  const loader = new G5PartitionLoader({
    fixtureRoot: G5_FIXTURE_ROOT,
    clock: () => NOW,
  });
  const fixtureManifest = await loader.loadManifest();
  const input = {
    schema_version: "1.0.0",
    canary_manifest_id: `manifest_${options.evaluation.identity.run_id}`,
    candidate_id: options.evaluation.identity.candidate_id,
    stable_release_id: options.stableReleaseId ?? null,
    case_ids: fixtureManifest.canary_cases.map(
      (entry) => entry.case_id,
    ),
    case_hashes: fixtureManifest.canary_cases.map(
      (entry) => entry.case_hash,
    ),
    maximum_exposures_per_case: 1,
    maximum_duration_ms: 600_000,
    promote_metric_ids: ["all_cases_pass", "zero_critical_failure"],
    abort_metric_ids: ["critical_failure", "identity_drift"],
    environment_hash:
      options.evaluation.identity.environment_hash,
    configuration_hash:
      options.evaluation.identity.retrieval_configuration_hash,
    runtime_identity_hash:
      options.evaluation.identity.runtime_identity_hash,
    control_epoch: options.controlEpoch ?? 0,
    manifest_hash: HASH_A,
  };
  return CanaryManifestSchema.parse({
    ...input,
    manifest_hash: canonicalSha256Omitting(input, ["manifest_hash"]),
  });
}

export async function canaryInput(options: {
  evaluation: Awaited<ReturnType<typeof runG5Evaluation>>;
  authorizationId?: string;
  stableReleaseId?: string | null;
  controlEpoch?: number;
}) {
  const manifest = await canaryManifest(options);
  return {
    schema_version: "1.0.0",
    idempotency_key: `g5-canary-${options.evaluation.identity.run_id}`,
    principal_id: "user_local",
    scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
    candidate_id: options.evaluation.identity.candidate_id,
    authorization_id:
      options.authorizationId ??
      `authorization_${options.evaluation.identity.run_id}`,
    canary_manifest: manifest,
    started_at: NOW,
  };
}

export async function canaryAuthorization(options: {
  evaluation: Awaited<ReturnType<typeof runG5Evaluation>>;
  input: Awaited<ReturnType<typeof canaryInput>>;
  overrides?: Partial<CanaryAuthorization>;
}): Promise<CanaryAuthorization> {
  const candidate = learningCandidate();
  if (candidate.release_slot === null) {
    throw new Error("release-capable fixture requires a slot");
  }
  const fixtureManifest = await new G5PartitionLoader({
    fixtureRoot: G5_FIXTURE_ROOT,
    clock: () => NOW,
  }).loadManifest();
  const requestHash = canonicalSha256({
    ...options.input,
    scopes: [...options.input.scopes],
  });
  const input = {
    schema_version: "1.0.0",
    authorization_id: options.input.authorization_id,
    principal_id: options.input.principal_id,
    tool: "learning_canary",
    safety_class: "important_mutation",
    scopes: options.input.scopes,
    candidate_id: options.input.candidate_id,
    release_slot_hash: candidate.release_slot.slot_hash,
    base_release_id: null,
    evaluation_receipt_id: options.evaluation.receipt.receipt_id,
    evaluation_receipt_hash: options.evaluation.receipt.receipt_hash,
    canary_manifest_id:
      options.input.canary_manifest.canary_manifest_id,
    canary_manifest_hash:
      options.input.canary_manifest.manifest_hash,
    case_hashes: fixtureManifest.canary_cases.map(
      (entry) => entry.case_hash,
    ),
    maximum_exposures: 3,
    deadline_at: CANARY_DEADLINE,
    control_epoch: options.input.canary_manifest.control_epoch,
    request_hash: requestHash,
    issued_at: CANARY_ISSUED,
    expires_at: CANARY_EXPIRES,
    authorization_hash: HASH_A,
    ...options.overrides,
  };
  return CanaryAuthorizationSchema.parse({
    ...input,
    authorization_hash: canonicalSha256Omitting(input, [
      "authorization_hash",
    ]),
  });
}

export function postCanaryApproval(options: {
  evaluation: Awaited<ReturnType<typeof runG5Evaluation>>;
  canaryReceiptId: string;
  canaryReceiptHash: string;
  approvalId?: string;
  requestHash?: `sha256:${string}`;
}): PostCanaryApproval {
  const candidate = learningCandidate();
  if (candidate.release_slot === null) {
    throw new Error("release-capable fixture requires a slot");
  }
  const input = {
    schema_version: "1.0.0",
    approval_id: options.approvalId ?? "post_canary_release_1",
    principal_id: "user_local",
    action: "release",
    scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
    candidate_id: candidate.candidate_id,
    release_slot_hash: candidate.release_slot.slot_hash,
    base_release_id: null,
    evaluation_receipt_id: options.evaluation.receipt.receipt_id,
    evaluation_receipt_hash: options.evaluation.receipt.receipt_hash,
    canary_receipt_id: options.canaryReceiptId,
    canary_receipt_hash: options.canaryReceiptHash,
    expected_pointer_revision: 0,
    target_release_id: null,
    control_epoch: 0,
    request_hash: options.requestHash ?? HASH_B,
    effect_manifest_hash: canonicalSha256("release-effect"),
    issued_at: CANARY_ISSUED,
    expires_at: CANARY_EXPIRES,
    approval_hash: HASH_A,
  };
  return PostCanaryApprovalSchema.parse({
    ...input,
    approval_hash: canonicalSha256Omitting(input, ["approval_hash"]),
  });
}
