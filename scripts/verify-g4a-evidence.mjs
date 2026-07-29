import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { URL } from "node:url";

import {
  G4ACaseBodySchema,
  G4AOverlayManifestSchema,
  canonicalJson,
  canonicalSha256,
} from "../packages/contracts/dist/index.js";
import {
  assertComparableG4AIdentities,
  graphGlobalLogicalDigest,
  materializeG4AExpectedProfile,
  scoreG4AOutcome,
} from "../packages/graph-projection/dist/index.js";

const repositoryRoot = realpathSync(resolve(import.meta.dirname, ".."));

function read(path) {
  return readFileSync(resolve(repositoryRoot, path));
}

function readJson(path) {
  return JSON.parse(read(path).toString("utf8"));
}

function committed(candidate, path) {
  return execFileSync("git", ["show", `${candidate}:${path}`], {
    cwd: repositoryRoot,
  });
}

function gitTree(candidate, path) {
  return execFileSync(
    "git",
    ["rev-parse", `${candidate}:${path}`],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
    },
  ).trim();
}

function rawSha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function assertEqual(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label} mismatch`);
  }
}

function verifyReportHash(report, recordedAtIsVolatile) {
  const { report_hash: reportHash, ...body } = report;
  const canonicalBody = recordedAtIsVolatile
    ? { ...body, recorded_at: null }
    : body;
  assertEqual(
    reportHash,
    canonicalSha256(canonicalBody),
    `${report.gate} report hash`,
  );
}

function verifyJsonBinding(binding) {
  const bytes = read(binding.path);
  assertEqual(
    rawSha256(bytes),
    binding.raw_hash,
    `${binding.path} raw hash`,
  );
  assertEqual(
    canonicalSha256(JSON.parse(bytes.toString("utf8"))),
    binding.canonical_hash,
    `${binding.path} canonical hash`,
  );
}

function verifyFinalManifest(options) {
  const finalManifest = readJson(
    "docs/evaluations/g4a-reproducibility-manifest.json",
  );
  assertEqual(finalManifest.schema_version, "1.0.0", "final manifest schema");
  assertEqual(finalManifest.gate, "G4A", "final manifest gate");
  assertEqual(
    finalManifest.evaluation_status,
    "EVIDENCE_READY",
    "final manifest status",
  );
  assertEqual(finalManifest.decision, "NO-GO", "final manifest decision");
  const candidate = finalManifest.tested_implementation?.commit;
  if (typeof candidate !== "string" || !/^[a-f0-9]{40}$/u.test(candidate)) {
    throw new Error("final manifest candidate is invalid");
  }
  execFileSync("git", ["cat-file", "-e", `${candidate}^{commit}`], {
    cwd: repositoryRoot,
  });
  assertEqual(
    candidate,
    options.structural.candidate_commit,
    "final structural candidate",
  );
  assertEqual(
    candidate,
    options.resource.candidate_commit,
    "final resource candidate",
  );
  assertEqual(
    finalManifest.tested_implementation.dependency_lock_hash,
    options.lockHash,
    "final dependency lock",
  );
  assertEqual(
    rawSha256(committed(candidate, "pnpm-lock.yaml")),
    options.lockHash,
    "candidate dependency lock",
  );

  const expectedPackages = [
    ["@memo-graph/context-compiler", "packages/context-compiler"],
    ["@memo-graph/contracts", "packages/contracts"],
    ["@memo-graph/graph-projection", "packages/graph-projection"],
    ["@memo-graph/mcp-server", "packages/mcp-server"],
    ["@memo-graph/memory-kernel", "packages/memory-kernel"],
    ["@memo-graph/storage-sqlite", "packages/storage-sqlite"],
  ];
  assertEqual(
    finalManifest.workspace_packages.map((entry) => [
      entry.name,
      entry.path,
    ]),
    expectedPackages,
    "workspace package inventory",
  );
  for (const packageBinding of finalManifest.workspace_packages) {
    assertEqual(
      packageBinding.git_tree,
      gitTree(candidate, packageBinding.path),
      `${packageBinding.name} candidate tree`,
    );
  }

  for (const binding of finalManifest.frozen_sources) {
    assertEqual(
      rawSha256(committed(candidate, binding.path)),
      binding.raw_hash,
      `${binding.path} candidate source`,
    );
  }
  assertEqual(
    finalManifest.frozen_inputs.g4a_manifest_raw,
    rawSha256(options.manifestBytes),
    "final G4A manifest raw hash",
  );
  assertEqual(
    finalManifest.frozen_inputs.g4a_manifest_canonical,
    options.manifestHash,
    "final G4A manifest canonical hash",
  );
  assertEqual(
    finalManifest.frozen_inputs.thresholds_canonical,
    options.thresholdsHash,
    "final G4A thresholds hash",
  );
  assertEqual(
    finalManifest.native_identity,
    options.resource.environment.ladybug,
    "final native identity",
  );
  assertEqual(
    finalManifest.environment,
    {
      node: options.resource.environment.node,
      pnpm: options.resource.environment.pnpm,
      operating_system: options.resource.environment.os,
      platform: options.resource.environment.platform,
      architecture: options.resource.environment.architecture,
      sqlite: options.resource.environment.sqlite,
    },
    "final environment",
  );
  assertEqual(
    finalManifest.versions,
    {
      storage_schema: options.resource.environment.storage_schema,
      graph_schema: options.resource.environment.graph_schema,
      context_compiler: "3.0.0",
      context_policy: "2.0.0",
      graph_process_protocol: "1.0.0",
      g4a_protocol: options.resource.environment.protocol,
      transform: options.resource.environment.transform,
    },
    "final versions",
  );

  for (const binding of Object.values(finalManifest.evidence_reports)) {
    verifyJsonBinding(binding);
  }
  assertEqual(
    readJson(finalManifest.evidence_reports.structural.path).candidate_commit,
    candidate,
    "manifest structural report candidate",
  );
  assertEqual(
    readJson(finalManifest.evidence_reports.resource.path).candidate_commit,
    candidate,
    "manifest resource report candidate",
  );
  const verification = readJson(
    finalManifest.evidence_reports.verification.path,
  );
  assertEqual(
    verification.candidate_commit,
    candidate,
    "verification report candidate",
  );
  if (
    verification.commands.length === 0 ||
    verification.commands.some((command) => command.result !== "PASS")
  ) {
    throw new Error("final verification report contains a failed command");
  }
  assertEqual(
    rawSha256(read(finalManifest.review.path)),
    finalManifest.review.raw_hash,
    "final code review hash",
  );
  assertEqual(finalManifest.review.unresolved_p0, 0, "unresolved P0");
  assertEqual(finalManifest.review.unresolved_p1, 0, "unresolved P1");
  assertEqual(
    finalManifest.decision_input.structural_gate,
    options.structural.decision_input.structural_gate,
    "final structural gate",
  );
  assertEqual(
    finalManifest.decision_input.governance_gate,
    options.structural.decision_input.governance_gate,
    "final governance gate",
  );
  assertEqual(
    finalManifest.decision_input.resource_gate,
    options.resource.resource_gate,
    "final resource gate",
  );
  assertEqual(
    finalManifest.decision_input.eligible_for_go,
    false,
    "final GO eligibility",
  );
}

function eligibility(input) {
  const checks = {
    reports_present:
      input.baseline !== null &&
      input.structural !== null &&
      input.resource !== null,
    baseline_pass: input.baseline?.result === "PASS",
    same_candidate:
      input.structural?.candidate_commit !== undefined &&
      input.structural.candidate_commit ===
        input.resource?.candidate_commit,
    identity_gate:
      input.structural?.decision_input?.identity_gate === true &&
      input.structural?.decision_input?.frozen_input_gate === true,
    structural_gate:
      input.structural?.summary?.material_structural_gain === true &&
      input.structural?.decision_input?.structural_gate === true,
    governance_gate:
      input.structural?.decision_input?.governance_gate === true,
    resource_gate: input.resource?.resource_gate === true,
  };
  return {
    checks,
    go: Object.values(checks).every(Boolean),
  };
}

const manifestBytes = read("fixtures/g4a/manifest.json");
const manifest = G4AOverlayManifestSchema.parse(
  JSON.parse(manifestBytes.toString("utf8")),
);
const accepted = readJson(
  "docs/evaluations/g3r-h3-reproducibility-manifest.json",
);
const baseline = readJson(
  "docs/evaluations/g4a-baseline-report.json",
);
const structural = readJson(
  "docs/evaluations/g4a-structural-report.json",
);
const resource = readJson(
  "docs/evaluations/g4a-resource-report.json",
);
const lockHash = rawSha256(read("pnpm-lock.yaml"));
const manifestHash = canonicalSha256(manifest);
const thresholdsHash = canonicalSha256(manifest.thresholds);

verifyReportHash(baseline, false);
verifyReportHash(structural, true);
verifyReportHash(resource, true);

assertEqual(
  manifest.baseline_commit,
  accepted.tested_implementation?.commit,
  "accepted G3R commit",
);
assertEqual(
  baseline.baseline_commit,
  manifest.baseline_commit,
  "isolated baseline commit",
);
assertEqual(
  baseline.dependency_lock_hash,
  accepted.tested_implementation?.dependency_lock_hash,
  "isolated baseline lock",
);
assertEqual(baseline.isolated_checkout, true, "isolated baseline");
assertEqual(baseline.result, "PASS", "isolated baseline result");
assertEqual(
  structural.accepted_g3r_commit,
  manifest.baseline_commit,
  "structural baseline",
);
assertEqual(
  structural.accepted_g3r_dependency_lock_hash,
  baseline.dependency_lock_hash,
  "structural baseline lock",
);
assertEqual(
  structural.dependency_lock_hash,
  lockHash,
  "structural dependency lock",
);
assertEqual(
  resource.dependency_lock_hash,
  lockHash,
  "resource dependency lock",
);
assertEqual(
  structural.candidate_commit,
  resource.candidate_commit,
  "paired candidate",
);
execFileSync(
  "git",
  ["cat-file", "-e", `${structural.candidate_commit}^{commit}`],
  { cwd: repositoryRoot },
);

assertEqual(
  structural.corpus.manifest_raw_hash,
  rawSha256(manifestBytes),
  "manifest raw hash",
);
assertEqual(
  structural.corpus.manifest_hash,
  manifestHash,
  "manifest canonical hash",
);
assertEqual(
  structural.corpus.thresholds_hash,
  thresholdsHash,
  "structural threshold hash",
);
assertEqual(
  resource.manifest_hash,
  manifestHash,
  "resource manifest hash",
);
assertEqual(
  resource.thresholds_hash,
  thresholdsHash,
  "resource threshold hash",
);
assertEqual(resource.thresholds, manifest.thresholds, "resource thresholds");

const sourceBindings = [
  [
    structural.corpus.evaluator_source_hash,
    "scripts/run-g4a-replay.mjs",
  ],
  [
    structural.corpus.materializer_source_hash,
    "packages/graph-projection/src/benchmark.ts",
  ],
  [
    structural.corpus.reference_source_hash,
    "packages/graph-projection/src/sqlite-baseline.ts",
  ],
  [
    structural.corpus.native_adapter_source_hash,
    "packages/graph-projection/src/ladybug-adapter.ts",
  ],
  [
    resource.environment.runner_source_hash,
    "scripts/run-g4a-resource-benchmark.mjs",
  ],
  [
    resource.environment.materializer_source_hash,
    "packages/graph-projection/src/benchmark.ts",
  ],
  [
    resource.environment.process_host_source_hash,
    "packages/graph-projection/src/process-host.ts",
  ],
  [
    resource.environment.native_adapter_source_hash,
    "packages/graph-projection/src/ladybug-adapter.ts",
  ],
];
for (const [expectedHash, path] of sourceBindings) {
  assertEqual(expectedHash, rawSha256(read(path)), `${path} source hash`);
}

const require = createRequire(
  new URL("../packages/graph-projection/package.json", import.meta.url),
);
const ladybugEntry = require.resolve("@ladybugdb/core");
const nativeBinaryHash = rawSha256(
  readFileSync(join(dirname(ladybugEntry), "lbugjs.node")),
);
assertEqual(
  structural.native_identity,
  resource.environment.ladybug,
  "native identity across reports",
);
assertEqual(
  structural.native_identity.native_binary_hash,
  nativeBinaryHash,
  "native binary hash",
);
assertEqual(
  structural.native_identity.package_name,
  manifest.candidate.package_name,
  "native package",
);
assertEqual(
  structural.native_identity.package_version,
  manifest.candidate.package_version,
  "native package version",
);
assertEqual(
  structural.native_identity.platform,
  manifest.candidate.platform,
  "native platform",
);
assertEqual(
  structural.native_identity.architecture,
  manifest.candidate.architecture,
  "native architecture",
);

const caseById = new Map();
for (const descriptor of manifest.cases) {
  const body = G4ACaseBodySchema.parse(
    readJson(`fixtures/g4a/${descriptor.body_file}`),
  );
  assertEqual(body.case_id, descriptor.case_id, "case identity");
  assertEqual(
    canonicalSha256(body),
    descriptor.content_hash,
    `${descriptor.case_id} content hash`,
  );
  caseById.set(body.case_id, body);
}
assertEqual(
  structural.results.length,
  manifest.cases.length,
  "structural result count",
);

for (const row of structural.results) {
  const body = caseById.get(row.case_id);
  if (body === undefined) {
    throw new Error(`unknown G4A result ${row.case_id}`);
  }
  const arms = [
    row.arms.accepted_g3r,
    row.arms.m4a_graph_disabled_reference,
    row.arms.m4a_graph_enabled,
  ];
  assertComparableG4AIdentities(arms.map((arm) => arm.identity));
  for (const arm of arms) {
    const { result_hash: resultHash, ...resultBody } = arm;
    assertEqual(
      resultHash,
      canonicalSha256(resultBody),
      `${row.case_id} ${arm.identity.arm} result hash`,
    );
    assertEqual(
      row.scores[arm.identity.arm],
      scoreG4AOutcome(body.expected, arm.actual),
      `${row.case_id} ${arm.identity.arm} score`,
    );
  }
  const nativeReferenceEqual =
    canonicalSha256(row.arms.m4a_graph_disabled_reference.actual) ===
    canonicalSha256(row.arms.m4a_graph_enabled.actual);
  assertEqual(
    row.native_reference_equal,
    nativeReferenceEqual,
    `${row.case_id} native/reference parity`,
  );
  const strictGain =
    row.scores.m4a_graph_enabled.passed &&
    !row.scores.accepted_g3r.passed &&
    !row.scores.m4a_graph_disabled_reference.passed &&
    nativeReferenceEqual;
  assertEqual(
    row.strict_gain,
    strictGain,
    `${row.case_id} strict gain`,
  );
}

const strictGains = structural.results.filter((row) => row.strict_gain);
const graphRegressions = structural.results.filter(
  (row) => !row.scores.m4a_graph_enabled.passed,
);
const governanceViolations = structural.results.flatMap(
  (row) => row.arms.m4a_graph_enabled.governance_violations,
);
const materialStructuralGain =
  strictGains.length >= manifest.thresholds.strict_case_gains &&
  strictGains.filter((row) => row.partition === "holdout").length >=
    manifest.thresholds.minimum_holdout_gains &&
  strictGains.filter((row) => row.partition === "transfer").length >=
    manifest.thresholds.minimum_transfer_gains &&
  graphRegressions.length === 0;
assertEqual(
  structural.summary.strict_gains,
  strictGains.map((row) => row.case_id),
  "strict gains",
);
assertEqual(
  structural.summary.graph_regressions,
  graphRegressions.map((row) => row.case_id),
  "graph regressions",
);
assertEqual(
  structural.summary.governance_violations,
  governanceViolations,
  "governance violations",
);
assertEqual(
  structural.summary.material_structural_gain,
  materialStructuralGain,
  "material structural gain",
);
const logicalResultsHash = canonicalSha256(
  structural.results.map((row) => ({
    case_id: row.case_id,
    partition: row.partition,
    input_identity: row.input_identity,
    scores: row.scores,
    arms: Object.fromEntries(
      Object.entries(row.arms).map(([arm, result]) => [
        arm,
        result.result_hash,
      ]),
    ),
    native_reference_equal: row.native_reference_equal,
    strict_gain: row.strict_gain,
  })),
);
assertEqual(
  structural.summary.logical_results_hash,
  logicalResultsHash,
  "logical results hash",
);

const expectedSnapshots = materializeG4AExpectedProfile(
  manifest.expected_profile,
);
assertEqual(
  resource.metrics.expected_profile.scope_count,
  expectedSnapshots.length,
  "Expected scope count",
);
assertEqual(
  resource.metrics.expected_profile.logical_digest,
  graphGlobalLogicalDigest(expectedSnapshots),
  "Expected logical digest",
);
assertEqual(
  resource.metrics.expected_profile.logical_materialized,
  true,
  "Expected logical materialization",
);
const thresholdResults = {
  warmups:
    resource.metrics.samples.warmups >=
    manifest.thresholds.warmup_samples,
  measured_samples:
    resource.metrics.samples.measured >=
    manifest.thresholds.measured_samples,
  graph_p50:
    resource.metrics.latency_ms.graph_assisted_p50 <=
    manifest.thresholds.governed_recall_p50_ms,
  graph_p95:
    resource.metrics.latency_ms.graph_assisted_p95 <=
    manifest.thresholds.governed_recall_p95_ms,
  fallback_p95:
    resource.metrics.latency_ms.fallback_p95 <=
    manifest.thresholds.fallback_p95_ms,
  replacement:
    resource.metrics.latency_ms.replacement_max <=
    manifest.thresholds.replacement_ready_ms,
  expected_rebuild:
    resource.metrics.latency_ms.expected_full_rebuild !== null &&
    resource.metrics.latency_ms.expected_full_rebuild <=
      manifest.thresholds.expected_rebuild_ms,
  graph_database_wal:
    resource.metrics.physical_bytes.graph_database_wal <=
    manifest.thresholds.graph_database_wal_bytes,
  install_delta:
    resource.metrics.physical_bytes.install_delta <=
    manifest.thresholds.install_delta_bytes,
  idle_rss:
    resource.metrics.rss_bytes.idle_delta !== null &&
    resource.metrics.rss_bytes.idle_delta <=
      manifest.thresholds.idle_rss_delta_bytes,
  peak_rss:
    resource.metrics.rss_bytes.peak_delta !== null &&
    resource.metrics.rss_bytes.peak_delta <=
      manifest.thresholds.peak_rss_delta_bytes,
  queue_debt: resource.metrics.process.queue_debt === 0,
  expected_native_profile:
    resource.metrics.expected_profile.native_physical_materialized &&
    resource.metrics.expected_profile.native_full_rebuild_measured,
};
assertEqual(
  resource.threshold_results,
  thresholdResults,
  "resource threshold evaluation",
);
assertEqual(
  resource.resource_gate,
  Object.values(thresholdResults).every(Boolean),
  "resource gate",
);

const actualEligibility = eligibility({
  baseline,
  structural,
  resource,
});
assertEqual(
  structural.decision_input.eligible_for_go,
  false,
  "structural provisional GO status",
);
if (actualEligibility.go) {
  throw new Error("current G4A evidence unexpectedly qualifies for GO");
}
for (const [label, input] of [
  ["missing", { baseline, structural, resource: null }],
  [
    "failed",
    {
      baseline,
      structural: {
        ...structural,
        summary: {
          ...structural.summary,
          material_structural_gain: false,
        },
      },
      resource,
    },
  ],
  [
    "mixed",
    {
      baseline,
      structural,
      resource: {
        ...resource,
        candidate_commit: "0".repeat(40),
      },
    },
  ],
]) {
  if (eligibility(input).go) {
    throw new Error(`${label} evidence was incorrectly eligible for GO`);
  }
}

const repeatRoot = realpathSync(
  mkdtempSync(join(realpathSync(tmpdir()), "memo-graph-g4a-verify-")),
);
try {
  const repeatPath = join(repeatRoot, "structural-repeat.json");
  execFileSync(
    process.execPath,
    [
      resolve(repositoryRoot, "scripts/run-g4a-replay.mjs"),
      "--candidate",
      structural.candidate_commit,
      "--output",
      repeatPath,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
    },
  );
  const repeated = JSON.parse(readFileSync(repeatPath, "utf8"));
  assertEqual(
    repeated.summary.logical_results_hash,
    structural.summary.logical_results_hash,
    "repeated logical results hash",
  );
} finally {
  rmSync(repeatRoot, { recursive: true, force: true });
}

verifyFinalManifest({
  structural,
  resource,
  lockHash,
  manifestBytes,
  manifestHash,
  thresholdsHash,
});

const failedChecks = Object.entries(actualEligibility.checks)
  .filter(([, passed]) => !passed)
  .map(([name]) => name);
process.stdout.write(
  `G4A evidence verified: NO-GO (${failedChecks.join(", ")})\n`,
);
