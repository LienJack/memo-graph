import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cpSync,
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
  G4ACaseBodySchema,
  G4AOverlayManifestSchema,
  buildGraphScopeSnapshot,
  canonicalSha256,
} from "../packages/contracts/dist/index.js";
import {
  GraphProcessHost,
  g4aQueryForCase,
  graphGlobalLogicalDigest,
  materializeG4ACaseSnapshot,
  materializeG4AExpectedProfile,
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

function percentile(samples, ratio) {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * ratio) - 1)] ??
    null;
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
    return Number(
      execFileSync("ps", ["-o", "rss=", "-p", String(pid)], {
        encoding: "utf8",
      }).trim(),
    ) * 1_024;
  } catch {
    return null;
  }
}

const outputPath = resolve(
  repositoryRoot,
  option(
    "--output",
    "docs/evaluations/g4a-resource-report.json",
  ),
);
const candidateCommit = option(
  "--candidate",
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim(),
);
if (!/^[a-f0-9]{40}$/u.test(candidateCommit)) {
  throw new Error("G4A resource candidate must be a full commit");
}
const manifest = G4AOverlayManifestSchema.parse(
  JSON.parse(
    readFileSync(
      resolve(repositoryRoot, "fixtures/g4a/manifest.json"),
      "utf8",
    ),
  ),
);
const dependencyLockHash = rawSha256(
  readFileSync(resolve(repositoryRoot, "pnpm-lock.yaml")),
);
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
const caseBodies = manifest.cases.map((descriptor) =>
  G4ACaseBodySchema.parse(
    JSON.parse(
      readFileSync(
        resolve(repositoryRoot, "fixtures/g4a", descriptor.body_file),
        "utf8",
      ),
    ),
  )
);
const resourceSnapshots = caseBodies.map((body) => {
  const snapshot = materializeG4ACaseSnapshot(body);
  const unsigned = { ...snapshot };
  Reflect.deleteProperty(unsigned, "logical_digest");
  const principalId = `resource_${body.case_id}`;
  return buildGraphScopeSnapshot({
    ...unsigned,
    principal_id: principalId,
    nodes: unsigned.nodes.map((node) => ({
      ...node,
      principal_id: principalId,
    })),
    edges: unsigned.edges.map((edge) => ({
      ...edge,
      principal_id: principalId,
    })),
  });
});
const latencyBody = caseBodies.find(
  (body) => body.family === "typed_explanatory_path",
);
if (latencyBody === undefined) {
  throw new Error("G4A latency case is missing");
}
const latencySnapshot = materializeG4ACaseSnapshot(latencyBody);
const latencyQuery = g4aQueryForCase({
  body: latencyBody,
  snapshot: latencySnapshot,
});
const dataRoot = realpathSync(
  mkdtempSync(join(realpathSync(tmpdir()), "memo-graph-g4a-resource-")),
);
const childEntry = new URL(
  "../packages/graph-projection/dist/ladybug-process.js",
  import.meta.url,
);
let graph;
let fallback;
let rebuild;
try {
  const parentRssBefore = process.memoryUsage().rss;
  const startupStarted = performance.now();
  graph = await GraphProcessHost.open({
    dataRoot,
    generationId: "resource-latency",
    expectedIdentity: identity,
    childEntry,
    requestTimeoutMs: manifest.thresholds.host_graph_deadline_ms,
    writeTimeoutMs: 10_000,
  });
  const startupMs = performance.now() - startupStarted;
  const childIdleRss = rssBytes(graph.processId());
  await graph.replaceScope(latencySnapshot);
  for (
    let index = 0;
    index < manifest.thresholds.warmup_samples;
    index += 1
  ) {
    await graph.queryPaths({
      ...latencyQuery,
      query_id: `g4a_resource_warmup_${index}`,
    });
  }
  const querySamples = [];
  for (
    let index = 0;
    index < manifest.thresholds.measured_samples;
    index += 1
  ) {
    const started = performance.now();
    const result = await graph.queryPaths({
      ...latencyQuery,
      query_id: `g4a_resource_measure_${index}`,
    });
    if (!result.complete) {
      throw new Error("G4A resource query was incomplete");
    }
    querySamples.push(performance.now() - started);
  }
  const childPeakRss = rssBytes(graph.processId());
  const finalHealth = await graph.health();
  await graph.close();
  graph = null;

  const fallbackRoot = join(dataRoot, "fallback-runtime");
  fallback = await GraphProcessHost.open({
    dataRoot: fallbackRoot,
    generationId: "fallback",
    expectedIdentity: identity,
    childEntry,
    requestTimeoutMs: manifest.thresholds.host_graph_deadline_ms,
    writeTimeoutMs: 10_000,
    testHooks: { adversarialNativeQuery: true },
    restartPolicy: {
      maxRestarts: manifest.thresholds.measured_samples,
      windowMs: 120_000,
      cooldownMs: 250,
    },
  });
  const fallbackSamples = [];
  const replacementSamples = [];
  for (
    let index = 0;
    index < manifest.thresholds.measured_samples;
    index += 1
  ) {
    const started = performance.now();
    const result = await fallback.queryPaths({
      ...latencyQuery,
      query_id: `adversarial_native_query_resource_${index}`,
    });
    fallbackSamples.push(performance.now() - started);
    if (
      result.reason_codes[0] !== "GRAPH_DEADLINE_EXCEEDED" ||
      result.complete
    ) {
      throw new Error("G4A fallback sample was not typed degradation");
    }
    const replacementStarted = performance.now();
    if (!(await fallback.waitUntilHealthy(
      manifest.thresholds.replacement_ready_ms,
    ))) {
      throw new Error("G4A replacement missed its bound");
    }
    replacementSamples.push(performance.now() - replacementStarted);
  }
  await fallback.close();
  fallback = null;

  const rebuildStarted = performance.now();
  rebuild = await GraphProcessHost.open({
    dataRoot,
    generationId: "resource-small-rebuild",
    expectedIdentity: identity,
    childEntry,
    requestTimeoutMs: 250,
    writeTimeoutMs: 10_000,
  });
  for (const snapshot of resourceSnapshots) {
    await rebuild.replaceScope(snapshot);
  }
  const smallRebuildMs = performance.now() - rebuildStarted;
  const smallRebuildDigest =
    graphGlobalLogicalDigest(resourceSnapshots);
  for (const snapshot of resourceSnapshots) {
    const readBack = await rebuild.readScopeSnapshot({
      principal_id: snapshot.principal_id,
      scope: snapshot.scope,
    });
    if (readBack?.logical_digest !== snapshot.logical_digest) {
      throw new Error("G4A small rebuild verification failed");
    }
  }
  await rebuild.close();
  rebuild = null;

  const expectedMaterializedStarted = performance.now();
  const expectedSnapshots = materializeG4AExpectedProfile(
    manifest.expected_profile,
  );
  const expectedMaterializationMs =
    performance.now() - expectedMaterializedStarted;
  const expectedLogicalDigest =
    graphGlobalLogicalDigest(expectedSnapshots);
  const graphRoot = join(dataRoot, "derived", "graph");
  const exportPath = join(graphRoot, "g4a-small-logical-export.json");
  writeFileSync(
    exportPath,
    JSON.stringify(resourceSnapshots),
    "utf8",
  );
  const expectedExportPath = join(
    dataRoot,
    "g4a-expected-logical-profile.json",
  );
  writeFileSync(
    expectedExportPath,
    JSON.stringify(
      expectedSnapshots.map((snapshot) => ({
        scope: snapshot.scope,
        logical_digest: snapshot.logical_digest,
        node_count: snapshot.nodes.length,
        edge_count: snapshot.edges.length,
      })),
    ),
    "utf8",
  );
  const backupRoot = join(dataRoot, "derived", "graph-backup");
  cpSync(graphRoot, backupRoot, { recursive: true });
  const databaseWalBytes = pathsUnder(graphRoot)
    .filter((path) =>
      path.endsWith("ladybug.lbdb") ||
      path.endsWith("ladybug.lbdb.wal")
    )
    .reduce((total, path) => total + statSync(path).size, 0);
  const quarantineBytes = bytesUnder(join(graphRoot, "quarantine"));
  const sqliteRequire = createRequire(
    new URL("../package.json", import.meta.url),
  );
  const BetterSqlite = sqliteRequire("better-sqlite3");
  const sqlite = new BetterSqlite(":memory:");
  const sqliteVersion = sqlite
    .prepare("SELECT sqlite_version() AS version")
    .get().version;
  sqlite.close();

  const metrics = {
    samples: {
      warmups: manifest.thresholds.warmup_samples,
      measured: manifest.thresholds.measured_samples,
      query_sample_hash: canonicalSha256(
        querySamples.map((value) => Number(value.toFixed(6))),
      ),
      fallback_sample_hash: canonicalSha256(
        fallbackSamples.map((value) => Number(value.toFixed(6))),
      ),
    },
    latency_ms: {
      graph_assisted_p50: percentile(querySamples, 0.5),
      graph_assisted_p95: percentile(querySamples, 0.95),
      fallback_p95: percentile(fallbackSamples, 0.95),
      process_startup: startupMs,
      replacement_max: Math.max(...replacementSamples),
      small_six_scope_rebuild: smallRebuildMs,
      expected_full_rebuild: null,
    },
    physical_bytes: {
      graph_database_wal: databaseWalBytes,
      logical_export: statSync(exportPath).size,
      logical_expected_profile_export: statSync(expectedExportPath).size,
      graph_backup: bytesUnder(backupRoot),
      install_delta: bytesUnder(dirname(ladybugEntry)),
      retained_quarantine: quarantineBytes,
    },
    rss_bytes: {
      parent_before: parentRssBefore,
      parent_after: process.memoryUsage().rss,
      child_idle: childIdleRss,
      child_peak_observed: childPeakRss,
      idle_delta: childIdleRss,
      peak_delta: childPeakRss,
    },
    process: {
      queue_debt: finalHealth.queue_depth,
      active_requests: finalHealth.active_requests,
      restart_count: finalHealth.restart_count,
    },
    small_profile: {
      scope_count: resourceSnapshots.length,
      logical_digest: smallRebuildDigest,
      native_physical_materialized: true,
    },
    expected_profile: {
      ...manifest.expected_profile,
      scope_count: expectedSnapshots.length,
      logical_materialized: true,
      logical_digest: expectedLogicalDigest,
      logical_materialization_ms: expectedMaterializationMs,
      native_physical_materialized: false,
      native_full_rebuild_measured: false,
      missing_reason:
        "EXPECTED_NATIVE_PROFILE_NOT_RUN_AFTER_STRUCTURAL_GATE_FAILED",
    },
  };
  const thresholdResults = {
    warmups:
      metrics.samples.warmups >= manifest.thresholds.warmup_samples,
    measured_samples:
      metrics.samples.measured >= manifest.thresholds.measured_samples,
    graph_p50:
      metrics.latency_ms.graph_assisted_p50 <=
      manifest.thresholds.governed_recall_p50_ms,
    graph_p95:
      metrics.latency_ms.graph_assisted_p95 <=
      manifest.thresholds.governed_recall_p95_ms,
    fallback_p95:
      metrics.latency_ms.fallback_p95 <=
      manifest.thresholds.fallback_p95_ms,
    replacement:
      metrics.latency_ms.replacement_max <=
      manifest.thresholds.replacement_ready_ms,
    expected_rebuild:
      metrics.latency_ms.expected_full_rebuild !== null &&
      metrics.latency_ms.expected_full_rebuild <=
        manifest.thresholds.expected_rebuild_ms,
    graph_database_wal:
      metrics.physical_bytes.graph_database_wal <=
      manifest.thresholds.graph_database_wal_bytes,
    install_delta:
      metrics.physical_bytes.install_delta <=
      manifest.thresholds.install_delta_bytes,
    idle_rss:
      metrics.rss_bytes.idle_delta !== null &&
      metrics.rss_bytes.idle_delta <=
        manifest.thresholds.idle_rss_delta_bytes,
    peak_rss:
      metrics.rss_bytes.peak_delta !== null &&
      metrics.rss_bytes.peak_delta <=
        manifest.thresholds.peak_rss_delta_bytes,
    queue_debt: metrics.process.queue_debt === 0,
    expected_native_profile:
      metrics.expected_profile.native_physical_materialized &&
      metrics.expected_profile.native_full_rebuild_measured,
  };
  const withoutHash = {
    schema_version: "1.0.0",
    recorded_at: new Date().toISOString(),
    gate: "G4A_RESOURCE",
    candidate_commit: candidateCommit,
    dependency_lock_hash: dependencyLockHash,
    manifest_hash: canonicalSha256(manifest),
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
      sqlite: sqliteVersion,
      ladybug: identity,
      storage_schema: "0012",
      graph_schema: "GraphRevision/GraphLink/GraphScope@1.0.0",
      compiler: "g4a-terminal-pattern-v1",
      transform: "g4a-frozen-topology-materializer@1.0.0",
      protocol: "G4A@1.0.0",
      corpus: canonicalSha256(manifest),
      runner_source_hash: rawSha256(
        readFileSync(
          resolve(
            repositoryRoot,
            "scripts/run-g4a-resource-benchmark.mjs",
          ),
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
      process_host_source_hash: rawSha256(
        readFileSync(
          resolve(
            repositoryRoot,
            "packages/graph-projection/src/process-host.ts",
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
      sample_identity: canonicalSha256({
        warmups: manifest.thresholds.warmup_samples,
        measured: manifest.thresholds.measured_samples,
        query: latencyQuery,
      }),
    },
    thresholds: manifest.thresholds,
    metrics,
    threshold_results: thresholdResults,
    resource_gate:
      Object.values(thresholdResults).every(Boolean),
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
  process.stdout.write(
    `${JSON.stringify({
      resource_gate: report.resource_gate,
      threshold_results: report.threshold_results,
      latency_ms: report.metrics.latency_ms,
      expected_profile: report.metrics.expected_profile,
    }, null, 2)}\n`,
  );
} finally {
  await Promise.allSettled(
    [graph, fallback, rebuild]
      .filter((host) => host !== null && host !== undefined)
      .map((host) => host.close()),
  );
  rmSync(dataRoot, { recursive: true, force: true });
}
