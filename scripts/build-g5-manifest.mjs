import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import process from "node:process";

import {
  canonicalSha256,
} from "../packages/contracts/dist/index.js";
import {
  G5_RECORDED_AT,
  git,
  migrationIdentity,
  readJson,
  repositoryRoot,
  sourceBinding,
  writeHashedReport,
} from "./g5-evidence-common.mjs";

function filesUnder(root) {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory() ? filesUnder(path) : [path];
    })
    .map((path) =>
      relative(repositoryRoot, path).replaceAll("\\", "/")
    )
    .sort();
}

function reportBinding(path) {
  const report = readJson(path);
  return {
    ...sourceBinding(path, true),
    report_hash: report.report_hash,
  };
}

const replay = readJson(
  "docs/evaluations/g5-replay-report.json",
);
const canary = readJson(
  "docs/evaluations/g5-canary-report.json",
);
const resource = readJson(
  "docs/evaluations/g5-resource-report.json",
);
const fixtureManifest = readJson("fixtures/g5/manifest.json");
const migration = migrationIdentity();
const testedCommit = replay.implementation.commit;
const hardRuleGroups = {
  replay: replay.hard_rules,
  canary: canary.hard_rules,
  resource: resource.hard_rules,
};
if (
  replay.implementation.commit !== canary.implementation.commit ||
  replay.implementation.commit !== resource.implementation.commit ||
  replay.implementation.tree !== canary.implementation.tree ||
  replay.implementation.tree !== resource.implementation.tree ||
  Object.values(hardRuleGroups).some((group) =>
    Object.values(group).some((passed) => passed !== true)
  )
) {
  throw new Error("G5 evidence reports are not manifest-ready");
}

