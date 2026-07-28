import { describe, expect, it } from "vitest";

import {
  canonicalSha256,
  type EvaluationPartition,
} from "../../packages/contracts/src/index.js";
import {
  loadReplayManifest,
  loadReplayPartition,
} from "../helpers/replay-corpus.js";

describe("frozen replay corpus", () => {
  it("matches every descriptor to a schema-valid, immutable body hash", async () => {
    const manifest = await loadReplayManifest();

    for (const partition of [
      "calibration",
      "holdout",
      "transfer",
    ] satisfies EvaluationPartition[]) {
      const bodies = await loadReplayPartition(partition);
      const descriptors = manifest.cases.filter(
        (entry) => entry.partition === partition,
      );

      expect(bodies).toHaveLength(descriptors.length);
      for (const body of bodies) {
        const descriptor = descriptors.find(
          (entry) => entry.case_id === body.case_id,
        );
        expect(descriptor).toBeDefined();
        expect(body.partition).toBe(partition);
        expect(body.risk_family).toBe(descriptor?.risk_family);
        expect(canonicalSha256(body)).toBe(descriptor?.content_hash);
      }
    }
  });

  it("exposes only the requested partition body payloads", async () => {
    const calibration = await loadReplayPartition("calibration");
    const holdout = await loadReplayPartition("holdout");
    const transfer = await loadReplayPartition("transfer");

    expect(new Set(calibration.map((body) => body.partition))).toEqual(
      new Set(["calibration"]),
    );
    expect(new Set(holdout.map((body) => body.partition))).toEqual(
      new Set(["holdout"]),
    );
    expect(new Set(transfer.map((body) => body.partition))).toEqual(
      new Set(["transfer"]),
    );
  });

  it("keeps holdout and transfer cases out of calibration enumeration", async () => {
    const manifest = await loadReplayManifest();
    const calibration = await loadReplayPartition("calibration");
    const protectedIds = new Set(
      manifest.cases
        .filter((entry) => entry.partition !== "calibration")
        .map((entry) => entry.case_id),
    );

    expect(
      calibration.some((body) => protectedIds.has(body.case_id)),
    ).toBe(false);
  });
});
