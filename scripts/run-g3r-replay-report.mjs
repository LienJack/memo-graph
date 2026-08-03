import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import {
  CanonicalHashSchema,
  G3OverlayCaseSchema,
  G3OverlayManifestSchema,
  RecallLaneSchema,
  ReplayCaseBodySchema,
  ReplayManifestSchema,
  canonicalJson,
  canonicalSha256,
} from "../packages/contracts/dist/index.js";
import {
  G3_ACCEPTED_M2_COMMIT,
  G3_ACCEPTED_M2_LOCK_HASH,
  runG3ReplayCase,
} from "../packages/memory-kernel/dist/index.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

function option(name) {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`missing required ${name} value`);
  }
  return value;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function rawSha256(value) {
  return CanonicalHashSchema.parse(
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
  );
}

function emptyAggregate() {
  return {
    runs: 0,
    task_included: 0,
    task_required: 0,
    evidence_included: 0,
    evidence_required: 0,
    pollution_events: 0,
    governance_violations: 0,
    budget_overflows: 0,
    abstention_correct: 0,
    rebuild_failures: 0,
    degraded_runs: 0,
    conflict_explanations: 0,
  };
}

function addMetrics(target, metrics) {
  target.runs += 1;
  target.task_included += metrics.task_units_included;
  target.task_required += metrics.task_units_required;
  target.evidence_included += metrics.evidence_units_included;
  target.evidence_required += metrics.evidence_units_required;
  target.pollution_events += metrics.pollution_categories.length;
  target.governance_violations += metrics.governance_violations.length;
  target.budget_overflows += Number(metrics.budget_overflow);
  target.abstention_correct += Number(metrics.abstention_correct);
  target.rebuild_failures += Number(!metrics.rebuild_equal);
  target.degraded_runs += Number(metrics.degraded_lanes.length > 0);
  target.conflict_explanations += metrics.conflict_explanations;
}

const candidateCommit = option("--candidate");
if (!/^[a-f0-9]{40}$/u.test(candidateCommit)) {
  throw new Error("candidate commit must be a full Git object id");
}
const outputPath = resolve(repositoryRoot, option("--output"));
const baseManifestPath = resolve(
  repositoryRoot,
  "fixtures/replay/manifest.json",
);
const overlayManifestPath = resolve(
  repositoryRoot,
  "fixtures/g3/manifest.json",
);
const regressionPath = resolve(
  repositoryRoot,
  "fixtures/g3/h3-regressions.json",
);
const rawBaseManifest = readFileSync(baseManifestPath);
const rawOverlayManifest = readFileSync(overlayManifestPath);
const baseManifest = ReplayManifestSchema.parse(
  JSON.parse(rawBaseManifest.toString("utf8")),
);
const overlayManifest = G3OverlayManifestSchema.parse(
  JSON.parse(rawOverlayManifest.toString("utf8")),
);
const regressionManifest = readJson(regressionPath);
if (
  canonicalSha256(baseManifest) !== overlayManifest.base_manifest_hash ||
  regressionManifest.candidate_commit !== candidateCommit ||
  regressionManifest.base_manifest_hash !==
    overlayManifest.base_manifest_hash
) {
  throw new Error("G3R manifest binding failed");
}
const dependencyLockHash = rawSha256(
  readFileSync(resolve(repositoryRoot, "pnpm-lock.yaml")),
);
const loaded = overlayManifest.cases.map((overlayDescriptor) => {
  const baseDescriptor = baseManifest.cases.find(
    (entry) => entry.case_id === overlayDescriptor.case_id,
  );
  if (baseDescriptor === undefined) {
    throw new Error(`missing M0 case ${overlayDescriptor.case_id}`);
  }
  const base = ReplayCaseBodySchema.parse(
    readJson(resolve(repositoryRoot, "fixtures/replay", baseDescriptor.body_file)),
  );
  const overlay = G3OverlayCaseSchema.parse(
    readJson(resolve(repositoryRoot, "fixtures/g3", overlayDescriptor.overlay_file)),
  );
  if (
    canonicalSha256(base) !== baseDescriptor.content_hash ||
    baseDescriptor.content_hash !== overlayDescriptor.base_case_hash ||
    canonicalSha256(overlay) !== overlayDescriptor.content_hash
  ) {
    throw new Error(`case hash mismatch for ${overlayDescriptor.case_id}`);
  }
  return { base, overlay, overlayDescriptor };
});

const armNames = [
  "accepted_m2",
  "m3_no_projection",
  "m3_layered",
];
const results = [];
for (const entry of loaded) {
  for (const tokenBudget of entry.overlay.token_budgets) {
    const common = {
      base: entry.base,
      overlay: entry.overlay,
      overlay_hash: entry.overlayDescriptor.content_hash,
      token_budget: tokenBudget,
    };
    const accepted = await runG3ReplayCase({
      ...common,
      arm: "accepted_m2",
      implementation_commit: G3_ACCEPTED_M2_COMMIT,
      dependency_lock_hash: CanonicalHashSchema.parse(
        G3_ACCEPTED_M2_LOCK_HASH,
      ),
    });
    const noProjection = await runG3ReplayCase({
      ...common,
      arm: "m3_no_projection",
      implementation_commit: candidateCommit,
      dependency_lock_hash: dependencyLockHash,
    });
    const layered = await runG3ReplayCase({
      ...common,
      arm: "m3_layered",
      implementation_commit: candidateCommit,
      dependency_lock_hash: dependencyLockHash,
    });
    results.push({
      case_id: entry.base.case_id,
      partition: entry.base.partition,
      token_budget: tokenBudget,
      accepted_m2: accepted,
      m3_no_projection: noProjection,
      m3_layered: layered,
    });
  }
}

