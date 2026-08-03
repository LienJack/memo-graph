#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  WorkbenchEndpointMetadataSchema,
  canonicalJson,
} from "@memo-graph/contracts";
import { workbenchArtifactPaths } from "@memo-graph/memory-workbench-host";
import { loadOperatorConfig } from "@memo-graph/operator-cli/config";
import { workbenchRuntimeConfig } from "@memo-graph/operator-cli/workbench";
import {
  memoryRuntimeConfigIdentity,
  memoryRuntimeRootIdentity,
} from "@memo-graph/runtime-host";
import { FileRecoveryHeadProvider } from "@memo-graph/storage-sqlite";

import {
  assertCoreMemoryTools,
  buildDefaultConfigDocuments,
  buildCodexRegistration,
  resolveBootstrapPaths,
  type CodexRegistration,
} from "./install-contract.js";
import {
  buildManagedHookCommand,
  installCodexHookConfiguration,
} from "./hook-config.js";

type InstallArguments = {
  codexBinary?: string;
  codexConfigPath: string;
  dataRoot: string;
  hookSpoolDirectory: string;
  hooksJsonPath: string;
  installRoot: string;
  mcpConfigPath: string;
  nodeExecutable: string;
  operatorConfigPath: string;
  recoveryAuthorityRoot: string;
  runtimeDirectory: string;
};

type CodexMcpSnapshot = {
  disabled_tools?: string[] | null;
  enabled?: boolean;
  enabled_tools?: string[] | null;
  name: string;
  startup_timeout_sec?: number | null;
  tool_timeout_sec?: number | null;
  transport:
    | {
        type: "stdio";
        command: string;
        args?: string[];
        cwd?: string | null;
        env?: Record<string, string> | null;
        env_vars?: string[];
      }
    | {
        type: "streamable_http";
        url: string;
        bearer_token_env_var?: string | null;
      };
};

function parseArguments(argv: string[]): InstallArguments {
  const defaults = resolveBootstrapPaths();
  const values: InstallArguments = {
    codexConfigPath: defaults.codexConfigPath,
    dataRoot: defaults.dataRoot,
    hookSpoolDirectory: defaults.hookSpoolDirectory,
    hooksJsonPath: defaults.hooksJsonPath,
    installRoot: defaults.installRoot,
    mcpConfigPath: defaults.mcpConfigPath,
    nodeExecutable: process.execPath,
    operatorConfigPath: defaults.operatorConfigPath,
    recoveryAuthorityRoot: defaults.recoveryAuthorityRoot,
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
      throw new Error("INVALID_INSTALL_ARGUMENTS");
    }
    seen.add(flag);
    switch (flag) {
      case "--codex-config":
        values.codexConfigPath = value;
        break;
      case "--codex-bin":
        values.codexBinary = value;
        break;
      case "--data-root":
        values.dataRoot = value;
        break;
      case "--hook-spool":
        values.hookSpoolDirectory = value;
        break;
      case "--hooks-json":
        values.hooksJsonPath = value;
        break;
      case "--install-root":
        values.installRoot = value;
        break;
      case "--mcp-config":
        values.mcpConfigPath = value;
        break;
      case "--node":
        values.nodeExecutable = value;
        break;
      case "--operator-config":
        values.operatorConfigPath = value;
        break;
      case "--recovery-authority-root":
        values.recoveryAuthorityRoot = value;
        break;
      case "--runtime-dir":
        values.runtimeDirectory = value;
        break;
      default:
        throw new Error("INVALID_INSTALL_ARGUMENTS");
    }
  }
  for (const value of Object.values(values)) {
    if (value !== undefined && !isAbsolute(value)) {
      throw new Error("INSTALL_PATH_NOT_ABSOLUTE");
    }
  }
  return values;
}

function pathContains(parent: string, candidate: string): boolean {
  const fromParent = relative(parent, candidate);
  return (
    fromParent === "" ||
    fromParent !== ".." &&
      !fromParent.startsWith(`..${sep}`) &&
      !isAbsolute(fromParent)
  );
}

