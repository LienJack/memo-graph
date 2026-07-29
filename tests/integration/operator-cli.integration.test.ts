import {
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  OperationalStatusSchema,
  type OperationalStatus,
} from "../../packages/contracts/src/index.js";
import { runOperatorCli } from "../../apps/operator-cli/src/cli.js";
import { runDoctor } from "../../apps/operator-cli/src/commands/doctor.js";
import { operatorExitCode } from "../../apps/operator-cli/src/exit-codes.js";
import { renderOperationalStatus } from "../../apps/operator-cli/src/render.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";

const cleanupPaths: string[] = [];
const NOW = "2026-07-30T09:00:00.000Z";

function temporaryRoot(prefix: string): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-graph-${prefix}-`)),
  );
  cleanupPaths.push(root);
  return root;
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target !== undefined) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

async function initializeDataRoot(dataRoot: string): Promise<void> {
  const storage = await SqliteStorageClient.open({ dataRoot });
  await storage.close();
}

function durableSnapshot(dataRoot: string): string[] {
  const visit = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return visit(path);
      }
      const stat = statSync(path);
      return [
        `${path.slice(dataRoot.length)}:${stat.size}:${stat.mtimeMs}:${stat.mode & 0o777}`,
      ];
    });
  return visit(dataRoot).sort();
}

describe("operator CLI doctor", () => {
  it("renders JSON and human output from the same parsed status", async () => {
    const dataRoot = join(temporaryRoot("operator-doctor"), "data");
    await initializeDataRoot(dataRoot);
    const before = durableSnapshot(dataRoot);
    const status = await runDoctor(
      {
        dataRoot,
        qualification: {
          status: "pending",
          tested_envelope_digest: null,
        },
      },
      { now: () => NOW },
    );
    const json = JSON.parse(renderOperationalStatus(status, "json")) as unknown;
    expect(OperationalStatusSchema.parse(json)).toEqual(status);
    const human = renderOperationalStatus(status, "human");
    expect(human).toContain(`readiness: ${status.readiness}`);
    expect(human).toContain(
      `qualification: ${status.qualification.status}`,
    );
    expect(operatorExitCode(status.exit_class)).toBe(0);
    expect(durableSnapshot(dataRoot)).toEqual(before);
  });

  it("parses a private config and creates no operator mutation", async () => {
    const root = temporaryRoot("operator-config");
    const dataRoot = join(root, "data");
    const configPath = join(root, "operator.json");
    await initializeDataRoot(dataRoot);
    writeFileSync(
      configPath,
      JSON.stringify({ data_root: dataRoot }),
      { mode: 0o600 },
    );
    let stdout = "";
    let stderr = "";
    const code = await runOperatorCli(
      ["doctor", "--config", configPath, "--format", "json"],
      {
        stdout: { write: (value) => ((stdout += String(value)), true) },
        stderr: { write: (value) => ((stderr += String(value)), true) },
      },
    );
    const status = OperationalStatusSchema.parse(
      JSON.parse(stdout) as unknown,
    );
    expect(code).toBe(operatorExitCode(status.exit_class));
    expect(status.readiness).toBe("ready");
    expect(stderr).toBe("");
  });

  it("fails invalid config before creating a data root and redacts values", async () => {
    const root = temporaryRoot("operator-invalid");
    const marker = "raw-config-marker";
    const dataRoot = join(root, marker);
    const configPath = join(root, "operator.json");
    writeFileSync(
      configPath,
      JSON.stringify({ data_root: dataRoot, unexpected: marker }),
      { mode: 0o600 },
    );
    let stdout = "";
    const code = await runOperatorCli(
      ["doctor", "--config", configPath, "--format", "json"],
      {
        stdout: { write: (value) => ((stdout += String(value)), true) },
        stderr: { write: () => true },
      },
    );
    expect(code).toBe(64);
    expect(existsSync(dataRoot)).toBe(false);
    expect(stdout).not.toContain(marker);
    expect(OperationalStatusSchema.parse(JSON.parse(stdout) as unknown)).toMatchObject({
      readiness: "blocked",
      exit_class: "invalid_input",
      primary_reason: "CONFIG_INVALID",
    } satisfies Partial<OperationalStatus>);
  });
});
