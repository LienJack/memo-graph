import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";

import {
  GovernedResponseSchema,
} from "../../packages/contracts/src/index.js";
import {
  ConsolidationService,
  LayeredLaneRetrievers,
  MemoryRuntime,
  type RecallLaneRetriever,
} from "../../packages/memory-kernel/src/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";

import {
  memoryCandidate,
  revisionCommand,
} from "../helpers/governance-examples.js";
import {
  seedLayeredProjectionSources,
} from "../helpers/projection-examples.js";
import { inlineEpisode } from "../helpers/storage-examples.js";

const cleanupPaths: string[] = [];
const NOW = "2026-07-28T12:12:00.000Z";
const SCOPE = { kind: "workspace", id: "workspace_local" } as const;
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

function runtime(
  storage: SqliteStorageClient,
  options: {
    allowedLanes?: typeof ALL_LANES[number][];
    laneRetriever?: RecallLaneRetriever;
  } = {},
) {
  return new MemoryRuntime({
    storage,
    ...(options.laneRetriever === undefined
      ? {}
      : { laneRetriever: options.laneRetriever }),
    policy: {
      principal: {
        principal_id: "user_local",
        allowed_scopes: [SCOPE],
        allowed_authorities: ["user_stated"],
        destructive_tools_enabled: false,
      },
      default_token_budget: 1_800,
      lane_policy: {
        allowed_lanes: options.allowedLanes ?? [...ALL_LANES],
        limits: {
          max_candidates_per_lane: 20,
          relation_max_depth: 2,
          relation_max_fanout: 5,
          max_concurrent_lanes: 2,
        },
      },
    },
  });
}

function compileRequest(requestId: string, query = "agent memory") {
  return {
    envelope: {
      schema_version: "1.0.0",
      request_id: requestId,
      tool: "memory_context_compile",
      actor_claim: {
        principal_id: "user_local",
        authority: "user_stated",
      },
      scopes: [SCOPE],
      purpose: "compile exact-scope layered context",
      reason: "verify frozen runtime integration",
      requested_at: NOW,
      safety_class: "read_only",
    },
    recall: {
      schema_version: "1.0.0",
      request_id: requestId,
      goal: "restore governed agent memory",
      query,
      scopes: [SCOPE],
      as_of: NOW,
      token_budget: 1_800,
      include_sensitive: false,
      lane_overrides: {
        requested_lanes: [...ALL_LANES],
        limits: {
          max_candidates_per_lane: 1_000,
          relation_max_depth: 4,
          relation_max_fanout: 100,
          max_concurrent_lanes: 5,
        },
      },
    },
  } as const;
}