function assertNoSymlinkAncestor(pathInput: string): void {
  let cursor = resolve(pathInput);
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) {
      throw new Error("INSTALL_PATH_HAS_NO_TRUSTED_ANCESTOR");
    }
    cursor = parent;
  }
  const stat = lstatSync(cursor);
  if (stat.isSymbolicLink() || realpathSync(cursor) !== cursor) {
    throw new Error("INSTALL_PATH_CONTAINS_SYMLINK");
  }
}

function assertSafeInstallLayout(arguments_: InstallArguments): void {
  if (
    process.getuid?.() === 0
  ) {
    throw new Error("INSTALL_AS_ROOT_FORBIDDEN");
  }
  if (
    basename(arguments_.dataRoot) !== "data" ||
    basename(arguments_.hookSpoolDirectory) !== "hook-spool" ||
    basename(arguments_.installRoot) !== "codex-bootstrap" ||
    basename(arguments_.recoveryAuthorityRoot) !== "recovery-authority" ||
    basename(arguments_.runtimeDirectory) !== "workbench-runtime" ||
    basename(arguments_.mcpConfigPath) !== "mcp.json" ||
    basename(arguments_.operatorConfigPath) !== "operator.json" ||
    basename(arguments_.hooksJsonPath) !== "hooks.json" ||
    basename(arguments_.codexConfigPath) !== "config.toml"
  ) {
    throw new Error("INSTALL_PATH_NOT_DEDICATED");
  }
  const home = resolve(homedir());
  const directories = [
    arguments_.dataRoot,
    arguments_.installRoot,
    arguments_.recoveryAuthorityRoot,
    arguments_.runtimeDirectory,
    arguments_.hookSpoolDirectory,
  ].map((path) => resolve(path));
  if (
    directories.some(
      (path) => path === dirname(path) || path === home,
    )
  ) {
    throw new Error("INSTALL_PATH_TOO_BROAD");
  }
  for (const path of [
    ...directories,
    arguments_.mcpConfigPath,
    arguments_.operatorConfigPath,
    arguments_.hooksJsonPath,
    arguments_.codexConfigPath,
  ]) {
    assertNoSymlinkAncestor(path);
  }
  for (let left = 0; left < directories.length; left += 1) {
    for (let right = left + 1; right < directories.length; right += 1) {
      const first = directories[left];
      const second = directories[right];
      if (
        first !== undefined &&
        second !== undefined &&
        (pathContains(first, second) || pathContains(second, first))
      ) {
        throw new Error("INSTALL_PATHS_OVERLAP");
      }
    }
  }
  for (const configPath of [
    resolve(arguments_.mcpConfigPath),
    resolve(arguments_.operatorConfigPath),
    resolve(arguments_.hooksJsonPath),
    resolve(arguments_.codexConfigPath),
  ]) {
    if (
      directories.some(
        (directory) =>
          pathContains(directory, configPath) ||
          pathContains(configPath, directory),
      )
    ) {
      throw new Error("INSTALL_PATHS_OVERLAP");
    }
  }
}

