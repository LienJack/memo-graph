import {
  OperationIntentSchema,
  canonicalSha256,
  scopeKey,
  type OperationIntent,
  type OperatorConfirmation,
  type OperatorConfirmationTrust,
} from "@memo-graph/contracts";
import {
  LearningReleaseInputSchema,
  type LearningReleaseInput,
  type LearningReleaseManager,
} from "@memo-graph/learning-lab";
import type {
  SqliteStorageClient,
} from "@memo-graph/storage-sqlite";

import type {
  OperatorActionLedger} from "../operator-action-ledger.js";
import {
  executeConfirmedOperatorAction,
} from "../operator-action-ledger.js";

export function learningRollbackVerification(input: {
  releaseRef: string;
}) {
  return {
    schema_version: "1.0.0" as const,
    operation: "learning.rollback" as const,
    status: "operator_action_required" as const,
    publication: "confirmation_required" as const,
    release_ref: input.releaseRef,
    parameters_digest: canonicalSha256({
      release_ref: input.releaseRef,
    }),
  };
}

export async function learningRollbackStateBindings(
  storage: SqliteStorageClient,
  learningRegistryHash: `sha256:${string}`,
) {
  const health = await storage.health();
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
          learning_registry_hash: learningRegistryHash,
        }),
      ),
    key_state_digest: OperationIntentSchema.shape.key_state_digest.parse(
      canonicalSha256(health.encryption),
    ),
    expected_state_digest:
      OperationIntentSchema.shape.expected_state_digest.parse(
        canonicalSha256({
          ledger_epoch: health.ledger_epoch,
          tombstone_epoch: health.tombstone_epoch,
          learning_frontier: health.learning_frontier,
          projection_frontier: health.projection_frontier,
          recovery: health.recovery,
        }),
      ),
    expected_frontier_digest:
      OperationIntentSchema.shape.expected_frontier_digest.parse(
        canonicalSha256(health.learning_frontier),
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

export function runConfirmedLearningRollback(input: {
  storage: SqliteStorageClient;
  manager: LearningReleaseManager;
  learningRegistryHash: `sha256:${string}`;
  request: LearningReleaseInput;
  intent: OperationIntent;
  confirmation: OperatorConfirmation;
  trust: OperatorConfirmationTrust;
  now: string;
  ledger: OperatorActionLedger;
}) {
  const parsed = LearningReleaseInputSchema.parse(input.request);
  if (parsed.test_failure_point !== undefined) {
    throw new Error("operator rollback cannot select a test fault");
  }
  const request = LearningReleaseInputSchema.parse({
    ...parsed,
    scopes: [...parsed.scopes].sort((left, right) =>
      scopeKey(left).localeCompare(scopeKey(right))
    ),
  });
  const requestHash = canonicalSha256(request);
  if (
    request.action !== "rollback" ||
    request.target_release_id === null ||
    input.intent.command !== "learning_rollback" ||
    input.intent.principal_id !== request.principal_id ||
    input.intent.source_ref !== request.candidate_id ||
    input.intent.target_ref !== request.target_release_id ||
    input.intent.parameters_digest !== requestHash
  ) {
    throw new Error("learning rollback intent binding is invalid");
  }
  const validateCurrentState = async () => {
    const current = await learningRollbackStateBindings(
      input.storage,
      input.learningRegistryHash,
    );
    for (const key of [
      "recovery_anchor_hash",
      "configuration_digest",
      "key_state_digest",
      "expected_state_digest",
      "expected_frontier_digest",
    ] as const) {
      if (current[key] !== input.intent[key]) {
        throw new Error(`learning rollback ${key} binding changed`);
      }
    }
  };
  const contentResult = (receipt: {
    receipt_id: string;
    receipt_hash: string;
  }) => ({
    status: "completed",
    action: "rollback",
    candidate_id: request.candidate_id,
    target_release_id: request.target_release_id,
    rollback_receipt_id: receipt.receipt_id,
    rollback_receipt_hash: receipt.receipt_hash,
  });
  return executeConfirmedOperatorAction({
    intent: input.intent,
    confirmation: input.confirmation,
    trust: input.trust,
    now: input.now,
    ledger: input.ledger,
    validateCurrentState,
    prepareEffectDigest: () => requestHash,
    reconcileEffect: async () => {
      const replay = await input.storage.replayLearningLedger({
        idempotency_key: request.idempotency_key,
        idempotency_hash:
          OperationIntentSchema.shape.parameters_digest.parse(requestHash),
      });
      return replay?.kind === "rollback" && replay.receipt !== null
        ? contentResult(replay.receipt)
        : null;
    },
    effect: async () => {
      const result = await input.manager.apply(request, {
        requestHash,
      });
      return contentResult(result.receipt);
    },
    recordReceipt: (receipt) =>
      input.storage.appendOperatorActionReceipt(receipt),
  });
}
