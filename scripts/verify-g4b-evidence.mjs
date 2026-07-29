import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  G4BFrozenSubsetSchema,
  canonicalJson,
  canonicalSha256,
  canonicalSha256Omitting,
} from "../packages/contracts/dist/index.js";
import {
  G4B_MANIFEST_HASH,
  G4B_VECTOR_EPOCH,
  calibrateG4B,
  evaluateG4BResourceMetrics,
  materializeG4BExpectedProfile,
} from "../tests/helpers/g4b-replay.ts";

const repositoryRoot = resolve(import.meta.dirname, "..");

function read(path) {
  return readFileSync(resolve(repositoryRoot, path));
}

function readJson(path) {
  return JSON.parse(read(path).toString("utf8"));
}

function rawSha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function committed(commit, path) {
  return execFileSync("git", ["show", `${commit}:${path}`], {
    cwd: repositoryRoot,
  });
}

function gitTree(commit, path) {
  return execFileSync(
    "git",
    ["rev-parse", `${commit}:${path}`],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
    },
  ).trim();
}

function assertEqual(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label} mismatch`);
  }
}

function verifyReportHash(report, recordedAtIsVolatile) {
  const { report_hash: reportHash, ...body } = report;
  assertEqual(
    reportHash,
    canonicalSha256(
      recordedAtIsVolatile
        ? { ...body, recorded_at: null }
        : body,
    ),
    `${report.gate} report hash`,
  );
}

function verifyBinding(binding, json) {
  const bytes = read(binding.path);
  assertEqual(
    rawSha256(bytes),
    binding.raw_hash,
    `${binding.path} raw hash`,
  );
  if (json) {
    assertEqual(
      canonicalSha256(JSON.parse(bytes.toString("utf8"))),
      binding.canonical_hash,
      `${binding.path} canonical hash`,
    );
  }
}

function dirtyPaths() {
  const output = execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
    },
  );
  return output
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3))
    .map((path) => path.includes(" -> ")
      ? path.split(" -> ").at(-1)
      : path)
    .filter((path) =>
      !path.startsWith(".trellis/tasks/") &&
      !path.startsWith(".trellis/workspace/")
    )
    .sort();
}

export function evaluateG4BEligibility(input) {
  const checks = {
    one_candidate:
      input.replay.implementation_commit ===
        input.resource.candidate_commit &&
      input.replay.implementation_commit ===
        input.manifest.tested_implementation.commit,
    lock_identity:
      input.replay.dependency_lock_hash ===
        input.resource.dependency_lock_hash &&
      input.replay.dependency_lock_hash ===
        input.manifest.tested_implementation.dependency_lock_hash &&
      input.manifest.embedding_epoch.dependency_lock_hash ===
        input.replay.dependency_lock_hash,
    dependency_gate:
      input.manifest.decision_input.dependency_gate === true,
    governance_gate:
      input.manifest.decision_input.governance_gate === true,
    recovery_gate:
      input.manifest.decision_input.recovery_gate === true,
    replay_repeat:
      input.replay.repeat?.runs === 2 &&
      input.replay.repeat?.deterministic === true,
    utility_gate: input.replay.utility_gate === true,
    resource_gate: input.resource.resource_gate === true,
    review_gate:
      input.manifest.review.result === "PASS" &&
      input.manifest.review.unresolved_p0 === 0 &&
      input.manifest.review.unresolved_p1 === 0,
    evidence_gate:
      input.manifest.evaluation_status === "EVIDENCE_READY",
  };
  return {
    checks,
    go: Object.values(checks).every(Boolean),
  };
}

export function assertSingleFrozenCandidate(input) {
  if (
    input.replay.implementation_commit !==
      input.resource.candidate_commit ||
    input.replay.implementation_commit !==
      input.manifest.tested_implementation.commit ||
    input.replay.calibration_receipt.configuration_hash !==
      input.manifest.evaluation.calibration_configuration_hash ||
    input.replay.calibration_receipt.sealed_hash !==
      input.manifest.evaluation.calibration_receipt_hash
  ) {
    throw new Error(
      "G4B candidate substitution or post-holdout calibration drift",
    );
  }
}

export async function verifyG4BEvidence() {
  const frozenBytes = read("fixtures/g4b/manifest.json");
  const frozen = G4BFrozenSubsetSchema.parse(
    JSON.parse(frozenBytes.toString("utf8")),
  );
  const replay = readJson(
    "docs/evaluations/g4b-replay-report.json",
  );
  const resource = readJson(
    "docs/evaluations/g4b-resource-report.json",
  );
  const manifest = readJson(
    "docs/evaluations/g4b-reproducibility-manifest.json",
  );
  const verification = readJson(
    "docs/evaluations/g4b-verification-report.json",
  );
  const u2 = readJson(
    ".trellis/tasks/07-29-agent-memory-runtime-m4b/evidence/u2-candidate-gate.json",
  );
  const u6 = readJson(
    ".trellis/tasks/07-29-agent-memory-runtime-m4b/evidence/u6-governance-recovery-gate.json",
  );

  assertEqual(canonicalSha256(frozen), G4B_MANIFEST_HASH, "G4B manifest");
  assertEqual(
    rawSha256(frozenBytes),
    manifest.frozen_inputs.manifest_raw_hash,
    "G4B manifest raw hash",
  );
  assertEqual(
    G4B_MANIFEST_HASH,
    manifest.frozen_inputs.manifest_canonical_hash,
    "G4B manifest canonical hash",
  );
  assertEqual(
    canonicalSha256(frozen.thresholds),
    manifest.frozen_inputs.thresholds_hash,
    "G4B thresholds hash",
  );
  verifyReportHash(replay, false);
  verifyReportHash(resource, true);
  assertSingleFrozenCandidate({ replay, resource, manifest });

  const candidate = replay.implementation_commit;
  if (!/^[a-f0-9]{40}$/u.test(candidate)) {
    throw new Error("G4B candidate commit is invalid");
  }
  execFileSync("git", ["cat-file", "-e", `${candidate}^{commit}`], {
    cwd: repositoryRoot,
  });
  execFileSync(
    "git",
    [
      "cat-file",
      "-e",
      `${manifest.accepted_baseline.commit}^{commit}`,
    ],
    { cwd: repositoryRoot },
  );
  assertEqual(
    rawSha256(
      committed(
        manifest.accepted_baseline.commit,
        "pnpm-lock.yaml",
      ),
    ),
    manifest.accepted_baseline.dependency_lock_hash,
    "accepted baseline lock",
  );
  assertEqual(
    rawSha256(committed(candidate, "pnpm-lock.yaml")),
    replay.dependency_lock_hash,
    "candidate dependency lock",
  );
  assertEqual(
    rawSha256(read("pnpm-lock.yaml")),
    replay.dependency_lock_hash,
    "current dependency lock",
  );
  assertEqual(
    resource.dependency_lock_hash,
    replay.dependency_lock_hash,
    "paired report lock",
  );
  assertEqual(
    G4B_VECTOR_EPOCH.dependency_lock_hash,
    replay.dependency_lock_hash,
    "embedding epoch dependency lock",
  );
  assertEqual(
    resource.environment.vector_epoch_id,
    G4B_VECTOR_EPOCH.epoch_id,
    "resource epoch",
  );
  assertEqual(
    manifest.embedding_epoch.epoch_id,
    G4B_VECTOR_EPOCH.epoch_id,
    "manifest epoch",
  );
  assertEqual(
    manifest.embedding_epoch.active_generation,
    {
      embedding_epoch_id:
        resource.metrics.exact_scope_rebuild.embedding_epoch_id,
      generation_id:
        resource.metrics.exact_scope_rebuild.generation_id,
      source_frontier_hash:
        resource.metrics.exact_scope_rebuild.source_frontier_hash,
      logical_digest:
        resource.metrics.exact_scope_rebuild.logical_digest,
    },
    "active generation identity",
  );

  const { receipt } = await calibrateG4B();
  assertEqual(
    replay.calibration_receipt,
    receipt,
    "sealed calibration receipt",
  );
  assertEqual(
    replay.calibration_receipt.sealed_hash,
    canonicalSha256Omitting(
      replay.calibration_receipt,
      ["sealed_hash"],
    ),
    "calibration receipt hash",
  );
  assertEqual(replay.arms, frozen.arms, "frozen arms");
  assertEqual(
    replay.token_budgets,
    frozen.token_budgets,
    "frozen token budgets",
  );
  assertEqual(replay.cases.length, frozen.cases.length, "case count");
  for (const [index, frozenCase] of frozen.cases.entries()) {
    const observed = replay.cases[index];
    assertEqual(observed.case_id, frozenCase.case_id, "case identity");
    assertEqual(
      observed.case_hash,
      canonicalSha256(frozenCase),
      `${frozenCase.case_id} case hash`,
    );
    assertEqual(
      observed.partition,
      frozenCase.partition,
      `${frozenCase.case_id} partition`,
    );
  }

  const strictGains = replay.cases.filter((entry) => entry.strict_gain);
  const positiveSolved = replay.cases.filter(
    (entry) =>
      entry.case_role === "positive_gap" &&
      entry.hybrid_passed,
  ).length;
  const negativeControlsPass = replay.cases
    .filter((entry) => entry.case_role === "negative_control")
    .every((entry) => entry.hybrid_passed);
  const replayThresholds = {
    hybrid_positive_success:
      positiveSolved >= frozen.thresholds.minimum_positive_cases_solved,
    strict_case_gains:
      strictGains.length >=
      frozen.thresholds.minimum_strict_case_gains,
    holdout_gain:
      strictGains.filter((entry) => entry.partition === "holdout")
        .length >= frozen.thresholds.minimum_holdout_gains,
    transfer_gain:
      strictGains.filter((entry) => entry.partition === "transfer")
        .length >= frozen.thresholds.minimum_transfer_gains,
    critical_regressions:
      replay.summary.critical_regressions.length <=
      frozen.thresholds.critical_regression_tolerance,
    negative_controls: negativeControlsPass,
    context_pollution: replay.summary.pollution_deltas.every(
      (entry) =>
        entry.delta <=
        frozen.thresholds.context_pollution_delta_tolerance,
    ),
  };
  assertEqual(
    replay.threshold_results,
    replayThresholds,
    "replay threshold evaluation",
  );
  assertEqual(
    replay.utility_gate,
    Object.values(replayThresholds).every(Boolean),
    "replay utility gate",
  );

  const outcomes = resource.metrics.outcomes;
  const resourceThresholds = evaluateG4BResourceMetrics({
    thresholds: frozen.thresholds,
    samples: resource.metrics.samples,
    outcomes: {
      direct_complete: outcomes.direct.complete ?? 0,
      governed_complete: outcomes.governed.complete ?? 0,
      context_ok: outcomes.context.OK ?? 0,
      fallback_typed_degraded: Object.entries(
        outcomes.fallback,
      ).reduce(
        (total, [key, value]) =>
          key.startsWith("degraded:")
            ? total + Number(value)
            : total,
        0,
      ),
    },
    latency_ms: resource.metrics.latency_ms,
    expected_profile: {
      logical_materialized:
        resource.metrics.expected_profile.logical_materialized,
      native_physical_materialized:
        resource.metrics.expected_profile
          .native_physical_materialized,
      full_rebuild_measured:
        resource.metrics.expected_profile
          .native_full_rebuild_measured,
      epoch_migration_measured:
        resource.metrics.expected_profile
          .epoch_migration_measured,
    },
  });
  assertEqual(
    resource.threshold_results,
    resourceThresholds,
    "resource threshold evaluation",
  );
  assertEqual(
    resource.resource_gate,
    Object.values(resourceThresholds).every(Boolean),
    "resource gate",
  );
  const expected = materializeG4BExpectedProfile(
    frozen.expected_profile,
  );
  assertEqual(
    resource.metrics.expected_profile.logical_digest,
    expected.logical_digest,
    "expected profile logical digest",
  );
  assertEqual(
    resource.metrics.expected_profile.scope_count,
    expected.scope_count,
    "expected profile scope count",
  );
  assertEqual(
    resource.metrics.expected_profile.native_record_count,
    expected.active_l1_memories,
    "expected native record count",
  );

  assertEqual(
    manifest.dependencies.direct_optional,
    {
      "@huggingface/transformers": "4.2.0",
      "better-sqlite3": "13.0.1",
      "sqlite-vec": "0.1.9",
    },
    "direct optional dependencies",
  );
  const vectorPackage = readJson(
    "packages/vector-retrieval/package.json",
  );
  assertEqual(
    vectorPackage.optionalDependencies,
    manifest.dependencies.direct_optional,
    "vector package optional dependencies",
  );
  assertEqual(
    readJson("package.json").pnpm.overrides,
    manifest.dependencies.overrides,
    "dependency overrides",
  );
  assertEqual(
    manifest.dependencies.lock_hash,
    replay.dependency_lock_hash,
    "manifest lock identity",
  );
  assertEqual(
    manifest.dependencies.critical_transitive,
    {
      "@huggingface/jinja": "0.5.9",
      "@huggingface/tokenizers": "0.1.3",
      "adm-zip": "0.6.0",
      "node-addon-api": "8.9.0",
      "onnxruntime-common": "1.24.3",
      "onnxruntime-node": "1.24.3",
      "sharp": "0.35.3",
    },
    "critical transitive dependencies",
  );
  const lockText = read("pnpm-lock.yaml").toString("utf8");
  for (const [name, version] of Object.entries(
    manifest.dependencies.critical_transitive,
  )) {
    if (!lockText.includes(`${name}@${version}`)) {
      throw new Error(
        `critical transitive dependency missing from lock: ${name}@${version}`,
      );
    }
  }
  assertEqual(
    manifest.dependencies.native_artifacts,
    u2.native_artifacts,
    "qualified native artifacts",
  );
  assertEqual(
    manifest.model.files.map((entry) => ({
      path: entry.path,
      sha256: entry.sha256,
    })),
    G4B_VECTOR_EPOCH.model.files,
    "model file identities",
  );
  assertEqual(
    manifest.model.repository,
    G4B_VECTOR_EPOCH.model.repository,
    "model repository",
  );
  assertEqual(
    manifest.model.revision,
    G4B_VECTOR_EPOCH.model.revision,
    "model revision",
  );
  const configuredModelRoot =
    process.env.MEMO_GRAPH_G4B_MODEL_ROOT;
  if (configuredModelRoot !== undefined) {
    for (const file of manifest.model.files) {
      const path = resolve(
        configuredModelRoot,
        manifest.model.repository,
        file.path,
      );
      assertEqual(statSync(path).size, file.size, `${file.path} size`);
      assertEqual(
        rawSha256(readFileSync(path)),
        file.sha256,
        `${file.path} hash`,
      );
    }
  }

  for (const packageBinding of manifest.workspace_packages) {
    assertEqual(
      gitTree(candidate, packageBinding.path),
      packageBinding.git_tree,
      `${packageBinding.name} candidate tree`,
    );
  }
  for (const binding of manifest.source_bindings) {
    verifyBinding(binding, false);
  }
  for (const binding of Object.values(manifest.evidence_reports)) {
    verifyBinding(binding, true);
  }
  for (const binding of Object.values(manifest.documentation)) {
    verifyBinding(binding, false);
  }

  assertEqual(
    {
      node: manifest.environment.node,
      pnpm: manifest.environment.pnpm,
      operating_system: manifest.environment.operating_system,
      platform: manifest.environment.platform,
      architecture: manifest.environment.architecture,
    },
    {
      node: resource.environment.node,
      pnpm: resource.environment.pnpm,
      operating_system: resource.environment.os,
      platform: resource.environment.platform,
      architecture: resource.environment.architecture,
    },
    "qualified environment",
  );
  assertEqual(
    manifest.environment.node,
    process.versions.node,
    "current Node version",
  );
  assertEqual(
    manifest.environment.platform,
    process.platform,
    "current platform",
  );
  assertEqual(
    manifest.environment.architecture,
    process.arch,
    "current architecture",
  );

  const sourceDigest = canonicalSha256(
    manifest.source_bindings.map((entry) => ({
      path: entry.path,
      raw_hash: entry.raw_hash,
    })),
  );
  assertEqual(
    manifest.dirty_state_policy.changed_path_digest,
    sourceDigest,
    "allowed overlay digest",
  );
  const expectedAllowedPaths = [
    ...manifest.source_bindings.map((entry) => entry.path),
    ...Object.values(manifest.evidence_reports)
      .map((entry) => entry.path),
    ...Object.values(manifest.documentation)
      .map((entry) => entry.path),
    "docs/evaluations/g4b-reproducibility-manifest.json",
  ].sort();
  assertEqual(
    manifest.dirty_state_policy.allowed_paths,
    expectedAllowedPaths,
    "hash-bound dirty-state allowlist",
  );
  const allowed = new Set(
    manifest.dirty_state_policy.allowed_paths,
  );
  const unexpectedDirty = dirtyPaths().filter(
    (path) => !allowed.has(path),
  );
  if (unexpectedDirty.length > 0) {
    throw new Error(
      `unexpected dirty paths: ${unexpectedDirty.join(", ")}`,
    );
  }

  if (
    verification.commands.length === 0 ||
    verification.commands.some(
      (command) => command.result !== "PASS",
    )
  ) {
    throw new Error("G4B verification command evidence is incomplete");
  }
  for (const requiredCommand of [
    "pnpm test",
    "pnpm lint",
    "pnpm typecheck",
    "pnpm build",
    "pnpm audit --audit-level high",
    "pnpm run verify:g4b",
    "tests/integration/g4b-artifact-integrity.test.ts",
    "--offline --frozen-lockfile --no-optional",
  ]) {
    if (
      !verification.commands.some((entry) =>
        entry.command.includes(requiredCommand)
      )
    ) {
      throw new Error(
        `G4B verification command evidence is missing ${requiredCommand}`,
      );
    }
  }
  assertEqual(
    verification.review,
    manifest.review,
    "verification review",
  );
  assertEqual(u2.outcome, "PASS", "dependency qualification");
  assertEqual(u6.outcome, "PASS", "governance qualification");

  const eligibility = evaluateG4BEligibility({
    replay,
    resource,
    manifest,
  });
  assertEqual(
    manifest.decision_input.eligible_for_go,
    eligibility.go,
    "manifest GO eligibility",
  );
  if (eligibility.go) {
    throw new Error("current G4B evidence unexpectedly qualifies for GO");
  }
  if (manifest.decision !== "NO-GO") {
    throw new Error("failed G4B evidence must record NO-GO");
  }
  return {
    eligibility,
    replay,
    resource,
    manifest,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await verifyG4BEvidence();
  const failures = Object.entries(result.eligibility.checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  process.stdout.write(
    `G4B evidence verified: NO-GO (${failures.join(", ")})\n`,
  );
}
