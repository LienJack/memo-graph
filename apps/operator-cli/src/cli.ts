#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import {
  OperationalStatusSchema,
  canonicalSha256Omitting,
  type OperationalExitClass,
  type OperationalStatus,
} from "@memo-graph/contracts";
import { blockedOperationalStatus } from "@memo-graph/storage-sqlite";

import { runDoctor } from "./commands/doctor.js";
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

function parseArguments(argv: readonly string[]): {
  command: "doctor";
  configPath: string;
  format: OperatorOutputFormat;
} {
  if (
    argv.filter((argument) => argument === "doctor").length !== 1 ||
    argv.filter((argument) => argument === "--config").length !== 1 ||
    argv.filter((argument) => argument === "--format").length > 1
  ) {
    throw new OperatorConfigError();
  }
  const consumed = new Set<number>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "doctor") {
      consumed.add(index);
      continue;
    }
    if (argument === "--config" || argument === "--format") {
      consumed.add(index);
      if (argv[index + 1] !== undefined) {
        consumed.add(index + 1);
        index += 1;
      }
    }
  }
  if (consumed.size !== argv.length) {
    throw new OperatorConfigError();
  }
  const configPath = argumentValue(argv, "--config");
  const format = argumentValue(argv, "--format") ?? "human";
  if (
    configPath === null ||
    (format !== "human" && format !== "json") ||
    argv.some((argument) => argument === "--yes")
  ) {
    throw new OperatorConfigError();
  }
  return { command: "doctor", configPath, format };
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
    const status = await runDoctor({
      dataRoot: config.data_root,
      qualification: config.qualification,
    });
    io.stdout.write(renderOperationalStatus(status, format));
    return operatorExitCode(status.exit_class);
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
