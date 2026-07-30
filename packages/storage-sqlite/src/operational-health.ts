import {
  ReleaseQualificationSchema,
  reduceOperationalStatus,
  type OperationalObservation,
  type OperationalStatus,
  type ReleaseQualification,
} from "@memo-graph/contracts";

import { StorageError, type StorageErrorCode } from "./errors.js";
import type { StorageClientHealth } from "./client.js";

const PENDING_QUALIFICATION: ReleaseQualification =
  ReleaseQualificationSchema.parse({
    status: "pending",
    tested_envelope_digest: null,
  });

function projectionObservation(
  component: "fts" | "layered_projection",
  state: StorageClientHealth["projection_state"],
): OperationalObservation {
  const reason =
    component === "fts"
      ? ("FTS_UNAVAILABLE" as const)
      : ("LAYERED_PROJECTION_UNAVAILABLE" as const);
  const action =
    component === "fts"
      ? ("REBUILD_FTS" as const)
      : ("REBUILD_LAYERED_PROJECTION" as const);
  switch (state) {
    case "ready":
      return {
        component,
        state: "ready",
        reason_code: null,
        action_code: "NONE",
        measurements: [],
      };
    case "pending":
    case "rebuilding":
      return {
        component,
        state: "rebuilding",
        reason_code: reason,
        action_code: action,
        measurements: [],
      };
    case "unavailable":
      return {
        component,
        state: "degraded",
        reason_code: reason,
        action_code: action,
        measurements: [],
      };
  }
}

