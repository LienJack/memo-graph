import process from "node:process";

import {
  currentCandidateIdentity,
  deriveProofStates,
  readJson,
  runEvidenceProofs,
  sourceBinding,
  writeCanonicalJson,
} from "./g6-evidence-common.mjs";

function stateFor(commands) {
  const proofStates = commands.flatMap(({ obligations, state }) =>
    obligations.length === 1
      ? [state]
      : obligations.map(() => "blocked"),
  );
  return proofStates.every((state) => state === "pass")
    ? "pass"
    : proofStates.some((state) => state === "blocked")
      ? "blocked"
      : "fail";
}

export function runG6FaultMatrix() {
  const candidate = currentCandidateIdentity();
  const manifest = readJson("fixtures/g6/manifest.json");
  const faultFixture = readJson(
    "fixtures/g6/faults/fault-matrix.json",
  );
  const recoveryFixture = readJson(
    "fixtures/g6/recovery/acceptance-examples.json",
  );
  const faultProofDefinitions = faultFixture.fault_groups.map(
    ({ id, fault_points: faultPoints, proof }) => ({
      id: `fault-group:${id}`,
      obligations: faultPoints.map((faultPoint) => `fault:${faultPoint}`),
      program: "pnpm",
      args: [
        "vitest",
        "run",
        proof.test_file,
        "-t",
        proof.test_name,
      ],
    }),
  );
  const acceptanceProofDefinitions = Object.entries(
    recoveryFixture.acceptance_examples,
  ).map(([id, example]) => ({
    id: `acceptance:${id}`,
    obligations: [`acceptance:${id}:success`, `acceptance:${id}:failure`],
    program: "pnpm",
    args: [
      "vitest",
      "run",
      example.proof.test_file,
      "-t",
      example.proof.test_name,
    ],
  }));
  const expectedFaultObligations = manifest.fault_points.map(
    (faultPoint) => `fault:${faultPoint}`,
  );
  const expectedAcceptanceObligations = Object.keys(
    recoveryFixture.acceptance_examples,
  ).flatMap((id) => [
    `acceptance:${id}:success`,
    `acceptance:${id}:failure`,
  ]);
  const recoveryCommands = runEvidenceProofs(
    [...faultProofDefinitions, ...acceptanceProofDefinitions],
    [...expectedFaultObligations, ...expectedAcceptanceObligations],
    "fault and acceptance",
  );
  const proofStates = deriveProofStates(
    recoveryCommands,
    [...expectedFaultObligations, ...expectedAcceptanceObligations],
    "fault and acceptance",
  );
  const faultState = stateFor(recoveryCommands);
  const faultPointStates = Object.fromEntries(
    manifest.fault_points.map((faultPoint) => [
      faultPoint,
      proofStates[`fault:${faultPoint}`],
    ]),
  );
  const faultReport = {
    schema_version: "1.0.0",
    gate: "G6",
    family: "fault_recovery",
    candidate,
    state: faultState,
    commands: recoveryCommands,
    fault_point_count: manifest.fault_points.length,
    fault_group_count: faultFixture.fault_groups.length,
    fault_points: faultPointStates,
    oracles: Object.fromEntries(
      faultFixture.required_oracles.map((oracle) => [
        oracle,
        Object.values(faultPointStates).every((state) => state === "pass"),
      ]),
    ),
    acceptance_examples: Object.fromEntries(
      Object.keys(recoveryFixture.acceptance_examples).map((id) => [
        id,
        {
          success_oracle:
            proofStates[`acceptance:${id}:success`] === "pass",
          failure_oracle:
            proofStates[`acceptance:${id}:failure`] === "pass",
        },
      ]),
    ),
    source_bindings: [
      sourceBinding("fixtures/g6/manifest.json", true),
      sourceBinding("fixtures/g6/faults/fault-matrix.json", true),
      sourceBinding(
        "fixtures/g6/recovery/acceptance-examples.json",
        true,
      ),
      sourceBinding("scripts/run-g6-fault-matrix.mjs"),
    ],
  };
  writeCanonicalJson(
    "docs/evaluations/g6-fault-report.json",
    faultReport,
  );

  const evidencePolicy = readJson(
    "fixtures/g6/security/evidence-policy.json",
  );
  const expectedSecurityObligations = evidencePolicy.proofs.map(
    ({ obligation }) => obligation,
  );
  const securityCommands = runEvidenceProofs(
    evidencePolicy.proofs.map(
      ({ id, obligation, test_file: testFile, test_name: testName }) => ({
        id: `security:${id}`,
        obligations: [obligation],
        program: "pnpm",
        args: ["vitest", "run", testFile, "-t", testName],
      }),
    ),
    expectedSecurityObligations,
    "security",
  );
  const securityProofStates = deriveProofStates(
    securityCommands,
    expectedSecurityObligations,
    "security",
  );
  const securityState = stateFor(securityCommands);
  const securityReport = {
    schema_version: "1.0.0",
    gate: "G6",
    family: "encryption_secret",
    candidate,
    state: securityState,
    commands: securityCommands,
    checks: Object.fromEntries(
      expectedSecurityObligations.map((obligation) => [
        obligation,
        securityProofStates[obligation] === "pass",
      ]),
    ),
    source_bindings: [
      sourceBinding("fixtures/g6/security/evidence-policy.json", true),
      sourceBinding("fixtures/g6/decision-authority.json", true),
      sourceBinding("fixtures/g6/release-control.json", true),
      sourceBinding("scripts/run-g6-fault-matrix.mjs"),
    ],
  };
  writeCanonicalJson(
    "docs/evaluations/g6-security-report.json",
    securityReport,
  );
  return {
    fault: faultReport,
    security: securityReport,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const reports = runG6FaultMatrix();
  process.stdout.write(
    `${JSON.stringify({
      fault: reports.fault.state,
      security: reports.security.state,
    })}\n`,
  );
  if (
    reports.fault.state !== "pass" ||
    reports.security.state !== "pass"
  ) {
    process.exitCode = 1;
  }
}