function ensurePrivateConfiguration(arguments_: InstallArguments): boolean {
  const mcpExists = existsSync(arguments_.mcpConfigPath);
  const operatorExists = existsSync(arguments_.operatorConfigPath);
  if (mcpExists !== operatorExists) {
    throw new Error("PARTIAL_CONFIGURATION_PRESENT");
  }
  if (mcpExists) {
    return false;
  }
  if (existsSync(arguments_.recoveryAuthorityRoot)) {
    throw new Error("DEFAULT_RECOVERY_AUTHORITY_PRESENT");
  }

  const recoveryDirectory = join(arguments_.recoveryAuthorityRoot, "head");
  const privateKeyPath = join(
    arguments_.recoveryAuthorityRoot,
    "private-key.pem",
  );
  const publicKeyPath = join(
    arguments_.recoveryAuthorityRoot,
    "public-key.pem",
  );
  const authorityKeyId = "recovery_authority:codex_local";
  const keys = generateKeyPairSync("ed25519");
  const documents = buildDefaultConfigDocuments({
    authorityKeyId,
    dataRoot: arguments_.dataRoot,
    privateKeyPath,
    publicKeyPath,
    recoveryDirectory,
  });
  mkdirSync(dirname(arguments_.mcpConfigPath), {
    recursive: true,
    mode: 0o700,
  });
  mkdirSync(dirname(arguments_.operatorConfigPath), {
    recursive: true,
    mode: 0o700,
  });
  mkdirSync(arguments_.dataRoot, { recursive: true, mode: 0o700 });
  mkdirSync(arguments_.recoveryAuthorityRoot, { mode: 0o700 });
  try {
    writeFileSync(
      privateKeyPath,
      keys.privateKey.export({ type: "pkcs8", format: "pem" }),
      { flag: "wx", mode: 0o600 },
    );
    writeFileSync(
      publicKeyPath,
      keys.publicKey.export({ type: "spki", format: "pem" }),
      { flag: "wx", mode: 0o600 },
    );
    new FileRecoveryHeadProvider({
      directory: recoveryDirectory,
      authorityKeyId,
      trustRootVersion: 1,
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
      create: true,
    });
    writeFileSync(
      arguments_.mcpConfigPath,
      `${JSON.stringify(documents.mcp, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    writeFileSync(
      arguments_.operatorConfigPath,
      `${JSON.stringify(documents.operator, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    rmSync(arguments_.mcpConfigPath, { force: true });
    rmSync(arguments_.operatorConfigPath, { force: true });
    rmSync(arguments_.recoveryAuthorityRoot, {
      recursive: true,
      force: true,
    });
    throw error;
  }
  return true;
}

function run(
  command: string,
  args: string[],
  options: { allowFailure?: boolean; cwd?: string } = {},
) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0 && options.allowFailure !== true) {
    throw new Error("INSTALL_COMMAND_FAILED");
  }
  return result;
}

function codexCanReadCurrentConfiguration(candidate: string): boolean {
  try {
    return run(candidate, ["mcp", "list", "--json"], {
      allowFailure: true,
    }).status === 0;
  } catch {
    return false;
  }
}

export function selectCompatibleCodexBinary(
  candidates: readonly string[],
): string {
  let existingCandidateFound = false;
  const visited = new Set<string>();
  for (const candidate of candidates) {
    if (!isAbsolute(candidate) || !existsSync(candidate)) {
      continue;
    }
    const canonical = realpathSync(candidate);
    if (visited.has(canonical)) {
      continue;
    }
    visited.add(canonical);
    existingCandidateFound = true;
    if (codexCanReadCurrentConfiguration(canonical)) {
      return canonical;
    }
  }
  throw new Error(
    existingCandidateFound
      ? "CODEX_BINARY_INCOMPATIBLE"
      : "CODEX_BINARY_NOT_FOUND",
  );
}

function findCodexBinary(explicit: string | undefined): string {
  if (explicit !== undefined) {
    return selectCompatibleCodexBinary([explicit]);
  }
  const candidates = [
    process.env.CODEX_BIN,
    ...(process.platform === "darwin"
      ? [
          "/Applications/ChatGPT.app/Contents/Resources/codex",
          "/Applications/Codex.app/Contents/Resources/codex",
          join(homedir(), "Applications", "ChatGPT.app", "Contents", "Resources", "codex"),
          join(homedir(), "Applications", "Codex.app", "Contents", "Resources", "codex"),
        ]
      : []),
  ].filter((value): value is string => value !== undefined);
  const locator = process.platform === "win32" ? "where" : "which";
  const located = run(
    locator,
    process.platform === "win32" ? ["codex"] : ["-a", "codex"],
    { allowFailure: true },
  );
  if (located.status === 0) {
    candidates.push(
      ...located.stdout
        .split(/\r?\n/u)
        .filter((value) => value.length > 0),
    );
  }
  return selectCompatibleCodexBinary(candidates);
}

function workspaceRoot(): string {
  return realpathSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."),
  );
}

