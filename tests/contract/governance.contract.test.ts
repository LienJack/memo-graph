import { describe, expect, it } from "vitest";

import {
  ApprovalGrantSchema,
  GovernedMemoryRecordSchema,
  MemoryCorrectInputSchema,
  MemoryDeleteInputSchema,
  MemoryObjectSchema,
  MemoryPinInputSchema,
  MemoryProposeInputSchema,
  MemoryStatusEventSchema,
  MemoryUsageRuleSchema,
  MemoryUsageSetInputSchema,
  PurgeReceiptSchema,
  canonicalSha256Omitting,
  receiptHashIsValid,
  sealReceipt,
} from "../../packages/contracts/src/index.js";
import {
  HASH_A,
  HASH_B,
  LATER,
  NOW,
  USER_ACTOR,
  USER_SCOPE,
  validMemoryRevision,
} from "../helpers/examples.js";

function mutationEnvelope(
  tool:
    | "memory_correct"
    | "memory_pin"
    | "memory_usage_set"
    | "memory_delete",
  safetyClass: "important_mutation" | "destructive",
) {
  return {
    schema_version: "1.0.0",
    request_id: `request_${tool}`,
    tool,
    safety_class: safetyClass,
    actor_claim: USER_ACTOR,
    scopes: [USER_SCOPE],
    purpose: "Exercise governed memory control",
    reason: "The user explicitly requested this memory change",
    requested_at: NOW,
    idempotency_key: `${tool}-request-001`,
    expected_revision_id: "revision_pref_1",
    approval_id: "approval_1",
    dry_run: false,
  } as const;
}

