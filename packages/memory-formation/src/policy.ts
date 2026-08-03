import {
  AutomaticMemoryPolicyDecisionSchema,
  AutomaticMemoryPolicyInputSchema,
  type AutomaticMemoryPolicyDecision,
  type AutomaticMemoryPolicyInput,
} from "@memo-graph/contracts";
import type { z } from "zod";

type DecisionFields = Pick<
  AutomaticMemoryPolicyDecision,
  "disposition" | "reason_codes" | "requires_user_confirmation"
>;

const ACTIVATION_THRESHOLDS = {
  stable_user_preference: {
    explicitness: 0.9,
    expectedReuse: 0.75,
    stability: 0.9,
    confidence: 0.9,
  },
  user_correction: {
    explicitness: 0.9,
    expectedReuse: 0.7,
    stability: 0.85,
    confidence: 0.9,
  },
  repository_convention: {
    explicitness: 0.9,
    expectedReuse: 0.8,
    stability: 0.85,
    confidence: 0.9,
  },
  confirmed_project_decision: {
    explicitness: 0.9,
    expectedReuse: 0.7,
    stability: 0.9,
    confidence: 0.9,
  },
} as const;

function decision(
  input: AutomaticMemoryPolicyInput,
  fields: DecisionFields,
): AutomaticMemoryPolicyDecision {
  return AutomaticMemoryPolicyDecisionSchema.parse({
    schema_version: input.schema_version,
    decision_id: input.decision_id,
    proposal_id: input.proposal.proposal_id,
    mode: input.mode,
    memory_kind:
      input.proposal.category === "confirmed_project_decision"
        ? "semantic"
        : "procedural",
    decided_at: input.decided_at,
    policy_version: input.policy_version,
    ...fields,
  });
}

function scopeRequiresReview(input: AutomaticMemoryPolicyInput): boolean {
  if (input.proposal.recommended_scope === "repository") {
    return input.target_scope.kind !== "workspace";
  }
  return input.target_scope.kind !== "user";
}

function meetsActivationThresholds(input: AutomaticMemoryPolicyInput): boolean {
  const threshold = ACTIVATION_THRESHOLDS[input.proposal.category];
  return (
    input.proposal.explicitness >= threshold.explicitness &&
    input.proposal.expected_reuse >= threshold.expectedReuse &&
    input.proposal.stability >= threshold.stability &&
    input.proposal.confidence >= threshold.confidence &&
    input.proposal.conflict_likelihood < 0.25
  );
}

export function evaluateAutomaticMemoryPolicy(
  unknownInput: z.input<typeof AutomaticMemoryPolicyInputSchema>,
): AutomaticMemoryPolicyDecision {
  const input = AutomaticMemoryPolicyInputSchema.parse(unknownInput);

  if (input.mode === "disabled") {
    return decision(input, {
      disposition: "reject",
      reason_codes: ["automatic_memory_disabled"],
      requires_user_confirmation: false,
    });
  }

  if (input.exclusions.length > 0) {
    return decision(input, {
      disposition: "reject",
      reason_codes: ["excluded_content"],
      requires_user_confirmation: false,
    });
  }

  if (["sensitive", "secret"].includes(input.proposal.sensitivity)) {
    return decision(input, {
      disposition: "reject",
      reason_codes: ["sensitive_content"],
      requires_user_confirmation: false,
    });
  }

  if (input.proposal.authority_basis === "assistant_context_only") {
    return decision(input, {
      disposition: "reject",
      reason_codes: ["assistant_only_authority"],
      requires_user_confirmation: false,
    });
  }

  if (input.proposal.temporariness === "temporary") {
    return decision(input, {
      disposition: "reject",
      reason_codes: ["temporary_or_uncertain"],
      requires_user_confirmation: false,
    });
  }

  if (input.injection_risk === "confirmed") {
    return decision(input, {
      disposition: "reject",
      reason_codes: ["prompt_injection_confirmed"],
      requires_user_confirmation: false,
    });
  }

  if (input.has_local_conflict) {
    return decision(input, {
      disposition: "review_required",
      reason_codes: ["local_conflict"],
      requires_user_confirmation: true,
    });
  }

  if (input.injection_risk === "suspected") {
    return decision(input, {
      disposition: "review_required",
      reason_codes: ["prompt_injection_suspected"],
      requires_user_confirmation: true,
    });
  }

  if (input.changes_global_behavior) {
    return decision(input, {
      disposition: "review_required",
      reason_codes: ["global_behavior_change_requires_review"],
      requires_user_confirmation: true,
    });
  }

  if (scopeRequiresReview(input)) {
    return decision(input, {
      disposition: "review_required",
      reason_codes: ["scope_or_authority_requires_review"],
      requires_user_confirmation: true,
    });
  }

  if (input.mode === "observe") {
    return decision(input, {
      disposition: "candidate_only",
      reason_codes: ["observe_mode"],
      requires_user_confirmation: false,
    });
  }

  if (input.proposal.authority_basis === "mixed") {
    return decision(input, {
      disposition: "candidate_only",
      reason_codes: ["mixed_authority"],
      requires_user_confirmation: false,
    });
  }

  if (
    input.proposal.temporariness === "uncertain" ||
    !meetsActivationThresholds(input)
  ) {
    return decision(input, {
      disposition: "candidate_only",
      reason_codes: ["threshold_not_met"],
      requires_user_confirmation: false,
    });
  }

  return decision(input, {
    disposition: "activate",
    reason_codes: ["eligible_for_activation"],
    requires_user_confirmation: false,
  });
}
