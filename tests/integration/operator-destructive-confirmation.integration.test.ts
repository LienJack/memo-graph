import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalJson,
  OperationIntentSchema,
  OperationalArtifactClassSchema,
  OperatorConfirmationTrustSchema,
  canonicalSha256,
  canonicalSha256Omitting,
  type OperatorActionReceipt,
} from "../../packages/contracts/src/index.js";
import {
  OperatorActionLedger,
  executeConfirmedOperatorAction,
} from "../../apps/operator-cli/src/operator-action-ledger.js";
import {
  signOperatorConfirmationFromDescriptor,
} from "../../apps/operator-cli/src/confirmation-authority.js";
import {
  FileRecoveryHeadProvider,
  SqliteStorageClient,
  operatorKeyRotationParameters,
} from "@memo-graph/storage-sqlite";
import {
  bindOperatorExecutionPayload,
  runOperatorCli,
} from "../../apps/operator-cli/src/cli.js";
import {
  loadOperatorConfig,
  loadRecoveryHeadProvider,
} from "../../apps/operator-cli/src/config.js";
import {
  runConfirmedRestore,
  restoreStateBindings,
} from "../../apps/operator-cli/src/commands/restore.js";

const cleanupPaths: string[] = [];
const NOW = "2026-07-30T10:00:00.000Z";
const HASH_A: `sha256:${string}` = `sha256:${"a".repeat(64)}`;
const HASH_B: `sha256:${string}` = `sha256:${"b".repeat(64)}`;

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

function restoreIntent() {
  const body = {
    schema_version: "1.0.0",
    operation_id: "restore_operation_1",
    command: "restore",
    principal_id: "user_local",
    root_ref: "root_primary",
    source_ref: "backup_current",
    target_ref: "restore_target",
    recovery_anchor_hash: HASH_A,
    configuration_digest: HASH_B,
    key_state_digest: HASH_A,
    expected_state_digest: HASH_B,
    expected_frontier_digest: HASH_A,
    parameters_digest: canonicalSha256({
      command: "restore",
      root_ref: "root_primary",
      source_ref: "backup_current",
      target_ref: "restore_target",
    }),
    nonce: "restore_nonce_1",
    issued_at: NOW,
    expires_at: "2026-07-30T10:05:00.000Z",
  };
  return OperationIntentSchema.parse({
    ...body,
    intent_hash: canonicalSha256(body),
  });
}

function operatorIntent(input: {
  operationId: string;
  command:
    | "restore"
    | "rebuild_fts"
    | "rebuild_layered_projection"
    | "purge_retry"
    | "key_rotate"
    | "learning_rollback";
  sourceRef: string | null;
  targetRef: string | null;
  parameters: unknown;
  principalId?: string;
}) {
  const body = {
    schema_version: "1.0.0",
    operation_id: input.operationId,
    command: input.command,
    principal_id: input.principalId ?? "user_local",
    root_ref: "root_primary",
    source_ref: input.sourceRef,
    target_ref: input.targetRef,
    recovery_anchor_hash: HASH_A,
    configuration_digest: HASH_B,
    key_state_digest: HASH_A,
    expected_state_digest: HASH_B,
    expected_frontier_digest: HASH_A,
    parameters_digest: canonicalSha256(input.parameters),
    nonce: `${input.operationId}_nonce`,
    issued_at: NOW,
    expires_at: "2026-07-30T10:05:00.000Z",
  };
  return OperationIntentSchema.parse({
    ...body,
    intent_hash: canonicalSha256(body),
  });
}

function authorityFixture(root: string) {
  const keys = generateKeyPairSync("ed25519");
  const privatePath = join(root, "operator-confirmation-key.pk8");
  writeFileSync(
    privatePath,
    keys.privateKey.export({ type: "pkcs8", format: "der" }),
    { mode: 0o600 },
  );
  const trust = OperatorConfirmationTrustSchema.parse({
    algorithm: "Ed25519",
    purpose: "memo-graph/operator-confirmation/v1",
    authority_key_id: "operator_confirmation_authority_1",
    authority_key_generation: 1,
    public_key_spki: keys.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64url"),
    max_ttl_seconds: 300,
    revoked_key_ids: [],
  });
  return { privatePath, trust };
}