describe("L1 governance contracts", () => {
  it("requires an active L1 record to bind one matching admission decision", () => {
    const revision = validMemoryRevision();
    const record = {
      memory: {
        schema_version: "1.0.0",
        memory_id: revision.memory_id,
        kind: revision.kind,
        scope: revision.scope,
        lifecycle: "active",
        current_revision_id: revision.revision_id,
        pinned: false,
        context_eligible: true,
        created_at: NOW,
        updated_at: NOW,
      },
      current_revision: revision,
      admission: {
        schema_version: "1.0.0",
        decision_id: "decision_pref_1",
        memory_id: revision.memory_id,
        revision_id: revision.revision_id,
        decision: "activate",
        decided_by: USER_ACTOR,
        decided_at: NOW,
        reason: "Direct user-stated evidence is eligible",
        conflict_group_id: null,
        requires_user_confirmation: false,
      },
    } as const;

    expect(GovernedMemoryRecordSchema.safeParse(record).success).toBe(true);
    expect(
      GovernedMemoryRecordSchema.safeParse({
        ...record,
        admission: null,
      }).success,
    ).toBe(false);
    expect(
      GovernedMemoryRecordSchema.safeParse({
        ...record,
        current_revision: {
          ...revision,
          evidence_ids: [],
        },
      }).success,
    ).toBe(false);
  });

  it("keeps tombstone epochs on tombstone status events only", () => {
    const event = {
      schema_version: "1.0.0",
      status_event_id: "status_1",
      memory_id: "memory_pref",
      revision_id: "revision_pref_1",
      action: "tombstone",
      lifecycle: "purged",
      actor: USER_ACTOR,
      occurred_at: NOW,
      reason: "The user requested deletion",
      tombstone_epoch: 2,
    } as const;

    expect(MemoryStatusEventSchema.safeParse(event).success).toBe(true);
    expect(
      MemoryStatusEventSchema.safeParse({
        ...event,
        action: "revoke",
        lifecycle: "revoked",
      }).success,
    ).toBe(false);
  });

  it.each(["candidate", "superseded"] as const)(
    "prevents %s memory from entering default Context",
    (lifecycle) => {
      expect(
        MemoryObjectSchema.safeParse({
          schema_version: "1.0.0",
          memory_id: "memory_pref",
          kind: "semantic",
          scope: USER_SCOPE,
          lifecycle,
          current_revision_id: "revision_pref_1",
          pinned: false,
          context_eligible: true,
          created_at: NOW,
          updated_at: LATER,
        }).success,
      ).toBe(false);
    },
  );

  it("represents pin and Context usage as independent overlays", () => {
    expect(
      MemoryUsageRuleSchema.parse({
        schema_version: "1.0.0",
        usage_rule_id: "usage_1",
        memory_id: "memory_pref",
        revision_id: "revision_pref_1",
        effect: "block",
        context_scope: null,
        actor: USER_ACTOR,
        occurred_at: NOW,
        reason: "Do not include this memory in model Context",
      }).effect,
    ).toBe("block");

    expect(
      MemoryPinInputSchema.safeParse({
        envelope: mutationEnvelope("memory_pin", "important_mutation"),
        memory_id: "memory_pref",
        pinned: true,
      }).success,
    ).toBe(true);
    const usage = {
      envelope: mutationEnvelope(
        "memory_usage_set",
        "important_mutation",
      ),
      memory_id: "memory_pref",
      effect: "block",
    } as const;
    expect(
      MemoryUsageSetInputSchema.safeParse({
        ...usage,
        context_scope: USER_SCOPE,
      }).success,
    ).toBe(true);
    expect(
      MemoryUsageSetInputSchema.safeParse({
        ...usage,
        context_scope: { kind: "workspace", id: "foreign_workspace" },
      }).success,
    ).toBe(false);
  });

  it("requires request-bound approval for an effect but not a dry run", () => {
    const correction = {
      envelope: mutationEnvelope("memory_correct", "important_mutation"),
      memory_id: "memory_pref",
      replacement: {
        content: {
          storage: "inline",
          text: "Prefer evidence-dense Chinese technical explanations.",
          media_type: "text/plain",
        },
        content_hash: HASH_B,
        evidence_ids: ["evidence_correction"],
        validity: {
          valid_from: NOW,
          valid_to: null,
          recorded_at: NOW,
        },
        reason: "The user corrected the preference",
      },
    } as const;

    expect(MemoryCorrectInputSchema.safeParse(correction).success).toBe(true);
    expect(
      MemoryCorrectInputSchema.safeParse({
        ...correction,
        envelope: {
          ...correction.envelope,
          approval_id: null,
        },
      }).success,
    ).toBe(false);
    expect(
      MemoryCorrectInputSchema.safeParse({
        ...correction,
        envelope: {
          ...correction.envelope,
          approval_id: null,
          dry_run: true,
        },
      }).success,
    ).toBe(true);
  });

  it("binds approval grants to one important or destructive request", () => {
    const unsignedGrant = {
      schema_version: "1.0.0",
      approval_id: "approval_1",
      principal_id: "user_local",
      tool: "memory_delete",
      safety_class: "destructive",
      scopes: [USER_SCOPE],
      request_hash: HASH_A,
      issued_at: NOW,
      expires_at: LATER,
      manifest_hash: `sha256:${"0".repeat(64)}`,
    } as const;
    const grant = {
      ...unsignedGrant,
      manifest_hash: canonicalSha256Omitting(unsignedGrant, [
        "manifest_hash",
      ]),
    } as const;

    expect(ApprovalGrantSchema.safeParse(grant).success).toBe(true);
    expect(
      ApprovalGrantSchema.safeParse({
        ...grant,
        tool: "memory_search",
        safety_class: "read_only",
      }).success,
    ).toBe(false);
    expect(
      ApprovalGrantSchema.safeParse({
        ...grant,
        expires_at: "2026-07-28T11:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("requires expected revision and destructive safety for delete", () => {
    const deletion = {
      envelope: mutationEnvelope("memory_delete", "destructive"),
      memory_id: "memory_pref",
    } as const;

    expect(MemoryDeleteInputSchema.safeParse(deletion).success).toBe(true);
    expect(
      MemoryDeleteInputSchema.safeParse({
        ...deletion,
        envelope: {
          ...deletion.envelope,
          expected_revision_id: null,
        },
      }).success,
    ).toBe(false);
  });

  it("accepts evidence-bound proposals without trusting claimed authority", () => {
    expect(
      MemoryProposeInputSchema.safeParse({
        envelope: {
          schema_version: "1.0.0",
          request_id: "request_memory_propose",
          tool: "memory_propose",
          safety_class: "proposal",
          actor_claim: USER_ACTOR,
          scopes: [USER_SCOPE],
          purpose: "Propose one L1 candidate",
          reason: "Persist an evidence-bound candidate",
          requested_at: NOW,
          idempotency_key: "memory-propose-request-001",
        },
        candidate: {
          schema_version: "1.0.0",
          candidate_id: "candidate_pref_1",
          logical_key: "user.preference.explanation_style",
          kind: "semantic",
          scope: USER_SCOPE,
          sensitivity: "personal",
          inferred: false,
          content: {
            storage: "inline",
            text: "Prefer concise Chinese technical explanations.",
            media_type: "text/plain",
          },
          content_hash: HASH_A,
          evidence_ids: ["evidence_pref"],
          validity: {
            valid_from: NOW,
            valid_to: null,
            recorded_at: NOW,
          },
          injection_risk: "none",
          requires_user_confirmation: false,
          transform: {
            name: "memory-proposal",
            version: "1.0.0",
          },
        },
      }).success,
    ).toBe(true);
  });

  it("seals complete and incomplete purge outcomes without ambiguity", () => {
    const complete = PurgeReceiptSchema.parse(
      sealReceipt({
        schema_version: "1.0.0",
        receipt_id: "receipt_purge_complete",
        created_at: NOW,
        state: "purged",
        request_hash: HASH_A,
        kind: "purge",
        purge_job_id: "purge_job_1",
        target_memory_ids: ["memory_pref"],
        tombstone_epoch: 2,
        stores_checked: ["memory_revisions", "fts"],
        store_outcomes: [
          {
            store: "memory_revisions",
            status: "verified",
            residual_hashes: [],
            error_code: null,
            checked_at: NOW,
          },
          {
            store: "fts",
            status: "verified",
            residual_hashes: [],
            error_code: null,
            checked_at: NOW,
          },
        ],
        residual_hashes: [],
        completed: true,
      }),
    );
    expect(receiptHashIsValid(complete)).toBe(true);

    expect(
      PurgeReceiptSchema.safeParse(
        sealReceipt({
          ...complete,
          receipt_id: "receipt_purge_invalid",
          state: "partial",
          store_outcomes: [
            {
              store: "memory_revisions",
              status: "residual",
              residual_hashes: [HASH_A],
              error_code: null,
              checked_at: NOW,
            },
          ],
          residual_hashes: [HASH_A],
          completed: true,
          receipt_hash: HASH_A,
        }),
      ).success,
    ).toBe(false);
  });
});
