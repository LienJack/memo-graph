import { describe, expect, it } from "vitest";

import { RequestCoordinator } from "./request-coordinator.js";

describe("RequestCoordinator", () => {
  it("prevents a late obsolete response from overwriting the current request", async () => {
    const coordinator = new RequestCoordinator();
    let resolveFirst: ((value: string) => void) | undefined;
    const first = coordinator.run(
      () =>
        new Promise<string>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const second = coordinator.run(async () => "current");
    resolveFirst?.("obsolete");

    await expect(second).resolves.toEqual({ status: "accepted", value: "current" });
    await expect(first).resolves.toEqual({ status: "superseded" });
  });

  it("aborts active work when cancelled", async () => {
    const coordinator = new RequestCoordinator();
    const result = coordinator.run(
      (signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    coordinator.cancel();
    await expect(result).resolves.toEqual({ status: "superseded" });
  });
});