export function operationalStatusFromStorageHealth(
  health: StorageClientHealth,
  options?: {
    observedAt?: string;
    qualification?: ReleaseQualification;
  },
): OperationalStatus {
  const capacity = health.admission_observation;
  const queuePolicy = health.admission_policy;
  const queuePressured =
    queuePolicy !== null &&
    (health.writer_queue.depth >= queuePolicy.max_queue_depth ||
      health.writer_queue.oldest_age_ms >=
        queuePolicy.max_queue_age_ms);
  const activeMaintenance =
    capacity?.active_maintenance ??
    (health.writer_queue.active_operation === "canonical_write"
      ? null
      : health.writer_queue.active_operation);
  return reduceOperationalStatus({
    observed_at: options?.observedAt ?? new Date().toISOString(),
    qualification: options?.qualification ?? PENDING_QUALIFICATION,
    observations: [
      {
        component: "canonical_store",
        state: "ready",
        reason_code: null,
        action_code: "NONE",
        measurements: [
          {
            component: "canonical_store",
            name: "frontier",
            value: health.ledger_epoch,
            unit: "epoch",
          },
          {
            component: "canonical_store",
            name: "item_count",
            value: health.counts.evidence_events,
            unit: "count",
          },
        ],
      },
      {
        component: "migrations",
        state: "ready",
        reason_code: null,
        action_code: "NONE",
        measurements: [],
      },
      {
        component: "resource_capacity",
        state: health.admission_read_only ? "read_only" : "ready",
        reason_code:
          health.pressure_reason === "disk"
            ? "DISK_PRESSURE"
            : health.pressure_reason === "wal"
              ? "WAL_PRESSURE"
              : null,
        action_code:
          health.pressure_reason === "disk"
            ? "FREE_LOCAL_CAPACITY"
            : health.pressure_reason === "wal"
              ? "RUN_CHECKPOINT"
              : "NONE",
        measurements:
          capacity === null
            ? []
            : [
                {
                  component: "resource_capacity",
                  name: "available_bytes",
                  value: capacity.available_bytes,
                  unit: "bytes",
                },
                {
                  component: "resource_capacity",
                  name: "wal_bytes",
                  value: capacity.wal_bytes,
                  unit: "bytes",
                },
              ],
      },
      {
        component: "checkpoint",
        state:
          health.checkpoint_counters.busy > 0 ? "degraded" : "ready",
        reason_code:
          health.checkpoint_counters.busy > 0
            ? "CHECKPOINT_BLOCKED"
            : null,
        action_code:
          health.checkpoint_counters.busy > 0
            ? "RUN_CHECKPOINT"
            : "NONE",
        measurements: [
          {
            component: "checkpoint",
            name: "checkpoint_busy",
            value: health.checkpoint_counters.busy,
            unit: "count",
          },
          {
            component: "checkpoint",
            name: "checkpoint_log",
            value: health.checkpoint_counters.log,
            unit: "count",
          },
          {
            component: "checkpoint",
            name: "checkpointed",
            value: health.checkpoint_counters.checkpointed,
            unit: "count",
          },
        ],
      },
      {
        component: "writer_queue",
        state: queuePressured ? "degraded" : "ready",
        reason_code: queuePressured ? "QUEUE_PRESSURE" : null,
        action_code: queuePressured
          ? "WAIT_FOR_WRITER_CAPACITY"
          : "NONE",
        measurements: [
          {
            component: "writer_queue",
            name: "queue_depth",
            value: health.writer_queue.depth,
            unit: "count",
          },
          {
            component: "writer_queue",
            name: "queue_capacity",
            value: health.admission_policy?.max_queue_depth ?? 0,
            unit: "count",
          },
          {
            component: "writer_queue",
            name: "queue_oldest_age_ms",
            value: health.writer_queue.oldest_age_ms,
            unit: "milliseconds",
          },
          {
            component: "writer_queue",
            name: "queue_completed",
            value: health.writer_queue.completed,
            unit: "count",
          },
          {
            component: "writer_queue",
            name: "queue_rejected_pre_enqueue",
            value: health.writer_queue.rejected_pre_enqueue,
            unit: "count",
          },
          {
            component: "writer_queue",
            name: "queue_rejected_transaction_start",
            value: health.writer_queue.rejected_transaction_start,
            unit: "count",
          },
        ],
      },
      {
        component: "maintenance",
        state: activeMaintenance === null ? "ready" : "active",
        reason_code: null,
        action_code: "NONE",
        measurements: [],
      },
      {
        component: "encryption",
        state:
          health.encryption.rotation_state === "blocked"
            ? "blocked"
            : health.encryption.rotation_id !== null
            ? "active"
            : health.encryption.keys.length === 0
              ? "disabled"
              : health.encryption.current_key_id === null
                ? "blocked"
                : "ready",
        reason_code:
          health.encryption.rotation_state === "blocked" ||
          (health.encryption.keys.length > 0 &&
          health.encryption.current_key_id === null &&
          health.encryption.rotation_id === null)
            ? "KEY_UNAVAILABLE"
            : null,
        action_code:
          health.encryption.rotation_state === "blocked" ||
          (health.encryption.keys.length > 0 &&
          health.encryption.current_key_id === null &&
          health.encryption.rotation_id === null)
            ? "PROVIDE_TRUSTED_KEY"
            : "NONE",
        measurements: [
          {
            component: "encryption",
            name: "item_count",
            value: health.encryption.encrypted_content_count,
            unit: "count",
          },
          {
            component: "encryption",
            name: "frontier",
            value:
              health.encryption.keys.at(-1)?.generation ?? 0,
            unit: "epoch",
          },
        ],
      },
      {
        component: "data_root",
        state: "ready",
        reason_code: null,
        action_code: "NONE",
        measurements:
          health.root_lease === null
            ? []
            : [
                {
                  component: "data_root",
                  name: "frontier",
                  value: health.root_lease.fence_token,
                  unit: "epoch",
                },
              ],
      },
      projectionObservation("fts", health.projection_state),
      projectionObservation(
        "layered_projection",
        health.layered_projection_state,
      ),
      {
        component: "graph_projection",
        state: "disabled",
        reason_code: null,
        action_code: "NONE",
        measurements: [],
      },
      {
        component: "vector_projection",
        state: "disabled",
        reason_code: null,
        action_code: "NONE",
        measurements: [],
      },
      {
        component: "learning",
        state: "ready",
        reason_code: null,
        action_code: "NONE",
        measurements: [
          {
            component: "learning",
            name: "frontier",
            value: Math.max(
              health.learning_frontier.control_epoch,
              health.learning_frontier.release_revision,
            ),
            unit: "epoch",
          },
        ],
      },
    ],
  });
}

