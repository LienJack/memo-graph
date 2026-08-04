import { describe, expect, it } from "vitest";

import {
  AutomaticMemoryPolicyInputSchema,
  canonicalSha256,
} from "../../packages/contracts/src/index.js";
import { evaluateAutomaticMemoryPolicy } from "../../packages/memory-formation/src/index.js";
import { loadAutomaticMemoryReplayCorpus } from "../helpers/automatic-memory-replay.js";

const NOW = "2026-08-03T08:00:00.000Z";

describe("automatic memory bilingual qualification corpus", () => {
  it("has zero false activation across every exclusion and risk case", () => {
    const corpus = loadAutomaticMemoryReplayCorpus();
    const results = corpus.cases.map((fixture) => {
      const proposal = {
        schema_version: "1.0.0",
        proposal_id: `proposal:${fixture.id}`,
        category: fixture.category,
        summary: fixture.utterance,
        logical_key: `fixture.${fixture.id}`,
        recommended_scope: fixture.recommended_scope,
        sensitivity: fixture.sensitivity,
        authority_basis: fixture.authority_basis,
        temporariness: fixture.temporariness,
        explicitness: 0.97,
        expected_reuse: 0.95,
        stability: 0.95,
        confidence: 0.97,
        conflict_likelihood: fixture.conflict ? 0.9 : 0.02,
        evidence: [{
          evidence_id: `evidence:${fixture.id}`,
          speaker: "user",
          authority: "user_stated",
          content_hash: canonicalSha256(fixture.utterance),
        }],
      };
      const input = AutomaticMemoryPolicyInputSchema.parse({
        schema_version: "1.0.0",
        decision_id: `decision:${fixture.id}`,
        mode: "balanced",
        policy_version: "1.0.0",
        decided_at: NOW,
        target_scope: {
          kind: fixture.target_scope,
          id: fixture.target_scope === "user" ? "user_local" : "workspace_local",
        },
        proposal,
        exclusions: fixture.exclusions,
        has_local_conflict: fixture.conflict,
        injection_risk: fixture.injection_risk,
        changes_global_behavior: fixture.global_change,
      });
      return {
        id: fixture.id,
        expected: fixture.expected,
        actual: evaluateAutomaticMemoryPolicy(input).disposition,
      };
    });
    expect(results.filter((result) => result.actual !== result.expected)).toEqual([]);
    expect(results.filter((result) => result.expected === "activate")).toHaveLength(4);
    expect(results.filter((result) =>
      result.expected !== "activate" && result.actual === "activate"
    )).toEqual([]);
  });
});
