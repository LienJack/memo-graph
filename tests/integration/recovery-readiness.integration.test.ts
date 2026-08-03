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
  createBlockedMemoryMcpServer,
  preflightMemoryRuntime,
} from "../../packages/mcp-server/src/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";

const cleanupPaths: string[] = [];

function temporaryRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "memo-m6-recovery-health-")),
  );
  cleanupPaths.push(root);
  return root;
}

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("recovery authority readiness", () => {
  it("narrows a runtime without external authority to the content-free blocked shell", async () => {
    const dataRoot = temporaryRoot();
    const preflight = await preflightMemoryRuntime({
      data_root: dataRoot,
      principal_id: "user_local",
      allowed_scopes: [
        { kind: "workspace", id: "workspace_local" },
      ],
      allowed_authorities: ["user_stated"],
      recovery_head: { enabled: false },
    }, {
      observedAt: "2026-07-30T12:00:00.000Z",
    });
    expect(preflight).toMatchObject({
      state: "blocked",
      status: {
        readiness: "blocked",
        primary_reason: "RECOVERY_AUTHORITY_INVALID",
        next_action: "RECOVER_EXTERNAL_AUTHORITY",
        components: expect.arrayContaining([
          expect.objectContaining({
            component: "recovery",
            state: "blocked",
          }),
        ]),
      },
    });
    if (preflight.state !== "blocked") {
      await preflight.opened.close();
      throw new Error("missing recovery authority must block preflight");
    }
    const nextWriter = await SqliteStorageClient.open({ dataRoot });
    await nextWriter.close();

    const server = createBlockedMemoryMcpServer({
      status: () => preflight.status,
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({
      name: "recovery-blocked-shell",
      version: "0.1.0",
    });
    await client.connect(clientTransport);
    try {
      expect((await client.listTools()).tools).toEqual([]);
      expect(
        (await client.listResources()).resources.map(
          (resource) => resource.uri,
        ),
      ).toEqual(["memory://runtime/health"]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
