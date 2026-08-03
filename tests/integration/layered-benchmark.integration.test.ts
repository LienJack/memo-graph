import { describe, expect, it } from "vitest";

import {
  runG3ResourceBenchmark,
} from "../../packages/memory-kernel/src/index.js";

describe("G3 layered resource benchmark harness", () => {
  it("materializes exact profile counts and a rebuild-equal frontier", async () => {
    const report = await runG3ResourceBenchmark({
      evidence: 40,
      l1: 20,
      projections: 5,
      relations: 20,
    });

    expect(report.workload).toEqual({
      profile: "custom",
      evidence: 40,
      l1: 20,
      projections: 5,
      relations: 20,
    });
    expect(report.counts).toMatchObject({
      evidence: 40,
      l1: 20,
      projections: 5,
      relations: 20,
    });
    expect(report.rebuild.equal).toBe(true);
    expect(report.storage.database_bytes).toBeGreaterThan(0);
    expect(report.storage.data_root_bytes).toBeGreaterThanOrEqual(
      report.storage.database_bytes,
    );
  }, 60_000);
});
