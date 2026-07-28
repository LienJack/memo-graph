import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  CanonicalHashSchema,
  RecallLaneSchema,
  canonicalJson,
} from "../../packages/contracts/src/index.js";
import {
  runG3ReplayCase,
} from "../../packages/memory-kernel/src/index.js";
import {
  currentDependencyLockHash,
  loadG3Partition,
} from "../helpers/g3-replay.js";

const currentCommit = execFileSync(
  "git",
  ["rev-parse", "HEAD"],
  { encoding: "utf8" },
).trim();

describe("G3 projection ablation", () => {
  it("attributes the multi-hop utility gain to the core lane", async () => {
    const dependencyLockHash = await currentDependencyLockHash();
    const loaded = (await loadG3Partition("holdout")).find(
      (entry) => entry.base.case_id === "hold_multi_hop_lineage",
    );
    expect(loaded).toBeDefined();
    if (loaded === undefined) {
      throw new Error("multi-hop fixture is required");
    }
    const common = {
      base: loaded.base,
      overlay: loaded.overlay,
      overlay_hash: loaded.overlay_descriptor.content_hash,
      token_budget: 1_800,
      implementation_commit: currentCommit,
      dependency_lock_hash: dependencyLockHash,
    } as const;
    const baseline = await runG3ReplayCase({
      ...common,
      arm: "m3_no_projection",
    });
    const layered = await runG3ReplayCase({
      ...common,
      arm: "m3_layered",
    });
    const withoutCore = await runG3ReplayCase({
      ...common,
      arm: "m3_layered",
      omit_lane: "core",
    });

    expect(layered.metrics.task_units_included).toBeGreaterThan(
      baseline.metrics.task_units_included,
    );
    expect(withoutCore.metrics.task_units_included).toBe(
      baseline.metrics.task_units_included,
    );
  });

  it("produces deterministic leave-one-lane-out diagnostics", async () => {
    const dependencyLockHash = await currentDependencyLockHash();
    const loaded = (await loadG3Partition("calibration"))[0];
    expect(loaded).toBeDefined();
    if (loaded === undefined) {
      throw new Error("calibration fixture is required");
    }
    for (const lane of RecallLaneSchema.options) {
      const options = {
        arm: "m3_layered" as const,
        base: loaded.base,
        overlay: loaded.overlay,
        overlay_hash: loaded.overlay_descriptor.content_hash,
        token_budget: loaded.overlay.token_budgets[0] ?? 128,
        implementation_commit: currentCommit,
        dependency_lock_hash: CanonicalHashSchema.parse(
          dependencyLockHash,
        ),
        omit_lane: lane,
      };
      const first = await runG3ReplayCase(options);
      const second = await runG3ReplayCase(options);
      expect(first.identity.ablation_lane).toBe(lane);
      expect(canonicalJson(first)).toBe(canonicalJson(second));
    }
  });
});
