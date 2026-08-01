import { Buffer } from "node:buffer";
import { verify } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import process from "node:process";
import { URL } from "node:url";

import { buildG6RuntimeIdentity } from "./build-g6-runtime-identity.mjs";
import {
  artifactBinding,
  assertContentFreeEvidence,
  assertExactG6EvidencePaths,
  canonicalEvidenceArgv,
  canonicalJson,
  canonicalSha256,
  deriveProofStates,
  evaluateFirstFalse,
  loadG6Fixture,
  readJson,
  sourceBinding,
  validateG6Fixture,
  writeCanonicalJson,
} from "./g6-evidence-common.mjs";

const REPORT_PATHS = Object.freeze({
  fault: "docs/evaluations/g6-fault-report.json",
  resource: "docs/evaluations/g6-resource-report.json",
  runbook: "docs/evaluations/g6-runbook-report.json",
  security: "docs/evaluations/g6-security-report.json",
  supply_chain: "docs/evaluations/g6-supply-chain-report.json",
});

const CODE_REVIEW_LENSES = Object.freeze([
  "correctness",
  "maintainability",
  "testing",
  "project-standards",
  "security",
  "data-integrity",
  "reliability",
  "performance",
  "api-contract",
]);

function assertExactObjectKeys(value, expected, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    canonicalJson(Object.keys(value).sort()) !==
      canonicalJson([...expected].sort())
  ) {
    throw new Error(`G6 ${label} schema is invalid`);
  }
}

export function validateG6CodeReviewArtifact(raw, expectedCandidate) {
  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    throw new Error("G6 code-review artifact is not valid JSON");
  }
  if (`${canonicalJson(report)}\n` !== raw) {
    throw new Error("G6 code-review artifact is not canonical JSON");
  }
  assertExactObjectKeys(
    report,
    [
      "schema_version",
      "gate",
      "family",
      "candidate",
      "review_state",
      "lenses",
      "unresolved_p0",
      "unresolved_p1",
      "lower_priority_debt_recorded",
    ],
    "code-review artifact",
  );
  assertExactObjectKeys(
    report.candidate,
    ["commit", "tree", "tested_implementation_digest"],
    "code-review candidate",
  );
  if (
    report.schema_version !== "1.0.0" ||
    report.gate !== "G6" ||
    report.family !== "independent_review" ||
    canonicalJson(report.candidate) !==
      canonicalJson(expectedCandidate) ||
    !Array.isArray(report.lenses) ||
    report.lenses.length !== CODE_REVIEW_LENSES.length ||
    typeof report.lower_priority_debt_recorded !== "boolean"
  ) {
    throw new Error("G6 code-review candidate or identity is invalid");
  }
  const lensIds = [];
  let unresolvedP0 = 0;
  let unresolvedP1 = 0;
  let allLensesPass = true;
  for (const lens of report.lenses) {
    assertExactObjectKeys(
      lens,
      ["id", "state", "unresolved_p0", "unresolved_p1"],
      "code-review lens",
    );
    if (
      !CODE_REVIEW_LENSES.includes(lens.id) ||
      !["pass", "fail"].includes(lens.state) ||
      !Number.isSafeInteger(lens.unresolved_p0) ||
      lens.unresolved_p0 < 0 ||
      !Number.isSafeInteger(lens.unresolved_p1) ||
      lens.unresolved_p1 < 0
    ) {
      throw new Error("G6 code-review lens is invalid");
    }
    lensIds.push(lens.id);
    unresolvedP0 += lens.unresolved_p0;
    unresolvedP1 += lens.unresolved_p1;
    allLensesPass &&= lens.state === "pass";
  }
  if (
    canonicalJson(lensIds) !== canonicalJson(CODE_REVIEW_LENSES) ||
    report.unresolved_p0 !== unresolvedP0 ||
    report.unresolved_p1 !== unresolvedP1
  ) {
    throw new Error("G6 code-review lens coverage is invalid");
  }
  const passed =
    allLensesPass && unresolvedP0 === 0 && unresolvedP1 === 0;
  if (report.review_state !== (passed ? "pass" : "fail")) {
    throw new Error("G6 code-review aggregate state is invalid");
  }
  assertContentFreeEvidence(report);
  return { report, passed };
}

