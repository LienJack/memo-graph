import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  OperationIntentSchema,
  canonicalSha256,
  type OperationIntent,
  type OperatorActionReceipt,
  type OperatorConfirmation,
  type OperatorConfirmationTrust,
} from "@memo-graph/contracts";
import {
  inspectRestorePublication,
  restoreBackupToEmptyDataRoot,
  type BackupResult,
  type RecoveryHeadProvider,
} from "@memo-graph/storage-sqlite";

import type {
  OperatorActionLedger} from "../operator-action-ledger.js";
import {
  executeConfirmedOperatorAction,
} from "../operator-action-ledger.js";
import { inspectBackup } from "./backup.js";

export function restoreDryRun(input: {
  backupDirectory: string;
  backupRef: string;
  targetRef: string;
}) {
  const inspection = inspectBackup(input.backupDirectory);
  return {
    schema_version: "1.0.0" as const,
    status: "operator_action_required" as const,
    publication: "confirmation_required" as const,
    backup_id: inspection.backup_id,
    manifest_hash: inspection.manifest_hash,
    intent_digest: canonicalSha256({
      operation: "restore",
      backup_ref: input.backupRef,
      target_ref: input.targetRef,
      manifest_hash: inspection.manifest_hash,
    }),
  };
}

export function restoreStateBindings(input: {
  backup: BackupResult;
  target: string;
  targetRef: string;
  recoveryHeadProvider: RecoveryHeadProvider;
}) {
  const current = input.recoveryHeadProvider.readCurrent();
  const manifest = input.backup.manifest;
  return {
    recovery_anchor_hash:
      OperationIntentSchema.shape.recovery_anchor_hash.parse(
        current?.anchor_hash ?? null,
      ),
    configuration_digest:
      OperationIntentSchema.shape.configuration_digest.parse(
        canonicalSha256({
          manifest_schema_version: manifest.schema_version,
          database_schema: manifest.schema,
          target_ref: input.targetRef,
          target_path: resolve(input.target),
        }),
      ),
    key_state_digest: OperationIntentSchema.shape.key_state_digest.parse(
      canonicalSha256(manifest.encryption),
    ),
    expected_state_digest:
      OperationIntentSchema.shape.expected_state_digest.parse(
        canonicalSha256({
          manifest_hash: manifest.manifest_hash,
          frontiers: manifest.frontiers,
          recovery_anchor_hash: current?.anchor_hash ?? null,
          target_state: existsSync(input.target) ? "occupied" : "absent",
        }),
      ),
    expected_frontier_digest:
      OperationIntentSchema.shape.expected_frontier_digest.parse(
        canonicalSha256(manifest.frontiers),
      ),
  } satisfies Pick<
    OperationIntent,
    | "recovery_anchor_hash"
    | "configuration_digest"
    | "key_state_digest"
    | "expected_state_digest"
    | "expected_frontier_digest"
  >;
}

export function runConfirmedRestore(input: {
  backup: BackupResult;
  backupRef: string;
  target: string;
  targetRef: string;
  recoveryHeadProvider: RecoveryHeadProvider;
  requiredKeyDescriptors?: Readonly<Record<string, number>>;
  intent: OperationIntent;
  confirmation: OperatorConfirmation;
  trust: OperatorConfirmationTrust;
  now: string;
  ledger: OperatorActionLedger;
  recordReceipt: (receipt: OperatorActionReceipt) => Promise<unknown>;
  testFaultAfter?:
    | "authorized"
    | "effect_prepared"
    | "external_effect"
    | "effect_committed"
    | "receipt_committed"
    | "responded";
}) {
  const requiredKeys = input.backup.manifest.encryption.required_keys
    .map(({ key_id, key_generation, state }) => ({
      key_id,
      key_generation,
      state,
    }))
    .sort((left, right) => left.key_id.localeCompare(right.key_id));
  const requiredKeyIds = requiredKeys.map(({ key_id }) => key_id);
  const suppliedKeyIds = Object.keys(
    input.requiredKeyDescriptors ?? {},
  ).sort();
  if (
    canonicalSha256(requiredKeyIds) !== canonicalSha256(suppliedKeyIds) ||
    input.intent.command !== "restore" ||
    input.intent.source_ref !== input.backupRef ||
    input.intent.target_ref !== input.targetRef ||
    input.intent.parameters_digest !==
      canonicalSha256({
        backup_ref: input.backupRef,
        backup_id: input.backup.backup_id,
        manifest_hash: input.backup.manifest.manifest_hash,
        target_ref: input.targetRef,
        required_keys: requiredKeys,
      })
  ) {
    throw new Error("restore intent target binding is invalid");
  }
  const validateCurrentState = async () => {
    const current = restoreStateBindings(input);
    for (const key of [
      "recovery_anchor_hash",
      "configuration_digest",
      "key_state_digest",
      "expected_state_digest",
      "expected_frontier_digest",
    ] as const) {
      if (current[key] !== input.intent[key]) {
        throw new Error(`restore ${key} binding changed`);
      }
    }
  };
  return executeConfirmedOperatorAction({
    intent: input.intent,
    confirmation: input.confirmation,
    trust: input.trust,
    now: input.now,
    ledger: input.ledger,
    validateCurrentState,
    prepareEffectDigest: () =>
      canonicalSha256({
        command: "restore",
        operation_id: input.intent.operation_id,
        manifest_hash: input.backup.manifest.manifest_hash,
        target_ref: input.targetRef,
      }),
    reconcileEffect: async () => {
      const current = input.recoveryHeadProvider.readCurrent();
      if (
        current === null ||
        !inspectRestorePublication({
          dataRoot: input.target,
          operationId: input.intent.operation_id,
          manifestHash: input.backup.manifest.manifest_hash,
          recoveryAnchorHash: current.anchor_hash,
        })
      ) {
        return null;
      }
      const restored = await restoreBackupToEmptyDataRoot({
        backup: input.backup,
        dataRoot: input.target,
        operationId: input.intent.operation_id,
        recoveryHeadProvider: input.recoveryHeadProvider,
        ...(input.requiredKeyDescriptors === undefined
          ? {}
          : {
              requiredKeyDescriptors:
                input.requiredKeyDescriptors,
            }),
      });
      return {
        status: "published",
        publication: restored.publication,
        operation_id: input.intent.operation_id,
        backup_id: input.backup.backup_id,
        manifest_hash: input.backup.manifest.manifest_hash,
        recovery_generation: restored.recovery_generation,
        recovery_anchor_hash: restored.recovery_anchor_hash,
        verified_blobs: restored.verified_blobs,
      };
    },
    effect: async () => {
      const restored = await restoreBackupToEmptyDataRoot({
        backup: input.backup,
        dataRoot: input.target,
        operationId: input.intent.operation_id,
        recoveryHeadProvider: input.recoveryHeadProvider,
        ...(input.requiredKeyDescriptors === undefined
          ? {}
          : {
              requiredKeyDescriptors:
                input.requiredKeyDescriptors,
            }),
      });
      return {
        status: "published",
        publication: restored.publication,
        operation_id: input.intent.operation_id,
        backup_id: input.backup.backup_id,
        manifest_hash: input.backup.manifest.manifest_hash,
        recovery_generation: restored.recovery_generation,
        recovery_anchor_hash: restored.recovery_anchor_hash,
        verified_blobs: restored.verified_blobs,
      };
    },
    recordReceipt: input.recordReceipt,
    ...(input.testFaultAfter === undefined
      ? {}
      : { testFaultAfter: input.testFaultAfter }),
  });
}
