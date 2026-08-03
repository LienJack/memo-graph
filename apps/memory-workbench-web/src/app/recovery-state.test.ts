import { describe, expect, it } from "vitest";

import { recoveryPolicy, type RecoveryState } from "./recovery-state.js";

describe("recoveryPolicy", () => {
  it("defines authority, mutation, focus, and polling behavior for every state", () => {
    const states: readonly RecoveryState<readonly string[]>[] = [
      { kind: "initial-loading", message: "loading" },
      { kind: "refreshing", message: "refresh", retained: ["cached"] },
      { kind: "ready", message: "ready", content: ["current"] },
      { kind: "ready-empty", message: "empty" },
      { kind: "filtered-empty", message: "filtered", filtersApplied: 1 },
      { kind: "governance-excluded", message: "excluded", excludedCount: 2 },
      { kind: "truncated", message: "truncated", retained: ["bounded"], omittedCount: 4 },
      { kind: "degraded", message: "degraded", retained: ["canonical"], reasonCode: "GRAPH_STALE" },
      { kind: "blocked", message: "blocked", reasonCode: "STORAGE_BLOCKED" },
      { kind: "unauthorized", message: "unauthorized" },
      { kind: "expired", message: "expired" },
      { kind: "disconnected", message: "disconnected", stale: ["old"] },
      { kind: "stale-instance", message: "stale", stale: ["old"] },
      { kind: "failed", message: "failed", stale: null, retryable: true },
    ];

    expect(states.map((state) => recoveryPolicy(state))).toHaveLength(14);
    for (const state of states) {
      const policy = recoveryPolicy(state);
      expect(policy.focusTarget).toBeTruthy();
      expect(policy.polling).toBeTruthy();
      if (["unauthorized", "expired", "disconnected", "stale-instance", "failed"].includes(state.kind)) {
        expect(policy.mutations).toBe("disabled");
        expect(policy.polling).toBe("stop");
      }
    }
  });

  it("keeps verified canonical content in degraded mode", () => {
    const policy = recoveryPolicy({
      kind: "degraded",
      message: "graph unavailable",
      retained: ["canonical"],
      reasonCode: "GRAPH_UNAVAILABLE",
    });
    expect(policy.contentTreatment).toBe("retained-degraded");
    expect(policy.primaryAction).toBe("open-health");
  });
});
