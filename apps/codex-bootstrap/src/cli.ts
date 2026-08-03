#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { RootLeaseRecoverySchema } from "@memo-graph/contracts";
import { launchOrReuseWorkbench, workbenchArtifactPaths } from "@memo-graph/memory-workbench-host";
import { runMemoryMcpCli } from "@memo-graph/mcp-server/cli";
import { loadOperatorConfig } from "@memo-graph/operator-cli/config";
import { workbenchRuntimeConfig } from "@memo-graph/operator-cli/workbench";
import {
  MemoryServerConfigSchema,
  memoryRuntimeConfigIdentity,
  memoryRuntimeRootIdentity,
} from "@memo-graph/runtime-host";
import { recoverStaleRootLease } from "@memo-graph/storage-sqlite";

import { resolveBootstrapPaths } from "./install-contract.js";

type BootstrapArguments = {
  mcpConfigPath: string;
  operatorConfigPath: string;
  runtimeDirectory: string;
};

function diagnostic(
  event: string,
  code: string,
  metadata: { detail?: string; instance_id?: string } = {},
): void {
  process.stderr.write(
    `${JSON.stringify({
      component: "memo-graph-codex-bootstrap",
      event,
      code,
      ...metadata,
    })}\n`,
  );
}

function parseArguments(argv: string[]): BootstrapArguments {
  const defaults = resolveBootstrapPaths();
  const values: BootstrapArguments = {
    mcpConfigPath: defaults.mcpConfigPath,
    operatorConfigPath: defaults.operatorConfigPath,
    runtimeDirectory: defaults.runtimeDirectory,
  };
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      flag === undefined ||
      value === undefined ||
      !flag.startsWith("--") ||
      seen.has(flag)
    ) {
      throw new Error("INVALID_BOOTSTRAP_ARGUMENTS");
    }
    seen.add(flag);
    switch (flag) {
      case "--mcp-config":
        values.mcpConfigPath = value;
        break;
      case "--operator-config":
        values.operatorConfigPath = value;
        break;
      case "--runtime-dir":
        values.runtimeDirectory = value;
        break;
      default:
        throw new Error("INVALID_BOOTSTRAP_ARGUMENTS");
    }
  }
  return values;
}

