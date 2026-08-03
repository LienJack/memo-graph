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

import {
  EpisodeSchema,
  EvidenceRecordSchema,
  MemoryCandidateSchema,
  MemoryProposeInputSchema,
  ProjectionRevisionSchema,
  ScopeSchema,
  canonicalJson,
  canonicalSha256,
  deriveProjectionIdentity,
  type ProjectionPayload,
  type ProjectionRevision,
} from "@memo-graph/contracts";
import {
  SqliteStorageClient,
} from "@memo-graph/storage-sqlite";

import {
  ConsolidationService,
} from "./consolidation-service.js";
import {
  PROJECTION_TRANSFORM,
  projectionStructuralDigest,
  type ProjectionPolicyInput,
} from "./projection-policy.js";

const PRINCIPAL_ID = "benchmark_user";
const SCOPE = ScopeSchema.parse({
  kind: "workspace",
  id: "g3_resource_benchmark",
});
const AS_OF = "2026-07-28T12:00:00.000Z";

export type G3ResourceBenchmarkOptions = {
  evidence: number;
  l1: number;
  projections: number;
  relations: number;
};

type ProjectionDescriptor = {
  projection_type: "topic" | "relation";
  payload: ProjectionPayload;
  sources: ProjectionPolicyInput["sources"];
  content: {
    storage: "inline";
    text: string;
    media_type: "application/json";
  };
  content_hash: `sha256:${string}`;
  projection_id: string;
};

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

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function descriptor(
  input: ProjectionPolicyInput,
  projectionType: "topic" | "relation",
  payload: ProjectionPayload,
  sources: ProjectionPolicyInput["sources"],
): ProjectionDescriptor {
  const orderedSources = [...sources].sort((left, right) =>
    left.revision_id.localeCompare(right.revision_id)
  );
  const content = {
    storage: "inline" as const,
    text: canonicalJson(payload),
    media_type: "application/json" as const,
  };
  const contentHash = canonicalSha256(content);
  return {
    projection_type: projectionType,
    payload,
    sources: orderedSources,
    content,
    content_hash: contentHash,
    projection_id: deriveProjectionIdentity({
      projection_type: projectionType,
      principal_id: input.principal_id,
      scope: input.scope,
      source_revisions: orderedSources.map((source) => ({
        revision_id: source.revision_id,
      })),
      transform: PROJECTION_TRANSFORM,
      content_hash: contentHash,
    }),
  };
}

function sourceReference(
  input: ProjectionPolicyInput,
  source: ProjectionPolicyInput["sources"][number],
) {
  return {
    memory_id: source.memory_id,
    revision_id: source.revision_id,
    abstraction: "l1_memory" as const,
    principal_id: input.principal_id,
    scope: source.scope,
    authority: source.authority,
    sensitivity: source.sensitivity,
    validity: source.validity,
    content_hash: source.content_hash,
    evidence_ids: uniqueSorted(source.evidence_ids),
  };
}

