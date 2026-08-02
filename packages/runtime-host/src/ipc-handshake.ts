import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { createConnection, type Socket } from "node:net";

import {
  CanonicalHashSchema,
  UtcTimestampSchema,
  canonicalJson,
  type CanonicalHash,
} from "@memo-graph/contracts";
import { z } from "zod";

import { readPrivateOperatorFile } from "./trusted-file.js";

export const MEMORY_HOST_IPC_PROTOCOL = "memo-graph-mcp-ipc-v1";
const MAX_HANDSHAKE_BYTES = 8 * 1024;

const IdentitySchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

export const RuntimeRootIdentitySchema = z
  .object({
    canonical_root_hash: CanonicalHashSchema,
    device: z.string().regex(/^\d+$/u).max(40),
    inode: z.string().regex(/^\d+$/u).max(40),
  })
  .strict();

export const ManagedHostDescriptorSchema = z
  .object({
    schema_version: z.literal("1.0.0"),
    protocol: z.literal(MEMORY_HOST_IPC_PROTOCOL),
    instance_id: IdentitySchema,
    root_identity: RuntimeRootIdentitySchema,
    config_identity: CanonicalHashSchema,
    socket_path: z.string().min(1).max(512),
    credential_path: z.string().min(1).max(512),
    created_at: UtcTimestampSchema,
    ready_at: UtcTimestampSchema,
  })
  .strict();

export type ManagedHostDescriptor = z.infer<typeof ManagedHostDescriptorSchema>;

const ClientHelloBaseSchema = z
  .object({
    kind: z.literal("client_hello"),
    protocol: z.literal(MEMORY_HOST_IPC_PROTOCOL),
    instance_id: IdentitySchema,
    root_identity: RuntimeRootIdentitySchema,
    config_identity: CanonicalHashSchema,
    client_nonce: z.string().regex(/^[A-Za-z0-9_-]{32}$/u),
  })
  .strict();

const ClientHelloSchema = ClientHelloBaseSchema.extend({
  client_proof: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
}).strict();

const ServerAckBaseSchema = z
  .object({
    kind: z.literal("server_ack"),
    protocol: z.literal(MEMORY_HOST_IPC_PROTOCOL),
    instance_id: IdentitySchema,
    root_identity: RuntimeRootIdentitySchema,
    config_identity: CanonicalHashSchema,
    client_nonce: z.string().regex(/^[A-Za-z0-9_-]{32}$/u),
    server_nonce: z.string().regex(/^[A-Za-z0-9_-]{32}$/u),
  })
  .strict();

const ServerAckSchema = ServerAckBaseSchema.extend({
  server_proof: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
}).strict();

const ServerRejectSchema = z
  .object({
    kind: z.literal("server_reject"),
    code: z.enum([
      "HOST_IDENTITY_MISMATCH",
      "HOST_AUTHENTICATION_FAILED",
    ]),
  })
  .strict();

const ServerHandshakeResponseSchema = z.discriminatedUnion("kind", [
  ServerAckSchema,
  ServerRejectSchema,
]);

export type IpcAttachFailureCode =
  | "HOST_UNAVAILABLE"
  | "HOST_IDENTITY_MISMATCH"
  | "IPC_PROTOCOL_INCOMPATIBLE"
  | "HOST_AUTHENTICATION_FAILED";

export class IpcAttachError extends Error {
  readonly code: IpcAttachFailureCode;

  constructor(code: IpcAttachFailureCode) {
    super(code);
    this.name = "IpcAttachError";
    this.code = code;
  }
}

export function readManagedHostDescriptor(path: string): ManagedHostDescriptor {
  const bytes = readPrivateOperatorFile(path);
  try {
    return ManagedHostDescriptorSchema.parse(
      JSON.parse(bytes.toString("utf8")) as unknown,
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new IpcAttachError("IPC_PROTOCOL_INCOMPATIBLE");
    }
    throw error;
  } finally {
    bytes.fill(0);
  }
}

