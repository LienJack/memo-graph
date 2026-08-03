import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  G5CanaryCaseBodySchema,
  G5CanaryOracleSchema,
  G5CaseBodySchema,
  G5CaseOracleSchema,
  G5FixtureManifestSchema,
  G5ThresholdsSchema,
  assertG5CanaryAccess,
  assertG5PartitionAccess,
  canonicalSha256,
} from "../../packages/contracts/src/index.js";

const ROOT = resolve("fixtures/g5");

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(ROOT, path), "utf8")) as unknown;
}

async function fileSha256(path: string): Promise<string> {
  return `sha256:${createHash("sha256")
    .update(await readFile(resolve(path)))
    .digest("hex")}`;
}

describe("frozen G5 learning fixtures", () => {
  it("binds three cases per partition and three independent canary cases", async () => {
    const manifest = G5FixtureManifestSchema.parse(
      await readJson("manifest.json"),
    );
    expect(manifest.arms).toEqual([
      "no_candidate",
      "current",
      "candidate",
    ]);
    for (const partition of ["calibration", "holdout", "transfer"] as const) {
      expect(
        manifest.evaluation_cases.filter(
          (descriptor) => descriptor.partition === partition,
        ),
      ).toHaveLength(3);
    }
    expect(manifest.canary_cases).toHaveLength(3);
    expect(new Set(manifest.canary_cases.map((entry) => entry.family)).size).toBe(
      3,
    );
    expect(manifest.accepted_baseline).toMatchObject({
      graph: {
        decision: "NO-GO",
        commit: "36421f5cd75007a1421d3e0594e7881dd4b864b2",
      },
      vector: {
        decision: "NO-GO",
        commit: "3eec7119b1e441d76523d0a57c328d4d811a4af3",
      },
      vector_enabled: false,
    });
    expect(await fileSha256("docs/evaluations/g3r-h3-decision.md")).toBe(
      manifest.accepted_baseline.g3r.artifact_sha256,
    );
    expect(await fileSha256("docs/evaluations/g4a-decision.md")).toBe(
      manifest.accepted_baseline.graph.artifact_sha256,
    );
    expect(await fileSha256("docs/evaluations/g4b-decision.md")).toBe(
      manifest.accepted_baseline.vector.artifact_sha256,
    );
    expect(
      G5FixtureManifestSchema.safeParse({
        ...manifest,
        frozen_at: "2026-07-29T12:31:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("verifies every descriptor body and protected oracle hash", async () => {
    const manifest = G5FixtureManifestSchema.parse(
      await readJson("manifest.json"),
    );
    for (const descriptor of manifest.evaluation_cases) {
      const body = G5CaseBodySchema.parse(await readJson(descriptor.case_file));
      const oracle = G5CaseOracleSchema.parse(
        await readJson(descriptor.oracle_file),
      );
      expect(body.case_id).toBe(descriptor.case_id);
      expect(oracle.case_id).toBe(descriptor.case_id);
      expect(body.partition).toBe(descriptor.partition);
      expect(oracle.partition).toBe(descriptor.partition);
      expect(canonicalSha256(body)).toBe(descriptor.case_hash);
      expect(canonicalSha256(oracle)).toBe(descriptor.oracle_hash);
      if (descriptor.partition !== "calibration") {
        expect(oracle.visibility).toBe("sealed_evaluator");
      }
    }
    for (const descriptor of manifest.canary_cases) {
      const body = G5CanaryCaseBodySchema.parse(
        await readJson(descriptor.case_file),
      );
      const oracle = G5CanaryOracleSchema.parse(
        await readJson(descriptor.oracle_file),
      );
      expect(canonicalSha256(body)).toBe(descriptor.case_hash);
      expect(canonicalSha256(oracle)).toBe(descriptor.oracle_hash);
      expect(oracle.visibility).toBe("approved_for_canary");
    }
  });

  it("freezes conjunctive D5 thresholds and rejects early oracle access", async () => {
    const thresholds = G5ThresholdsSchema.parse(
      await readJson("thresholds.json"),
    );
    const manifest = G5FixtureManifestSchema.parse(
      await readJson("manifest.json"),
    );
    expect(canonicalSha256(thresholds)).toBe(manifest.thresholds_hash);
    expect(thresholds).toMatchObject({
      minimum_task_unit_gain_over_current_per_partition: 1,
      minimum_task_unit_gain_over_no_candidate_per_partition: 1,
      maximum_required_task_unit_losses: 0,
      maximum_critical_regressions: 0,
      maximum_context_pollution_increase: 0,
      maximum_token_overflows: 0,
      context_compile_p95_ms: 400,
      context_compile_max_relative_increase: 0.2,
      context_compile_max_absolute_increase_ms: 25,
      canary_case_count: 3,
      canary_maximum_exposures_per_case: 1,
      canary_deadline_ms: 600_000,
    });
    expect(() =>
      assertG5PartitionAccess("calibration_tuning", "calibration", "oracle"),
    ).not.toThrow();
    expect(() =>
      assertG5PartitionAccess("calibration_tuning", "holdout", "oracle"),
    ).toThrow();
    expect(() =>
      assertG5PartitionAccess("gate_evaluator", "holdout", "oracle"),
    ).not.toThrow();
    expect(() => assertG5CanaryAccess("evaluating", "oracle")).toThrow();
    expect(() =>
      assertG5CanaryAccess("approved_for_canary", "oracle"),
    ).not.toThrow();
  });
});