function observedEvidencePaths(includePendingVerification) {
  const paths = readdirSync(
    new URL("../docs/evaluations", import.meta.url),
  )
    .filter((name) => name.startsWith("g6-"))
    .map((name) => `docs/evaluations/${name}`)
    .filter(
      (path) =>
        ![
          "docs/evaluations/g6-decision.md",
          "docs/evaluations/g6-handoff.md",
          "docs/evaluations/g6-release-control.json",
        ].includes(path),
    );
  if (
    includePendingVerification &&
    !paths.includes("docs/evaluations/g6-verification-report.json")
  ) {
    paths.push("docs/evaluations/g6-verification-report.json");
  }
  return paths;
}

function verifyArtifactBindings(manifest) {
  for (const binding of manifest.artifact_bindings) {
    const expected = artifactBinding(
      binding.artifact_name,
      "canonical_digest" in binding,
    );
    if (canonicalJson(binding) !== canonicalJson(expected)) {
      throw new Error(
        `G6 artifact binding mismatch: ${binding.artifact_name}`,
      );
    }
  }
}

function verifySourceBindings(bindings) {
  for (const binding of bindings) {
    const expected = sourceBinding(
      binding.path,
      "canonical_hash" in binding,
    );
    if (canonicalJson(binding) !== canonicalJson(expected)) {
      throw new Error(`G6 source binding mismatch: ${binding.path}`);
    }
  }
}

function commandsState(commands) {
  const states = commands.flatMap(({ obligations, state }) =>
    obligations.length === 1
      ? [state]
      : obligations.map(() => "blocked"),
  );
  if (states.every((state) => state === "pass")) return "pass";
  return states.some((state) => state === "blocked")
    ? "blocked"
    : "fail";
}

function allBooleanLeavesTrue(value) {
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.length > 0 && value.every(allBooleanLeavesTrue);
  }
  if (value !== null && typeof value === "object") {
    const values = Object.values(value);
    return values.length > 0 && values.every(allBooleanLeavesTrue);
  }
  return false;
}

