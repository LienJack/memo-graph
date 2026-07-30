#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import {
  blockedOperationalStatus,
  operationalStatusFromStorageHealth,
} from "@memo-graph/storage-sqlite";

import {
  createBlockedMemoryMcpServer,
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
  let openedRuntime: Awaited<ReturnType<typeof openMemoryRuntime>> | null =
    null;
  let configParsed = false;
  try {
    const parsedConfig = JSON.parse(
      readFileSync(configPath(argv), "utf8"),
    ) as unknown;
    configParsed = true;
    const opened = await openMemoryRuntime(parsedConfig);
    openedRuntime = opened;
    const status = operationalStatusFromStorageHealth(
      await opened.storage.health(),
    );
    if (status.readiness === "blocked") {
      await opened.close();
      openedRuntime = null;
      const handle = serveStdio(
        () => createBlockedMemoryMcpServer({ status: () => status }),
        {
          onerror: () =>
            writeDiagnostic("transport_error", "MCP_TRANSPORT"),
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
      };
      process.once("SIGINT", () => void shutdown("SIGINT"));
      process.once("SIGTERM", () => void shutdown("SIGTERM"));
      process.stdin.once("end", () => void shutdown("STDIN_END"));
      writeDiagnostic(
        "blocked",
        status.primary_reason ?? "STARTUP_BLOCKED",
      );
      return;
    }
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
      await opened.close();
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    process.stdin.once("end", () => void shutdown("STDIN_END"));
    writeDiagnostic("ready", "MCP_STDIO_READY");
  } catch (error) {
    if (openedRuntime !== null) {
      await openedRuntime.close().catch(() => undefined);
    }
    const invalidConfig = !configParsed || error instanceof z.ZodError;
    const status = blockedOperationalStatus(error, { invalidConfig });
    const handle = serveStdio(
      () => createBlockedMemoryMcpServer({ status: () => status }),
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
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    process.stdin.once("end", () => void shutdown("STDIN_END"));
    writeDiagnostic(
      "blocked",
      invalidConfig ? "INVALID_CONFIG" : status.primary_reason ?? "STARTUP_FAILURE",
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runMemoryMcpCli();
}
