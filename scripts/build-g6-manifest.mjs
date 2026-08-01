import process from "node:process";

import { buildG6RuntimeIdentity } from "./build-g6-runtime-identity.mjs";
import {
  artifactBinding,
  canonicalSha256,
  currentCandidateIdentity,
  loadG6Fixture,
  sourceBinding,
  validateG6Fixture,
  writeCanonicalJson,
} from "./g6-evidence-common.mjs";

const REPORT_INPUTS = Object.freeze([
  ["docs/evaluations/g6-code-review.md", false],
  ["docs/evaluations/g6-fault-report.json", true],
  ["docs/evaluations/g6-resource-report.json", true],
  ["docs/evaluations/g6-runbook-report.json", true],
  ["docs/evaluations/g6-security-report.json", true],
  ["docs/evaluations/g6-supply-chain-report.json", true],
]);

export function buildG6Manifest() {
  const fixture = validateG6Fixture(loadG6Fixture());
  const runtimeIdentity = buildG6RuntimeIdentity();
  const artifactBindings = REPORT_INPUTS.map(([path, json]) =>
    artifactBinding(path, json),
  );
  const evidenceBundleHash = canonicalSha256({
    runtime_identity_hash: runtimeIdentity.runtime_identity_hash,
    artifact_bindings: artifactBindings,
  });
  const manifest = {
    schema_version: "1.0.0",
    gate: "G6",
    candidate: currentCandidateIdentity(),
    runtime_identity: runtimeIdentity,
    evidence_bundle_hash: evidenceBundleHash,
    artifact_bindings: artifactBindings,
    allowed_evidence_artifacts: fixture.allowed_paths.evidence,
    allowed_decision_artifacts: fixture.allowed_paths.decision,
    decision_recorded: false,
    current_release_control: false,
    source_bindings: [
      sourceBinding("fixtures/g6/manifest.json", true),
      sourceBinding("fixtures/g6/thresholds.json", true),
      sourceBinding("fixtures/g6/runtime-inputs.json", true),
      sourceBinding("fixtures/g6/operator-config.json", true),
      sourceBinding("fixtures/g6/decision-authority.json", true),
      sourceBinding("fixtures/g6/release-control.json", true),
      sourceBinding("scripts/build-g6-manifest.mjs"),
      sourceBinding("scripts/verify-g6-evidence.mjs"),
    ],
  };
  writeCanonicalJson(
    "docs/evaluations/g6-reproducibility-manifest.json",
    manifest,
  );
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const manifest = buildG6Manifest();
  process.stdout.write(
    `${JSON.stringify({
      evidence_bundle_hash: manifest.evidence_bundle_hash,
      runtime_identity_hash:
        manifest.runtime_identity.runtime_identity_hash,
    })}\n`,
  );
}