function verifyProofClaims(name, report, fixture) {
  if (name === "fault") {
    const expectedFaults = fixture.fault_points.map(
      (faultPoint) => `fault:${faultPoint}`,
    );
    const expectedAcceptance = Object.keys(
      fixture.recovery_fixture.acceptance_examples,
    ).flatMap((id) => [
      `acceptance:${id}:success`,
      `acceptance:${id}:failure`,
    ]);
    const states = deriveProofStates(
      report.commands,
      [...expectedFaults, ...expectedAcceptance],
      "fault and acceptance report",
    );
    const expectedFaultStates = fixture.fault_points.map(
      (faultPoint) => ({
        id: faultPoint,
        state: states[`fault:${faultPoint}`],
      }),
    );
    const allFaultsPass = expectedFaultStates.every(
      ({ state }) => state === "pass",
    );
    const expectedOracles = Object.fromEntries(
      fixture.fault_fixture.required_oracles.map((oracle) => [
        oracle,
        allFaultsPass,
      ]),
    );
    const expectedExamples = Object.fromEntries(
      Object.keys(
        fixture.recovery_fixture.acceptance_examples,
      ).map((id) => [
        id,
        {
          success_oracle:
            states[`acceptance:${id}:success`] === "pass",
          failure_oracle:
            states[`acceptance:${id}:failure`] === "pass",
        },
      ]),
    );
    if (
      canonicalJson(report.fault_points) !==
        canonicalJson(expectedFaultStates) ||
      canonicalJson(report.oracles) !== canonicalJson(expectedOracles) ||
      canonicalJson(report.acceptance_examples) !==
        canonicalJson(expectedExamples)
    ) {
      throw new Error("G6 fault proof claim mismatch");
    }
    return;
  }
  if (name === "security") {
    const obligations = fixture.evidence_policy.proofs.map(
      ({ obligation }) => obligation,
    );
    const states = deriveProofStates(
      report.commands,
      obligations,
      "security report",
    );
    const expectedChecks = Object.fromEntries(
      obligations.map((obligation) => [
        obligation,
        states[obligation] === "pass",
      ]),
    );
    if (
      canonicalJson(report.checks) !== canonicalJson(expectedChecks)
    ) {
      throw new Error("G6 security proof claim mismatch");
    }
    return;
  }
  if (name === "resource") {
    const obligations = fixture.resource_fixture.proofs.flatMap(
      ({ obligations: proofObligations }) => proofObligations,
    );
    const states = deriveProofStates(
      report.commands,
      obligations,
      "resource report",
    );
    const expectedResults = Object.fromEntries(
      Object.keys(fixture.resource_fixture.workloads).map((workload) => [
        workload,
        {
          admission_hysteresis:
            states[`${workload}:admission_hysteresis`] === "pass",
          bounded_queue:
            states[`${workload}:bounded_queue`] === "pass",
          checkpoint_convergence:
            states[`${workload}:checkpoint_convergence`] === "pass",
          maintenance_exclusion:
            states[`${workload}:maintenance_exclusion`] === "pass",
        },
      ]),
    );
    if (
      canonicalJson(report.workload_results) !==
      canonicalJson(expectedResults)
    ) {
      throw new Error("G6 resource proof claim mismatch");
    }
    return;
  }
  if (name === "runbook") {
    const obligations = fixture.runbook_fixture.steps.map(({ id }) => id);
    const states = deriveProofStates(
      report.commands,
      obligations,
      "runbook report",
    );
    const expectedSteps = fixture.runbook_fixture.steps.map(
      ({ id, automation }) => ({
        id,
        automation,
        grammar_verified: report.grammar_command.state === "pass",
        proof_test_passed: states[id] === "pass",
        direct_automation_observed: false,
        typed_result_verified: false,
      }),
    );
    if (
      canonicalJson(report.grammar_command.command) !==
        canonicalJson(
          canonicalEvidenceArgv("pnpm", [
            "vitest",
            "run",
            "tests/fixtures/g6.fixture.test.ts",
            "-t",
            "parses every frozen runbook automation with the actual CLI grammar",
          ]),
        ) ||
      canonicalJson(report.steps) !== canonicalJson(expectedSteps)
    ) {
      throw new Error("G6 runbook proof claim mismatch");
    }
  }
}

