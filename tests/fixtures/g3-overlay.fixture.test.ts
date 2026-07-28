import { describe, expect, it } from "vitest";

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
});
