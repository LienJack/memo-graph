import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  WorkbenchControlBootstrapResponseSchema,
  WorkbenchEndpointMetadataSchema,
  WorkbenchLaunchResultSchema,
  canonicalJson,
  type WorkbenchEndpointMetadata,
  type WorkbenchLaunchResult,
} from "@memo-graph/contracts";
import {
  MemoryServerConfigSchema,
  connectAuthenticatedIpc,
  memoryRuntimeConfigIdentity,
  memoryRuntimeRootIdentity,
  readIpcCredential,
  readManagedHostDescriptor,
  readPrivateOperatorFile,
  type MemoryServerConfig,
} from "@memo-graph/runtime-host";
import { z } from "zod";

import {
  createWorkbenchControlProof,
} from "../http/control-auth.js";
import {
  publishPrivateFile,
  quarantineArtifacts,
  readWorkbenchEndpoint,
  removeOwnedArtifact,
  workbenchArtifactPaths,
  type WorkbenchArtifactPaths,
} from "./artifacts.js";
import {
  recoverExpiredWorkbenchLaunchLock,
  tryAcquireWorkbenchLaunchLock,
} from "./launch-lock.js";

const HostReadySchema = z
  .object({
    kind: z.literal("workbench_ready"),
    endpoint: WorkbenchEndpointMetadataSchema,
    initial_bootstrap: WorkbenchControlBootstrapResponseSchema,
  })
  .strict();

export class WorkbenchLaunchError extends Error {
  readonly code:
    | "WORKBENCH_START_TIMEOUT"
    | "WORKBENCH_START_FAILED"
    | "WORKBENCH_IDENTITY_MISMATCH"
    | "WORKBENCH_HTTP_UNAVAILABLE"
    | "WORKBENCH_LAUNCH_BUSY";

  constructor(code: WorkbenchLaunchError["code"]) {
    super(code);
    this.name = "WorkbenchLaunchError";
    this.code = code;
  }
}

export type WorkbenchLaunchOutcome = {
  result: WorkbenchLaunchResult;
  launchUrl: string | null;
  processId: number;
};

function processIsLive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

function readControlCredential(path: string): Buffer {
  const bytes = readPrivateOperatorFile(path);
  try {
    const encoded = bytes.toString("utf8").trim();
    if (!/^[A-Za-z0-9_-]{43}$/u.test(encoded)) {
      throw new WorkbenchLaunchError("WORKBENCH_START_FAILED");
    }
    const credential = Buffer.from(encoded, "base64url");
    if (credential.byteLength !== 32) {
      credential.fill(0);
      throw new WorkbenchLaunchError("WORKBENCH_START_FAILED");
    }
    return credential;
  } finally {
    bytes.fill(0);
  }
}

function assertExpectedEndpoint(
  endpoint: WorkbenchEndpointMetadata,
  paths: WorkbenchArtifactPaths,
  config: MemoryServerConfig,
): void {
  const rootIdentity = memoryRuntimeRootIdentity(config.data_root);
  const configIdentity = memoryRuntimeConfigIdentity(config);
  if (
    canonicalJson(endpoint.root_identity) !== canonicalJson(rootIdentity) ||
    endpoint.config_identity !== configIdentity ||
    endpoint.control_credential_path !== paths.controlCredentialPath ||
    (endpoint.runtime_descriptor_path !== null &&
      endpoint.runtime_descriptor_path !== paths.runtimeDescriptorPath)
  ) {
    throw new WorkbenchLaunchError("WORKBENCH_IDENTITY_MISMATCH");
  }
}

function allowedRuntimeSocketPaths(
  paths: WorkbenchArtifactPaths,
): ReadonlySet<string> {
  return new Set([
    paths.runtimeSocketPath,
    join(
      realpathSync(tmpdir()),
      `memo-graph-ipc-${process.getuid?.() ?? "local"}`,
      basename(paths.runtimeSocketPath),
    ),
  ]);
}

function assertExpectedRuntimeArtifactPaths(
  descriptor: ReturnType<typeof readManagedHostDescriptor>,
  paths: WorkbenchArtifactPaths,
): void {
  if (
    descriptor.credential_path !== paths.runtimeCredentialPath ||
    !allowedRuntimeSocketPaths(paths).has(descriptor.socket_path)
  ) {
    throw new WorkbenchLaunchError("WORKBENCH_IDENTITY_MISMATCH");
  }
}

