import {
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
  canonicalJson,
  canonicalSha256Omitting,
  receiptHashIsValid,
} from "../../packages/contracts/src/index.js";
import {
  MEMORY_RESOURCE_URIS,
  MEMORY_TOOL_METADATA,
} from "../../packages/mcp-server/src/index.js";

import { mcpRecoveryFixture } from "../helpers/mcp-recovery.js";
import { inlineEpisode } from "../helpers/storage-examples.js";

const cleanupPaths: string[] = [];
const requestedAt = "2026-07-28T14:00:00.000Z";

function temporaryRoot(prefix: string): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-graph-${prefix}-`)),
  );
  cleanupPaths.push(root);
  return root;
}

function configFixture(): { configPath: string; dataRoot: string } {
  const root = temporaryRoot("stdio");
  const dataRoot = join(root, "data");
  const recovery = mcpRecoveryFixture(dataRoot);
  const configPath = join(root, "mcp-config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      data_root: dataRoot,
      principal_id: "user_local",
      allowed_scopes: [
        { kind: "workspace", id: "workspace_local" },
      ],
      allowed_authorities: ["user_stated", "tool_result"],
      destructive_tools_enabled: false,
      default_token_budget: 1_800,
      recovery_head: recovery.config,
    }),
    { encoding: "utf8", mode: 0o600 },
  );
  return { configPath, dataRoot };
}

function readEnvelope(tool: string, requestId: string, principalId = "user_local") {
  return {
    schema_version: "1.0.0",
    request_id: requestId,
    tool,
    actor_claim: {
      principal_id: principalId,
      authority: "user_stated",
    },
    scopes: [{ kind: "workspace", id: "workspace_local" }],
    purpose: "restore explicit task context",
    reason: "real stdio integration fixture",
    requested_at: requestedAt,
    safety_class: "read_only",
  };
}

async function connectServer(configPath: string) {
  const stderr: string[] = [];
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
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    stderr.push(String(chunk));
  });
  const client = new Client({
    name: "memo-graph-integration-client",
    version: "0.1.0",
  });
  await client.connect(transport);
  return { client, transport, stderr };
}

function governed(result: Awaited<ReturnType<Client["callTool"]>>) {
  const response = GovernedResponseSchema.parse(result.structuredContent);
  const first = result.content[0];
  if (first === undefined || first.type !== "text") {
    throw new Error("tool response must include canonical JSON text");
  }
  expect(JSON.parse(first.text)).toEqual(response);
  expect(first.text).toBe(canonicalJson(response));
  return response;
}

async function health(client: Client) {
  const result = await client.readResource({
    uri: "memory://runtime/storage-health",
  });
  const first = result.contents[0];
  if (first === undefined || !("text" in first)) {
    throw new Error("health must be a text resource");
  }
  return JSON.parse(first.text) as {
    ledger_epoch: number;
    counts: {
      evidence_events: number;
      episodes: number;
      recall_requests: number;
      retrieval_receipts: number;
      context_slices: number;
    };
  };
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target !== undefined) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

describe("official MCP client stdio integration", () => {
  it("codex-explicit-loop: no match, commit, restart, and frozen recall", async () => {
    const fixture = configFixture();
    const episode = inlineEpisode({});
    const firstSession = await connectServer(fixture.configPath);

    const tools = await firstSession.client.listTools();
    expect(
      tools.tools.map((tool) => ({
        name: tool.name,
        annotations: tool.annotations,
      })),
    ).toEqual(
      MEMORY_TOOL_METADATA.map((tool) => ({
        name: tool.name,
        annotations: tool.annotations,
      })),
    );
    const resources = await firstSession.client.listResources();
    expect(resources.resources.map((resource) => resource.uri)).toEqual(
      MEMORY_RESOURCE_URIS,
    );
    const healthBeforeResources = await health(firstSession.client);
    await firstSession.client.readResource({
      uri: "memory://runtime/contracts",
    });
    await firstSession.client.readResource({
      uri: "memory://runtime/usage",
    });
    expect(await health(firstSession.client)).toMatchObject({
      ledger_epoch: healthBeforeResources.ledger_epoch,
      counts: healthBeforeResources.counts,
    });

    const initial = governed(
      await firstSession.client.callTool({
        name: "memory_context_compile",
        arguments: {
          envelope: readEnvelope(
            "memory_context_compile",
            "stdio_compile_empty",
          ),
          recall: {
            schema_version: "1.0.0",
            request_id: "stdio_compile_empty",
            goal: "restore prior task context",
            query: "governed context",
            scopes: episode.episode.scope
              ? [episode.episode.scope]
              : [],
            as_of: requestedAt,
            token_budget: 1_800,
            include_sensitive: false,
          },
        },
      }),
    );
    expect(initial.status).toBe("NO_MATCH");

    const commitArguments = {
      envelope: {
        ...readEnvelope("memory_episode_commit", "stdio_commit_1"),
        safety_class: "proposal",
        idempotency_key: episode.idempotencyKey,
      },
      episode: episode.episode,
      evidence: episode.evidence,
      blobs: [],
    };
    const committed = governed(
      await firstSession.client.callTool({
        name: "memory_episode_commit",
        arguments: commitArguments,
      }),
    );
    const replayedCommit = governed(
      await firstSession.client.callTool({
        name: "memory_episode_commit",
        arguments: commitArguments,
      }),
    );
    expect(replayedCommit).toEqual(committed);
    const firstHealth = await health(firstSession.client);
    expect(firstHealth).toMatchObject({
      ledger_epoch: 1,
      counts: {
        evidence_events: 1,
        episodes: 1,
      },
    });
    await firstSession.client.close();

    const firstDiagnostics = firstSession.stderr.join("");
    expect(firstDiagnostics).toMatch(/MCP_STDIO_READY/);
    expect(firstDiagnostics).not.toContain(fixture.dataRoot);
    expect(firstDiagnostics).not.toContain("governed context");
    for (const line of firstDiagnostics.trim().split("\n")) {
      expect(() => JSON.parse(line)).not.toThrow();
    }

    const secondSession = await connectServer(fixture.configPath);
    const compiled = governed(
      await secondSession.client.callTool({
        name: "memory_context_compile",
        arguments: {
          envelope: readEnvelope(
            "memory_context_compile",
            "stdio_compile_restarted",
          ),
          recall: {
            schema_version: "1.0.0",
            request_id: "stdio_compile_restarted",
            goal: "restore prior task context",
            query: "governed context",
            scopes: [episode.episode.scope],
            as_of: requestedAt,
            token_budget: 1_800,
            include_sensitive: false,
          },
        },
      }),
    );
    expect(compiled.status).toBe("OK");
    if (compiled.status !== "OK") {
      throw new Error("restarted process must recall a context slice");
    }
    const compiledData = compiled.data as {
      context_slice: {
        frozen_hash: string;
        token_budget: number;
        token_used: number;
        items: unknown[];
      };
      receipt: Parameters<typeof receiptHashIsValid>[0];
    };
    expect(compiledData.context_slice.items).toHaveLength(1);
    expect(compiledData.context_slice.token_used).toBeLessThanOrEqual(
      compiledData.context_slice.token_budget,
    );
    expect(compiledData.context_slice.frozen_hash).toBe(
      canonicalSha256Omitting(compiledData.context_slice, [
        "frozen_hash",
      ]),
    );
    expect(receiptHashIsValid(compiledData.receipt)).toBe(true);

    const beforeUnauthorized = await health(secondSession.client);
    const unauthorized = governed(
      await secondSession.client.callTool({
        name: "memory_search",
        arguments: {
          envelope: readEnvelope(
            "memory_search",
            "stdio_unauthorized",
            "unconfigured_principal",
          ),
          query: "SECRET_MARKER_DO_NOT_LOG",
        },
      }),
    );
    const afterUnauthorized = await health(secondSession.client);
    expect(unauthorized).toMatchObject({
      status: "FAILED",
      error: { code: "PERMISSION_DENIED" },
    });
    expect(afterUnauthorized.counts.recall_requests).toBe(
      beforeUnauthorized.counts.recall_requests,
    );
    expect(afterUnauthorized.counts.retrieval_receipts).toBe(
      beforeUnauthorized.counts.retrieval_receipts,
    );
    await secondSession.client.close();
    expect(secondSession.stderr.join("")).not.toContain(
      "SECRET_MARKER_DO_NOT_LOG",
    );
  });
});
