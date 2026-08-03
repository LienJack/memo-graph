import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import {
  OperationalStatusSchema,
  reduceOperationalStatus,
} from "../../packages/contracts/src/index.js";
import {
  createOperationalHealthMcpServer,
} from "../../packages/mcp-server/src/index.js";
import { blockedOperationalStatus } from "@memo-graph/storage-sqlite";
import { renderOperationalStatus } from "../../apps/operator-cli/src/render.js";

describe("operator and MCP health parity", () => {
  it("keeps unknown startup failures distinct from canonical corruption", () => {
    expect(blockedOperationalStatus(new Error("private failure"))).toMatchObject({
      readiness: "blocked",
      primary_reason: "INTERNAL_FAILURE",
      next_action: "RESTART_RUNTIME",
    });
  });

  it("returns the exact same content-free status and no tools in preflight", async () => {
    const status = reduceOperationalStatus({
      observed_at: "2026-07-30T09:00:00.000Z",
      qualification: {
        status: "pending",
        tested_envelope_digest: null,
      },
      observations: [
        {
          component: "migrations",
          state: "blocked",
          reason_code: "MIGRATION_DRIFT",
          action_code: "RESTORE_VERIFIED_BACKUP",
          measurements: [],
        },
      ],
    });
    const server = createOperationalHealthMcpServer({
      status: () => status,
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({
      name: "operator-health-parity",
      version: "0.1.0",
    });
    await client.connect(clientTransport);
    try {
      expect((await client.listTools()).tools).toEqual([]);
      const resource = await client.readResource({
        uri: "memory://runtime/health",
      });
      const first = resource.contents[0];
      if (first === undefined || !("text" in first)) {
        throw new Error("operational health must contain JSON");
      }
      const mcpStatus = OperationalStatusSchema.parse(
        JSON.parse(first.text) as unknown,
      );
      const cliStatus = OperationalStatusSchema.parse(
        JSON.parse(renderOperationalStatus(status, "json")) as unknown,
      );
      expect(mcpStatus).toEqual(cliStatus);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
