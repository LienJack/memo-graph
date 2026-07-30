#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import {
  OperationalStatusSchema,
  canonicalJson,
  canonicalSha256Omitting,
  type OperationalExitClass,
  type OperationalStatus,
} from "@memo-graph/contracts";
import { blockedOperationalStatus } from "@memo-graph/storage-sqlite";

import { runDoctor } from "./commands/doctor.js";
import { inspectBackup } from "./commands/backup.js";
import {
  inspectKeys,
  keyRotationDryRun,
  renderKeyInventory,
} from "./commands/key.js";
import { secretAdmissionDryRun } from "./commands/secret.js";
import { restoreDryRun } from "./commands/restore.js";
import {
  OperatorConfigError,
  loadOperatorConfig,
} from "./config.js";
import { operatorExitCode } from "./exit-codes.js";
import {
  renderOperationalStatus,
  type OperatorOutputFormat,
} from "./render.js";

type OperatorIo = {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
};

function argumentValue(argv: readonly string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  const value = index === -1 ? undefined : argv[index + 1];
  return value === undefined || value.trim().length === 0 ? null : value;
}

function argumentCount(argv: readonly string[], flag: string): number {
  return argv.filter((argument) => argument === flag).length;
}

type ParsedArguments =
  | {
      command: "doctor";
      configPath: string;
      format: OperatorOutputFormat;
    }
  | {
      command: "key_inspect";
      configPath: string;
      format: OperatorOutputFormat;
    }
  | {
      command: "key_rotate_dry_run";
      configPath: string;
      format: OperatorOutputFormat;
    }
  | {
      command: "secret_admit_dry_run";
      configPath: string;
      format: OperatorOutputFormat;
      inputDescriptor: number;
    }
  | {
      command: "backup_inspect";
      configPath: string;
      format: OperatorOutputFormat;
      backupRef: string;
    }
  | {
      command: "restore_dry_run";
      configPath: string;
      format: OperatorOutputFormat;
      backupRef: string;
      targetRef: string;
    };

function parseArguments(argv: readonly string[]): ParsedArguments {
  const commandLength =
    argv[0] === "doctor"
      ? 1
      : argv[0] === "key" &&
          (argv[1] === "inspect" || argv[1] === "rotate")
        ? 2
        : argv[0] === "backup" && argv[1] === "inspect"
          ? 2
          : argv[0] === "restore"
            ? 1
        : argv[0] === "secret" && argv[1] === "admit"
          ? 2
          : 0;
  if (
    commandLength === 0 ||
    argv.filter((argument) => argument === "--config").length !== 1 ||
    argv.filter((argument) => argument === "--format").length > 1 ||
    argv.some((argument) => argument === "--yes")
  ) {
    throw new OperatorConfigError();
  }
  const consumed = new Set<number>(
    Array.from({ length: commandLength }, (_, index) => index),
  );
  for (let index = commandLength; index < argv.length; index += 1) {
    const argument = argv[index];
    if (
      argument === "--config" ||
      argument === "--format" ||
      argument === "--input-fd"
      || argument === "--backup-ref"
      || argument === "--target-ref"
    ) {
      consumed.add(index);
      if (argv[index + 1] !== undefined) {
        consumed.add(index + 1);
        index += 1;
      }
      continue;
    }
    if (argument === "--dry-run") {
      consumed.add(index);
    }
  }
  if (consumed.size !== argv.length) {
    throw new OperatorConfigError();
  }
  const configPath = argumentValue(argv, "--config");
  const format = argumentValue(argv, "--format") ?? "human";
  if (
    configPath === null ||
    (format !== "human" && format !== "json")
  ) {
    throw new OperatorConfigError();
  }
  if (argv[0] === "doctor") {
    if (
      argv.includes("--dry-run") ||
      argv.includes("--input-fd") ||
      argv.includes("--backup-ref") ||
      argv.includes("--target-ref")
    ) {
      throw new OperatorConfigError();
    }
    return { command: "doctor", configPath, format };
  }
  if (argv[0] === "backup" && argv[1] === "inspect") {
    const backupRef = argumentValue(argv, "--backup-ref");
    if (
      backupRef === null ||
      argumentCount(argv, "--backup-ref") !== 1 ||
      argv.includes("--dry-run") ||
      argv.includes("--input-fd") ||
      argv.includes("--target-ref")
    ) {
      throw new OperatorConfigError();
    }
    return {
      command: "backup_inspect",
      configPath,
      format,
      backupRef,
    };
  }
  if (argv[0] === "restore") {
    const backupRef = argumentValue(argv, "--backup-ref");
    const targetRef = argumentValue(argv, "--target-ref");
    if (
      backupRef === null ||
      targetRef === null ||
      argumentCount(argv, "--backup-ref") !== 1 ||
      argumentCount(argv, "--target-ref") !== 1 ||
      argv.filter((argument) => argument === "--dry-run").length !== 1 ||
      argv.includes("--input-fd")
    ) {
      throw new OperatorConfigError();
    }
    return {
      command: "restore_dry_run",
      configPath,
      format,
      backupRef,
      targetRef,
    };
  }
  if (argv[0] === "key" && argv[1] === "inspect") {
    if (
      argv.includes("--dry-run") ||
      argv.includes("--input-fd") ||
      argv.includes("--backup-ref") ||
      argv.includes("--target-ref")
    ) {
      throw new OperatorConfigError();
    }
    return { command: "key_inspect", configPath, format };
  }
  if (argv[0] === "key" && argv[1] === "rotate") {
    if (
      argv.filter((argument) => argument === "--dry-run").length !== 1 ||
      argv.includes("--input-fd") ||
      argv.includes("--backup-ref") ||
      argv.includes("--target-ref")
    ) {
      throw new OperatorConfigError();
    }
    return { command: "key_rotate_dry_run", configPath, format };
  }
  const descriptorText = argumentValue(argv, "--input-fd");
  const inputDescriptor = Number(descriptorText);
  if (
    argv.filter((argument) => argument === "--dry-run").length !== 1 ||
    argv.filter((argument) => argument === "--input-fd").length !== 1 ||
    !Number.isSafeInteger(inputDescriptor) ||
    inputDescriptor < 3 ||
    argv.includes("--backup-ref") ||
    argv.includes("--target-ref")
  ) {
    throw new OperatorConfigError();
  }
  return {
    command: "secret_admit_dry_run",
    configPath,
    format,
    inputDescriptor,
  };
}