export function readIpcCredential(path: string): Buffer {
  const bytes = readPrivateOperatorFile(path);
  try {
    const encoded = bytes.toString("utf8").trim();
    if (!/^[A-Za-z0-9_-]{43}$/u.test(encoded)) {
      throw new IpcAttachError("HOST_AUTHENTICATION_FAILED");
    }
    const credential = Buffer.from(encoded, "base64url");
    if (credential.byteLength !== 32) {
      credential.fill(0);
      throw new IpcAttachError("HOST_AUTHENTICATION_FAILED");
    }
    return credential;
  } finally {
    bytes.fill(0);
  }
}

function proof(key: Buffer, domain: string, value: unknown): Buffer {
  return createHmac("sha256", key)
    .update(domain)
    .update("\0")
    .update(canonicalJson(value))
    .digest();
}

function proofMatches(actual: string, expected: Buffer): boolean {
  const candidate = Buffer.from(actual, "base64url");
  return (
    candidate.byteLength === expected.byteLength &&
    timingSafeEqual(candidate, expected)
  );
}

async function readLine(
  socket: Socket,
  timeoutMs: number,
): Promise<string> {
  socket.pause();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      socket.pause();
    };
    const fail = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onError = (): void => fail(new IpcAttachError("HOST_UNAVAILABLE"));
    const onClose = (): void => fail(new IpcAttachError("HOST_UNAVAILABLE"));
    const onData = (chunk: Buffer): void => {
      const newline = chunk.indexOf(0x0a);
      if (newline === -1) {
        size += chunk.byteLength;
        if (size > MAX_HANDSHAKE_BYTES) {
          fail(new IpcAttachError("IPC_PROTOCOL_INCOMPATIBLE"));
          return;
        }
        chunks.push(chunk);
        return;
      }
      if (newline !== chunk.byteLength - 1) {
        fail(new IpcAttachError("IPC_PROTOCOL_INCOMPATIBLE"));
        return;
      }
      chunks.push(chunk.subarray(0, newline));
      size += newline;
      if (size > MAX_HANDSHAKE_BYTES) {
        fail(new IpcAttachError("IPC_PROTOCOL_INCOMPATIBLE"));
        return;
      }
      cleanup();
      resolve(Buffer.concat(chunks, size).toString("utf8"));
    };
    const timer = setTimeout(
      () => fail(new IpcAttachError("HOST_UNAVAILABLE")),
      timeoutMs,
    );
    timer.unref();
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.resume();
  });
}

function writeLine(socket: Socket, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(`${canonicalJson(value)}\n`, "utf8", (error) => {
      if (error === null || error === undefined) {
        resolve();
      } else {
        reject(new IpcAttachError("HOST_UNAVAILABLE"));
      }
    });
  });
}

export async function authenticateServerSocket(options: {
  socket: Socket;
  descriptor: ManagedHostDescriptor;
  credential: Buffer;
  timeoutMs?: number;
}): Promise<void> {
  let parsed: z.infer<typeof ClientHelloSchema>;
  try {
    parsed = ClientHelloSchema.parse(
      JSON.parse(
        await readLine(options.socket, options.timeoutMs ?? 2_000),
      ) as unknown,
    );
  } catch (error) {
    throw error instanceof IpcAttachError
      ? error
      : new IpcAttachError("IPC_PROTOCOL_INCOMPATIBLE");
  }
  const { client_proof: clientProof, ...baseInput } = parsed;
  const base = ClientHelloBaseSchema.parse(baseInput);
  if (
    parsed.instance_id !== options.descriptor.instance_id ||
    canonicalJson(parsed.root_identity) !==
      canonicalJson(options.descriptor.root_identity) ||
    parsed.config_identity !== options.descriptor.config_identity
  ) {
    await writeLine(options.socket, {
      kind: "server_reject",
      code: "HOST_IDENTITY_MISMATCH",
    });
    throw new IpcAttachError("HOST_IDENTITY_MISMATCH");
  }
  if (
    !proofMatches(
      clientProof,
      proof(options.credential, "memo-graph/ipc/client/v1", base),
    )
  ) {
    await writeLine(options.socket, {
      kind: "server_reject",
      code: "HOST_AUTHENTICATION_FAILED",
    });
    throw new IpcAttachError("HOST_AUTHENTICATION_FAILED");
  }
  const ackBase = ServerAckBaseSchema.parse({
    kind: "server_ack",
    protocol: MEMORY_HOST_IPC_PROTOCOL,
    instance_id: parsed.instance_id,
    root_identity: parsed.root_identity,
    config_identity: parsed.config_identity,
    client_nonce: parsed.client_nonce,
    server_nonce: randomBytes(24).toString("base64url"),
  });
  await writeLine(options.socket, {
    ...ackBase,
    server_proof: proof(
      options.credential,
      "memo-graph/ipc/server/v1",
      ackBase,
    ).toString("base64url"),
  });
  options.socket.pause();
}

