import {
  OperationIntentSchema,
  canonicalSha256,
  type OperationIntent,
  type OperatorConfirmation,
  type OperatorConfirmationTrust,
} from "@memo-graph/contracts";
import type {
  SqliteStorageClient} from "@memo-graph/storage-sqlite";
import {
  type OperationalRepairResult,
} from "@memo-graph/storage-sqlite";
import {
  ConsolidationService,
} from "@memo-graph/memory-kernel";
import type { Scope } from "@memo-graph/contracts";

import type {
  OperatorActionLedger} from "../operator-action-ledger.js";
import {
  executeConfirmedOperatorAction,
  type ContentFreeOperatorResult,
} from "../operator-action-ledger.js";

export function rebuildDryRun(input: {
  repairKind: "fts" | "layered_projection" | "sqlite_relations";
}) {
  return {
    schema_version: "1.0.0" as const,
    operation: "projection.rebuild" as const,
    status: "operator_action_required" as const,
    source: "canonical_sqlite" as const,
    repair_kind: input.repairKind,
    publication: "confirmation_required" as const,
    parameters_digest: canonicalSha256({
      repair_kind: input.repairKind,
      source: "canonical_sqlite",
    }),
  };
}

function repairResult(
  result: OperationalRepairResult,
): ContentFreeOperatorResult {
  return {
    status: result.state,
    operation_id: result.operation_id,
    repair_kind: result.repair_kind,
    source: result.source,
    result_hash: result.result_hash,
  };
}

export async function rebuildStateBindings(
  storage: SqliteStorageClient,
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
          projection_frontier: health.projection_frontier,
          counts: health.counts,
          recovery: health.recovery,
        }),
      ),
    expected_frontier_digest:
      OperationIntentSchema.shape.expected_frontier_digest.parse(
        canonicalSha256({
          ledger_epoch: health.ledger_epoch,
          tombstone_epoch: health.tombstone_epoch,
          projection_state: health.projection_state,
          projection_frontier: health.projection_frontier,
        }),
      ),
  };
}

export function runConfirmedFtsRebuild(input: {
  storage: SqliteStorageClient;
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
  if (
    input.intent.command !== "rebuild_fts" ||
    input.intent.source_ref !== "canonical_sqlite" ||
    input.intent.target_ref !== "fts" ||
    input.intent.parameters_digest !==
      canonicalSha256({
        repair_kind: "fts",
        source: "canonical_sqlite",
        target: "fts",
      })
  ) {
    throw new Error("projection rebuild intent is invalid");
  }
  const validateCurrentState = async () => {
    const current = await rebuildStateBindings(input.storage);
    for (const key of [
      "recovery_anchor_hash",
      "configuration_digest",
      "key_state_digest",
      "expected_state_digest",
      "expected_frontier_digest",
    ] as const) {
      if (current[key] !== input.intent[key]) {
        throw new Error(`projection rebuild ${key} binding changed`);
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
        command: "rebuild_fts",
        source: "canonical_sqlite",
        target: "fts",
        expected_frontier_digest:
          input.intent.expected_frontier_digest,
      }),
    reconcileEffect: async () => {
      const existing = await input.storage.inspectOperationalRepair({
        operation_id: input.intent.operation_id,
      });
      return existing?.state === "completed"
        ? repairResult(existing)
        : null;
    },
    effect: async () =>
      repairResult(
        await input.storage.repairFts({
          operation_id: input.intent.operation_id,
          repair_kind: "fts",
          source: "canonical_sqlite",
          expected_frontier_hash:
            input.intent.expected_frontier_digest,
          started_at: input.intent.issued_at,
          completed_at: input.now,
        }),
      ),
    recordReceipt: (receipt) =>
      input.storage.appendOperatorActionReceipt(receipt),
    ...(input.testFaultAfter === undefined
      ? {}
      : { testFaultAfter: input.testFaultAfter }),
  });
}

export function runConfirmedCanonicalProjectionRebuild(input: {
  storage: SqliteStorageClient;
  repairKind: "layered_projection" | "sqlite_relations";
  principalId: string;
  scope: Scope;
  intent: OperationIntent;
  confirmation: OperatorConfirmation;
  trust: OperatorConfirmationTrust;
  now: string;
  ledger: OperatorActionLedger;
}): Promise<ContentFreeOperatorResult> {
  if (
    input.intent.command !== "rebuild_layered_projection" ||
    input.intent.source_ref !== "canonical_sqlite" ||
    input.intent.target_ref !== input.repairKind ||
    input.principalId !== input.intent.principal_id ||
    input.intent.parameters_digest !==
      canonicalSha256({
        repair_kind: input.repairKind,
        source: "canonical_sqlite",
        target: input.repairKind,
        principal_id: input.principalId,
        scope: input.scope,
      })
  ) {
    throw new Error("canonical projection rebuild intent is invalid");
  }
  const validateCurrentState = async () => {
    const current = await rebuildStateBindings(input.storage);
    for (const key of [
      "recovery_anchor_hash",
      "configuration_digest",
      "key_state_digest",
      "expected_state_digest",
      "expected_frontier_digest",
    ] as const) {
      if (current[key] !== input.intent[key]) {
        throw new Error(`projection rebuild ${key} binding changed`);
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
        command: "rebuild_layered_projection",
        repair_kind: input.repairKind,
        source: "canonical_sqlite",
        principal_id: input.principalId,
        scope: input.scope,
        expected_frontier_digest:
          input.intent.expected_frontier_digest,
      }),
    reconcileEffect: async () => {
      const existing = await input.storage.inspectOperationalRepair({
        operation_id: input.intent.operation_id,
      });
      return existing?.state === "completed"
        ? repairResult(existing)
        : null;
    },
    effect: async () => {
      const command = {
        operation_id: input.intent.operation_id,
        repair_kind: input.repairKind,
        source: "canonical_sqlite" as const,
        expected_frontier_hash:
          input.intent.expected_frontier_digest,
        started_at: input.intent.issued_at,
        completed_at: input.now,
      };
      const prepared =
        await input.storage.prepareOperationalRepair(command);
      if (prepared.state === "completed") {
        return repairResult(prepared);
      }
      const rebuilt = await new ConsolidationService({
        storage: input.storage,
      }).rebuild({
        principal_id: input.principalId,
        scope: input.scope,
        as_of: input.now,
        idempotency_key:
          `operator-rebuild:${input.intent.operation_id}`,
        rebuild_receipt_id:
          `operator-rebuild-receipt:${input.intent.operation_id}`,
      });
      const relationCount = rebuilt.projections.filter(
        ({ projection_type }) => projection_type === "relation",
      ).length;
      return repairResult(
        await input.storage.completeOperationalRepair({
          command,
          artifact_count:
            input.repairKind === "sqlite_relations"
              ? relationCount
              : rebuilt.projections.length,
          relation_count: relationCount,
          ledger_epoch: rebuilt.frontier.ledger_epoch,
        }),
      );
    },
    recordReceipt: (receipt) =>
      input.storage.appendOperatorActionReceipt(receipt),
  });
}
