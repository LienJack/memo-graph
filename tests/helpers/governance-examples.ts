import {
  MemoryCandidateSchema,
  MemoryProposeInputSchema,
  canonicalSha256,
} from "../../packages/contracts/src/index.js";

import { NOW, USER_ACTOR, USER_SCOPE } from "./examples.js";

export function memoryCandidate(options: {
  candidateId?: string;
  logicalKey?: string;
  kind?: "episodic" | "semantic" | "procedural";
  scope?: { kind: "user" | "workspace"; id: string };
  sensitivity?:
    | "public"
    | "internal"
    | "personal"
    | "sensitive"
    | "secret";
  inferred?: boolean;
  text?: string;
  evidenceIds?: string[];
  injectionRisk?: "none" | "suspected" | "confirmed";
  requiresUserConfirmation?: boolean;
  validFrom?: string;
  validTo?: string | null;
}) {
  const content = {
    storage: "inline",
    text:
      options.text ?? "Prefer evidence-dense Chinese technical explanations.",
    media_type: "text/plain",
  } as const;
  return MemoryCandidateSchema.parse({
    schema_version: "1.0.0",
    candidate_id: options.candidateId ?? "candidate_pref_1",
    logical_key:
      options.logicalKey ?? "user.preference.explanation_style",
    kind: options.kind ?? "semantic",
    scope: options.scope ?? USER_SCOPE,
    sensitivity: options.sensitivity ?? "personal",
    inferred: options.inferred ?? false,
    content,
    content_hash: canonicalSha256(content),
    evidence_ids: options.evidenceIds ?? ["evidence_storage_1"],
    validity: {
      valid_from: options.validFrom ?? NOW,
      valid_to: options.validTo ?? null,
      recorded_at: NOW,
    },
    injection_risk: options.injectionRisk ?? "none",
    requires_user_confirmation:
      options.requiresUserConfirmation ?? false,
    transform: {
      name: "memory-proposal",
      version: "1.0.0",
    },
  });
}

export function memoryProposal(options: {
  candidate?: ReturnType<typeof memoryCandidate>;
  idempotencyKey?: string;
  requestId?: string;
  scope?: { kind: "user" | "workspace"; id: string };
}) {
  const candidate = options.candidate ?? memoryCandidate({});
  return MemoryProposeInputSchema.parse({
    envelope: {
      schema_version: "1.0.0",
      request_id: options.requestId ?? "request_memory_propose_1",
      tool: "memory_propose",
      safety_class: "proposal",
      actor_claim: USER_ACTOR,
      scopes: [options.scope ?? candidate.scope],
      purpose: "Propose one governed L1 memory",
      reason: "Persist an evidence-bound candidate",
      requested_at: NOW,
      idempotency_key:
        options.idempotencyKey ?? "memory-propose-request-001",
    },
    candidate,
  });
}

export function revisionCommand(options: {
  memoryId: string;
  expectedRevisionId: string;
  candidate: ReturnType<typeof memoryCandidate>;
  idempotencyKey: string;
}) {
  return {
    idempotency_key: options.idempotencyKey,
    principal_id: "user_local",
    actor_authority: "user_stated",
    scope: options.candidate.scope,
    requested_at: NOW,
    memory_id: options.memoryId,
    expected_revision_id: options.expectedRevisionId,
    candidate: options.candidate,
    evaluation: {
      decision: "activate",
      reason: "live exact-scope user-stated evidence is eligible",
    },
  } as const;
}
