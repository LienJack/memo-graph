import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";

import {
  GovernedResponseSchema,
  canonicalJson,
} from "../../packages/contracts/src/index.js";
import { MemoryRuntime } from "../../packages/memory-kernel/src/index.js";
import { createMemoryMcpServer } from "../../packages/mcp-server/src/index.js";
import {
  SqliteStorageClient,
  StorageClientHealthSchema,
  operationalStatusFromStorageHealth,
  type AdmissionObservation,
} from "@memo-graph/storage-sqlite";

import { inlineEpisode } from "../helpers/storage-examples.js";

const cleanupPaths: string[] = [];

function temporaryRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "memo-graph-bounded-write-")),
  );
  cleanupPaths.push(root);
  return join(root, "data");
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target !== undefined) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

describe("bounded write admission", () => {
  it("rejects before durable effects while verified reads remain available", async () => {
    const observation: AdmissionObservation = {
      available_bytes: 1_000,
      wal_bytes: 0,
      checkpoint_healthy: true,
      active_maintenance: null,
    };
    const storage = await SqliteStorageClient.open({
      dataRoot: temporaryRoot(),
      admission: {
        policy: {
          max_queue_depth: 4,
          max_queue_age_ms: 100,
          min_available_bytes_enter: 100,
          min_available_bytes_recover: 200,
          max_wal_bytes_enter: 1_000,
          max_wal_bytes_recover: 100,
        },
        observe: () => observation,
      },
    });
    try {
      const command = inlineEpisode({});
      observation.available_bytes = 50;
      await expect(storage.commitEpisode(command)).rejects.toMatchObject({
        code: "RESOURCE_PRESSURE",
        retryable: true,
      });
      const pressured = await storage.health();
      const status = operationalStatusFromStorageHealth(pressured);
      const capacity = status.components.find(
        ({ component }) => component === "resource_capacity",
      );
      const queue = status.components.find(
        ({ component }) => component === "writer_queue",
      );
      const checkpoint = status.components.find(
        ({ component }) => component === "checkpoint",
      );
      expect(pressured.ledger_epoch).toBe(0);
      expect(pressured.counts.mutation_receipts).toBe(0);
      expect(pressured.admission_read_only).toBe(true);
      expect(pressured.writer_queue.rejected_pre_enqueue).toBe(1);
      expect(StorageClientHealthSchema.parse(pressured)).toEqual(pressured);
      expect(capacity?.measurements).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "available_bytes",
            value: 50,
          }),
          expect.objectContaining({ name: "wal_bytes", value: 0 }),
        ]),
      );
      expect(queue?.measurements.map(({ name }) => name)).toEqual(
        expect.arrayContaining([
          "queue_oldest_age_ms",
          "queue_completed",
          "queue_rejected_pre_enqueue",
          "queue_rejected_transaction_start",
        ]),
      );
      expect(checkpoint?.measurements.map(({ name }) => name)).toEqual([
        "checkpoint_busy",
        "checkpoint_log",
        "checkpointed",
      ]);
      await expect(
        storage.searchEvidence({
          principal_id: "user_local",
          scope: { kind: "workspace", id: "workspace_local" },
          query: "safe read",
          limit: 5,
        }),
      ).resolves.toMatchObject({ status: "NO_MATCH" });

      observation.available_bytes = 250;
      await expect(storage.commitEpisode(command)).resolves.toMatchObject({
        resulting_epoch: 1,
      });
      expect((await storage.health()).admission_read_only).toBe(false);
    } finally {
      await storage.close();
    }
  });

  it("preserves bounded rejection codes through in-memory MCP", async () => {
    const observation: AdmissionObservation = {
      available_bytes: 1_000,
      wal_bytes: 0,
      checkpoint_healthy: true,
      active_maintenance: null,
    };
    const dataRoot = temporaryRoot();
    const storage = await SqliteStorageClient.open({
      dataRoot,
      testOperations: true,
      admission: {
        policy: {
          max_queue_depth: 1,
          max_queue_age_ms: 1_000,
          min_available_bytes_enter: 100,
          min_available_bytes_recover: 200,
          max_wal_bytes_enter: 1_000,
          max_wal_bytes_recover: 100,
        },
        observe: () => observation,
      },
    });
    const runtime = new MemoryRuntime({
      storage,
      policy: {
        principal: {
          principal_id: "user_local",
          allowed_scopes: [
            { kind: "workspace", id: "workspace_local" },
          ],
          allowed_authorities: ["user_stated"],
          destructive_tools_enabled: false,
        },
        default_token_budget: 1_800,
      },
    });
    const server = createMemoryMcpServer({ runtime, storage });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({
      name: "bounded-admission-client",
      version: "0.1.0",
    });
    await client.connect(clientTransport);

    const episode = inlineEpisode({
      episodeId: "episode_mcp_bounded",
      evidenceId: "evidence_mcp_bounded",
      idempotencyKey: "commit:mcp:bounded",
      text: "MCP_BOUNDED_PRIVATE_MARKER",
    });
    const argumentsFor = (requestId: string) => ({
      envelope: {
        schema_version: "1.0.0",
        request_id: requestId,
        tool: "memory_episode_commit",
        actor_claim: {
          principal_id: "user_local",
          authority: "user_stated",
        },
        scopes: [{ kind: "workspace", id: "workspace_local" }],
        purpose: "verify bounded admission",
        reason: "U4 transport Oracle",
        requested_at: "2026-07-30T00:00:00.000Z",
        safety_class: "proposal",
        idempotency_key: episode.idempotencyKey,
      },
      episode: episode.episode,
      evidence: episode.evidence,
      blobs: [],
    });
    const call = async (requestId: string) => {
      const result = await client.callTool({
        name: "memory_episode_commit",
        arguments: argumentsFor(requestId),
      });
      const governed = GovernedResponseSchema.parse(
        result.structuredContent,
      );
      const first = result.content[0];
      expect(first?.type).toBe("text");
      if (first?.type === "text") {
        expect(first.text).toBe(canonicalJson(governed));
      }
      return governed;
    };

    try {
      const blocker = storage.blockWorkerForTest(500);
      const queued = storage.commitEpisode(
        inlineEpisode({
          episodeId: "episode_queue_holder",
          evidenceId: "evidence_queue_holder",
          idempotencyKey: "commit:queue:holder",
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      await expect(call("request_queue_saturated")).resolves.toMatchObject({
        status: "FAILED",
        error: { code: "QUEUE_SATURATED" },
      });
      await Promise.all([blocker, queued]);

      observation.available_bytes = 50;
      await expect(call("request_resource_pressure")).resolves.toMatchObject({
        status: "FAILED",
        error: { code: "RESOURCE_PRESSURE" },
      });

      observation.available_bytes = 250;
      observation.active_maintenance = "backup";
      await storage.health();
      await expect(call("request_maintenance_blocked")).resolves.toMatchObject({
        status: "FAILED",
        error: { code: "MAINTENANCE_BLOCKED" },
      });

      const resource = await client.readResource({
        uri: "memory://runtime/storage-health",
      });
      const first = resource.contents[0];
      if (first === undefined || !("text" in first)) {
        throw new Error("storage health must contain canonical JSON");
      }
      expect(() =>
        StorageClientHealthSchema.parse(
          JSON.parse(first.text) as unknown,
        ),
      ).not.toThrow();
      expect(first.text).not.toContain(dataRoot);
      expect(first.text).not.toContain("MCP_BOUNDED_PRIVATE_MARKER");
    } finally {
      await client.close();
      await server.close();
      await storage.close();
    }
  });
});
