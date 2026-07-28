import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import {
  SqliteStorageClient,
  storageBenchmarkCommand,
} from "@memo-graph/storage-sqlite";

import { MemoryRuntime } from "./index.js";

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

function readEnvelope(tool: string, requestId: string) {
  return {
    schema_version: "1.0.0",
    request_id: requestId,
    tool,
    actor_claim: {
      principal_id: "benchmark_user",
      authority: "observed",
    },
    scopes: [{ kind: "workspace", id: "benchmark_workspace" }],
    purpose: "measure the governed local runtime",
    reason: "M1B Small-profile baseline",
    requested_at: "2026-07-29T00:00:00.000Z",
    safety_class: "read_only",
  };
}

export async function runMemoryRuntimeBenchmark(
  eventCount = 10_000,
  sampleCount = 200,
): Promise<Record<string, unknown>> {
  const dataRoot = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "memo-graph-runtime-benchmark-")),
  );
  const storage = await SqliteStorageClient.open({ dataRoot });
  const runtime = new MemoryRuntime({
    storage,
    policy: {
      principal: {
        principal_id: "benchmark_user",
        allowed_scopes: [
          { kind: "workspace", id: "benchmark_workspace" },
        ],
        allowed_authorities: ["observed"],
        destructive_tools_enabled: false,
      },
      default_token_budget: 1_800,
    },
  });
  const searchLatencies: number[] = [];
  const compileLatencies: number[] = [];
  const commitLatencies: number[] = [];

  try {
    for (let index = 0; index < eventCount; index += 1) {
      await storage.commitEpisode(storageBenchmarkCommand(index));
    }
    let remaining = 1;
    while (remaining > 0) {
      const drained = await storage.drainFtsOutbox();
      if (drained.failed > 0) {
        throw new Error("benchmark FTS projection failed");
      }
      remaining = drained.remaining;
    }

    for (let index = 0; index < sampleCount; index += 1) {
      const query = `context item ${index % eventCount}`;
      let startedAt = performance.now();
      const search = await runtime.memorySearch({
        envelope: readEnvelope("memory_search", `bench_search_${index}`),
        query,
        limit: 20,
        include_sensitive: false,
      });
      searchLatencies.push(performance.now() - startedAt);
      if (search.status !== "OK") {
        throw new Error("benchmark governed search failed");
      }

      const requestId = `bench_compile_${index}`;
      startedAt = performance.now();
      const compiled = await runtime.memoryContextCompile({
        envelope: readEnvelope("memory_context_compile", requestId),
        recall: {
          schema_version: "1.0.0",
          request_id: requestId,
          goal: "restore governed benchmark context",
          query,
          scopes: [{ kind: "workspace", id: "benchmark_workspace" }],
          as_of: "2026-07-29T00:00:00.000Z",
          token_budget: 1_800,
          include_sensitive: false,
        },
      });
      compileLatencies.push(performance.now() - startedAt);
      if (compiled.status !== "OK") {
        throw new Error("benchmark Context compilation failed");
      }
    }

    for (let index = 0; index < sampleCount; index += 1) {
      const command = storageBenchmarkCommand(eventCount + index);
      const envelope = {
        ...readEnvelope(
          "memory_episode_commit",
          `bench_commit_${index}`,
        ),
        safety_class: "proposal",
        idempotency_key: command.idempotencyKey,
      };
      const startedAt = performance.now();
      const committed = await runtime.memoryEpisodeCommit({
        envelope,
        episode: command.episode,
        evidence: command.evidence,
        blobs: [],
      });
      commitLatencies.push(performance.now() - startedAt);
      if (committed.status !== "OK") {
        throw new Error("benchmark governed commit failed");
      }
    }

    const health = await storage.health();
    const search = summarize(searchLatencies);
    const compile = summarize(compileLatencies);
    const commit = summarize(commitLatencies);
    return {
      recorded_at: new Date().toISOString(),
      runtime: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        sqlite: health.sqlite_version,
      },
      workload: {
        profile: eventCount === 10_000 ? "small" : "custom",
        initial_evidence_events: eventCount,
        samples_per_operation: sampleCount,
        scopes_per_request: 1,
        context_token_budget: 1_800,
      },
      latency: { search, context_compile: compile, episode_commit: commit },
      thresholds: {
        search_p95_ms: 200,
        context_compile_p95_ms: 400,
        episode_commit_p95_ms: 150,
        search_pass: search.p95_ms <= 200,
        context_compile_pass: compile.p95_ms <= 400,
        episode_commit_pass: commit.p95_ms <= 150,
      },
      frontier: {
        schema_version: health.schema_version,
        ledger_epoch: health.ledger_epoch,
        evidence_events: health.counts.evidence_events,
        recall_requests: health.counts.recall_requests,
        context_slices: health.counts.context_slices,
      },
      memory: {
        rss_bytes: process.memoryUsage().rss,
        heap_used_bytes: process.memoryUsage().heapUsed,
      },
    };
  } finally {
    await storage.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

const invokedAsScript =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  const eventCount = Number.parseInt(
    process.env.MEMO_GRAPH_BENCH_EVENTS ?? "10000",
    10,
  );
  const sampleCount = Number.parseInt(
    process.env.MEMO_GRAPH_BENCH_SAMPLES ?? "200",
    10,
  );
  if (
    !Number.isSafeInteger(eventCount) ||
    eventCount < 1 ||
    !Number.isSafeInteger(sampleCount) ||
    sampleCount < 1
  ) {
    throw new Error("benchmark counts must be positive safe integers");
  }
  process.stdout.write(
    `${JSON.stringify(
      await runMemoryRuntimeBenchmark(eventCount, sampleCount),
      null,
      2,
    )}\n`,
  );
}
