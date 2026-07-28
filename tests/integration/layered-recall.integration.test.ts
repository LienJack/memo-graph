import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ProjectionRevisionSchema,
  ScopeSchema,
  canonicalSha256,
} from "../../packages/contracts/src/index.js";
import {
  ConsolidationService,
  LayeredLaneRetrievers,
  RecallOrchestrator,
  type RecallLaneRetriever,
} from "../../packages/memory-kernel/src/index.js";
import {
  SqliteStorageClient,
  StorageError,
} from "@memo-graph/storage-sqlite";

import {
  memoryCandidate,
  revisionCommand,
} from "../helpers/governance-examples.js";
import {
  projectionFrontier,
  seedProjectionSources,
  seedLayeredProjectionSources,
  topicProjection,
} from "../helpers/projection-examples.js";
import { inlineEpisode } from "../helpers/storage-examples.js";

const cleanupPaths: string[] = [];
const MAIN_SCOPE = ScopeSchema.parse({
  kind: "workspace",
  id: "workspace_local",
});
const FOREIGN_SCOPE = ScopeSchema.parse({
  kind: "workspace",
  id: "workspace_foreign",
});
const ALL_LANES = [
  "recent_l1",
  "topic",
  "scenario_procedure",
  "core",
  "relation_sqlite",
] as const;

