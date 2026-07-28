import {
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import {
  EpisodeSchema,
  EvidenceRecordSchema,
  canonicalSha256,
} from "@memo-graph/contracts";

import { SqliteStorageClient } from "./client.js";

type Percentiles = {
  p50_ms: number;
  p95_ms: number;
  max_ms: number;
};

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * quantile) - 1),
  );
  return sorted[index] ?? 0;
}

function summarize(values: number[]): Percentiles {
  const round = (value: number) => Math.round(value * 1_000) / 1_000;
  return {
    p50_ms: round(percentile(values, 0.5)),
    p95_ms: round(percentile(values, 0.95)),
    max_ms: round(Math.max(...values)),
  };
}

function directoryBytes(path: string): number {
  const entry = statSync(path);
  if (!entry.isDirectory()) {
    return entry.size;
  }
  return readdirSync(path).reduce(
    (total, child) => total + directoryBytes(join(path, child)),
    0,
  );
}

function benchmarkCommand(index: number) {
  const occurredAt = new Date(
    Date.UTC(2026, 6, 28, 0, 0, 0, index),
  ).toISOString();
  const evidenceId = `bench_evidence_${index}`;
  const episodeId = `bench_episode_${index}`;
  const payload = {
    storage: "inline",
    text: `Governed benchmark context item ${index}`,
    media_type: "text/plain",
  } as const;
  const evidence = EvidenceRecordSchema.parse({
    schema_version: "1.0.0",
    evidence_id: evidenceId,
    sequence: 0,
    occurred_at: occurredAt,
    recorded_at: occurredAt,
    scope: { kind: "workspace", id: "benchmark_workspace" },
    actor: {
      principal_id: "benchmark_user",
      authority: "observed",
    },
    source: "evaluation",
    authority: "observed",
    sensitivity: "internal",
    payload,
    content_hash: canonicalSha256(payload),
  });
  const unsealed = {
    schema_version: "1.0.0",
    episode_id: episodeId,
    scope: evidence.scope,
    started_at: occurredAt,
    ended_at: occurredAt,
    event_ids: [evidenceId],
    artifact_hashes: [],
    outcome: "succeeded",
  } as const;
  const episode = EpisodeSchema.parse({
    ...unsealed,
    sealed_hash: canonicalSha256(unsealed),
  });
  return {
    idempotencyKey: `benchmark:episode:${index}`,
    episode,
    evidence: [evidence],
    blobs: [],
  };
}

export async function runStorageBenchmark(
  eventCount = 10_000,
): Promise<Record<string, unknown>> {
  const dataRoot = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "memo-graph-benchmark-")),
  );
  const client = await SqliteStorageClient.open({ dataRoot });
  const commitLatencies: number[] = [];
  const searchLatencies: number[] = [];
  const startedAt = performance.now();

  try {
    for (let index = 0; index < eventCount; index += 1) {
      const operationStartedAt = performance.now();
      await client.commitEpisode(benchmarkCommand(index));
      commitLatencies.push(performance.now() - operationStartedAt);
    }

    let remaining = 1;
    let projected = 0;
    const projectionStartedAt = performance.now();
    while (remaining > 0) {
      const drained = await client.drainFtsOutbox();
      projected += drained.processed;
      remaining = drained.remaining;
      if (drained.failed > 0) {
        throw new Error("benchmark FTS projection failed");
      }
    }
    const projectionDurationMs = performance.now() - projectionStartedAt;

    for (let index = 0; index < 200; index += 1) {
      const operationStartedAt = performance.now();
      const result = await client.searchEvidence({
        query: `context item ${index % Math.max(1, eventCount)}`,
        scope: { kind: "workspace", id: "benchmark_workspace" },
        limit: 20,
      });
      if (result.status !== "OK") {
        throw new Error("benchmark search returned no result");
      }
      searchLatencies.push(performance.now() - operationStartedAt);
    }

    const backupStartedAt = performance.now();
    const backup = await client.createBackup();
    const backupDurationMs = performance.now() - backupStartedAt;
    const health = await client.health();
    const totalDurationMs = performance.now() - startedAt;
    const profile =
      eventCount === 10_000
        ? "small"
        : eventCount === 250_000
          ? "expected"
          : "custom";

    return {
      recorded_at: new Date().toISOString(),
      runtime: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        sqlite: health.sqlite_version,
      },
      workload: {
        profile,
        evidence_events: eventCount,
        episodes: eventCount,
        search_samples: searchLatencies.length,
        projected,
        concurrent_readers: 1,
        serialized_writers: 1,
      },
      latency: {
        commit: summarize(commitLatencies),
        search: summarize(searchLatencies),
        projection_total_ms:
          Math.round(projectionDurationMs * 1_000) / 1_000,
        backup_ms: Math.round(backupDurationMs * 1_000) / 1_000,
        total_ms: Math.round(totalDurationMs * 1_000) / 1_000,
      },
      thresholds: {
        commit_p95_ms: 150,
        search_p95_ms: 200,
        commit_pass: summarize(commitLatencies).p95_ms <= 150,
        search_pass: summarize(searchLatencies).p95_ms <= 200,
      },
      storage: {
        database_bytes: statSync(join(dataRoot, "ledger", "memory.db")).size,
        backup_bytes: backup.size_bytes,
        data_root_bytes: directoryBytes(dataRoot),
      },
      memory: {
        rss_bytes: process.memoryUsage().rss,
        heap_used_bytes: process.memoryUsage().heapUsed,
      },
      frontier: {
        schema_version: health.schema_version,
        ledger_epoch: health.ledger_epoch,
        latest_receipt_hash: health.latest_receipt_hash,
      },
    };
  } finally {
    await client.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

const invokedAsScript =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  const requested = Number.parseInt(
    process.env.MEMO_GRAPH_BENCH_EVENTS ?? "10000",
    10,
  );
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new Error("MEMO_GRAPH_BENCH_EVENTS must be a positive integer");
  }
  process.stdout.write(
    `${JSON.stringify(await runStorageBenchmark(requested), null, 2)}\n`,
  );
}
