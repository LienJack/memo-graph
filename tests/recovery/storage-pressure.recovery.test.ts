import { describe, expect, it } from "vitest";

import {
  AdmissionController,
  type AdmissionObservation,
} from "../../packages/storage-sqlite/src/admission-control.js";

describe("storage pressure hysteresis", () => {
  it("requires recovery headroom and a healthy checkpoint", () => {
    const observation: AdmissionObservation = {
      available_bytes: 50,
      wal_bytes: 0,
      checkpoint_healthy: true,
      active_maintenance: null,
    };
    const controller = new AdmissionController({
      policy: {
        max_queue_depth: 4,
        max_queue_age_ms: 100,
        min_available_bytes_enter: 100,
        min_available_bytes_recover: 200,
        max_wal_bytes_enter: 1_000,
        max_wal_bytes_recover: 100,
      },
      observe: () => observation,
    });
    const metrics = {
      depth: 0,
      oldest_age_ms: 0,
      completed: 0,
      rejected_pre_enqueue: 0,
      rejected_transaction_start: 0,
      active_operation: null,
    };
    expect(() =>
      controller.assert("pre_enqueue", metrics, "canonical_write"),
    ).toThrow();
    expect(controller.readOnly).toBe(true);
    expect(controller.pressureReason).toBe("disk");

    observation.available_bytes = 150;
    expect(() =>
      controller.assert("pre_enqueue", metrics, "canonical_write"),
    ).toThrow();
    observation.available_bytes = 250;
    observation.checkpoint_healthy = false;
    expect(() =>
      controller.assert("pre_enqueue", metrics, "canonical_write"),
    ).toThrow();
    observation.checkpoint_healthy = true;
    expect(() =>
      controller.assert("pre_enqueue", metrics, "canonical_write"),
    ).not.toThrow();
    expect(controller.readOnly).toBe(false);
  });

  it("keeps bounded checkpoint recovery available during WAL pressure", () => {
    const observation: AdmissionObservation = {
      available_bytes: 1_000,
      wal_bytes: 1_200,
      checkpoint_healthy: false,
      active_maintenance: null,
    };
    const controller = new AdmissionController({
      policy: {
        max_queue_depth: 4,
        max_queue_age_ms: 100,
        min_available_bytes_enter: 100,
        min_available_bytes_recover: 200,
        max_wal_bytes_enter: 1_000,
        max_wal_bytes_recover: 100,
      },
      observe: () => observation,
    });
    const metrics = {
      depth: 0,
      oldest_age_ms: 0,
      completed: 0,
      rejected_pre_enqueue: 0,
      rejected_transaction_start: 0,
      active_operation: null,
    };

    expect(() =>
      controller.assert("pre_enqueue", metrics, "canonical_write"),
    ).toThrow();
    expect(controller.pressureReason).toBe("wal");
    expect(() =>
      controller.assert("pre_enqueue", metrics, "checkpoint"),
    ).not.toThrow();

    observation.wal_bytes = 0;
    expect(() =>
      controller.assert("pre_enqueue", metrics, "canonical_write"),
    ).toThrow();
    observation.checkpoint_healthy = true;
    expect(() =>
      controller.assert("pre_enqueue", metrics, "canonical_write"),
    ).not.toThrow();
  });
});