function temporaryRoot(prefix: string): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-graph-${prefix}-`)),
  );
  cleanupPaths.push(root);
  return root;
}

function lanePolicy(
  allowedLanes: typeof ALL_LANES[number][] = [...ALL_LANES],
) {
  return {
    allowed_lanes: allowedLanes,
    limits: {
      max_candidates_per_lane: 20,
      relation_max_depth: 2,
      relation_max_fanout: 5,
      max_concurrent_lanes: 2,
    },
  } as const;
}

async function seedLateRelevantProjections(
  storage: SqliteStorageClient,
): Promise<void> {
  const sources = await seedProjectionSources(storage);
  const health = await storage.health();
  const baseFrontier = projectionFrontier({
    ledgerEpoch: health.ledger_epoch,
    tombstoneEpoch: health.tombstone_epoch,
    projectionEpoch: 1,
  });
  const frontier = {
    ...baseFrontier,
    source_frontier_hash: canonicalSha256(
      sources
        .map((source) => ({
          revision_id: source.revision_id,
          content_hash: source.content_hash,
        }))
        .sort((left, right) =>
          left.revision_id.localeCompare(right.revision_id)
        ),
    ),
  };
  const base = topicProjection(sources, frontier);
  const projections = [
    ["projection_topic_early_a", "irrelevant alpha"],
    ["projection_topic_early_b", "irrelevant beta"],
    ["projection_topic_late_relevant", "needle appears late"],
  ].map(([projectionId, text]) => {
    const content = {
      storage: "inline",
      text,
      media_type: "text/plain",
    } as const;
    return ProjectionRevisionSchema.parse({
      ...base,
      projection_id: projectionId,
      projection_revision_id: `${projectionId}_revision_1`,
      payload: {
        kind: "topic",
        key: projectionId,
        summary: text,
        open_items: [],
      },
      content,
      content_hash: canonicalSha256(content),
    });
  });
  await storage.applyProjectionBatch({
    principal_id: "user_local",
    scope: MAIN_SCOPE,
    idempotency_key: "projection-late-relevant-0001",
    expected_projection_epoch: 0,
    projections,
    applied_at: "2026-07-28T12:05:00.000Z",
  });
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target !== undefined) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

describe("governed layered recall", () => {
  it("finds a relevant projection after the first page and exhausts clean misses", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("layered-recall-late-match"),
    });
    await seedLateRelevantProjections(storage);
    const policy = {
      ...lanePolicy(["topic"]),
      limits: {
        ...lanePolicy(["topic"]).limits,
        max_projection_scan_per_lane: 10,
      },
    };
    const overrides = {
      requested_lanes: ["topic"],
      limits: {
        max_candidates_per_lane: 1,
        max_projection_scan_per_lane: 10,
        max_concurrent_lanes: 1,
      },
    } satisfies NonNullable<
      Parameters<RecallOrchestrator["recall"]>[0]["lane_overrides"]
    >;
    const recalled = await new RecallOrchestrator({ storage }).recall({
      principal_id: "user_local",
      scope: MAIN_SCOPE,
      query: "needle",
      as_of: "2026-07-28T12:12:00.000Z",
      include_sensitive: false,
      lane_policy: policy,
      lane_overrides: overrides,
    });
    expect(recalled.status).toBe("OK");
    expect(
      recalled.candidates.map((candidate) =>
        candidate.kind === "projection"
          ? candidate.projection.projection_id
          : ""
      ),
    ).toEqual(["projection_topic_late_relevant"]);
    expect(
      recalled.telemetry.find((item) => item.lane === "topic")
        ?.bounded_work,
    ).toEqual([
      {
        boundary: "projection_scan",
        configured_limit: 10,
        observed_count: 3,
        retained_count: 3,
        truncated_count: 0,
        complete: true,
      },
      {
        boundary: "projection_return",
        configured_limit: 1,
        observed_count: 1,
        retained_count: 1,
        truncated_count: 0,
        complete: true,
      },
    ]);

    const missed = await new RecallOrchestrator({ storage }).recall({
      principal_id: "user_local",
      scope: MAIN_SCOPE,
      query: "absent",
      as_of: "2026-07-28T12:12:00.000Z",
      include_sensitive: false,
      lane_policy: policy,
      lane_overrides: overrides,
    });
    expect(missed.status).toBe("NO_MATCH");
    expect(
      missed.telemetry.find((item) => item.lane === "topic")
        ?.bounded_work?.[0],
    ).toMatchObject({
      boundary: "projection_scan",
      retained_count: 3,
      truncated_count: 0,
      complete: true,
    });
    await storage.close();
  });

  it("degrades instead of emitting NO_MATCH when the projection scan ceiling is reached", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("layered-recall-scan-limit"),
    });
    await seedLateRelevantProjections(storage);
    const recalled = await new RecallOrchestrator({ storage }).recall({
      principal_id: "user_local",
      scope: MAIN_SCOPE,
      query: "needle",
      as_of: "2026-07-28T12:12:00.000Z",
      include_sensitive: false,
      lane_policy: {
        ...lanePolicy(["topic"]),
        limits: {
          ...lanePolicy(["topic"]).limits,
          max_projection_scan_per_lane: 2,
        },
      },
      lane_overrides: {
        requested_lanes: ["topic"],
        limits: {
          max_candidates_per_lane: 1,
          max_projection_scan_per_lane: 2,
          max_concurrent_lanes: 1,
        },
      },
    });
    expect(recalled.status).toBe("DEGRADED");
    expect(recalled.candidates).toEqual([]);
    expect(recalled.degraded_lanes).toEqual(["topic"]);
    expect(
      recalled.telemetry.find((item) => item.lane === "topic"),
    ).toMatchObject({
      status: "degraded",
      reason_codes: ["PROJECTION_SCAN_LIMIT"],
      bounded_work: [
        {
          boundary: "projection_scan",
          configured_limit: 2,
          observed_count: 3,
          retained_count: 2,
          truncated_count: 1,
          complete: false,
          reason_code: "PROJECTION_SCAN_LIMIT",
        },
        {
          boundary: "projection_return",
          configured_limit: 1,
          observed_count: 0,
          retained_count: 0,
          truncated_count: 0,
          complete: true,
        },
      ],
    });
    await storage.close();
  });

  it("names a concurrent scope-frontier change as degradation", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("layered-recall-frontier-change"),
    });
    const retriever: RecallLaneRetriever = {
      retrieve: async () => {
        throw new StorageError("STALE_PROJECTION_FRONTIER", {
          retryable: true,
        });
      },
    };
    const recalled = await new RecallOrchestrator({
      storage,
      retriever,
    }).recall({
      principal_id: "user_local",
      scope: MAIN_SCOPE,
      query: "needle",
      as_of: "2026-07-28T12:12:00.000Z",
      include_sensitive: false,
      lane_policy: lanePolicy(["topic"]),
      lane_overrides: {
        requested_lanes: ["topic"],
        limits: { max_concurrent_lanes: 1 },
      },
    });
    expect(recalled.status).toBe("DEGRADED");
    expect(recalled.degraded_lanes).toEqual(["topic"]);
    expect(
      recalled.telemetry.find((item) => item.lane === "topic"),
    ).toMatchObject({
      status: "unavailable",
      reason_codes: ["PROJECTION_FRONTIER_CHANGED"],
    });
    await storage.close();
  });

  it("returns every enabled exact-scope lane with revalidated lineage", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("layered-recall"),
    });
    await seedLayeredProjectionSources(storage);
    await seedLayeredProjectionSources(storage, {
      prefix: "foreign",
      scopeId: FOREIGN_SCOPE.id,
    });
    const consolidation = new ConsolidationService({ storage });
    expect(
      await consolidation.drain({
        worker_id: "layered_recall_projection_worker",
        claimed_at: "2026-07-28T12:10:00.000Z",
        lease_expires_at: "2026-07-28T12:11:00.000Z",
      }),
    ).toMatchObject({ claimed: 8, processed: 8, failed: 0 });

    const recalled = await new RecallOrchestrator({ storage }).recall({
      principal_id: "user_local",
      scope: MAIN_SCOPE,
      query: "agent memory",
      as_of: "2026-07-28T12:12:00.000Z",
      include_sensitive: false,
      lane_policy: lanePolicy(),
      lane_overrides: {
        requested_lanes: [...ALL_LANES],
        limits: {
          max_candidates_per_lane: 10,
          relation_max_depth: 1,
          relation_max_fanout: 2,
          max_concurrent_lanes: 2,
        },
      },
    });

    expect(recalled.status).toBe("OK");
    expect(
      [...new Set(recalled.candidates.map((candidate) => candidate.lane))]
        .sort(),
    ).toEqual([...ALL_LANES].sort());
    expect(
      recalled.candidates.every(
        (candidate) =>
          candidate.canonical_revalidated &&
          candidate.scope.kind === MAIN_SCOPE.kind &&
          candidate.scope.id === MAIN_SCOPE.id,
      ),
    ).toBe(true);
    expect(
      recalled.candidates.some(
        (candidate) => candidate.scope.id === FOREIGN_SCOPE.id,
      ),
    ).toBe(false);
    expect(recalled.telemetry).toHaveLength(ALL_LANES.length);
    expect(
      recalled.telemetry.every(
        (item) =>
          item.status === "eligible" &&
          item.candidate_count >= item.eligible_count &&
          item.eligible_count === item.selected_count,
      ),
    ).toBe(true);
    const relationTelemetry = recalled.telemetry.find(
      (item) => item.lane === "relation_sqlite",
    );
    expect(relationTelemetry?.selected_count).toBeLessThanOrEqual(10);
    await storage.close();
  });

  it("clamps forged expansion and preserves recent L1 when one lane fails", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("layered-recall-degraded"),
    });
    await seedLayeredProjectionSources(storage);
    const consolidation = new ConsolidationService({ storage });
    await consolidation.drain({
      worker_id: "layered_recall_degraded_projection_worker",
      claimed_at: "2026-07-28T12:10:00.000Z",
      lease_expires_at: "2026-07-28T12:11:00.000Z",
    });
    const base = new LayeredLaneRetrievers(storage);
    const failingRetriever: RecallLaneRetriever = {
      retrieve: async (request) => {
        if (request.lane === "topic") {
          throw new Error("simulated topic lane outage");
        }
        return base.retrieve(request);
      },
    };
    const recalled = await new RecallOrchestrator({
      storage,
      retriever: failingRetriever,
    }).recall({
      principal_id: "user_local",
      scope: MAIN_SCOPE,
      query: "agent memory",
      as_of: "2026-07-28T12:12:00.000Z",
      include_sensitive: false,
      lane_policy: lanePolicy(["recent_l1", "topic"]),
      lane_overrides: {
        requested_lanes: [...ALL_LANES],
        limits: {
          max_candidates_per_lane: 100,
          relation_max_depth: 4,
          relation_max_fanout: 100,
          max_concurrent_lanes: 5,
        },
      },
    });

    expect(recalled.status).toBe("DEGRADED");
    expect(recalled.degraded_lanes).toEqual(["topic"]);
    expect(
      recalled.candidates.every(
        (candidate) => candidate.lane === "recent_l1",
      ),
    ).toBe(true);
    expect(recalled.effective_configuration.enabled_lanes).toEqual([
      "recent_l1",
      "topic",
    ]);
    expect(recalled.effective_configuration.limits).toEqual(
      lanePolicy(["recent_l1", "topic"]).limits,
    );
    expect(recalled.effective_configuration.reason_codes).toEqual([
      "LANE_DENIED_BY_POLICY:core",
      "LANE_DENIED_BY_POLICY:relation_sqlite",
      "LANE_DENIED_BY_POLICY:scenario_procedure",
      "LIMIT_CLAMPED_BY_POLICY:max_candidates_per_lane",
      "LIMIT_CLAMPED_BY_POLICY:max_concurrent_lanes",
      "LIMIT_CLAMPED_BY_POLICY:relation_max_depth",
      "LIMIT_CLAMPED_BY_POLICY:relation_max_fanout",
    ]);
    expect(
      recalled.telemetry.find((item) => item.lane === "topic"),
    ).toMatchObject({
      status: "unavailable",
      reason_codes: ["LANE_UNAVAILABLE:topic"],
    });
    expect(
      recalled.telemetry.find((item) => item.lane === "core"),
    ).toMatchObject({ status: "disabled_by_policy" });
    await storage.close();
  });

  it("rejects a projection changed between lane query and revalidation", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("layered-recall-race"),
    });
    const admitted = await seedLayeredProjectionSources(storage);
    const consolidation = new ConsolidationService({ storage });
    await consolidation.drain({
      worker_id: "layered_recall_race_projection_worker",
      claimed_at: "2026-07-28T12:10:00.000Z",
      lease_expires_at: "2026-07-28T12:11:00.000Z",
    });
    await storage.commitEpisode(
      inlineEpisode({
        episodeId: "episode_layered_race_correction",
        evidenceId: "evidence_layered_race_correction",
        idempotencyKey: "commit:layered-race-correction:0001",
        text: "Agent memory correction wins immediately.",
      }),
    );
    const base = new LayeredLaneRetrievers(storage);
    let corrected = false;
    const racingRetriever: RecallLaneRetriever = {
      retrieve: async (request) => {
        const result = await base.retrieve(request);
        const first = admitted[0];
        if (request.lane === "topic" && !corrected && first !== undefined) {
          corrected = true;
          await storage.applyMemoryRevision(
            revisionCommand({
              memoryId: first.memory_id,
              expectedRevisionId: first.current_revision_id,
              candidate: memoryCandidate({
                candidateId: "candidate_layered_race_correction",
                logicalKey: "projection.layered_semantic_a",
                scope: {
                  kind: "workspace",
                  id: MAIN_SCOPE.id,
                },
                text: "Agent memory correction wins immediately.",
                evidenceIds: ["evidence_layered_race_correction"],
              }),
              idempotencyKey: "layered-race-correction-0001",
            }),
          );
        }
        return result;
      },
    };
    const recalled = await new RecallOrchestrator({
      storage,
      retriever: racingRetriever,
    }).recall({
      principal_id: "user_local",
      scope: MAIN_SCOPE,
      query: "agent memory",
      as_of: "2026-07-28T12:12:00.000Z",
      include_sensitive: false,
      lane_policy: lanePolicy(["topic"]),
      lane_overrides: {
        requested_lanes: ["topic"],
        limits: { max_concurrent_lanes: 1 },
      },
    });

    expect(recalled.status).toBe("POLICY_EXCLUDED");
    expect(recalled.candidates).toEqual([]);
    expect(
      recalled.exclusions.map((exclusion) => exclusion.reason_code),
    ).toContain("PROJECTION_STALE_FRONTIER");
    expect(recalled.telemetry.find(
      (item) => item.lane === "topic",
    )).toMatchObject({
      status: "stale",
      selected_count: 0,
    });
    await storage.close();
  });

  it("matches the governed L1 baseline when projection lanes are disabled", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("layered-recall-baseline"),
    });
    await seedLayeredProjectionSources(storage);
    const baseline = await storage.searchGovernedMemory({
      query: "agent memory",
      principal_id: "user_local",
      scope: MAIN_SCOPE,
      as_of: "2026-07-28T12:12:00.000Z",
      include_sensitive: false,
      context_scope: MAIN_SCOPE,
      limit: 20,
    });
    const recalled = await new RecallOrchestrator({ storage }).recall({
      principal_id: "user_local",
      scope: MAIN_SCOPE,
      query: "agent memory",
      as_of: "2026-07-28T12:12:00.000Z",
      include_sensitive: false,
      lane_policy: lanePolicy(["recent_l1"]),
    });

    expect(recalled.status).toBe("OK");
    expect(
      recalled.candidates.map((candidate) =>
        candidate.kind === "memory" ? candidate.memory : null
      ),
    ).toEqual(baseline.items.map((item) => item.item));
    expect(recalled.exclusions).toEqual(
      baseline.exclusions.map((item) => ({
        memory_id: item.memory_id,
        revision_id: item.revision_id,
        lane: "recent_l1",
        reason_code: item.reason_code,
        score: item.score,
      })),
    );
    expect(
      recalled.telemetry.filter(
        (item) => item.status === "disabled_by_policy",
      ).map((item) => item.lane),
    ).toEqual([]);
    expect(
      recalled.telemetry.filter(
        (item) => item.status === "disabled_by_request",
      ).map((item) => item.lane),
    ).toEqual([
      "topic",
      "scenario_procedure",
      "core",
      "relation_sqlite",
    ]);
    expect(
      (
        await new RecallOrchestrator({ storage }).recall({
          principal_id: "user_local",
          scope: MAIN_SCOPE,
          query: "unmatchedzz",
          as_of: "2026-07-28T12:12:00.000Z",
          include_sensitive: false,
          lane_policy: lanePolicy(["recent_l1"]),
        })
      ).status,
    ).toBe("NO_MATCH");
    await storage.close();
  });
});
