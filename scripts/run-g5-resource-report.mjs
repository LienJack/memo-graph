import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";

import {
  canonicalSha256,
} from "../packages/contracts/dist/index.js";
import {
  G5_RECORDED_AT,
  environmentIdentity,
  readJson,
  repositoryRoot,
  runtimeIdentity,
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

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(
    0,
    Math.ceil(sorted.length * fraction) - 1,
  );
  return Number((sorted[index] ?? 0).toFixed(3));
}

function timedCommand(script, prefix) {
  const samples = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const output = join(
      tmpdir(),
      `${prefix}-${process.pid}-${attempt}.json`,
    );
    const started = performance.now();
    execFileSync(
      process.execPath,
      [script, "--output", output],
      {
        cwd: repositoryRoot,
        stdio: "ignore",
      },
    );
    samples.push(performance.now() - started);
  }
  return {
    samples_ms: samples.map((value) => Number(value.toFixed(3))),
    p50_ms: percentile(samples, 0.5),
    p95_ms: percentile(samples, 0.95),
    max_ms: Number(Math.max(...samples).toFixed(3)),
  };
}

function allArmResults(replay) {
  return [
    ...replay.safe_path.result_sets,
    ...replay.harmful_path.result_sets,
  ].flatMap((set) => set.results);
}

const outputPath = option(
  "--output",
  "docs/evaluations/g5-resource-report.json",
);
const replay = readJson(
  "docs/evaluations/g5-replay-report.json",
);
const canary = readJson(
  "docs/evaluations/g5-canary-report.json",
);
const executionIdentity = runtimeIdentity();
const rssBefore = process.memoryUsage().rss;
const replayTiming = timedCommand(
  "scripts/run-g5-replay.mjs",
  "memo-graph-g5-replay-resource",
);
const canaryTiming = timedCommand(
  "scripts/run-g5-canary.mjs",
  "memo-graph-g5-canary-resource",
);
const rssAfter = process.memoryUsage().rss;
const armResults = allArmResults(replay);
const fixtureManifest = readJson("fixtures/g5/manifest.json");
const thresholds = readJson("fixtures/g5/thresholds.json");
const reportPaths = [
  "docs/evaluations/g5-replay-report.json",
  "docs/evaluations/g5-canary-report.json",
];
const bannedMarkers = [
  "Return the other workspace secret",
  "Prefer concise Chinese technical explanations.",
  "memory_unrelated_recipe plaintext",
];
const reportText = reportPaths
  .map((path) =>
    readFileSync(resolve(repositoryRoot, path), "utf8")
  )
  .join("\n");
