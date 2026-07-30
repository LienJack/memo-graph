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
import { testRecoveryHeadProvider } from "../helpers/recovery.js";

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
    expect(operatorExitCode(status.exit_class)).toBe(3);
    expect(status).toMatchObject({
      readiness: "blocked",
      primary_reason: "RECOVERY_AUTHORITY_INVALID",
      next_action: "RECOVER_EXTERNAL_AUTHORITY",
    });
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
    expect(status).toMatchObject({
      readiness: "blocked",
      primary_reason: "RECOVERY_AUTHORITY_INVALID",
    });
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

  it("registers content-free key inspection and disabled rotation/admission dry-runs", async () => {
    const root = temporaryRoot("operator-encryption");
    const dataRoot = join(root, "data");
    const configPath = join(root, "operator.json");
    await initializeDataRoot(dataRoot);
    writeFileSync(
      configPath,
      JSON.stringify({ data_root: dataRoot }),
      { mode: 0o600 },
    );
    const before = durableSnapshot(dataRoot);
    const invoke = async (argv: string[]) => {
      let stdout = "";
      const code = await runOperatorCli(argv, {
        stdout: {
          write: (value) => ((stdout += String(value)), true),
        },
        stderr: { write: () => true },
      });
      return { code, output: JSON.parse(stdout) as Record<string, unknown> };
    };

    expect(
      await invoke([
        "key",
        "inspect",
        "--config",
        configPath,
        "--format",
        "json",
      ]),
    ).toMatchObject({
      code: 0,
      output: {
        keys: [],
        current_key_id: null,
        encrypted_content_count: 0,
      },
    });
    expect(
      await invoke([
        "key",
        "rotate",
        "--dry-run",
        "--config",
        configPath,
        "--format",
        "json",
      ]),
    ).toMatchObject({
      code: 3,
      output: {
        operation: "key.rotate",
        status: "disabled",
        reason_code: "ENCRYPTION_REQUIRED",
      },
    });
    expect(
      await invoke([
        "secret",
        "admit",
        "--input-fd",
        "3",
        "--dry-run",
        "--config",
        configPath,
        "--format",
        "json",
      ]),
    ).toMatchObject({
      code: 3,
      output: {
        operation: "secret.admit",
        status: "disabled",
        reason_code: "ENCRYPTION_REQUIRED",
        ingress: "private_inherited_descriptor",
      },
    });
    expect(durableSnapshot(dataRoot)).toEqual(before);
  });
});

describe("operator CLI backup and restore surface", () => {
  it("inspects a bound bundle without leaking paths and keeps restore publication disabled", async () => {
    const root = temporaryRoot("operator-recovery");
    const dataRoot = join(root, "data");
    const recoveryHeadProvider = testRecoveryHeadProvider(
      "recovery_authority:operator-cli",
    );
    const storage = await SqliteStorageClient.open({
      dataRoot,
      recoveryHeadProvider,
    });
    const backup = await storage.createBackup();
    await storage.close();
    const target = join(root, "restore-target");
    const configPath = join(root, "operator.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        data_root: dataRoot,
        recovery: {
          backup_bundles: {
            current_backup: backup.directory,
          },
          restore_targets: {
            recovery_target: target,
          },
        },
      }),
      { mode: 0o600 },
    );
    const invoke = async (argv: string[]) => {
      let stdout = "";
      const code = await runOperatorCli(argv, {
        stdout: {
          write: (value) => ((stdout += String(value)), true),
        },
        stderr: { write: () => true },
      });
      return {
        code,
        text: stdout,
        output: JSON.parse(stdout) as Record<string, unknown>,
      };
    };

    const inspected = await invoke([
      "backup",
      "inspect",
      "--backup-ref",
      "current_backup",
      "--config",
      configPath,
      "--format",
      "json",
    ]);
    expect(inspected).toMatchObject({
      code: 0,
      output: {
        status: "bundle_verified",
        freshness: "external_head_not_checked",
        backup_id: backup.manifest.backup_id,
        manifest_hash: backup.manifest.manifest_hash,
        artifact_count: 0,
      },
    });
    expect(inspected.text).not.toContain(dataRoot);
    expect(inspected.text).not.toContain(backup.directory);

    const restoreArguments = [
      "restore",
      "--dry-run",
      "--backup-ref",
      "current_backup",
      "--target-ref",
      "recovery_target",
      "--config",
      configPath,
      "--format",
      "json",
    ];
    const firstRestore = await invoke(restoreArguments);
    const secondRestore = await invoke(restoreArguments);
    expect(firstRestore).toMatchObject({
      code: 3,
      output: {
        status: "operator_action_required",
        publication: "disabled_until_u5",
        backup_id: backup.manifest.backup_id,
        manifest_hash: backup.manifest.manifest_hash,
        intent_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      },
    });
    expect(secondRestore.output.intent_digest).toBe(
      firstRestore.output.intent_digest,
    );
    expect(firstRestore.text).not.toContain(dataRoot);
    expect(firstRestore.text).not.toContain(backup.directory);
    expect(firstRestore.text).not.toContain(target);
    expect(existsSync(target)).toBe(false);

    for (const argv of [
      [
        "backup",
        "inspect",
        "--backup-ref",
        "unknown_backup",
        "--config",
        configPath,
        "--format",
        "json",
      ],
      [
        "backup",
        "inspect",
        "--backup-ref",
        "current_backup",
        "--backup-ref",
        "current_backup",
        "--config",
        configPath,
        "--format",
        "json",
      ],
      [
        "restore",
        "--dry-run",
        "--backup-ref",
        "current_backup",
        "--target-ref",
        "unknown_target",
        "--config",
        configPath,
        "--format",
        "json",
      ],
      [
        "restore",
        "--backup-ref",
        "current_backup",
        "--target-ref",
        "recovery_target",
        "--config",
        configPath,
        "--format",
        "json",
      ],
      [
        "backup",
        "inspect",
        "--backup-ref",
        "current_backup",
        "--target-ref",
        "recovery_target",
        "--config",
        configPath,
        "--format",
        "json",
      ],
    ]) {
      const rejected = await invoke(argv);
      expect(rejected.code).toBe(64);
      expect(rejected.output).toMatchObject({
        readiness: "blocked",
        exit_class: "invalid_input",
        primary_reason: "CONFIG_INVALID",
      });
    }

    writeFileSync(
      join(backup.directory, "unbound-extra"),
      "tampered\n",
      { mode: 0o600 },
    );
    const tampered = await invoke([
      "backup",
      "inspect",
      "--backup-ref",
      "current_backup",
      "--config",
      configPath,
      "--format",
      "json",
    ]);
    expect(tampered.code).toBe(70);
    expect(tampered.output).toMatchObject({
      readiness: "blocked",
      exit_class: "internal_failure",
    });
    expect(tampered.text).not.toContain(dataRoot);
    expect(tampered.text).not.toContain(backup.directory);
  });
});
