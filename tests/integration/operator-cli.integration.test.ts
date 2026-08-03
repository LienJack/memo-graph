import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  OperationalStatusSchema,
  RuntimeIdentitySchema,
  SecretAdmissionApprovalSchema,
  canonicalSha256,
  type OperationalStatus,
} from "../../packages/contracts/src/index.js";
import { runOperatorCli } from "../../apps/operator-cli/src/cli.js";
import {
  loadSecretAdmissionArtifacts,
  loadOperatorConfig,
  loadRecoveryHeadProvider,
} from "../../apps/operator-cli/src/config.js";
import { runDoctor } from "../../apps/operator-cli/src/commands/doctor.js";
import { operatorExitCode } from "../../apps/operator-cli/src/exit-codes.js";
import { renderOperationalStatus } from "../../apps/operator-cli/src/render.js";
import {
  FileRecoveryHeadProvider,
  SqliteStorageClient,
} from "@memo-graph/storage-sqlite";
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

function canonicalG6Root(): string {
  const root = "/private/tmp/memo-graph-g6-canonical";
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  cleanupPaths.push(root);
  return realpathSync(root);
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
    const g6Hash = canonicalSha256("operator-cli-g6-report");
    const g6ReportPath = join(root, "g6-verification-report.json");
    writeFileSync(
      g6ReportPath,
      JSON.stringify({
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
      }),
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
    expect(
      await invoke([
        "rebuild",
        "--dry-run",
        "--repair-kind",
        "fts",
        "--config",
        configPath,
        "--format",
        "json",
      ]),
    ).toMatchObject({
      code: 3,
      output: {
        operation: "projection.rebuild",
        repair_kind: "fts",
        status: "operator_action_required",
      },
    });
    expect(
      await invoke([
        "rollback",
        "verify",
        "--release-ref",
        "release:operator-runbook",
        "--config",
        configPath,
        "--format",
        "json",
      ]),
    ).toMatchObject({
      code: 3,
      output: {
        operation: "learning.rollback",
        release_ref: "release:operator-runbook",
      },
    });
    expect(
      await invoke([
        "g6",
        "verify",
        "--evidence-ref",
        g6ReportPath,
        "--config",
        configPath,
        "--format",
        "json",
      ]),
    ).toMatchObject({
      code: 3,
      output: {
        operation: "g6.verify",
        status: "verified",
        eligible: true,
      },
    });
    expect(durableSnapshot(dataRoot)).toEqual(before);
  });

  it("executes the frozen JSON purge audit command against registered artifact roots", async () => {
    const root = temporaryRoot("operator-purge-audit");
    const dataRoot = join(root, "data");
    const recoveryKeys = generateKeyPairSync("ed25519");
    const recoveryDirectory = join(root, "recovery-head");
    const recoveryPrivatePath = join(root, "recovery-private.pem");
    const recoveryPublicPath = join(root, "recovery-public.pem");
    writeFileSync(
      recoveryPrivatePath,
      recoveryKeys.privateKey.export({
        format: "pem",
        type: "pkcs8",
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      recoveryPublicPath,
      recoveryKeys.publicKey.export({
        format: "pem",
        type: "spki",
      }),
      { mode: 0o600 },
    );
    const recoveryHeadProvider = new FileRecoveryHeadProvider({
      directory: recoveryDirectory,
      authorityKeyId: "recovery_authority:g6-runbook-purge",
      trustRootVersion: 1,
      privateKey: recoveryKeys.privateKey,
      publicKey: recoveryKeys.publicKey,
      create: true,
    });
    const storage = await SqliteStorageClient.open({
      dataRoot,
      secretPrincipalId: "user_local",
      recoveryHeadProvider,
    });
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
    ] as const;
    const roots = Object.fromEntries(
      artifactClasses.map((artifactClass) => {
        const path = join(root, `artifact-${artifactClass}`);
        mkdirSync(path, { mode: 0o700 });
        return [artifactClass, path];
      }),
    );
    const configPath = join(root, "operator.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        data_root: dataRoot,
        recovery: {
          backup_bundles: {},
          restore_targets: {},
          authority: {
            directory: recoveryDirectory,
            authority_key_id: "recovery_authority:g6-runbook-purge",
            trust_root_version: 1,
            private_key_path: recoveryPrivatePath,
            public_key_path: recoveryPublicPath,
          },
        },
        operational_artifacts: {
          roots,
          forbidden_markers: ["FORBIDDEN_PURGED_CONTENT_MARKER"],
        },
      }),
      { mode: 0o600 },
    );
    const loadedConfig = loadOperatorConfig(configPath);
    expect(loadedConfig.operational_artifacts).not.toBeNull();
    expect(
      loadRecoveryHeadProvider(loadedConfig).readCurrent(),
    ).not.toBeNull();
    const reopened = await SqliteStorageClient.open({
      dataRoot,
      secretPrincipalId: loadedConfig.principal_id,
      recoveryHeadProvider: loadRecoveryHeadProvider(loadedConfig),
    });
    await reopened.close();
    let stdout = "";
    const code = await runOperatorCli(
      [
        "purge",
        "audit",
        "--audit-id",
        "g6_runbook_purge_audit",
        "--tombstone-epoch",
        "0",
        "--config",
        configPath,
        "--format",
        "json",
      ],
      {
        stdout: {
          write: (value) => ((stdout += String(value)), true),
        },
        stderr: { write: () => true },
      },
    );
    expect(code, stdout).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      completed: true,
      purge_audit: { completed: true },
      residual_audit: { completed: true },
    });
  });

  it("runs separate approve and admit processes against one inherited private descriptor", async () => {
    const root = canonicalG6Root();
    const dataRoot = join(root, "data");
    const artifactRoot = join(root, "artifacts");
    mkdirSync(artifactRoot, { mode: 0o700 });
    const writePrivate = (
      name: string,
      value: string | Uint8Array,
    ): string => {
      const path = join(artifactRoot, name);
      writeFileSync(path, value, { mode: 0o600 });
      return path;
    };
    const clock = Date.parse("2026-07-30T07:30:00.000Z");
    const issuedAt = new Date(clock - 60_000).toISOString();
    const expiresAt = new Date(clock + 10 * 60_000).toISOString();
    const trustValidFrom = new Date(clock - 60 * 60_000).toISOString();
    const trustExpiresAt = new Date(clock + 60 * 60_000).toISOString();

    const recoveryKeys = generateKeyPairSync("ed25519");
    const recoveryPrivatePath = writePrivate(
      "recovery-private.pem",
      recoveryKeys.privateKey.export({ format: "pem", type: "pkcs8" }),
    );
    const recoveryPublicPath = writePrivate(
      "recovery-public.pem",
      recoveryKeys.publicKey.export({ format: "pem", type: "spki" }),
    );
    const recoveryDirectory = join(root, "recovery-authority");
    const recoveryAuthorityKeyId =
      "recovery-authority:operator-governed-secret";
    const recoveryHeadProvider = new FileRecoveryHeadProvider({
      directory: recoveryDirectory,
      authorityKeyId: recoveryAuthorityKeyId,
      trustRootVersion: 1,
      privateKey: recoveryKeys.privateKey,
      publicKey: recoveryKeys.publicKey,
      create: true,
    });

    const dataKeyPath = writePrivate(
      "data-key.bin",
      Buffer.alloc(32, 0x71),
    );
    const dataAuthorityPath = writePrivate(
      "data-authority.bin",
      Buffer.alloc(32, 0x72),
    );
    const dataCommitmentPath = writePrivate(
      "data-commitment.bin",
      Buffer.alloc(32, 0x73),
    );
    const bootstrapDescriptors = [
      openSync(dataKeyPath, "r"),
      openSync(dataAuthorityPath, "r"),
      openSync(dataCommitmentPath, "r"),
    ];
    try {
      const bootstrap = await SqliteStorageClient.open({
        dataRoot,
        testOperations: true,
        secretPrincipalId: "principal:operator-u9",
        recoveryHeadProvider,
      });
      try {
        await bootstrap.darkLaunchInstallEncryptionKey({
          idempotency_key: "install-operator-governed-secret-key",
          key_id: "key:operator-u9:1",
          key_generation: 1,
          key_descriptor: bootstrapDescriptors[0] as number,
          authority_key_id: "data-authority:operator-u9:1",
          authority_descriptor: bootstrapDescriptors[1] as number,
          commitment_key_id: "data-commitment:operator-u9:1",
          commitment_descriptor: bootstrapDescriptors[2] as number,
        });
      } finally {
        await bootstrap.close();
      }
    } finally {
      for (const descriptor of bootstrapDescriptors) {
        closeSync(descriptor);
      }
    }

    const admissionSigningSeed = Buffer.alloc(32, 0x74);
    const admissionSigningPath = writePrivate(
      "admission-signing.bin",
      admissionSigningSeed,
    );
    const admissionCommitment = Buffer.alloc(32, 0x75);
    const admissionCommitmentPath = writePrivate(
      "admission-commitment.bin",
      admissionCommitment,
    );
    const admissionPrivateKey = createPrivateKey({
      key: Buffer.concat([
        Buffer.from("302e020100300506032b657004220420", "hex"),
        admissionSigningSeed,
      ]),
      format: "der",
      type: "pkcs8",
    });
    const admissionTrust = {
      schema_version: "1.0.0",
      purpose: "secret_admission" as const,
      authority_key_id: "secret-admission-authority:operator-u9",
      authority_key_generation: 1,
      public_key_spki_base64url: createPublicKey(admissionPrivateKey)
        .export({ format: "der", type: "spki" })
        .toString("base64url"),
      valid_from: trustValidFrom,
      expires_at: trustExpiresAt,
      revoked_at: null,
      maximum_approval_ttl_seconds: 1_800,
      commitment_key_id: "secret-admission-commitment:operator-u9",
      commitment_key_verification_tag:
        `hmac-sha256:${createHmac("sha256", admissionCommitment)
          .update(
            "memo-graph/secret-admission-commitment-key-verification/v1",
            "utf8",
          )
          .digest("base64url")}`,
    };
    const pinnedG6Fixture = JSON.parse(
      readFileSync(
        join(
          process.cwd(),
          "tests/fixtures/g6-pinned-secret-admission.json",
        ),
        "utf8",
      ),
    ) as {
      runtime_identity: unknown;
      release_artifact: {
        control: unknown;
        trust: NonNullable<
          ReturnType<typeof loadOperatorConfig>["secret_admission"]
        >["release_trust"];
      };
    };
    const releaseTrust = pinnedG6Fixture.release_artifact.trust;
    const runtimeIdentity = RuntimeIdentitySchema.parse(
      pinnedG6Fixture.runtime_identity,
    );
    const runtimeIdentityPath = writePrivate(
      "runtime-identity.json",
      JSON.stringify(runtimeIdentity),
    );
    const releaseControlPath = writePrivate(
      "release-control.json",
      JSON.stringify(pinnedG6Fixture.release_artifact),
    );

    const owner = {
      kind: "evidence" as const,
      id: "evidence:operator-governed-u9",
      generation: 1,
    };
    const scope = {
      kind: "workspace" as const,
      id: "workspace:operator-u9",
    };
    const requestIdentity = {
      idempotency_key: "governed-admit:operator-u9",
      principal_id: "principal:operator-u9",
      owner,
      scope,
      content_identity: "content:operator-u9",
      media_type: "text/plain",
      request_nonce: "request-nonce:operator-u9",
    };
    const request = {
      ...requestIdentity,
      request_digest: canonicalSha256({
        schema_version: "1.0.0",
        purpose: "secret_admission",
        sensitivity: "secret",
        envelope_version: 1,
        ...requestIdentity,
      }),
      issued_at: issuedAt,
      expires_at: expiresAt,
    };
    const requestRef = "request:operator-u9";
    const approvalRef = "approval:operator-u9";
    const requestPath = writePrivate(
      "request.json",
      JSON.stringify(request),
    );
    const approvalPath = join(artifactRoot, "approval.json");
    const secretMarker = "OPERATOR_GOVERNED_SECRET_MARKER_92017";
    const secretPath = writePrivate("secret.txt", secretMarker);
    const configPath = writePrivate(
      "operator.json",
      JSON.stringify({
        data_root: dataRoot,
        principal_id: "principal:operator-u9",
        recovery: {
          backup_bundles: {},
          restore_targets: {},
          authority: {
            directory: recoveryDirectory,
            authority_key_id: recoveryAuthorityKeyId,
            trust_root_version: 1,
            private_key_path: recoveryPrivatePath,
            public_key_path: recoveryPublicPath,
          },
        },
        secret_admission: {
          enabled: true,
          approval_trust: admissionTrust,
          signing_private_key_path: admissionSigningPath,
          commitment_key_path: admissionCommitmentPath,
          release_control_path: releaseControlPath,
          release_trust: releaseTrust,
          runtime_identity_path: runtimeIdentityPath,
          encryption_provider: {
            key_id: "key:operator-u9:1",
            key_generation: 1,
            key_path: dataKeyPath,
            commitment_key_id: "data-commitment:operator-u9:1",
            commitment_key_path: dataCommitmentPath,
          },
          requests: { [requestRef]: requestPath },
          approvals: { [approvalRef]: approvalPath },
        },
      }),
    );
    const substitutedEvidenceHash = canonicalSha256(
      "substituted-g6-evidence-bundle",
    );
    const substitutedReleaseArtifact = structuredClone(
      pinnedG6Fixture.release_artifact,
    ) as typeof pinnedG6Fixture.release_artifact & {
      control: { control_hash: string };
      evidence_binding: {
        evidence_bundle_hash: string;
        release_binding_hash: string;
      };
    };
    substitutedReleaseArtifact.evidence_binding.evidence_bundle_hash =
      substitutedEvidenceHash;
    substitutedReleaseArtifact.evidence_binding.release_binding_hash =
      canonicalSha256({
        control_hash:
          substitutedReleaseArtifact.control.control_hash,
        evidence_bundle_hash: substitutedEvidenceHash,
      });
    writeFileSync(
      releaseControlPath,
      JSON.stringify(substitutedReleaseArtifact),
      { mode: 0o600 },
    );
    expect(() =>
      loadSecretAdmissionArtifacts(loadOperatorConfig(configPath), {}),
    ).toThrow();
    writeFileSync(
      releaseControlPath,
      JSON.stringify(pinnedG6Fixture.release_artifact),
      { mode: 0o600 },
    );
    const inputDescriptor = openSync(secretPath, "r");
    const invoke = async (argv: string[]) => {
      let stdout = "";
      let stderr = "";
      const code = await runOperatorCli(
        argv,
        {
          stdout: {
            write: (value) => ((stdout += String(value)), true),
          },
          stderr: {
            write: (value) => ((stderr += String(value)), true),
          },
        },
        {
          now: () => "2026-07-30T07:30:00.000Z",
        },
      );
      return { code, stdout, stderr };
    };
    try {
      const approved = await invoke([
        "secret",
        "approve",
        "--input-fd",
        String(inputDescriptor),
        "--request-ref",
        requestRef,
        "--config",
        configPath,
        "--format",
        "json",
      ]);
      expect(approved.code, approved.stdout).toBe(0);
      expect(approved.stderr).toBe("");
      expect(approved.stdout).not.toContain(secretMarker);
      const approval = SecretAdmissionApprovalSchema.parse(
        JSON.parse(approved.stdout) as unknown,
      );
      writeFileSync(approvalPath, JSON.stringify(approval), { mode: 0o600 });

      const admitted = await invoke([
        "secret",
        "admit",
        "--input-fd",
        String(inputDescriptor),
        "--request-ref",
        requestRef,
        "--approval-ref",
        approvalRef,
        "--config",
        configPath,
        "--format",
        "json",
      ]);
      expect(admitted.code, admitted.stdout).toBe(0);
      expect(admitted.stderr).toBe("");
      expect(admitted.stdout).not.toContain(secretMarker);
      expect(JSON.parse(admitted.stdout)).toMatchObject({
        operation: "secret_admit",
      });
    } finally {
      closeSync(inputDescriptor);
    }

    const database = new DatabaseSync(join(dataRoot, "ledger", "memory.db"), {
      readOnly: true,
    });
    expect(
      database
        .prepare(
          `SELECT count(*) AS count FROM encrypted_content_owners
           WHERE owner_id = ?`,
        )
        .get(owner.id),
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare(
          `SELECT count(*) AS count FROM secret_authority_consumptions
           WHERE authority_kind = 'admission'`,
        )
        .get(),
    ).toEqual({ count: 1 });
    database.close();
  });
});

describe("operator CLI backup and restore surface", () => {
  it("rejects human purge verification instead of emitting ad-hoc output", async () => {
    let stdout = "";
    const code = await runOperatorCli(
      [
        "purge",
        "audit",
        "--audit-id",
        "purge_audit_human_rejected",
        "--tombstone-epoch",
        "0",
        "--config",
        "/not-read-after-argument-rejection.json",
        "--format",
        "human",
      ],
      {
        stdout: {
          write: (value) => ((stdout += String(value)), true),
        },
        stderr: { write: () => true },
      },
    );
    const status = OperationalStatusSchema.parse(
      JSON.parse(stdout) as unknown,
    );
    expect(code).toBe(operatorExitCode("invalid_input"));
    expect(status.exit_class).toBe("invalid_input");
  });

  it("inspects a bound bundle without leaking paths and requires confirmed restore publication", async () => {
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
        publication: "confirmation_required",
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
