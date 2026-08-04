import { describe, expect, it } from "vitest";

import {
  AutomaticMemoryAuditSummarySchema,
  AutomaticMemoryCaptureOutcomeSchema,
  AutomaticMemoryCategorySchema,
  AutomaticMemoryEventSchema,
  AutomaticMemoryExclusionReasonSchema,
  AutomaticMemoryPolicyDecisionSchema,
  FormationProposalSchema,
  MemoryCandidateSchema,
  ProviderFormationRequestSchema,
  ProviderFormationResultSchema,
  RedactionReportSchema,
} from "../../packages/contracts/src/index.js";

const NOW = "2026-08-03T08:00:00.000Z";
const HASH = `sha256:${"a".repeat(64)}`;
const REDACTED_HASH = `sha256:${"b".repeat(64)}`;

function redactionReport() {
  return RedactionReportSchema.parse({
    schema_version: "1.0.0",
    policy_version: "1.0.0",
    original_hash: HASH,
    redacted_hash: REDACTED_HASH,
    action: "redacted",
    finding_categories: ["credential"],
    egress_safe: true,
  });
}

function proposal() {
  return FormationProposalSchema.parse({
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
  });
}

describe("automatic memory contracts", () => {
  it("freezes the four allowed categories and every exclusion class", () => {
    expect(AutomaticMemoryCategorySchema.options).toEqual([
      "stable_user_preference",
      "user_correction",
      "repository_convention",
      "confirmed_project_decision",
    ]);
    expect(AutomaticMemoryExclusionReasonSchema.options).toEqual([
      "temporary_instruction",
      "task_progress",
      "assistant_speculation",
      "unconfirmed_conclusion",
      "secret_or_sensitive",
      "tool_log",
      "global_procedural_change",
      "system_or_developer_instruction",
    ]);
  });

  it("accepts normalized lifecycle events and rejects unknown hook fields", () => {
    const event = {
      schema_version: "1.0.0",
      event_kind: "user_prompt_submit",
      event_id: "event-001",
      session_id: "thr_001",
      turn_id: "turn-001",
      cwd: "/workspace/repository",
      occurred_at: NOW,
      model: "gpt-5",
      generation: 1,
      prompt: "Keep contract changes evidence-backed.",
    };

    expect(AutomaticMemoryEventSchema.parse(event).event_kind).toBe(
      "user_prompt_submit",
    );
    expect(
      AutomaticMemoryEventSchema.safeParse({ ...event, transcript: "secret" })
        .success,
    ).toBe(false);
  });

  it("records capture outcomes without retaining event content", () => {
    const capture = AutomaticMemoryCaptureOutcomeSchema.parse({
      schema_version: "1.0.0",
      capture_id: "capture-001",
      event_id: "event-001",
      session_id: "thr_001",
      outcome: "spooled",
      reason_code: "runtime_unavailable",
      recorded_at: NOW,
      payload_hash: HASH,
    });

    expect(capture.outcome).toBe("spooled");
    expect(
      AutomaticMemoryCaptureOutcomeSchema.safeParse({
        ...capture,
        prompt: "must not be copied into capture metadata",
      }).success,
    ).toBe(false);
  });

  it("keeps remote provider proposals structurally separate from memory candidates", () => {
    const result = ProviderFormationResultSchema.parse({
      schema_version: "1.0.0",
      request_id: "request-001",
      provider_id: "provider-openai",
      model: "formation-model",
      completed_at: NOW,
      proposals: [proposal()],
      usage: { input_tokens: 120, output_tokens: 30 },
    });

    expect(result.proposals).toHaveLength(1);
    expect(MemoryCandidateSchema.safeParse(result.proposals[0]).success).toBe(
      false,
    );
  });

  it("bounds remote egress to redacted turns and excludes active memory context", () => {
    const request = ProviderFormationRequestSchema.parse({
      schema_version: "1.0.0",
      request_id: "request-001",
      provider_id: "provider-openai",
      model: "formation-model",
      prompt_version: "1.0.0",
      policy_version: "1.0.0",
      schema_revision: "1.0.0",
      requested_at: NOW,
      project_identity_hash: HASH,
      redaction: redactionReport(),
      turns: [
        {
          evidence_id: "evidence-user-001",
          role: "user",
          text: "Use contract-first changes in this repository.",
          content_hash: HASH,
        },
      ],
    });

    expect(request.turns[0]?.role).toBe("user");
    expect(
      ProviderFormationRequestSchema.safeParse({
        ...request,
        active_memories: ["Never send this"],
      }).success,
    ).toBe(false);
    expect(
      ProviderFormationRequestSchema.safeParse({
        ...request,
        redaction: { ...request.redaction, egress_safe: false },
      }).success,
    ).toBe(false);
  });

  it("requires local decisions to preserve review and activation invariants", () => {
    const base = {
      schema_version: "1.0.0",
      decision_id: "decision-001",
      proposal_id: "proposal-001",
      mode: "balanced",
      disposition: "review_required",
      memory_kind: "procedural",
      reason_codes: ["scope_or_authority_requires_review"],
      requires_user_confirmation: true,
      decided_at: NOW,
      policy_version: "1.0.0",
    };

    expect(AutomaticMemoryPolicyDecisionSchema.safeParse(base).success).toBe(
      true,
    );
    expect(
      AutomaticMemoryPolicyDecisionSchema.safeParse({
        ...base,
        disposition: "activate",
      }).success,
    ).toBe(false);
  });

  it("keeps audit summaries content-free and finite", () => {
    const audit = AutomaticMemoryAuditSummarySchema.parse({
      schema_version: "1.0.0",
      audit_id: "audit-001",
      session_id: "thr_001",
      event_id: "event-001",
      request_id: "request-001",
      provider_id: "provider-openai",
      proposal_count: 1,
      disposition_counts: {
        activate: 0,
        candidate_only: 1,
        review_required: 0,
        reject: 0,
      },
      reason_codes: ["observe_mode"],
      redaction_action: "accepted",
      recorded_at: NOW,
    });

    expect(audit.proposal_count).toBe(1);
    expect(
      AutomaticMemoryAuditSummarySchema.safeParse({
        ...audit,
        raw_content: "must not be logged",
      }).success,
    ).toBe(false);
  });
});
