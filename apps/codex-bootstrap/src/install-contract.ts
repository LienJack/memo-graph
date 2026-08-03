import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const CORE_MEMORY_TOOLS = [
  "memory_search",
  "memory_context_compile",
  "memory_evidence_ingest",
  "memory_episode_commit",
  "memory_propose",
] as const;

export type BootstrapPaths = {
  codexConfigPath: string;
  hooksJsonPath: string;
  hookSpoolDirectory: string;
  dataRoot: string;
  installRoot: string;
  mcpConfigPath: string;
  operatorConfigPath: string;
  recoveryAuthorityRoot: string;
  runtimeDirectory: string;
};

type PortableEnvironment = Partial<
  Record<"XDG_CONFIG_HOME" | "XDG_DATA_HOME" | "XDG_STATE_HOME", string>
>;

function directory(
  value: string | undefined,
  fallback: string,
): string {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }
  if (!isAbsolute(value)) {
    throw new Error("PORTABLE_DIRECTORY_NOT_ABSOLUTE");
  }
  return value;
}

export function resolveBootstrapPaths(input: {
  env?: PortableEnvironment;
  homeDirectory?: string;
} = {}): BootstrapPaths {
  const homeDirectory = input.homeDirectory ?? homedir();
  if (!isAbsolute(homeDirectory)) {
    throw new Error("HOME_DIRECTORY_NOT_ABSOLUTE");
  }
  const env = input.env ?? process.env;
  const configHome = directory(
    env.XDG_CONFIG_HOME,
    join(homeDirectory, ".config"),
  );
  const dataHome = directory(
    env.XDG_DATA_HOME,
    join(homeDirectory, ".local", "share"),
  );
  const stateHome = directory(
    env.XDG_STATE_HOME,
    join(homeDirectory, ".local", "state"),
  );
  return {
    codexConfigPath: join(homeDirectory, ".codex", "config.toml"),
    hooksJsonPath: join(homeDirectory, ".codex", "hooks.json"),
    hookSpoolDirectory: join(stateHome, "memo-graph", "hook-spool"),
    dataRoot: join(dataHome, "memo-graph", "data"),
    installRoot: join(dataHome, "memo-graph", "codex-bootstrap"),
    mcpConfigPath: join(configHome, "memo-graph", "mcp.json"),
    operatorConfigPath: join(configHome, "memo-graph", "operator.json"),
    recoveryAuthorityRoot: join(
      dataHome,
      "memo-graph",
      "recovery-authority",
    ),
    runtimeDirectory: join(
      stateHome,
      "memo-graph",
      "workbench-runtime",
    ),
  };
}

export function buildDefaultConfigDocuments(input: {
  authorityKeyId: string;
  dataRoot: string;
  privateKeyPath: string;
  publicKeyPath: string;
  recoveryDirectory: string;
}): {
  mcp: Record<string, unknown>;
  operator: Record<string, unknown>;
} {
  for (const value of [
    input.dataRoot,
    input.privateKeyPath,
    input.publicKeyPath,
    input.recoveryDirectory,
  ]) {
    if (!isAbsolute(value)) {
      throw new Error("DEFAULT_CONFIGURATION_PATH_NOT_ABSOLUTE");
    }
  }
  const recovery = {
    enabled: true,
    directory: input.recoveryDirectory,
    authority_key_id: input.authorityKeyId,
    trust_root_version: 1,
    private_key_path: input.privateKeyPath,
    public_key_path: input.publicKeyPath,
  };
  const automaticMemory = {
    mode: "observe",
    provider: {
      enabled: true,
      kind: "openai_responses",
      model: "gpt-5.6-luna",
      api_key_env: "OPENAI_API_KEY",
      endpoint: "https://api.openai.com/v1/responses",
      timeout_ms: 20_000,
    },
    sensitive_identifiers: [],
  };
  const workbench = {
    allowed_scopes: [{ kind: "workspace", id: "workspace_local" }],
    allowed_authorities: [
      "user_stated",
      "observed",
      "tool_result",
      "inferred",
      "derived",
      "imported",
    ],
    destructive_tools_enabled: false,
    automatic_memory: automaticMemory,
  };
  return {
    mcp: {
      data_root: input.dataRoot,
      principal_id: "user_local",
      allowed_scopes: [{ kind: "workspace", id: "workspace_local" }],
      allowed_authorities: [
        "user_stated",
        "observed",
        "tool_result",
        "inferred",
        "derived",
        "imported",
      ],
      destructive_tools_enabled: false,
      recovery_head: recovery,
      automatic_memory: automaticMemory,
    },
    operator: {
      data_root: input.dataRoot,
      principal_id: "user_local",
      workbench,
      recovery: {
        backup_bundles: {},
        restore_targets: {},
        authority: {
          directory: input.recoveryDirectory,
          authority_key_id: input.authorityKeyId,
          trust_root_version: 1,
          private_key_path: input.privateKeyPath,
          public_key_path: input.publicKeyPath,
        },
      },
    },
  };
}

export type CodexRegistration = {
  name: "memo_graph_memory";
  command: string;
  args: string[];
};

export function buildCodexRegistration(input: {
  nodeExecutable: string;
  entryPath: string;
  mcpConfigPath: string;
  operatorConfigPath: string;
  runtimeDirectory: string;
}): CodexRegistration {
  for (const value of Object.values(input)) {
    if (!isAbsolute(value)) {
      throw new Error("CODEX_REGISTRATION_PATH_NOT_ABSOLUTE");
    }
  }
  return {
    name: "memo_graph_memory",
    command: input.nodeExecutable,
    args: [
      input.entryPath,
      "--mcp-config",
      input.mcpConfigPath,
      "--operator-config",
      input.operatorConfigPath,
      "--runtime-dir",
      input.runtimeDirectory,
    ],
  };
}

export function assertCoreMemoryTools(toolNames: readonly string[]): void {
  const available = new Set(toolNames);
  if (CORE_MEMORY_TOOLS.some((tool) => !available.has(tool))) {
    throw new Error("MCP_TOOL_REGISTRATION_INCOMPLETE");
  }
}
