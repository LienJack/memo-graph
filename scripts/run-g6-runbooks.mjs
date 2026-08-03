import process from "node:process";

import {
  currentCandidateIdentity,
  deriveProofStates,
  g6RunRootFromArgv,
  readJson,
  runEvidenceCommand,
  runEvidenceProofs,
  sourceBinding,
  writeCanonicalJson,
  writeG6RunCanonicalJson,
} from "./g6-evidence-common.mjs";
import { runDirectG6RunbookHarness } from "./g6-runbook-harness.mjs";

export async function runG6Runbooks(options = {}) {
  const runRoot = options.runRoot ?? null;
  const candidate = currentCandidateIdentity();
  if (
    runRoot !== null &&
    runRoot.split("/").at(-1) !== candidate.commit
  ) {
    throw new Error("G6 run root must name the exact candidate commit");
  }
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
  const directStates =
    runRoot === null ? {} : await runDirectG6RunbookHarness();
  const directState =
    runRoot === null
      ? "blocked"
      : Object.values(directStates).every((proofState) => proofState === "pass")
        ? "pass"
        : Object.values(directStates).some(
              (proofState) => proofState === "blocked",
            )
          ? "blocked"
          : "fail";
  const state =
    runRoot === null
      ? commandState === "pass"
        ? "blocked"
        : commandState
      : commandState === "pass" ? directState : commandState;
  const report = {
    schema_version: "1.0.0",
    gate: "G6",
    family: "operator_runbooks",
    candidate,
    state,
    commands,
    grammar_command: grammarCommand,
    steps: fixture.steps.map(({ id, automation }) => ({
      id,
      automation,
      grammar_verified: grammarCommand.state === "pass",
      proof_test_passed: proofStates[id] === "pass",
      direct_automation_observed:
        runRoot !== null && directStates[id] === "pass",
      typed_result_verified:
        runRoot !== null && directStates[id] === "pass",
    })),
    source_bindings: [
      sourceBinding("fixtures/g6/runbooks/operator-runbooks.json", true),
      sourceBinding("scripts/run-g6-runbooks.mjs"),
      sourceBinding("tests/fixtures/g6.fixture.test.ts"),
      ...(runRoot === null
        ? []
        : [
            sourceBinding(
              "packages/contracts/src/operator-results.ts",
            ),
            sourceBinding("scripts/g6-runbook-harness.mjs"),
            sourceBinding(
              "tests/integration/operator-runbook-harness.integration.test.ts",
            ),
            sourceBinding(
              "tests/integration/operator-cli.integration.test.ts",
            ),
            sourceBinding(
              "tests/integration/operator-destructive-confirmation.integration.test.ts",
            ),
          ]),
    ],
  };
  if (runRoot === null) {
    writeCanonicalJson(
      "docs/evaluations/g6-runbook-report.json",
      report,
    );
  } else {
    writeG6RunCanonicalJson(runRoot, "runbook-report.json", report);
  }
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = await runG6Runbooks({ runRoot: g6RunRootFromArgv() });
  process.stdout.write(`${JSON.stringify({ state: report.state })}\n`);
  if (report.state !== "pass") process.exitCode = 1;
}
