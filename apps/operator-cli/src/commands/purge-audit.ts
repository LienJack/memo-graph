import {
  OperationIntentSchema,
  canonicalSha256,
  type ArtifactPurgeAudit,
  type OperationIntent,
  type OperatorConfirmation,
  type OperatorConfirmationTrust,
  type PurgeReceipt,
} from "@memo-graph/contracts";
import type {
  SqliteStorageClient} from "@memo-graph/storage-sqlite";
import {
  type AuditPurgeArtifactsInput,
} from "@memo-graph/storage-sqlite";

import type {
  OperatorActionLedger} from "../operator-action-ledger.js";
import {
  executeConfirmedOperatorAction,
  type ContentFreeOperatorResult,
} from "../operator-action-ledger.js";

function contentFreePurgeResult(
  receipt: PurgeReceipt,
): ContentFreeOperatorResult {
  return {
    status: receipt.completed ? "completed" : receipt.state,
    purge_job_id: receipt.purge_job_id,
    purge_receipt_id: receipt.receipt_id,
    purge_receipt_hash: receipt.receipt_hash,
    completed: receipt.completed,
    residual_count: receipt.residual_hashes.length,
  };
}

export function runPurgeAudit(
  storage: SqliteStorageClient,
  input: AuditPurgeArtifactsInput,
): Promise<ArtifactPurgeAudit> {
  return storage.auditPurgeArtifacts(input);
}

export async function purgeRetryStateBindings(
  storage: SqliteStorageClient,
  input: {
    purgeJobId: string;
    expectedPriorReceiptId: string | null;
  },
): Promise<
  Pick<
    OperationIntent,
    | "recovery_anchor_hash"
    | "configuration_digest"
    | "key_state_digest"
    | "expected_state_digest"
    | "expected_frontier_digest"
  >
> {
  const health = await storage.health();
  const prior = await storage.inspectPurgeReceipt({
    purge_job_id: input.purgeJobId,
  });
  if (prior?.receipt_id !== input.expectedPriorReceiptId) {
    throw new Error("purge retry prior receipt binding changed");
  }
  return {
    recovery_anchor_hash:
      OperationIntentSchema.shape.recovery_anchor_hash.parse(
        storage.recoveryHeadProvider.readCurrent()?.anchor_hash ?? null,
      ),
    configuration_digest:
      OperationIntentSchema.shape.configuration_digest.parse(
        canonicalSha256({
          schema_version: health.schema_version,
          migrations: health.migrations,
        }),
      ),
    key_state_digest: OperationIntentSchema.shape.key_state_digest.parse(
      canonicalSha256(health.encryption),
    ),
    expected_state_digest:
      OperationIntentSchema.shape.expected_state_digest.parse(
        canonicalSha256({
          schema_version: health.schema_version,
          ledger_epoch: health.ledger_epoch,
          tombstone_epoch: health.tombstone_epoch,
          latest_receipt_hash: health.latest_receipt_hash,
          projection_state: health.projection_state,
          layered_projection_state: health.layered_projection_state,
          projection_frontier: health.projection_frontier,
          learning_frontier: health.learning_frontier,
          counts: health.counts,
          recovery: health.recovery,
        }),
      ),
    expected_frontier_digest:
      OperationIntentSchema.shape.expected_frontier_digest.parse(
        canonicalSha256({
          ledger_epoch: health.ledger_epoch,
          tombstone_epoch: health.tombstone_epoch,
          latest_receipt_hash: health.latest_receipt_hash,
          purge_job_id: input.purgeJobId,
          expected_prior_receipt_id: input.expectedPriorReceiptId,
          expected_prior_receipt_hash: prior?.receipt_hash ?? null,
        }),
      ),
  };
}

export function runConfirmedPurgeRetry(input: {
  storage: SqliteStorageClient;
  purgeJobId: string;
  intent: OperationIntent;
  confirmation: OperatorConfirmation;
  trust: OperatorConfirmationTrust;
  now: string;
  ledger: OperatorActionLedger;
  testFaultAfter?:
    | "authorized"
    | "effect_prepared"
    | "external_effect"
    | "effect_committed"
    | "receipt_committed"
    | "responded";
}): Promise<ContentFreeOperatorResult> {
  if (input.intent.command !== "purge_retry") {
    throw new Error("purge retry intent is invalid");
  }
  const expectedPriorReceiptId = input.intent.target_ref;
  if (
    input.intent.source_ref !== input.purgeJobId ||
    expectedPriorReceiptId === null ||
    input.intent.parameters_digest !==
      canonicalSha256({
        purge_job_id: input.purgeJobId,
        expected_prior_receipt_id: expectedPriorReceiptId,
      })
  ) {
    throw new Error("purge retry target binding is invalid");
  }
  const validateCurrentState = async () => {
    const current = await purgeRetryStateBindings(input.storage, {
      purgeJobId: input.purgeJobId,
      expectedPriorReceiptId,
    });
    for (const key of [
      "recovery_anchor_hash",
      "configuration_digest",
      "key_state_digest",
      "expected_state_digest",
      "expected_frontier_digest",
    ] as const) {
      if (current[key] !== input.intent[key]) {
        throw new Error(`purge retry ${key} binding changed`);
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
        command: "purge_retry",
        purge_job_id: input.purgeJobId,
        expected_frontier_digest:
          input.intent.expected_frontier_digest,
      }),
    reconcileEffect: async () => {
      const receipt = await input.storage.inspectPurgeReceipt({
        purge_job_id: input.purgeJobId,
        operator_operation_id: input.intent.operation_id,
      });
      return receipt === null ? null : contentFreePurgeResult(receipt);
    },
    effect: async () =>
      contentFreePurgeResult(
        await input.storage.runPurge({
          purge_job_id: input.purgeJobId,
          operator_action: {
            operation_id: input.intent.operation_id,
            expected_prior_receipt_id: expectedPriorReceiptId,
          },
        }),
      ),
    recordReceipt: (receipt) =>
      input.storage.appendOperatorActionReceipt(receipt),
    ...(input.testFaultAfter === undefined
      ? {}
      : { testFaultAfter: input.testFaultAfter }),
  });
}