const BLOCKED_ERROR_MAPPING: Partial<
  Record<
    StorageErrorCode,
    {
      component: OperationalObservation["component"];
      reason_code: NonNullable<OperationalObservation["reason_code"]>;
      action_code: OperationalObservation["action_code"];
    }
  >
> = {
  INVALID_DATA_ROOT: {
    component: "data_root",
    reason_code: "DATA_ROOT_UNSAFE",
    action_code: "SELECT_SAFE_DATA_ROOT",
  },
  CORRUPTION: {
    component: "canonical_store",
    reason_code: "CANONICAL_CORRUPTION",
    action_code: "RESTORE_VERIFIED_BACKUP",
  },
  MIGRATION_DRIFT: {
    component: "migrations",
    reason_code: "MIGRATION_DRIFT",
    action_code: "RESTORE_VERIFIED_BACKUP",
  },
  ENCRYPTION_REQUIRED: {
    component: "encryption",
    reason_code: "KEY_UNAVAILABLE",
    action_code: "PROVIDE_TRUSTED_KEY",
  },
  KEY_PROVIDER_INVALID: {
    component: "encryption",
    reason_code: "KEY_UNAVAILABLE",
    action_code: "PROVIDE_TRUSTED_KEY",
  },
  KEY_UNAVAILABLE: {
    component: "encryption",
    reason_code: "KEY_UNAVAILABLE",
    action_code: "PROVIDE_TRUSTED_KEY",
  },
  KEY_REVOKED: {
    component: "encryption",
    reason_code: "KEY_UNAVAILABLE",
    action_code: "PROVIDE_TRUSTED_KEY",
  },
  KEY_STATE_AMBIGUOUS: {
    component: "encryption",
    reason_code: "KEY_UNAVAILABLE",
    action_code: "PROVIDE_TRUSTED_KEY",
  },
  NONCE_REUSE: {
    component: "encryption",
    reason_code: "KEY_UNAVAILABLE",
    action_code: "PROVIDE_TRUSTED_KEY",
  },
  AUTHORITY_REPLAY: {
    component: "encryption",
    reason_code: "KEY_UNAVAILABLE",
    action_code: "PROVIDE_TRUSTED_KEY",
  },
  ROTATION_INCOMPLETE: {
    component: "encryption",
    reason_code: "KEY_UNAVAILABLE",
    action_code: "PROVIDE_TRUSTED_KEY",
  },
};

export function blockedOperationalStatus(
  error: unknown,
  options?: {
    observedAt?: string;
    qualification?: ReleaseQualification;
    invalidConfig?: boolean;
  },
): OperationalStatus {
  const mapping =
    options?.invalidConfig === true
      ? {
          component: "configuration" as const,
          reason_code: "CONFIG_INVALID" as const,
          action_code: "FIX_CONFIGURATION" as const,
        }
      : error instanceof StorageError
        ? BLOCKED_ERROR_MAPPING[error.code]
        : undefined;
  const resolved = mapping ?? {
    component: "canonical_store" as const,
    reason_code: "INTERNAL_FAILURE" as const,
    action_code: "RESTART_RUNTIME" as const,
  };
  return reduceOperationalStatus({
    observed_at: options?.observedAt ?? new Date().toISOString(),
    qualification: options?.qualification ?? PENDING_QUALIFICATION,
    observations: [
      {
        component: resolved.component,
        state: "blocked",
        reason_code: resolved.reason_code,
        action_code: resolved.action_code,
        measurements: [],
      },
      {
        component: "graph_projection",
        state: "disabled",
        reason_code: null,
        action_code: "NONE",
        measurements: [],
      },
      {
        component: "vector_projection",
        state: "disabled",
        reason_code: null,
        action_code: "NONE",
        measurements: [],
      },
    ],
  });
}
