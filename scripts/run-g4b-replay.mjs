import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  accessSync,
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
  calibrateG4B,
  runG4BReplay,
} from "../tests/helpers/g4b-replay.ts";
import {
  canonicalSha256,
} from "../packages/contracts/dist/index.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) {
    return fallback;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`missing required ${name} value`);
  }
  return value;
}

function rawSha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

const outputPath = resolve(
  repositoryRoot,
  option(
    "--output",
    "docs/evaluations/g4b-replay-report.json",
  ),
);
const configuredModelRoot = option(
  "--model-root",
  process.env.MEMO_GRAPH_G4B_MODEL_ROOT,
);
if (configuredModelRoot === undefined) {
  throw new Error(
    "G4B replay requires --model-root or MEMO_GRAPH_G4B_MODEL_ROOT",
  );
}
const modelRoot = realpathSync(configuredModelRoot);
for (const relative of [
  "Xenova/multilingual-e5-small/config.json",
  "Xenova/multilingual-e5-small/onnx/model_int8.onnx",
  "Xenova/multilingual-e5-small/tokenizer.json",
  "Xenova/multilingual-e5-small/tokenizer_config.json",
]) {
  accessSync(join(modelRoot, relative));
}
const implementationCommit = option(
  "--candidate",
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim(),
);
if (!/^[a-f0-9]{40}$/u.test(implementationCommit)) {
  throw new Error("G4B replay candidate must be a full commit");
}
const dependencyLockHash = rawSha256(
  readFileSync(resolve(repositoryRoot, "pnpm-lock.yaml")),
);
const firstDataRoot = realpathSync(
  mkdtempSync(
    join(realpathSync(tmpdir()), "memo-graph-g4b-replay-first-"),
  ),
);
const secondDataRoot = realpathSync(
  mkdtempSync(
    join(realpathSync(tmpdir()), "memo-graph-g4b-replay-second-"),
  ),
);

try {
  const { receipt } = await calibrateG4B();
  const first = await runG4BReplay({
    data_root: firstDataRoot,
    model_root: modelRoot,
    implementation_commit: implementationCommit,
    dependency_lock_hash: dependencyLockHash,
    receipt,
    recorded_at: new Date().toISOString(),
  });
  const second = await runG4BReplay({
    data_root: secondDataRoot,
    model_root: modelRoot,
    implementation_commit: implementationCommit,
    dependency_lock_hash: dependencyLockHash,
    receipt,
    recorded_at: first.recorded_at,
  });
  const repeat = {
    schema_version: "1.0.0",
    runs: 2,
    deterministic:
      first.logical_results_hash === second.logical_results_hash,
    logical_results_hashes: [
      first.logical_results_hash,
      second.logical_results_hash,
    ],
  };
  const reportWithoutHash = {
    ...first,
    repeat,
  };
  Reflect.deleteProperty(reportWithoutHash, "report_hash");
  const report = {
    ...reportWithoutHash,
    report_hash: canonicalSha256(reportWithoutHash),
  };
  writeFileSync(
    outputPath,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(
    `G4B replay: ${report.utility_gate ? "GO-ELIGIBLE" : "NO-GO"} ` +
      `(positive=${report.summary.positive_cases_solved}, ` +
      `strict=${report.summary.strict_case_gains}, ` +
      `pollution=${report.threshold_results.context_pollution}, ` +
      `deterministic=${report.repeat.deterministic})\n`,
  );
} finally {
  rmSync(firstDataRoot, { recursive: true, force: true });
  rmSync(secondDataRoot, { recursive: true, force: true });
}