const sourcePaths = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "vitest.config.ts",
  "migrations/0014-learning-lab.sql",
  "tests/helpers/g5-replay.ts",
  "tests/helpers/g5-canary.ts",
  "tests/helpers/g5-release.ts",
  "tests/helpers/learning-examples.ts",
  "scripts/g5-evidence-common.mjs",
  "scripts/run-g5-replay.mjs",
  "scripts/run-g5-canary.mjs",
  "scripts/run-g5-resource-report.mjs",
  "scripts/build-g5-manifest.mjs",
  "scripts/verify-g4b-evidence.d.mts",
  "scripts/verify-g5-evidence.d.mts",
  "scripts/verify-g5-evidence.mjs",
  "tests/integration/g5-artifact-integrity.test.ts",
];
const fixturePaths = filesUnder(
  resolve(repositoryRoot, "fixtures/g5"),
);
const evidenceReports = {
  replay: reportBinding(
    "docs/evaluations/g5-replay-report.json",
  ),
  canary: reportBinding(
    "docs/evaluations/g5-canary-report.json",
  ),
  resource: reportBinding(
    "docs/evaluations/g5-resource-report.json",
  ),
};
const reviewBinding = sourceBinding(
  "docs/evaluations/g5-code-review.md",
);
const workspacePackages = [
  "@memo-graph/context-compiler",
  "@memo-graph/contracts",
  "@memo-graph/graph-projection",
  "@memo-graph/learning-lab",
  "@memo-graph/mcp-server",
  "@memo-graph/memory-kernel",
  "@memo-graph/storage-sqlite",
  "@memo-graph/vector-retrieval",
].map((name) => {
  const packageName = name.slice("@memo-graph/".length);
  const path = `packages/${packageName}`;
  return {
    name,
    path,
    git_tree: git("rev-parse", `${testedCommit}:${path}`),
  };
});
const allowedDecisionPaths = [
  ".trellis/tasks/07-29-agent-memory-runtime-m5/task.json",
  ".trellis/tasks/07-29-agent-memory-runtime-m5/implement.md",
  "docs/adr/0005-governed-learning-release.md",
  "docs/evaluations/g5-decision.md",
  "docs/plans/2026-07-28-001-feat-agent-memory-runtime-plan.md",
  "docs/plans/2026-07-29-005-feat-governed-learning-lab-plan.md",
];
const allowedPaths = [
  ...sourcePaths,
  ...fixturePaths,
  ...Object.values(evidenceReports).map((entry) => entry.path),
  reviewBinding.path,
  "docs/evaluations/g5-reproducibility-manifest.json",
  "docs/evaluations/g5-verification-report.json",
  ...allowedDecisionPaths,
].sort();
const manifest = writeHashedReport(
  "docs/evaluations/g5-reproducibility-manifest.json",
  {
    schema_version: "1.0.0",
    gate: "G5_U8_EVIDENCE",
    evaluation_status: "EVIDENCE_READY",
    decision_status: "PENDING_U9",
    recorded_at: G5_RECORDED_AT,
    tested_implementation: {
      commit: testedCommit,
      tree: replay.implementation.tree,
      dependency_lock_hash:
        replay.implementation.dependency_lock_hash,
      migration_set_hash:
        replay.implementation.migration_set_hash,
      executable_frozen_before_evidence: true,
      reviewed_runtime_commit:
        "02bb7a1824e710b0736ee6e35c02b7d7e8925abc",
      reviewed_runtime_tree:
        "6ba5d29b3f51fb63d604a39c984e3ffc2f69b74b",
    },
    accepted_baseline: fixtureManifest.accepted_baseline,
    workspace_packages: workspacePackages,
    migrations: migration,
    environment: replay.environment,
    frozen_inputs: {
      manifest: sourceBinding("fixtures/g5/manifest.json", true),
      thresholds: sourceBinding(
        "fixtures/g5/thresholds.json",
        true,
      ),
      fixtures: fixturePaths.map((path) =>
        sourceBinding(path, true)
      ),
      fixture_manifest_hash: fixtureManifest.manifest_hash,
      thresholds_hash: fixtureManifest.thresholds_hash,
      corpus_hash: replay.safe_path.identity.corpus_hash,
      partition_manifest_hash:
        replay.safe_path.identity.partition_manifest_hash,
      scorer_hash: replay.safe_path.identity.scorer_hash,
      seed: replay.safe_path.identity.seed,
    },
    configuration: {
      retrieval_configuration_hash:
        fixtureManifest.accepted_baseline
          .retrieval_configuration_hash,
      graph_decision:
        fixtureManifest.accepted_baseline.graph.decision,
      vector_decision:
        fixtureManifest.accepted_baseline.vector.decision,
      graph_enabled: false,
      vector_enabled: false,
      sqlite_authoritative: true,
    },
    evaluation: {
      safe_candidate_id:
        replay.safe_path.candidate.candidate_id,
      safe_candidate_hash:
        replay.safe_path.candidate.candidate_hash,
      safe_common_identity_hash:
        replay.safe_path.identity.common_identity_hash,
      safe_evaluation_receipt_hash:
        replay.safe_path.receipt.receipt_hash,
      harmful_common_identity_hash:
        replay.harmful_path.identity.common_identity_hash,
      harmful_evaluation_receipt_hash:
        replay.harmful_path.receipt.receipt_hash,
      canary_authorization_hash:
        canary.authority.canary_authorization.authorization_hash,
      canary_receipt_hash:
        canary.canary.receipt.receipt_hash,
      release_approval_hash:
        canary.authority.post_canary_release_approval
          .approval_hash,
      release_receipt_hash:
        canary.release.result.receipt.receipt_hash,
      success_monitor_receipt_hash:
        canary.monitoring.success.receipt.receipt_hash,
      breach_monitor_receipt_hash:
        canary.monitoring.breach.receipt.receipt_hash,
      rollback_receipt_hash:
        canary.rollback.result.receipt.receipt_hash,
      final_pointer_hash:
        canary.rollback.final_pointer.pointer_hash,
    },
    source_bindings: sourcePaths.map((path) =>
      sourceBinding(path)
    ),
    evidence_reports: evidenceReports,
    review: {
      ...reviewBinding,
      result: "PASS",
      unresolved_p0: 0,
      unresolved_p1: 0,
      lower_debt_recorded: true,
    },
    hard_rules: hardRuleGroups,
    hard_rule_digest: canonicalSha256(hardRuleGroups),
    decision_input: {
      all_hard_rules_pass: true,
      first_false_hard_rule: null,
      eligible_for_g5_decision: true,
      decision_recorded: false,
    },
    dirty_state_policy: {
      base_commit: testedCommit,
      policy:
        "Only hash-bound U8 evidence and explicit U9 decision paths may differ from the frozen implementation.",
      allowed_paths: allowedPaths,
      allowed_decision_paths: allowedDecisionPaths,
    },
    evidence_boundary: {
      local_synthetic_evidence: true,
      production_traffic: false,
      production_readiness_claimed: false,
      m6_hardening_claimed: false,
    },
  },
);

process.stdout.write(
  `G5 reproducibility manifest: ${manifest.report_hash}\n`,
);
