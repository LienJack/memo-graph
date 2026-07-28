import { describe, expect, it } from "vitest";

import { CandidateChangeSchema } from "../../packages/contracts/src/index.js";
import { HASH_A, NOW, USER_SCOPE } from "../helpers/examples.js";

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "1.0.0",
    candidate_id: "candidate_1",
    candidate_type: "retrieval_policy",
    status: "proposed",
    scope: USER_SCOPE,
    authority: "inferred",
    sensitivity: "internal",
    impact: "medium",
    confidence: 0.9,
    evidence_ids: ["evidence_eval_1"],
    proposed_at: NOW,
    proposed_change_hash: HASH_A,
    requires_user_confirmation: false,
    authorization_receipt_id: null,
    reason: "Reduce repeated irrelevant topic matches",
    ...overrides,
  };
}

describe("candidate-only learning contracts", () => {
  it("keeps an ordinary candidate in proposed state", () => {
    expect(CandidateChangeSchema.parse(candidate()).status).toBe("proposed");
  });

  it.each([
    { impact: "high" },
    { confidence: 0.5 },
    { sensitivity: "sensitive" },
    { candidate_type: "core_projection" },
  ])("requires confirmation for governed candidate $impact", (overrides) => {
    expect(
      CandidateChangeSchema.safeParse(candidate(overrides)).success,
    ).toBe(false);
  });

  it("does not allow a confirmation-required candidate to jump to released", () => {
    expect(
      CandidateChangeSchema.safeParse(
        candidate({
          status: "released",
          impact: "high",
          requires_user_confirmation: true,
        }),
      ).success,
    ).toBe(false);
  });

  it("accepts a confirmed release only when its authorization receipt is named", () => {
    expect(
      CandidateChangeSchema.parse(
        candidate({
          status: "released",
          impact: "high",
          requires_user_confirmation: true,
          authorization_receipt_id: "receipt_user_approval",
        }),
      ).status,
    ).toBe("released");
  });
});
