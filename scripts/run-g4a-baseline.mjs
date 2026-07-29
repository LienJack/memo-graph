import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

import {
  canonicalSha256,
} from "../packages/contracts/dist/index.js";

const repositoryRoot = realpathSync(resolve(import.meta.dirname, ".."));
const manifest = JSON.parse(
  readFileSync(
    resolve(repositoryRoot, "fixtures/g4a/manifest.json"),
    "utf8",
  ),
);
const accepted = JSON.parse(
  readFileSync(
    resolve(
      repositoryRoot,
      "docs/evaluations/g3r-h3-reproducibility-manifest.json",
    ),
    "utf8",
  ),
);
if (manifest.baseline_commit !== accepted.tested_implementation?.commit) {
  throw new Error("G4A baseline does not equal accepted G3R");
}
const temporaryParent = realpathSync(
  mkdtempSync(join(realpathSync(tmpdir()), "memo-graph-g4a-g3r-")),
);
const checkout = join(temporaryParent, "checkout");
const outputIndex = process.argv.indexOf("--output");
const outputPath = resolve(
  repositoryRoot,
  outputIndex === -1
    ? "docs/evaluations/g4a-baseline-report.json"
    : process.argv[outputIndex + 1],
);

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    ...options,
  });
}

let registered = false;
try {
  run("git", [
    "worktree",
    "add",
    "--detach",
    checkout,
    manifest.baseline_commit,
  ]);
  registered = true;
  run(
    "pnpm",
    ["install", "--offline", "--frozen-lockfile", "--ignore-scripts"],
    { cwd: checkout },
  );
  const testOutput = run(
    "pnpm",
    ["test:g3r:h3"],
    { cwd: checkout },
  );
  const actualCommit = run("git", ["rev-parse", "HEAD"], {
    cwd: checkout,
  }).trim();
  if (actualCommit !== manifest.baseline_commit) {
    throw new Error("isolated G3R checkout commit drift");
  }
  const withoutHash = {
    schema_version: "1.0.0",
    gate: "G4A_BASELINE",
    baseline_commit: actualCommit,
    dependency_lock_hash:
      accepted.tested_implementation.dependency_lock_hash,
    isolated_checkout: true,
    command: "pnpm test:g3r:h3",
    result: "PASS",
    output_tail: testOutput.trim().split("\n").slice(-8),
  };
  const report = {
    ...withoutHash,
    report_hash: canonicalSha256(withoutHash),
  };
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  if (registered) {
    try {
      run("git", ["worktree", "remove", "--force", checkout]);
    } catch {
      // The exact temporary parent is removed below.
    }
  }
  if (
    temporaryParent.startsWith(
      `${realpathSync(tmpdir())}/memo-graph-g4a-g3r-`,
    )
  ) {
    rmSync(temporaryParent, { recursive: true, force: true });
  }
}