function ownerIsDead(ownerId: unknown): boolean {
  if (typeof ownerId !== "string") {
    return false;
  }
  const match = /^pid:([1-9][0-9]*):/u.exec(ownerId);
  if (match === null) {
    return false;
  }
  const pid = Number(match[1]);
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function recoverExpiredDeadOwnerLease(dataRoot: string): void {
  const leasePath = join(dataRoot, ".memo-graph-writer.lock");
  if (!existsSync(leasePath)) {
    return;
  }
  let lease: Record<string, unknown>;
  try {
    lease = JSON.parse(readFileSync(leasePath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    diagnostic("lease_recovery_skipped", "LEASE_UNREADABLE");
    return;
  }
  const now = new Date().toISOString();
  if (
    typeof lease.expires_at !== "string" ||
    Date.parse(now) <= Date.parse(lease.expires_at) ||
    !ownerIsDead(lease.owner_id)
  ) {
    return;
  }
  try {
    const recovery = RootLeaseRecoverySchema.parse({
      root_ref: String(lease.root_ref),
      previous_lease_id: String(lease.lease_id),
      previous_fence_token: Number(lease.fence_token),
      observed_heartbeat_at: String(lease.heartbeat_at),
      takeover_nonce: `codex_bootstrap_${createHash("sha256")
        .update(`${String(lease.lease_id)}:${String(lease.heartbeat_at)}`)
        .digest("hex")
        .slice(0, 20)}`,
    });
    recoverStaleRootLease({
      root: dataRoot,
      recovery,
      now,
    });
    diagnostic("lease_recovered", "EXACT_DEAD_OWNER_PROOF");
  } catch {
    diagnostic("lease_recovery_blocked", "STALE_ROOT_LEASE");
  }
}

function parentProcessIdentity(): string {
  let startedAt = "unknown";
  try {
    startedAt = execFileSync(
      "/bin/ps",
      ["-p", String(process.ppid), "-o", "lstart="],
      { encoding: "utf8", timeout: 1_000 },
    ).trim();
  } catch {
    // The PID still safely scopes the browser marker.
  }
  return createHash("sha256")
    .update(`${process.ppid}:${startedAt}`)
    .digest("hex")
    .slice(0, 20);
}

function claimBrowserOpen(
  runtimeDirectory: string,
  instanceId: string,
): string | null {
  if (process.env.MEMO_GRAPH_BOOTSTRAP_NO_OPEN === "1") {
    return null;
  }
  const markerPath = join(
    runtimeDirectory,
    `codex-browser-${createHash("sha256")
      .update(`${parentProcessIdentity()}:${instanceId}`)
      .digest("hex")
      .slice(0, 20)}.opened`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(markerPath, "wx", 0o600);
    closeSync(descriptor);
    return markerPath;
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return null;
    }
    throw error;
  }
}

export async function runCodexBootstrap(
  argv = process.argv.slice(2),
): Promise<void> {
  if (process.versions.node.split(".")[0] !== "24") {
    throw new Error("UNSUPPORTED_NODE_VERSION");
  }
  const arguments_ = parseArguments(argv);
  const operator = loadOperatorConfig(arguments_.operatorConfigPath);
  const workbenchConfig = workbenchRuntimeConfig(operator);
  const mcpConfig = MemoryServerConfigSchema.parse(
    JSON.parse(readFileSync(arguments_.mcpConfigPath, "utf8")),
  );
  mkdirSync(workbenchConfig.data_root, { recursive: true, mode: 0o700 });
  if (
    memoryRuntimeConfigIdentity(workbenchConfig) !==
    memoryRuntimeConfigIdentity(mcpConfig)
  ) {
    throw new Error("CONFIG_IDENTITY_MISMATCH");
  }

  recoverExpiredDeadOwnerLease(workbenchConfig.data_root);
  const launch = await launchOrReuseWorkbench({
    config: workbenchConfig,
    runtimeDirectory: arguments_.runtimeDirectory,
    noOpen: true,
  });
  diagnostic("workbench_ready", launch.result.status.toUpperCase(), {
    instance_id: launch.result.instance_id,
  });

  const marker = claimBrowserOpen(
    arguments_.runtimeDirectory,
    launch.result.instance_id,
  );
  if (marker !== null) {
    try {
      const opened = await launchOrReuseWorkbench({
        config: workbenchConfig,
        runtimeDirectory: arguments_.runtimeDirectory,
      });
      if (opened.result.browser === "opened") {
        diagnostic("browser_opened", "ONCE_PER_PARENT");
      } else {
        try {
          unlinkSync(marker);
        } catch {
          // The marker only suppresses duplicate browser opens.
        }
        diagnostic("browser_open_failed", "OPEN_BASE_URL");
      }
    } catch (error) {
      try {
        unlinkSync(marker);
      } catch {
        // A later safe browser-open retry may recreate the marker.
      }
      throw error;
    }
  }

  const paths = workbenchArtifactPaths({
    runtimeDirectory: arguments_.runtimeDirectory,
    rootIdentity: memoryRuntimeRootIdentity(workbenchConfig.data_root),
    configIdentity: memoryRuntimeConfigIdentity(workbenchConfig),
  });
  await runMemoryMcpCli([
    "--config",
    arguments_.mcpConfigPath,
    "--managed-descriptor",
    paths.runtimeDescriptorPath,
  ]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await runCodexBootstrap();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    diagnostic(
      "startup_failed",
      /^[A-Z0-9_]+$/u.test(message) ? message : "BOOTSTRAP_FAILURE",
      process.env.MEMO_GRAPH_BOOTSTRAP_DEBUG === "1"
        ? {
            detail:
              error instanceof Error
                ? error.stack ?? error.message
                : String(error),
          }
        : {},
    );
    process.exitCode = 1;
  }
}
