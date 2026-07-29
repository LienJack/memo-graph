import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  G4ACaseBodySchema,
  G4AOverlayManifestSchema,
  assertG4APartitionAccess,
  canonicalSha256,
  type EvaluationPartition,
} from "../../packages/contracts/src/index.js";

const ROOT = resolve("fixtures/g4a");

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

describe("frozen G4A structural overlay", () => {
  it("binds exactly six immutable cases across two cases per partition", async () => {
    const manifest = G4AOverlayManifestSchema.parse(
      await readJson(resolve(ROOT, "manifest.json")),
    );
    expect(manifest.arms).toEqual([
      "accepted_g3r",
      "m4a_graph_disabled_reference",
      "m4a_graph_enabled",
    ]);
    expect(canonicalSha256(manifest)).toBe(
      "sha256:0125495066b577da571e46f7c4533b73bb3f9a4ba547affa8d7357eb5dd713e7",
    );
    expect(manifest.cases).toHaveLength(6);

    for (const partition of [
      "calibration",
      "holdout",
      "transfer",
    ] satisfies EvaluationPartition[]) {
      const descriptors = manifest.cases.filter(
        (entry) => entry.partition === partition,
      );
      expect(descriptors).toHaveLength(2);
      for (const descriptor of descriptors) {
        const body = G4ACaseBodySchema.parse(
          await readJson(resolve(ROOT, descriptor.body_file)),
        );
        expect(body.case_id).toBe(descriptor.case_id);
        expect(body.partition).toBe(partition);
        expect(body.family).toBe(descriptor.family);
        expect(canonicalSha256(body)).toBe(descriptor.content_hash);
        const expectedRevisionIds = new Set(body.expected.revision_ids);
        const pathRevisionIds = new Set(
          body.expected.ordered_paths.flatMap(
            (path) => path.node_revision_ids,
          ),
        );
        expect(expectedRevisionIds).toEqual(pathRevisionIds);
        expect(body.expected.abstain).toBe(
          body.expected.revision_ids.length === 0,
        );
      }
    }
  });

  it("freezes the candidate, baseline, thresholds, and strict-gain rule", async () => {
    const manifest = G4AOverlayManifestSchema.parse(
      await readJson(resolve(ROOT, "manifest.json")),
    );
    expect(manifest.baseline_commit).toBe(
      "6224f782c86712488d416d8101ef7c9fa477c0ae",
    );
    expect(manifest.candidate).toEqual({
      package_name: "@ladybugdb/core",
      package_version: "0.18.3",
      platform: "darwin",
      architecture: "arm64",
    });
    expect(manifest.thresholds).toMatchObject({
      strict_case_gains: 3,
      minimum_holdout_gains: 1,
      minimum_transfer_gains: 1,
      critical_regression_tolerance: 0,
      host_graph_deadline_ms: 75,
      fallback_p95_ms: 100,
      governed_recall_p50_ms: 50,
      governed_recall_p95_ms: 200,
      replacement_ready_ms: 2_000,
      expected_rebuild_ms: 60_000,
      graph_database_wal_bytes: 536_870_912,
      install_delta_bytes: 67_108_864,
      idle_rss_delta_bytes: 134_217_728,
      peak_rss_delta_bytes: 536_870_912,
      warmup_samples: 20,
      measured_samples: 100,
    });
    expect(manifest.strict_gain_rule).toContain(
      "both accepted_g3r and m4a_graph_disabled_reference",
    );
    expect(manifest.strict_gain_rule).not.toContain("candidate count");
    expect(
      canonicalSha256({
        ...manifest,
        thresholds: {
          ...manifest.thresholds,
          host_graph_deadline_ms:
            manifest.thresholds.host_graph_deadline_ms + 1,
        },
      }),
    ).not.toBe(
      "sha256:0125495066b577da571e46f7c4533b73bb3f9a4ba547affa8d7357eb5dd713e7",
    );
  });

  it("prevents calibration tuning from opening holdout or transfer payloads", () => {
    expect(() =>
      assertG4APartitionAccess("calibration_tuning", "calibration")
    ).not.toThrow();
    expect(() =>
      assertG4APartitionAccess("calibration_tuning", "holdout")
    ).toThrow();
    expect(() =>
      assertG4APartitionAccess("calibration_tuning", "transfer")
    ).toThrow();
    expect(() =>
      assertG4APartitionAccess("gate_evaluation", "holdout")
    ).not.toThrow();
  });
});
