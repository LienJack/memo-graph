import process from "node:process";

import {
  MonitorReceiptSchema,
  MonitorResultSchema,
  canonicalSha256,
  canonicalSha256Omitting,
  sealReceipt,
} from "../packages/contracts/dist/index.js";
import {
  G5PartitionLoader,
  LearningCanaryRunner,
  LearningReleaseManager,
} from "../packages/learning-lab/dist/index.js";
import {
  MemoryRuntime,
} from "../packages/memory-kernel/dist/index.js";
import {
  SqliteStorageClient,
} from "../packages/storage-sqlite/dist/index.js";
import {
  TestLearningAuthorityRegistry,
  canaryAuthorization,
  canaryInput,
  postCanaryApproval,
  prepareApprovedCandidate,
} from "../tests/helpers/g5-canary.ts";
import {
  BASE_LANE_POLICY,
  RELEASE_CLOCK,
  RELEASE_SCOPES,
  TestReleaseApprovalRegistry,
  authorizeRelease,
  authorizeRollback,
  preparePassedCanary,
  releaseRequest,
  rollbackRequest,
} from "../tests/helpers/g5-release.ts";
import {
  G5_FIXTURE_ROOT,
} from "../tests/helpers/g5-replay.ts";
import {
  verifiedLearningApproval,
} from "../tests/helpers/learning-examples.ts";
import {
  G5_RECORDED_AT,
  environmentIdentity,
  readJson,
  removeTemporaryRoot,
  runtimeIdentity,
  temporaryDataRoot,
  writeHashedReport,
} from "./g5-evidence-common.mjs";

const args = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) {
    return fallback;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`missing required ${name} value`);
  }
  return value;
}

function errorCode(error) {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : error instanceof Error
      ? error.message
      : "UNKNOWN";
}

function controlEnvelope(tool, suffix, approvalId) {
  return {
    schema_version: "1.0.0",
    request_id: `request_g5_${suffix}`,
    tool,
    actor_claim: {
      principal_id: "user_local",
      authority: "user_stated",
    },
    scopes: RELEASE_SCOPES,
    purpose: "govern the G5 evidence learning loop",
    reason: "freeze or resume exact evaluated learning work",
    requested_at: RELEASE_CLOCK,
    safety_class: "important_mutation",
    idempotency_key: `g5-${suffix}-001`,
    expected_revision_id: null,
    approval_id: approvalId,
    dry_run: false,
  };
}

function installControlApproval(approvals, tool, request) {
  const verified = verifiedLearningApproval({
    tool,
    requestHash: canonicalSha256(request),
  });
  approvals.grants.set(
    verified.approval.grant.approval_id,
    verified.approval.grant,
  );
}

async function precomputedApprovalScenario(executionIdentity) {
  const root = temporaryDataRoot("g5-precomputed-approval");
  const storage = await SqliteStorageClient.open({ dataRoot: root });
  try {
    const approved = await prepareApprovedCandidate({
      storage,
      runId: "run_g5_precomputed_approval",
      evaluationKey: "g5-precomputed-evaluation-001",
      executionIdentity,
    });
    const request = releaseRequest({ suffix: "precomputed" });
    const authority = new TestLearningAuthorityRegistry();
    const approval = postCanaryApproval({
      evaluation: approved.evaluation,
      canaryReceiptId: "receipt_precomputed_canary",
      canaryReceiptHash: canonicalSha256(
        "precomputed-canary-does-not-exist",
      ),
      approvalId: request.approval_id,
      requestHash: canonicalSha256(request),
    });
    authority.postCanaryApprovals.set(
      approval.approval_id,
      approval,
    );
    const approvals = new TestReleaseApprovalRegistry();
    approvals.register(approval);
    let rejectedWith = null;
    try {
      await new LearningReleaseManager({
        storage,
        authorityRegistry: authority,
        approvalRegistry: approvals,
        clock: () => RELEASE_CLOCK,
      }).apply(request);
    } catch (error) {
      rejectedWith = errorCode(error);
    }
    const ledger = await storage.readLearningLedger({
      principal_id: request.principal_id,
      scopes: request.scopes,
    });
    return {
      rejected_with: rejectedWith,
      release_count: ledger.releases.length,
      pointer_count: ledger.pointers.length,
      post_canary_approval_id: approval.approval_id,
      referenced_canary_receipt_id:
        approval.canary_receipt_id,
    };
  } finally {
    await storage.close();
    removeTemporaryRoot(root);
  }
}

