import { describe, expect, it } from "vitest";

import {
  packContextItems,
} from "../../packages/context-compiler/src/index.js";

const ITEMS = [
  {
    key: "constraint",
    lane: "scenario_procedure" as const,
    constraint_priority: 4,
    total_score: 2,
    item: { token_estimate: 13 },
  },
  {
    key: "core",
    lane: "core" as const,
    constraint_priority: 3,
    total_score: 3,
    item: { token_estimate: 5 },
  },
  {
    key: "recent",
    lane: "recent_l1" as const,
    constraint_priority: 0,
    total_score: 4,
    item: { token_estimate: 2 },
  },
  {
    key: "topic",
    lane: "topic" as const,
    constraint_priority: 0,
    total_score: 5,
    item: { token_estimate: 1 },
  },
];

describe("layered token packer properties", () => {
  it("never exceeds any integer budget from 1 through 32,000", () => {
    for (let budget = 1; budget <= 32_000; budget += 1) {
      const packed = packContextItems(ITEMS, budget);
      expect(packed.token_used).toBeLessThanOrEqual(budget);
      expect(
        packed.included.reduce(
          (sum, candidate) => sum + candidate.item.token_estimate,
          0,
        ),
      ).toBe(packed.token_used);
    }
  });

  it("honors exact boundaries, constraint priority, and stable ties", () => {
    expect(packContextItems(ITEMS, 12).included.map((item) => item.key))
      .not.toContain("constraint");
    expect(packContextItems(ITEMS, 13).included[0]?.key).toBe(
      "constraint",
    );
    const forward = packContextItems(ITEMS, 32_000);
    const reverse = packContextItems([...ITEMS].reverse(), 32_000);
    expect(reverse).toEqual(forward);
  });
});