function replaceExitClass(
  status: OperationalStatus,
  exitClass: OperationalExitClass,
): OperationalStatus {
  const next = {
    ...status,
    exit_class: exitClass,
    status_digest: status.status_digest,
  };
  return OperationalStatusSchema.parse({
    ...next,
    status_digest: canonicalSha256Omitting(next, ["status_digest"]),
  });
}

export async function runOperatorCli(
  argv = process.argv.slice(2),
  io: OperatorIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  let format: OperatorOutputFormat = "json";
  try {
    const arguments_ = parseArguments(argv);
    format = arguments_.format;
    const config = loadOperatorConfig(arguments_.configPath);
    switch (arguments_.command) {
      case "doctor": {
        const status = await runDoctor({
          dataRoot: config.data_root,
          qualification: config.qualification,
        });
        io.stdout.write(renderOperationalStatus(status, format));
        return operatorExitCode(status.exit_class);
      }
      case "key_inspect": {
        io.stdout.write(
          renderKeyInventory(
            await inspectKeys(config.data_root),
            format,
          ),
        );
        return operatorExitCode("success");
      }
      case "key_rotate_dry_run":
        io.stdout.write(`${canonicalJson(keyRotationDryRun())}\n`);
        return operatorExitCode("operator_action_required");
      case "secret_admit_dry_run":
        void arguments_.inputDescriptor;
        io.stdout.write(`${canonicalJson(secretAdmissionDryRun())}\n`);
        return operatorExitCode("operator_action_required");
      case "backup_inspect": {
        const backupBundles = config.recovery
          .backup_bundles as Record<string, string>;
        const directory = backupBundles[arguments_.backupRef];
        if (directory === undefined) {
          throw new OperatorConfigError();
        }
        io.stdout.write(`${canonicalJson(inspectBackup(directory))}\n`);
        return operatorExitCode("success");
      }
      case "restore_dry_run": {
        const backupBundles = config.recovery
          .backup_bundles as Record<string, string>;
        const restoreTargets = config.recovery
          .restore_targets as Record<string, string>;
        const directory = backupBundles[arguments_.backupRef];
        if (
          directory === undefined ||
          restoreTargets[arguments_.targetRef] === undefined
        ) {
          throw new OperatorConfigError();
        }
        io.stdout.write(
          `${canonicalJson(
            restoreDryRun({
              backupDirectory: directory,
              backupRef: arguments_.backupRef,
              targetRef: arguments_.targetRef,
            }),
          )}\n`,
        );
        return operatorExitCode("operator_action_required");
      }
    }
  } catch (error) {
    const invalidInput = error instanceof OperatorConfigError;
    const status = replaceExitClass(
      blockedOperationalStatus(error, { invalidConfig: invalidInput }),
      invalidInput ? "invalid_input" : "internal_failure",
    );
    io.stdout.write(renderOperationalStatus(status, format));
    return operatorExitCode(status.exit_class);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runOperatorCli();
}
