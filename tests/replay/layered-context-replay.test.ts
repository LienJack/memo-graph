import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  canonicalSha256Omitting,
  type EvaluationPartition,
} from "../../packages/contracts/src/index.js";
import {
  externalBaselineCompiler,
  currentDependencyLockHash,
  loadAllG3Cases,
  loadG3Manifest,
  loadG3Partition,
  runThreeArms,
} from "../helpers/g3-replay.js";

const currentCommit = execFileSync(
  "git",
  ["rev-parse", "HEAD"],
  { encoding: "utf8" },
).trim();

function comparableIdentity(
  identity: Awaited<ReturnType<typeof runThreeArms>>["accepted"]["identity"],
) {
  return {
    protocol_version: identity.protocol_version,
    case_id: identity.case_id,
    partition: identity.partition,
    base_case_hash: identity.base_case_hash,
    overlay_hash: identity.overlay_hash,
    request_hash: identity.request_hash,
    token_budget: identity.token_budget,
    ablation_lane: identity.ablation_lane,
  };
}

describe("frozen G3 layered Context replay", () => {
  it("binds every immutable M0 case and keeps partitions isolated", async () => {
    const manifests = await loadG3Manifest();
    expect(
      new Set(manifests.overlay.cases.map((entry) => entry.case_id)),
    ).toEqual(
      new Set(manifests.base.cases.map((entry) => entry.case_id)),
    );
    for (const partition of [
      "calibration",
      "holdout",
      "transfer",
    ] satisfies EvaluationPartition[]) {
      const cases = await loadG3Partition(partition);
      expect(cases.length).toBeGreaterThan(0);
      expect(
        new Set(cases.map((entry) => entry.base.partition)),
      ).toEqual(new Set([partition]));
      expect(
        new Set(cases.map((entry) => entry.overlay.partition)),
      ).toEqual(new Set([partition]));
    }
  });

  it("runs deterministic comparable three-arm outputs at every budget", async () => {
    const dependencyLockHash = await currentDependencyLockHash();
    for (const loaded of await loadAllG3Cases()) {
      for (const budget of loaded.overlay.token_budgets) {
        const first = await runThreeArms(loaded, budget, {
          implementationCommit: currentCommit,
          dependencyLockHash,
        });
        const second = await runThreeArms(loaded, budget, {
          implementationCommit: currentCommit,
          dependencyLockHash,
        });

        expect(comparableIdentity(first.accepted.identity)).toEqual(
          comparableIdentity(first.noProjection.identity),
        );
        expect(comparableIdentity(first.noProjection.identity)).toEqual(
          comparableIdentity(first.layered.identity),
        );
        expect(first.accepted.metrics).toEqual(
          first.noProjection.metrics,
        );
        expect(first.accepted.context_frozen_hash).toBe(
          first.noProjection.context_frozen_hash,
        );
        expect(canonicalJson(first)).toBe(canonicalJson(second));
        for (const result of Object.values(first)) {
          expect(
            canonicalSha256Omitting(result, ["result_hash"]),
          ).toBe(result.result_hash);
          expect(result.metrics.budget_overflow).toBe(false);
          expect(result.metrics.rebuild_equal).toBe(true);
        }
      }
    }
  }, 30_000);

  it("retains explicit conflict and evidence metrics", async () => {
    const dependencyLockHash = await currentDependencyLockHash();
    const conflict = (await loadG3Partition("calibration")).find(
      (entry) => entry.base.case_id === "cal_conflict_supersession",
    );
    expect(conflict).toBeDefined();
    if (conflict === undefined) {
      throw new Error("conflict fixture is required");
    }
    const { layered } = await runThreeArms(conflict, 1_800, {
      implementationCommit: currentCommit,
      dependencyLockHash,
    });
    expect(layered.metrics.conflict_explanations).toBeGreaterThan(0);
    expect(layered.metrics.evidence_units_included).toBe(
      layered.metrics.evidence_units_required,
    );
    expect(layered.metrics.task_units_included).toBe(
      layered.metrics.task_units_required,
    );
  });

  it.runIf(process.env.G3_ACCEPTED_M2_COMPILER_MODULE !== undefined)(
    "executes Arm A from the exact accepted M2 checkout",
    async () => {
      const modulePath = process.env.G3_ACCEPTED_M2_COMPILER_MODULE;
      if (modulePath === undefined) {
        throw new Error("accepted M2 compiler path is required");
      }
      const dependencyLockHash = await currentDependencyLockHash();
      const compiler = externalBaselineCompiler(modulePath);
      for (const loaded of await loadAllG3Cases()) {
        for (const budget of loaded.overlay.token_budgets) {
          const results = await runThreeArms(loaded, budget, {
            implementationCommit: currentCommit,
            dependencyLockHash,
            acceptedCompiler: compiler,
          });
          expect(results.accepted.metrics).toEqual(
            results.noProjection.metrics,
          );
          expect(results.accepted.context_frozen_hash).toBe(
            results.noProjection.context_frozen_hash,
          );
        }
      }
    },
    60_000,
  );
});