export function deriveG6ReportState(name, report) {
  if (name === "fault") {
    const commandState = commandsState(report.commands);
    if (commandState !== "pass") return commandState;
    return allBooleanLeavesTrue(report.oracles) &&
      allBooleanLeavesTrue(report.acceptance_examples)
      ? "pass"
      : "fail";
  }
  if (name === "security") {
    const commandState = commandsState(report.commands);
    if (commandState !== "pass") return commandState;
    return allBooleanLeavesTrue(report.checks) ? "pass" : "fail";
  }
  if (name === "resource") {
    const commandState = commandsState(report.commands);
    if (commandState !== "pass") return commandState;
    return allBooleanLeavesTrue(report.workload_results)
      ? "pass"
      : "fail";
  }
  if (name === "runbook") {
    const commandState = commandsState(report.commands);
    if (commandState !== "pass") return commandState;
    if (report.grammar_command.state !== "pass") {
      return report.grammar_command.state;
    }
    return report.steps.every(
        ({
          grammar_verified: grammarVerified,
          proof_test_passed: proofTestPassed,
          direct_automation_observed: directAutomationObserved,
          typed_result_verified: typedResultVerified,
        }) =>
          grammarVerified === true &&
          proofTestPassed === true &&
          directAutomationObserved === true &&
          typedResultVerified === true,
      )
      ? "pass"
      : "blocked";
  }
  const firstNonPass = Object.entries(report.checks).find(
    ([, state]) => state !== "pass",
  );
  const bootstrap = report.bootstrap;
  if (
    bootstrap === null ||
    typeof bootstrap !== "object" ||
    bootstrap.scripts_disabled_install === undefined ||
    bootstrap.store_tarball_integrity === undefined ||
    bootstrap.lifecycle_inventory === undefined ||
    bootstrap.approved_package_build === undefined ||
    bootstrap.approved_local_native_build === undefined ||
    bootstrap.dependency_inventory === undefined ||
    bootstrap.provenance === undefined
  ) {
    return "fail";
  }
  const lockStoreState =
    bootstrap.scripts_disabled_install.state === "pass" &&
    bootstrap.store_tarball_integrity.state === "pass"
      ? "pass"
      : bootstrap.scripts_disabled_install.state === "blocked" ||
          bootstrap.store_tarball_integrity.state === "blocked"
        ? "blocked"
        : "fail";
  const lifecycle = bootstrap.lifecycle_inventory;
  const lifecycleCountsValid =
    Number.isSafeInteger(lifecycle.pending_build_count) &&
    lifecycle.pending_build_count > 0 &&
    Number.isSafeInteger(lifecycle.approved_pending_count) &&
    lifecycle.approved_pending_count === lifecycle.pending_build_count &&
    lifecycle.ignored_unapproved_count === 0 &&
    lifecycle.source_binding_count === lifecycle.pending_build_count &&
    lifecycle.policy_allowlist_exact === true &&
    lifecycle.pending_entries_valid === true &&
    lifecycle.pending_entries_unique === true &&
    /^sha256:[a-f0-9]{64}$/u.test(
      lifecycle.pending_builds_digest,
    ) &&
    /^sha256:[a-f0-9]{64}$/u.test(
      lifecycle.approved_pending_sources_digest,
    );
  const lifecycleState =
    lifecycle.state === "blocked"
      ? "blocked"
      : lifecycle.state === "pass" && lifecycleCountsValid
        ? "pass"
        : "fail";
  const nativeBuildState =
    bootstrap.approved_package_build.state === "pass" &&
    bootstrap.approved_local_native_build.state === "pass" &&
    report.native_outputs.state === "pass"
      ? "pass"
      : report.native_outputs.state === "blocked" ||
          bootstrap.approved_package_build.state === "blocked" ||
          bootstrap.approved_local_native_build.state === "blocked"
        ? "blocked"
        : "fail";
  const state = firstNonPass?.[1] ?? "pass";
  if (
    report.first_non_pass !== (firstNonPass?.[0] ?? null) ||
    report.checks.lock_store_tarball !== lockStoreState ||
    lifecycle.state !== lifecycleState ||
    report.checks.lifecycle_inventory !== lifecycleState ||
    report.checks.approved_native_builds !== nativeBuildState ||
    report.checks.sbom !== bootstrap.dependency_inventory.state ||
    report.checks.provenance !== bootstrap.provenance.state ||
    report.checks.runtime_downloads !==
      report.runtime_download_scan.state ||
    report.checks.vulnerability_audit !== report.audit.state ||
    (report.audit.state !== "pass" && nativeBuildState === "pass") ||
    report.audit.registry_available !==
      (report.audit.state !== "blocked") ||
    (report.native_outputs.state === "pass" &&
      !report.native_outputs.outputs.every(
        ({ verified }) => verified === true,
      ))
  ) {
    return "fail";
  }
  return state;
}

function reportState(name, report, manifest, fixture) {
  assertContentFreeEvidence(report);
  if (
    report.schema_version !== "1.0.0" ||
    report.gate !== "G6" ||
    !["pass", "fail", "blocked"].includes(report.state) ||
    report.candidate.commit !== manifest.candidate.commit ||
    report.candidate.tree !== manifest.candidate.tree ||
    report.candidate.dirty_paths_allowed !== true
  ) {
    throw new Error("G6 report schema or state mismatch");
  }
  verifySourceBindings(report.source_bindings);
  if (name !== "supply_chain") {
    verifyProofClaims(name, report, fixture);
  }
  if (deriveG6ReportState(name, report) !== report.state) {
    throw new Error(`G6 ${name} report claim mismatch`);
  }
  return report.state;
}

export function deriveG6HardRules(input) {
  return {
    integrity:
      input.states.fault === "pass" &&
      input.states.resource === "pass",
    privacy: input.states.security === "pass",
    deletion: input.states.fault === "pass",
    encryption: input.states.security === "pass",
    restore: input.states.fault === "pass",
    rollback: input.states.fault === "pass",
    supply_chain:
      input.states.supply_chain === "blocked"
        ? "blocked"
        : input.states.supply_chain === "pass",
    binding:
      input.bindingPassed &&
      input.codeReviewPassed &&
      input.states.runbook === "pass",
  };
}

