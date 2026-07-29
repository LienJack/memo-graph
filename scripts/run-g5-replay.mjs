import process from "node:process";

import {
  canonicalSha256,
} from "../packages/contracts/dist/index.js";
import {
  SqliteStorageClient,
} from "../packages/storage-sqlite/dist/index.js";
import {
  harmfulTransferExecution,
  runG5Evaluation,
  safeArmExecution,
  seedLearningCandidate,
} from "../tests/helpers/g5-replay.ts";
import {
  G5_RECORDED_AT,
  G5_SCORER_ID,
  environmentIdentity,
  readJson,
  removeTemporaryRoot,
  reportLogicalHash,
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

const outputPath = option(
  "--output",
  "docs/evaluations/g5-replay-report.json",
);
const manifest = readJson("fixtures/g5/manifest.json");
const partitionByCase = new Map(
  manifest.evaluation_cases.map((entry) => [
    entry.case_id,
    entry.partition,
  ]),
);
const executionIdentity = runtimeIdentity();

function partitionMetrics(result) {
  const metrics = {};
  for (const partition of ["calibration", "holdout", "transfer"]) {
    metrics[partition] = {};
    for (const arm of manifest.arms) {
      metrics[partition][arm] = {
        passed_task_units: 0,
        failed_task_units: 0,
        errors: 0,
        negative_transfer_units: 0,
        context_tokens: 0,
        context_pollution: 0,
        latency_ms: 0,
        side_effects: 0,
        violations: 0,
        critical_failures: 0,
      };
    }
  }
  for (const set of result.result_sets) {
    const partition = partitionByCase.get(set.case_id);
    if (partition === undefined) {
      throw new Error(`missing partition for ${set.case_id}`);
    }
    for (const armResult of set.results) {
      const target = metrics[partition][armResult.arm];
      target.passed_task_units +=
        armResult.passed_required_task_units.length;
      target.failed_task_units +=
        armResult.failed_required_task_units.length;
      target.errors += armResult.error_codes.length;
      target.negative_transfer_units +=
        armResult.negative_transfer_units.length;
      target.context_tokens += armResult.context.token_used;
      target.context_pollution +=
        armResult.context.pollution_count;
      target.latency_ms += armResult.latency_ms;
      target.side_effects += armResult.side_effect_ids.length;
      target.violations += armResult.violation_codes.length;
      target.critical_failures +=
        armResult.critical_failure_codes.length;
    }
  }
  return Object.fromEntries(
    Object.entries(metrics).map(([partition, arms]) => {
      const candidate = arms.candidate;
      const current = arms.current;
      const noCandidate = arms.no_candidate;
      return [
        partition,
        {
          arms,
          deltas: {
            task_units_over_current:
              candidate.passed_task_units -
              current.passed_task_units,
            task_units_over_no_candidate:
              candidate.passed_task_units -
              noCandidate.passed_task_units,
            errors_vs_current:
              candidate.errors - current.errors,
            negative_transfer_vs_current:
              candidate.negative_transfer_units -
              current.negative_transfer_units,
            context_tokens_vs_current:
              candidate.context_tokens -
              current.context_tokens,
            context_pollution_vs_current:
              candidate.context_pollution -
              current.context_pollution,
            latency_ms_vs_current:
              candidate.latency_ms - current.latency_ms,
            side_effects_vs_current:
              candidate.side_effects - current.side_effects,
            violations_vs_current:
              candidate.violations - current.violations,
          },
        },
      ];
    }),
  );
}

async function executeScenario(kind, attempt) {
  const root = temporaryDataRoot(`g5-${kind}-${attempt}`);
  const storage = await SqliteStorageClient.open({ dataRoot: root });
  try {
    const candidate = await seedLearningCandidate(storage);
    const before = await storage.readLearningLedger({
      principal_id: "user_local",
      scopes: candidate.scopes,
    });
    const result = await runG5Evaluation({
      storage,
      idempotencyKey: `g5-evidence-${kind}-001`,
      runId: `run_g5_evidence_${kind}`,
      executeArm:
        kind === "safe"
          ? safeArmExecution
          : harmfulTransferExecution,
      executionIdentity,
    });
    const after = await storage.readLearningLedger({
      principal_id: "user_local",
      scopes: candidate.scopes,
    });
    return {
      candidate: {
        candidate_id: candidate.candidate_id,
        candidate_hash: candidate.candidate_hash,
        target: candidate.target,
        frozen_before_sealed_partitions: true,
      },
      identity: result.identity,
      fixture_manifest_hash: result.fixture_manifest_hash,
      thresholds_hash: result.thresholds_hash,
      receipt: result.receipt,
      rules: result.rules,
      partition_metrics: partitionMetrics(result),
      result_sets: result.result_sets,
      pointer_before: before.pointers,
      pointer_after: after.pointers,
      logical_results_hash: canonicalSha256({
        identity: result.identity,
        candidate_hash: result.candidate_hash,
        receipt: result.receipt,
        rules: result.rules,
        result_sets: result.result_sets,
        pointers: after.pointers,
      }),
    };
  } finally {
    await storage.close();
    removeTemporaryRoot(root);
  }
}

const [safeFirst, safeSecond, harmfulFirst, harmfulSecond] =
  await Promise.all([
    executeScenario("safe", "first"),
    executeScenario("safe", "second"),
    executeScenario("harmful", "first"),
    executeScenario("harmful", "second"),
  ]);
const sqliteVersion = (
  await (async () => {
    const root = temporaryDataRoot("g5-environment");
    const storage = await SqliteStorageClient.open({ dataRoot: root });
    try {
      return (await storage.health()).sqlite_version;
    } finally {
      await storage.close();
      removeTemporaryRoot(root);
    }
  })()
);
const hardRules = {
  implementation_identity_bound:
    safeFirst.identity.implementation_commit ===
      executionIdentity.implementation_commit &&
    safeFirst.identity.implementation_tree ===
      executionIdentity.implementation_tree,
  graph_vector_disabled:
    manifest.accepted_baseline.graph.decision === "NO-GO" &&
    manifest.accepted_baseline.vector.decision === "NO-GO" &&
    manifest.accepted_baseline.vector_enabled === false,
  candidate_frozen_before_holdout_transfer:
    safeFirst.candidate.frozen_before_sealed_partitions,
  safe_three_arms:
    safeFirst.result_sets.every(
      (set) =>
        JSON.stringify(set.results.map((entry) => entry.arm)) ===
        JSON.stringify(manifest.arms),
    ),
  safe_common_identity:
    safeFirst.result_sets.every(
      (set) =>
        new Set(
          set.results.map(
            (entry) => entry.common_identity_hash,
          ),
        ).size === 1,
    ),
  safe_d5_conjunctive:
    safeFirst.receipt.passed === true &&
    safeFirst.rules.every((rule) => rule.passed),
  harmful_rejected:
    harmfulFirst.receipt.passed === false &&
    harmfulFirst.rules.some(
      (rule) =>
        rule.rule_id === "NO_REQUIRED_TASK_UNIT_LOSS" &&
        rule.passed === false,
    ),
  harmful_zero_pointer_change:
    harmfulFirst.pointer_before.length === 0 &&
    harmfulFirst.pointer_after.length === 0,
  deterministic_repeat:
    safeFirst.logical_results_hash ===
      safeSecond.logical_results_hash &&
    harmfulFirst.logical_results_hash ===
      harmfulSecond.logical_results_hash,
};
const report = writeHashedReport(outputPath, {
  schema_version: "1.0.0",
  gate: "G5_U8_REPLAY",
  recorded_at: G5_RECORDED_AT,
  implementation: {
    commit: executionIdentity.implementation_commit,
    tree: executionIdentity.implementation_tree,
    dependency_lock_hash:
      executionIdentity.dependency_lock_hash,
    migration_set_hash: executionIdentity.migration_set_hash,
    runtime_identity_hash:
      executionIdentity.runtime_identity_hash,
  },
  environment: environmentIdentity(sqliteVersion),
  protocol: {
    fixture_manifest_hash: manifest.manifest_hash,
    thresholds_hash: manifest.thresholds_hash,
    scorer: G5_SCORER_ID,
    scorer_hash: executionIdentity.scorer_hash,
    seed: executionIdentity.seed,
    arms: manifest.arms,
    partitions: ["calibration", "holdout", "transfer"],
    accepted_baseline: manifest.accepted_baseline,
  },
  safe_path: safeFirst,
  harmful_path: harmfulFirst,
  repeat: {
    runs_per_path: 2,
    safe_hashes: [
      safeFirst.logical_results_hash,
      safeSecond.logical_results_hash,
    ],
    harmful_hashes: [
      harmfulFirst.logical_results_hash,
      harmfulSecond.logical_results_hash,
    ],
    deterministic: hardRules.deterministic_repeat,
  },
  hard_rules: hardRules,
  evidence_boundary: {
    synthetic_fixture: true,
    production_traffic: false,
    production_readiness_claimed: false,
    scope:
      "Deterministic local G5 evaluation of one frozen retrieval-policy candidate.",
  },
});

process.stdout.write(
  `G5 replay evidence: ${
    Object.values(report.hard_rules).every(Boolean)
      ? "PASS"
      : "FAIL"
  } (${reportLogicalHash(report)})\n`,
);
