import { generateKeyPairSync, sign, verify } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ArtifactPurgeAuditSchema,
  ArtifactStoreIdSchema,
  OperationIntentSchema,
  OperatorActionReceiptSchema,
  OperationalArtifactClassSchema,
  OperationalArtifactResidualAuditSchema,
  OperationalPurgeVerificationSchema,
  OperationalStatusSchema,
  OperatorConfirmationTrustSchema,
  OperatorConfirmationSchema,
  ReleaseQualificationSchema,
  canonicalSha256,
  canonicalSha256Omitting,
  operatorConfirmationSigningPayload,
  reduceOperationalStatus,
  verifyOperatorConfirmationBinding,
  type OperationalComponent,
  type OperationalObservation,
} from "../../packages/contracts/src/index.js";

const NOW = "2026-07-30T08:00:00.000Z";
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const CONFIRMATION_PURPOSE = "memo-graph/operator-confirmation/v1";
const CONFIRMATION_ALGORITHM = "Ed25519";

function readyObservation(
  component: OperationalComponent = "canonical_store",
): OperationalObservation {
  return {
    component,
    state: "ready",
    reason_code: null,
    action_code: "NONE",
    measurements: [],
  };
}

function sealIntent(overrides: Record<string, unknown> = {}) {
  const value = {
    schema_version: "1.0.0",
    operation_id: "operation_restore_1",
    command: "restore",
    principal_id: "user_local",
    root_ref: "root_primary",
    source_ref: "bundle_candidate",
    target_ref: "root_restored",
    recovery_anchor_hash: HASH_A,
    configuration_digest: HASH_B,
    key_state_digest: HASH_A,
    expected_state_digest: HASH_A,
    expected_frontier_digest: HASH_B,
    parameters_digest: canonicalSha256({
      command: "restore",
      root_ref: "root_primary",
      source_ref: "backup_verified",
      target_ref: "root_restored",
    }),
    nonce: "nonce_restore_1",
    issued_at: NOW,
    expires_at: "2026-07-30T08:05:00.000Z",
    ...overrides,
  };
  return OperationIntentSchema.parse({
    ...value,
    intent_hash: canonicalSha256Omitting(value, ["intent_hash"]),
  });
}

function confirmationFor(
  intent: ReturnType<typeof sealIntent>,
  overrides: Record<string, unknown> = {},
) {
  const unsigned = {
    schema_version: "1.0.0",
    confirmation_id: "confirmation_restore_1",
    intent_hash: intent.intent_hash,
    command: intent.command,
    principal_id: intent.principal_id,
    nonce: intent.nonce,
    algorithm: CONFIRMATION_ALGORITHM,
    purpose: CONFIRMATION_PURPOSE,
    authority_key_id: "operator_authority_1",
    authority_key_generation: 1,
    issued_at: "2026-07-30T08:00:01.000Z",
    expires_at: "2026-07-30T08:04:00.000Z",
    ...overrides,
  };
  return OperatorConfirmationSchema.parse({
    ...unsigned,
    signed_payload_hash: canonicalSha256Omitting(unsigned, [
      "signed_payload_hash",
      "signature",
    ]),
    signature: "a".repeat(86),
  });
}

function resealStatus(
  status: ReturnType<typeof reduceOperationalStatus>,
  changes: Record<string, unknown>,
) {
  const next = { ...status, ...changes };
  return {
    ...next,
    status_digest: canonicalSha256Omitting(next, ["status_digest"]),
  };
}

