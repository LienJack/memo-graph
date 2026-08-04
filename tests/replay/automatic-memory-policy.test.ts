import { describe, expect, it } from "vitest";

import {
  AutomaticMemoryPolicyInputSchema,
  type AutomaticMemoryPolicyInput,
} from "../../packages/contracts/src/index.js";
import { evaluateAutomaticMemoryPolicy } from "../../packages/memory-formation/src/index.js";

const NOW = "2026-08-03T08:00:00.000Z";
const HASH = `sha256:${"a".repeat(64)}`;

function input(
  overrides: Partial<AutomaticMemoryPolicyInput> = {},
): AutomaticMemoryPolicyInput {
  return AutomaticMemoryPolicyInputSchema.parse({
    schema_version: "1.0.0",
    decision_id: "decision-001",
    mode: "balanced",
    policy_version: "1.0.0",
    decided_at: NOW,
    target_scope: { kind: "workspace", id: "workspace-local" },
    proposal: {
      schema_version: "1.0.0",
      proposal_id: "proposal-001",
      category: "repository_convention",
      summary: "Use contract-first changes in this repository.",
      logical_key: "repository.workflow.contract_first",
      recommended_scope: "repository",
      sensitivity: "internal",
      authority_basis: "user_explicit",
      temporariness: "durable",
      explicitness: 0.96,
      expected_reuse: 0.9,
      stability: 0.92,
      confidence: 0.93,
      conflict_likelihood: 0.05,
      evidence: [
        {
          evidence_id: "evidence-user-001",
          speaker: "user",
          authority: "user_stated",
          content_hash: HASH,
        },
      ],
    },
    exclusions: [],
    has_local_conflict: false,
    injection_risk: "none",
    changes_global_behavior: false,
    ...overrides,
  });
}

describe("automatic memory local admission policy", () => {
  it.each([
    ["stable_user_preference", "global_user", "user"],
    ["user_correction", "global_user", "user"],
    ["repository_convention", "repository", "workspace"],
    ["confirmed_project_decision", "repository", "workspace"],
  ] as const)(
    "admits a high-confidence %s through the matching scope",
    (category, recommendedScope, scopeKind) => {
      const base = input();
      const decision = evaluateAutomaticMemoryPolicy(input({
        target_scope: scopeKind === "user"
          ? AutomaticMemoryPolicyInputSchema.shape.target_scope.parse({
              kind: "user",
              id: "user_local",
            })
          : base.target_scope,
        proposal: {
          ...base.proposal,
          category,
          recommended_scope: recommendedScope,
          authority_basis: category === "confirmed_project_decision"
            ? "user_confirmation"
            : "user_explicit",
        },
      }));
      expect(decision.disposition).toBe("activate");
    },
  );

  it("activates only a high-confidence, durable, low-risk explicit proposal", () => {
    const decision = evaluateAutomaticMemoryPolicy(input());

    expect(decision.disposition).toBe("activate");
    expect(decision.requires_user_confirmation).toBe(false);
    expect(decision.memory_kind).toBe("procedural");
  });

  it("never activates model-only inference or temporary instructions", () => {
    const modelOnly = evaluateAutomaticMemoryPolicy(
      input({
        proposal: {
          ...input().proposal,
          authority_basis: "assistant_context_only",
        },
      }),
    );
    const temporary = evaluateAutomaticMemoryPolicy(
      input({ exclusions: ["temporary_instruction"] }),
    );

    expect(modelOnly.disposition).toBe("reject");
    expect(temporary.disposition).toBe("reject");
  });

  it("rejects every excluded content class", () => {
    const exclusions = [
      "temporary_instruction",
      "task_progress",
      "assistant_speculation",
      "unconfirmed_conclusion",
      "secret_or_sensitive",
      "tool_log",
      "global_procedural_change",
      "system_or_developer_instruction",
    ] as const;

    for (const exclusion of exclusions) {
      const decision = evaluateAutomaticMemoryPolicy(
        input({ exclusions: [exclusion] }),
      );
      expect(decision.disposition, exclusion).toBe("reject");
      expect(decision.reason_codes).toEqual(["excluded_content"]);
    }
  });

  it("routes conflicts, sensitive data, injection, and global behavior changes safely", () => {
    expect(
      evaluateAutomaticMemoryPolicy(input({ has_local_conflict: true }))
        .disposition,
    ).toBe("review_required");
    expect(
      evaluateAutomaticMemoryPolicy(
        input({
          proposal: { ...input().proposal, sensitivity: "secret" },
        }),
      ).disposition,
    ).toBe("reject");
    expect(
      evaluateAutomaticMemoryPolicy(input({ injection_risk: "suspected" }))
        .disposition,
    ).toBe("review_required");
    expect(
      evaluateAutomaticMemoryPolicy(input({ changes_global_behavior: true }))
        .disposition,
    ).toBe("review_required");
  });

  it("keeps observe mode non-activating and disabled mode inert", () => {
    expect(evaluateAutomaticMemoryPolicy(input({ mode: "observe" })).disposition).toBe(
      "candidate_only",
    );
    expect(evaluateAutomaticMemoryPolicy(input({ mode: "disabled" })).disposition).toBe(
      "reject",
    );
  });

  it("is deterministic across replay", () => {
    const first = evaluateAutomaticMemoryPolicy(input());
    const replay = evaluateAutomaticMemoryPolicy(input());

    expect(replay).toEqual(first);
  });
});