async function requestBootstrap(input: {
  endpoint: WorkbenchEndpointMetadata;
  paths: WorkbenchArtifactPaths;
  config: MemoryServerConfig;
  timeoutMs: number;
}) {
  assertExpectedEndpoint(input.endpoint, input.paths, input.config);
  const credential = readControlCredential(
    input.endpoint.control_credential_path,
  );
  const body = {};
  const nonce = randomBytes(24).toString("base64url");
  const proof = createWorkbenchControlProof({
    credential,
    instanceId: input.endpoint.instance_id,
    origin: input.endpoint.origin,
    nonce,
    body,
  });
  try {
    const response = await fetch(
      `${input.endpoint.origin}/__operator/bootstrap`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-memo-control-nonce": nonce,
          "x-memo-control-proof": proof,
          "x-memo-instance": input.endpoint.instance_id,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(input.timeoutMs),
      },
    );
    const length = Number(response.headers.get("content-length") ?? 0);
    if (!response.ok || length > 8 * 1024) {
      throw new WorkbenchLaunchError("WORKBENCH_HTTP_UNAVAILABLE");
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > 8 * 1024) {
      throw new WorkbenchLaunchError("WORKBENCH_HTTP_UNAVAILABLE");
    }
    return WorkbenchControlBootstrapResponseSchema.parse(
      JSON.parse(text) as unknown,
    );
  } catch (error) {
    if (error instanceof WorkbenchLaunchError) {
      throw error;
    }
    throw new WorkbenchLaunchError("WORKBENCH_HTTP_UNAVAILABLE");
  } finally {
    credential.fill(0);
  }
}

async function runtimeIsLive(input: {
  endpoint: WorkbenchEndpointMetadata | null;
  paths: WorkbenchArtifactPaths;
  config: MemoryServerConfig;
}): Promise<boolean> {
  const descriptorPath =
    input.endpoint?.runtime_descriptor_path ?? input.paths.runtimeDescriptorPath;
  if (!existsSync(descriptorPath)) {
    return false;
  }
  try {
    const descriptor = readManagedHostDescriptor(descriptorPath);
    assertExpectedRuntimeArtifactPaths(descriptor, input.paths);
    const credential = readIpcCredential(descriptor.credential_path);
    try {
      const socket = await connectAuthenticatedIpc({
        descriptor,
        credential,
        expectedRootIdentity: memoryRuntimeRootIdentity(
          input.config.data_root,
        ),
        expectedConfigIdentity: memoryRuntimeConfigIdentity(input.config),
        timeoutMs: 500,
      });
      socket.destroy();
      return true;
    } finally {
      credential.fill(0);
    }
  } catch (error) {
    if (error instanceof WorkbenchLaunchError) {
      throw error;
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "HOST_IDENTITY_MISMATCH" ||
        error.code === "HOST_AUTHENTICATION_FAILED" ||
        error.code === "IPC_PROTOCOL_INCOMPATIBLE")
    ) {
      throw new WorkbenchLaunchError("WORKBENCH_IDENTITY_MISMATCH");
    }
    return false;
  }
}

function cleanupStaleArtifacts(input: {
  endpoint: WorkbenchEndpointMetadata | null;
  paths: WorkbenchArtifactPaths;
}): void {
  const candidates = [
    input.paths.endpointPath,
    input.paths.controlCredentialPath,
    input.paths.runtimeDescriptorPath,
    input.paths.runtimeCredentialPath,
    input.paths.runtimeSocketPath,
    input.paths.hookDescriptorPath,
    input.paths.hookCredentialPath,
  ];
  if (input.endpoint?.runtime_descriptor_path !== null) {
    try {
      const descriptor = readManagedHostDescriptor(
        input.endpoint?.runtime_descriptor_path ?? input.paths.runtimeDescriptorPath,
      );
      assertExpectedRuntimeArtifactPaths(descriptor, input.paths);
      candidates.push(descriptor.socket_path);
    } catch {
      // The deterministic descriptor/key paths are still quarantined below.
    }
  }
  quarantineArtifacts(
    [...new Set(candidates)],
    input.paths.runtimeDirectory,
  );
}

function readExpectedEndpoint(input: {
  paths: WorkbenchArtifactPaths;
  config: MemoryServerConfig;
}): WorkbenchEndpointMetadata | null {
  if (!existsSync(input.paths.endpointPath)) {
    return null;
  }
  try {
    const endpoint = readWorkbenchEndpoint(input.paths.endpointPath);
    assertExpectedEndpoint(endpoint, input.paths, input.config);
    return endpoint;
  } catch (error) {
    if (error instanceof WorkbenchLaunchError) {
      throw error;
    }
    return null;
  }
}