function deployNodeRuntime(
  nodeExecutable: string,
  installRoot: string,
): string {
  const source = realpathSync(nodeExecutable);
  const versionResult = run(source, ["--version"]);
  const version = versionResult.stdout.trim();
  if (!/^v24\.\d+\.\d+$/u.test(version)) {
    throw new Error("UNSUPPORTED_NODE_VERSION");
  }
  const binaryIdentity = createHash("sha256")
    .update(readFileSync(source))
    .digest("hex")
    .slice(0, 20);
  const runtimes = join(installRoot, "runtimes");
  mkdirSync(runtimes, { recursive: true, mode: 0o700 });
  chmodSync(runtimes, 0o700);
  const runtime = join(
    runtimes,
    `node-${version.slice(1)}-${binaryIdentity}`,
  );
  const entry = join(runtime, "bin", "node");
  if (!existsSync(entry)) {
    const staging = mkdtempSync(join(installRoot, ".node-staging-"));
    try {
      mkdirSync(join(staging, "bin"), { recursive: true, mode: 0o700 });
      copyFileSync(source, join(staging, "bin", "node"));
      chmodSync(join(staging, "bin", "node"), 0o700);
      const license = join(dirname(dirname(source)), "LICENSE");
      if (existsSync(license)) {
        copyFileSync(license, join(staging, "LICENSE"));
        chmodSync(join(staging, "LICENSE"), 0o600);
      }
      renameSync(staging, runtime);
    } catch (error) {
      if (existsSync(staging)) {
        rmSync(staging, { recursive: true, force: true });
      }
      throw error;
    }
  }
  const runtimeStat = lstatSync(runtime);
  const entryStat = lstatSync(entry);
  const installedIdentity = createHash("sha256")
    .update(readFileSync(entry))
    .digest("hex")
    .slice(0, 20);
  if (
    runtimeStat.isSymbolicLink() ||
    !runtimeStat.isDirectory() ||
    realpathSync(runtime) !== runtime ||
    entryStat.isSymbolicLink() ||
    !entryStat.isFile() ||
    installedIdentity !== binaryIdentity ||
    run(entry, ["--version"]).stdout.trim() !== version
  ) {
    throw new Error("DEPLOYED_NODE_INVALID");
  }
  chmodSync(runtime, 0o700);
  chmodSync(join(runtime, "bin"), 0o700);
  chmodSync(entry, 0o700);
  return realpathSync(entry);
}

function deployPackage(root: string, installRoot: string): string {
  mkdirSync(installRoot, { recursive: true, mode: 0o700 });
  chmodSync(installRoot, 0o700);
  const releases = join(installRoot, "releases");
  mkdirSync(releases, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(installRoot, ".staging-"));
  const npmExecutable = process.env.npm_execpath;
  const command = npmExecutable === undefined ? "pnpm" : process.execPath;
  const prefix = npmExecutable === undefined ? [] : [npmExecutable];
  try {
    run(
      command,
      [
        ...prefix,
        "--filter",
        "@memo-graph/codex-bootstrap",
        "deploy",
        "--prod",
        "--legacy",
        staging,
      ],
      { cwd: root },
    );
    sanitizePortableDeployment(staging);
    const identity = deploymentIdentity(staging);
    const release = join(releases, identity);
    if (existsSync(release)) {
      removeStaging(staging, installRoot);
    } else {
      renameSync(staging, release);
    }
    const entry = join(release, "dist", "cli.js");
    if (!existsSync(entry)) {
      throw new Error("DEPLOYED_BOOTSTRAP_MISSING");
    }
    return entry;
  } catch (error) {
    if (existsSync(staging)) {
      removeStaging(staging, installRoot);
    }
    throw error;
  }
}