async function verifyCurrentControl({
  releaseArtifact,
  runtimeIdentity,
  evidenceBundleHash,
  eligible,
}) {
  if (
    releaseArtifact.evidence_binding?.evidence_bundle_hash !==
      evidenceBundleHash ||
    releaseArtifact.evidence_binding?.release_binding_hash !==
      canonicalSha256({
        control_hash: releaseArtifact.control?.control_hash,
        evidence_bundle_hash: evidenceBundleHash,
      })
  ) {
    throw new Error("G6 release control is not evidence-bound");
  }
  const {
    G6ReleaseControlSchema,
    G6ReleaseControlTrustSchema,
    g6ReleaseControlSigningPayload,
  } = await import("../packages/contracts/dist/index.js");
  const control = G6ReleaseControlSchema.parse(
    releaseArtifact.control,
  );
  const trust = G6ReleaseControlTrustSchema.parse(
    releaseArtifact.trust,
  );
  const authority = readJson("fixtures/g6/decision-authority.json");
  const verificationTime = Date.parse(
    releaseArtifact.verification_time,
  );
  const issuedAt = Date.parse(control.issued_at);
  const expiresAt = Date.parse(control.expires_at);
  const validSignature = verify(
    null,
    Buffer.from(g6ReleaseControlSigningPayload(control), "utf8"),
    {
      key: Buffer.from(trust.public_key_spki_base64url, "base64url"),
      format: "der",
      type: "spki",
    },
    Buffer.from(control.signature, "base64url"),
  );
  if (
    control.authority_key_id !== authority.authority_key_id ||
    control.authority_key_generation !==
      authority.authority_key_generation ||
    trust.authority_key_id !== authority.authority_key_id ||
    trust.authority_key_generation !==
      authority.authority_key_generation ||
    trust.public_key_spki_base64url !==
      authority.public_key_spki_base64url ||
    trust.valid_from !== authority.valid_from ||
    trust.expires_at !== authority.expires_at ||
    trust.revoked_at !== authority.revoked_at ||
    trust.maximum_control_ttl_seconds !==
      authority.maximum_control_ttl_seconds ||
    control.runtime_identity_hash !==
      runtimeIdentity.runtime_identity_hash ||
    control.tested_envelope_digest !==
      runtimeIdentity.tested_envelope_digest ||
    !Number.isFinite(verificationTime) ||
    issuedAt < Date.parse(trust.valid_from) ||
    expiresAt > Date.parse(trust.expires_at) ||
    (trust.revoked_at !== null &&
      Date.parse(trust.revoked_at) <= verificationTime) ||
    issuedAt > verificationTime ||
    expiresAt <= verificationTime ||
    (expiresAt - issuedAt) / 1_000 >
      trust.maximum_control_ttl_seconds ||
    !validSignature ||
    !control.control_id.endsWith(
      evidenceBundleHash.slice("sha256:".length),
    ) ||
    control.decision !== (eligible ? "GO" : "NO-GO") ||
    control.secret_admission_allowed !== eligible
  ) {
    throw new Error("G6 release-control verification failed");
  }
  if (!eligible) return control;
  const { verifyExactG6ReleaseControl } = await import(
    "../packages/storage-sqlite/dist/release-control.js"
  );
  return verifyExactG6ReleaseControl({
    control,
    trust,
    runtimeIdentity,
    now: releaseArtifact.verification_time,
  });
}

