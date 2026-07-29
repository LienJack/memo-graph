import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  accessSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { URL } from "node:url";

import {
  buildVectorEmbeddingEpoch,
  buildVectorScopeSnapshot,
  canonicalSha256,
} from "../packages/contracts/dist/index.js";
import {
  SqliteVecIndex,
  VectorProcessHost,
  verifyLocalModelSnapshot,
} from "../packages/vector-retrieval/dist/index.js";
import {
  G4B_MANIFEST_HASH,
  G4B_VECTOR_EPOCH,
  evaluateG4BResourceMetrics,
  loadG4BManifest,
  materializeG4BExpectedProfile,
  openG4BResourceHarness,
  percentile,
} from "../tests/helpers/g4b-replay.ts";

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

function pathsUnder(root) {
  try {
    return readdirSync(root).flatMap((name) => {
      const path = join(root, name);
      return statSync(path).isDirectory() ? pathsUnder(path) : [path];
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function bytesUnder(root) {
  return pathsUnder(root).reduce(
    (total, path) => total + statSync(path).size,
    0,
  );
}

function rssBytes(pid) {
  if (pid === null) {
    return null;
  }
  try {
    const value = execFileSync(
      "ps",
      ["-o", "rss=", "-p", String(pid)],
      { encoding: "utf8" },
    ).trim();
    const rss = value.length === 0 ? 0 : Number(value) * 1_024;
    return rss > 0 ? rss : null;
  } catch {
    return null;
  }
}

function packageRoot(require, packageName) {
  let current = dirname(require.resolve(packageName));
  while (current !== dirname(current)) {
    const packagePath = join(current, "package.json");
    try {
      const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
      if (manifest.name === packageName) {
        return current;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    current = dirname(current);
  }
  throw new Error(`package root not found: ${packageName}`);
}

function deterministicVector(scopeIndex, recordIndex) {
  const vector = Array.from({ length: 384 }, () => 0);
  vector[(scopeIndex * 17 + recordIndex) % vector.length] = 1;
  return vector;
}

async function materializeNativeProfile(input) {
  const expected = materializeG4BExpectedProfile(input.profile);
  const snapshotDigests = [];
  let records = 0;
  mkdirSync(input.root, { recursive: true });
  for (
    let scopeIndex = 0;
    scopeIndex < expected.scopes.length;
    scopeIndex += 1
  ) {
    const logical = expected.scopes[scopeIndex];
    if (logical === undefined) {
      throw new Error("G4B expected scope is missing");
    }
    const scopeRoot = join(input.root, logical.scope_id);
    mkdirSync(scopeRoot, { recursive: true });
    const index = await SqliteVecIndex.open({
      databasePath: join(scopeRoot, "vectors.sqlite3"),
      dimensions: 384,
    });
    try {
      const snapshot = buildVectorScopeSnapshot({
        schema_version: "1.0.0",
        principal_id: "g4b_resource_principal",
        scope: {
          kind: "workspace",
          id: logical.scope_id,
        },
        embedding_epoch_id: input.epoch.epoch_id,
        generation_id: `${input.generation_prefix}_${String(scopeIndex).padStart(3, "0")}`,
        frontier: {
          ledger_epoch: 1,
          tombstone_epoch: 0,
          source_frontier_hash: canonicalSha256({
            scope_id: logical.scope_id,
            active_l1_memories: logical.active_l1_memories,
          }),
          next_validity_transition_at: null,
        },
        records: Array.from(
          { length: logical.active_l1_memories },
          (_unused, recordIndex) => ({
            schema_version: "1.0.0",
            revision_id:
              `revision_${String(scopeIndex).padStart(3, "0")}_${String(recordIndex).padStart(4, "0")}`,
            source_content_hash: canonicalSha256({
              scope_index: scopeIndex,
              record_index: recordIndex,
            }),
            vector: deterministicVector(scopeIndex, recordIndex),
          }),
        ),
      });
      const replaced = await index.replaceScope(snapshot);
      const readBack = await index.readScopeSnapshot();
      if (readBack?.logical_digest !== replaced.logical_digest) {
        throw new Error("G4B native profile read-back mismatch");
      }
      snapshotDigests.push(replaced.logical_digest);
      records += replaced.records.length;
    } finally {
      await index.close();
    }
  }
  return {
    scope_count: expected.scope_count,
    record_count: records,
    logical_digest: canonicalSha256(snapshotDigests),
    physical_bytes: bytesUnder(input.root),
  };
}

async function timedSamples(input) {
  for (let index = 0; index < input.warmups; index += 1) {
    await input.run(`warmup_${index}`);
  }
  const samples = [];
  const outcomes = new Map();
  for (let index = 0; index < input.measured; index += 1) {
    const started = performance.now();
    const outcome = await input.run(`measured_${index}`);
    samples.push(performance.now() - started);
    const key = input.classify(outcome);
    outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
  }
  return {
    values: samples,
    outcomes: Object.fromEntries(
      [...outcomes.entries()].sort(([left], [right]) =>
        left.localeCompare(right)
      ),
    ),
  };
}

const outputPath = resolve(
  repositoryRoot,
  option(
    "--output",
    "docs/evaluations/g4b-resource-report.json",
  ),
);
const configuredModelRoot = option(
  "--model-root",
  process.env.MEMO_GRAPH_G4B_MODEL_ROOT,
);
if (configuredModelRoot === undefined) {
  throw new Error(
    "G4B resources require --model-root or MEMO_GRAPH_G4B_MODEL_ROOT",
  );
}
const modelRoot = realpathSync(configuredModelRoot);
for (const relative of G4B_VECTOR_EPOCH.model.files.map(
  (entry) =>
    join(
      G4B_VECTOR_EPOCH.model.repository,
      entry.path,
    ),
)) {
  accessSync(join(modelRoot, relative));
}
await verifyLocalModelSnapshot(modelRoot, G4B_VECTOR_EPOCH);

const candidateCommit = option(
  "--candidate",
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim(),
);
if (!/^[a-f0-9]{40}$/u.test(candidateCommit)) {
  throw new Error("G4B resource candidate must be a full commit");
}
const manifest = await loadG4BManifest();
const expectedProfile = materializeG4BExpectedProfile(
  manifest.expected_profile,
);
const dependencyLockHash = rawSha256(
  readFileSync(resolve(repositoryRoot, "pnpm-lock.yaml")),
);
const dataRoot = realpathSync(
  mkdtempSync(
    join(realpathSync(tmpdir()), "memo-graph-g4b-resource-"),
  ),
);
const require = createRequire(
  new URL("../packages/vector-retrieval/package.json", import.meta.url),
);
const installRoots = [
  "@huggingface/transformers",
  "sqlite-vec",
  "better-sqlite3",
].map((name) => packageRoot(require, name));
const installBytes = installRoots.reduce(
  (total, root) => total + bytesUnder(root),
  0,
);

let directHost;
let harness;
let contextHarness;
try {
  const parentRssBefore = process.memoryUsage().rss;
  const directRoot = join(dataRoot, "direct-runtime");
  const principalId = "g4b_resource_direct";
  const scope = {
    kind: "workspace",
    id: "g4b_resource_direct_scope",
  };
  const coldStarted = performance.now();
  directHost = await VectorProcessHost.open({
    dataRoot: directRoot,
    modelRoot,
    principalId,
    scope,
    expectedEpoch: G4B_VECTOR_EPOCH,
    startupTimeoutMs: 30_000,
    requestTimeoutMs: 75,
    writeTimeoutMs: 120_000,
    maxIpcBytes: 16 * 1_024 * 1_024,
  });
  const coldReadyMs = performance.now() - coldStarted;
  const childIdleRss = rssBytes(directHost.processId());
  const scopePassages = Array.from(
    { length: 250 },
    (_unused, index) =>
      `G4B governed semantic resource record ${index}: SQLite remains authoritative.`,
  );
  const scopeRebuildStarted = performance.now();
  const vectors = [];
  for (let offset = 0; offset < scopePassages.length; offset += 32) {
    vectors.push(
      ...await directHost.embedPassages(
        scopePassages.slice(offset, offset + 32),
      ),
    );
  }
  const directSnapshot = buildVectorScopeSnapshot({
    schema_version: "1.0.0",
    principal_id: principalId,
    scope,
    embedding_epoch_id: G4B_VECTOR_EPOCH.epoch_id,
    generation_id: "g4b_resource_direct_generation",
    frontier: {
      ledger_epoch: 1,
      tombstone_epoch: 0,
      source_frontier_hash: canonicalSha256(scopePassages),
      next_validity_transition_at: null,
    },
    records: vectors.map((vector, index) => ({
      schema_version: "1.0.0",
      revision_id: `g4b_resource_revision_${String(index).padStart(4, "0")}`,
      source_content_hash: canonicalSha256(scopePassages[index]),
      vector,
    })),
  });
  await directHost.replaceScope(directSnapshot);
  const scopeRebuildMs = performance.now() - scopeRebuildStarted;
  const directQuery = (sampleId) =>
    directHost.query({
      schema_version: "1.0.0",
      request_id: `g4b_direct_${sampleId}`,
      principal_id: principalId,
      scope,
      query: "authoritative memory governed retrieval",
      embedding_epoch_id: G4B_VECTOR_EPOCH.epoch_id,
      generation_id: directSnapshot.generation_id,
      source_frontier_hash:
        directSnapshot.frontier.source_frontier_hash,
      top_k: 5,
      parent_deadline_ms: 75,
      max_response_bytes: 65_536,
    });
  const direct = await timedSamples({
    warmups: manifest.thresholds.warmup_samples,
    measured: manifest.thresholds.measured_samples,
    run: directQuery,
    classify: (outcome) => outcome.status,
  });
  const childPeakRss = rssBytes(directHost.processId());
  await directHost.close();
  directHost = null;

  harness = await openG4BResourceHarness({
    data_root: join(dataRoot, "governed-runtime"),
    model_root: modelRoot,
  });
  const frozenResourceQuery = harness.frozen_case.query;
  const governed = await timedSamples({
    warmups: manifest.thresholds.warmup_samples,
    measured: manifest.thresholds.measured_samples,
    run: (sampleId) => harness.recall({ sample_id: sampleId }),
    classify: (outcome) =>
      outcome.reason_codes.length === 0
        ? "complete"
        : `degraded:${outcome.reason_codes.join(",")}`,
  });
  await harness.close();
  harness = null;
  contextHarness = await openG4BResourceHarness({
    data_root: join(dataRoot, "context-runtime"),
    model_root: modelRoot,
  });
  const context = await timedSamples({
    warmups: manifest.thresholds.warmup_samples,
    measured: manifest.thresholds.measured_samples,
    run: (sampleId) =>
      contextHarness.compile({ sample_id: sampleId }),
    classify: (outcome) => outcome.status,
  });
  const fallback = await timedSamples({
    warmups: manifest.thresholds.warmup_samples,
    measured: manifest.thresholds.measured_samples,
    run: (sampleId) =>
      contextHarness.fallback({ sample_id: sampleId }),
    classify: (outcome) =>
      outcome.reason_codes.length === 0
        ? "unexpected_complete"
        : `degraded:${outcome.reason_codes.join(",")}`,
  });
  await contextHarness.close();
  contextHarness = null;

  const nativeRoot = join(dataRoot, "expected-native");
  const fullRebuildStarted = performance.now();
  const nativeProfile = await materializeNativeProfile({
    root: nativeRoot,
    profile: manifest.expected_profile,
    epoch: G4B_VECTOR_EPOCH,
    generation_prefix: "g4b_full",
  });
  const fullRebuildMs = performance.now() - fullRebuildStarted;

  const migrationEpoch = buildVectorEmbeddingEpoch({
    schema_version: G4B_VECTOR_EPOCH.schema_version,
    runtime: G4B_VECTOR_EPOCH.runtime,
    sqlite_binding: G4B_VECTOR_EPOCH.sqlite_binding,
    model: G4B_VECTOR_EPOCH.model,
    index: G4B_VECTOR_EPOCH.index,
    projection_schema_version: "1.0.1",
    dependency_lock_hash:
      G4B_VECTOR_EPOCH.dependency_lock_hash,
  });
  const migrationRoot = join(dataRoot, "epoch-migration");
  const migrationStarted = performance.now();
  const migratedProfile = await materializeNativeProfile({
    root: migrationRoot,
    profile: manifest.expected_profile,
    epoch: migrationEpoch,
    generation_prefix: "g4b_migration",
  });
  const epochMigrationMs = performance.now() - migrationStarted;

  const latency = {
    governed_recall_p50: percentile(governed.values, 0.5),
    governed_recall_p95: percentile(governed.values, 0.95),
    governed_recall_p99: percentile(governed.values, 0.99),
    context_compile_p50: percentile(context.values, 0.5),
    context_compile_p95: percentile(context.values, 0.95),
    context_compile_p99: percentile(context.values, 0.99),
    fallback_p95: percentile(fallback.values, 0.95),
    cold_ready: coldReadyMs,
    scope_rebuild: scopeRebuildMs,
    full_rebuild: fullRebuildMs,
    epoch_migration: epochMigrationMs,
  };
  const thresholdResults = evaluateG4BResourceMetrics({
    thresholds: manifest.thresholds,
    samples: {
      warmups: manifest.thresholds.warmup_samples,
      measured: manifest.thresholds.measured_samples,
    },
    outcomes: {
      direct_complete: direct.outcomes.complete ?? 0,
      governed_complete: governed.outcomes.complete ?? 0,
      context_ok: context.outcomes.OK ?? 0,
      fallback_typed_degraded: Object.entries(
        fallback.outcomes,
      ).reduce(
        (total, [key, value]) =>
          key.startsWith("degraded:") ? total + value : total,
        0,
      ),
    },
    latency_ms: latency,
    expected_profile: {
      logical_materialized: true,
      native_physical_materialized:
        nativeProfile.scope_count === expectedProfile.scope_count &&
        nativeProfile.record_count ===
          expectedProfile.active_l1_memories,
      full_rebuild_measured: true,
      epoch_migration_measured:
        migratedProfile.scope_count ===
          expectedProfile.scope_count &&
        migratedProfile.record_count ===
          expectedProfile.active_l1_memories,
    },
  });
  const vectorRoot = join(dataRoot, "derived", "vector");
  const withoutHash = {
    schema_version: "1.0.0",
    recorded_at: new Date().toISOString(),
    gate: "G4B_RESOURCE",
    candidate_commit: candidateCommit,
    dependency_lock_hash: dependencyLockHash,
    manifest_hash: G4B_MANIFEST_HASH,
    thresholds_hash: canonicalSha256(manifest.thresholds),
    environment: {
      node: process.versions.node,
      pnpm: execFileSync("pnpm", ["--version"], {
        encoding: "utf8",
      }).trim(),
      os: execFileSync("uname", ["-srv"], {
        encoding: "utf8",
      }).trim(),
      platform: process.platform,
      architecture: process.arch,
      vector_epoch_id: G4B_VECTOR_EPOCH.epoch_id,
      migration_epoch_id: migrationEpoch.epoch_id,
      runner_source_hash: rawSha256(
        readFileSync(
          resolve(
            repositoryRoot,
            "scripts/run-g4b-resource-benchmark.mjs",
          ),
        ),
      ),
      replay_helper_source_hash: rawSha256(
        readFileSync(
          resolve(repositoryRoot, "tests/helpers/g4b-replay.ts"),
        ),
      ),
      runtime_source_hash: rawSha256(
        readFileSync(
          resolve(
            repositoryRoot,
            "packages/vector-retrieval/src/process-host.ts",
          ),
        ),
      ),
      sample_identity: canonicalSha256({
        warmups: manifest.thresholds.warmup_samples,
        measured: manifest.thresholds.measured_samples,
        query: frozenResourceQuery,
        expected_profile: manifest.expected_profile,
      }),
    },
    thresholds: manifest.thresholds,
    metrics: {
      samples: {
        warmups: manifest.thresholds.warmup_samples,
        measured: manifest.thresholds.measured_samples,
        governed_hash: canonicalSha256(
          governed.values.map((value) => Number(value.toFixed(6))),
        ),
        context_hash: canonicalSha256(
          context.values.map((value) => Number(value.toFixed(6))),
        ),
        fallback_hash: canonicalSha256(
          fallback.values.map((value) => Number(value.toFixed(6))),
        ),
        direct_warm_hash: canonicalSha256(
          direct.values.map((value) => Number(value.toFixed(6))),
        ),
      },
      latency_ms: {
        ...latency,
        direct_warm_p50: percentile(direct.values, 0.5),
        direct_warm_p95: percentile(direct.values, 0.95),
        direct_warm_p99: percentile(direct.values, 0.99),
      },
      outcomes: {
        direct: direct.outcomes,
        governed: governed.outcomes,
        context: context.outcomes,
        fallback: fallback.outcomes,
      },
      physical_bytes: {
        model_snapshot: bytesUnder(modelRoot),
        install_delta: installBytes,
        direct_runtime: bytesUnder(directRoot),
        expected_native: nativeProfile.physical_bytes,
        epoch_migration: migratedProfile.physical_bytes,
        index_wal_temp_total: bytesUnder(vectorRoot),
      },
      rss_bytes: {
        parent_before: parentRssBefore,
        parent_after: process.memoryUsage().rss,
        child_idle: childIdleRss,
        child_peak_observed: childPeakRss,
      },
      exact_scope_rebuild: {
        scope_records: directSnapshot.records.length,
        logical_digest: directSnapshot.logical_digest,
      },
      expected_profile: {
        ...manifest.expected_profile,
        scope_count: expectedProfile.scope_count,
        logical_materialized: true,
        logical_digest: expectedProfile.logical_digest,
        native_physical_materialized: true,
        native_record_count: nativeProfile.record_count,
        native_logical_digest: nativeProfile.logical_digest,
        native_full_rebuild_measured: true,
        epoch_migration_measured: true,
        migration_record_count: migratedProfile.record_count,
        migration_logical_digest: migratedProfile.logical_digest,
        physical_boundary:
          "100 exact-scope sqlite-vec indexes with deterministic normalized vectors; semantic model latency is measured separately through the real governed runtime",
      },
    },
    threshold_results: thresholdResults,
    resource_gate: Object.values(thresholdResults).every(Boolean),
  };
  const report = {
    ...withoutHash,
    report_hash: canonicalSha256({
      ...withoutHash,
      recorded_at: null,
    }),
  };
  writeFileSync(
    outputPath,
    `${JSON.stringify(report, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  process.stdout.write(
    `${JSON.stringify({
      resource_gate: report.resource_gate,
      threshold_results: report.threshold_results,
      latency_ms: report.metrics.latency_ms,
      expected_profile: report.metrics.expected_profile,
    }, null, 2)}\n`,
  );
} finally {
  await Promise.allSettled([
    directHost?.close(),
    harness?.close(),
    contextHarness?.close(),
  ]);
  rmSync(dataRoot, { recursive: true, force: true });
}