export function sanitizePortableDeployment(root: string): void {
  const canonicalRoot = realpathSync(root);
  const removeGenerated = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const relativePath = relative(canonicalRoot, path);
      if (
        relativePath.length === 0 ||
        relativePath.startsWith(`..${sep}`) ||
        isAbsolute(relativePath)
      ) {
        throw new Error("UNSAFE_DEPLOYMENT_SANITIZE_PATH");
      }
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        let remove: boolean;
        try {
          const target = realpathSync(path);
          const fromRoot = relative(canonicalRoot, target);
          remove =
            fromRoot === ".." ||
            fromRoot.startsWith(`..${sep}`) ||
            isAbsolute(fromRoot);
        } catch {
          remove = true;
        }
        if (remove) {
          rmSync(path, { force: true });
        }
      } else if (stat.isDirectory() && name === ".bin") {
        rmSync(path, { recursive: true, force: true });
      } else if (stat.isDirectory()) {
        removeGenerated(path);
      }
    }
  };
  removeGenerated(canonicalRoot);
  const modulesMetadata = join(canonicalRoot, "node_modules", ".modules.yaml");
  if (existsSync(modulesMetadata)) {
    rmSync(modulesMetadata);
  }
}

function removeStaging(staging: string, installRoot: string): void {
  const relativePath = relative(realpathSync(installRoot), staging);
  if (
    relativePath.length === 0 ||
    relativePath.startsWith(`..${sep}`) ||
    !relativePath.startsWith(".staging-")
  ) {
    throw new Error("UNSAFE_STAGING_PATH");
  }
  rmSync(staging, { recursive: true, force: true });
}

function deploymentIdentity(root: string): string {
  const hash = createHash("sha256");
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relativePath = relative(root, path);
      const stat = lstatSync(path);
      hash.update(relativePath);
      if (stat.isSymbolicLink()) {
        hash.update("symlink");
        hash.update(readlinkSync(path));
      } else if (stat.isDirectory()) {
        hash.update("directory");
        visit(path);
      } else if (stat.isFile()) {
        hash.update("file");
        hash.update(readFileSync(path));
      }
    }
  };
  visit(root);
  return `release-${hash.digest("hex").slice(0, 20)}`;
}

function codexSnapshot(codexBinary: string): CodexMcpSnapshot | null {
  const result = run(
    codexBinary,
    ["mcp", "get", "memo_graph_memory", "--json"],
    { allowFailure: true },
  );
  if (result.status !== 0) {
    return null;
  }
  return JSON.parse(result.stdout) as CodexMcpSnapshot;
}

function codexAddArguments(snapshot: CodexMcpSnapshot): string[] {
  if (snapshot.transport.type === "stdio") {
    const args = ["mcp", "add", snapshot.name];
    for (const [key, value] of Object.entries(snapshot.transport.env ?? {})) {
      args.push("--env", `${key}=${value}`);
    }
    args.push(
      "--",
      snapshot.transport.command,
      ...(snapshot.transport.args ?? []),
    );
    return args;
  }
  const args = [
    "mcp",
    "add",
    snapshot.name,
    "--url",
    snapshot.transport.url,
  ];
  if (snapshot.transport.bearer_token_env_var !== null && snapshot.transport.bearer_token_env_var !== undefined) {
    args.push(
      "--bearer-token-env-var",
      snapshot.transport.bearer_token_env_var,
    );
  }
  return args;
}

