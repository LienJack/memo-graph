import {
  EvalResultSchema,
  EvaluationCommonIdentitySchema,
  G5FixtureManifestSchema,
  canonicalSha256,
  canonicalSha256Omitting,
  type EvaluationArm,
  type CandidateChange,
} from "../../packages/contracts/dist/index.js";
import {
  G5PartitionLoader,
  LearningEvaluationRunner,
  type ArmExecutionRequest,
  type ArmExecutionResult,
  type EvaluationRunResult,
} from "../../packages/learning-lab/dist/index.js";
import type { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import {
  NOW,
  USER_SCOPE,
} from "./examples.ts";
import {
  LEARNING_WORKSPACE_SCOPE,
  learningCandidate,
  learningTrace,
} from "./learning-examples.ts";

export const G5_FIXTURE_ROOT = "fixtures/g5";
export const G5_STATE_HASH = canonicalSha256({
  canonical_memory: "unchanged",
  release_pointer: null,
});

export type G5ExecutionIdentity = {
  implementation_commit: string;
  implementation_tree: string;
  dependency_lock_hash: `sha256:${string}`;
  migration_set_hash: `sha256:${string}`;
  runtime_identity_hash: `sha256:${string}`;
  corpus_hash: `sha256:${string}`;
  scorer_hash: `sha256:${string}`;
  seed: number;
  environment_hash: `sha256:${string}`;
};

export async function seedLearningCandidate(
  storage: SqliteStorageClient,
): Promise<ReturnType<typeof learningCandidate>> {
  const trace = learningTrace();
  const traceCommand = {
    kind: "trace" as const,
    idempotency_key: "g5-seed-trace-001",
    trace,
  };
  await storage.writeLearningLedger({
    ...traceCommand,
    request_hash: canonicalSha256Omitting(traceCommand, ["request_hash"]),
  });
  const candidate = learningCandidate();
  const candidateCommand = {
    kind: "candidate" as const,
    idempotency_key: "g5-seed-candidate-001",
    candidate,
  };
  await storage.writeLearningLedger({
    ...candidateCommand,
    request_hash: canonicalSha256Omitting(candidateCommand, ["request_hash"]),
  });
  return candidate;
}

export async function g5EvaluationIdentity(options?: {
  runId?: string;
  candidateId?: string;
  environmentHash?: `sha256:${string}`;
  baseReleaseId?: string | null;
  currentReleaseId?: string | null;
  executionIdentity?: G5ExecutionIdentity;
}) {
  const loader = new G5PartitionLoader({
    fixtureRoot: G5_FIXTURE_ROOT,
    clock: () => NOW,
  });
  const manifest = await loader.loadManifest();
  const input = {
    schema_version: "1.0.0",
    run_id: options?.runId ?? "run_g5_safe_1",
    candidate_id: options?.candidateId ?? "candidate_storage_1",
    base_release_id: options?.baseReleaseId ?? null,
    current_release_id: options?.currentReleaseId ?? null,
    implementation_commit:
      options?.executionIdentity?.implementation_commit ??
      "a".repeat(40),
    implementation_tree:
      options?.executionIdentity?.implementation_tree ??
      "b".repeat(40),
    dependency_lock_hash:
      options?.executionIdentity?.dependency_lock_hash ??
      canonicalSha256("g5-lock"),
    migration_set_hash:
      options?.executionIdentity?.migration_set_hash ??
      canonicalSha256("g5-migrations"),
    runtime_identity_hash:
      options?.executionIdentity?.runtime_identity_hash ??
      canonicalSha256("node-24-runtime"),
    accepted_g3r_commit: manifest.accepted_baseline.g3r.commit,
    accepted_g4a_commit: manifest.accepted_baseline.graph.commit,
    accepted_g4b_commit: manifest.accepted_baseline.vector.commit,
    retrieval_configuration_hash:
      manifest.accepted_baseline.retrieval_configuration_hash,
    corpus_hash:
      options?.executionIdentity?.corpus_hash ??
      canonicalSha256(manifest.evaluation_cases),
    partition_manifest_hash: manifest.manifest_hash,
    scorer_hash:
      options?.executionIdentity?.scorer_hash ??
      canonicalSha256("g5-scorer-v1"),
    thresholds_hash: manifest.thresholds_hash,
    seed: options?.executionIdentity?.seed ?? 7,
    environment_hash:
      options?.executionIdentity?.environment_hash ??
      options?.environmentHash ??
      canonicalSha256("g5-environment"),
    common_identity_hash: canonicalSha256("placeholder"),
  };
  return EvaluationCommonIdentitySchema.parse({
    ...input,
    common_identity_hash: canonicalSha256Omitting(input, [
      "common_identity_hash",
    ]),
  });
}

export function safeArmExecution(
  request: ArmExecutionRequest,
): ArmExecutionResult {
  const candidate = request.arm === "candidate";
  return {
    common_input_hash: request.common_input_hash,
    initial_state_hash: request.initial_state_hash,
    final_state_hash: request.initial_state_hash,
    passed_required_task_units: candidate
      ? request.case_body.required_task_unit_ids
      : [],
    failed_required_task_units: candidate
      ? []
      : request.case_body.required_task_unit_ids,
    error_codes: candidate ? [] : ["TASK_UNIT_MISSING"],
    negative_transfer_units: [],
    context: {
      token_budget: 1_800,
      token_used: candidate ? 100 : 120,
      pollution_count: 0,
      selected_item_ids: candidate
        ? request.oracle.expected_included_ids
        : [],
    },
    latency_ms: candidate ? 10 : 12,
    side_effect_ids: [],
    violation_codes: [],
    critical_failure_codes: [],
  };
}

export function harmfulTransferExecution(
  request: ArmExecutionRequest,
): ArmExecutionResult {
  if (
    request.partition === "transfer" &&
    request.case_body.case_id === "g5_transfer_negative"
  ) {
    const candidate = request.arm === "candidate";
    return {
      ...safeArmExecution(request),
      passed_required_task_units: candidate
        ? []
        : request.case_body.required_task_unit_ids,
      failed_required_task_units: candidate
        ? request.case_body.required_task_unit_ids
        : [],
      error_codes: candidate ? ["REQUIRED_LANE_REMOVED"] : [],
      negative_transfer_units: candidate
        ? request.case_body.required_task_unit_ids
        : [],
    };
  }
  if (request.partition === "transfer") {
    return {
      ...safeArmExecution(request),
      passed_required_task_units:
        request.case_body.required_task_unit_ids,
      failed_required_task_units: [],
      error_codes: [],
    };
  }
  return safeArmExecution(request);
}

export async function runG5Evaluation(options: {
  storage: SqliteStorageClient;
  idempotencyKey: string;
  runId: string;
  candidate?: CandidateChange;
  executeArm?: (
    request: ArmExecutionRequest,
  ) => ArmExecutionResult | Promise<ArmExecutionResult>;
  loader?: ConstructorParameters<
    typeof LearningEvaluationRunner
  >[0]["partitions"];
  stateProbe?: () => string | Promise<string>;
  executionIdentity?: G5ExecutionIdentity;
}): Promise<EvaluationRunResult> {
  const loader =
    options.loader ??
    new G5PartitionLoader({
      fixtureRoot: G5_FIXTURE_ROOT,
      clock: () => NOW,
    });
  const manifest = G5FixtureManifestSchema.parse(
    await loader.loadManifest(),
  );
  const candidate = options.candidate ?? learningCandidate();
  const runner = new LearningEvaluationRunner({
    storage: options.storage,
    partitions: loader,
    executeArm: options.executeArm ?? safeArmExecution,
    stateProbe:
      options.stateProbe ??
      (() =>
        options.executionIdentity?.environment_hash ??
        G5_STATE_HASH),
  });
  return runner.run({
    schema_version: "1.0.0",
    idempotency_key: options.idempotencyKey,
    principal_id: "user_local",
    scopes: [USER_SCOPE, LEARNING_WORKSPACE_SCOPE],
    identity: await g5EvaluationIdentity({
      runId: options.runId,
      candidateId: candidate.candidate_id,
      baseReleaseId: candidate.active_base_release_id,
      currentReleaseId: candidate.active_base_release_id,
      ...(options.executionIdentity === undefined
        ? {}
        : { executionIdentity: options.executionIdentity }),
    }),
    candidate_hash: candidate.candidate_hash,
    fixture_manifest_hash: manifest.manifest_hash,
    thresholds_hash: manifest.thresholds_hash,
    started_at: NOW,
  });
}

export function resultFor(
  result: EvaluationRunResult,
  caseId: string,
  arm: EvaluationArm,
) {
  const entry = result.result_sets
    .find((set) => set.case_id === caseId)
    ?.results.find((item) => item.arm === arm);
  if (entry === undefined) {
    throw new Error(`missing ${caseId}/${arm} evaluation result`);
  }
  return EvalResultSchema.parse(entry);
}
