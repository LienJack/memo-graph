import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import {
  BackupInspectionResultSchema,
  ContentFreeOperatorResultSchema,
  EncryptionKeyInventorySchema,
  G6CandidateVerificationResultSchema,
  KeyRotationDryRunResultSchema,
  LearningRollbackVerificationResultSchema,
  OperationIntentSchema,
  OperationalPurgeVerificationSchema,
  OperationalStatusSchema,
  OperatorConfirmationTrustSchema,
  ProjectionRebuildDryRunResultSchema,
  RestoreDryRunResultSchema,
  canonicalJson,
  canonicalSha256,
} from "../packages/contracts/dist/index.js";
import {
  FileRecoveryHeadProvider,
  SqliteStorageClient,
} from "../packages/storage-sqlite/dist/index.js";
import { signOperatorConfirmationFromDescriptor } from "../apps/operator-cli/dist/confirmation-authority.js";
import { restoreStateBindings } from "../apps/operator-cli/dist/commands/restore.js";
import {
  loadOperatorConfig,
  loadRecoveryHeadProvider,
} from "../apps/operator-cli/dist/config.js";

import { repositoryRoot } from "./g6-evidence-common.mjs";

const CLI_PATH = join(
  repositoryRoot,
  "apps/operator-cli/dist/cli.js",
);
const FORBIDDEN_OUTPUT =
  /(?:\/Users\/|\/private\/|\/tmp\/|memo-graph-g6-runbook-|FORBIDDEN_PURGED_CONTENT_MARKER)/u;

function writePrivate(path, value) {
  writeFileSync(path, value, { mode: 0o600 });
  return path;
}

export function classifyG6RunbookInvocation(
  result,
  schema,
  expectedExitCodes,
) {
  if (result.error?.code === "ETIMEDOUT") {
    return { state: "blocked" };
  }
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (
    !expectedExitCodes.includes(result.status) ||
    stderr.length > 0 ||
    FORBIDDEN_OUTPUT.test(stdout) ||
    FORBIDDEN_OUTPUT.test(stderr)
  ) {
    return { state: "fail" };
  }
  try {
    schema.parse(JSON.parse(stdout));
    return { state: "pass" };
  } catch {
    return { state: "fail" };
  }
}

function invoke(argv, schema, expectedExitCodes) {
  return classifyG6RunbookInvocation(
    spawnSync(process.execPath, [CLI_PATH, ...argv], {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 120_000,
      env: process.env,
    }),
    schema,
    expectedExitCodes,
  );
}

function confirmationAuthority(root) {
  const keys = generateKeyPairSync("ed25519");
  const privatePath = writePrivate(
    join(root, "operator-confirmation-key.pk8"),
    keys.privateKey.export({ type: "pkcs8", format: "der" }),
  );
  return {
    privatePath,
    trust: OperatorConfirmationTrustSchema.parse({
      algorithm: "Ed25519",
      purpose: "memo-graph/operator-confirmation/v1",
      authority_key_id: "operator_confirmation_authority_g6_runbook",
      authority_key_generation: 1,
      public_key_spki: keys.publicKey
        .export({ type: "spki", format: "der" })
        .toString("base64url"),
      max_ttl_seconds: 300,
      revoked_key_ids: [],
    }),
  };
}