async function existingEndpoint(input: {
  paths: WorkbenchArtifactPaths;
  config: MemoryServerConfig;
  timeoutMs: number;
}): Promise<{
  endpoint: WorkbenchEndpointMetadata;
  bootstrap: Awaited<ReturnType<typeof requestBootstrap>>;
} | null> {
  const endpoint = readExpectedEndpoint(input);
  if (endpoint === null) {
    return null;
  }
  try {
    return {
      endpoint,
      bootstrap: await requestBootstrap({
        endpoint,
        paths: input.paths,
        config: input.config,
        timeoutMs: input.timeoutMs,
      }),
    };
  } catch (error) {
    if (!(error instanceof WorkbenchLaunchError)) {
      throw error;
    }
    if (
      processIsLive(endpoint.process_id) ||
      await runtimeIsLive({ endpoint, paths: input.paths, config: input.config })
    ) {
      throw new WorkbenchLaunchError("WORKBENCH_HTTP_UNAVAILABLE");
    }
    return null;
  }
}

async function waitForReady(input: {
  child: ReturnType<typeof spawn>;
  timeoutMs: number;
}): Promise<z.infer<typeof HostReadySchema>> {
  const stdout = input.child.stdout;
  const stderr = input.child.stderr;
  if (stdout === null) {
    throw new WorkbenchLaunchError("WORKBENCH_START_FAILED");
  }
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    let stderrBytes = 0;
    let settled = false;
    const finish = (
      result: z.infer<typeof HostReadySchema> | null,
      error?: WorkbenchLaunchError,
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      stdout.off("data", onData);
      stderr?.off("data", onStderr);
      input.child.off("exit", onExit);
      if (result === null) {
        reject(error ?? new WorkbenchLaunchError("WORKBENCH_START_FAILED"));
      } else {
        resolve(result);
      }
    };
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.byteLength > 64 * 1024) {
        finish(null);
        return;
      }
      const newline = buffered.indexOf(0x0a);
      if (newline === -1) {
        return;
      }
      try {
        finish(
          HostReadySchema.parse(
            JSON.parse(buffered.subarray(0, newline).toString("utf8")) as unknown,
          ),
        );
      } catch {
        finish(null);
      }
    };
    const onExit = (): void => finish(null);
    const onStderr = (chunk: Buffer): void => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > 64 * 1024) {
        finish(null);
      }
    };
    const timer = setTimeout(
      () => finish(null, new WorkbenchLaunchError("WORKBENCH_START_TIMEOUT")),
      input.timeoutMs,
    );
    timer.unref();
    stdout.on("data", onData);
    stderr?.on("data", onStderr);
    input.child.once("exit", onExit);
  });
}

async function defaultBrowserOpener(url: string): Promise<void> {
  const command = process.platform === "darwin"
    ? { executable: "open", args: [url] }
    : process.platform === "win32"
      ? {
          executable: "rundll32.exe",
          args: ["url.dll,FileProtocolHandler", url],
        }
      : { executable: "xdg-open", args: [url] };
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      shell: false,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error("browser opener failed"));
      }
    });
  });
}

