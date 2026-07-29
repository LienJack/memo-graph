import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  assertExactG5EvidencePaths,
  assertSingleG5Implementation,
  evaluateG5Eligibility,
  verifyG5Evidence,
} from "../../scripts/verify-g5-evidence.mjs";

type JsonObject = Record<string, unknown>;

async function json(path: string): Promise<JsonObject> {
  return JSON.parse(await readFile(path, "utf8")) as JsonObject;
}

async function evidence() {
  const [replay, canary, resource, manifest] =
    await Promise.all([
      json("docs/evaluations/g5-replay-report.json"),
      json("docs/evaluations/g5-canary-report.json"),
      json("docs/evaluations/g5-resource-report.json"),
      json(
        "docs/evaluations/g5-reproducibility-manifest.json",
      ),
    ]);
  return { replay, canary, resource, manifest };
}

const paths = [
  "docs/evaluations/g5-canary-report.json",
  "docs/evaluations/g5-code-review.md",
  "docs/evaluations/g5-replay-report.json",
  "docs/evaluations/g5-reproducibility-manifest.json",
  "docs/evaluations/g5-resource-report.json",
  "docs/evaluations/g5-verification-report.json",
];

describe("G5 evidence integrity", () => {
  it("independently verifies every current hard rule", async () => {
    const result = await verifyG5Evidence();
    expect(result.eligible).toBe(true);
    expect(Object.values(result.checks).every(Boolean)).toBe(true);
    expect(result.manifest.decision_status).toBe("PENDING_U9");
  });

  it("rejects missing and extra unbound evidence paths", () => {
    expect(() =>
      assertExactG5EvidencePaths(paths.slice(1)),
    ).toThrow("G5 evidence path set");
    expect(() =>
      assertExactG5EvidencePaths([
        ...paths,
        "docs/evaluations/g5-unbound-report.json",
      ]),
    ).toThrow("G5 evidence path set");
  });

  it("never qualifies a false or missing hard check", () => {
    expect(
      evaluateG5Eligibility({
        replay: true,
        canary: true,
        rollback: false,
      }).eligible,
    ).toBe(false);
    expect(
      evaluateG5Eligibility({
        replay: true,
        canary: undefined,
        rollback: true,
      }).eligible,
    ).toBe(false);
  });

  it("rejects candidate substitution across paired reports", async () => {
    const current = await evidence();
    expect(() =>
      assertSingleG5Implementation({
        ...current,
        canary: {
          ...current.canary,
          implementation: {
            ...(current.canary.implementation as JsonObject),
            commit: "0".repeat(40),
          },
        },
      }),
    ).toThrow("candidate substitution");
  });
});
