import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  G4BFrozenSubsetSchema,
  assertG4BPartitionAccess,
  canonicalSha256,
  type EvaluationPartition,
} from "../../packages/contracts/src/index.js";

const MANIFEST = resolve("fixtures/g4b/manifest.json");

async function readManifest(): Promise<unknown> {
  return JSON.parse(await readFile(MANIFEST, "utf8")) as unknown;
}

describe("frozen G4B semantic-gap overlay", () => {
  it("preserves the candidate-free nine-case declaration exactly", async () => {
    const manifest = G4BFrozenSubsetSchema.parse(await readManifest());
    expect(manifest.candidate_selection).toBeNull();
    expect(manifest.arms).toEqual([
      "fts_recency",
      "layered",
      "vector",
      "hybrid",
    ]);
    expect(manifest.cases).toHaveLength(9);
    expect(
      manifest.cases.filter((entry) => entry.case_role === "positive_gap"),
    ).toHaveLength(6);
    expect(canonicalSha256(manifest)).toBe(
      "sha256:449981ac83b2bc415c60df5237d6c857777e2dda6c03b1778588aa052c6ae3d4",
    );

    for (const partition of [
      "calibration",
      "holdout",
      "transfer",
    ] satisfies EvaluationPartition[]) {
      expect(
        manifest.cases.filter((entry) => entry.partition === partition),
      ).toHaveLength(3);
    }
  });

  it("freezes the material-gain, fallback, and M0 thresholds", async () => {
    const manifest = G4BFrozenSubsetSchema.parse(await readManifest());
    expect(manifest.thresholds).toEqual({
      positive_cases: 6,
      minimum_positive_cases_solved: 5,
      minimum_strict_case_gains: 4,
      minimum_holdout_gains: 1,
      minimum_transfer_gains: 1,
      critical_regression_tolerance: 0,
      context_pollution_delta_tolerance: 0,
      governed_recall_p50_ms: 50,
      governed_recall_p95_ms: 200,
      context_compile_p50_ms: 100,
      context_compile_p95_ms: 400,
      fallback_p95_ms: 100,
      warmup_samples: 20,
      measured_samples: 100,
    });
    expect(manifest.expected_profile).toEqual({
      evidence_events: 250_000,
      active_l1_memories: 25_000,
      l2_l3_projections: 6_000,
      relations: 50_000,
    });
    expect(manifest.strict_gain_rule).toContain(
      "both fts_recency and layered",
    );
  });

  it("prevents tuning from opening holdout and transfer partitions", () => {
    expect(() =>
      assertG4BPartitionAccess("calibration_tuning", "calibration"),
    ).not.toThrow();
    expect(() =>
      assertG4BPartitionAccess("calibration_tuning", "holdout"),
    ).toThrow();
    expect(() =>
      assertG4BPartitionAccess("calibration_tuning", "transfer"),
    ).toThrow();
    expect(() =>
      assertG4BPartitionAccess("gate_evaluation", "holdout"),
    ).not.toThrow();
  });
});
