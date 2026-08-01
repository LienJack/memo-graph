import process from "node:process";

import {
  currentCandidateIdentity,
  deriveProofStates,
  readJson,
  runEvidenceCommand,
  runEvidenceProofs,
  sourceBinding,
  writeCanonicalJson,
} from "./g6-evidence-common.mjs";

export function runG6Runbooks() {
  const fixture = readJson(
    "fixtures/g6/runbooks/operator-runbooks.json",
  );
  const expectedObligations = fixture.steps.map(({ id }) => id);
  const commands = runEvidenceProofs(
    fixture.steps.map(({ id, proof }) => ({
      id: `runbook:${id}`,
      obligations: [id],
      program: "pnpm",
      args: [
        "vitest",
        "run",
        proof.test_file,
        "-t",
        proof.test_name,
      ],
    })),
    expectedObligations,
    "runbook",
  );
  const proofStates = deriveProofStates(
    commands,
    expectedObligations,
    "runbook",
  );
  const grammarCommand = runEvidenceCommand("pnpm", [
    "vitest",
    "run",
    "tests/fixtures/g6.fixture.test.ts",
    "-t",
    "parses every frozen runbook automation with the actual CLI grammar",
  ]);
  const allStates = [
    ...Object.values(proofStates),
    grammarCommand.state,
  ];
  const commandState = allStates.every((proofState) => proofState === "pass")
    ? "pass"
    : allStates.some((proofState) => proofState === "blocked")
      ? "blocked"
      : "fail";
  const state = commandState === "pass" ? "blocked" : commandState;
  const report = {
    schema_version: "1.0.0",
    gate: "G6",
    family: "operator_runbooks",
    candidate: currentCandidateIdentity(),
    state,
    commands,
    grammar_command: grammarCommand,
    steps: fixture.steps.map(({ id, automation }) => ({
      id,
      automation,
      grammar_verified: grammarCommand.state === "pass",
      proof_test_passed: proofStates[id] === "pass",
      direct_automation_observed: false,
      typed_result_verified: false,
    })),
    source_bindings: [
      sourceBinding("fixtures/g6/runbooks/operator-runbooks.json", true),
      sourceBinding("scripts/run-g6-runbooks.mjs"),
      sourceBinding("tests/fixtures/g6.fixture.test.ts"),
    ],
  };
  writeCanonicalJson(
    "docs/evaluations/g6-runbook-report.json",
    report,
  );
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = runG6Runbooks();
  process.stdout.write(`${JSON.stringify({ state: report.state })}\n`);
  if (report.state !== "pass") process.exitCode = 1;
}