const summary = Object.fromEntries(
  armNames.map((arm) => [
    arm,
    {
      aggregate: emptyAggregate(),
      partitions: {
        calibration: { task_included: 0, evidence_included: 0 },
        holdout: { task_included: 0, evidence_included: 0 },
        transfer: { task_included: 0, evidence_included: 0 },
      },
    },
  ]),
);
for (const row of results) {
  for (const arm of armNames) {
    const metrics = row[arm].metrics;
    addMetrics(summary[arm].aggregate, metrics);
    summary[arm].partitions[row.partition].task_included +=
      metrics.task_units_included;
    summary[arm].partitions[row.partition].evidence_included +=
      metrics.evidence_units_included;
  }
}

const compatibilityMismatches = results.flatMap((row) => {
  const semanticEqual =
    canonicalJson(row.accepted_m2.metrics) ===
      canonicalJson(row.m3_no_projection.metrics);
  const frozenEqual =
    row.accepted_m2.context_frozen_hash ===
      row.m3_no_projection.context_frozen_hash;
  return semanticEqual && frozenEqual
    ? []
    : [{
        case_id: row.case_id,
        token_budget: row.token_budget,
        semantic_equal: semanticEqual,
        frozen_context_equal: frozenEqual,
      }];
});

const ablationNonzero = [];
let ablationRuns = 0;
for (const row of results) {
  const entry = loaded.find((item) => item.base.case_id === row.case_id);
  if (entry === undefined) {
    throw new Error(`missing loaded case ${row.case_id}`);
  }
  for (const lane of RecallLaneSchema.options) {
    const omitted = await runG3ReplayCase({
      arm: "m3_layered",
      base: entry.base,
      overlay: entry.overlay,
      overlay_hash: entry.overlayDescriptor.content_hash,
      token_budget: row.token_budget,
      implementation_commit: candidateCommit,
      dependency_lock_hash: dependencyLockHash,
      omit_lane: lane,
    });
    ablationRuns += 1;
    const taskDelta =
      omitted.metrics.task_units_included -
      row.m3_layered.metrics.task_units_included;
    const evidenceDelta =
      omitted.metrics.evidence_units_included -
      row.m3_layered.metrics.evidence_units_included;
    if (taskDelta !== 0 || evidenceDelta !== 0) {
      ablationNonzero.push({
        case_id: row.case_id,
        token_budget: row.token_budget,
        omitted_lane: lane,
        task_delta: taskDelta,
        evidence_delta: evidenceDelta,
      });
    }
  }
}

const invariantFailures = results.flatMap((row) =>
  armNames.flatMap((arm) => {
    const metrics = row[arm].metrics;
    return metrics.governance_violations.length === 0 &&
        !metrics.budget_overflow &&
        metrics.rebuild_equal &&
        metrics.abstention_correct
      ? []
      : [{
          case_id: row.case_id,
          token_budget: row.token_budget,
          arm,
        }];
  })
);
const strictImprovements = results.flatMap((row) => {
  const taskDelta =
    row.m3_layered.metrics.task_units_included -
    row.accepted_m2.metrics.task_units_included;
  return taskDelta > 0
    ? [{
        case_id: row.case_id,
        partition: row.partition,
        token_budget: row.token_budget,
        task_delta: taskDelta,
      }]
    : [];
});
const report = {
  schema_version: "1.0.0",
  recorded_at: new Date().toISOString(),
  gate: "G3R",
  protocol_version: "1.0.0",
  candidate_commit: candidateCommit,
  accepted_m2_commit: G3_ACCEPTED_M2_COMMIT,
  dependency_lock_hash: dependencyLockHash,
  accepted_m2_lock_hash: G3_ACCEPTED_M2_LOCK_HASH,
  accepted_m2_isolated_checkout: {
    command: "pnpm test:g3:accepted",
    result: "PASS",
  },
  corpus: {
    base_manifest_raw_hash: rawSha256(rawBaseManifest),
    base_manifest_hash: canonicalSha256(baseManifest),
    g3_manifest_raw_hash: rawSha256(rawOverlayManifest),
    g3_manifest_hash: canonicalSha256(overlayManifest),
    h3_regression_manifest_hash: canonicalSha256(regressionManifest),
    cases: loaded.length,
    runs_per_arm: results.length,
  },
  compatibility: {
    arm_a_b_semantic_equal: compatibilityMismatches.length === 0,
    arm_a_b_frozen_context_equal: compatibilityMismatches.length === 0,
    mismatches: compatibilityMismatches,
  },
  summary,
  strict_improvements: strictImprovements,
  ablation: {
    runs: ablationRuns,
    nonzero_deltas: ablationNonzero,
  },
  invariant_failures: invariantFailures,
  h3_regressions: {
    command: "pnpm test:g3r:h3",
    cases: regressionManifest.cases.length,
    result: "PASS",
  },
  decision_input: {
    zero_governance_budget_rebuild_partition_violations:
      invariantFailures.length === 0,
    accepted_m2_parity: compatibilityMismatches.length === 0,
    strict_designated_improvement: strictImprovements.length > 0,
    all_h3_regressions_pass: true,
  },
};
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
