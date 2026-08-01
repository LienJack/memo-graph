import process from "node:process";

import {
  currentCandidateIdentity,
  deriveProofStates,
  readJson,
  runEvidenceProofs,
  sourceBinding,
  writeCanonicalJson,
} from "./g6-evidence-common.mjs";

export function runG6ResourceReport() {
  const fixture = readJson("fixtures/g6/resources/workloads.json");
  const thresholds = readJson("fixtures/g6/thresholds.json");
  const expectedObligations = fixture.proofs.map(
    ({ obligations }) => obligations,
  ).flat();
  const commands = runEvidenceProofs(
    fixture.proofs.map(
      ({ id, obligations, test_file: testFile, test_name: testName }) => ({
        id: `resource:${id}`,
        obligations,
        program: "pnpm",
        args: ["vitest", "run", testFile, "-t", testName],
      }),
    ),
    expectedObligations,
    "resource",
  );
  const proofStates = deriveProofStates(
    commands,
    expectedObligations,
    "resource",
  );
  const observedStates = commands.flatMap(({ obligations, state }) =>
    obligations.length === 1
      ? [state]
      : obligations.map(() => "blocked"),
  );
  const state = observedStates.every((proofState) => proofState === "pass")
    ? "pass"
    : observedStates.some((proofState) => proofState === "blocked")
      ? "blocked"
      : "fail";
  const report = {
    schema_version: "1.0.0",
    gate: "G6",
    family: "resource_pressure",
    candidate: currentCandidateIdentity(),
    state,
    commands,
    workload_results: Object.fromEntries(
      Object.keys(fixture.workloads).map((name) => [
        name,
        {
          admission_hysteresis:
            proofStates[`${name}:admission_hysteresis`] === "pass",
          bounded_queue:
            proofStates[`${name}:bounded_queue`] === "pass",
          checkpoint_convergence:
            proofStates[`${name}:checkpoint_convergence`] === "pass",
          maintenance_exclusion:
            proofStates[`${name}:maintenance_exclusion`] === "pass",
        },
      ]),
    ),
    claim_boundary: thresholds.claim_boundary,
    source_bindings: [
      sourceBinding("fixtures/g6/resources/workloads.json", true),
      sourceBinding("fixtures/g6/thresholds.json", true),
      sourceBinding("scripts/run-g6-resource-report.mjs"),
    ],
  };
  writeCanonicalJson(
    "docs/evaluations/g6-resource-report.json",
    report,
  );
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = runG6ResourceReport();
  process.stdout.write(`${JSON.stringify({ state: report.state })}\n`);
  if (report.state !== "pass") process.exitCode = 1;
}