export function buildG3ProfileProjections(
  input: ProjectionPolicyInput,
  options: {
    projections: number;
    relations: number;
  },
): ProjectionRevision[] {
  if (
    input.sources.length === 0 ||
    options.projections < 1 ||
    options.relations < 1
  ) {
    throw new Error("G3 resource projection counts must be positive");
  }
  const descriptors: ProjectionDescriptor[] = [];
  for (let index = 0; index < options.projections; index += 1) {
    const start = (index * 4) % input.sources.length;
    const sources = Array.from({ length: 4 }, (_, offset) =>
      input.sources[(start + offset) % input.sources.length]
    ).filter((source) => source !== undefined);
    descriptors.push(
      descriptor(
        input,
        "topic",
        {
          kind: "topic",
          key: `g3_benchmark_topic_${index}`,
          summary: `G3 benchmark topic ${index}`,
          open_items: [],
        },
        sources,
      ),
    );
  }
  for (let index = 0; index < options.relations; index += 1) {
    const source = input.sources[index % input.sources.length];
    const offset = 1 + Math.floor(index / input.sources.length);
    const target =
      input.sources[(index + offset) % input.sources.length];
    if (source === undefined || target === undefined) {
      throw new Error("G3 relation benchmark source is missing");
    }
    descriptors.push(
      descriptor(
        input,
        "relation",
        {
          kind: "relation",
          source_revision_id: source.revision_id,
          target_revision_id: target.revision_id,
          relation_type: "supports",
          direction: "directed",
          description: `G3 benchmark relation ${index}`,
        },
        [source, target],
      ),
    );
  }
  const sourceFrontierHash = canonicalSha256(
    [...input.sources]
      .sort((left, right) =>
        left.revision_id.localeCompare(right.revision_id)
      )
      .map((source) => ({
        revision_id: source.revision_id,
        content_hash: source.content_hash,
      })),
  );
  const projectionFrontierHash = canonicalSha256(
    descriptors
      .map((item) => ({
        projection_id: item.projection_id,
        content_hash: item.content_hash,
      }))
      .sort((left, right) =>
        left.projection_id.localeCompare(right.projection_id)
      ),
  );
  const frontier = {
    schema_version: "1.0.0" as const,
    ledger_epoch: input.ledger_epoch,
    tombstone_epoch: input.tombstone_epoch,
    projection_epoch: input.projection_epoch,
    transform: PROJECTION_TRANSFORM,
    source_frontier_hash: sourceFrontierHash,
    projection_frontier_hash: projectionFrontierHash,
  };
  return descriptors
    .map((item) => {
      const sources = item.sources.map((source) =>
        sourceReference(input, source)
      );
      const validFrom = sources
        .map((source) => source.validity.valid_from)
        .sort()
        .at(-1);
      const recordedAt = sources
        .map((source) => source.validity.recorded_at)
        .sort()
        .at(-1);
      if (validFrom === undefined || recordedAt === undefined) {
        throw new Error("G3 projection validity source is missing");
      }
      return ProjectionRevisionSchema.parse({
        schema_version: "1.0.0",
        projection_id: item.projection_id,
        projection_revision_id:
          `projection-revision:${canonicalSha256({
            projection_id: item.projection_id,
            frontier,
          }).slice("sha256:".length, 48)}`,
        revision: 1,
        projection_type: item.projection_type,
        abstraction:
          item.projection_type === "topic"
            ? "l2_topic"
            : "l2_relation",
        principal_id: input.principal_id,
        scope: input.scope,
        lifecycle: "active",
        authority: "derived",
        sensitivity: "internal",
        validity: {
          valid_from: validFrom,
          valid_to: null,
          recorded_at: recordedAt,
        },
        payload: item.payload,
        content: item.content,
        content_hash: item.content_hash,
        source_revisions: sources,
        evidence_ids: uniqueSorted(
          sources.flatMap((source) => source.evidence_ids),
        ),
        supersedes_projection_revision_id: null,
        transform: PROJECTION_TRANSFORM,
        frontier,
        created_at: recordedAt,
        invalidated_at: null,
        invalidation_reason: null,
      });
    })
    .sort(
      (left, right) =>
        left.projection_type.localeCompare(right.projection_type) ||
        left.projection_id.localeCompare(right.projection_id),
    );
}

function benchmarkEpisode(index: number) {
  const recordedAt = new Date(
    Date.UTC(2026, 6, 28, 0, 0, 0, index),
  ).toISOString();
  const evidenceId = `g3_benchmark_evidence_${index}`;
  const content = {
    storage: "inline" as const,
    text: `G3 governed benchmark memory ${index}`,
    media_type: "text/plain",
  };
  const evidence = EvidenceRecordSchema.parse({
    schema_version: "1.0.0",
    evidence_id: evidenceId,
    sequence: 0,
    occurred_at: recordedAt,
    recorded_at: recordedAt,
    scope: SCOPE,
    actor: {
      principal_id: PRINCIPAL_ID,
      authority: "user_stated",
    },
    source: "evaluation",
    authority: "user_stated",
    sensitivity: "internal",
    payload: content,
    content_hash: canonicalSha256(content),
  });
  const unsealed = {
    schema_version: "1.0.0" as const,
    episode_id: `g3_benchmark_episode_${index}`,
    scope: SCOPE,
    started_at: recordedAt,
    ended_at: recordedAt,
    event_ids: [evidenceId],
    artifact_hashes: [],
    outcome: "succeeded" as const,
  };
  return {
    command: {
      idempotencyKey: `g3:benchmark:episode:${index}`,
      episode: EpisodeSchema.parse({
        ...unsealed,
        sealed_hash: canonicalSha256(unsealed),
      }),
      evidence: [evidence],
      blobs: [],
    },
    evidence,
    recordedAt,
  };
}

