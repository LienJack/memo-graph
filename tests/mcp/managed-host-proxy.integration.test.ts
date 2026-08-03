import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";

import {
  GovernedResponseSchema,
  type GovernedResponse,
} from "../../packages/contracts/src/index.js";
import {
  attachManagedMemoryMcpSession,
  MEMORY_RESOURCE_URIS,
  MEMORY_TOOL_METADATA,
} from "../../packages/mcp-server/src/index.js";
import {
  connectAuthenticatedIpc,
  memoryRuntimeConfigIdentity,
  memoryRuntimeRootIdentity,
  preflightMemoryRuntime,
  readIpcCredential,
  readManagedHostDescriptor,
  startManagedRuntimeHost,
} from "../../packages/runtime-host/src/index.js";
import { mcpRecoveryFixture } from "../helpers/mcp-recovery.js";

const cleanupPaths: string[] = [];
const requestedAt = "2026-08-02T08:00:00.000Z";

function temporaryRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "memo-graph-managed-host-")),
  );
  cleanupPaths.push(root);
  return root;
}

function configFixture() {
  const root = temporaryRoot();
  const dataRoot = join(root, "data");
  const recovery = mcpRecoveryFixture(dataRoot);
  const config = {
    data_root: dataRoot,
    principal_id: "user_local",
    allowed_scopes: [{ kind: "workspace", id: "workspace_local" }],
    allowed_authorities: ["user_stated", "tool_result"],
    destructive_tools_enabled: false,
    recovery_head: recovery.config,
  } as const;
  const configPath = join(root, "mcp-config.json");
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  return { root, dataRoot, config, configPath };
}

async function connectProxy(configPath: string, descriptorPath: string) {
  const stderr: string[] = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      join(process.cwd(), "packages/mcp-server/dist/cli.js"),
      "--config",
      configPath,
      "--managed-descriptor",
      descriptorPath,
    ],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    stderr.push(String(chunk));
  });
  const client = new Client({
    name: "memo-graph-managed-proxy-test",
    version: "0.1.0",
  });
  await client.connect(transport);
  return { client, transport, stderr };
}

