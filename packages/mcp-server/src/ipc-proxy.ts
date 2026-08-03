import type { Readable, Writable } from "node:stream";

import {
  reduceOperationalStatus,
  type OperationalStatus,
} from "@memo-graph/contracts";
import {
  IpcAttachError,
  MemoryServerConfigSchema,
  connectAuthenticatedIpc,
  memoryRuntimeConfigIdentity,
  memoryRuntimeRootIdentity,
  readIpcCredential,
  readManagedHostDescriptor,
} from "@memo-graph/runtime-host";

export type ManagedMcpProxyHandle = {
  done: Promise<void>;
  close(): Promise<void>;
};

export async function attachManagedMcpProxy(options: {
  config: unknown;
  descriptorPath: string;
  input?: Readable;
  output?: Writable;
  timeoutMs?: number;
}): Promise<ManagedMcpProxyHandle> {
  const config = MemoryServerConfigSchema.parse(options.config);
  const descriptor = readManagedHostDescriptor(options.descriptorPath);
  const credential = readIpcCredential(descriptor.credential_path);
  let socket;
  try {
    socket = await connectAuthenticatedIpc({
      descriptor,
      credential,
      expectedRootIdentity: memoryRuntimeRootIdentity(config.data_root),
      expectedConfigIdentity: memoryRuntimeConfigIdentity(config),
      timeoutMs: options.timeoutMs ?? 2_000,
    });
  } finally {
    credential.fill(0);
  }
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  let settled = false;
  let resolveDone: (() => void) | undefined;
  let rejectDone: ((error: Error) => void) | undefined;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const cleanup = (): void => {
    input.unpipe(socket);
    socket.unpipe(output);
  };
  socket.once("close", () => {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    resolveDone?.();
  });
  socket.once("error", () => {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    rejectDone?.(new IpcAttachError("HOST_UNAVAILABLE"));
  });
  input.pipe(socket);
  socket.pipe(output, { end: false });
  socket.resume();
  return {
    done,
    close: async () => {
      if (!socket.destroyed) {
        socket.end();
        socket.destroy();
      }
      await done.catch(() => undefined);
    },
  };
}

export function managedAttachBlockedStatus(
  error: unknown,
  observedAt = new Date().toISOString(),
): OperationalStatus {
  const reason =
    error instanceof IpcAttachError
      ? error.code
      : "HOST_UNAVAILABLE";
  return reduceOperationalStatus({
    observed_at: observedAt,
    qualification: { status: "pending", tested_envelope_digest: null },
    observations: [
      {
        component: "runtime_owner",
        state: "blocked",
        reason_code: reason,
        action_code: "RESTART_RUNTIME",
        measurements: [],
      },
    ],
  });
}