async function drain(storage: SqliteStorageClient, workerId: string) {
  return new ConsolidationService({ storage }).drain({
    worker_id: workerId,
    claimed_at: "2026-07-28T12:10:00.000Z",
    lease_expires_at: "2026-07-28T12:11:00.000Z",
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

describe("frozen layered Context runtime", () => {
  it("returns the same typed lane and frontier evidence through stdio MCP", async () => {
    const dataRoot = temporaryRoot("layered-context-mcp");
    const storage = await SqliteStorageClient.open({ dataRoot });
    await seedLayeredProjectionSources(storage);
    await drain(storage, "layered_context_mcp_worker");
    await storage.close();
    const configPath = join(dataRoot, "mcp-layered-context.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        data_root: dataRoot,
        principal_id: "user_local",
        allowed_scopes: [SCOPE],
        allowed_authorities: ["user_stated"],
        destructive_tools_enabled: false,
        default_token_budget: 1_800,
        lane_policy: {
          allowed_lanes: ["recent_l1", "topic"],
          limits: {
            max_candidates_per_lane: 20,
            relation_max_depth: 2,
            relation_max_fanout: 5,
            max_concurrent_lanes: 2,
          },
        },
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        join(process.cwd(), "packages/mcp-server/dist/cli.js"),
        "--config",
        configPath,
      ],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    const client = new Client({
      name: "layered-context-integration-client",
      version: "0.1.0",
    });
    await client.connect(transport);
    const called = await client.callTool({
      name: "memory_context_compile",
      arguments: compileRequest("request_layered_context_mcp"),
    });
    const response = GovernedResponseSchema.parse(
      called.structuredContent,
    );
    expect(response.status).toBe("OK");
    if (response.status !== "OK") {
      throw new Error("stdio MCP layered Context must compile");
    }
    const context = (
      response.data as {
        context_slice: {
          frontier: unknown;
          lane_telemetry: unknown[];
          effective_lane_configuration: {
            enabled_lanes: string[];
            limits: Record<string, number>;
          };
        };
        receipt: { frontier?: unknown };
      }
    );
    expect(context.context_slice.frontier).toEqual(
      context.receipt.frontier,
    );
    expect(context.context_slice.lane_telemetry).toHaveLength(
      ALL_LANES.length,
    );
    expect(
      context.context_slice.effective_lane_configuration.enabled_lanes,
    ).toEqual(["recent_l1", "topic"]);
    expect(
      context.context_slice.effective_lane_configuration.limits,
    ).toEqual({
      max_candidates_per_lane: 20,
      relation_max_depth: 2,
      relation_max_fanout: 5,
      max_concurrent_lanes: 2,
    });
    await client.close();
  });

  it("persists an exact layered slice and replays it byte-for-byte after restart", async () => {
    const dataRoot = temporaryRoot("frozen-layered-context");
    let storage = await SqliteStorageClient.open({ dataRoot });
    await seedLayeredProjectionSources(storage);
    expect(await drain(storage, "frozen_layered_worker")).toMatchObject({
      claimed: 4,
      processed: 4,
      failed: 0,
    });
    const request = compileRequest("request_frozen_layered_context");
    const first = await runtime(storage).memoryContextCompile(request);
    expect(first.status).toBe("OK");
    if (first.status !== "OK") {
      throw new Error("layered Context fixture must compile");
    }
    const firstData = first.data as {
      context_slice: {
        items: Array<{
          abstraction: string;
          projection?: unknown;
        }>;
        frontier: unknown;
        effective_lane_configuration: {
          enabled_lanes: string[];
          limits: Record<string, number>;
          reason_codes: string[];
        };
        lane_telemetry: unknown[];
      };
      receipt: { frontier?: unknown };
      replayed: boolean;
    };
    expect(
      firstData.context_slice.items.some((item) =>
        item.abstraction.startsWith("l2_") ||
        item.abstraction === "l3_core"
      ),
    ).toBe(true);
    expect(firstData.context_slice.frontier).toEqual(
      firstData.receipt.frontier,
    );
    expect(firstData.context_slice.lane_telemetry).toHaveLength(
      ALL_LANES.length,
    );
    expect(
      firstData.context_slice.effective_lane_configuration.limits,
    ).toEqual({
      max_candidates_per_lane: 20,
      relation_max_depth: 2,
      relation_max_fanout: 5,
      max_concurrent_lanes: 2,
    });
    expect(firstData.replayed).toBe(false);
    const replay = await runtime(storage).memoryContextCompile(request);
    expect(replay).toMatchObject({
      status: "OK",
      data: { replayed: true },
    });
    expect(
      replay.status === "OK"
        ? (replay.data as { context_slice: unknown }).context_slice
        : null,
    ).toEqual(firstData.context_slice);

    expect(await storage.verifyRestoreCandidate()).toMatchObject({
      active_projections_verified: expect.any(Number),
      active_relations_verified: expect.any(Number),
      projection_rebuild_required: false,
    });
    await storage.close();
    storage = await SqliteStorageClient.open({ dataRoot });
    expect(
      await runtime(storage).memoryContextCompile(request),
    ).toMatchObject({
      status: "OK",
      data: {
        replayed: true,
        context_slice: firstData.context_slice,
      },
    });
    await storage.close();
  });

  it("clamps MCP lane expansion and degrades to revalidated L1 on lane failure", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("layered-context-degraded"),
    });
    await seedLayeredProjectionSources(storage);
    await drain(storage, "layered_context_degraded_worker");
    const base = new LayeredLaneRetrievers(storage);
    const failingRetriever: RecallLaneRetriever = {
      retrieve: async (request) => {
        if (request.lane === "topic") {
          throw new Error("simulated projection outage");
        }
        return base.retrieve(request);
      },
    };
    const result = await runtime(storage, {
      allowedLanes: ["recent_l1", "topic"],
      laneRetriever: failingRetriever,
    }).memoryContextCompile(
      compileRequest("request_layered_context_degraded"),
    );
    expect(result.status).toBe("DEGRADED");
    if (result.status !== "DEGRADED") {
      throw new Error("projection outage must produce degraded Context");
    }
    const data = result.data as {
      context_slice: {
        items: Array<{ abstraction: string }>;
        effective_lane_configuration: {
          enabled_lanes: string[];
          limits: Record<string, number>;
          reason_codes: string[];
        };
        lane_telemetry: Array<{
          lane: string;
          status: string;
          reason_codes: string[];
        }>;
      };
    };
    expect(result.fallback_lane).toBe("recent_l1");
    expect(
      data.context_slice.items.every(
        (item) => item.abstraction === "l1_memory",
      ),
    ).toBe(true);
    expect(
      data.context_slice.effective_lane_configuration.enabled_lanes,
    ).toEqual(["recent_l1", "topic"]);
    expect(
      data.context_slice.effective_lane_configuration.reason_codes,
    ).toContain("LANE_DENIED_BY_POLICY:core");
    expect(
      data.context_slice.lane_telemetry.find(
        (item) => item.lane === "topic",
      ),
    ).toMatchObject({
      status: "unavailable",
      reason_codes: ["LANE_UNAVAILABLE:topic"],
    });
    expect(JSON.stringify(data.context_slice.lane_telemetry)).not.toContain(
      "agent memory",
    );
    expect(JSON.stringify(data.context_slice.lane_telemetry)).not.toContain(
      "Agent memory must remain governed",
    );
    await storage.close();
  });

  it("rejects the old frozen projection and excludes it from the next compile after correction", async () => {
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot("layered-context-correction"),
    });
    const admitted = await seedLayeredProjectionSources(storage);
    await drain(storage, "layered_context_correction_worker");
    const oldRequest = compileRequest("request_layered_before_correction");
    expect(
      await runtime(storage).memoryContextCompile(oldRequest),
    ).toMatchObject({ status: "OK" });
    await storage.commitEpisode(
      inlineEpisode({
        episodeId: "episode_layered_runtime_correction",
        evidenceId: "evidence_layered_runtime_correction",
        idempotencyKey: "commit:layered-runtime-correction:0001",
        text: "Agent memory correction wins immediately.",
      }),
    );
    const source = admitted[0];
    if (source === undefined) {
      throw new Error("correction fixture requires one source");
    }
    await storage.applyMemoryRevision(
      revisionCommand({
        memoryId: source.memory_id,
        expectedRevisionId: source.current_revision_id,
        candidate: memoryCandidate({
          candidateId: "candidate_layered_runtime_correction",
          logicalKey: "projection.layered_semantic_a",
          scope: SCOPE,
          text: "Agent memory correction wins immediately.",
          evidenceIds: ["evidence_layered_runtime_correction"],
        }),
        idempotencyKey: "layered-runtime-correction-0001",
      }),
    );
    expect(
      await runtime(storage).memoryContextCompile(oldRequest),
    ).toMatchObject({
      status: "FAILED",
      error: { code: "CONFLICT" },
    });
    const next = await runtime(storage).memoryContextCompile(
      compileRequest(
        "request_layered_after_correction",
        "Agent memory correction",
      ),
    );
    expect(next.status).toBe("OK");
    if (next.status !== "OK") {
      throw new Error("corrected canonical L1 must remain available");
    }
    const items = (
      next.data as {
        context_slice: {
          items: Array<{
            abstraction: string;
            revision_id: string;
          }>;
        };
      }
    ).context_slice.items;
    expect(
      items.some((item) => item.revision_id === source.current_revision_id),
    ).toBe(false);
    expect(
      items.filter((item) => item.abstraction !== "l1_memory"),
    ).toEqual([]);
    await storage.close();
  });
});
