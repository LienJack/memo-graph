import { describe, expect, it } from "vitest";

import {
  EvidenceRecordSchema,
  ProviderFormationResultSchema,
  canonicalSha256,
  type ProviderFormationRequest,
} from "../../packages/contracts/src/index.js";
import {
  AutomaticMemoryFormationJobSchema,
} from "../../packages/storage-sqlite/src/index.js";
import {
  MemoryFormationService,
  type MemoryFormationProvider,
} from "../../packages/memory-formation/src/index.js";

const NOW = "2026-08-03T08:00:00.000Z";
const scope = {
  kind: "workspace",
  id: "workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
} as const;

function evidence(input: {
  id: string;
  sequence: number;
  speaker: "user" | "assistant";
  text: string;
}) {
  const authority = input.speaker === "user" ? "user_stated" : "observed";
  const payload = {
    storage: "inline" as const,
    text: input.text,
    media_type: "text/plain",
  };
  return EvidenceRecordSchema.parse({
    schema_version: "1.0.0",
    evidence_id: input.id,
    sequence: input.sequence,
    occurred_at: NOW,
    recorded_at: NOW,
    scope,
    actor: { principal_id: "user_local", authority },
    source: "conversation_turn",
    authority,
    sensitivity: "internal",
    payload,
    content_hash: canonicalSha256(payload),
  });
}

function job() {
  return AutomaticMemoryFormationJobSchema.parse({
    schema_version: "1.0.0",
    job_id: "formation:job-1",
    turn_key: "turn:key-1",
    project_id: "project:one",
    project_identity_hash: `sha256:${"a".repeat(64)}`,
    principal_id: "user_local",
    scope,
    session_id: "thr_1",
    turn_id: "turn_1",
    generation: 1,
    user_event_id: "hook:user-1",
    assistant_event_id: "hook:assistant-1",
    user_evidence_id: "evidence:user-1",
    assistant_evidence_id: "evidence:assistant-1",
    status: "processing",
    attempts: 1,
    available_at: NOW,
    claimed_by: "worker_1",
    lease_expires_at: "2026-08-03T08:01:00.000Z",
  });
}

class FakeProvider implements MemoryFormationProvider {
  readonly id = "fake_provider";
  constructor(
    private readonly build: (
      request: ProviderFormationRequest,
    ) => Record<string, unknown>[],
  ) {}

  async extract(request: ProviderFormationRequest) {
    return ProviderFormationResultSchema.parse({
      schema_version: "1.0.0",
      request_id: request.request_id,
      provider_id: this.id,
      model: "fake-model",
      completed_at: NOW,
      proposals: this.build(request),
      usage: { input_tokens: 100, output_tokens: 30 },
    });
  }
}

describe("automatic-memory formation replay", () => {
  it("activates an implicit durable presentation preference without remember wording", async () => {
    const records = [
      evidence({
        id: "evidence:user-1",
        sequence: 0,
        speaker: "user",
        text: "I consistently prefer concise Chinese explanations.",
      }),
      evidence({
        id: "evidence:assistant-1",
        sequence: 1,
        speaker: "assistant",
        text: "Understood; I will keep the explanation concise.",
      }),
    ];
    const proposed: unknown[] = [];
    const provider = new FakeProvider((request) => [{
      schema_version: "1.0.0",
      proposal_id: "proposal:preference-1",
      category: "stable_user_preference",
      summary: "The user prefers concise Chinese explanations.",
      logical_key: "user.presentation.explanation_style",
      recommended_scope: "global_user",
      sensitivity: "internal",
      authority_basis: "user_explicit",
      temporariness: "durable",
      explicitness: 0.96,
      expected_reuse: 0.95,
      stability: 0.95,
      confidence: 0.97,
      conflict_likelihood: 0.05,
      evidence: [{
        evidence_id: request.turns[0]?.evidence_id,
        speaker: "user",
        authority: "user_stated",
        content_hash: request.turns[0]?.content_hash,
      }],
    }]);
    const service = new MemoryFormationService({
      provider,
      model: "fake-model",
      mode: "balanced",
      clock: () => NOW,
      loadEvidence: async (id) => records.find((item) => item.evidence_id === id) ?? null,
      propose: async (candidate, decision) => {
        proposed.push({ candidate, decision });
        return {
          candidate_id: candidate.candidate_id,
          memory_id: "memory:preference-1",
          revision_id: "revision:preference-1",
          receipt_id: "receipt:preference-1",
        };
      },
    });

    const result = await service.process(job());
    expect(result.decisions).toMatchObject([
      { disposition: "activate", reason_codes: ["eligible_for_activation"] },
    ]);
    expect(proposed).toMatchObject([
      {
        candidate: {
          scope: { kind: "user", id: "user_local" },
          inferred: false,
          requires_user_confirmation: false,
        },
      },
    ]);
  });

  it("rejects a temporary one-turn instruction even when the provider scores it highly", async () => {
    const records = [
      evidence({
        id: "evidence:user-1",
        sequence: 0,
        speaker: "user",
        text: "For this task only, output JSON.",
      }),
      evidence({
        id: "evidence:assistant-1",
        sequence: 1,
        speaker: "assistant",
        text: "I will output JSON for this task.",
      }),
    ];
    let proposeCalls = 0;
    const service = new MemoryFormationService({
      provider: new FakeProvider((request) => [{
        schema_version: "1.0.0",
        proposal_id: "proposal:temporary-1",
        category: "stable_user_preference",
        summary: "The user prefers JSON output.",
        logical_key: "user.presentation.output_format",
        recommended_scope: "global_user",
        sensitivity: "internal",
        authority_basis: "user_explicit",
        temporariness: "durable",
        explicitness: 0.99,
        expected_reuse: 0.99,
        stability: 0.99,
        confidence: 0.99,
        conflict_likelihood: 0,
        evidence: [{
          evidence_id: request.turns[0]?.evidence_id,
          speaker: "user",
          authority: "user_stated",
          content_hash: request.turns[0]?.content_hash,
        }],
      }]),
      model: "fake-model",
      mode: "balanced",
      clock: () => NOW,
      loadEvidence: async (id) => records.find((item) => item.evidence_id === id) ?? null,
      propose: async (candidate) => {
        proposeCalls += 1;
        return {
          candidate_id: candidate.candidate_id,
          memory_id: null,
          revision_id: null,
          receipt_id: null,
        };
      },
    });

    const result = await service.process(job());
    expect(result.decisions).toMatchObject([
      { disposition: "reject", reason_codes: ["excluded_content"] },
    ]);
    expect(proposeCalls).toBe(0);
  });
});