export async function connectAuthenticatedIpc(options: {
  descriptor: ManagedHostDescriptor;
  credential: Buffer;
  expectedRootIdentity: z.infer<typeof RuntimeRootIdentitySchema>;
  expectedConfigIdentity: CanonicalHash;
  timeoutMs?: number;
}): Promise<Socket> {
  if (
    canonicalJson(options.descriptor.root_identity) !==
      canonicalJson(RuntimeRootIdentitySchema.parse(options.expectedRootIdentity)) ||
    options.descriptor.config_identity !== options.expectedConfigIdentity
  ) {
    throw new IpcAttachError("HOST_IDENTITY_MISMATCH");
  }
  const socket = createConnection({ path: options.descriptor.socket_path });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new IpcAttachError("HOST_UNAVAILABLE"));
    }, options.timeoutMs ?? 2_000);
    timer.unref();
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", () => {
      clearTimeout(timer);
      reject(new IpcAttachError("HOST_UNAVAILABLE"));
    });
  });
  const helloBase = ClientHelloBaseSchema.parse({
    kind: "client_hello",
    protocol: MEMORY_HOST_IPC_PROTOCOL,
    instance_id: options.descriptor.instance_id,
    root_identity: options.descriptor.root_identity,
    config_identity: options.descriptor.config_identity,
    client_nonce: randomBytes(24).toString("base64url"),
  });
  await writeLine(socket, {
    ...helloBase,
    client_proof: proof(
      options.credential,
      "memo-graph/ipc/client/v1",
      helloBase,
    ).toString("base64url"),
  });
  let response: z.infer<typeof ServerHandshakeResponseSchema>;
  try {
    response = ServerHandshakeResponseSchema.parse(
      JSON.parse(await readLine(socket, options.timeoutMs ?? 2_000)) as unknown,
    );
  } catch (error) {
    socket.destroy();
    throw error instanceof IpcAttachError
      ? error
      : new IpcAttachError("IPC_PROTOCOL_INCOMPATIBLE");
  }
  if (response.kind === "server_reject") {
    socket.destroy();
    throw new IpcAttachError(response.code);
  }
  const ack = response;
  const { server_proof: serverProof, ...ackBaseInput } = ack;
  const ackBase = ServerAckBaseSchema.parse(ackBaseInput);
  if (
    ack.instance_id !== helloBase.instance_id ||
    canonicalJson(ack.root_identity) !== canonicalJson(helloBase.root_identity) ||
    ack.config_identity !== helloBase.config_identity ||
    ack.client_nonce !== helloBase.client_nonce ||
    !proofMatches(
      serverProof,
      proof(options.credential, "memo-graph/ipc/server/v1", ackBase),
    )
  ) {
    socket.destroy();
    throw new IpcAttachError("HOST_AUTHENTICATION_FAILED");
  }
  socket.pause();
  return socket;
}
