import { performance } from "node:perf_hooks";

export type WriterQueueMetrics = {
  depth: number;
  oldest_age_ms: number;
  completed: number;
};

type QueuedEntry = {
  enqueuedAt: number;
};

export class WriterQueue {
  #tail: Promise<void> = Promise.resolve();
  #queued = new Set<QueuedEntry>();
  #completed = 0;

  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const entry = { enqueuedAt: performance.now() };
    this.#queued.add(entry);

    const result = this.#tail.then(operation);
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
    const now = performance.now();
    const oldest = [...this.#queued].reduce(
      (age, entry) => Math.max(age, now - entry.enqueuedAt),
      0,
    );
    return {
      depth: this.#queued.size,
      oldest_age_ms: Math.round(oldest * 1_000) / 1_000,
      completed: this.#completed,
    };
  }
}