export async function launchOrReuseWorkbench(options: {
  config: unknown;
  runtimeDirectory: string;
  noOpen?: boolean;
  headless?: boolean;
  hostEntry?: string;
  browserOpener?: (url: string) => Promise<void>;
  startupTimeoutMs?: number;
  lockTimeoutMs?: number;
  detach?: boolean;
}): Promise<WorkbenchLaunchOutcome> {
  const config = MemoryServerConfigSchema.parse(options.config);
  mkdirSync(config.data_root, { recursive: true, mode: 0o700 });
  const rootIdentity = memoryRuntimeRootIdentity(config.data_root);
  const configIdentity = memoryRuntimeConfigIdentity(config);
  const paths = workbenchArtifactPaths({
    runtimeDirectory: options.runtimeDirectory,
    rootIdentity,
    configIdentity,
  });
  const suppressBrowser = options.noOpen === true || options.headless === true;
  const deadline = Date.now() + (options.lockTimeoutMs ?? 5_000);
  const launchId = randomUUID();
  let lock = null;
  while (lock === null && Date.now() <= deadline) {
    const reused = await existingEndpoint({
      paths,
      config,
      timeoutMs: 750,
    });
    if (reused !== null) {
      return finishLaunch({
        status: "reused",
        endpoint: reused.endpoint,
        bootstrap: reused.bootstrap,
        suppressBrowser,
        paths,
        config,
        timeoutMs: 750,
        ...(options.browserOpener === undefined
          ? {}
          : { browserOpener: options.browserOpener }),
      });
    }
    lock = tryAcquireWorkbenchLaunchLock({
      path: paths.launchLockPath,
      launchId,
      createdAt: new Date().toISOString(),
    });
    if (lock === null) {
      recoverExpiredWorkbenchLaunchLock({
        path: paths.launchLockPath,
        nowMs: Date.now(),
        staleAfterMs: 1_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (lock === null) {
    throw new WorkbenchLaunchError("WORKBENCH_LAUNCH_BUSY");
  }
  let child: ReturnType<typeof spawn> | null = null;
  let configPath: string | null = null;
  let configArtifactIdentity: ReturnType<typeof publishPrivateFile> | null =
    null;
  try {
    const existing = await existingEndpoint({
      paths,
      config,
      timeoutMs: 750,
    });
    if (existing !== null) {
      return await finishLaunch({
        status: "reused",
        endpoint: existing.endpoint,
        bootstrap: existing.bootstrap,
        suppressBrowser,
        paths,
        config,
        timeoutMs: 750,
        ...(options.browserOpener === undefined
          ? {}
          : { browserOpener: options.browserOpener }),
      });
    }
    const staleEndpoint = readExpectedEndpoint({ paths, config });
    if (await runtimeIsLive({ endpoint: staleEndpoint, paths, config })) {
      throw new WorkbenchLaunchError("WORKBENCH_HTTP_UNAVAILABLE");
    }
    cleanupStaleArtifacts({ endpoint: staleEndpoint, paths });
    configPath = `${paths.runtimeDirectory}/launch-${launchId}.json`;
    configArtifactIdentity = publishPrivateFile(
      configPath,
      `${canonicalJson(config)}\n`,
    );
    const adjacentHostEntry = fileURLToPath(
      new URL("../cli.js", import.meta.url),
    );
    const hostEntry = options.hostEntry ?? (
      existsSync(adjacentHostEntry)
        ? adjacentHostEntry
        : fileURLToPath(new URL("../../dist/cli.js", import.meta.url))
    );
    child = spawn(
      process.execPath,
      [
        hostEntry,
        "--config",
        configPath,
        "--runtime-dir",
        paths.runtimeDirectory,
        "--instance",
        `workbench:${randomUUID()}`,
      ],
      {
        shell: false,
        detached: options.detach ?? true,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const ready = await waitForReady({
      child,
      timeoutMs: options.startupTimeoutMs ?? 10_000,
    });
    assertExpectedEndpoint(ready.endpoint, paths, config);
    const publishedEndpoint = readExpectedEndpoint({ paths, config });
    if (
      publishedEndpoint === null ||
      canonicalJson(publishedEndpoint) !== canonicalJson(ready.endpoint) ||
      ready.initial_bootstrap.instance_id !== ready.endpoint.instance_id
    ) {
      throw new WorkbenchLaunchError("WORKBENCH_IDENTITY_MISMATCH");
    }
    child.stderr?.destroy();
    child.stdout?.destroy();
    child.unref();
    const bootstrap = WorkbenchControlBootstrapResponseSchema.parse(
      ready.initial_bootstrap,
    );
    return await finishLaunch({
      status: "started",
      endpoint: ready.endpoint,
      bootstrap,
      suppressBrowser,
      paths,
      config,
      timeoutMs: 750,
      ...(options.browserOpener === undefined
        ? {}
        : { browserOpener: options.browserOpener }),
    });
  } catch (error) {
    child?.kill("SIGTERM");
    throw error;
  } finally {
    lock.release();
    if (configPath !== null) {
      removeOwnedArtifact(configPath, configArtifactIdentity);
    }
  }
}

async function finishLaunch(input: {
  status: "started" | "reused";
  endpoint: WorkbenchEndpointMetadata;
  bootstrap: z.infer<typeof WorkbenchControlBootstrapResponseSchema>;
  suppressBrowser: boolean;
  paths: WorkbenchArtifactPaths;
  config: MemoryServerConfig;
  timeoutMs: number;
  browserOpener?: (url: string) => Promise<void>;
}): Promise<WorkbenchLaunchOutcome> {
  let browser: "opened" | "suppressed" | "failed" = input.suppressBrowser
    ? "suppressed"
    : "opened";
  const launchUrl = (ticket: string): string =>
    `${input.endpoint.origin}/#ticket=${ticket}&instance=${input.endpoint.instance_id}`;
  let pendingLaunchUrl: string | null = launchUrl(input.bootstrap.ticket);
  if (!input.suppressBrowser) {
    try {
      await (input.browserOpener ?? defaultBrowserOpener)(
        pendingLaunchUrl,
      );
      browser = "opened";
      pendingLaunchUrl = null;
    } catch {
      browser = "failed";
      const recovery = await requestBootstrap({
        endpoint: input.endpoint,
        paths: input.paths,
        config: input.config,
        timeoutMs: input.timeoutMs,
      });
      pendingLaunchUrl = launchUrl(recovery.ticket);
    }
  }
  return {
    result: WorkbenchLaunchResultSchema.parse({
      schema_version: "1.0.0",
      status: input.status,
      instance_id: input.endpoint.instance_id,
      runtime_state: input.endpoint.runtime_state,
      origin: input.endpoint.origin,
      browser,
      recovery: browser === "opened" ? "none" : "open_launch_url",
    }),
    launchUrl: pendingLaunchUrl,
    processId: input.endpoint.process_id,
  };
}