function memoryProposal(
  index: number,
  episode: ReturnType<typeof benchmarkEpisode>,
) {
  const candidate = MemoryCandidateSchema.parse({
    schema_version: "1.0.0",
    candidate_id: `g3_benchmark_candidate_${index}`,
    logical_key: `g3.benchmark.memory.${index}`,
    kind: "semantic",
    scope: SCOPE,
    sensitivity: "internal",
    inferred: false,
    content: episode.evidence.payload,
    content_hash: episode.evidence.content_hash,
    evidence_ids: [episode.evidence.evidence_id],
    validity: {
      valid_from: episode.recordedAt,
      valid_to: null,
      recorded_at: episode.recordedAt,
    },
    injection_risk: "none",
    requires_user_confirmation: false,
    transform: {
      name: "g3-resource-benchmark",
      version: "1.0.0",
    },
  });
  return MemoryProposeInputSchema.parse({
    envelope: {
      schema_version: "1.0.0",
      request_id: `g3_benchmark_propose_${index}`,
      tool: "memory_propose",
      safety_class: "proposal",
      actor_claim: {
        principal_id: PRINCIPAL_ID,
        authority: "user_stated",
      },
      scopes: [SCOPE],
      purpose: "materialize the frozen G3 resource profile",
      reason: "measure projection storage and rebuild cost",
      requested_at: episode.recordedAt,
      idempotency_key: `g3:benchmark:memory:${index}`,
    },
    candidate,
  });
}

