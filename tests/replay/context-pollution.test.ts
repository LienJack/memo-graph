import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  currentDependencyLockHash,
  loadG3Partition,
  runThreeArms,
} from "../helpers/g3-replay.js";

const currentCommit = execFileSync(
  "git",
  ["rev-parse", "HEAD"],
  { encoding: "utf8" },
).trim();

describe("G3 Context pollution and governance", () => {
  it("keeps protected partitions clean and budget bounded", async () => {
    const dependencyLockHash = await currentDependencyLockHash();
    for (const partition of ["holdout", "transfer"] as const) {
      for (const loaded of await loadG3Partition(partition)) {
        for (const budget of loaded.overlay.token_budgets) {
          const { layered } = await runThreeArms(loaded, budget, {
            implementationCommit: currentCommit,
            dependencyLockHash,
          });
          const prohibited = new Set(
            loaded.overlay.rubric.prohibited_pollution,
          );
          expect(
            layered.metrics.pollution_categories.filter((category) =>
              prohibited.has(category)
            ),
          ).toEqual([]);
          expect(layered.metrics.governance_violations).toEqual([]);
          expect(layered.metrics.budget_overflow).toBe(false);
          expect(layered.metrics.rebuild_equal).toBe(true);
          expect(layered.metrics.abstention_correct).toBe(true);
        }
      }
    }
  });

  it("reports a failed projection lane and retains the safe L1 fallback", async () => {
    const dependencyLockHash = await currentDependencyLockHash();
    const failureCase = (await loadG3Partition("holdout")).find(
      (entry) => entry.base.case_id === "hold_projection_failure",
    );
    expect(failureCase).toBeDefined();
    if (failureCase === undefined) {
      throw new Error("projection failure fixture is required");
    }
    const { layered } = await runThreeArms(failureCase, 1_800, {
      implementationCommit: currentCommit,
      dependencyLockHash,
    });
    expect(layered.metrics.status).toBe("DEGRADED");
    expect(layered.metrics.degraded_lanes).toEqual(["topic"]);
    expect(layered.metrics.included_source_memory_ids).toContain(
      "mem_runtime_node24",
    );
    expect(layered.metrics.task_units_included).toBe(1);
  });

  it("never exposes holdout or transfer through calibration loading", async () => {
    const calibration = await loadG3Partition("calibration");
    const protectedCases = [
      ...(await loadG3Partition("holdout")),
      ...(await loadG3Partition("transfer")),
    ];
    const protectedIds = new Set(
      protectedCases.map((entry) => entry.base.case_id),
    );
    expect(
      calibration.some((entry) =>
        protectedIds.has(entry.base.case_id)
      ),
    ).toBe(false);
  });
});
