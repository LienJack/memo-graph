import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import {
  canonicalSha256,
} from "../packages/contracts/dist/index.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(
  readFileSync(
    resolve(
      repositoryRoot,
      "docs/evaluations/g3r-h3-reproducibility-manifest.json",
    ),
    "utf8",
  ),
);

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function read(path) {
  return readFileSync(resolve(repositoryRoot, path));
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label} mismatch: expected ${expected}, received ${actual}`,
    );
  }
}

function verifyJson(path, expectedRaw, expectedCanonical) {
  const bytes = read(path);
  assertEqual(sha256(bytes), expectedRaw, `${path} raw hash`);
  assertEqual(
    canonicalSha256(JSON.parse(bytes.toString("utf8"))),
    expectedCanonical,
    `${path} canonical hash`,
  );
}

const frozen = manifest.frozen_hashes;
verifyJson(
  "fixtures/replay/manifest.json",
  frozen.base_manifest_raw,
  frozen.base_manifest_canonical,
);
verifyJson(
  "fixtures/g3/manifest.json",
  frozen.g3_manifest_raw,
  frozen.g3_manifest_canonical,
);
verifyJson(
  "fixtures/g3/h3-regressions.json",
  frozen.h3_regression_manifest_raw,
  frozen.h3_regression_manifest_canonical,
);
for (const report of Object.values(manifest.evidence_reports)) {
  verifyJson(report.path, report.raw_hash, report.canonical_hash);
}
assertEqual(
  sha256(read("pnpm-lock.yaml")),
  manifest.tested_implementation.dependency_lock_hash,
  "dependency lock",
);
assertEqual(
  sha256(read(manifest.historical_candidate.review_evidence)),
  manifest.historical_candidate.review_raw_hash,
  "historical review",
);

const sourcePaths = {
  projection_contract_source: "packages/contracts/src/projections.ts",
  scope_frontier_migration_source:
    "migrations/0011-scope-projection-frontiers.sql",
  governed_memory_reader_source:
    "packages/storage-sqlite/src/governed-memory-reader.ts",
  projection_effects_source:
    "packages/storage-sqlite/src/projection-effects.ts",
  projection_repository_source:
    "packages/storage-sqlite/src/projection-repository.ts",
  relation_repository_source:
    "packages/storage-sqlite/src/relation-repository.ts",
  lane_retrievers_source:
    "packages/memory-kernel/src/lane-retrievers.ts",
  recall_orchestrator_source:
    "packages/memory-kernel/src/recall-orchestrator.ts",
  memory_runtime_source: "packages/memory-kernel/src/index.ts",
  context_compiler_source: "packages/context-compiler/src/index.ts",
};
const candidate = manifest.tested_implementation.commit;
for (const [field, path] of Object.entries(sourcePaths)) {
  const committedBytes = execFileSync(
    "git",
    ["show", `${candidate}:${path}`],
    { cwd: repositoryRoot },
  );
  assertEqual(
    sha256(committedBytes),
    frozen[field],
    `${field} candidate source`,
  );
}
assertEqual(
  sha256(read("scripts/run-g3r-replay-report.mjs")),
  frozen.g3r_report_generator_source,
  "G3R report generator",
);

const regression = JSON.parse(
  read("fixtures/g3/h3-regressions.json").toString("utf8"),
);
const testFiles = [
  ...new Set(regression.cases.map((entry) => entry.test_file)),
].sort();
const testBundle = testFiles.map((path) => ({
  file: path,
  raw: sha256(read(path)),
}));
assertEqual(
  canonicalSha256(testBundle),
  frozen.h3_test_bundle,
  "H3 regression test bundle",
);
for (const report of Object.values(manifest.evidence_reports)) {
  const parsed = JSON.parse(read(report.path).toString("utf8"));
  assertEqual(
    parsed.candidate_commit,
    candidate,
    `${report.path} candidate`,
  );
}
execFileSync("git", ["cat-file", "-e", `${candidate}^{commit}`], {
  cwd: repositoryRoot,
});
process.stdout.write(
  `G3R evidence verified for ${candidate}\n`,
);
