import { existsSync, statfsSync, statSync } from "node:fs";

import { z } from "zod";

import { StorageError } from "./errors.js";
import type { WriterQueueMetrics } from "./writer-queue.js";

export const AdmissionPolicySchema = z
  .object({
    max_queue_depth: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    max_queue_age_ms: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    min_available_bytes_enter: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    min_available_bytes_recover: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    max_wal_bytes_enter: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER),
    max_wal_bytes_recover: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.min_available_bytes_recover <= value.min_available_bytes_enter
    ) {
      context.addIssue({
        code: "custom",
        path: ["min_available_bytes_recover"],
        message: "disk recovery threshold must exceed the enter threshold",
      });
    }
    if (value.max_wal_bytes_recover >= value.max_wal_bytes_enter) {
      context.addIssue({
        code: "custom",
        path: ["max_wal_bytes_recover"],
        message: "WAL recovery threshold must be below the enter threshold",
      });
    }
  });

export const DEFAULT_ADMISSION_POLICY = AdmissionPolicySchema.parse({
  max_queue_depth: 64,
  max_queue_age_ms: 5_000,
  min_available_bytes_enter: 256 * 1024 * 1024,
  min_available_bytes_recover: 384 * 1024 * 1024,
  max_wal_bytes_enter: 64 * 1024 * 1024,
  max_wal_bytes_recover: 16 * 1024 * 1024,
});

export const MaintenanceOperationSchema = z.enum([
  "canonical_write",
  "backup",
  "checkpoint",
  "rebuild_fts",
  "purge_retry",
  "key_rotation",
  "secret_write",
]);

export const AdmissionObservationSchema = z
  .object({
    available_bytes: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    wal_bytes: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    checkpoint_healthy: z.boolean(),
    active_maintenance: MaintenanceOperationSchema.nullable(),
  })
  .strict();

export type MaintenanceOperation = z.infer<
  typeof MaintenanceOperationSchema
>;
export type AdmissionPolicy = z.infer<typeof AdmissionPolicySchema>;
export type AdmissionStage = "pre_enqueue" | "transaction_start";

export type AdmissionObservation = z.infer<
  typeof AdmissionObservationSchema
>;

export function observeStorageCapacity(input: {
  dataRoot: string;
  databasePath: string;
}): AdmissionObservation {
  const filesystem = statfsSync(input.dataRoot);
  const availableBytes = filesystem.bavail * filesystem.bsize;
  const walPath = `${input.databasePath}-wal`;
  return {
    available_bytes: availableBytes,
    wal_bytes: existsSync(walPath) ? statSync(walPath).size : 0,
    checkpoint_healthy: true,
    active_maintenance: null,
  };
}

export function maintenanceCompatible(
  active: unknown,
  requested: unknown,
): boolean {
  const parsedActive = MaintenanceOperationSchema.nullable().safeParse(active);
  const parsedRequested = MaintenanceOperationSchema.safeParse(requested);
  if (!parsedActive.success || !parsedRequested.success) {
    return false;
  }
  if (parsedActive.data === null) {
    return true;
  }
  return (
    parsedActive.data === parsedRequested.data &&
    parsedRequested.data === "canonical_write"
  );
}

export class AdmissionController {
  readonly #policy: AdmissionPolicy;
  readonly #observe: () => AdmissionObservation;
  #readOnly = false;
  #pressureReason: "disk" | "wal" | null = null;
  #lastObservation: AdmissionObservation | null = null;

  constructor(options: {
    policy?: AdmissionPolicy;
    observe: () => AdmissionObservation;
  }) {
    this.#policy = AdmissionPolicySchema.parse(
      options.policy ?? DEFAULT_ADMISSION_POLICY,
    );
    this.#observe = options.observe;
  }

  get readOnly(): boolean {
    return this.#readOnly;
  }

  get pressureReason(): "disk" | "wal" | null {
    return this.#pressureReason;
  }

  get policy(): AdmissionPolicy {
    return this.#policy;
  }

  get observation(): AdmissionObservation | null {
    return this.#lastObservation;
  }

  refresh(): AdmissionObservation {
    const parsed = AdmissionObservationSchema.safeParse(this.#observe());
    if (!parsed.success) {
      throw new StorageError("MAINTENANCE_BLOCKED");
    }
    const observation = parsed.data;
    this.#lastObservation = observation;
    this.#updatePressure(observation);
    return observation;
  }

  assert(
    stage: AdmissionStage,
    queue: WriterQueueMetrics,
    operation: unknown,
  ): void {
    const requested = MaintenanceOperationSchema.safeParse(operation);
    if (!requested.success) {
      throw new StorageError("MAINTENANCE_BLOCKED");
    }
    if (
      (stage === "pre_enqueue" &&
        queue.depth >= this.#policy.max_queue_depth) ||
      queue.oldest_age_ms >= this.#policy.max_queue_age_ms
    ) {
      throw new StorageError("QUEUE_SATURATED", { retryable: true });
    }
    const observation = this.refresh();
    const queuedActive = MaintenanceOperationSchema.safeParse(
      queue.active_operation,
    );
    const activeMaintenance =
      observation.active_maintenance ??
      (queuedActive.success ? queuedActive.data : null);
    if (
      !maintenanceCompatible(activeMaintenance, requested.data)
    ) {
      throw new StorageError("MAINTENANCE_BLOCKED", { retryable: true });
    }
    if (this.#readOnly && requested.data !== "checkpoint") {
      throw new StorageError("RESOURCE_PRESSURE", { retryable: true });
    }
  }

  #updatePressure(observation: AdmissionObservation): void {
    if (
      observation.available_bytes <
      this.#policy.min_available_bytes_enter
    ) {
      this.#readOnly = true;
      this.#pressureReason = "disk";
    } else if (observation.wal_bytes > this.#policy.max_wal_bytes_enter) {
      this.#readOnly = true;
      this.#pressureReason = "wal";
    } else if (
      this.#readOnly &&
      observation.available_bytes >=
        this.#policy.min_available_bytes_recover &&
      observation.wal_bytes <= this.#policy.max_wal_bytes_recover &&
      observation.checkpoint_healthy
    ) {
      this.#readOnly = false;
      this.#pressureReason = null;
    }
  }
}
