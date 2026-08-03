import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CORE_MEMORY_TOOLS,
  assertCoreMemoryTools,
  buildCodexRegistration,
  buildDefaultConfigDocuments,
  resolveBootstrapPaths,
} from "../../apps/codex-bootstrap/src/install-contract.js";
import {
  sanitizePortableDeployment,
  selectCompatibleCodexBinary,
} from "../../apps/codex-bootstrap/src/install.js";
import { workbenchArtifactPaths } from "../../apps/memory-workbench-host/src/index.js";
import { loadOperatorConfig } from "../../apps/operator-cli/src/config.js";
import { workbenchRuntimeConfig } from "../../apps/operator-cli/src/commands/workbench.js";
import {
  memoryRuntimeConfigIdentity,
  memoryRuntimeRootIdentity,
} from "../../packages/runtime-host/src/index.js";
import { mcpRecoveryFixture } from "../helpers/mcp-recovery.js";

const cleanupPaths: string[] = [];
const hostProcesses: number[] = [];
const runtimeDirectories: string[] = [];

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(path)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("INSTALL_TEST_PATH_TIMEOUT");
}

function assertPortableRelease(root: string): void {
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        const target = realpathSync(path);
        const fromRoot = relative(root, target);
        expect(isAbsolute(fromRoot)).toBe(false);
        expect(fromRoot === ".." || fromRoot.startsWith(`..${sep}`)).toBe(
          false,
        );
      } else if (stat.isDirectory()) {
        expect(name).not.toBe(".bin");
        visit(path);
      } else if (/\.(?:js|json|ya?ml)$/u.test(name)) {
        const text = readFileSync(path, "utf8");
        expect(text).not.toContain(process.cwd());
        expect(text).not.toContain("/.staging-");
      }
    }
  };
  visit(root);
}

