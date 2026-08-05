import { describe, expect, it, vi } from "vitest";

import type { OperationalStatus } from "../../packages/contracts/src/index.js";
import { waitForSettledRuntimeStatus } from "../../apps/memory-workbench-host/src/host.js";

function status(readiness: "ready" | "blocked"): OperationalStatus {
  return { readiness } as OperationalStatus;
}

describe("memory workbench runtime readiness", () => {
  it("does not downgrade a progressing startup write that needs more than two seconds", async () => {
    let elapsedMs = 0;
    const observe = vi
      .fn()
      .mockResolvedValueOnce({
        status: status("blocked"),
        startupWorkPending: true,
      })
      .mockResolvedValueOnce({
        status: status("blocked"),
        startupWorkPending: true,
      })
      .mockResolvedValueOnce({
        status: status("blocked"),
        startupWorkPending: true,
      })
      .mockResolvedValueOnce({
        status: status("ready"),
        startupWorkPending: false,
      });

    const result = await waitForSettledRuntimeStatus({
      observe,
      now: () => elapsedMs,
      delay: async () => {
        elapsedMs += 2_500;
      },
    });

    expect(result.readiness).toBe("ready");
    expect(observe).toHaveBeenCalledTimes(4);
  });
});
