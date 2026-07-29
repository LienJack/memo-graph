import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { URL } from "node:url";

import {
  G4ACaseBodySchema,
  G4AOverlayManifestSchema,
  assertG4APartitionAccess,
  canonicalSha256,
} from "../packages/contracts/dist/index.js";
import {
  GraphProcessHost,
  acceptedG3RStructuralOutcome,
  assertComparableG4AIdentities,
  g4aQueryForCase,
  materializeG4ACaseSnapshot,
  outcomeFromGraphResult,
  queryGraphSnapshotReference,
  scoreG4AOutcome,
  sealG4ACaseResult,
} from "../packages/graph-projection/dist/index.js";

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

const candidateCommit = option(
  "--candidate",
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim(),
);
if (!/^[a-f0-9]{40}$/u.test(candidateCommit)) {
  throw new Error("G4A candidate must be one full Git commit");
}
execFileSync("git", ["cat-file", "-e", `${candidateCommit}^{commit}`], {
  cwd: repositoryRoot,
});
const outputPath = resolve(
  repositoryRoot,
  option(
    "--output",
    "docs/evaluations/g4a-structural-report.json",
  ),
);
const phase = option("--phase", "gate_evaluation");
if (phase !== "calibration_tuning" && phase !== "gate_evaluation") {
  throw new Error("G4A phase must be calibration_tuning or gate_evaluation");
}
const manifestBytes = readFileSync(
  resolve(repositoryRoot, "fixtures/g4a/manifest.json"),
);
const manifest = G4AOverlayManifestSchema.parse(
  JSON.parse(manifestBytes.toString("utf8")),
);
const acceptedManifest = JSON.parse(
  readFileSync(
    resolve(
      repositoryRoot,
      "docs/evaluations/g3r-h3-reproducibility-manifest.json",
    ),
    "utf8",
  ),
);
if (
  manifest.baseline_commit !==
    acceptedManifest.tested_implementation?.commit
) {
  throw new Error("G4A baseline is not the accepted G3R commit");
}
const dependencyLockHash = rawSha256(
  readFileSync(resolve(repositoryRoot, "pnpm-lock.yaml")),
);
const acceptedLockHash =
  acceptedManifest.tested_implementation.dependency_lock_hash;
const manifestHash = canonicalSha256(manifest);
const thresholdsHash = canonicalSha256(manifest.thresholds);
const require = createRequire(
  new URL("../packages/graph-projection/package.json", import.meta.url),
);
const ladybugEntry = require.resolve("@ladybugdb/core");
const identity = {
  schema_version: "1.0.0",
  backend: "ladybugdb",
  package_name: "@ladybugdb/core",
  package_version: manifest.candidate.package_version,
  storage_version: "42",
  platform: process.platform,
  architecture: process.arch,
  native_binary_hash: rawSha256(
    readFileSync(join(dirname(ladybugEntry), "lbugjs.node")),
  ),
  dependency_lock_hash: dependencyLockHash,
};
if (
  identity.package_name !== manifest.candidate.package_name ||
  identity.package_version !== manifest.candidate.package_version ||
  identity.platform !== manifest.candidate.platform ||
  identity.architecture !== manifest.candidate.architecture ||
  identity.dependency_lock_hash !== dependencyLockHash
) {
  throw new Error("G4A native candidate identity mismatch");
}