afterEach(async () => {
  while (runtimeDirectories.length > 0) {
    const runtimeDirectory = runtimeDirectories.pop();
    if (runtimeDirectory === undefined || !existsSync(runtimeDirectory)) {
      continue;
    }
    for (const name of readdirSync(runtimeDirectory)) {
      if (!/^w-.*\.json$/u.test(name)) {
        continue;
      }
      try {
        const endpoint = JSON.parse(
          readFileSync(join(runtimeDirectory, name), "utf8"),
        ) as { process_id?: unknown };
        if (
          typeof endpoint.process_id === "number" &&
          !hostProcesses.includes(endpoint.process_id)
        ) {
          hostProcesses.push(endpoint.process_id);
        }
      } catch {
        // Teardown still handles every already discovered exact owner.
      }
    }
  }
  while (hostProcesses.length > 0) {
    const pid = hostProcesses.pop();
    if (pid === undefined) {
      continue;
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }
    let exited = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 20));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          exited = true;
          break;
        }
        throw error;
      }
    }
    if (!exited) {
      throw new Error("INSTALL_TEST_HOST_DID_NOT_EXIT");
    }
  }
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path !== undefined) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe("Codex bootstrap installation contract", () => {
  it("derives portable defaults from XDG directories without repository paths", () => {
    const home = realpathSync(
      mkdtempSync(join(realpathSync(tmpdir()), "memo-codex-home-")),
    );
    cleanupPaths.push(home);

    expect(
      resolveBootstrapPaths({
        homeDirectory: home,
        env: {
          XDG_CONFIG_HOME: join(home, "portable-config"),
          XDG_DATA_HOME: join(home, "portable-data"),
          XDG_STATE_HOME: join(home, "portable-state"),
        },
      }),
    ).toEqual({
      codexConfigPath: join(home, ".codex", "config.toml"),
      hooksJsonPath: join(home, ".codex", "hooks.json"),
      hookSpoolDirectory: join(
        home,
        "portable-state",
        "memo-graph",
        "hook-spool",
      ),
      dataRoot: join(home, "portable-data", "memo-graph", "data"),
      installRoot: join(home, "portable-data", "memo-graph", "codex-bootstrap"),
      mcpConfigPath: join(home, "portable-config", "memo-graph", "mcp.json"),
      operatorConfigPath: join(
        home,
        "portable-config",
        "memo-graph",
        "operator.json",
      ),
      recoveryAuthorityRoot: join(
        home,
        "portable-data",
        "memo-graph",
        "recovery-authority",
      ),
      runtimeDirectory: join(
        home,
        "portable-state",
        "memo-graph",
        "workbench-runtime",
      ),
    });
  });

  it("builds matching safe defaults with an external recovery authority", () => {
    const documents = buildDefaultConfigDocuments({
      authorityKeyId: "recovery_authority:codex_local",
      dataRoot: "/private/data/memo-graph",
      privateKeyPath: "/private/recovery/private-key.pem",
      publicKeyPath: "/private/recovery/public-key.pem",
      recoveryDirectory: "/private/recovery/head",
    });

    expect(documents.mcp).toMatchObject({
      data_root: "/private/data/memo-graph",
      destructive_tools_enabled: false,
      recovery_head: {
        enabled: true,
        directory: "/private/recovery/head",
      },
      automatic_memory: {
        mode: "observe",
        provider: {
          enabled: true,
          kind: "openai_responses",
          model: "gpt-5.6-luna",
          api_key_env: "OPENAI_API_KEY",
        },
      },
    });
    expect(documents.operator).toMatchObject({
      data_root: "/private/data/memo-graph",
      recovery: {
        authority: { directory: "/private/recovery/head" },
      },
      workbench: {
        automatic_memory: { mode: "observe" },
      },
    });
  });

  it("registers only the deployed entry and explicit private configuration", () => {
    const registration = buildCodexRegistration({
      nodeExecutable: "/opt/node24/bin/node",
      entryPath: "/opt/memo-graph/releases/release-a/dist/cli.js",
      mcpConfigPath: "/private/config/mcp.json",
      operatorConfigPath: "/private/config/operator.json",
      runtimeDirectory: "/private/state/workbench-runtime",
    });

    expect(registration).toEqual({
      name: "memo_graph_memory",
      command: "/opt/node24/bin/node",
      args: [
        "/opt/memo-graph/releases/release-a/dist/cli.js",
        "--mcp-config",
        "/private/config/mcp.json",
        "--operator-config",
        "/private/config/operator.json",
        "--runtime-dir",
        "/private/state/workbench-runtime",
      ],
    });
  });

  it("rejects a registration handshake that omits any core memory tool", () => {
    expect(() => assertCoreMemoryTools([...CORE_MEMORY_TOOLS])).not.toThrow();
    expect(() =>
      assertCoreMemoryTools(
        CORE_MEMORY_TOOLS.filter((tool) => tool !== "memory_search"),
      ),
    ).toThrow("MCP_TOOL_REGISTRATION_INCOMPLETE");
  });

  it("removes pnpm launchers and metadata that bind a release to staging", () => {
    const root = realpathSync(
      mkdtempSync(join(realpathSync(tmpdir()), "memo-codex-sanitize-")),
    );
    cleanupPaths.push(root);
    const bin = join(root, "node_modules", ".bin");
    const nestedBin = join(root, "node_modules", "package", ".bin");
    mkdirSync(bin, { recursive: true });
    mkdirSync(nestedBin, { recursive: true });
    writeFileSync(join(bin, "memo-tool"), `NODE_PATH=${root}/.staging-random\n`);
    writeFileSync(join(nestedBin, "nested-tool"), "generated launcher\n");
    writeFileSync(join(root, "node_modules", ".modules.yaml"), "virtualStoreDir: staging\n");
    writeFileSync(join(root, "dist.js"), "export {};\n");

    sanitizePortableDeployment(root);

    expect(existsSync(bin)).toBe(false);
    expect(existsSync(nestedBin)).toBe(false);
    expect(existsSync(join(root, "node_modules", ".modules.yaml"))).toBe(false);
    expect(existsSync(join(root, "dist.js"))).toBe(true);
  });

  it("skips an installed Codex binary that cannot read the current config", () => {
    const root = realpathSync(
      mkdtempSync(join(realpathSync(tmpdir()), "memo-codex-selection-")),
    );
    cleanupPaths.push(root);
    const incompatible = join(root, "incompatible-codex.mjs");
    const compatible = join(root, "compatible-codex.mjs");
    writeFileSync(
      incompatible,
      `#!${process.execPath}\nprocess.exitCode = 1;\n`,
      { mode: 0o700 },
    );
    writeFileSync(
      compatible,
      `#!${process.execPath}\nprocess.stdout.write("[]");\n`,
      { mode: 0o700 },
    );

    expect(
      selectCompatibleCodexBinary([incompatible, compatible]),
    ).toBe(realpathSync(compatible));
    expect(() =>
      selectCompatibleCodexBinary([incompatible]),
    ).toThrow("CODEX_BINARY_INCOMPATIBLE");
  });

  it("restores the previous Codex registration when the final probe fails", () => {
    const root = realpathSync(
      mkdtempSync(join(realpathSync(tmpdir()), "memo-codex-rollback-")),
    );
    cleanupPaths.push(root);
    const dataRoot = join(root, "data");
    const recovery = mcpRecoveryFixture(dataRoot).config;
    const mcpConfigPath = join(root, "mcp.json");
    const operatorConfigPath = join(root, "operator.json");
    writeFileSync(
      mcpConfigPath,
      JSON.stringify({
        data_root: dataRoot,
        principal_id: "user_local",
        allowed_scopes: [{ kind: "workspace", id: "workspace_local" }],
        allowed_authorities: [
          "tool_result",
        ],
        recovery_head: recovery,
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      operatorConfigPath,
      JSON.stringify({
        data_root: dataRoot,
        workbench: {
          allowed_scopes: [
            { kind: "workspace", id: "workspace_local" },
          ],
          allowed_authorities: ["tool_result"],
          destructive_tools_enabled: false,
        },
        recovery: {
          backup_bundles: {},
          restore_targets: {},
          authority: {
            directory: recovery.directory,
            authority_key_id: recovery.authority_key_id,
            trust_root_version: recovery.trust_root_version,
            private_key_path: recovery.private_key_path,
            public_key_path: recovery.public_key_path,
          },
        },
      }),
      { mode: 0o600 },
    );
    const codexLog = join(root, "codex.log");
    const fakeCodex = join(root, "fake-codex.mjs");
    writeFileSync(
      fakeCodex,
      `#!${process.execPath}\n` +
        `import { appendFileSync } from "node:fs";\n` +
        `const args = process.argv.slice(2);\n` +
        `appendFileSync(${JSON.stringify(codexLog)}, JSON.stringify(args) + "\\n");\n` +
        `if (args[0] === "mcp" && args[1] === "get") {\n` +
        `  process.stdout.write(JSON.stringify({name:"memo_graph_memory",enabled:true,transport:{type:"stdio",command:${JSON.stringify(process.execPath)},args:["/previous/mcp.js"]},enabled_tools:null,disabled_tools:null,startup_timeout_sec:null,tool_timeout_sec:null}));\n` +
        `}\n`,
      { mode: 0o700 },
    );
    chmodSync(fakeCodex, 0o700);

    const runtimeDirectory = join(root, "workbench-runtime");
    const hookSpoolDirectory = join(root, "hook-spool");
    const hooksJsonPath = join(root, ".codex", "hooks.json");
    const codexConfigPath = join(root, ".codex", "config.toml");
    runtimeDirectories.push(runtimeDirectory);
    const installed = spawnSync(
      process.execPath,
      [
        join(process.cwd(), "apps", "codex-bootstrap", "dist", "install.js"),
        "--codex-bin",
        fakeCodex,
        "--data-root",
        dataRoot,
        "--install-root",
        join(root, "codex-bootstrap"),
        "--mcp-config",
        mcpConfigPath,
        "--node",
        process.execPath,
        "--operator-config",
        operatorConfigPath,
        "--recovery-authority-root",
        join(root, "recovery-authority"),
        "--runtime-dir",
        runtimeDirectory,
        "--hook-spool",
        hookSpoolDirectory,
        "--hooks-json",
        hooksJsonPath,
        "--codex-config",
        codexConfigPath,
      ],
      { cwd: process.cwd(), encoding: "utf8", env: process.env },
    );

    expect(installed.status).toBe(1);
    const calls = readFileSync(codexLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(calls.map((call) => call.slice(0, 3))).toEqual([
      ["mcp", "list", "--json"],
      ["mcp", "get", "memo_graph_memory"],
      ["mcp", "remove", "memo_graph_memory"],
      ["mcp", "add", "memo_graph_memory"],
      ["mcp", "remove", "memo_graph_memory"],
      ["mcp", "add", "memo_graph_memory"],
    ]);
    expect(calls.at(-1)).toContain("/previous/mcp.js");
    expect(
      existsSync(runtimeDirectory)
        ? readdirSync(runtimeDirectory).filter((name) =>
            /^w-.*\.json$/u.test(name),
          )
        : [],
    ).toEqual([]);
  }, 30_000);

  it("restarts an exact owned incompatible Workbench during upgrade", async () => {
    const root = realpathSync(
      mkdtempSync(join(realpathSync(tmpdir()), "memo-codex-upgrade-")),
    );
    cleanupPaths.push(root);
    const dataRoot = join(root, "data");
    const recovery = mcpRecoveryFixture(dataRoot).config;
    const mcpConfigPath = join(root, "mcp.json");
    const operatorConfigPath = join(root, "operator.json");
    const allowedAuthorities = [
      "user_stated",
      "observed",
      "tool_result",
      "inferred",
      "derived",
      "imported",
    ];
    writeFileSync(
      mcpConfigPath,
      JSON.stringify({
        data_root: dataRoot,
        principal_id: "user_local",
        allowed_scopes: [{ kind: "workspace", id: "workspace_local" }],
        allowed_authorities: allowedAuthorities,
        destructive_tools_enabled: false,
        recovery_head: recovery,
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      operatorConfigPath,
      JSON.stringify({
        data_root: dataRoot,
        principal_id: "user_local",
        workbench: {
          allowed_scopes: [
            { kind: "workspace", id: "workspace_local" },
          ],
          allowed_authorities: allowedAuthorities,
          destructive_tools_enabled: false,
        },
        recovery: {
          backup_bundles: {},
          restore_targets: {},
          authority: {
            directory: recovery.directory,
            authority_key_id: recovery.authority_key_id,
            trust_root_version: recovery.trust_root_version,
            private_key_path: recovery.private_key_path,
            public_key_path: recovery.public_key_path,
          },
        },
      }),
      { mode: 0o600 },
    );
    const runtimeDirectory = join(root, "workbench-runtime");
    const hookSpoolDirectory = join(root, "hook-spool");
    const hooksJsonPath = join(root, ".codex", "hooks.json");
    const codexConfigPath = join(root, ".codex", "config.toml");
    runtimeDirectories.push(runtimeDirectory);
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
    const oldHostEntry = join(root, "old-workbench-host.mjs");
    writeFileSync(
      oldHostEntry,
      `import { createServer } from "node:http";\n` +
      `import { unlinkSync, writeFileSync } from "node:fs";\n` +
        `const [endpointPath, credentialPath, descriptorPath, rootIdentityJson, configIdentity] = process.argv.slice(2);\n` +
        `writeFileSync(credentialPath, "A".repeat(43), { mode: 0o600 });\n` +
        `const server = createServer((_request, response) => { response.writeHead(400, { "content-length": "0" }); response.end(); });\n` +
        `server.listen(0, "127.0.0.1", () => {\n` +
        `  const address = server.address();\n` +
        `  const now = new Date().toISOString();\n` +
        `  writeFileSync(endpointPath, JSON.stringify({schema_version:"1.0.0",instance_id:"workbench:old-contract",root_identity:JSON.parse(rootIdentityJson),config_identity:configIdentity,runtime_state:"ready",origin:"http://127.0.0.1:" + address.port,port:address.port,process_id:process.pid,control_credential_path:credentialPath,runtime_descriptor_path:descriptorPath,created_at:now,ready_at:now}), { mode: 0o600 });\n` +
        `});\n` +
        `process.once("SIGTERM", () => server.close(() => { unlinkSync(endpointPath); unlinkSync(credentialPath); process.exit(0); }));\n`,
      { mode: 0o700 },
    );
    const oldHost = spawn(
      process.execPath,
      [
        oldHostEntry,
        paths.endpointPath,
        paths.controlCredentialPath,
        paths.runtimeDescriptorPath,
        JSON.stringify(rootIdentity),
        configIdentity,
      ],
      { stdio: "ignore" },
    );
    expect(oldHost.pid).toBeTypeOf("number");
    hostProcesses.push(oldHost.pid ?? -1);
    await waitForPath(paths.endpointPath);

    const fakeCodex = join(root, "fake-codex.mjs");
    writeFileSync(
      fakeCodex,
      `#!${process.execPath}\n` +
        `const args = process.argv.slice(2);\n` +
        `if (args[0] === "mcp" && args[1] === "get") process.exitCode = 1;\n`,
      { mode: 0o700 },
    );
    const installed = spawnSync(
      process.execPath,
      [
        join(process.cwd(), "apps", "codex-bootstrap", "dist", "install.js"),
        "--codex-bin",
        fakeCodex,
        "--data-root",
        dataRoot,
        "--install-root",
        join(root, "codex-bootstrap"),
        "--mcp-config",
        mcpConfigPath,
        "--node",
        process.execPath,
        "--operator-config",
        operatorConfigPath,
        "--recovery-authority-root",
        join(root, "recovery-authority"),
        "--runtime-dir",
        runtimeDirectory,
        "--hook-spool",
        hookSpoolDirectory,
        "--hooks-json",
        hooksJsonPath,
        "--codex-config",
        codexConfigPath,
      ],
      { cwd: process.cwd(), encoding: "utf8", env: process.env },
    );

    expect(installed.status, installed.stderr).toBe(0);
    if (oldHost.exitCode === null) {
      await new Promise<void>((resolve) => oldHost.once("exit", () => resolve()));
    }
    expect(oldHost.exitCode).toBe(0);
    const endpoint = JSON.parse(
      readFileSync(paths.endpointPath, "utf8"),
    ) as { instance_id: string; process_id: number };
    expect(endpoint.instance_id).not.toBe("workbench:old-contract");
    hostProcesses.push(endpoint.process_id);
  }, 30_000);

  it("executes a clean one-command install with private defaults and a read probe", () => {
    const root = realpathSync(
      mkdtempSync(join(realpathSync(tmpdir()), "memo-codex-clean-install-")),
    );
    cleanupPaths.push(root);
    const fakeCodex = join(
      process.cwd(),
      "tests",
      "fixtures",
      "fake-codex-cli.mjs",
    );
    const configRoot = join(root, "config");
    const dataRoot = join(root, "data");
    const installRoot = join(root, "codex-bootstrap");
    const mcpConfigPath = join(configRoot, "mcp.json");
    const operatorConfigPath = join(configRoot, "operator.json");
    const recoveryRoot = join(root, "recovery-authority");
    const runtimeDirectory = join(root, "workbench-runtime");
    const hookSpoolDirectory = join(root, "hook-spool");
    const hooksJsonPath = join(root, ".codex", "hooks.json");
    const codexConfigPath = join(root, ".codex", "config.toml");
    runtimeDirectories.push(runtimeDirectory);
    const installed = spawnSync(
      process.execPath,
      [
        join(process.cwd(), "apps", "codex-bootstrap", "dist", "install.js"),
        "--codex-bin",
        fakeCodex,
        "--data-root",
        dataRoot,
        "--install-root",
        installRoot,
        "--mcp-config",
        mcpConfigPath,
        "--node",
        process.execPath,
        "--operator-config",
        operatorConfigPath,
        "--recovery-authority-root",
        recoveryRoot,
        "--runtime-dir",
        runtimeDirectory,
        "--hook-spool",
        hookSpoolDirectory,
        "--hooks-json",
        hooksJsonPath,
        "--codex-config",
        codexConfigPath,
      ],
      { cwd: process.cwd(), encoding: "utf8", env: process.env },
    );
    expect(installed.status, installed.stderr).toBe(0);
    const result = JSON.parse(installed.stdout) as {
      node_executable: string;
      release_entry: string;
    };
    expect(result).toMatchObject({
      status: "installed",
      configuration_created: true,
      tool_count: 19,
      read_status: "NO_MATCH",
    });
    expect(result.node_executable.startsWith(`${realpathSync(installRoot)}${sep}`))
      .toBe(true);
    expect(result.node_executable).not.toBe(realpathSync(process.execPath));
    expect(spawnSync(result.node_executable, ["--version"], {
      encoding: "utf8",
    }).stdout.trim()).toBe("v24.18.0");
    assertPortableRelease(dirname(dirname(result.release_entry)));
    expect(statSync(mcpConfigPath).mode & 0o777).toBe(0o600);
    expect(statSync(operatorConfigPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(recoveryRoot, "private-key.pem")).mode & 0o777).toBe(
      0o600,
    );
    const endpointName = readdirSync(runtimeDirectory).find((name) =>
      /^w-.*\.json$/u.test(name),
    );
    expect(endpointName).toBeTypeOf("string");
    const endpoint = JSON.parse(
      readFileSync(join(runtimeDirectory, endpointName ?? ""), "utf8"),
    ) as { process_id: number; runtime_state: string };
    expect(endpoint.runtime_state).toBe("ready");
    hostProcesses.push(endpoint.process_id);
  }, 30_000);
});
