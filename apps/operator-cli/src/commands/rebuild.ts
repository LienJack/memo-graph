import {
  OperationIntentSchema,
  ProjectionRebuildDryRunResultSchema,
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
  return ProjectionRebuildDryRunResultSchema.parse({
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
  });
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

async function repairAlreadyOwnsStateDrift(input: {
  storage: SqliteStorageClient;
  intent: OperationIntent;
  repairKind: "fts" | "layered_projection" | "sqlite_relations";
  principalId: string | null;
  scope: Scope | null;
}): Promise<boolean> {
  const existing = await input.storage.inspectOperationalRepair({
    operation_id: input.intent.operation_id,
  });
  return (
    existing?.state === "rebuilding" &&
    existing.repair_kind === input.repairKind &&
    existing.source === "canonical_sqlite" &&
    existing.principal_id === input.principalId &&
    canonicalSha256(existing.scope) === canonicalSha256(input.scope) &&
    existing.source_frontier_hash ===
      input.intent.expected_frontier_digest
  );
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
          learning_frontier: health.learning_frontier,
          canonical_counts: {
            evidence_events: health.counts.evidence_events,
            episodes: health.counts.episodes,
            mutation_receipts: health.counts.mutation_receipts,
            idempotency_keys: health.counts.idempotency_keys,
            outbox_pending: health.counts.outbox_pending,
            backup_manifests: health.counts.backup_manifests,
            recall_requests: health.counts.recall_requests,
            retrieval_receipts: health.counts.retrieval_receipts,
            context_slices: health.counts.context_slices,
            receipt_access_scopes: health.counts.receipt_access_scopes,
            learning_traces: health.counts.learning_traces,
            learning_candidates: health.counts.learning_candidates,
            learning_transitions: health.counts.learning_transitions,
            learning_evaluation_runs:
              health.counts.learning_evaluation_runs,
            learning_canary_runs: health.counts.learning_canary_runs,
            learning_release_versions:
              health.counts.learning_release_versions,
            learning_release_pointers:
              health.counts.learning_release_pointers,
            learning_monitor_results:
              health.counts.learning_monitor_results,
            learning_control_rows: health.counts.learning_control_rows,
            learning_receipts: health.counts.learning_receipts,
            encryption_keys: health.counts.encryption_keys,
            encrypted_contents: health.counts.encrypted_contents,
            secret_nonce_reservations:
              health.counts.secret_nonce_reservations,
            key_rotations: health.counts.key_rotations,
            encrypted_artifact_operations:
              health.counts.encrypted_artifact_operations,
            operational_receipts: health.counts.operational_receipts,
            artifact_store_registry:
              health.counts.artifact_store_registry,
            memory_candidates: health.counts.memory_candidates,
            memory_objects: health.counts.memory_objects,
            memory_revisions: health.counts.memory_revisions,
            admission_decisions: health.counts.admission_decisions,
            conflict_groups: health.counts.conflict_groups,
            status_events: health.counts.status_events,
            pin_events: health.counts.pin_events,
            usage_rules: health.counts.usage_rules,
            memory_tombstones: health.counts.memory_tombstones,
            purge_jobs: health.counts.purge_jobs,
            purge_store_outcomes: health.counts.purge_store_outcomes,
            purge_receipts: health.counts.purge_receipts,
            approval_consumptions: health.counts.approval_consumptions,
          },
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
    const ownsRepairDrift = await repairAlreadyOwnsStateDrift({
        storage: input.storage,
        intent: input.intent,
        repairKind: "fts",
        principalId: null,
        scope: null,
      });
    const current = await rebuildStateBindings(input.storage);
    const keys = ownsRepairDrift
      ? ([
          "configuration_digest",
          "key_state_digest",
          "expected_state_digest",
        ] as const)
      : ([
          "recovery_anchor_hash",
          "configuration_digest",
          "key_state_digest",
          "expected_state_digest",
          "expected_frontier_digest",
        ] as const);
    for (const key of keys) {
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
      return existing?.state === "completed" &&
        existing.repair_kind === "fts" &&
        existing.principal_id === null &&
        existing.scope === null &&
        existing.source_frontier_hash ===
          input.intent.expected_frontier_digest
        ? repairResult(existing)
        : null;
    },
    effect: async () =>
      repairResult(
        await input.storage.repairFts({
          operation_id: input.intent.operation_id,
          repair_kind: "fts",
          source: "canonical_sqlite",
          principal_id: null,
          scope: null,
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
    const ownsRepairDrift = await repairAlreadyOwnsStateDrift({
        storage: input.storage,
        intent: input.intent,
        repairKind: input.repairKind,
        principalId: input.principalId,
        scope: input.scope,
      });
    const current = await rebuildStateBindings(input.storage);
    const keys = ownsRepairDrift
      ? ([
          "configuration_digest",
          "key_state_digest",
          "expected_state_digest",
        ] as const)
      : ([
          "recovery_anchor_hash",
          "configuration_digest",
          "key_state_digest",
          "expected_state_digest",
          "expected_frontier_digest",
        ] as const);
    for (const key of keys) {
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
      return existing?.state === "completed" &&
        existing.repair_kind === input.repairKind &&
        existing.principal_id === input.principalId &&
        canonicalSha256(existing.scope) === canonicalSha256(input.scope) &&
        existing.source_frontier_hash ===
          input.intent.expected_frontier_digest
        ? repairResult(existing)
        : null;
    },
    effect: async () => {
      const command = {
        operation_id: input.intent.operation_id,
        repair_kind: input.repairKind,
        source: "canonical_sqlite" as const,
        principal_id: input.principalId,
        scope: input.scope,
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