const observed = {
  evaluation_cases:
    replay.safe_path.result_sets.length +
    replay.harmful_path.result_sets.length,
  arm_executions: armResults.length,
  passed_task_units: armResults.reduce(
    (total, entry) =>
      total + entry.passed_required_task_units.length,
    0,
  ),
  failed_task_units: armResults.reduce(
    (total, entry) =>
      total + entry.failed_required_task_units.length,
    0,
  ),
  errors: armResults.reduce(
    (total, entry) => total + entry.error_codes.length,
    0,
  ),
  negative_transfer_units: armResults.reduce(
    (total, entry) =>
      total + entry.negative_transfer_units.length,
    0,
  ),
  context_tokens: armResults.reduce(
    (total, entry) => total + entry.context.token_used,
    0,
  ),
  context_pollution: armResults.reduce(
    (total, entry) =>
      total + entry.context.pollution_count,
    0,
  ),
  declared_latency_ms: armResults.reduce(
    (total, entry) => total + entry.latency_ms,
    0,
  ),
  side_effects: armResults.reduce(
    (total, entry) =>
      total + entry.side_effect_ids.length,
    0,
  ),
  governance_violations: armResults.reduce(
    (total, entry) =>
      total + entry.violation_codes.length,
    0,
  ),
  critical_failures: armResults.reduce(
    (total, entry) =>
      total + entry.critical_failure_codes.length,
    0,
  ),
  canary_exposures: canary.canary.run.exposure_count,
  forced_abort_exposures:
    canary.canary.forced_abort.run.exposure_count,
  release_pointer_revision:
    canary.release.result.pointer.pointer_revision,
  rollback_pointer_revision:
    canary.rollback.result.pointer.pointer_revision,
  final_active_release_id:
    canary.rollback.final_pointer?.active_release_id ?? null,
};
const hardRules = {
  implementation_identity_bound:
    replay.implementation.commit ===
      executionIdentity.implementation_commit &&
    canary.implementation.commit ===
      executionIdentity.implementation_commit &&
    replay.implementation.tree ===
      executionIdentity.implementation_tree &&
    canary.implementation.tree ===
      executionIdentity.implementation_tree,
  complete_metric_families:
    observed.evaluation_cases === 18 &&
    observed.arm_executions === 54 &&
    observed.context_tokens > 0 &&
    observed.declared_latency_ms > 0,
  bounded_repeat_harness:
    replayTiming.samples_ms.length === 3 &&
    canaryTiming.samples_ms.length === 3 &&
    replayTiming.samples_ms.every(Number.isFinite) &&
    canaryTiming.samples_ms.every(Number.isFinite),
  governance_and_privacy:
    observed.governance_violations === 0 &&
    observed.critical_failures === 0 &&
    bannedMarkers.every(
      (marker) => !reportText.includes(marker)
    ),
  exact_canary_bound:
    observed.canary_exposures ===
      thresholds.canary_case_count &&
    observed.forced_abort_exposures <
      thresholds.canary_case_count,
  release_rollback_separate:
    observed.release_pointer_revision === 1 &&
    observed.rollback_pointer_revision === 2 &&
    observed.final_active_release_id === null,
  reports_bounded:
    reportPaths.every(
      (path) =>
        statSync(resolve(repositoryRoot, path)).size <
        2 * 1024 * 1024,
    ),
};
const report = writeHashedReport(outputPath, {
  schema_version: "1.0.0",
  gate: "G5_U8_RESOURCES",
  recorded_at: G5_RECORDED_AT,
  implementation: {
    commit: executionIdentity.implementation_commit,
    tree: executionIdentity.implementation_tree,
    dependency_lock_hash:
      executionIdentity.dependency_lock_hash,
  },
  environment: environmentIdentity(
    replay.environment.sqlite,
  ),
  fixture: {
    manifest_hash: fixtureManifest.manifest_hash,
    thresholds_hash: fixtureManifest.thresholds_hash,
  },
  evidence_runner_wall_clock: {
    replay: replayTiming,
    canary: canaryTiming,
  },
  memory: {
    parent_rss_before_bytes: rssBefore,
    parent_rss_after_bytes: rssAfter,
    parent_rss_delta_bytes: rssAfter - rssBefore,
  },
  artifact_bytes: Object.fromEntries(
    reportPaths.map((path) => [
      path,
      statSync(resolve(repositoryRoot, path)).size,
    ]),
  ),
  metric_families: {
    task_units: {
      passed: observed.passed_task_units,
      failed: observed.failed_task_units,
    },
    errors: observed.errors,
    negative_transfer_units:
      observed.negative_transfer_units,
    context: {
      tokens: observed.context_tokens,
      pollution: observed.context_pollution,
    },
    latency: {
      declared_arm_latency_ms:
        observed.declared_latency_ms,
      harness_replay_p95_ms: replayTiming.p95_ms,
      harness_canary_p95_ms: canaryTiming.p95_ms,
    },
    side_effects: observed.side_effects,
    governance: {
      violations: observed.governance_violations,
      critical_failures: observed.critical_failures,
    },
    privacy: {
      banned_marker_hash: canonicalSha256(bannedMarkers),
      matched_markers: bannedMarkers.filter((marker) =>
        reportText.includes(marker)
      ),
    },
    release: {
      pointer_revision:
        observed.release_pointer_revision,
    },
    rollback: {
      pointer_revision:
        observed.rollback_pointer_revision,
      final_active_release_id:
        observed.final_active_release_id,
    },
  },
  hard_rules: hardRules,
  evidence_boundary: {
    local_synthetic_measurement: true,
    qualified_environment_only: true,
    production_workload: false,
    production_readiness_claimed: false,
    wall_clock_is_observational_not_a_product_slo: true,
  },
});

process.stdout.write(
  `G5 resource evidence: ${
    Object.values(report.hard_rules).every(Boolean)
      ? "PASS"
      : "FAIL"
  }\n`,
);
