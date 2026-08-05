#!/usr/bin/env node

import { closeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import {
  IdentifierSchema,
  OperationIntentSchema,
  OperationalPurgeVerificationSchema,
  OperationalStatusSchema,
  OperatorConfirmationValidationError,
  ScopeSchema,
  canonicalJson,
  canonicalSha256,
  canonicalSha256Omitting,
  scopeKey,
  type OperationalExitClass,
  type OperationalStatus,
  type OperationIntent,
  type RuntimeIdentityProvider,
} from "@memo-graph/contracts";
import {
  blockedOperationalStatus,
  inspectNextRootFenceToken,
  operatorKeyRotationParameters,
  SqliteStorageClient,
} from "@memo-graph/storage-sqlite";
import {
  LearningReleaseInputSchema,
  LearningReleaseManager,
} from "@memo-graph/learning-lab";

import { runDoctor } from "./commands/doctor.js";
import type { WorkbenchLauncher } from "./commands/workbench.js";
import {
  inspectBackup,
  loadBackupResult,
} from "./commands/backup.js";
import {
  inspectKeys,
  keyRotationDryRun,
  renderKeyInventory,
  runConfirmedKeyRotation,
} from "./commands/key.js";
import {
  restoreDryRun,
  runConfirmedRestore,
} from "./commands/restore.js";
import {
  rebuildDryRun,
  runConfirmedCanonicalProjectionRebuild,
  runConfirmedFtsRebuild,
} from "./commands/rebuild.js";
import { runPurgeAudit } from "./commands/purge-audit.js";
import { runConfirmedPurgeRetry } from "./commands/purge-audit.js";
import {
  learningRollbackVerification,
  runConfirmedLearningRollback,
} from "./commands/rollback.js";
import { verifyG6Candidate } from "./commands/g6.js";
import {
  OperatorConfigError,
  loadOperatorGrant,
  loadRecoveryHeadProvider,
  loadOperatorConfig,
  openPrivateOperatorDescriptor,
  readPrivateOperatorJson,
} from "./config.js";
import { OperatorActionLedger } from "./operator-action-ledger.js";
import {
  verifyPinnedOperatorConfirmation,
} from "./confirmation-authority.js";
import {
  loadLearningApprovalRegistries,
} from "./learning-approval-registry.js";
import { operatorExitCode } from "./exit-codes.js";
import {
  scanOperationalArtifactResiduals,
} from "./operational-artifact-scan.js";
import {
  renderOperationalStatus,
  renderWorkbenchLaunch,
  type OperatorOutputFormat,
} from "./render.js";
import { productionRuntimeIdentityProvider } from "./runtime-identity.js";

type OperatorIo = {
  stdout: Pick<NodeJS.WriteStream, "write"> & { isTTY?: boolean };
  stderr: Pick<NodeJS.WriteStream, "write">;
};

type OperatorRuntime = {
  now?: () => string;
  runtimeIdentityProvider?: RuntimeIdentityProvider;
  workbenchLauncher?: WorkbenchLauncher;
  workbenchRuntimeDirectory?: string;
  browserOpener?: (url: string) => Promise<void>;
};

const ExecutePurgePayloadSchema = z
  .object({ purge_job_id: z.string().min(1) })
  .strict();
const ExecuteRebuildPayloadSchema = z
  .object({
    repair_kind: z.enum([
      "fts",
      "layered_projection",
      "sqlite_relations",
    ]),
    principal_id: z.string().min(1).optional(),
    scope: ScopeSchema.optional(),
  })
  .strict();
const ExecuteRestorePayloadSchema = z
  .object({
    backup_ref: IdentifierSchema,
    target_ref: IdentifierSchema,
    required_key_descriptors: z
      .record(IdentifierSchema, z.number().int().min(3))
      .default({}),
  })
  .strict();
const ExecuteKeyRotationPayloadSchema = z
  .object({
    begin: z
      .object({
        rotation_id: z.string().min(1),
        new_key_id: z.string().min(1),
        new_key_generation: z.number().int().positive(),
        new_key_descriptor: z.number().int().min(3),
        new_authority_key_id: z.string().min(1),
        new_authority_descriptor: z.number().int().min(3),
        new_commitment_key_id: z.string().min(1),
        new_commitment_descriptor: z.number().int().min(3),
      })
      .strict(),
    resume: z
      .object({
        old_key_descriptor: z.number().int().min(3),
        new_key_descriptor: z.number().int().min(3),
        old_authority_descriptor: z.number().int().min(3),
        new_commitment_descriptor: z.number().int().min(3),
        max_items: z.number().int().positive().optional(),
      })
      .strict(),
  })
  .strict();

type BoundOperatorExecution =
  | {
      command: "purge_retry";
      payload: z.output<typeof ExecutePurgePayloadSchema>;
    }
  | {
      command: "rebuild_fts";
      payload: z.output<typeof ExecuteRebuildPayloadSchema> & {
        repair_kind: "fts";
        principal_id?: never;
        scope?: never;
      };
    }
  | {
      command: "rebuild_layered_projection";
      payload: z.output<typeof ExecuteRebuildPayloadSchema> & {
        repair_kind: "layered_projection" | "sqlite_relations";
        principal_id: string;
        scope: z.output<typeof ScopeSchema>;
      };
    }
  | {
      command: "restore";
      payload: z.output<typeof ExecuteRestorePayloadSchema>;
    }
  | {
      command: "key_rotate";
      payload: z.output<typeof ExecuteKeyRotationPayloadSchema>;
    }
  | {
      command: "learning_rollback";
      payload: z.output<typeof LearningReleaseInputSchema>;
    };

export function bindOperatorExecutionPayload(input: {
  intent: OperationIntent;
  payload: unknown;
}): BoundOperatorExecution {
  const intent = OperationIntentSchema.parse(input.intent);
  switch (intent.command) {
    case "purge_retry": {
      const payload = ExecutePurgePayloadSchema.parse(input.payload);
      if (
        intent.source_ref !== payload.purge_job_id ||
        intent.target_ref === null ||
        intent.parameters_digest !==
          canonicalSha256({
            purge_job_id: payload.purge_job_id,
            expected_prior_receipt_id: intent.target_ref,
          })
      ) {
        throw new OperatorConfigError();
      }
      return { command: intent.command, payload };
    }
    case "rebuild_fts": {
      const payload = ExecuteRebuildPayloadSchema.parse(input.payload);
      if (
        payload.repair_kind !== "fts" ||
        payload.principal_id !== undefined ||
        payload.scope !== undefined ||
        intent.source_ref !== "canonical_sqlite" ||
        intent.target_ref !== "fts" ||
        intent.parameters_digest !==
          canonicalSha256({
            repair_kind: "fts",
            source: "canonical_sqlite",
            target: "fts",
          })
      ) {
        throw new OperatorConfigError();
      }
      return {
        command: intent.command,
        payload: { repair_kind: "fts" },
      };
    }
    case "rebuild_layered_projection": {
      const payload = ExecuteRebuildPayloadSchema.parse(input.payload);
      if (
        payload.repair_kind === "fts" ||
        payload.principal_id === undefined ||
        payload.scope === undefined ||
        payload.principal_id !== intent.principal_id ||
        intent.source_ref !== "canonical_sqlite" ||
        intent.target_ref !== payload.repair_kind ||
        intent.parameters_digest !==
          canonicalSha256({
            repair_kind: payload.repair_kind,
            source: "canonical_sqlite",
            target: payload.repair_kind,
            principal_id: payload.principal_id,
            scope: payload.scope,
          })
      ) {
        throw new OperatorConfigError();
      }
      return {
        command: intent.command,
        payload: {
          repair_kind: payload.repair_kind,
          principal_id: payload.principal_id,
          scope: payload.scope,
        },
      };
    }
    case "restore": {
      const payload = ExecuteRestorePayloadSchema.parse(input.payload);
      if (
        intent.source_ref !== payload.backup_ref ||
        intent.target_ref !== payload.target_ref
      ) {
        throw new OperatorConfigError();
      }
      return { command: intent.command, payload };
    }
    case "key_rotate": {
      const payload = ExecuteKeyRotationPayloadSchema.parse(input.payload);
      const normalized = {
        begin: payload.begin,
        resume: {
          old_key_descriptor: payload.resume.old_key_descriptor,
          new_key_descriptor: payload.resume.new_key_descriptor,
          old_authority_descriptor:
            payload.resume.old_authority_descriptor,
          new_commitment_descriptor:
            payload.resume.new_commitment_descriptor,
          ...(payload.resume.max_items === undefined
            ? {}
            : { max_items: payload.resume.max_items }),
        },
      };
      const parameters = operatorKeyRotationParameters({
        begin: normalized.begin,
        resume: normalized.resume,
      });
      if (
        intent.source_ref !== payload.begin.rotation_id ||
        intent.target_ref !== payload.begin.new_key_id ||
        intent.parameters_digest !== canonicalSha256(parameters)
      ) {
        throw new OperatorConfigError();
      }
      return { command: intent.command, payload: normalized };
    }
    case "learning_rollback": {
      const payload = LearningReleaseInputSchema.parse(input.payload);
      const normalized = LearningReleaseInputSchema.parse({
        ...payload,
        scopes: [...payload.scopes].sort((left, right) =>
          scopeKey(left).localeCompare(scopeKey(right)),
        ),
      });
      if (
        normalized.action !== "rollback" ||
        normalized.target_release_id === null ||
        normalized.test_failure_point !== undefined ||
        intent.principal_id !== normalized.principal_id ||
        intent.source_ref !== normalized.candidate_id ||
        intent.target_ref !== normalized.target_release_id ||
        intent.parameters_digest !== canonicalSha256(normalized)
      ) {
        throw new OperatorConfigError();
      }
      return { command: intent.command, payload: normalized };
    }
  }
}

function argumentValue(argv: readonly string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  const value = index === -1 ? undefined : argv[index + 1];
  return value === undefined || value.trim().length === 0 ? null : value;
}

function argumentCount(argv: readonly string[], flag: string): number {
  return argv.filter((argument) => argument === flag).length;
}

function hasUnexpectedFlags(
  argv: readonly string[],
  allowed: readonly string[],
): boolean {
  const allow = new Set(allowed);
  return argv.some(
    (argument) =>
      argument.startsWith("--") && !allow.has(argument),
  );
}

function processOwnerIsNotLive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return false;
  } catch (error) {
    return (
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

type ParsedArguments =
  | {
      command: "workbench";
      configPath: string;
      format: OperatorOutputFormat;
      noOpen: boolean;
      headless: boolean;
    }
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
    }
  | {
      command: "rebuild_dry_run";
      configPath: string;
      format: OperatorOutputFormat;
      repairKind: "fts" | "layered_projection" | "sqlite_relations";
    }
  | {
      command: "purge_audit";
      configPath: string;
      format: OperatorOutputFormat;
      auditId: string;
      tombstoneEpoch: number;
    }
  | {
      command: "rollback_verify";
      configPath: string;
      format: OperatorOutputFormat;
      releaseRef: string;
    }
  | {
      command: "g6_verify";
      configPath: string;
      format: OperatorOutputFormat;
      evidenceRef: string;
    }
  | {
      command: "operator_execute";
      configPath: string;
      format: OperatorOutputFormat;
      confirmationRef: string;
    }
  | {
      command: "operator_recover_lock";
      configPath: string;
      format: OperatorOutputFormat;
      confirmationRef: string;
      expectedProcessId: number;
    };

export function parseOperatorArguments(
  argv: readonly string[],
): ParsedArguments {
  const commandLength =
    argv[0] === "workbench"
      ? 1
      : argv[0] === "doctor"
      ? 1
      : argv[0] === "key" &&
          (argv[1] === "inspect" || argv[1] === "rotate")
        ? 2
        : argv[0] === "backup" && argv[1] === "inspect"
          ? 2
        : argv[0] === "restore"
            ? 1
          : argv[0] === "rebuild"
            ? 1
          : argv[0] === "purge" && argv[1] === "audit"
            ? 2
          : argv[0] === "rollback" && argv[1] === "verify"
            ? 2
          : argv[0] === "g6" && argv[1] === "verify"
            ? 2
          : argv[0] === "operator" && argv[1] === "execute"
            ? 2
          : argv[0] === "operator" && argv[1] === "recover-lock"
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
      || argument === "--repair-kind"
      || argument === "--audit-id"
      || argument === "--tombstone-epoch"
      || argument === "--release-ref"
      || argument === "--evidence-ref"
      || argument === "--confirmation-ref"
      || argument === "--process-id"
    ) {
      consumed.add(index);
      if (argv[index + 1] !== undefined) {
        consumed.add(index + 1);
        index += 1;
      }
      continue;
    }
    if (
      argument === "--dry-run" ||
      argument === "--no-open" ||
      argument === "--headless"
    ) {
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
  if (argv[0] === "workbench") {
    const noOpen = argv.includes("--no-open");
    const headless = argv.includes("--headless");
    if (
      argumentCount(argv, "--no-open") > 1 ||
      argumentCount(argv, "--headless") > 1 ||
      (noOpen && headless) ||
      hasUnexpectedFlags(argv, [
        "--config",
        "--format",
        "--no-open",
        "--headless",
      ])
    ) {
      throw new OperatorConfigError();
    }
    return {
      command: "workbench",
      configPath,
      format,
      noOpen,
      headless,
    };
  }
  if (argv[0] === "doctor") {
    if (
      hasUnexpectedFlags(argv, ["--config", "--format"]) ||
      argv.includes("--dry-run") ||
      argv.includes("--input-fd") ||
      argv.includes("--backup-ref") ||
      argv.includes("--target-ref")
    ) {
      throw new OperatorConfigError();
    }
    return { command: "doctor", configPath, format };
  }
  if (argv[0] === "operator" && argv[1] === "execute") {
    const confirmationRef = argumentValue(argv, "--confirmation-ref");
    if (
      confirmationRef === null ||
      argumentCount(argv, "--confirmation-ref") !== 1 ||
      hasUnexpectedFlags(argv, [
        "--config",
        "--format",
        "--confirmation-ref",
      ])
    ) {
      throw new OperatorConfigError();
    }
    return {
      command: "operator_execute",
      configPath,
      format,
      confirmationRef,
    };
  }
  if (argv[0] === "operator" && argv[1] === "recover-lock") {
    const confirmationRef = argumentValue(argv, "--confirmation-ref");
    const expectedProcessId = Number(
      argumentValue(argv, "--process-id"),
    );
    if (
      confirmationRef === null ||
      argumentCount(argv, "--confirmation-ref") !== 1 ||
      argumentCount(argv, "--process-id") !== 1 ||
      !Number.isSafeInteger(expectedProcessId) ||
      expectedProcessId <= 0 ||
      hasUnexpectedFlags(argv, [
        "--config",
        "--format",
        "--confirmation-ref",
        "--process-id",
      ])
    ) {
      throw new OperatorConfigError();
    }
    return {
      command: "operator_recover_lock",
      configPath,
      format,
      confirmationRef,
      expectedProcessId,
    };
  }
  if (argv[0] === "rebuild") {
    const repairKind = argumentValue(argv, "--repair-kind");
    if (
      (repairKind !== "fts" &&
        repairKind !== "layered_projection" &&
        repairKind !== "sqlite_relations") ||
      argumentCount(argv, "--repair-kind") !== 1 ||
      argumentCount(argv, "--dry-run") !== 1 ||
      hasUnexpectedFlags(argv, [
        "--config",
        "--format",
        "--repair-kind",
        "--dry-run",
      ])
    ) {
      throw new OperatorConfigError();
    }
    return {
      command: "rebuild_dry_run",
      configPath,
      format,
      repairKind,
    };
  }
  if (argv[0] === "purge" && argv[1] === "audit") {
    const auditId = argumentValue(argv, "--audit-id");
    const tombstoneEpoch = Number(
      argumentValue(argv, "--tombstone-epoch"),
    );
    if (
      auditId === null ||
      argumentCount(argv, "--audit-id") !== 1 ||
      argumentCount(argv, "--tombstone-epoch") !== 1 ||
      !Number.isSafeInteger(tombstoneEpoch) ||
      tombstoneEpoch < 0 ||
      format !== "json" ||
      argv.includes("--dry-run") ||
      hasUnexpectedFlags(argv, [
        "--config",
        "--format",
        "--audit-id",
        "--tombstone-epoch",
      ])
    ) {
      throw new OperatorConfigError();
    }
    return {
      command: "purge_audit",
      configPath,
      format,
      auditId,
      tombstoneEpoch,
    };
  }
  if (argv[0] === "rollback" && argv[1] === "verify") {
    const releaseRef = argumentValue(argv, "--release-ref");
    if (
      releaseRef === null ||
      argumentCount(argv, "--release-ref") !== 1 ||
      argv.includes("--dry-run") ||
      hasUnexpectedFlags(argv, [
        "--config",
        "--format",
        "--release-ref",
      ])
    ) {
      throw new OperatorConfigError();
    }
    return {
      command: "rollback_verify",
      configPath,
      format,
      releaseRef,
    };
  }
  if (argv[0] === "g6" && argv[1] === "verify") {
    const evidenceRef = argumentValue(argv, "--evidence-ref");
    if (
      evidenceRef === null ||
      argumentCount(argv, "--evidence-ref") !== 1 ||
      argv.includes("--dry-run") ||
      hasUnexpectedFlags(argv, [
        "--config",
        "--format",
        "--evidence-ref",
      ])
    ) {
      throw new OperatorConfigError();
    }
    return {
      command: "g6_verify",
      configPath,
      format,
      evidenceRef,
    };
  }
  if (argv[0] === "backup" && argv[1] === "inspect") {
    const backupRef = argumentValue(argv, "--backup-ref");
    if (
      backupRef === null ||
      argumentCount(argv, "--backup-ref") !== 1 ||
      argv.includes("--dry-run") ||
      argv.includes("--input-fd") ||
      argv.includes("--target-ref")
      || hasUnexpectedFlags(argv, [
        "--config",
        "--format",
        "--backup-ref",
      ])
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
      || hasUnexpectedFlags(argv, [
        "--config",
        "--format",
        "--backup-ref",
        "--target-ref",
        "--dry-run",
      ])
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
      || hasUnexpectedFlags(argv, ["--config", "--format"])
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
      || hasUnexpectedFlags(argv, [
        "--config",
        "--format",
        "--dry-run",
      ])
    ) {
      throw new OperatorConfigError();
    }
    return { command: "key_rotate_dry_run", configPath, format };
  }
  throw new OperatorConfigError();
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
  runtime: OperatorRuntime = {},
): Promise<number> {
  let format: OperatorOutputFormat = "json";
  try {
    const arguments_ = parseOperatorArguments(argv);
    format = arguments_.format;
    const config = loadOperatorConfig(arguments_.configPath);
    switch (arguments_.command) {
      case "workbench": {
        const { runWorkbench } = await import("./commands/workbench.js");
        const launched = await runWorkbench({
          config,
          noOpen: arguments_.noOpen,
          headless: arguments_.headless,
          ...(runtime.workbenchLauncher === undefined
            ? {}
            : { launcher: runtime.workbenchLauncher }),
          ...(runtime.workbenchRuntimeDirectory === undefined
            ? {}
            : {
                runtimeDirectory:
                  runtime.workbenchRuntimeDirectory,
              }),
          ...(runtime.browserOpener === undefined
            ? {}
            : { browserOpener: runtime.browserOpener }),
        });
        io.stdout.write(
          renderWorkbenchLaunch(
            launched.result,
            format,
            launched.launchUrl,
            io.stdout.isTTY === true,
          ),
        );
        return operatorExitCode(
          launched.result.runtime_state === "health_only" ||
            launched.result.browser === "failed"
            ? "inspectable_degraded"
            : "success",
        );
      }
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
      case "rebuild_dry_run":
        io.stdout.write(
          `${canonicalJson(
            rebuildDryRun({ repairKind: arguments_.repairKind }),
          )}\n`,
        );
        return operatorExitCode("operator_action_required");
      case "purge_audit": {
        if (config.operational_artifacts === null) {
          throw new OperatorConfigError();
        }
        const storage = await SqliteStorageClient.open({
          dataRoot: config.data_root,
          secretPrincipalId: config.principal_id,
          recoveryHeadProvider: loadRecoveryHeadProvider(config),
        });
        try {
          const checkedAt = new Date().toISOString();
          const audit = await runPurgeAudit(storage, {
            audit_id: arguments_.auditId,
            expected_tombstone_epoch: arguments_.tombstoneEpoch,
            checked_at: checkedAt,
          });
          const residualAudit = scanOperationalArtifactResiduals({
            auditId: `${arguments_.auditId}_residual`,
            checkedAt,
            roots: config.operational_artifacts.roots,
            forbiddenMarkers:
              config.operational_artifacts.forbidden_markers,
          });
          const body = {
            schema_version: "1.0.0",
            purge_audit: audit,
            residual_audit: residualAudit,
            completed: audit.completed && residualAudit.completed,
          };
          const result = OperationalPurgeVerificationSchema.parse({
            ...body,
            verification_hash: canonicalSha256Omitting(
              body,
              [],
            ),
          });
          io.stdout.write(`${canonicalJson(result)}\n`);
          return operatorExitCode(
            result.completed ? "success" : "operator_action_required",
          );
        } finally {
          await storage.close();
        }
      }
      case "rollback_verify":
        io.stdout.write(
          `${canonicalJson(
            learningRollbackVerification({
              releaseRef: arguments_.releaseRef,
            }),
          )}\n`,
        );
        return operatorExitCode("operator_action_required");
      case "g6_verify":
        io.stdout.write(
          `${canonicalJson(
            verifyG6Candidate({
              evidenceRef: arguments_.evidenceRef,
              report: readPrivateOperatorJson(
                arguments_.evidenceRef,
              ),
            }),
          )}\n`,
        );
        return operatorExitCode("operator_action_required");
      case "operator_recover_lock": {
        const authority = config.operator_confirmation;
        if (authority === null) {
          throw new OperatorConfigError();
        }
        const grant = loadOperatorGrant(
          config,
          arguments_.confirmationRef,
        );
        if (grant.intent.root_ref !== config.root_ref) {
          throw new OperatorConfigError();
        }
        verifyPinnedOperatorConfirmation({
          intent: grant.intent,
          confirmation: grant.confirmation,
          trust: authority.trust,
          now: grant.confirmation.issued_at,
        });
        const ledger = new OperatorActionLedger(
          authority.action_ledger_directory,
        );
        const ownerNotLive = () =>
          processOwnerIsNotLive(arguments_.expectedProcessId);
        const recoveredAt = new Date().toISOString();
        const minimumAgeMs =
          authority.trust.max_ttl_seconds * 1_000;
        if (!ownerNotLive()) {
          throw new OperatorConfigError();
        }
        ledger.recoverStaleConfirmationLock({
          confirmationId: grant.confirmation.confirmation_id,
          expectedProcessId: arguments_.expectedProcessId,
          ownerNotLive,
          now: recoveredAt,
          minimumAgeMs,
        });
        ledger.recoverStaleLock({
          operationId: grant.intent.operation_id,
          expectedProcessId: arguments_.expectedProcessId,
          ownerNotLive,
          now: recoveredAt,
          minimumAgeMs,
        });
        io.stdout.write(
          `${canonicalJson({
            schema_version: "1.0.0",
            status: "recovered",
            operation_id: grant.intent.operation_id,
            confirmation_id: grant.confirmation.confirmation_id,
            process_id: arguments_.expectedProcessId,
          })}\n`,
        );
        return operatorExitCode("success");
      }
      case "operator_execute": {
        const authority = config.operator_confirmation;
        if (authority === null) {
          throw new OperatorConfigError();
        }
        const grant = loadOperatorGrant(
          config,
          arguments_.confirmationRef,
        );
        if (grant.intent.root_ref !== config.root_ref) {
          throw new OperatorConfigError();
        }
        const ledger = new OperatorActionLedger(
          authority.action_ledger_directory,
        );
        const recoveryHeadProvider =
          loadRecoveryHeadProvider(config);
        const now = new Date().toISOString();
        const execution = bindOperatorExecutionPayload(grant);
        if (execution.command === "restore") {
          const payload = execution.payload;
          const backupDirectory =
            config.recovery.backup_bundles[payload.backup_ref];
          const target =
            config.recovery.restore_targets[payload.target_ref];
          if (backupDirectory === undefined || target === undefined) {
            throw new OperatorConfigError();
          }
          const backup = loadBackupResult(
            backupDirectory,
            recoveryHeadProvider,
          );
          const requiredKeyIds =
            backup.manifest.encryption.required_keys
              .map(({ key_id }) => key_id)
              .sort();
          if (
            canonicalJson(
              Object.keys(payload.required_key_descriptors).sort(),
            ) !== canonicalJson(requiredKeyIds)
          ) {
            throw new OperatorConfigError();
          }
          const result = await runConfirmedRestore({
            backup,
            backupRef: payload.backup_ref,
            target,
            targetRef: payload.target_ref,
            recoveryHeadProvider,
            requiredKeyDescriptors:
              payload.required_key_descriptors,
            intent: grant.intent,
            confirmation: grant.confirmation,
            trust: authority.trust,
            now,
            ledger,
            recordReceipt: async (receipt) => {
              const restored = await SqliteStorageClient.open({
                dataRoot: target,
                secretPrincipalId: config.principal_id,
                recoveryHeadProvider,
              });
              try {
                return await restored.appendOperatorActionReceipt(
                  receipt,
                );
              } finally {
                await restored.close();
              }
            },
          });
          io.stdout.write(`${canonicalJson(result)}\n`);
          return operatorExitCode("success");
        }
        const storage = await SqliteStorageClient.open({
          dataRoot: config.data_root,
          secretPrincipalId: config.principal_id,
          recoveryHeadProvider,
        });
        try {
          const result = await (async () => {
            switch (execution.command) {
              case "purge_retry": {
                const payload = execution.payload;
                return runConfirmedPurgeRetry({
                  storage,
                  purgeJobId: payload.purge_job_id,
                  intent: grant.intent,
                  confirmation: grant.confirmation,
                  trust: authority.trust,
                  now,
                  ledger,
                });
              }
              case "rebuild_fts": {
                return runConfirmedFtsRebuild({
                  storage,
                  intent: grant.intent,
                  confirmation: grant.confirmation,
                  trust: authority.trust,
                  now,
                  ledger,
                });
              }
              case "rebuild_layered_projection": {
                const payload = execution.payload;
                return runConfirmedCanonicalProjectionRebuild({
                  storage,
                  repairKind: payload.repair_kind,
                  principalId: payload.principal_id,
                  scope: payload.scope,
                  intent: grant.intent,
                  confirmation: grant.confirmation,
                  trust: authority.trust,
                  now,
                  ledger,
                });
              }
              case "key_rotate": {
                const payload = execution.payload;
                return runConfirmedKeyRotation({
                  storage,
                  begin: payload.begin,
                  resume: {
                    old_key_descriptor:
                      payload.resume.old_key_descriptor,
                    new_key_descriptor:
                      payload.resume.new_key_descriptor,
                    old_authority_descriptor:
                      payload.resume.old_authority_descriptor,
                    new_commitment_descriptor:
                      payload.resume.new_commitment_descriptor,
                    ...(payload.resume.max_items === undefined
                      ? {}
                      : { max_items: payload.resume.max_items }),
                  },
                  intent: grant.intent,
                  confirmation: grant.confirmation,
                  trust: authority.trust,
                  now,
                  ledger,
                });
              }
              case "learning_rollback":
                {
                  const request = execution.payload;
                  const registries =
                    loadLearningApprovalRegistries(
                      config,
                      () => now,
                    );
                  const manager = new LearningReleaseManager({
                    storage,
                    ...registries,
                    clock: () => now,
                  });
                  return runConfirmedLearningRollback({
                    storage,
                    manager,
                    learningRegistryHash:
                      registries.registryHash,
                    request,
                    intent: grant.intent,
                    confirmation: grant.confirmation,
                    trust: authority.trust,
                    now,
                    ledger,
                  });
                }
            }
          })();
          io.stdout.write(`${canonicalJson(result)}\n`);
          return operatorExitCode("success");
        } finally {
          await storage.close();
        }
      }
    }
  } catch (error) {
    const invalidInput =
      error instanceof OperatorConfigError ||
      error instanceof z.ZodError ||
      error instanceof OperatorConfirmationValidationError;
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