const dataRoot = realpathSync(
  mkdtempSync(join(realpathSync(tmpdir()), "memo-graph-g4a-replay-")),
);
let graph;
try {
  graph = await GraphProcessHost.open({
    dataRoot,
    expectedIdentity: identity,
    childEntry: new URL(
      "../packages/graph-projection/dist/ladybug-process.js",
      import.meta.url,
    ),
    requestTimeoutMs: manifest.thresholds.host_graph_deadline_ms,
    writeTimeoutMs: 10_000,
  });
  const results = [];
  const descriptors =
    phase === "calibration_tuning"
      ? manifest.cases.filter(
          (descriptor) => descriptor.partition === "calibration",
        )
      : manifest.cases;
  for (const descriptor of descriptors) {
    assertG4APartitionAccess(phase, descriptor.partition);
    const bodyBytes = readFileSync(
      resolve(repositoryRoot, "fixtures/g4a", descriptor.body_file),
    );
    const body = G4ACaseBodySchema.parse(
      JSON.parse(bodyBytes.toString("utf8")),
    );
    if (
      body.case_id !== descriptor.case_id ||
      body.partition !== descriptor.partition ||
      body.family !== descriptor.family ||
      canonicalSha256(body) !== descriptor.content_hash
    ) {
      throw new Error(`G4A case binding failed for ${descriptor.case_id}`);
    }
    const snapshot = materializeG4ACaseSnapshot(body);
    const query = g4aQueryForCase({ body, snapshot });
    const policyHash = canonicalSha256({
      query: body.query,
      exact_scope: body.scope,
      canonical_prefilter: true,
      canonical_postvalidation: true,
      reference_algorithm: "terminal-pattern-path-v1",
    });
    const common = {
      protocol_version: "1.0.0",
      case_id: body.case_id,
      partition: body.partition,
      manifest_hash: manifestHash,
      case_hash: descriptor.content_hash,
      query_hash: canonicalSha256(query),
      policy_hash: policyHash,
      frontier_hash: canonicalSha256(snapshot.frontier),
      thresholds_hash: thresholdsHash,
    };
    const identities = [
      {
        ...common,
        arm: "accepted_g3r",
        candidate_commit: manifest.baseline_commit,
        dependency_lock_hash: acceptedLockHash,
        native_binary_hash: null,
      },
      {
        ...common,
        arm: "m4a_graph_disabled_reference",
        candidate_commit: candidateCommit,
        dependency_lock_hash: dependencyLockHash,
        native_binary_hash: null,
      },
      {
        ...common,
        arm: "m4a_graph_enabled",
        candidate_commit: candidateCommit,
        dependency_lock_hash: dependencyLockHash,
        native_binary_hash: identity.native_binary_hash,
      },
    ];
    assertComparableG4AIdentities(identities);

    const acceptedActual = acceptedG3RStructuralOutcome();
    const referenceResult = queryGraphSnapshotReference({
      snapshot,
      query,
    });
    const referenceActual = outcomeFromGraphResult({
      body,
      snapshot,
      result: referenceResult,
    });
    await graph.replaceScope(snapshot);
    const graphResult = await graph.queryPaths(query);
    const graphActual = outcomeFromGraphResult({
      body,
      snapshot,
      result: graphResult,
    });
    const acceptedScore = scoreG4AOutcome(
      body.expected,
      acceptedActual,
    );
    const referenceScore = scoreG4AOutcome(
      body.expected,
      referenceActual,
    );
    const graphScore = scoreG4AOutcome(body.expected, graphActual);
    const nativeReferenceEqual =
      canonicalSha256(graphActual) === canonicalSha256(referenceActual);
    const strictGain =
      graphScore.passed &&
      !acceptedScore.passed &&
      !referenceScore.passed &&
      nativeReferenceEqual;
    const governanceViolations = [
      ...body.prohibited_revision_ids.filter((revisionId) =>
        graphActual.revision_ids.includes(revisionId)
      ).map((revisionId) => `PROHIBITED_REVISION:${revisionId}`),
      ...(nativeReferenceEqual ? [] : ["NATIVE_REFERENCE_MISMATCH"]),
    ];
    results.push({
      case_id: body.case_id,
      partition: body.partition,
      family: body.family,
      input_identity: {
        snapshot_logical_digest: snapshot.logical_digest,
        node_count: snapshot.nodes.length,
        edge_count: snapshot.edges.length,
        query_hash: canonicalSha256(query),
      },
      scores: {
        accepted_g3r: acceptedScore,
        m4a_graph_disabled_reference: referenceScore,
        m4a_graph_enabled: graphScore,
      },
      arms: {
        accepted_g3r: sealG4ACaseResult({
          identity: identities[0],
          actual: acceptedActual,
          expected: body.expected,
          strictGain: false,
        }),
        m4a_graph_disabled_reference: sealG4ACaseResult({
          identity: identities[1],
          actual: referenceActual,
          expected: body.expected,
          strictGain: false,
        }),
        m4a_graph_enabled: sealG4ACaseResult({
          identity: identities[2],
          actual: graphActual,
          expected: body.expected,
          strictGain,
          governanceViolations,
        }),
      },
      native_reference_equal: nativeReferenceEqual,
      strict_gain: strictGain,
    });
  }
  const strictGains = results.filter((row) => row.strict_gain);
  const graphRegressions = results.filter(
    (row) => !row.scores.m4a_graph_enabled.passed,
  );
  const governanceViolations = results.flatMap(
    (row) => row.arms.m4a_graph_enabled.governance_violations,
  );
  const materialGain =
    strictGains.length >= manifest.thresholds.strict_case_gains &&
    strictGains.filter((row) => row.partition === "holdout").length >=
      manifest.thresholds.minimum_holdout_gains &&
    strictGains.filter((row) => row.partition === "transfer").length >=
      manifest.thresholds.minimum_transfer_gains &&
    graphRegressions.length === 0;
  const logicalResultsHash = canonicalSha256(
    results.map((row) => ({
      case_id: row.case_id,
      partition: row.partition,
      input_identity: row.input_identity,
      scores: row.scores,
      arms: Object.fromEntries(
        Object.entries(row.arms).map(([arm, result]) => [
          arm,
          result.result_hash,
        ]),
      ),
      native_reference_equal: row.native_reference_equal,
      strict_gain: row.strict_gain,
    })),
  );
  const withoutHash = {
    schema_version: "1.0.0",
    recorded_at: new Date().toISOString(),
    gate: "G4A",
    phase,
    protocol_version: "1.0.0",
    accepted_g3r_commit: manifest.baseline_commit,
    accepted_g3r_dependency_lock_hash: acceptedLockHash,
    candidate_commit: candidateCommit,
    dependency_lock_hash: dependencyLockHash,
    native_identity: identity,
    corpus: {
      manifest_raw_hash: rawSha256(manifestBytes),
      manifest_hash: manifestHash,
      thresholds_hash: thresholdsHash,
      cases: results.length,
      partitions:
        [...new Set(results.map((row) => row.partition))].sort(),
      materializer: "g4a-frozen-topology-materializer@1.0.0",
      evaluator_source_hash: rawSha256(
        readFileSync(
          resolve(repositoryRoot, "scripts/run-g4a-replay.mjs"),
        ),
      ),
      materializer_source_hash: rawSha256(
        readFileSync(
          resolve(
            repositoryRoot,
            "packages/graph-projection/src/benchmark.ts",
          ),
        ),
      ),
      reference_source_hash: rawSha256(
        readFileSync(
          resolve(
            repositoryRoot,
            "packages/graph-projection/src/sqlite-baseline.ts",
          ),
        ),
      ),
      native_adapter_source_hash: rawSha256(
        readFileSync(
          resolve(
            repositoryRoot,
            "packages/graph-projection/src/ladybug-adapter.ts",
          ),
        ),
      ),
    },
    results,
    summary: {
      strict_gains: strictGains.map((row) => row.case_id),
      holdout_gains: strictGains.filter(
        (row) => row.partition === "holdout",
      ).length,
      transfer_gains: strictGains.filter(
        (row) => row.partition === "transfer",
      ).length,
      graph_regressions: graphRegressions.map((row) => row.case_id),
      governance_violations: governanceViolations,
      native_reference_mismatches: results
        .filter((row) => !row.native_reference_equal)
        .map((row) => row.case_id),
      material_structural_gain: materialGain,
      logical_results_hash: logicalResultsHash,
    },
    decision_input: {
      identity_gate: true,
      frozen_input_gate: true,
      structural_gate: materialGain,
      governance_gate:
        governanceViolations.length ===
        manifest.thresholds.critical_regression_tolerance,
      resource_gate: "PENDING_U7_RESOURCE_REPORT",
      eligible_for_go: false,
    },
  };
  const report = {
    ...withoutHash,
    report_hash: canonicalSha256({
      ...withoutHash,
      recorded_at: null,
    }),
  };
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
} finally {
  await graph?.close().catch(() => undefined);
  rmSync(dataRoot, { recursive: true, force: true });
}
