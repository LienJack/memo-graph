import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  canonicalSha256,
  type EvaluationPartition,
} from "../../packages/contracts/src/index.js";
import {
  G3_BASE_MANIFEST_RAW_SHA256,
  loadG3Manifest,
  loadG3Partition,
} from "../helpers/g3-replay.js";

describe("frozen G3 overlay corpus", () => {
  it("binds every overlay to an immutable M0 case and partition", async () => {
    const manifests = await loadG3Manifest();
    expect(G3_BASE_MANIFEST_RAW_SHA256).toBe(
      "sha256:8827b6fd6f1db6df8643faa46cdd5ce1008c10cca092fada555e3896cd7804e3",
    );

    for (const partition of [
      "calibration",
      "holdout",
      "transfer",
    ] satisfies EvaluationPartition[]) {
      const loaded = await loadG3Partition(partition);
      const descriptors = manifests.overlay.cases.filter(
        (entry) => entry.partition === partition,
      );
      expect(loaded).toHaveLength(descriptors.length);
      for (const entry of loaded) {
        expect(entry.base.partition).toBe(partition);
        expect(entry.overlay.partition).toBe(partition);
        expect(canonicalSha256(entry.base)).toBe(
          entry.overlay.base_case_hash,
        );
        expect(canonicalSha256(entry.overlay)).toBe(
          entry.overlay_descriptor.content_hash,
        );
      }
    }
  });

  it("declares the exact three comparison arms", async () => {
    const manifests = await loadG3Manifest();
    expect(manifests.overlay.arms).toEqual([
      "accepted_m2",
      "m3_no_projection",
      "m3_layered",
    ]);
  });

  it("binds every H3 regression to M0 and an executable test oracle", async () => {
    const manifests = await loadG3Manifest();
    const regressionSchema = z
      .object({
        schema_version: z.literal("1.0.0"),
        suite_id: z.literal("g3r_h3_bounded_recall"),
        frozen_at: z.iso.datetime({ offset: true }),
        candidate_commit: z.string().regex(/^[a-f0-9]{40}$/u),
        historical_candidate_commit: z.string().regex(/^[a-f0-9]{40}$/u),
        base_manifest_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
        historical_failure_evidence: z.string().min(1),
        cases: z.array(
          z.object({
            case_id: z.string().min(1),
            base_case_id: z.string().min(1),
            base_case_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
            oracle: z.string().min(1),
            test_file: z.string().regex(/^tests\/.+\.test\.ts$/u),
            test_name: z.string().min(1),
            requirement_anchors: z.array(
              z.string().regex(/^R\d+$/u),
            ).min(1),
            historical_result: z.enum(["PASS", "FAIL"]),
            candidate_expected_result: z.literal("PASS"),
          }).strict(),
        ).length(8),
      })
      .strict();
    const suite = regressionSchema.parse(
      JSON.parse(
        readFileSync(
          resolve("fixtures/g3/h3-regressions.json"),
          "utf8",
        ),
      ),
    );

    expect(suite.base_manifest_hash).toBe(
      canonicalSha256(manifests.base),
    );
    expect(new Set(suite.cases.map((item) => item.case_id)).size).toBe(
      suite.cases.length,
    );
    expect(
      suite.cases.filter((item) => item.historical_result === "FAIL"),
    ).toHaveLength(7);
    for (const regression of suite.cases) {
      const base = manifests.base.cases.find(
        (item) => item.case_id === regression.base_case_id,
      );
      expect(base?.content_hash).toBe(regression.base_case_hash);
      expect(
        readFileSync(resolve(regression.test_file), "utf8"),
      ).toContain(regression.test_name);
    }
    expect(
      readFileSync(
        resolve(suite.historical_failure_evidence),
        "utf8",
      ),
    ).toContain("### P1");
  });
});
