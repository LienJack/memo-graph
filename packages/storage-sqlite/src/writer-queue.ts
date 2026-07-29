import { performance } from "node:perf_hooks";

import { z } from "zod";

export const WriterQueueMetricsSchema = z
  .object({
    depth: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    oldest_age_ms: z.number().finite().nonnegative(),
    completed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    rejected_pre_enqueue: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    rejected_transaction_start: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    active_operation: z.string().trim().min(1).nullable(),
  })
  .strict();

export type WriterQueueMetrics = z.infer<typeof WriterQueueMetricsSchema>;

type QueuedEntry = {
  enqueuedAt: number;
};

export class WriterQueue {
  #tail: Promise<void> = Promise.resolve();
  #queued = new Set<QueuedEntry>();
  #completed = 0;
  #rejectedPreEnqueue = 0;
  #rejectedTransactionStart = 0;
  #activeOperation: string | null = null;
  readonly #clock: () => number;
  readonly #admit:
    | ((
        stage: "pre_enqueue" | "transaction_start",
        metrics: WriterQueueMetrics,
        operation: string,
      ) => void)
    | undefined;

  constructor(options?: {
    clock?: () => number;
    admit?: (
      stage: "pre_enqueue" | "transaction_start",
      metrics: WriterQueueMetrics,
      operation: string,
    ) => void;
  }) {
    this.#clock = options?.clock ?? (() => performance.now());
    this.#admit = options?.admit;
  }

  enqueue<T>(
    operation: () => Promise<T>,
    operationName = "canonical_write",
  ): Promise<T> {
    try {
      this.#admit?.("pre_enqueue", this.metrics(), operationName);
    } catch (error) {
      this.#rejectedPreEnqueue += 1;
      return Promise.reject(error);
    }
    const entry = { enqueuedAt: this.#clock() };
    this.#queued.add(entry);

    const result = this.#tail.then(async () => {
      try {
        this.#admit?.(
          "transaction_start",
          this.metrics(),
          operationName,
        );
      } catch (error) {
        this.#rejectedTransactionStart += 1;
        throw error;
      }
      this.#activeOperation = operationName;
      try {
        return await operation();
      } finally {
        this.#activeOperation = null;
      }
    });
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );

    return result.finally(() => {
      this.#queued.delete(entry);
      this.#completed += 1;
    });
  }

  metrics(): WriterQueueMetrics {
    const now = this.#clock();
    const oldest = [...this.#queued].reduce(
      (age, entry) => Math.max(age, now - entry.enqueuedAt),
      0,
    );
    return {
      depth: this.#queued.size,
      oldest_age_ms: Math.round(oldest * 1_000) / 1_000,
      completed: this.#completed,
      rejected_pre_enqueue: this.#rejectedPreEnqueue,
      rejected_transaction_start: this.#rejectedTransactionStart,
      active_operation: this.#activeOperation,
    };
  }
}
