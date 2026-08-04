import { describe, expect, it } from "vitest";

import {
  EvidenceRecordSchema,
  MemoryCandidateSchema,
  canonicalSha256,
} from "../../packages/contracts/src/index.js";
import { evaluateAdmission } from "../../packages/memory-kernel/src/governance.js";

const NOW = "2026-08-03T08:00:00.000Z";
const scope = { kind: "workspace", id: "workspace_automatic" } as const;

function evidence(input: {
  id: string;
  authority: "user_stated" | "observed";
  text: string;
}) {
  const payload = {
    storage: "inline" as const,
    text: input.text,
    media_type: "text/plain",
  };
  return EvidenceRecordSchema.parse({
    schema_version: "1.0.0",
    evidence_id: input.id,
    sequence: input.authority === "user_stated" ? 0 : 1,
    occurred_at: NOW,
    recorded_at: NOW,
    scope,
    actor: { principal_id: "user_local", authority: input.authority },
    source: "conversation_turn",
    authority: input.authority,
    sensitivity: "internal",
    payload,
    content_hash: canonicalSha256(payload),
  });
}

function candidate(transformName: string) {
  const content = {
    storage: "inline" as const,
    text: "The project decision is confirmed by the user.",
    media_type: "text/plain",
  };
  return MemoryCandidateSchema.parse({
    schema_version: "1.0.0",
    candidate_id: `candidate:${transformName}`,
    logical_key: "repository.decision.confirmed",
    kind: "semantic",
    scope,
    sensitivity: "internal",
    inferred: false,
    content,
    content_hash: canonicalSha256(content),
    evidence_ids: ["evidence:user", "evidence:assistant"],
    validity: { valid_from: NOW, valid_to: null, recorded_at: NOW },
    injection_risk: "none",
    requires_user_confirmation: false,
    transform: { name: transformName, version: "1.0.0" },
  });
}

describe("automatic-memory admission authority", () => {
  it("allows bounded assistant context only for governed user confirmation", () => {
    const records = [
      evidence({
        id: "evidence:user",
        authority: "user_stated",
        text: "Confirmed. Use that design.",
      }),
      evidence({
        id: "evidence:assistant",
        authority: "observed",
        text: "The design separates capture from admission.",
      }),
    ];

    expect(
      evaluateAdmission(candidate("automatic-memory-formation"), records),
    ).toMatchObject({ decision: "activate" });
    expect(
      evaluateAdmission(candidate("untrusted-transform"), records),
    ).toMatchObject({ decision: "quarantine" });
  });
});