function governed(result: Awaited<ReturnType<Client["callTool"]>>): GovernedResponse {
  return GovernedResponseSchema.parse(result.structuredContent);
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path !== undefined) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe("managed Runtime host MCP byte proxy", () => {
  it("shares one Runtime across proxies without changing the MCP surface", async () => {
    const fixture = configFixture();
    const hostDiagnostics: string[] = [];
    const host = await startManagedRuntimeHost({
      config: fixture.config,
      runtimeDirectory: join(fixture.root, "runtime"),
      attachSession: (socket, _context, runtime) =>
        attachManagedMemoryMcpSession(socket, runtime),
      onDiagnostic: (event) => hostDiagnostics.push(event.code),
    });
    const descriptor = readManagedHostDescriptor(host.descriptorPath);
    const credential = readIpcCredential(descriptor.credential_path);
    const probe = await connectAuthenticatedIpc({
      descriptor,
      credential,
      expectedRootIdentity: memoryRuntimeRootIdentity(fixture.dataRoot),
      expectedConfigIdentity: memoryRuntimeConfigIdentity(fixture.config),
    }).catch((error) => {
      throw new Error(`${String(error)} host=${hostDiagnostics.join(",")}`);
    });
    credential.fill(0);
    probe.destroy();
    const first = await connectProxy(fixture.configPath, host.descriptorPath);
    const second = await connectProxy(fixture.configPath, host.descriptorPath);
    try {
      expect(
        (await first.client.listTools()).tools.map((tool) => tool.name),
        first.stderr.join(""),
      )
        .toEqual(MEMORY_TOOL_METADATA.map((tool) => tool.name));
      expect(
        (await second.client.listResources()).resources.map(
          (resource) => resource.uri,
        ),
      ).toEqual(MEMORY_RESOURCE_URIS);

      const contender = await preflightMemoryRuntime(fixture.config);
      expect(contender.state).toBe("blocked");
      if (contender.state === "opened") {
        await contender.opened.close();
        throw new Error("managed host must retain the only root writer");
      }

      const committed = governed(
        await first.client.callTool({
          name: "memory_evidence_ingest",
          arguments: {
            envelope: {
              schema_version: "1.0.0",
              request_id: "managed_ingest_1",
              tool: "memory_evidence_ingest",
              actor_claim: {
                principal_id: "user_local",
                authority: "user_stated",
              },
              scopes: [{ kind: "workspace", id: "workspace_local" }],
              purpose: "characterize managed MCP framing",
              reason: "managed proxy integration fixture",
              requested_at: requestedAt,
              safety_class: "proposal",
              idempotency_key: "managed-ingest-001",
            },
            batch: {
              scope: { kind: "workspace", id: "workspace_local" },
              outcome: "succeeded",
              items: [
                {
                  kind: "conversation_turn",
                  speaker: "user",
                  occurred_at: requestedAt,
                  sensitivity: "personal",
                  text: "managed proxy shares the authoritative Runtime",
                },
              ],
            },
          },
        }),
      );
      expect(committed.status).toBe("OK");
      if (committed.status !== "OK") {
        throw new Error("managed mutation must commit");
      }
      const evidenceId = (
        committed.data as { adaptation: { evidence_ids: string[] } }
      ).adaptation.evidence_ids[0];
      expect(evidenceId).toBeTypeOf("string");

      const reopened = governed(
        await second.client.callTool({
          name: "memory_get",
          arguments: {
            envelope: {
              schema_version: "1.0.0",
              request_id: "managed_get_1",
              tool: "memory_get",
              actor_claim: {
                principal_id: "user_local",
                authority: "user_stated",
              },
              scopes: [{ kind: "workspace", id: "workspace_local" }],
              purpose: "read shared managed state",
              reason: "managed proxy integration fixture",
              requested_at: requestedAt,
              safety_class: "read_only",
            },
            evidence_id: evidenceId,
            scope: { kind: "workspace", id: "workspace_local" },
          },
        }),
      );
      expect(reopened.status).toBe("OK");

      await first.client.close();
      expect((await host.health()).lifecycle).toBe("ready");
      expect((await second.client.listTools()).tools).toHaveLength(
        MEMORY_TOOL_METADATA.length,
      );
      const diagnostics = [...first.stderr, ...second.stderr].join("");
      expect(diagnostics).not.toContain(fixture.dataRoot);
      expect(diagnostics).not.toContain(host.descriptor.credential_path);
    } finally {
      await first.client.close().catch(() => undefined);
      await second.client.close().catch(() => undefined);
      const descriptorPath = host.descriptorPath;
      const credentialPath = host.descriptor.credential_path;
      await host.close();
      expect(existsSync(descriptorPath)).toBe(false);
      expect(existsSync(credentialPath)).toBe(false);
    }
  }, 30_000);

  it("fails closed with health-only MCP and never opens managed storage", async () => {
    const root = temporaryRoot();
    const dataRoot = join(root, "must-remain-absent");
    const configPath = join(root, "managed-missing-config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        data_root: dataRoot,
        principal_id: "user_local",
        allowed_scopes: [{ kind: "workspace", id: "workspace_local" }],
        allowed_authorities: ["user_stated"],
      }),
      { mode: 0o600 },
    );
    const session = await connectProxy(
      configPath,
      join(root, "missing-host.json"),
    );
    try {
      expect((await session.client.listTools()).tools).toEqual([]);
      const health = await session.client.readResource({
        uri: "memory://runtime/health",
      });
      const first = health.contents[0];
      if (first === undefined || !("text" in first)) {
        throw new Error("blocked health must be readable");
      }
      expect(JSON.parse(first.text)).toMatchObject({
        readiness: "blocked",
        primary_reason: "HOST_UNAVAILABLE",
        components: [
          {
            component: "runtime_owner",
            state: "blocked",
            reason_code: "HOST_UNAVAILABLE",
          },
        ],
      });
      expect(existsSync(dataRoot)).toBe(false);
      expect(session.stderr.join("")).not.toContain(dataRoot);
    } finally {
      await session.client.close();
    }
  });
});
