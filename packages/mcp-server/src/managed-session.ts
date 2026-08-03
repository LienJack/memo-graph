import type { Socket } from "node:net";

import type { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import {
  StdioServerTransport,
  serveStdio,
} from "@modelcontextprotocol/server/stdio";

import {
  createMemoryMcpServer,
  type MemoryMcpRuntime,
} from "./index.js";

export async function attachManagedMemoryMcpSession(
  socket: Socket,
  opened: {
    runtime: MemoryMcpRuntime;
    storage: SqliteStorageClient;
  },
  options?: { maxBufferSize?: number; onerror?: (error: Error) => void },
): Promise<{ close(): Promise<void> }> {
  const transport = new StdioServerTransport(socket, socket, {
    maxBufferSize: options?.maxBufferSize ?? 1024 * 1024,
  });
  const handle = serveStdio(
    () =>
      createMemoryMcpServer({
        runtime: opened.runtime,
        storage: opened.storage,
      }),
    {
      transport,
      ...(options?.onerror === undefined ? {} : { onerror: options.onerror }),
    },
  );
  return { close: () => handle.close() };
}