function assertRoundTrippableSnapshot(snapshot: CodexMcpSnapshot): void {
  if (
    snapshot.enabled === false ||
    (snapshot.enabled_tools?.length ?? 0) > 0 ||
    (snapshot.disabled_tools?.length ?? 0) > 0 ||
    snapshot.startup_timeout_sec !== null &&
      snapshot.startup_timeout_sec !== undefined ||
    snapshot.tool_timeout_sec !== null &&
      snapshot.tool_timeout_sec !== undefined ||
    snapshot.transport.type === "stdio" &&
      (snapshot.transport.cwd !== null &&
        snapshot.transport.cwd !== undefined ||
        (snapshot.transport.env_vars?.length ?? 0) > 0) ||
    snapshot.transport.type !== "stdio"
  ) {
    throw new Error("PREVIOUS_REGISTRATION_NOT_ROUND_TRIPPABLE");
  }
}

function writeRegistrationBackup(
  installRoot: string,
  previous: CodexMcpSnapshot | null,
  next: CodexRegistration,
): string {
  const directory = join(installRoot, "registration-backups");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(
    directory,
    `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.json`,
  );
  writeFileSync(
    path,
    `${JSON.stringify({ schema_version: "1.0.0", previous, next }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return path;
}

function registerCodex(
  codexBinary: string,
  registration: CodexRegistration,
  installRoot: string,
): { backupPath: string; previous: CodexMcpSnapshot | null } {
  const previous = codexSnapshot(codexBinary);
  if (previous !== null) {
    assertRoundTrippableSnapshot(previous);
  }
  const backupPath = writeRegistrationBackup(
    installRoot,
    previous,
    registration,
  );
  if (previous !== null) {
    run(codexBinary, ["mcp", "remove", registration.name]);
  }
  try {
    run(codexBinary, [
      "mcp",
      "add",
      registration.name,
      "--",
      registration.command,
      ...registration.args,
    ]);
  } catch (error) {
    if (previous !== null) {
      run(codexBinary, codexAddArguments(previous));
    }
    throw error;
  }
  return { backupPath, previous };
}

function rollbackCodex(
  codexBinary: string,
  registration: CodexRegistration,
  previous: CodexMcpSnapshot | null,
): void {
  run(codexBinary, ["mcp", "remove", registration.name], {
    allowFailure: true,
  });
  if (previous !== null) {
    run(codexBinary, codexAddArguments(previous));
  }
}

function registrationArgument(
  registration: CodexRegistration,
  flag: string,
): string {
  const index = registration.args.indexOf(flag);
  const value = index === -1 ? undefined : registration.args[index + 1];
  if (value === undefined) {
    throw new Error("REGISTRATION_ARGUMENT_MISSING");
  }
  return value;
}

function startedProbeInstance(diagnostics: string): string | null {
  for (const line of diagnostics.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (
        parsed.component === "memo-graph-codex-bootstrap" &&
        parsed.event === "workbench_ready" &&
        parsed.code === "STARTED" &&
        typeof parsed.instance_id === "string"
      ) {
        return parsed.instance_id;
      }
    } catch {
      // Non-bootstrap stderr cannot authorize owner cleanup.
    }
  }
  return null;
}

function diagnosticsContain(
  diagnostics: string,
  event: string,
  code: string,
): boolean {
  for (const line of diagnostics.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (
        parsed.component === "memo-graph-codex-bootstrap" &&
        parsed.event === event &&
        parsed.code === code
      ) {
        return true;
      }
    } catch {
      // Only exact structured bootstrap diagnostics authorize a retry.
    }
  }
  return false;
}

function expectedWorkbenchOwner(registration: CodexRegistration) {
  const operatorConfigPath = registrationArgument(
    registration,
    "--operator-config",
  );
  const runtimeDirectory = registrationArgument(
    registration,
    "--runtime-dir",
  );
  const config = workbenchRuntimeConfig(
    loadOperatorConfig(operatorConfigPath),
  );
  const rootIdentity = memoryRuntimeRootIdentity(config.data_root);
  const configIdentity = memoryRuntimeConfigIdentity(config);
  const paths = workbenchArtifactPaths({
    runtimeDirectory,
    rootIdentity,
    configIdentity,
  });
  if (!existsSync(paths.endpointPath)) {
    return null;
  }
  const endpoint = WorkbenchEndpointMetadataSchema.parse(
    JSON.parse(readFileSync(paths.endpointPath, "utf8")) as unknown,
  );
  if (
    endpoint.config_identity !== configIdentity ||
    canonicalJson(endpoint.root_identity) !== canonicalJson(rootIdentity) ||
    endpoint.control_credential_path !== paths.controlCredentialPath ||
    endpoint.runtime_descriptor_path !== paths.runtimeDescriptorPath ||
    endpoint.process_id <= 1
  ) {
    throw new Error("PROBE_OWNER_IDENTITY_MISMATCH");
  }
  return { endpoint };
}

async function stopWorkbenchOwner(processId: number): Promise<void> {
  try {
    process.kill(processId, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return;
    }
    throw error;
  }
  for (let attempt = 0; attempt < 250; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    try {
      process.kill(processId, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return;
      }
      throw error;
    }
    if (process.platform !== "win32") {
      const state = run("/bin/ps", ["-p", String(processId), "-o", "stat="], {
        allowFailure: true,
      });
      if (state.status !== 0 || state.stdout.trimStart().startsWith("Z")) {
        return;
      }
    }
  }
  throw new Error("PROBE_OWNER_DID_NOT_EXIT");
}

async function stopStartedProbeWorkbench(
  registration: CodexRegistration,
  diagnostics: string,
): Promise<void> {
  const instanceId = startedProbeInstance(diagnostics);
  if (instanceId === null) {
    return;
  }
  const owner = expectedWorkbenchOwner(registration);
  if (owner === null) {
    return;
  }
  if (owner.endpoint.instance_id !== instanceId) {
    throw new Error("PROBE_OWNER_IDENTITY_MISMATCH");
  }
  await stopWorkbenchOwner(owner.endpoint.process_id);
}

async function restartIncompatibleWorkbench(
  registration: CodexRegistration,
): Promise<boolean> {
  const owner = expectedWorkbenchOwner(registration);
  if (owner === null) {
    return false;
  }
  await stopWorkbenchOwner(owner.endpoint.process_id);
  return true;
}

async function probeRegistration(
  registration: CodexRegistration,
  allowUpgradeRestart = true,
): Promise<{ readStatus: "NO_MATCH" | "OK"; toolNames: string[] }> {
  const transport = new StdioClientTransport({
    command: registration.command,
    args: registration.args,
    env: { MEMO_GRAPH_BOOTSTRAP_NO_OPEN: "1" },
    stderr: "pipe",
  });
  const client = new Client({
    name: "memo-graph-codex-installer",
    version: "1.0.0",
  });
  let diagnostics = "";
  transport.stderr?.on("data", (chunk) => {
    diagnostics += chunk.toString();
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const toolNames = listed.tools.map((tool) => tool.name);
    assertCoreMemoryTools(toolNames);
    const read = await client.callTool({
      name: "memory_search",
      arguments: {
        envelope: {
          schema_version: "1.0.0",
          request_id: `codex_install_probe_${randomUUID()}`,
          tool: "memory_search",
          actor_claim: {
            principal_id: "user_local",
            authority: "user_stated",
          },
          scopes: [{ kind: "workspace", id: "workspace_local" }],
          purpose: "verify installed Codex memory tools",
          reason: "post-install read-only acceptance probe",
          requested_at: new Date().toISOString(),
          safety_class: "read_only",
        },
        query: "memo_graph_installation_probe",
        limit: 1,
        include_sensitive: false,
      },
    });
    const readStatus = (read.structuredContent as { status?: unknown } | undefined)
      ?.status;
    if (readStatus !== "OK" && readStatus !== "NO_MATCH") {
      throw new Error("MCP_READ_PROBE_FAILED");
    }
    return { readStatus, toolNames };
  } catch (error) {
    await client.close().catch(() => undefined);
    const startedInstance = startedProbeInstance(diagnostics);
    if (startedInstance !== null) {
      await stopStartedProbeWorkbench(registration, diagnostics);
    } else if (
      allowUpgradeRestart &&
      diagnosticsContain(
        diagnostics,
        "startup_failed",
        "WORKBENCH_HTTP_UNAVAILABLE",
      ) &&
      await restartIncompatibleWorkbench(registration)
    ) {
      return probeRegistration(registration, false);
    }
    throw error;
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  if (process.versions.node.split(".")[0] !== "24") {
    throw new Error("UNSUPPORTED_NODE_VERSION");
  }
  const arguments_ = parseArguments(process.argv.slice(2));
  assertSafeInstallLayout(arguments_);
  const configurationCreated = ensurePrivateConfiguration(arguments_);
  for (const path of [arguments_.nodeExecutable]) {
    if (!existsSync(path)) {
      throw new Error("INSTALL_PREREQUISITE_MISSING");
    }
  }
  const codexBinary = findCodexBinary(arguments_.codexBinary);
  const deployedNode = deployNodeRuntime(
    arguments_.nodeExecutable,
    arguments_.installRoot,
  );
  const entry = deployPackage(workspaceRoot(), arguments_.installRoot);
  const hookEntry = join(dirname(entry), "hook-command.js");
  if (!existsSync(hookEntry)) {
    throw new Error("DEPLOYED_HOOK_MISSING");
  }
  const registration = buildCodexRegistration({
    nodeExecutable: deployedNode,
    entryPath: realpathSync(entry),
    mcpConfigPath: realpathSync(arguments_.mcpConfigPath),
    operatorConfigPath: realpathSync(arguments_.operatorConfigPath),
    runtimeDirectory: arguments_.runtimeDirectory,
  });
  const installed = registerCodex(
    codexBinary,
    registration,
    arguments_.installRoot,
  );
  try {
    const probe = await probeRegistration(registration);
    const workbenchConfig = workbenchRuntimeConfig(
      loadOperatorConfig(arguments_.operatorConfigPath),
    );
    const hookPaths = workbenchArtifactPaths({
      runtimeDirectory: arguments_.runtimeDirectory,
      rootIdentity: memoryRuntimeRootIdentity(workbenchConfig.data_root),
      configIdentity: memoryRuntimeConfigIdentity(workbenchConfig),
    });
    const hookCommand = buildManagedHookCommand({
      nodeExecutable: deployedNode,
      hookEntryPath: realpathSync(hookEntry),
      descriptorPath: hookPaths.hookDescriptorPath,
      spoolDirectory: arguments_.hookSpoolDirectory,
    });
    const hookInstallation = installCodexHookConfiguration({
      hooksJsonPath: arguments_.hooksJsonPath,
      codexConfigPath: arguments_.codexConfigPath,
      backupRoot: join(arguments_.installRoot, "hook-backups"),
      command: hookCommand,
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          schema_version: "1.0.0",
          status: "installed",
          registration: registration.name,
          release_entry: registration.args[0],
          node_executable: registration.command,
          registration_backup: installed.backupPath,
          configuration_created: configurationCreated,
          tool_count: probe.toolNames.length,
          read_status: probe.readStatus,
          hooks_representation: hookInstallation.representation,
          hooks_backup: hookInstallation.backupDirectory,
          hooks_concurrent_sources_detected:
            hookInstallation.concurrentSourcesDetected,
          hooks_trust_review_required:
            hookInstallation.trustReviewRequired,
          restart_required: true,
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    rollbackCodex(codexBinary, registration, installed.previous);
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : "INSTALL_FAILED";
    process.stderr.write(
      `${JSON.stringify({
        component: "memo-graph-codex-installer",
        event: "install_failed",
        code: /^[A-Z0-9_]+$/u.test(message) ? message : "INSTALL_FAILED",
      })}\n`,
    );
    process.exitCode = 1;
  }
}