async function forcedAbortScenario(executionIdentity) {
  const root = temporaryDataRoot("g5-forced-abort");
  const storage = await SqliteStorageClient.open({ dataRoot: root });
  try {
    const prepared = await prepareApprovedCandidate({
      storage,
      runId: "run_g5_forced_abort",
      evaluationKey: "g5-forced-abort-evaluation-001",
      executionIdentity,
    });
    const input = await canaryInput({
      evaluation: prepared.evaluation,
      authorizationId: "authorization_g5_forced_abort",
    });
    const authority = new TestLearningAuthorityRegistry();
    authority.canaryAuthorizations.set(
      input.authorization_id,
      await canaryAuthorization({
        evaluation: prepared.evaluation,
        input,
      }),
    );
    let clockCalls = 0;
    const result = await new LearningCanaryRunner({
      storage,
      partitions: new G5PartitionLoader({
        fixtureRoot: G5_FIXTURE_ROOT,
        clock: () => RELEASE_CLOCK,
      }),
      authorityRegistry: authority,
      executeCase: (request) => ({
        case_id: request.case_body.case_id,
        stable_comparator_release_id:
          request.stable_release_id,
        passed: true,
        failure_codes: [],
        initial_state_hash: request.initial_state_hash,
        final_state_hash: request.initial_state_hash,
      }),
      stateProbe: () =>
        prepared.evaluation.identity.environment_hash,
      clock: () => {
        clockCalls += 1;
        return clockCalls > 1
          ? "2026-07-28T12:10:01.000Z"
          : RELEASE_CLOCK;
      },
    }).run(input);
    const ledger = await storage.readLearningLedger({
      principal_id: input.principal_id,
      scopes: input.scopes,
    });
    return {
      run: result.run,
      receipt: result.receipt,
      pointer_count: ledger.pointers.length,
    };
  } finally {
    await storage.close();
    removeTemporaryRoot(root);
  }
}

async function persistMonitor(options) {
  const input = {
    schema_version: "1.0.0",
    monitor_id: `monitor_g5_${options.suffix}`,
    release_id: options.released.release.release_id,
    pointer_revision:
      options.released.pointer.pointer_revision,
    canary_receipt_id:
      options.prepared.canary.receipt.receipt_id,
    replayed_case_ids: options.replayedCaseIds,
    passed: options.passed,
    failure_codes: options.failureCodes,
    rollback_required: options.rollbackRequired,
    monitored_at: options.monitoredAt,
    monitor_hash: canonicalSha256("placeholder"),
  };
  const monitor = MonitorResultSchema.parse({
    ...input,
    monitor_hash: canonicalSha256Omitting(input, [
      "monitor_hash",
    ]),
  });
  const receipt = MonitorReceiptSchema.parse(
    sealReceipt({
      schema_version: "1.0.0",
      receipt_id: `receipt_monitor_g5_${options.suffix}`,
      created_at: monitor.monitored_at,
      state: "durable",
      request_hash: canonicalSha256({
        monitor_id: monitor.monitor_id,
        monitor_hash: monitor.monitor_hash,
      }),
      kind: "learning_monitor",
      release_id: monitor.release_id,
      pointer_revision: monitor.pointer_revision,
      canary_receipt_id: monitor.canary_receipt_id,
      monitor_contract_hash:
        options.released.release.monitor_contract_hash,
      replayed_case_ids: monitor.replayed_case_ids,
      passed: monitor.passed,
      failure_codes: monitor.failure_codes,
      rollback_required: monitor.rollback_required,
    }),
  );
  const command = {
    kind: "monitor",
    idempotency_key: `g5-monitor-${options.suffix}-001`,
    principal_id: options.released.request.principal_id,
    scopes: options.released.request.scopes,
    monitor,
    receipt,
  };
  await options.storage.writeLearningLedger({
    ...command,
    request_hash: canonicalSha256Omitting(command, [
      "request_hash",
    ]),
  });
  return { monitor, receipt };
}

