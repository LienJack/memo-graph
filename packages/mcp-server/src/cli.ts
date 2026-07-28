#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

import {
  createMemoryMcpServer,
  openMemoryRuntime,
} from "./index.js";

function writeDiagnostic(event: string, code: string): void {
  process.stderr.write(
    `${JSON.stringify({ component: "memo-graph-mcp", event, code })}\n`,
  );
}

function configPath(argv: string[]): string {
  const index = argv.indexOf("--config");
  const value = index === -1 ? undefined : argv[index + 1];
  if (value === undefined || value.trim().length === 0) {
    throw new Error("config argument required");
  }
  return value;
}

export async function runMemoryMcpCli(argv = process.argv.slice(2)): Promise<void> {
  let storage: Awaited<ReturnType<typeof openMemoryRuntime>>["storage"] | null =
    null;
  try {
    const parsedConfig = JSON.parse(
      readFileSync(configPath(argv), "utf8"),
    ) as unknown;
    const opened = await openMemoryRuntime(parsedConfig);
    storage = opened.storage;
    const handle = serveStdio(
      () =>
        createMemoryMcpServer({
          runtime: opened.runtime,
          storage: opened.storage,
        }),
      {
        onerror: () => writeDiagnostic("transport_error", "MCP_TRANSPORT"),
      },
    );
    let closing = false;
    const shutdown = async (code: string): Promise<void> => {
      if (closing) {
        return;
      }
      closing = true;
      writeDiagnostic("shutdown", code);
      await handle.close();
      await opened.storage.close();
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    process.stdin.once("end", () => void shutdown("STDIN_END"));
    writeDiagnostic("ready", "MCP_STDIO_READY");
  } catch (error) {
    if (storage !== null) {
      await storage.close().catch(() => undefined);
    }
    writeDiagnostic(
      "startup_failed",
      error instanceof z.ZodError ? "INVALID_CONFIG" : "STARTUP_FAILURE",
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runMemoryMcpCli();
}
