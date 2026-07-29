import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  assertSingleFrozenCandidate,
  evaluateG4BEligibility,
  resolveG4BTaskArtifact,
  verifyG4BEvidence,
} from "../../scripts/verify-g4b-evidence.mjs";

type JsonObject = Record<string, unknown>;

async function json(path: string): Promise<JsonObject> {
  return JSON.parse(await readFile(path, "utf8")) as JsonObject;
}

async function currentEvidence() {
  const [replay, resource, manifest] = await Promise.all([
    json("docs/evaluations/g4b-replay-report.json"),
    json("docs/evaluations/g4b-resource-report.json"),
    json("docs/evaluations/g4b-reproducibility-manifest.json"),
  ]);
  return {
    replay: replay as JsonObject & {
      calibration_receipt: JsonObject;
    },
    resource,
    manifest: manifest as JsonObject & {
      review: JsonObject;
    },
  };
}

describe("G4B evidence integrity", () => {
  it("resolves immutable gate evidence after Trellis archives the task", () => {
    expect(
      resolveG4BTaskArtifact(
        "evidence/u2-candidate-gate.json",
      ),
    ).toBe(
      ".trellis/tasks/archive/2026-07/07-29-agent-memory-runtime-m4b/evidence/u2-candidate-gate.json",
    );
  });

  it("independently verifies the current hash-bound NO-GO evidence", async () => {
    const result = await verifyG4BEvidence();
    expect(result.eligibility.go).toBe(false);
    expect(result.eligibility.checks).toMatchObject({
      one_candidate: true,
      lock_identity: true,
      dependency_gate: true,
      governance_gate: true,
      recovery_gate: true,
      replay_repeat: true,
      utility_gate: false,
      resource_gate: false,
      review_gate: true,
      evidence_gate: true,
    });
  });

  it("rejects a second candidate and post-holdout calibration change", async () => {
    const evidence = await currentEvidence();
    expect(() =>
      assertSingleFrozenCandidate({
        ...evidence,
        resource: {
          ...evidence.resource,
          candidate_commit: "0".repeat(40),
        },
      }),
    ).toThrow("candidate substitution");
    expect(() =>
      assertSingleFrozenCandidate({
        ...evidence,
        replay: {
          ...evidence.replay,
          calibration_receipt: {
            ...evidence.replay.calibration_receipt,
            configuration_hash: `sha256:${"0".repeat(64)}`,
          },
        },
      }),
    ).toThrow("calibration drift");
  });

  it("never permits GO with a missing or failed hard gate", async () => {
    const evidence = await currentEvidence();
    const current = evaluateG4BEligibility(evidence);
    expect(current.go).toBe(false);
    expect(current.checks.utility_gate).toBe(false);
    expect(current.checks.resource_gate).toBe(false);

    const missingReview = evaluateG4BEligibility({
      ...evidence,
      manifest: {
        ...evidence.manifest,
        review: {
          ...evidence.manifest.review,
          result: "MISSING",
        },
      },
    });
    expect(missingReview.go).toBe(false);
    expect(missingReview.checks.review_gate).toBe(false);
  });
});
