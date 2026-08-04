import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  WorkbenchLaunchResultSchema,
} from "../../packages/contracts/src/index.js";
import {
  parseOperatorArguments,
  runOperatorCli,
} from "../../apps/operator-cli/src/cli.js";
import {
  loadOperatorConfig,
} from "../../apps/operator-cli/src/config.js";
import {
  workbenchRuntimeConfig,
} from "../../apps/operator-cli/src/commands/workbench.js";

const cleanupPaths: string[] = [];

function fixture() {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "memo-operator-workbench-")),
  );
  cleanupPaths.push(root);
  const configPath = join(root, "operator.json");
  writeFileSync(
    configPath,
    JSON.stringify({ data_root: join(root, "data") }),
    { mode: 0o600 },
  );
  return { root, configPath };
}

function launchResult(
  overrides: Partial<ReturnType<typeof WorkbenchLaunchResultSchema.parse>> = {},
) {
  return WorkbenchLaunchResultSchema.parse({
    schema_version: "1.0.0",
    status: "started",
    instance_id: "workbench:test",
    runtime_state: "ready",
    origin: "http://127.0.0.1:49152",
    browser: "suppressed",
    recovery: "open_launch_url",
    ...overrides,
  });
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path !== undefined) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe("operator workbench command", () => {
  it("parses explicit browser modes and rejects ambiguous duplicates", () => {
    expect(
      parseOperatorArguments([
        "workbench",
        "--config",
        "/tmp/operator.json",
        "--no-open",
      ]),
    ).toMatchObject({
      command: "workbench",
      noOpen: true,
      headless: false,
    });
    expect(
      parseOperatorArguments([
        "workbench",
        "--config",
        "/tmp/operator.json",
        "--headless",
      ]),
    ).toMatchObject({
      command: "workbench",
      noOpen: false,
      headless: true,
    });
    expect(() =>
      parseOperatorArguments([
        "workbench",
        "--config",
        "/tmp/operator.json",
        "--no-open",
        "--headless",
      ]),
    ).toThrow();
    expect(() =>
      parseOperatorArguments([
        "workbench",
        "--config",
        "/tmp/operator.json",
        "--no-open",
        "--no-open",
      ]),
    ).toThrow();
  });

  it("derives a governed Runtime config from backward-compatible defaults", () => {
    const current = fixture();
    const config = loadOperatorConfig(current.configPath);
    const runtime = workbenchRuntimeConfig(config);

    expect(runtime).toMatchObject({
      data_root: join(current.root, "data"),
      principal_id: "user_local",
      allowed_scopes: [
        { kind: "workspace", id: "workspace_local" },
      ],
      destructive_tools_enabled: false,
      graph: { enabled: false },
      vector: { enabled: false },
      recovery_head: { enabled: false },
    });
  });

  it("never emits launch authority in JSON output", async () => {
    const current = fixture();
    const stdout: string[] = [];
    const launcher = vi.fn(async () => ({
      result: launchResult(),
      launchUrl: "http://127.0.0.1:49152/#ticket=secret",
      processId: 12_345,
    }));

    const code = await runOperatorCli(
      [
        "workbench",
        "--config",
        current.configPath,
        "--format",
        "json",
        "--no-open",
      ],
      {
        stdout: {
          write: (value) => {
            stdout.push(String(value));
            return true;
          },
        },
        stderr: { write: () => true },
      },
      { workbenchLauncher: launcher },
    );

    expect(code).toBe(0);
    expect(launcher).toHaveBeenCalledOnce();
    expect(JSON.parse(stdout.join(""))).toEqual(launchResult());
    expect(stdout.join("")).not.toContain("ticket=secret");
  });

  it("reveals a launch URL only on a controlling human TTY", async () => {
    const current = fixture();
    const ttyOutput: string[] = [];
    const launcher = vi.fn(async () => ({
      result: launchResult({
        status: "reused",
        browser: "failed",
      }),
      launchUrl: "http://127.0.0.1:49152/#ticket=secret",
      processId: 12_345,
    }));

    const code = await runOperatorCli(
      ["workbench", "--config", current.configPath],
      {
        stdout: {
          isTTY: true,
          write: (value) => {
            ttyOutput.push(String(value));
            return true;
          },
        },
        stderr: { write: () => true },
      },
      { workbenchLauncher: launcher },
    );

    expect(code).toBe(2);
    expect(ttyOutput.join("")).toContain("url: http://127.0.0.1:49152");
    expect(ttyOutput.join(""))
      .toContain("launch url: http://127.0.0.1:49152/#ticket=secret");

    const redirected: string[] = [];
    await runOperatorCli(
      ["workbench", "--config", current.configPath, "--no-open"],
      {
        stdout: {
          write: (value) => {
            redirected.push(String(value));
            return true;
          },
        },
        stderr: { write: () => true },
      },
      { workbenchLauncher: launcher },
    );
    expect(redirected.join("")).not.toContain("ticket=secret");
  });
});