const outputPath = option(
  "--output",
  "docs/evaluations/g5-canary-report.json",
);
const executionIdentity = runtimeIdentity();
const fixtureManifest = readJson("fixtures/g5/manifest.json");
const root = temporaryDataRoot("g5-canary-evidence");
const storage = await SqliteStorageClient.open({ dataRoot: root });

try {
  const health = await storage.health();
  const loader = new G5PartitionLoader({
    fixtureRoot: G5_FIXTURE_ROOT,
    clock: () => RELEASE_CLOCK,
  });
  let earlyAccessRejection = null;
  try {
    await loader.loadCanaryCases({
      candidate_state: "evaluating",
    });
  } catch (error) {
    earlyAccessRejection = errorCode(error);
  }

  const prepared = await preparePassedCanary({
    storage,
    suffix: "evidence",
    executionIdentity,
  });
  const approvals = new TestReleaseApprovalRegistry();
  const release = releaseRequest({ suffix: "evidence" });
  const releaseApproval = authorizeRelease({
    request: release,
    prepared,
    approvals,
  });
  const manager = new LearningReleaseManager({
    storage,
    authorityRegistry: prepared.authority,
    approvalRegistry: approvals,
    clock: () => RELEASE_CLOCK,
  });
  const released = await manager.apply(release);
  const releaseReplay = await manager.apply(release);

  const monitorCases = await loader.loadCanaryCases({
    candidate_state: "released",
  });
  const replayedCaseIds = [];
  const activePointerObservations = [];
  for (const entry of monitorCases) {
    const ledger = await storage.readLearningLedger({
      principal_id: release.principal_id,
      scopes: release.scopes,
      release_slot_hash:
        prepared.candidate.release_slot?.slot_hash,
    });
    replayedCaseIds.push(entry.case_body.case_id);
    activePointerObservations.push({
      case_id: entry.case_body.case_id,
      active_release_id:
        ledger.pointers[0]?.active_release_id ?? null,
      pointer_revision:
        ledger.pointers[0]?.pointer_revision ?? 0,
      passed: true,
    });
  }
  const successMonitor = await persistMonitor({
    storage,
    suffix: "success",
    prepared,
    released,
    replayedCaseIds,
    passed: true,
    failureCodes: [],
    rollbackRequired: false,
    monitoredAt: "2026-07-28T12:05:20.000Z",
  });
  const breachMonitor = await persistMonitor({
    storage,
    suffix: "breach",
    prepared,
    released,
    replayedCaseIds,
    passed: false,
    failureCodes: ["ACTIVE_POINTER_REPLAY_MISMATCH"],
    rollbackRequired: true,
    monitoredAt: "2026-07-28T12:05:30.000Z",
  });

  const runtime = new MemoryRuntime({
    storage,
    approvalRegistry: approvals,
    learningAuthorityRegistry: prepared.authority,
    clock: () => RELEASE_CLOCK,
    policy: {
      principal: {
        principal_id: "user_local",
        allowed_scopes: RELEASE_SCOPES,
        allowed_authorities: ["user_stated"],
        destructive_tools_enabled: false,
      },
      lane_policy: BASE_LANE_POLICY,
    },
  });
  const pauseFrontier =
    (await runtime.learningInspection()).action_frontier;
  const pauseRequest = {
    envelope: controlEnvelope(
      "learning_pause",
      "pause",
      "approval_learning_pause_storage_1",
    ),
    expected_control_epoch:
      pauseFrontier.expected_control_epoch,
    expected_release_revision:
      pauseFrontier.expected_release_revision,
    expected_frontier_hash:
      pauseFrontier.expected_frontier_hash,
    runtime_identity_hash:
      pauseFrontier.runtime_identity_hash,
    configuration_hash: pauseFrontier.configuration_hash,
    corpus_hash: pauseFrontier.corpus_hash,
  };
  installControlApproval(approvals, "learning_pause", pauseRequest);
  const paused = await runtime.learningPause(pauseRequest);
  const ordinaryWhilePaused = await runtime.memorySearch({
    envelope: {
      schema_version: "1.0.0",
      request_id: "request_g5_search_while_paused",
      tool: "memory_search",
      actor_claim: {
        principal_id: "user_local",
        authority: "user_stated",
      },
      scopes: RELEASE_SCOPES,
      purpose: "prove ordinary memory runtime continuity",
      reason: "learning pause must not degrade explicit memory reads",
      requested_at: RELEASE_CLOCK,
      safety_class: "read_only",
    },
    query: "governed memory runtime continuity",
    limit: 5,
    include_sensitive: false,
  });

  const rollback = rollbackRequest({
    suffix: "evidence",
    released,
    monitorReceiptId: breachMonitor.receipt.receipt_id,
  });
  authorizeRollback({
    request: rollback,
    prepared,
    released,
    approvals,
    controlEpoch: 1,
  });
  const rolledBack = await manager.apply(rollback);
  const releaseReplayAfterRollback = await manager.apply(release);
  const afterReplayLedger = await storage.readLearningLedger({
    principal_id: release.principal_id,
    scopes: release.scopes,
    release_slot_hash:
      prepared.candidate.release_slot?.slot_hash,
  });

  const resumeFrontier =
    (await runtime.learningInspection()).action_frontier;
  const resumeRequest = {
    envelope: controlEnvelope(
      "learning_resume",
      "resume",
      "approval_learning_resume_storage_1",
    ),
    expected_control_epoch:
      resumeFrontier.expected_control_epoch,
    expected_release_revision:
      resumeFrontier.expected_release_revision,
    expected_frontier_hash:
      resumeFrontier.expected_frontier_hash,
    runtime_identity_hash:
      resumeFrontier.runtime_identity_hash,
    configuration_hash: resumeFrontier.configuration_hash,
    corpus_hash: resumeFrontier.corpus_hash,
    abandon_in_flight: true,
  };
  installControlApproval(
    approvals,
    "learning_resume",
    resumeRequest,
  );
  const resumed = await runtime.learningResume(resumeRequest);
  const finalLedger = await storage.readLearningLedger({
    principal_id: release.principal_id,
    scopes: release.scopes,
    release_slot_hash:
      prepared.candidate.release_slot?.slot_hash,
  });

  const [precomputed, forcedAbort] = await Promise.all([
    precomputedApprovalScenario(executionIdentity),
    forcedAbortScenario(executionIdentity),
  ]);
  const uniqueReplayedCases = new Set(replayedCaseIds);
  const hardRules = {
    implementation_identity_bound:
      prepared.evaluation.identity.implementation_commit ===
        executionIdentity.implementation_commit &&
      prepared.evaluation.identity.implementation_tree ===
        executionIdentity.implementation_tree,
    canary_hidden_before_approval:
      earlyAccessRejection === "CANARY_ACCESS_DENIED",
    precomputed_post_canary_approval_rejected:
      precomputed.rejected_with !== null &&
      precomputed.release_count === 0 &&
      precomputed.pointer_count === 0,
    separate_authority_chains:
      prepared.canary.run.authorization_id !==
        releaseApproval.approval_id &&
      prepared.canary.receipt.receipt_id ===
        releaseApproval.canary_receipt_id,
    exact_single_consumption:
      prepared.authority.verifyCanaryCalls === 1 &&
      prepared.authority.verifyPostCanaryCalls === 2 &&
      approvals.verifyCalls === 4,
    bounded_canary_success:
      prepared.canary.run.status === "passed" &&
      prepared.canary.run.exposure_count === 3 &&
      prepared.canary.receipt.exposures === 3,
    forced_abort_terminal:
      forcedAbort.run.status === "aborted" &&
      forcedAbort.receipt.passed === false &&
      forcedAbort.pointer_count === 0,
    exact_monitor_replay:
      replayedCaseIds.length === 3 &&
      uniqueReplayedCases.size === 3 &&
      fixtureManifest.canary_cases.every((entry) =>
        uniqueReplayedCases.has(entry.case_id)
      ) &&
      activePointerObservations.every(
        (entry) =>
          entry.active_release_id ===
            released.release.release_id &&
          entry.pointer_revision ===
            released.pointer.pointer_revision,
      ),
    breach_blocks_until_rollback:
      breachMonitor.monitor.rollback_required === true &&
      rolledBack.pointer.active_release_id === null,
    pause_resume_runtime_continuity:
      paused.status === "OK" &&
      ordinaryWhilePaused.status !== "FAILED" &&
      resumed.status === "OK",
    no_resurrection:
      releaseReplayAfterRollback.replayed === true &&
      afterReplayLedger.pointers[0]?.active_release_id === null &&
      finalLedger.pointers[0]?.active_release_id === null,
    release_and_rollback_exact:
      released.pointer.pointer_revision === 1 &&
      rolledBack.pointer.pointer_revision === 2 &&
      rolledBack.release.previous_release_id ===
        released.release.release_id,
  };
  const report = writeHashedReport(outputPath, {
    schema_version: "1.0.0",
    gate: "G5_U8_CANARY",
    recorded_at: G5_RECORDED_AT,
    implementation: {
      commit: executionIdentity.implementation_commit,
      tree: executionIdentity.implementation_tree,
      dependency_lock_hash:
        executionIdentity.dependency_lock_hash,
      migration_set_hash:
        executionIdentity.migration_set_hash,
    },
    environment: environmentIdentity(health.sqlite_version),
    authority: {
      canary_authorization:
        prepared.authority.canaryAuthorizations.get(
          prepared.canary.run.authorization_id,
        ),
      post_canary_release_approval: releaseApproval,
      verification_counts: {
        canary:
          prepared.authority.verifyCanaryCalls,
        post_canary:
          prepared.authority.verifyPostCanaryCalls,
        mutation_approval: approvals.verifyCalls,
      },
      precomputed_rejection: precomputed,
    },
    canary: {
      run: prepared.canary.run,
      receipt: prepared.canary.receipt,
      forced_abort: forcedAbort,
      early_access_rejection: earlyAccessRejection,
    },
    release: {
      result: released,
      replayed: releaseReplay.replayed,
    },
    monitoring: {
      active_pointer_replay: activePointerObservations,
      success: successMonitor,
      breach: breachMonitor,
    },
    controls: {
      pause: paused,
      ordinary_runtime_while_paused: {
        status: ordinaryWhilePaused.status,
        receipt_id: ordinaryWhilePaused.receipt_id,
      },
      resume: resumed,
    },
    rollback: {
      result: rolledBack,
      release_replay_after_rollback:
        releaseReplayAfterRollback,
      final_pointer: finalLedger.pointers[0] ?? null,
    },
    hard_rules: hardRules,
    evidence_boundary: {
      synthetic_canary: true,
      production_traffic: false,
      production_readiness_claimed: false,
      graph_enabled: false,
      vector_enabled: false,
    },
  });
  process.stdout.write(
    `G5 canary evidence: ${
      Object.values(report.hard_rules).every(Boolean)
        ? "PASS"
        : "FAIL"
    }\n`,
  );
} finally {
  await storage.close();
  removeTemporaryRoot(root);
}
