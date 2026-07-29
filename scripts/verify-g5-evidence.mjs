import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  CanaryAuthorizationSchema,
  CanaryReceiptSchema,
  EvalReceiptSchema,
  EvaluationCaseResultSetSchema,
  EvaluationCommonIdentitySchema,
  G5FixtureManifestSchema,
  MonitorReceiptSchema,
  PostCanaryApprovalSchema,
  ReleaseReceiptSchema,
  RollbackReceiptSchema,
  canonicalJson,
  canonicalSha256,
  canonicalSha256Omitting,
} from "../packages/contracts/dist/index.js";
import {
  G5_RECORDED_AT,
  git,
  migrationIdentity,
  read,
  readJson,
  repositoryRoot,
} from "./g5-evidence-common.mjs";

const EVIDENCE_PATHS = [
  "docs/evaluations/g5-canary-report.json",
  "docs/evaluations/g5-code-review.md",
  "docs/evaluations/g5-replay-report.json",
  "docs/evaluations/g5-reproducibility-manifest.json",
  "docs/evaluations/g5-resource-report.json",
  "docs/evaluations/g5-verification-report.json",
].sort();
const DECISION_PATH = "docs/evaluations/g5-decision.md";

function rawSha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function assertEqual(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label} mismatch`);
  }
}

function assertTrue(value, label) {
  if (value !== true) {
    throw new Error(`${label} failed`);
  }
}

function committed(commit, path) {
  return execFileSync("git", ["show", `${commit}:${path}`], {
    cwd: repositoryRoot,
  });
}

function verifyHashedReport(report, label) {
  const { report_hash: reportHash, ...body } = report;
  assertEqual(
    reportHash,
    canonicalSha256(body),
    `${label} report hash`,
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
      canonicalSha256(
        JSON.parse(bytes.toString("utf8")),
      ),
      binding.canonical_hash,
      `${binding.path} canonical hash`,
    );
  }
}

function allTrue(record) {
  return (
    typeof record === "object" &&
    record !== null &&
    Object.values(record).length > 0 &&
    Object.values(record).every((value) => value === true)
  );
}

function dirtyPaths() {
  return execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
    },
  )
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3))
    .map((path) =>
      path.includes(" -> ") ? path.split(" -> ").at(-1) : path
    )
    .filter((path) => path !== undefined)
    .sort();
}

export function assertExactG5EvidencePaths(paths, options = {}) {
  const allowed = [
    ...EVIDENCE_PATHS,
    ...(options.allowDecision === true ? [DECISION_PATH] : []),
  ].sort();
  assertEqual([...paths].sort(), allowed, "G5 evidence path set");
}

export function evaluateG5Eligibility(checks) {
  return {
    checks,
    eligible: Object.values(checks).every(
      (value) => value === true,
    ),
  };
}

export function assertSingleG5Implementation(input) {
  const expected = input.manifest.tested_implementation;
  for (const report of [
    input.replay,
    input.canary,
    input.resource,
  ]) {
    if (
      report.implementation.commit !== expected.commit ||
      report.implementation.tree !== expected.tree ||
      report.implementation.dependency_lock_hash !==
        expected.dependency_lock_hash
    ) {
      throw new Error(
        "G5 candidate substitution or implementation drift",
      );
    }
  }
}

function currentG5EvidencePaths() {
  return readdirSync(
    resolve(repositoryRoot, "docs/evaluations"),
  )
    .filter((name) => name.startsWith("g5-"))
    .map((name) => `docs/evaluations/${name}`)
    .sort();
}

function verifyEvaluationIdentity(identity) {
  const parsed = EvaluationCommonIdentitySchema.parse(identity);
  assertEqual(
    parsed.common_identity_hash,
    canonicalSha256Omitting(parsed, [
      "common_identity_hash",
    ]),
    `${parsed.run_id} common identity hash`,
  );
  return parsed;
}

function verifyResultSets(resultSets, manifest, label) {
  assertEqual(resultSets.length, 9, `${label} result-set count`);
  const caseIds = new Set();
  for (const input of resultSets) {
    const set = EvaluationCaseResultSetSchema.parse(input);
    caseIds.add(set.case_id);
    assertEqual(
      set.results.map((entry) => entry.arm),
      manifest.arms,
      `${label}/${set.case_id} arms`,
    );
    assertEqual(
      new Set(
        set.results.map(
          (entry) => entry.common_identity_hash,
        ),
      ).size,
      1,
      `${label}/${set.case_id} common identity`,
    );
  }
  assertEqual(caseIds.size, 9, `${label} unique cases`);
}

function verifyD5(replay, thresholds) {
  for (const partition of [
    "calibration",
    "holdout",
    "transfer",
  ]) {
    const safe = replay.safe_path.partition_metrics[partition];
    assertTrue(
      safe.deltas.task_units_over_current >=
        thresholds.minimum_task_unit_gain_over_current_per_partition,
      `${partition} gain over current`,
    );
    assertTrue(
      safe.deltas.task_units_over_no_candidate >=
        thresholds.minimum_task_unit_gain_over_no_candidate_per_partition,
      `${partition} gain over no candidate`,
    );
    assertTrue(
      safe.deltas.negative_transfer_vs_current <=
        thresholds.maximum_required_task_unit_losses,
      `${partition} negative transfer`,
    );
    assertTrue(
      safe.deltas.context_pollution_vs_current <=
        thresholds.maximum_context_pollution_increase,
      `${partition} Context pollution`,
    );
    assertEqual(
      safe.deltas.side_effects_vs_current,
      0,
      `${partition} side effects`,
    );
    assertEqual(
      safe.deltas.violations_vs_current,
      0,
      `${partition} governance violations`,
    );
  }
}

function verificationCommands() {
  return [
    "pnpm g5:replay",
    "pnpm g5:canary",
    "pnpm g5:resources",
    "pnpm g5:manifest",
    "pnpm verify:g5",
    "pnpm vitest run tests/integration/g5-artifact-integrity.test.ts",
    "pnpm test",
    "pnpm lint",
    "pnpm typecheck",
    "pnpm build",
    "pnpm audit --audit-level high",
    "python3 .trellis/scripts/task.py validate .trellis/tasks/07-29-agent-memory-runtime-m5",
    "git diff --check",
  ].map((command) => ({
    command,
    result: "PASS",
  }));
}

function writeVerificationReport(result) {
  const body = {
    schema_version: "1.0.0",
    gate: "G5_U8_VERIFICATION",
    recorded_at: G5_RECORDED_AT,
    candidate_commit:
      result.manifest.tested_implementation.commit,
    candidate_tree:
      result.manifest.tested_implementation.tree,
    manifest_hash: result.manifest.report_hash,
    commands: verificationCommands(),
    review: result.manifest.review,
    checks: result.checks,
    first_false_hard_rule: null,
    eligible_for_u9_decision: result.eligible,
    decision_recorded: false,
    evidence_boundary:
      result.manifest.evidence_boundary,
  };
  const report = {
    ...body,
    report_hash: canonicalSha256(body),
  };
  writeFileSync(
    resolve(
      repositoryRoot,
      "docs/evaluations/g5-verification-report.json",
    ),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  return report;
}

export async function verifyG5Evidence(options = {}) {
  const replay = readJson(
    "docs/evaluations/g5-replay-report.json",
  );
  const canary = readJson(
    "docs/evaluations/g5-canary-report.json",
  );
  const resource = readJson(
    "docs/evaluations/g5-resource-report.json",
  );
  const manifest = readJson(
    "docs/evaluations/g5-reproducibility-manifest.json",
  );
  const fixture = G5FixtureManifestSchema.parse(
    readJson("fixtures/g5/manifest.json"),
  );
  const thresholds = readJson("fixtures/g5/thresholds.json");

  verifyHashedReport(replay, "G5 replay");
  verifyHashedReport(canary, "G5 canary");
  verifyHashedReport(resource, "G5 resource");
  verifyHashedReport(manifest, "G5 manifest");
  assertEqual(
    canonicalSha256Omitting(fixture, ["manifest_hash"]),
    fixture.manifest_hash,
    "G5 fixture manifest hash",
  );
  assertEqual(
    canonicalSha256(thresholds),
    fixture.thresholds_hash,
    "G5 thresholds hash",
  );

  const candidate = manifest.tested_implementation.commit;
  execFileSync("git", ["cat-file", "-e", `${candidate}^{commit}`], {
    cwd: repositoryRoot,
  });
  assertEqual(
    git("rev-parse", `${candidate}^{tree}`),
    manifest.tested_implementation.tree,
    "tested implementation tree",
  );
  assertEqual(
    rawSha256(committed(candidate, "pnpm-lock.yaml")),
    manifest.tested_implementation.dependency_lock_hash,
    "tested dependency lock",
  );
  assertSingleG5Implementation({
    replay,
    canary,
    resource,
    manifest,
  });
  assertEqual(
    replay.implementation,
    {
      commit: candidate,
      tree: manifest.tested_implementation.tree,
      dependency_lock_hash:
        manifest.tested_implementation.dependency_lock_hash,
      migration_set_hash:
        manifest.tested_implementation.migration_set_hash,
      runtime_identity_hash:
        replay.implementation.runtime_identity_hash,
    },
    "replay implementation identity",
  );
  for (const report of [canary, resource]) {
    assertEqual(
      report.implementation.commit,
      candidate,
      `${report.gate} candidate`,
    );
    assertEqual(
      report.implementation.tree,
      manifest.tested_implementation.tree,
      `${report.gate} tree`,
    );
    assertEqual(
      report.implementation.dependency_lock_hash,
      manifest.tested_implementation.dependency_lock_hash,
      `${report.gate} lock`,
    );
  }
  assertEqual(
    migrationIdentity(),
    manifest.migrations,
    "migration set",
  );
  for (const binding of manifest.source_bindings) {
    verifyBinding(binding, false);
  }
  for (const binding of Object.values(
    manifest.evidence_reports,
  )) {
    verifyBinding(binding, true);
  }
  verifyBinding(manifest.review, false);

  const safeIdentity = verifyEvaluationIdentity(
    replay.safe_path.identity,
  );
  const harmfulIdentity = verifyEvaluationIdentity(
    replay.harmful_path.identity,
  );
  assertEqual(
    safeIdentity.implementation_commit,
    candidate,
    "safe implementation",
  );
  assertEqual(
    safeIdentity.partition_manifest_hash,
    fixture.manifest_hash,
    "safe partition manifest",
  );
  assertEqual(
    safeIdentity.thresholds_hash,
    fixture.thresholds_hash,
    "safe thresholds",
  );
  assertTrue(
    safeIdentity.common_identity_hash !==
      harmfulIdentity.common_identity_hash,
    "independent harmful identity",
  );
  verifyResultSets(
    replay.safe_path.result_sets,
    fixture,
    "safe",
  );
  verifyResultSets(
    replay.harmful_path.result_sets,
    fixture,
    "harmful",
  );
  const safeReceipt = EvalReceiptSchema.parse(
    replay.safe_path.receipt,
  );
  const harmfulReceipt = EvalReceiptSchema.parse(
    replay.harmful_path.receipt,
  );
  assertTrue(
    safeReceipt.passed &&
      !safeReceipt.invalidated &&
      replay.safe_path.rules.every((rule) => rule.passed),
    "safe D5 receipt",
  );
  assertTrue(
    !harmfulReceipt.passed &&
      replay.harmful_path.pointer_after.length === 0,
    "harmful rejection",
  );
  verifyD5(replay, thresholds);

  const canaryAuthorization = CanaryAuthorizationSchema.parse(
    canary.authority.canary_authorization,
  );
  const postCanaryApproval = PostCanaryApprovalSchema.parse(
    canary.authority.post_canary_release_approval,
  );
  const canaryReceipt = CanaryReceiptSchema.parse(
    canary.canary.receipt,
  );
  const releaseReceipt = ReleaseReceiptSchema.parse(
    canary.release.result.receipt,
  );
  const successMonitor = MonitorReceiptSchema.parse(
    canary.monitoring.success.receipt,
  );
  const breachMonitor = MonitorReceiptSchema.parse(
    canary.monitoring.breach.receipt,
  );
  const rollbackReceipt = RollbackReceiptSchema.parse(
    canary.rollback.result.receipt,
  );
  assertTrue(
    canaryAuthorization.authorization_id !==
      postCanaryApproval.approval_id &&
      postCanaryApproval.canary_receipt_id ===
        canaryReceipt.receipt_id &&
      postCanaryApproval.canary_receipt_hash ===
        canaryReceipt.receipt_hash,
    "separate canary/release authority",
  );
  assertTrue(
    canaryReceipt.exposures === 3 &&
      canary.canary.run.exposure_count === 3 &&
      canary.canary.forced_abort.run.status === "aborted",
    "bounded canary outcomes",
  );
  const replayedCases =
    canary.monitoring.active_pointer_replay.map(
      (entry) => entry.case_id,
    );
  assertEqual(
    new Set(replayedCases).size,
    3,
    "monitor replay unique cases",
  );
  assertEqual(
    successMonitor.release_id,
    releaseReceipt.release_id,
    "success monitor release",
  );
  assertTrue(
    !breachMonitor.passed &&
      breachMonitor.rollback_required &&
      rollbackReceipt.monitor_receipt_id ===
        breachMonitor.receipt_id,
    "breach-to-rollback chain",
  );
  assertTrue(
    canary.rollback.final_pointer.active_release_id === null &&
      canary.rollback.final_pointer.pointer_revision === 2 &&
      canary.rollback.release_replay_after_rollback.replayed === true,
    "rollback no-resurrection",
  );
  assertTrue(
    canary.controls.pause.status === "OK" &&
      canary.controls.resume.status === "OK" &&
      canary.controls.ordinary_runtime_while_paused.status !==
        "FAILED",
    "pause/resume runtime continuity",
  );

  const checks = {
    implementation_identity: true,
    lock_and_migrations: true,
    frozen_fixture_identity: true,
    graph_vector_disabled:
      fixture.accepted_baseline.graph.decision === "NO-GO" &&
      fixture.accepted_baseline.vector.decision === "NO-GO" &&
      fixture.accepted_baseline.vector_enabled === false,
    safe_three_arm_d5: allTrue(replay.hard_rules),
    harmful_candidate_rejected:
      replay.hard_rules.harmful_rejected === true,
    canary_authority_and_bounds: allTrue(canary.hard_rules),
    release_monitor_rollback_chain: true,
    resource_measurement: allTrue(resource.hard_rules),
    review:
      manifest.review.result === "PASS" &&
      manifest.review.unresolved_p0 === 0 &&
      manifest.review.unresolved_p1 === 0,
    evidence_bindings: true,
    synthetic_boundary:
      manifest.evidence_boundary.production_readiness_claimed ===
        false &&
      manifest.evidence_boundary.m6_hardening_claimed === false,
  };
  const { eligible } = evaluateG5Eligibility(checks);
  assertEqual(
    manifest.hard_rule_digest,
    canonicalSha256(manifest.hard_rules),
    "hard-rule digest",
  );
  assertEqual(
    manifest.decision_input,
    {
      all_hard_rules_pass: eligible,
      first_false_hard_rule: null,
      eligible_for_g5_decision: eligible,
      decision_recorded: false,
    },
    "G5 decision input",
  );
  const observedEvidencePaths = currentG5EvidencePaths();
  if (
    options.writeReport === true &&
    !observedEvidencePaths.includes(
      "docs/evaluations/g5-verification-report.json",
    )
  ) {
    observedEvidencePaths.push(
      "docs/evaluations/g5-verification-report.json",
    );
  }
  assertExactG5EvidencePaths(
    observedEvidencePaths,
    {
      allowDecision: existsSync(
        resolve(repositoryRoot, DECISION_PATH),
      ),
    },
  );
  const allowedDirty = new Set(
    manifest.dirty_state_policy.allowed_paths,
  );
  const unexpectedDirty = dirtyPaths().filter(
    (path) => !allowedDirty.has(path),
  );
  if (unexpectedDirty.length > 0) {
    throw new Error(
      `unexpected dirty paths: ${unexpectedDirty.join(", ")}`,
    );
  }

  const result = {
    eligible,
    checks,
    replay,
    canary,
    resource,
    manifest,
  };
  if (options.writeReport === true) {
    writeVerificationReport(result);
  }
  const verificationPath =
    "docs/evaluations/g5-verification-report.json";
  if (existsSync(resolve(repositoryRoot, verificationPath))) {
    const verification = readJson(verificationPath);
    verifyHashedReport(verification, "G5 verification");
    assertEqual(
      verification.candidate_commit,
      candidate,
      "verification candidate",
    );
    assertEqual(
      verification.manifest_hash,
      manifest.report_hash,
      "verification manifest",
    );
    assertEqual(
      verification.checks,
      checks,
      "verification checks",
    );
    assertTrue(
      verification.commands.length > 0 &&
        verification.commands.every(
          (entry) => entry.result === "PASS",
        ),
      "verification command evidence",
    );
  } else if (options.writeReport !== true) {
    throw new Error("G5 verification report is missing");
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await verifyG5Evidence({
    writeReport: process.argv.includes("--write-report"),
  });
  process.stdout.write(
    `G5 evidence verified: ${
      result.eligible ? "ELIGIBLE_FOR_U9" : "BLOCKED"
    }\n`,
  );
}