describe("operational contracts", () => {
  it("reduces reordered observations to one deterministic status", () => {
    const observations: OperationalObservation[] = [
      {
        component: "writer_queue",
        state: "read_only",
        reason_code: "QUEUE_PRESSURE",
        action_code: "WAIT_FOR_WRITER_CAPACITY",
        measurements: [
          {
            component: "writer_queue",
            name: "queue_depth",
            value: 50,
            unit: "count",
          },
        ],
      },
      {
        component: "fts",
        state: "rebuilding",
        reason_code: "FTS_UNAVAILABLE",
        action_code: "REBUILD_FTS",
        measurements: [],
      },
      readyObservation(),
    ];
    const qualification = {
      status: "pending" as const,
      tested_envelope_digest: null,
    };
    const first = reduceOperationalStatus({
      observed_at: NOW,
      qualification,
      observations,
    });
    const second = reduceOperationalStatus({
      observed_at: NOW,
      qualification,
      observations: [...observations].reverse(),
    });
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      readiness: "read_only",
      primary_reason: "QUEUE_PRESSURE",
      next_action: "WAIT_FOR_WRITER_CAPACITY",
      exit_class: "operator_action_required",
    });
  });

  it.each([
    ["pending", null],
    ["GO", HASH_A],
    ["NO-GO", HASH_A],
    ["outside_tested_envelope", HASH_A],
  ] as const)("keeps %s qualification independent from readiness", (status, digest) => {
    const result = reduceOperationalStatus({
      observed_at: NOW,
      qualification: {
        status,
        tested_envelope_digest: digest,
      },
      observations: [readyObservation()],
    });
    expect(result.readiness).toBe("ready");
    expect(result.qualification.status).toBe(status);
  });

  it("rejects malformed, unordered, duplicated, and unsealed status", () => {
    const valid = reduceOperationalStatus({
      observed_at: NOW,
      qualification: {
        status: "pending",
        tested_envelope_digest: null,
      },
      observations: [
        {
          component: "fts",
          state: "degraded",
          reason_code: "FTS_UNAVAILABLE",
          action_code: "REBUILD_FTS",
          measurements: [],
        },
        {
          component: "canonical_store",
          state: "blocked",
          reason_code: "CANONICAL_CORRUPTION",
          action_code: "RESTORE_VERIFIED_BACKUP",
          measurements: [],
        },
      ],
    });
    expect(
      OperationalStatusSchema.safeParse({
        ...valid,
        reasons: [...valid.reasons].reverse(),
      }).success,
    ).toBe(false);
    expect(
      OperationalStatusSchema.safeParse(
        resealStatus(valid, { exit_class: "success" }),
      ).success,
    ).toBe(false);
    const unrelatedReason = {
      ...valid.reasons[0],
      reason_code: "MIGRATION_DRIFT",
    };
    expect(
      OperationalStatusSchema.safeParse(
        resealStatus(valid, {
          reasons: [unrelatedReason, ...valid.reasons.slice(1)],
          primary_reason: "MIGRATION_DRIFT",
          next_action: unrelatedReason.action_code,
        }),
      ).success,
    ).toBe(false);
    expect(
      OperationalStatusSchema.safeParse({
        ...valid,
        reasons: [valid.reasons[0], valid.reasons[0]],
      }).success,
    ).toBe(false);
    expect(
      OperationalStatusSchema.safeParse({
        ...valid,
        primary_reason: "FTS_UNAVAILABLE",
      }).success,
    ).toBe(false);
    expect(
      OperationalStatusSchema.safeParse({
        ...valid,
        raw_path: "/private/secret",
      }).success,
    ).toBe(false);
    expect(
      OperationalStatusSchema.safeParse({
        ...valid,
        status_digest: HASH_A,
      }).success,
    ).toBe(false);
    expect(() =>
      reduceOperationalStatus({
        observed_at: NOW,
        qualification: {
          status: "pending",
          tested_envelope_digest: null,
        },
        observations: [
          {
            ...readyObservation(),
            measurements: [
              {
                component: "canonical_store",
                name: "duration_ms",
                value: Number.POSITIVE_INFINITY,
                unit: "milliseconds",
              },
            ],
          },
        ],
      }),
    ).toThrow();
    for (const value of [-1, 1.5]) {
      expect(() =>
        reduceOperationalStatus({
          observed_at: NOW,
          qualification: {
            status: "pending",
            tested_envelope_digest: null,
          },
          observations: [
            {
              ...readyObservation(),
              measurements: [
                {
                  component: "canonical_store",
                  name: "frontier",
                  value,
                  unit: "epoch",
                },
              ],
            },
          ],
        }),
      ).toThrow();
    }
  });

  it("rejects malformed qualification digests", () => {
    expect(
      ReleaseQualificationSchema.safeParse({
        status: "GO",
        tested_envelope_digest: null,
      }).success,
    ).toBe(false);
    expect(
      ReleaseQualificationSchema.safeParse({
        status: "pending",
        tested_envelope_digest: HASH_A,
      }).success,
    ).toBe(false);
  });

  it("binds confirmation to the exact intent, authority, expiry, and use", () => {
    const intent = sealIntent();
    const keys = generateKeyPairSync("ed25519");
    const trust = OperatorConfirmationTrustSchema.parse({
      algorithm: CONFIRMATION_ALGORITHM,
      purpose: CONFIRMATION_PURPOSE,
      authority_key_id: "operator_authority_1",
      authority_key_generation: 1,
      public_key_spki: keys.publicKey
        .export({ type: "spki", format: "der" })
        .toString("base64url"),
      max_ttl_seconds: 300,
      revoked_key_ids: [],
    });
    const unsigned = confirmationFor(intent);
    const confirmation = OperatorConfirmationSchema.parse({
      ...unsigned,
      signature: sign(
        null,
        Buffer.from(operatorConfirmationSigningPayload(unsigned), "utf8"),
        keys.privateKey,
      ).toString("base64url"),
    });
    expect(
      verifyOperatorConfirmationBinding({
        intent,
        confirmation,
        now: "2026-07-30T08:02:00.000Z",
        trust,
        verifySignature: ({ payload, signature, publicKeySpki }) =>
          verify(
            null,
            Buffer.from(payload, "utf8"),
            {
              key: Buffer.from(publicKeySpki, "base64url"),
              type: "spki",
              format: "der",
            },
            Buffer.from(signature, "base64url"),
          ),
      }),
    ).toEqual(confirmation);
    for (const changed of [
      confirmationFor(intent, { command: "purge_retry" }),
      confirmationFor(intent, { nonce: "nonce_other" }),
      confirmationFor(intent, { principal_id: "other_user" }),
      confirmationFor(intent, { authority_key_id: "self_signed_key" }),
    ]) {
      expect(() =>
        verifyOperatorConfirmationBinding({
          intent,
          confirmation: changed,
          now: "2026-07-30T08:02:00.000Z",
          trust,
          verifySignature: () => false,
        }),
      ).toThrow("operator confirmation is invalid");
    }
    expect(
      OperatorConfirmationSchema.safeParse({
        ...confirmation,
        purpose: "memo-graph/other-purpose/v1",
      }).success,
    ).toBe(false);
    expect(
      OperatorConfirmationSchema.safeParse({
        ...confirmation,
        algorithm: "RSA-PSS",
      }).success,
    ).toBe(false);
    expect(() =>
      verifyOperatorConfirmationBinding({
        intent,
        confirmation,
        now: "2026-07-30T08:05:00.000Z",
        trust,
        verifySignature: () => true,
      }),
    ).toThrow("operator confirmation is invalid");
    for (const rejected of [
      confirmationFor(intent, {
        issued_at: "2026-07-30T08:03:00.000Z",
        expires_at: "2026-07-30T08:04:00.000Z",
      }),
      confirmationFor(intent, {
        issued_at: "2026-07-30T08:00:01.000Z",
        expires_at: "2026-07-30T08:05:01.000Z",
      }),
      confirmationFor(intent, {
        issued_at: "2026-07-30T08:00:01.000Z",
        expires_at: "2026-07-30T08:06:00.000Z",
      }),
    ]) {
      expect(() =>
        verifyOperatorConfirmationBinding({
          intent,
          confirmation: rejected,
          now: "2026-07-30T08:02:00.000Z",
          trust,
          verifySignature: () => true,
        }),
      ).toThrow("operator confirmation is invalid");
    }
    expect(() =>
      verifyOperatorConfirmationBinding({
        intent,
        confirmation,
        now: "2026-07-30T08:02:00.000Z",
        trust,
        consumedConfirmationIds: new Set([confirmation.confirmation_id]),
        verifySignature: () => true,
      }),
    ).toThrow("operator confirmation is invalid");
    expect(() =>
      verifyOperatorConfirmationBinding({
        intent,
        confirmation,
        now: "2026-07-30T08:02:00.000Z",
        trust: {
          ...trust,
          revoked_key_ids: [trust.authority_key_id],
        },
        verifySignature: () => true,
      }),
    ).toThrow("operator confirmation is invalid");
    expect(
      OperatorConfirmationTrustSchema.safeParse({
        ...trust,
        public_key_spki: Buffer.from("not-an-ed25519-spki").toString(
          "base64url",
        ),
      }).success,
    ).toBe(false);
  });

  it("rejects a target change under the same sealed intent", () => {
    const intent = sealIntent();
    expect(
      OperationIntentSchema.safeParse({
        ...intent,
        target_ref: "root_attacker",
      }).success,
    ).toBe(false);
  });

  it("keeps legacy purge stores separate from the versioned artifact audit", () => {
    expect(ArtifactStoreIdSchema.options).toEqual([
      "canonical_evidence",
      "canonical_memory",
      "fts",
      "context",
      "layered_projection",
      "graph_projection_disabled",
      "vector_projection_disabled",
      "learning",
      "blobs",
      "encrypted_content",
      "backups",
      "operational_artifacts",
    ]);
    const stores = ArtifactStoreIdSchema.options.map((store_id) => ({
      store_id,
      store_version: 1,
      required_for_purge:
        store_id !== "graph_projection_disabled" &&
        store_id !== "vector_projection_disabled",
      outcome:
        store_id.endsWith("_disabled")
          ? ("verified_ineligible" as const)
          : ("verified_removed" as const),
      debt_count: 0,
      frontier_hash: HASH_A,
      checked_at: NOW,
      error_code: null,
    }));
    const purgeAudit = ArtifactPurgeAuditSchema.parse({
        schema_version: "1.0.0",
        audit_id: "purge_audit_1",
        tombstone_epoch: 3,
        stores,
        completed: true,
        audit_hash: canonicalSha256Omitting(
          {
            schema_version: "1.0.0",
            audit_id: "purge_audit_1",
            tombstone_epoch: 3,
            stores,
            completed: true,
          },
          ["audit_hash"],
        ),
      });
    expect(purgeAudit.stores).toHaveLength(12);
    const classes = OperationalArtifactClassSchema.options.map(
      (artifact_class) => ({
        artifact_class,
        outcome:
          artifact_class === "quarantine"
            ? ("quarantined_non_publishable" as const)
            : ("verified_present" as const),
        file_count: 0,
        byte_count: 0,
        inventory_hash: HASH_A,
        error_code: null,
      }),
    );
    const residualBody = {
      schema_version: "1.0.0" as const,
      audit_id: "residual_audit_1",
      checked_at: NOW,
      classes,
      completed: true,
    };
    const residualAudit =
      OperationalArtifactResidualAuditSchema.parse({
        ...residualBody,
        audit_hash: canonicalSha256(residualBody),
      });
    const verificationBody = {
      schema_version: "1.0.0" as const,
      purge_audit: purgeAudit,
      residual_audit: residualAudit,
      completed: true,
    };
    const verification = OperationalPurgeVerificationSchema.parse({
      ...verificationBody,
      verification_hash: canonicalSha256(verificationBody),
    });
    expect(verification.completed).toBe(true);
    expect(
      OperationalPurgeVerificationSchema.safeParse({
        ...verification,
        completed: false,
      }).success,
    ).toBe(false);
    expect(
      OperationalPurgeVerificationSchema.safeParse({
        ...verification,
        verification_hash: HASH_B,
      }).success,
    ).toBe(false);
  });

  it("accepts only content-free, hash-bound operator action receipts", () => {
    const value = {
      schema_version: "1.0.0",
      receipt_id: "operator_receipt_1",
      operation_id: "operation_restore_1",
      command: "restore",
      intent_hash: HASH_A,
      confirmation_id: "confirmation_restore_1",
      confirmation_key_id: "operator_authority_1",
      confirmation_key_generation: 1,
      state: "receipt_committed",
      effect_digest: HASH_B,
      result_digest: HASH_A,
      created_at: NOW,
      completed_at: NOW,
    };
    expect(
      OperatorActionReceiptSchema.parse({
        ...value,
        receipt_hash: canonicalSha256Omitting(value, ["receipt_hash"]),
      }).receipt_id,
    ).toBe("operator_receipt_1");
    expect(
      OperatorActionReceiptSchema.safeParse({
        ...value,
        receipt_hash: canonicalSha256Omitting(value, ["receipt_hash"]),
        raw_path: "/private/memory-root",
      }).success,
    ).toBe(false);
  });
});