describe("confirmed destructive operator actions", () => {
  it("strictly dispatches every operator command from one payload/intent binding", () => {
    const root = temporaryRoot("operator-dispatch-binding");
    const keyPaths = Array.from({ length: 5 }, (_, index) => {
      const path = join(root, `key-${index}.bin`);
      writeFileSync(path, Buffer.alloc(32, index + 1), { mode: 0o600 });
      return path;
    });
    const descriptors = keyPaths.map((path) => openSync(path, "r"));
    const [
      oldKeyDescriptor,
      newKeyDescriptor,
      oldAuthorityDescriptor,
      newAuthorityDescriptor,
      newCommitmentDescriptor,
    ] = descriptors as [number, number, number, number, number];
    try {
      const ftsPayload = { repair_kind: "fts" as const };
      const layeredPayload = {
        repair_kind: "layered_projection" as const,
        principal_id: "user_local",
        scope: { kind: "workspace" as const, id: "workspace_local" },
      };
      const purgePayload = { purge_job_id: "purge_job_1" };
      const restorePayload = {
        backup_ref: "backup_current",
        target_ref: "restore_target",
        required_key_descriptors: {},
      };
      const keyPayload = {
        begin: {
          rotation_id: "rotation_dispatch_1",
          new_key_id: "key_dispatch_2",
          new_key_generation: 2,
          new_key_descriptor: newKeyDescriptor,
          new_authority_key_id: "authority_dispatch_2",
          new_authority_descriptor: newAuthorityDescriptor,
          new_commitment_key_id: "commitment_dispatch_2",
          new_commitment_descriptor: newCommitmentDescriptor,
        },
        resume: {
          old_key_descriptor: oldKeyDescriptor,
          new_key_descriptor: newKeyDescriptor,
          old_authority_descriptor: oldAuthorityDescriptor,
          new_commitment_descriptor: newCommitmentDescriptor,
          max_items: 10,
        },
      };
      const keyParameters = operatorKeyRotationParameters(keyPayload);
      const learningPayload = {
        schema_version: "1.0.0",
        action: "rollback" as const,
        idempotency_key: "learning-rollback-dispatch-001",
        principal_id: "user_local",
        scopes: [
          { kind: "workspace" as const, id: "workspace_local" },
        ],
        candidate_id: "candidate_dispatch_1",
        approval_id: "approval_dispatch_1",
        target_release_id: "release_base_1",
        operator_lane_policy: null,
        base_configuration_hash: HASH_A,
        monitor_contract_hash: HASH_B,
        monitor_receipt_id: "monitor_receipt_1",
        reason: "Restore the exact configured base release.",
        activated_at: NOW,
      };
      const cases = [
        {
          command: "purge_retry" as const,
          intent: operatorIntent({
            operationId: "dispatch_purge_1",
            command: "purge_retry",
            sourceRef: purgePayload.purge_job_id,
            targetRef: "purge_receipt_prior_1",
            parameters: {
              purge_job_id: purgePayload.purge_job_id,
              expected_prior_receipt_id: "purge_receipt_prior_1",
            },
          }),
          payload: purgePayload,
        },
        {
          command: "rebuild_fts" as const,
          intent: operatorIntent({
            operationId: "dispatch_fts_1",
            command: "rebuild_fts",
            sourceRef: "canonical_sqlite",
            targetRef: "fts",
            parameters: {
              repair_kind: "fts",
              source: "canonical_sqlite",
              target: "fts",
            },
          }),
          payload: ftsPayload,
        },
        {
          command: "rebuild_layered_projection" as const,
          intent: operatorIntent({
            operationId: "dispatch_layered_1",
            command: "rebuild_layered_projection",
            sourceRef: "canonical_sqlite",
            targetRef: layeredPayload.repair_kind,
            parameters: {
              repair_kind: layeredPayload.repair_kind,
              source: "canonical_sqlite",
              target: layeredPayload.repair_kind,
              principal_id: layeredPayload.principal_id,
              scope: layeredPayload.scope,
            },
          }),
          payload: layeredPayload,
        },
        {
          command: "restore" as const,
          intent: operatorIntent({
            operationId: "dispatch_restore_1",
            command: "restore",
            sourceRef: restorePayload.backup_ref,
            targetRef: restorePayload.target_ref,
            parameters: { manifest_hash: HASH_A },
          }),
          payload: restorePayload,
        },
        {
          command: "key_rotate" as const,
          intent: operatorIntent({
            operationId: "dispatch_key_1",
            command: "key_rotate",
            sourceRef: keyPayload.begin.rotation_id,
            targetRef: keyPayload.begin.new_key_id,
            parameters: keyParameters,
          }),
          payload: keyPayload,
        },
        {
          command: "learning_rollback" as const,
          intent: operatorIntent({
            operationId: "dispatch_learning_1",
            command: "learning_rollback",
            sourceRef: learningPayload.candidate_id,
            targetRef: learningPayload.target_release_id,
            parameters: learningPayload,
          }),
          payload: learningPayload,
        },
      ];
      for (const value of cases) {
        expect(
          bindOperatorExecutionPayload({
            intent: value.intent,
            payload: value.payload,
          }).command,
        ).toBe(value.command);
      }
      const byCommand = new Map(
        cases.map((value) => [value.command, value.intent] as const),
      );
      const requiredIntent = (command: (typeof cases)[number]["command"]) => {
        const intent = byCommand.get(command);
        if (intent === undefined) {
          throw new Error("operator dispatcher test fixture is invalid");
        }
        return intent;
      };
      for (const value of [
        {
          intent: requiredIntent("purge_retry"),
          payload: { purge_job_id: "purge_job_other" },
        },
        {
          intent: requiredIntent("rebuild_fts"),
          payload: layeredPayload,
        },
        {
          intent: requiredIntent("rebuild_layered_projection"),
          payload: { repair_kind: "layered_projection" },
        },
        {
          intent: requiredIntent("restore"),
          payload: { ...restorePayload, backup_ref: "backup_other" },
        },
        {
          intent: requiredIntent("key_rotate"),
          payload: {
            ...keyPayload,
            begin: {
              ...keyPayload.begin,
              new_key_id: "key_dispatch_other",
            },
          },
        },
        {
          intent: requiredIntent("learning_rollback"),
          payload: {
            ...learningPayload,
            target_release_id: "release_other",
          },
        },
      ]) {
        expect(() =>
          bindOperatorExecutionPayload({
            intent: value.intent,
            payload: value.payload,
          }),
        ).toThrow("operator configuration is invalid");
      }
    } finally {
      for (const descriptor of descriptors) {
        closeSync(descriptor);
      }
    }
  });

  it("rejects duplicate and nested operational artifact class roots", () => {
    const root = temporaryRoot("operator-artifact-root-policy");
    const shared = join(root, "shared-artifacts");
    writeFileSync(join(root, "placeholder"), "x", { mode: 0o600 });
    const duplicateConfig = join(root, "duplicate.json");
    writeFileSync(
      duplicateConfig,
      `${canonicalJson({
        data_root: join(root, "data"),
        operational_artifacts: {
          roots: Object.fromEntries(
            OperationalArtifactClassSchema.options.map(
              (artifactClass) => [artifactClass, shared],
            ),
          ),
          forbidden_markers: [],
        },
      })}\n`,
      { mode: 0o600 },
    );
    expect(() => loadOperatorConfig(duplicateConfig)).toThrow(
      "operator configuration is invalid",
    );

    const nestedConfig = join(root, "nested.json");
    const classRoots = Object.fromEntries(
      OperationalArtifactClassSchema.options.map(
        (artifactClass) => [
          artifactClass,
          join(root, `class-${artifactClass}`),
        ],
      ),
    ) as Record<
      (typeof OperationalArtifactClassSchema.options)[number],
      string
    >;
    classRoots.quarantine = join(
      classRoots.canonical,
      "nested-quarantine",
    );
    writeFileSync(
      nestedConfig,
      `${canonicalJson({
        data_root: join(root, "data"),
        operational_artifacts: {
          roots: classRoots,
          forbidden_markers: [],
        },
      })}\n`,
      { mode: 0o600 },
    );
    expect(() => loadOperatorConfig(nestedConfig)).toThrow(
      "operator configuration is invalid",
    );
  });

  it("restores an encrypted backup through the CLI using exact inherited key descriptors", async () => {
    const dataRoot = join(
      temporaryRoot("operator-encrypted-source"),
      "data",
    );
    const target = join(
      temporaryRoot("operator-encrypted-target"),
      "data",
    );
    const recoveryRoot = temporaryRoot(
      "operator-encrypted-recovery",
    );
    const recoveryDirectory = join(recoveryRoot, "head");
    const recoveryKeys = generateKeyPairSync("ed25519");
    const recoveryPrivatePath = join(
      recoveryRoot,
      "recovery-private.pem",
    );
    const recoveryPublicPath = join(
      recoveryRoot,
      "recovery-public.pem",
    );
    writeFileSync(
      recoveryPrivatePath,
      recoveryKeys.privateKey.export({
        type: "pkcs8",
        format: "pem",
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      recoveryPublicPath,
      recoveryKeys.publicKey.export({
        type: "spki",
        format: "pem",
      }),
      { mode: 0o600 },
    );
    const recoveryHeadProvider = new FileRecoveryHeadProvider({
      directory: recoveryDirectory,
      authorityKeyId: "recovery_authority_operator_encrypted",
      trustRootVersion: 1,
      privateKey: recoveryKeys.privateKey,
      publicKey: recoveryKeys.publicKey,
      create: true,
    });

    const descriptorRoot = temporaryRoot(
      "operator-encrypted-descriptors",
    );
    const descriptorBytes = [
      Buffer.alloc(32, 0x31),
      Buffer.alloc(32, 0x32),
      Buffer.alloc(32, 0x33),
      Buffer.alloc(1024, 0x53),
    ];
    const descriptorNames = [
      "key.bin",
      "authority.bin",
      "commitment.bin",
      "secret.bin",
    ];
    const descriptorValues = descriptorNames.map((name, index) => {
      const path = join(descriptorRoot, name);
      const bytes = descriptorBytes[index];
      if (bytes === undefined) {
        throw new Error("descriptor fixture bytes are absent");
      }
      writeFileSync(path, bytes, { mode: 0o600 });
      return openSync(path, "r");
    });
    const [
      keyDescriptor,
      authorityDescriptor,
      commitmentDescriptor,
      secretDescriptor,
    ] = descriptorValues as [number, number, number, number];

    try {
      const storage = await SqliteStorageClient.open({
        dataRoot,
        testOperations: true,
        secretPrincipalId: "principal:operator-restore",
        recoveryHeadProvider,
      });
      await storage.darkLaunchInstallEncryptionKey({
        idempotency_key: "install-encrypted-restore-key-001",
        key_id: "key:encrypted-restore:1",
        key_generation: 1,
        key_descriptor: keyDescriptor,
        authority_key_id: "authority:encrypted-restore:1",
        authority_descriptor: authorityDescriptor,
        commitment_key_id: "commitment:encrypted-restore:1",
        commitment_descriptor: commitmentDescriptor,
      });
      await storage.darkLaunchAdmitSecret({
        idempotency_key: "admit-encrypted-restore-secret-001",
        request_digest: canonicalSha256({
          operation: "operator-encrypted-restore",
        }),
        principal_id: "principal:operator-restore",
        owner: {
          kind: "evidence",
          id: "evidence:operator-restore:1",
          generation: 1,
        },
        scope: {
          kind: "workspace",
          id: "workspace:operator-restore",
        },
        content_identity: "content:operator-restore:1",
        media_type: "application/octet-stream",
        input_descriptor: secretDescriptor,
      });
      const backup = await storage.createBackup();
      await storage.close();

      const supportRoot = temporaryRoot(
        "operator-encrypted-support",
      );
      const authority = authorityFixture(
        temporaryRoot("operator-encrypted-confirmation"),
      );
      const grantPath = join(supportRoot, "restore-grant.json");
      const configPath = join(supportRoot, "operator.json");
      const bindings = restoreStateBindings({
        backup,
        target,
        targetRef: "recovery_target",
        recoveryHeadProvider,
      });
      const issued = new Date(Date.now() - 10_000).toISOString();
      const expires = new Date(Date.now() + 240_000).toISOString();
      const body = {
        schema_version: "1.0.0",
        operation_id: "restore_operator_encrypted_1",
        command: "restore",
        principal_id: "principal_operator_restore",
        root_ref: "root_primary",
        source_ref: "current_backup",
        target_ref: "recovery_target",
        ...bindings,
        parameters_digest: canonicalSha256({
          backup_ref: "current_backup",
          backup_id: backup.backup_id,
          manifest_hash: backup.manifest.manifest_hash,
          target_ref: "recovery_target",
          required_keys:
            backup.manifest.encryption.required_keys
              .map(({ key_id, key_generation, state }) => ({
                key_id,
                key_generation,
                state,
              }))
              .sort((left, right) =>
                left.key_id.localeCompare(right.key_id)
              ),
        }),
        nonce: "restore_operator_encrypted_nonce_1",
        issued_at: issued,
        expires_at: expires,
      };
      const intent = OperationIntentSchema.parse({
        ...body,
        intent_hash: canonicalSha256(body),
      });
      const confirmationDescriptor = openSync(
        authority.privatePath,
        "r",
      );
      const confirmation =
        signOperatorConfirmationFromDescriptor({
          descriptor: confirmationDescriptor,
          intent,
          trust: authority.trust,
          confirmationId:
            "restore_operator_encrypted_confirmation_1",
          issuedAt: issued,
          expiresAt: expires,
        });
      closeSync(confirmationDescriptor);
      writeFileSync(
        grantPath,
        `${canonicalJson({
          intent,
          confirmation,
          payload: {
            backup_ref: "current_backup",
            target_ref: "recovery_target",
            required_key_descriptors: {
              "key:encrypted-restore:1": keyDescriptor,
            },
          },
        })}\n`,
        { mode: 0o600 },
      );
      writeFileSync(
        configPath,
        `${canonicalJson({
          data_root: dataRoot,
          principal_id: "principal:operator-restore",
          root_ref: "root_primary",
          recovery: {
            backup_bundles: {
              current_backup: backup.directory,
            },
            restore_targets: {
              recovery_target: target,
            },
            authority: {
              directory: recoveryDirectory,
              authority_key_id:
                "recovery_authority_operator_encrypted",
              trust_root_version: 1,
              private_key_path: recoveryPrivatePath,
              public_key_path: recoveryPublicPath,
            },
          },
          operator_confirmation: {
            trust: authority.trust,
            action_ledger_directory: join(
              supportRoot,
              "action-ledger",
            ),
            grants: { restore_encrypted: grantPath },
          },
        })}\n`,
        { mode: 0o600 },
      );
      expect(
        loadRecoveryHeadProvider(
          loadOperatorConfig(configPath),
        ).readCurrent()?.anchor_hash,
      ).toBe(backup.recovery_anchor.anchor_hash);
      let stdout = "";
      const code = await runOperatorCli(
        [
          "operator",
          "execute",
          "--confirmation-ref",
          "restore_encrypted",
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
      expect(
        code,
        `${stdout}\ntarget=${existsSync(target)} ledger=${JSON.stringify(
          new OperatorActionLedger(
            join(supportRoot, "action-ledger"),
          ).read(intent.operation_id),
        )}`,
      ).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({
        status: "published",
        backup_id: backup.backup_id,
        verified_blobs: 0,
      });
      expect(existsSync(target)).toBe(true);
    } finally {
      for (const descriptor of descriptorValues) {
        closeSync(descriptor);
      }
    }
  });

  it("pins Ed25519 authority and executes a confirmed restore exactly once", async () => {
    const root = temporaryRoot("operator-confirmed-restore");
    const intent = restoreIntent();
    const { privatePath, trust } = authorityFixture(root);
    const descriptor = openSync(privatePath, "r");
    const confirmation = signOperatorConfirmationFromDescriptor({
      descriptor,
      intent,
      trust,
      confirmationId: "restore_confirmation_1",
      issuedAt: "2026-07-30T10:00:01.000Z",
      expiresAt: "2026-07-30T10:04:00.000Z",
    });
    closeSync(descriptor);

    const ledger = new OperatorActionLedger(join(root, "action-ledger"));
    let effects = 0;
    let receipts = 0;
    let published:
      | { status: string; publication_id: string }
      | null = null;
    const execute = () =>
      executeConfirmedOperatorAction({
        intent,
        confirmation,
        trust,
        now: "2026-07-30T10:02:00.000Z",
        ledger,
        validateCurrentState: () => undefined,
        prepareEffectDigest: () =>
          canonicalSha256({
            command: intent.command,
            target_ref: intent.target_ref,
          }),
        reconcileEffect: async () => published,
        effect: async () => {
          effects += 1;
          published = {
            status: "published",
            publication_id: "restore_publication_1",
          };
          return published;
        },
        recordReceipt: async (receipt) => {
          receipts += 1;
          return receipt;
        },
      });

    const first = await execute();
    const replay = await execute();
    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      status: "published",
      publication_id: "restore_publication_1",
    });
    expect(effects).toBe(1);
    expect(receipts).toBe(1);
    expect(ledger.read(intent.operation_id)).toMatchObject({
      state: "responded",
      intent_hash: intent.intent_hash,
      confirmation_id: confirmation.confirmation_id,
    });
  });

  it("reconciles a real restore publication after response loss and confirmation expiry", async () => {
    const dataRoot = join(temporaryRoot("operator-restore-response-source"), "data");
    const target = join(temporaryRoot("operator-restore-response-target"), "data");
    const providerDirectory = join(
      temporaryRoot("operator-restore-response-provider"),
      "head",
    );
    const recoveryKeys = generateKeyPairSync("ed25519");
    const recoveryHeadProvider = new FileRecoveryHeadProvider({
      directory: providerDirectory,
      authorityKeyId: "recovery_authority:operator-response-loss",
      trustRootVersion: 1,
      privateKey: recoveryKeys.privateKey,
      publicKey: recoveryKeys.publicKey,
      create: true,
    });
    const source = await SqliteStorageClient.open({
      dataRoot,
      secretPrincipalId: "user_local",
      recoveryHeadProvider,
    });
    const backup = await source.createBackup();
    await source.close();

    const bindings = restoreStateBindings({
      backup,
      target,
      targetRef: "restore_target",
      recoveryHeadProvider,
    });
    const issuedAt = "2026-07-30T10:00:00.000Z";
    const expiresAt = "2026-07-30T10:01:00.000Z";
    const body = {
      schema_version: "1.0.0",
      operation_id: "restore_response_loss_operation",
      command: "restore",
      principal_id: "user_local",
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
      nonce: "restore_response_loss_nonce",
      issued_at: issuedAt,
      expires_at: expiresAt,
    };
    const intent = OperationIntentSchema.parse({
      ...body,
      intent_hash: canonicalSha256(body),
    });
    const authority = authorityFixture(
      temporaryRoot("operator-restore-response-confirmation"),
    );
    const descriptor = openSync(authority.privatePath, "r");
    const confirmation = signOperatorConfirmationFromDescriptor({
      descriptor,
      intent,
      trust: authority.trust,
      confirmationId: "restore_response_loss_confirmation",
      issuedAt,
      expiresAt,
    });
    closeSync(descriptor);
    const ledger = new OperatorActionLedger(
      join(temporaryRoot("operator-restore-response-ledger"), "ledger"),
    );
    let receiptWrites = 0;
    const recordReceipt = async (receipt: OperatorActionReceipt) => {
      receiptWrites += 1;
      const restored = await SqliteStorageClient.open({
        dataRoot: target,
        secretPrincipalId: "user_local",
        recoveryHeadProvider,
      });
      try {
        return await restored.appendOperatorActionReceipt(receipt);
      } finally {
        await restored.close();
      }
    };
    const base = {
      backup,
      backupRef: "backup_current",
      target,
      targetRef: "restore_target",
      recoveryHeadProvider,
      intent,
      confirmation,
      trust: authority.trust,
      ledger,
      recordReceipt,
    };

    const remappedTarget = join(
      temporaryRoot("operator-restore-remapped-target"),
      "data",
    );
    await expect(
      runConfirmedRestore({
        ...base,
        target: remappedTarget,
        now: "2026-07-30T10:00:20.000Z",
      }),
    ).rejects.toThrow("restore configuration_digest binding changed");
    expect(existsSync(remappedTarget)).toBe(false);
    expect(ledger.read(intent.operation_id)?.state).toBe("authorized");

    await expect(
      runConfirmedRestore({
        ...base,
        now: "2026-07-30T10:00:30.000Z",
        testFaultAfter: "external_effect",
      }),
    ).rejects.toThrow("injected operator action fault");
    expect(existsSync(target)).toBe(true);
    expect(ledger.read(intent.operation_id)?.state).toBe("effect_prepared");

    await expect(
      runConfirmedRestore({
        ...base,
        now: "2026-07-30T10:02:00.000Z",
      }),
    ).resolves.toMatchObject({
      status: "published",
      publication: "reconciled",
      operation_id: intent.operation_id,
      backup_id: backup.backup_id,
    });
    expect(receiptWrites).toBe(1);
    expect(ledger.read(intent.operation_id)?.state).toBe("responded");
  });

  it.each([
    "authorized",
    "effect_prepared",
    "external_effect",
    "effect_committed",
    "receipt_committed",
    "responded",
  ] as const)(
    "reconciles interruption after %s without repeating a committed effect",
    async (faultAt) => {
      const root = temporaryRoot(`operator-ledger-${faultAt}`);
      const intent = restoreIntent();
      const { privatePath, trust } = authorityFixture(root);
      const descriptor = openSync(privatePath, "r");
      const confirmation = signOperatorConfirmationFromDescriptor({
        descriptor,
        intent,
        trust,
        confirmationId: `confirmation_${faultAt}`,
        issuedAt: "2026-07-30T10:00:01.000Z",
        expiresAt: "2026-07-30T10:04:00.000Z",
      });
      closeSync(descriptor);
      const ledger = new OperatorActionLedger(join(root, "action-ledger"));
      let effects = 0;
      let externalResult:
        | { status: string; operation_id: string }
        | null = null;
      const input = {
        intent,
        confirmation,
        trust,
        now: "2026-07-30T10:02:00.000Z",
        ledger,
        validateCurrentState: () => undefined,
        prepareEffectDigest: () => HASH_A,
        reconcileEffect: async () => externalResult,
        effect: async () => {
          effects += 1;
          externalResult = {
            status: "completed",
            operation_id: intent.operation_id,
          };
          return externalResult;
        },
        recordReceipt: async (receipt: OperatorActionReceipt) => receipt,
      };
      await expect(
        executeConfirmedOperatorAction({
          ...input,
          testFaultAfter: faultAt,
        }),
      ).rejects.toThrow("injected operator action fault");
      const result = await executeConfirmedOperatorAction(input);
      expect(result).toMatchObject({ status: "completed" });
      expect(effects).toBe(1);
      expect(ledger.read(intent.operation_id)?.state).toBe("responded");
    },
  );

  it("finishes a durable committed action after confirmation expiry", async () => {
    const root = temporaryRoot("operator-expired-recovery");
    const intent = restoreIntent();
    const { privatePath, trust } = authorityFixture(root);
    const descriptor = openSync(privatePath, "r");
    const confirmation = signOperatorConfirmationFromDescriptor({
      descriptor,
      intent,
      trust,
      confirmationId: "restore_confirmation_expired_recovery",
      issuedAt: "2026-07-30T10:00:01.000Z",
      expiresAt: "2026-07-30T10:04:00.000Z",
    });
    closeSync(descriptor);
    const ledger = new OperatorActionLedger(join(root, "action-ledger"));
    let effects = 0;
    const base = {
      intent,
      confirmation,
      trust,
      ledger,
      validateCurrentState: () => undefined,
      prepareEffectDigest: () => HASH_A,
      reconcileEffect: async () => null,
      effect: async () => {
        effects += 1;
        return { status: "completed" };
      },
      recordReceipt: async (receipt: OperatorActionReceipt) => receipt,
    };
    await expect(
      executeConfirmedOperatorAction({
        ...base,
        now: "2026-07-30T10:02:00.000Z",
        testFaultAfter: "effect_committed",
      }),
    ).rejects.toThrow("injected operator action fault");
    await expect(
      executeConfirmedOperatorAction({
        ...base,
        now: "2026-07-30T10:06:00.000Z",
      }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(effects).toBe(1);
    expect(ledger.read(intent.operation_id)?.state).toBe("responded");
  });

  it.each(["authorized", "effect_prepared"] as const)(
    "does not start a new effect after an expired %s crash",
    async (faultAt) => {
      const root = temporaryRoot(`operator-expired-${faultAt}`);
      const intent = restoreIntent();
      const { privatePath, trust } = authorityFixture(root);
      const descriptor = openSync(privatePath, "r");
      const confirmation = signOperatorConfirmationFromDescriptor({
        descriptor,
        intent,
        trust,
        confirmationId: `restore_confirmation_expired_${faultAt}`,
        issuedAt: "2026-07-30T10:00:01.000Z",
        expiresAt: "2026-07-30T10:04:00.000Z",
      });
      closeSync(descriptor);
      const ledger = new OperatorActionLedger(join(root, "action-ledger"));
      let effects = 0;
      const base = {
        intent,
        confirmation,
        trust,
        ledger,
        validateCurrentState: () => undefined,
        prepareEffectDigest: () => HASH_A,
        reconcileEffect: async () => null,
        effect: async () => {
          effects += 1;
          return { status: "completed" };
        },
        recordReceipt: async (receipt: OperatorActionReceipt) => receipt,
      };
      await expect(
        executeConfirmedOperatorAction({
          ...base,
          now: "2026-07-30T10:02:00.000Z",
          testFaultAfter: faultAt,
        }),
      ).rejects.toThrow("injected operator action fault");
      await expect(
        executeConfirmedOperatorAction({
          ...base,
          now: "2026-07-30T10:06:00.000Z",
        }),
      ).rejects.toThrow("operator confirmation is invalid");
      expect(effects).toBe(0);
      expect(ledger.read(intent.operation_id)?.state).toBe(faultAt);
    },
  );

  it("reconciles an already committed external effect after confirmation expiry", async () => {
    const root = temporaryRoot("operator-expired-external-effect");
    const intent = restoreIntent();
    const { privatePath, trust } = authorityFixture(root);
    const descriptor = openSync(privatePath, "r");
    const confirmation = signOperatorConfirmationFromDescriptor({
      descriptor,
      intent,
      trust,
      confirmationId: "restore_confirmation_expired_external",
      issuedAt: "2026-07-30T10:00:01.000Z",
      expiresAt: "2026-07-30T10:04:00.000Z",
    });
    closeSync(descriptor);
    const ledger = new OperatorActionLedger(join(root, "action-ledger"));
    let effects = 0;
    let committed: { status: string } | null = null;
    const base = {
      intent,
      confirmation,
      trust,
      ledger,
      validateCurrentState: () => undefined,
      prepareEffectDigest: () => HASH_A,
      reconcileEffect: async () => committed,
      effect: async () => {
        effects += 1;
        committed = { status: "completed" };
        return committed;
      },
      recordReceipt: async (receipt: OperatorActionReceipt) => receipt,
    };
    await expect(
      executeConfirmedOperatorAction({
        ...base,
        now: "2026-07-30T10:02:00.000Z",
        testFaultAfter: "external_effect",
      }),
    ).rejects.toThrow("injected operator action fault");
    await expect(
      executeConfirmedOperatorAction({
        ...base,
        now: "2026-07-30T10:06:00.000Z",
      }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(effects).toBe(1);
    expect(ledger.read(intent.operation_id)?.state).toBe("responded");
  });

  it("atomically consumes one confirmation id across operations", async () => {
    const root = temporaryRoot("operator-confirmation-consumption");
    const firstIntent = restoreIntent();
    const firstIntentBody = ((
      { intent_hash, ...body }: typeof firstIntent,
    ) => {
      void intent_hash;
      return body;
    })(firstIntent);
    const secondBody = {
      ...firstIntentBody,
      operation_id: "restore_operation_2",
      nonce: "restore_nonce_2",
    };
    const secondIntent = OperationIntentSchema.parse({
      ...secondBody,
      intent_hash: canonicalSha256(secondBody),
    });
    const { privatePath, trust } = authorityFixture(root);
    const descriptor = openSync(privatePath, "r");
    const firstConfirmation =
      signOperatorConfirmationFromDescriptor({
        descriptor,
        intent: firstIntent,
        trust,
        confirmationId: "confirmation_reused_across_operations",
        issuedAt: "2026-07-30T10:00:01.000Z",
        expiresAt: "2026-07-30T10:04:00.000Z",
      });
    const secondConfirmation =
      signOperatorConfirmationFromDescriptor({
        descriptor,
        intent: secondIntent,
        trust,
        confirmationId: "confirmation_reused_across_operations",
        issuedAt: "2026-07-30T10:00:01.000Z",
        expiresAt: "2026-07-30T10:04:00.000Z",
      });
    closeSync(descriptor);
    const ledgerDirectory = join(root, "action-ledger");
    let effects = 0;
    const execute = (
      intent: typeof firstIntent,
      confirmation: typeof firstConfirmation,
    ) =>
      executeConfirmedOperatorAction({
        intent,
        confirmation,
        trust,
        now: "2026-07-30T10:02:00.000Z",
        ledger: new OperatorActionLedger(ledgerDirectory),
        validateCurrentState: () => undefined,
        prepareEffectDigest: () => HASH_A,
        reconcileEffect: async () => null,
        effect: async () => {
          effects += 1;
          return { status: "completed" };
        },
        recordReceipt: async (receipt) => receipt,
      });
    await execute(firstIntent, firstConfirmation);
    await expect(
      execute(secondIntent, secondConfirmation),
    ).rejects.toThrow("operator confirmation replay is invalid");
    expect(effects).toBe(1);
  });

  it("rejects forged, stale, revoked, cross-target, and double-submitted grants before effect", async () => {
    const root = temporaryRoot("operator-confirmation-rejection");
    const intent = restoreIntent();
    const { privatePath, trust } = authorityFixture(root);
    const descriptor = openSync(privatePath, "r");
    const confirmation = signOperatorConfirmationFromDescriptor({
      descriptor,
      intent,
      trust,
      confirmationId: "restore_confirmation_reject",
      issuedAt: "2026-07-30T10:00:01.000Z",
      expiresAt: "2026-07-30T10:04:00.000Z",
    });
    closeSync(descriptor);
    let effects = 0;
    const base = {
      intent,
      confirmation,
      trust,
      now: "2026-07-30T10:02:00.000Z",
      ledger: new OperatorActionLedger(join(root, "action-ledger")),
      validateCurrentState: () => undefined,
      prepareEffectDigest: () => HASH_A,
      reconcileEffect: async () => null,
      effect: async () => {
        effects += 1;
        return { status: "completed" };
      },
      recordReceipt: async (receipt: OperatorActionReceipt) => receipt,
    };
    for (const changed of [
      {
        ...base,
        confirmation: {
          ...confirmation,
          signature: "a".repeat(86),
        },
      },
      {
        ...base,
        now: "2026-07-30T10:05:00.000Z",
      },
      {
        ...base,
        trust: {
          ...trust,
          revoked_key_ids: [trust.authority_key_id],
        },
      },
      {
        ...base,
        intent: {
          ...intent,
          target_ref:
            OperationIntentSchema.shape.target_ref.parse(
              "another_target",
            ),
        },
      },
    ]) {
      await expect(
        executeConfirmedOperatorAction(changed),
      ).rejects.toThrow();
    }
    expect(effects).toBe(0);

    const concurrent = await Promise.allSettled([
      executeConfirmedOperatorAction(base),
      executeConfirmedOperatorAction(base),
    ]);
    expect(
      concurrent.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    expect(effects).toBe(1);
    const stored = base.ledger.read(intent.operation_id);
    expect(stored?.record_hash).toBe(
      canonicalSha256Omitting(stored, ["record_hash"]),
    );
  });

  it("revalidates signed state before preparation and immediately before effect", async () => {
    const root = temporaryRoot("operator-state-drift");
    const intent = restoreIntent();
    const { privatePath, trust } = authorityFixture(root);
    const descriptor = openSync(privatePath, "r");
    const confirmation = signOperatorConfirmationFromDescriptor({
      descriptor,
      intent,
      trust,
      confirmationId: "restore_confirmation_state_drift",
      issuedAt: "2026-07-30T10:00:01.000Z",
      expiresAt: "2026-07-30T10:04:00.000Z",
    });
    closeSync(descriptor);
    let validations = 0;
    let effects = 0;
    await expect(
      executeConfirmedOperatorAction({
        intent,
        confirmation,
        trust,
        now: "2026-07-30T10:02:00.000Z",
        ledger: new OperatorActionLedger(join(root, "action-ledger")),
        validateCurrentState: () => {
          validations += 1;
          if (validations === 2) {
            throw new Error("operator action state binding changed");
          }
        },
        prepareEffectDigest: () => HASH_A,
        reconcileEffect: async () => null,
        effect: async () => {
          effects += 1;
          return { status: "completed" };
        },
        recordReceipt: async (receipt) => receipt,
      }),
    ).rejects.toThrow("operator action state binding changed");
    expect(validations).toBe(2);
    expect(effects).toBe(0);
  });

  it("recovers exact stale locks and never removes a live writer temp during construction", async () => {
    const root = temporaryRoot("operator-stale-lock");
    const ledgerDirectory = join(root, "action-ledger");
    const ledger = new OperatorActionLedger(ledgerDirectory);
    const lockPath = join(ledgerDirectory, "restore_operation_1.lock");
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        schema_version: "1.0.0",
        operation_id: "restore_operation_1",
        process_id: 424242,
        acquired_at: NOW,
      })}\n`,
      { mode: 0o600 },
    );
    expect(() =>
      ledger.recoverStaleLock({
        operationId: "restore_operation_1",
        expectedProcessId: 424242,
        ownerNotLive: () => false,
        now: "2026-07-30T10:10:00.000Z",
        minimumAgeMs: 300_000,
      }),
    ).toThrow("operator action lock recovery is invalid");
    expect(existsSync(lockPath)).toBe(true);
    expect(() =>
      ledger.recoverStaleLock({
        operationId: "restore_operation_1",
        expectedProcessId: 424242,
        ownerNotLive: () => true,
        now: "2026-07-30T10:01:00.000Z",
        minimumAgeMs: 300_000,
      }),
    ).toThrow("operator action lock recovery is invalid");
    ledger.recoverStaleLock({
      operationId: "restore_operation_1",
      expectedProcessId: 424242,
      ownerNotLive: () => true,
      now: "2026-07-30T10:10:00.000Z",
      minimumAgeMs: 300_000,
    });
    expect(existsSync(lockPath)).toBe(false);

    const confirmationLockPath = join(
      ledgerDirectory,
      "confirmation.restore_confirmation_1.lock",
    );
    writeFileSync(
      confirmationLockPath,
      `${JSON.stringify({
        schema_version: "1.0.0",
        operation_id: "confirmation:restore_confirmation_1",
        process_id: 424243,
        acquired_at: NOW,
      })}\n`,
      { mode: 0o600 },
    );
    const confirmationTemp = join(
      ledgerDirectory,
      ".confirmation.restore_confirmation_1.tmp",
    );
    writeFileSync(confirmationTemp, "{}\n", { mode: 0o600 });
    expect(() =>
      ledger.recoverStaleConfirmationLock({
        confirmationId: "restore_confirmation_1",
        expectedProcessId: 424243,
        ownerNotLive: () => false,
        now: "2026-07-30T10:10:00.000Z",
        minimumAgeMs: 300_000,
      }),
    ).toThrow("operator confirmation lock recovery is invalid");
    ledger.recoverStaleConfirmationLock({
      confirmationId: "restore_confirmation_1",
      expectedProcessId: 424243,
      ownerNotLive: () => true,
      now: "2026-07-30T10:10:00.000Z",
      minimumAgeMs: 300_000,
    });
    expect(existsSync(confirmationLockPath)).toBe(false);
    expect(existsSync(confirmationTemp)).toBe(false);

    const orphan = join(
      ledgerDirectory,
      ".restore_operation_1.2.tmp",
    );
    writeFileSync(orphan, "{}\n", { mode: 0o600 });
    new OperatorActionLedger(ledgerDirectory);
    expect(existsSync(orphan)).toBe(true);
    await new OperatorActionLedger(ledgerDirectory).withLock(
      "restore_operation_1",
      async () => {
        expect(existsSync(orphan)).toBe(false);
      },
    );
  });

  it("binds key-rotation capability to one durable signed plan and blocks direct production mutation", async () => {
    const root = temporaryRoot("operator-key-capability");
    const dataRoot = join(root, "data");
    const descriptorPaths = [
      "old-key",
      "new-key",
      "old-authority",
      "new-authority",
      "new-commitment",
    ].map((name, index) => {
      const path = join(root, `${name}.key`);
      writeFileSync(path, Buffer.alloc(32, index + 1), {
        mode: 0o600,
      });
      return path;
    });
    const descriptors = descriptorPaths.map((path) => openSync(path, "r"));
    const [
      oldKeyDescriptor,
      newKeyDescriptor,
      oldAuthorityDescriptor,
      newAuthorityDescriptor,
      newCommitmentDescriptor,
    ] = descriptors as [number, number, number, number, number];
    const begin = {
      rotation_id: "rotation_confirmed_plan_1",
      new_key_id: "key_generation_2",
      new_key_generation: 2,
      new_key_descriptor: newKeyDescriptor,
      new_authority_key_id: "authority_generation_2",
      new_authority_descriptor: newAuthorityDescriptor,
      new_commitment_key_id: "commitment_generation_2",
      new_commitment_descriptor: newCommitmentDescriptor,
    };
    const resume = {
      old_key_descriptor: oldKeyDescriptor,
      new_key_descriptor: newKeyDescriptor,
      old_authority_descriptor: oldAuthorityDescriptor,
      new_commitment_descriptor: newCommitmentDescriptor,
      max_items: 10,
    };
    const parameters = operatorKeyRotationParameters({ begin, resume });
    const intentBody = {
      schema_version: "1.0.0" as const,
      operation_id: "key_rotation_operation_1",
      command: "key_rotate" as const,
      principal_id: "user_local",
      root_ref: "root_primary",
      source_ref: begin.rotation_id,
      target_ref: begin.new_key_id,
      recovery_anchor_hash: HASH_A,
      configuration_digest: HASH_B,
      key_state_digest: HASH_A,
      expected_state_digest: HASH_B,
      expected_frontier_digest: HASH_A,
      parameters_digest: canonicalSha256(parameters),
      nonce: "key_rotation_nonce_1",
      issued_at: NOW,
      expires_at: "2026-07-30T10:05:00.000Z",
    };
    const intent = OperationIntentSchema.parse({
      ...intentBody,
      intent_hash: canonicalSha256(intentBody),
    });
    const { privatePath, trust } = authorityFixture(root);
    const signer = openSync(privatePath, "r");
    const confirmation = signOperatorConfirmationFromDescriptor({
      descriptor: signer,
      intent,
      trust,
      confirmationId: "key_rotation_confirmation_1",
      issuedAt: "2026-07-30T10:00:01.000Z",
      expiresAt: "2026-07-30T10:04:00.000Z",
    });
    closeSync(signer);
    let storage = await SqliteStorageClient.open({ dataRoot });
    await expect(
      storage.darkLaunchBeginKeyRotation(begin),
    ).rejects.toMatchObject({ code: "ENCRYPTION_REQUIRED" });
    await expect(
      storage.authorizeOperatorKeyRotation({
        intent,
        confirmation,
        trust,
        now: "2026-07-30T10:02:00.000Z",
        begin: { ...begin, new_key_id: "arbitrary_key" },
        resume,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const capability = await storage.authorizeOperatorKeyRotation({
        intent,
        confirmation,
        trust,
        now: "2026-07-30T10:02:00.000Z",
        begin,
        resume,
      });
    expect(capability).toMatchObject({
      purpose: "confirmed_operator_key_rotation",
    });
    const mutableDescriptorPath = descriptorPaths[1];
    if (mutableDescriptorPath === undefined) {
      throw new Error("key rotation fixture requires a mutable descriptor");
    }
    writeFileSync(mutableDescriptorPath, Buffer.alloc(32, 0x7f), {
      mode: 0o600,
    });
    await expect(capability.begin()).rejects.toMatchObject({
      code: "KEY_PROVIDER_INVALID",
    });
    writeFileSync(mutableDescriptorPath, Buffer.alloc(32, 2), {
      mode: 0o600,
    });
    await storage.close();
    storage = await SqliteStorageClient.open({ dataRoot });
    await expect(
      storage.authorizeOperatorKeyRotation({
        intent,
        confirmation,
        trust,
        now: "2026-07-30T10:02:00.000Z",
        begin,
        resume,
      }),
    ).resolves.toMatchObject({
      purpose: "confirmed_operator_key_rotation",
    });
    await storage.close();
    for (const descriptor of descriptors) {
      closeSync(descriptor);
    }
  });
});
