import { describe, expect, it } from "vitest";

import {
  AdmissionController,
  type AdmissionObservation,
} from "../../packages/storage-sqlite/src/admission-control.js";
import { WriterQueue } from "../../packages/storage-sqlite/src/writer-queue.js";

const POLICY = {
  max_queue_depth: 2,
  max_queue_age_ms: 10,
  min_available_bytes_enter: 100,
  min_available_bytes_recover: 200,
  max_wal_bytes_enter: 1_000,
  max_wal_bytes_recover: 100,
};

function queueWith(
  observation: () => AdmissionObservation,
  clock: () => number = () => 0,
) {
  const admission = new AdmissionController({
    policy: POLICY,
    observe: observation,
  });
  return {
    admission,
    queue: new WriterQueue({
      clock,
      admit: (stage, metrics, operation) =>
        admission.assert(
          stage,
          metrics,
          operation as "canonical_write" | "backup",
        ),
    }),
  };
}

describe("bounded storage admission", () => {
  it("rejects depth and age saturation before rejected work executes", async () => {
    let now = 0;
    const observation = {
      available_bytes: 1_000,
      wal_bytes: 0,
      checkpoint_healthy: true,
      active_maintenance: null,
    } satisfies AdmissionObservation;
    const { queue } = queueWith(() => observation, () => now);
    let release!: () => void;
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = queue.enqueue(async () => {
      started();
      await held;
    });
    await running;
    const second = queue.enqueue(async () => undefined);
    let thirdExecuted = false;
    await expect(
      queue.enqueue(async () => {
        thirdExecuted = true;
      }),
    ).rejects.toMatchObject({ code: "QUEUE_SATURATED" });
    now = 20;
    await expect(
      queue.enqueue(async () => {
        thirdExecuted = true;
      }),
    ).rejects.toMatchObject({ code: "QUEUE_SATURATED" });
    expect(thirdExecuted).toBe(false);
    expect(queue.metrics().rejected_pre_enqueue).toBe(2);
    release();
    await first;
    await expect(second).rejects.toMatchObject({
      code: "QUEUE_SATURATED",
    });
  });

  it("rechecks capacity immediately before execution", async () => {
    const observation: AdmissionObservation = {
      available_bytes: 1_000,
      wal_bytes: 0,
      checkpoint_healthy: true,
      active_maintenance: null,
    };
    const { queue } = queueWith(() => observation);
    let release!: () => void;
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = queue.enqueue(async () => {
      started();
      await held;
    });
    await running;
    let secondExecuted = false;
    const second = queue.enqueue(async () => {
      secondExecuted = true;
    });
    observation.available_bytes = 50;
    release();
    await first;
    await expect(second).rejects.toMatchObject({
      code: "RESOURCE_PRESSURE",
    });
    expect(secondExecuted).toBe(false);
    expect(queue.metrics().rejected_transaction_start).toBe(1);
  });
});