export async function verifyG6Evidence(options = {}) {
  const fixture = validateG6Fixture(loadG6Fixture());
  assertExactG6EvidencePaths(observedEvidencePaths(true));
  const runtimeIdentity = buildG6RuntimeIdentity();
  const manifest = readJson(
    "docs/evaluations/g6-reproducibility-manifest.json",
  );
  if (
    canonicalJson(runtimeIdentity) !==
      canonicalJson(manifest.runtime_identity) ||
    manifest.decision_recorded !== false ||
    manifest.current_release_control !== false
  ) {
    throw new Error("G6 runtime identity or pending decision mismatch");
  }
  verifyArtifactBindings(manifest);
  verifySourceBindings(manifest.source_bindings);
  if (
    canonicalJson(manifest.allowed_evidence_artifacts) !==
      canonicalJson(fixture.allowed_paths.evidence) ||
    canonicalJson(manifest.allowed_decision_artifacts) !==
      canonicalJson(fixture.allowed_paths.decision) ||
    manifest.candidate.dirty_paths_allowed !== true
  ) {
    throw new Error("G6 manifest partition or candidate mismatch");
  }
  const expectedBundleHash = canonicalSha256({
    runtime_identity_hash: runtimeIdentity.runtime_identity_hash,
    artifact_bindings: manifest.artifact_bindings,
  });
  if (manifest.evidence_bundle_hash !== expectedBundleHash) {
    throw new Error("G6 evidence bundle binding mismatch");
  }

  const reports = Object.fromEntries(
    Object.entries(REPORT_PATHS).map(([name, path]) => [
      name,
      readJson(path),
    ]),
  );
  const states = Object.fromEntries(
    Object.entries(reports).map(([name, report]) => [
      name,
      reportState(name, report, manifest, fixture),
    ]),
  );
  const codeReviewPath = new URL(
    "../docs/evaluations/g6-code-review.md",
    import.meta.url,
  );
  const codeReview = existsSync(codeReviewPath)
    ? readFileSync(codeReviewPath, "utf8")
    : "";
  const { passed: codeReviewPassed } =
    validateG6CodeReviewArtifact(codeReview, {
      commit: manifest.candidate.commit,
      tree: manifest.candidate.tree,
      tested_implementation_digest:
        runtimeIdentity.tested_implementation_digest,
    });
  const bindingPassed =
    manifest.candidate.dirty_paths_allowed === true &&
    manifest.runtime_identity.tested_implementation_digest ===
      fixture.runtime_inputs.tested_implementation_digest;
  const hardRules = deriveG6HardRules({
    states,
    bindingPassed,
    codeReviewPassed,
  });
  const eligibility = evaluateFirstFalse(hardRules);
  const releasePath = new URL(
    "../docs/evaluations/g6-release-control.json",
    import.meta.url,
  );
  const releasePresent = existsSync(releasePath);
  let currentControl = null;
  if (releasePresent) {
    if (options.allowDecision !== true) {
      throw new Error("G6 decision artifact is not allowed in U7");
    }
    const releaseArtifact = readJson(
      "docs/evaluations/g6-release-control.json",
    );
    currentControl = await verifyCurrentControl({
      releaseArtifact,
      runtimeIdentity,
      evidenceBundleHash: expectedBundleHash,
      eligible: eligibility.eligible,
    });
  }
  const verification = {
    schema_version: "1.0.0",
    gate: "G6",
    state: eligibility.eligible ? "pass" : eligibility.state,
    eligible: eligibility.eligible,
    first_non_pass: eligibility.first_non_pass,
    decision_recorded: releasePresent,
    current_control_verified: currentControl !== null,
    evidence_bundle_hash: expectedBundleHash,
    runtime_identity_hash: runtimeIdentity.runtime_identity_hash,
    tested_implementation_digest:
      runtimeIdentity.tested_implementation_digest,
    hard_rules: hardRules,
    report_states: states,
    exact_environment: fixture.thresholds.environment,
    topology: fixture.configuration.topology,
    source_bindings: [
      sourceBinding(
        "docs/evaluations/g6-reproducibility-manifest.json",
        true,
      ),
      sourceBinding("fixtures/g6/manifest.json", true),
      sourceBinding("scripts/verify-g6-evidence.mjs"),
    ],
  };
  if (options.write !== false && !releasePresent) {
    writeCanonicalJson(
      "docs/evaluations/g6-verification-report.json",
      verification,
    );
  }
  return {
    verification,
    runtimeIdentity,
    manifest,
    currentControl,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const allowDecision = existsSync(
    new URL("../docs/evaluations/g6-release-control.json", import.meta.url),
  );
  const result = await verifyG6Evidence({ allowDecision });
  process.stdout.write(`${JSON.stringify(result.verification)}\n`);
  if (!result.verification.eligible) process.exitCode = 1;
}
