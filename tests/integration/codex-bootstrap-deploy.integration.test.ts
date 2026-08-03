import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
  CORE_MEMORY_TOOLS,
  assertCoreMemoryTools,
} from "../../apps/codex-bootstrap/src/install-contract.js";
import { MEMORY_TOOL_METADATA } from "../../packages/mcp-server/src/index.js";
import { mcpRecoveryFixture } from "../helpers/mcp-recovery.js";

const cleanupPaths: string[] = [];
const hostProcesses: number[] = [];
const runtimeDirectories: string[] = [];

async function waitForExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("DEPLOY_TEST_HOST_DID_NOT_EXIT");
}

afterEach(async () => {
  while (runtimeDirectories.length > 0) {
    const runtimeDirectory = runtimeDirectories.pop();
    if (runtimeDirectory === undefined || !existsSync(runtimeDirectory)) {
      continue;
    }
    for (const name of readdirSync(runtimeDirectory)) {
      if (!/^w-.*\.json$/u.test(name)) {
        continue;
      }
      try {
        const endpoint = JSON.parse(
          readFileSync(join(runtimeDirectory, name), "utf8"),
        ) as { process_id?: unknown };
        if (
          typeof endpoint.process_id === "number" &&
          !hostProcesses.includes(endpoint.process_id)
        ) {
          hostProcesses.push(endpoint.process_id);
        }
      } catch {
        // Teardown still cleans every already discovered exact owner.
      }
    }
  }
  while (hostProcesses.length > 0) {
    const pid = hostProcesses.pop();
    if (pid !== undefined) {
      try {
        process.kill(pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          throw error;
        }
      }
      await waitForExit(pid);
    }
  }
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path !== undefined) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe("deployed Codex bootstrap", () => {
  it("cold-starts outside the source tree and lists governed memory tools", async () => {
    const root = realpathSync(
      mkdtempSync(join(realpathSync(tmpdir()), "memo-codex-deploy-")),
    );
    cleanupPaths.push(root);
    const deployRoot = join(root, "release");
    const runtimeDirectory = join(root, "runtime");
    runtimeDirectories.push(runtimeDirectory);
    const dataRoot = join(root, "data");
    const mcpConfigPath = join(root, "mcp.json");
    const operatorConfigPath = join(root, "operator.json");
    const recovery = mcpRecoveryFixture(dataRoot).config;
    writeFileSync(
      mcpConfigPath,
      JSON.stringify({
        data_root: dataRoot,
        principal_id: "user_local",
        allowed_scopes: [
          { kind: "workspace", id: "workspace_local" },
        ],
        allowed_authorities: [
          "user_stated",
          "observed",
          "tool_result",
          "inferred",
          "derived",
          "imported",
        ],
        recovery_head: recovery,
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      operatorConfigPath,
      JSON.stringify({
        data_root: dataRoot,
        recovery: {
          backup_bundles: {},
          restore_targets: {},
          authority: {
            directory: recovery.directory,
            authority_key_id: recovery.authority_key_id,
            trust_root_version: recovery.trust_root_version,
            private_key_path: recovery.private_key_path,
            public_key_path: recovery.public_key_path,
          },
        },
      }),
      { mode: 0o600 },
    );
    chmodSync(root, 0o700);

    const deployed = spawnSync(
      "pnpm",
      [
        "--filter",
        "@memo-graph/codex-bootstrap",
        "deploy",
        "--prod",
        "--legacy",
        deployRoot,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: process.env,
      },
    );
    expect(deployed.status, deployed.stderr).toBe(0);

    const entry = join(deployRoot, "dist", "cli.js");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        entry,
        "--mcp-config",
        mcpConfigPath,
        "--operator-config",
        operatorConfigPath,
        "--runtime-dir",
        runtimeDirectory,
      ],
      cwd: root,
      env: {
        MEMO_GRAPH_BOOTSTRAP_DEBUG: "1",
        MEMO_GRAPH_BOOTSTRAP_NO_OPEN: "1",
      },
      stderr: "pipe",
    });
    let diagnostics = "";
    transport.stderr?.on("data", (chunk) => {
      diagnostics += chunk.toString();
    });
    const client = new Client({
      name: "memo-graph-deploy-test",
      version: "1.0.0",
    });
    try {
      await client.connect(transport).catch((error: unknown) => {
        throw new Error(
          `DEPLOYED_BOOTSTRAP_CONNECTION_FAILED: ${diagnostics}`,
          { cause: error },
        );
      });
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      expect(
        names,
        `DEPLOYED_TOOL_NAMES: ${JSON.stringify(names)}; diagnostics: ${diagnostics}`,
      ).toEqual(expect.arrayContaining([...CORE_MEMORY_TOOLS]));
      assertCoreMemoryTools(names);
      expect(names).toHaveLength(MEMORY_TOOL_METADATA.length);
      const read = await client.callTool({
        name: "memory_search",
        arguments: {
          envelope: {
            schema_version: "1.0.0",
            request_id: "deployed_bootstrap_read_probe",
            tool: "memory_search",
            actor_claim: {
              principal_id: "user_local",
              authority: "user_stated",
            },
            scopes: [{ kind: "workspace", id: "workspace_local" }],
            purpose: "verify deployed bootstrap invocation",
            reason: "cold deployment read-only acceptance probe",
            requested_at: new Date().toISOString(),
            safety_class: "read_only",
          },
          query: "deployed_bootstrap_probe",
          limit: 1,
          include_sensitive: false,
        },
      });
      expect(read.structuredContent).toMatchObject({ status: "NO_MATCH" });
    } finally {
      await client.close().catch(() => undefined);
    }

    const endpointName = readdirSync(runtimeDirectory).find((name) =>
      /^w-.*\.json$/u.test(name),
    );
    expect(endpointName).toBeTypeOf("string");
    const endpoint = JSON.parse(
      readFileSync(join(runtimeDirectory, endpointName ?? ""), "utf8"),
    ) as { process_id: number; runtime_state: string };
    expect(endpoint.runtime_state).toBe("ready");
    hostProcesses.push(endpoint.process_id);

    const deployedJavaScript = readFileSync(entry, "utf8");
    expect(deployedJavaScript).not.toContain(process.cwd());
    expect(deployedJavaScript).not.toContain("/Users/lienli");
  }, 30_000);
});
