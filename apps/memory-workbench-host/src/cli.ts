#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import { canonicalJson } from "@memo-graph/contracts";
import {
  MemoryServerConfigSchema,
  readPrivateOperatorFile,
} from "@memo-graph/runtime-host";

import { startMemoryWorkbenchHost } from "./host.js";

function argument(argv: readonly string[], flag: string): string {
  const index = argv.indexOf(flag);
  const value = index === -1 ? undefined : argv[index + 1];
  if (value === undefined || value.trim().length === 0) {
    throw new Error("INVALID_ARGUMENTS");
  }
  return value;
}

export async function runMemoryWorkbenchHostCli(
  argv = process.argv.slice(2),
): Promise<void> {
  const configPath = argument(argv, "--config");
  const runtimeDirectory = argument(argv, "--runtime-dir");
  const instanceId = argument(argv, "--instance");
  const bytes = readPrivateOperatorFile(configPath);
  let config: unknown;
  try {
    config = MemoryServerConfigSchema.parse(
      JSON.parse(bytes.toString("utf8")) as unknown,
    );
  } finally {
    bytes.fill(0);
  }
  const host = await startMemoryWorkbenchHost({
    config,
    runtimeDirectory,
    instanceId,
    onDiagnostic: (event) => {
      process.stderr.write(`${canonicalJson(event)}\n`);
    },
  });
  process.stdout.write(
    `${canonicalJson({
      kind: "workbench_ready",
      endpoint: host.endpoint,
      initial_bootstrap: host.initialBootstrap,
    })}\n`,
  );
  let closing = false;
  const close = async (signal: string): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    process.stderr.write(
      `${JSON.stringify({
        component: "memory-workbench-host",
        event: "shutdown",
        code: signal,
      })}\n`,
    );
    await host.close();
  };
  process.once("SIGINT", () => void close("SIGINT"));
  process.once("SIGTERM", () => void close("SIGTERM"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runMemoryWorkbenchHostCli().catch((error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({
        component: "memory-workbench-host",
        event: "startup_failed",
        code:
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : "HOST_STARTUP_FAILED",
      })}\n`,
    );
    process.exitCode = 1;
  });
}