export async function runDirectG6RunbookHarness() {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "memo-graph-g6-runbook-")),
  );
  try {
    const dataRoot = join(root, "data");
    const restoreTarget = join(root, "restore-target");
    const recoveryDirectory = join(root, "recovery-head");
    const recoveryKeys = generateKeyPairSync("ed25519");
    const recoveryPrivatePath = writePrivate(
      join(root, "recovery-private.pem"),
      recoveryKeys.privateKey.export({ format: "pem", type: "pkcs8" }),
    );
    const recoveryPublicPath = writePrivate(
      join(root, "recovery-public.pem"),
      recoveryKeys.publicKey.export({ format: "pem", type: "spki" }),
    );
    const recoveryHeadProvider = new FileRecoveryHeadProvider({
      directory: recoveryDirectory,
      authorityKeyId: "recovery_authority_g6_runbook",
      trustRootVersion: 1,
      privateKey: recoveryKeys.privateKey,
      publicKey: recoveryKeys.publicKey,
      create: true,
    });
    const storage = await SqliteStorageClient.open({
      dataRoot,
      secretPrincipalId: "principal_local_default",
      recoveryHeadProvider,
    });
    const backup = await storage.createBackup();
    await storage.close();

    const artifactClasses = [
      "canonical",
      "context",
      "projection",
      "learning",
      "backup",
      "log",
      "temp",
      "quarantine",
      "ciphertext",
    ];
    const artifactRoots = Object.fromEntries(
      artifactClasses.map((artifactClass) => {
        const path = join(root, `artifact-${artifactClass}`);
        mkdirSync(path, { mode: 0o700 });
        return [artifactClass, path];
      }),
    );

    const authority = confirmationAuthority(root);
    const now = Date.now();
    const issuedAt = new Date(now - 10_000).toISOString();
    const expiresAt = new Date(now + 240_000).toISOString();
    const bindings = restoreStateBindings({
      backup,
      target: restoreTarget,
      targetRef: "restore_target",
      recoveryHeadProvider,
    });
    const intentBody = {
      schema_version: "1.0.0",
      operation_id: "g6_runbook_restore_operation",
      command: "restore",
      principal_id: "principal_local_default",
      root_ref: "root_primary",
      source_ref: "backup_current",
      target_ref: "restore_target",
      ...bindings,
      parameters_digest: canonicalSha256({
        backup_ref: "backup_current",
        backup_id: backup.backup_id,
        manifest_hash: backup.manifest.manifest_hash,
        target_ref: "restore_target",
        required_keys: [],
      }),
      nonce: "g6_runbook_restore_nonce",
      issued_at: issuedAt,
      expires_at: expiresAt,
    };
    const intent = OperationIntentSchema.parse({
      ...intentBody,
      intent_hash: canonicalSha256(intentBody),
    });
    const signingDescriptor = openSync(authority.privatePath, "r");
    const confirmation = signOperatorConfirmationFromDescriptor({
      descriptor: signingDescriptor,
      intent,
      trust: authority.trust,
      confirmationId: "g6_runbook_restore_confirmation",
      issuedAt,
      expiresAt,
    });
    closeSync(signingDescriptor);
    const grantPath = writePrivate(
      join(root, "restore-grant.json"),
      `${canonicalJson({
        intent,
        confirmation,
        payload: {
          backup_ref: "backup_current",
          target_ref: "restore_target",
          required_key_descriptors: {},
        },
      })}\n`,
    );
    const g6Hash = canonicalSha256("g6-runbook-verification-fixture");
    const g6ReportPath = writePrivate(
      join(root, "verification-report.json"),
      `${canonicalJson({
        schema_version: "1.0.0",
        gate: "G6",
        state: "pass",
        eligible: true,
        first_non_pass: null,
        decision_recorded: false,
        current_control_verified: false,
        evidence_bundle_hash: g6Hash,
        runtime_identity_hash: g6Hash,
        tested_implementation_digest: g6Hash,
        hard_rules: {
          integrity: true,
          privacy: true,
          deletion: true,
          encryption: true,
          restore: true,
          rollback: true,
          supply_chain: true,
          binding: true,
        },
        report_states: {
          fault: "pass",
          resource: "pass",
          runbook: "pass",
          security: "pass",
          supply_chain: "pass",
        },
        exact_environment: { runtime: "node-24.18.0" },
        topology: "single-user-single-root-single-writer-stdio",
        source_bindings: [{}],
      })}\n`,
    );
    const configPath = writePrivate(
      join(root, "operator.json"),
      `${canonicalJson({
        data_root: dataRoot,
        principal_id: "principal_local_default",
        root_ref: "root_primary",
        recovery: {
          backup_bundles: { backup_current: backup.directory },
          restore_targets: { restore_target: restoreTarget },
          authority: {
            directory: recoveryDirectory,
            authority_key_id: "recovery_authority_g6_runbook",
            trust_root_version: 1,
            private_key_path: recoveryPrivatePath,
            public_key_path: recoveryPublicPath,
          },
        },
        operator_confirmation: {
          trust: authority.trust,
          action_ledger_directory: join(root, "action-ledger"),
          grants: { restore_grant: grantPath },
        },
        operational_artifacts: {
          roots: artifactRoots,
          forbidden_markers: ["FORBIDDEN_PURGED_CONTENT_MARKER"],
        },
      })}\n`,
    );
    const configuredRecovery = loadRecoveryHeadProvider(
      loadOperatorConfig(configPath),
    );
    if (
      configuredRecovery.readCurrent()?.anchor_hash !==
      backup.recovery_anchor.anchor_hash
    ) {
      throw new Error("G6 runbook recovery authority is not pinned");
    }
    const common = ["--config", configPath, "--format", "json"];
    const cases = [
      ["inspect_readiness", ["doctor", ...common], OperationalStatusSchema, [0, 3]],
      ["inspect_backup", ["backup", "inspect", "--backup-ref", "backup_current", ...common], BackupInspectionResultSchema, [0]],
      ["prepare_restore", ["restore", "--dry-run", "--backup-ref", "backup_current", "--target-ref", "restore_target", ...common], RestoreDryRunResultSchema, [3]],
      ["inspect_keys", ["key", "inspect", ...common], EncryptionKeyInventorySchema, [0]],
      ["prepare_key_rotation", ["key", "rotate", "--dry-run", ...common], KeyRotationDryRunResultSchema, [3]],
      ["audit_purge", ["purge", "audit", "--audit-id", "g6_runbook_audit", "--tombstone-epoch", "0", ...common], OperationalPurgeVerificationSchema, [0]],
      ["prepare_rebuild", ["rebuild", "--dry-run", "--repair-kind", "fts", ...common], ProjectionRebuildDryRunResultSchema, [3]],
      ["verify_learning_rollback", ["rollback", "verify", "--release-ref", "release:g6-runbook", ...common], LearningRollbackVerificationResultSchema, [3]],
      ["verify_g6_candidate", ["g6", "verify", "--evidence-ref", g6ReportPath, ...common], G6CandidateVerificationResultSchema, [3]],
      ["execute_confirmed_restore", ["operator", "execute", "--confirmation-ref", "restore_grant", ...common], ContentFreeOperatorResultSchema, [0]],
    ];
    return Object.fromEntries(
      cases.map(([id, argv, schema, expected]) => [
        id,
        invoke(argv, schema, expected).state,
      ]),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