export async function runG3ResourceBenchmark(
  options: G3ResourceBenchmarkOptions,
) {
  if (
    !Number.isSafeInteger(options.evidence) ||
    !Number.isSafeInteger(options.l1) ||
    !Number.isSafeInteger(options.projections) ||
    !Number.isSafeInteger(options.relations) ||
    options.evidence < options.l1 ||
    options.l1 < 1 ||
    options.projections < 1 ||
    options.relations < 1
  ) {
    throw new Error("G3 resource profile counts are invalid");
  }
  const dataRoot = realpathSync(
    mkdtempSync(
      join(realpathSync(tmpdir()), "memo-graph-g3-resource-"),
    ),
  );
  const storage = await SqliteStorageClient.open({
    dataRoot,
    ...(process.env.G3_BENCH_DEBUG === "1"
      ? {
          onDiagnostic: (diagnostic: unknown) => {
            process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
          },
        }
      : {}),
  });
  const projector = (input: ProjectionPolicyInput) =>
    buildG3ProfileProjections(input, {
      projections: options.projections,
      relations: options.relations,
    });
  const consolidation = new ConsolidationService({
    storage,
    projector,
  });
  const startedAt = performance.now();
  let phase = "evidence setup";
  try {
    for (let index = 0; index < options.evidence; index += 1) {
      phase = `evidence commit ${index}`;
      const episode = benchmarkEpisode(index);
      await storage.commitEpisode(episode.command);
      if (index < options.l1) {
        phase = `L1 admission ${index}`;
        await storage.admitMemory({
          request: memoryProposal(index, episode),
          evaluation: {
            decision: "activate",
            reason: "G3 benchmark source is exact-scope governed evidence",
          },
        });
      }
    }
    let ftsRemaining = 1;
    phase = "FTS drain";
    let ftsIterations = 0;
    while (ftsRemaining > 0) {
      ftsIterations += 1;
      if (ftsIterations > options.evidence + options.l1 + 2) {
        throw new Error("G3 resource FTS drain did not converge");
      }
      const drained = await storage.drainFtsOutbox();
      if (drained.failed > 0) {
        throw new Error("G3 resource benchmark FTS drain failed");
      }
      ftsRemaining = drained.remaining;
    }
    const projectionStartedAt = performance.now();
    let projectionRemaining = 1;
    phase = "projection drain";
    let projectionIterations = 0;
    while (projectionRemaining > 0) {
      projectionIterations += 1;
      if (projectionIterations > options.l1 + 2) {
        throw new Error("G3 resource projection drain did not converge");
      }
      const drained = await consolidation.drain({
        worker_id: "g3_resource_benchmark_worker",
        claimed_at: AS_OF,
        lease_expires_at: "2026-07-28T12:05:00.000Z",
        limit: 100,
      });
      if (drained.failed > 0) {
        throw new Error("G3 resource projection drain failed");
      }
      projectionRemaining = drained.remaining;
    }
    const projectionDurationMs =
      performance.now() - projectionStartedAt;
    phase = "incremental projection query";
    const incremental = await storage.queryProjections({
      principal_id: PRINCIPAL_ID,
      scope: SCOPE,
      as_of: AS_OF,
      limit: 100_000,
    });
    const incrementalDigest = projectionStructuralDigest(
      incremental.items,
    );
    const rebuildStartedAt = performance.now();
    phase = "full projection rebuild";
    const rebuilt = await consolidation.rebuild({
      principal_id: PRINCIPAL_ID,
      scope: SCOPE,
      as_of: AS_OF,
      idempotency_key: "g3:resource:full-rebuild:0001",
      rebuild_receipt_id: "g3_resource_rebuild_receipt_0001",
    });
    const rebuildDurationMs = performance.now() - rebuildStartedAt;
    const health = await storage.health();
    const databasePath = join(dataRoot, "ledger", "memory.db");
    const walPath = `${databasePath}-wal`;
    const report = {
      recorded_at: new Date().toISOString(),
      runtime: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        sqlite: health.sqlite_version,
      },
      workload: {
        profile:
          options.evidence === 10_000 &&
          options.l1 === 1_000 &&
          options.projections === 250 &&
          options.relations === 1_000
            ? "small"
            : "custom",
        ...options,
      },
      counts: {
        evidence: health.counts.evidence_events,
        l1: health.counts.memory_objects,
        projections:
          health.counts.projection_objects -
          health.counts.relation_objects,
        relations: health.counts.relation_objects,
        projection_revisions: health.counts.projection_revisions,
        projection_sources: health.counts.projection_sources,
      },
      latency: {
        projection_build_ms:
          Math.round(projectionDurationMs * 1_000) / 1_000,
        full_rebuild_ms:
          Math.round(rebuildDurationMs * 1_000) / 1_000,
        total_ms:
          Math.round((performance.now() - startedAt) * 1_000) / 1_000,
      },
      rebuild: {
        applied: rebuilt.applied,
        incremental_digest: incrementalDigest,
        rebuilt_digest: rebuilt.structural_digest,
        equal: incrementalDigest === rebuilt.structural_digest,
      },
      storage: {
        database_bytes: statSync(databasePath).size,
        wal_bytes: statSync(walPath).size,
        data_root_bytes: directoryBytes(dataRoot),
      },
      memory: {
        rss_bytes: process.memoryUsage().rss,
        heap_used_bytes: process.memoryUsage().heapUsed,
      },
    };
    if (
      report.counts.evidence !== options.evidence ||
      report.counts.l1 !== options.l1 ||
      report.counts.projections !== options.projections ||
      report.counts.relations !== options.relations ||
      !report.rebuild.equal
    ) {
      throw new Error("G3 resource benchmark profile verification failed");
    }
    return report;
  } catch (error) {
    throw new Error(
      `G3 resource benchmark failed during ${phase}`,
      { cause: error },
    );
  } finally {
    await storage.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
}
