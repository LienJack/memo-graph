export const HASH_A = `sha256:${"a".repeat(64)}`;
export const HASH_B = `sha256:${"b".repeat(64)}`;
export const NOW = "2026-07-28T12:00:00.000Z";
export const LATER = "2026-07-28T13:00:00.000Z";

export const USER_SCOPE = {
  kind: "user",
  id: "user_local",
} as const;

export const USER_ACTOR = {
  principal_id: "user_local",
  authority: "user_stated",
} as const;

export function validMemoryRevision() {
  return {
    schema_version: "1.0.0",
    revision_id: "revision_pref_1",
    memory_id: "memory_pref",
    revision: 1,
    abstraction: "l1_memory",
    lifecycle: "active",
    kind: "semantic",
    scope: USER_SCOPE,
    authority: "user_stated",
    sensitivity: "personal",
    validity: {
      valid_from: NOW,
      valid_to: null,
      recorded_at: NOW,
    },
    inferred: false,
    content: {
      storage: "inline",
      text: "Prefer concise Chinese technical explanations.",
      media_type: "text/plain",
    },
    content_hash: HASH_A,
    evidence_ids: ["evidence_pref"],
    derived_from_revision_ids: [],
    supersedes_revision_id: null,
    transform: {
      name: "user-confirmed-memory",
      version: "1.0.0",
    },
  } as const;
}

export function validReadRequest() {
  return {
    schema_version: "1.0.0",
    request_id: "request_1",
    tool: "memory_search",
    safety_class: "read_only",
    actor_claim: USER_ACTOR,
    scopes: [USER_SCOPE],
    purpose: "Recall a stable preference",
    reason: "Compile governed context for the current task",
    requested_at: NOW,
  } as const;
}
