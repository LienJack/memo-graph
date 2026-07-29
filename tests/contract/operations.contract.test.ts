import { describe, expect, it } from "vitest";

import {
  OperationIntentSchema,
  OperationalStatusSchema,
  OperatorConfirmationSchema,
  ReleaseQualificationSchema,
  canonicalSha256Omitting,
  reduceOperationalStatus,
  verifyOperatorConfirmationBinding,
  type OperationalComponent,
  type OperationalObservation,
} from "../../packages/contracts/src/index.js";

const NOW = "2026-07-30T08:00:00.000Z";
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

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
    expected_state_digest: HASH_A,
    expected_frontier_digest: HASH_B,
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
  return OperatorConfirmationSchema.parse({
    schema_version: "1.0.0",
    confirmation_id: "confirmation_restore_1",
    intent_hash: intent.intent_hash,
    command: intent.command,
    principal_id: intent.principal_id,
    nonce: intent.nonce,
    authority_key_id: "operator_authority_1",
    issued_at: "2026-07-30T08:00:01.000Z",
    expires_at: "2026-07-30T08:04:00.000Z",
    signature: "a".repeat(64),
    ...overrides,
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
    const confirmation = confirmationFor(intent);
    expect(
      verifyOperatorConfirmationBinding({
        intent,
        confirmation,
        now: "2026-07-30T08:02:00.000Z",
        expectedAuthorityKeyId: "operator_authority_1",
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
          expectedAuthorityKeyId: "operator_authority_1",
        }),
      ).toThrow("operator confirmation is invalid");
    }
    expect(() =>
      verifyOperatorConfirmationBinding({
        intent,
        confirmation,
        now: "2026-07-30T08:05:00.000Z",
        expectedAuthorityKeyId: "operator_authority_1",
      }),
    ).toThrow("operator confirmation is invalid");
    expect(() =>
      verifyOperatorConfirmationBinding({
        intent,
        confirmation,
        now: "2026-07-30T08:02:00.000Z",
        expectedAuthorityKeyId: "operator_authority_1",
        consumedConfirmationIds: new Set([confirmation.confirmation_id]),
      }),
    ).toThrow("operator confirmation is invalid");
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
});
