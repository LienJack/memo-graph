import { z } from "zod";

import {
  canonicalSha256,
  canonicalSha256Omitting,
} from "./canonical-json.js";
import {
  CanonicalHashSchema,
  ContractVersionSchema,
  IdentifierSchema,
  UtcTimestampSchema,
} from "./common.js";

export const OperationalReadinessSchema = z.enum([
  "ready",
  "degraded",
  "read_only",
  "blocked",
]);

export const OperationalComponentSchema = z.enum([
  "configuration",
  "data_root",
  "canonical_store",
  "migrations",
  "encryption",
  "recovery",
  "resource_capacity",
  "writer_queue",
  "checkpoint",
  "maintenance",
  "purge",
  "fts",
  "layered_projection",
  "graph_projection",
  "vector_projection",
  "learning",
]);

export const OperationalComponentStateSchema = z.enum([
  "ready",
  "disabled",
  "active",
  "degraded",
  "rebuilding",
  "read_only",
  "blocked",
]);

export const OperationalReasonCodeSchema = z.enum([
  "CONFIG_INVALID",
  "DATA_ROOT_UNSAFE",
  "CANONICAL_CORRUPTION",
  "MIGRATION_DRIFT",
  "KEY_UNAVAILABLE",
  "RECOVERY_AUTHORITY_INVALID",
  "DISK_PRESSURE",
  "WAL_PRESSURE",
  "QUEUE_PRESSURE",
  "CHECKPOINT_BLOCKED",
  "PURGE_INCOMPLETE",
  "FTS_UNAVAILABLE",
  "LAYERED_PROJECTION_UNAVAILABLE",
  "LEARNING_PAUSED",
  "INTERNAL_FAILURE",
]);

export const OperationalActionCodeSchema = z.enum([
  "NONE",
  "FIX_CONFIGURATION",
  "SELECT_SAFE_DATA_ROOT",
  "RESTORE_VERIFIED_BACKUP",
  "PROVIDE_TRUSTED_KEY",
  "RECOVER_EXTERNAL_AUTHORITY",
  "FREE_LOCAL_CAPACITY",
  "WAIT_FOR_WRITER_CAPACITY",
  "RUN_CHECKPOINT",
  "RETRY_PURGE",
  "REBUILD_FTS",
  "REBUILD_LAYERED_PROJECTION",
  "INSPECT_LEARNING_CONTROL",
  "RESTART_RUNTIME",
]);

export const OperationalExitClassSchema = z.enum([
  "success",
  "inspectable_degraded",
  "operator_action_required",
  "invalid_input",
  "invalid_confirmation",
  "internal_failure",
]);

export const ReleaseQualificationSchema = z
  .object({
    status: z.enum(["pending", "GO", "NO-GO", "outside_tested_envelope"]),
    tested_envelope_digest: CanonicalHashSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const needsDigest =
      value.status === "GO" ||
      value.status === "NO-GO" ||
      value.status === "outside_tested_envelope";
    if (needsDigest !== (value.tested_envelope_digest !== null)) {
      context.addIssue({
        code: "custom",
        path: ["tested_envelope_digest"],
        message:
          "terminal and outside-envelope qualification require the tested envelope digest",
      });
    }
  });

export const OperationalMeasurementNameSchema = z.enum([
  "duration_ms",
  "capacity_bytes",
  "available_bytes",
  "queue_depth",
  "queue_capacity",
  "queue_oldest_age_ms",
  "queue_completed",
  "queue_rejected_pre_enqueue",
  "queue_rejected_transaction_start",
  "wal_bytes",
  "checkpoint_age_ms",
  "checkpoint_busy",
  "checkpoint_log",
  "checkpointed",
  "item_count",
  "frontier",
]);

export const OperationalMeasurementSchema = z
  .object({
    component: OperationalComponentSchema,
    name: OperationalMeasurementNameSchema,
    value: z.number().finite(),
    unit: z.enum(["milliseconds", "bytes", "count", "epoch"]),
  })
  .strict();

export const OperationalObservationSchema = z
  .object({
    component: OperationalComponentSchema,
    state: OperationalComponentStateSchema,
    reason_code: OperationalReasonCodeSchema.nullable(),
    action_code: OperationalActionCodeSchema,
    measurements: z.array(OperationalMeasurementSchema),
  })
  .strict()
  .superRefine((value, context) => {
    const healthy =
      value.state === "ready" ||
      value.state === "disabled" ||
      value.state === "active";
    if (healthy && value.reason_code !== null) {
      context.addIssue({
        code: "custom",
        path: ["reason_code"],
        message:
          "ready, active, or intentionally disabled components have no reason",
      });
    }
    if (!healthy && value.reason_code === null) {
      context.addIssue({
        code: "custom",
        path: ["reason_code"],
        message: "non-ready components require a stable reason",
      });
    }
    if (healthy !== (value.action_code === "NONE")) {
      context.addIssue({
        code: "custom",
        path: ["action_code"],
        message:
          "only ready, active, or intentionally disabled components use NONE",
      });
    }
    if (
      value.measurements.some(
        (measurement) => measurement.component !== value.component,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["measurements"],
        message: "measurement component must match its observation",
      });
    }
    for (const [index, measurement] of value.measurements.entries()) {
      if (
        measurement.value < 0 ||
        (measurement.unit !== "milliseconds" &&
          !Number.isSafeInteger(measurement.value))
      ) {
        context.addIssue({
          code: "custom",
          path: ["measurements", index, "value"],
          message:
            "measurements must be nonnegative and count/byte/epoch values must be safe integers",
        });
      }
    }
    const measurementKeys = value.measurements.map(
      (measurement) => `${measurement.component}:${measurement.name}`,
    );
    if (new Set(measurementKeys).size !== measurementKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["measurements"],
        message: "measurement names must be unique per component",
      });
    }
  });

export const OperationalReasonSchema = z
  .object({
    component: OperationalComponentSchema,
    state: OperationalComponentStateSchema.exclude([
      "ready",
      "disabled",
      "active",
    ]),
    reason_code: OperationalReasonCodeSchema,
    action_code: OperationalActionCodeSchema.exclude(["NONE"]),
  })
  .strict();

const READINESS_SEVERITY = {
  ready: 0,
  degraded: 1,
  read_only: 2,
  blocked: 3,
} as const satisfies Record<z.infer<typeof OperationalReadinessSchema>, number>;

const COMPONENT_TO_READINESS = {
  ready: "ready",
  disabled: "ready",
  active: "ready",
  degraded: "degraded",
  rebuilding: "degraded",
  read_only: "read_only",
  blocked: "blocked",
} as const satisfies Record<
  z.infer<typeof OperationalComponentStateSchema>,
  z.infer<typeof OperationalReadinessSchema>
>;

const REASON_ORDER = Object.fromEntries(
  OperationalReasonCodeSchema.options.map((code, index) => [code, index]),
) as Record<z.infer<typeof OperationalReasonCodeSchema>, number>;

export const OperationalStatusSchema = z
  .object({
    schema_version: ContractVersionSchema,
    observed_at: UtcTimestampSchema,
    readiness: OperationalReadinessSchema,
    qualification: ReleaseQualificationSchema,
    components: z.array(OperationalObservationSchema).min(1),
    reasons: z.array(OperationalReasonSchema),
    primary_reason: OperationalReasonCodeSchema.nullable(),
    next_action: OperationalActionCodeSchema,
    exit_class: OperationalExitClassSchema,
    status_digest: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const componentNames = value.components.map(({ component }) => component);
    if (new Set(componentNames).size !== componentNames.length) {
      context.addIssue({
        code: "custom",
        path: ["components"],
        message: "component observations must be unique",
      });
    }
    const orderedComponents = [...componentNames].sort();
    if (
      orderedComponents.some(
        (component, index) => component !== componentNames[index],
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["components"],
        message: "component observations must use deterministic ordering",
      });
    }
    const reasonCodes = value.reasons.map(({ reason_code }) => reason_code);
    if (new Set(reasonCodes).size !== reasonCodes.length) {
      context.addIssue({
        code: "custom",
        path: ["reasons"],
        message: "reason codes must be unique",
      });
    }
    const sortedReasons = [...value.reasons].sort(compareOperationalReasons);
    if (
      sortedReasons.some(
        (reason, index) =>
          reason.reason_code !== value.reasons[index]?.reason_code,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["reasons"],
        message: "reasons must use deterministic severity and code ordering",
      });
    }
    const derivedReasons = value.components
      .flatMap((component): OperationalReason[] =>
        component.reason_code === null
          ? []
          : [
              {
                component: component.component,
                state: OperationalReasonSchema.shape.state.parse(
                  component.state,
                ),
                reason_code: component.reason_code,
                action_code:
                  OperationalReasonSchema.shape.action_code.parse(
                    component.action_code,
                  ),
              },
            ],
      )
      .sort(compareOperationalReasons);
    if (
      derivedReasons.length !== value.reasons.length ||
      derivedReasons.some((reason, index) => {
        const actual = value.reasons[index];
        return (
          actual === undefined ||
          actual.component !== reason.component ||
          actual.state !== reason.state ||
          actual.reason_code !== reason.reason_code ||
          actual.action_code !== reason.action_code
        );
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["reasons"],
        message: "reasons must be derived exactly from component observations",
      });
    }
    const expectedPrimary = value.reasons[0]?.reason_code ?? null;
    const expectedAction = value.reasons[0]?.action_code ?? "NONE";
    if (value.primary_reason !== expectedPrimary) {
      context.addIssue({
        code: "custom",
        path: ["primary_reason"],
        message: "primary reason must be the first ordered reason",
      });
    }
    if (value.next_action !== expectedAction) {
      context.addIssue({
        code: "custom",
        path: ["next_action"],
        message: "next action must come from the primary reason",
      });
    }
    const expectedReadiness = value.components.reduce<
      z.infer<typeof OperationalReadinessSchema>
    >((current, component) => {
      const next = COMPONENT_TO_READINESS[component.state];
      return READINESS_SEVERITY[next] > READINESS_SEVERITY[current]
        ? next
        : current;
    }, "ready");
    if (value.readiness !== expectedReadiness) {
      context.addIssue({
        code: "custom",
        path: ["readiness"],
        message: "readiness must equal the most severe component state",
      });
    }
    const allowedExitClasses: Record<
      OperationalReadiness,
      readonly OperationalExitClass[]
    > = {
      ready: ["success"],
      degraded: ["inspectable_degraded"],
      read_only: ["operator_action_required"],
      blocked: [
        "operator_action_required",
        "invalid_input",
        "invalid_confirmation",
        "internal_failure",
      ],
    };
    if (!allowedExitClasses[value.readiness].includes(value.exit_class)) {
      context.addIssue({
        code: "custom",
        path: ["exit_class"],
        message: "exit class is incompatible with readiness",
      });
    }
    if (
      value.status_digest !==
      canonicalSha256Omitting(value, ["status_digest"])
    ) {
      context.addIssue({
        code: "custom",
        path: ["status_digest"],
        message: "status digest must bind the complete public status",
      });
    }
  });

function compareOperationalReasons(
  left: z.infer<typeof OperationalReasonSchema>,
  right: z.infer<typeof OperationalReasonSchema>,
): number {
  const readinessDelta =
    READINESS_SEVERITY[COMPONENT_TO_READINESS[right.state]] -
    READINESS_SEVERITY[COMPONENT_TO_READINESS[left.state]];
  if (readinessDelta !== 0) {
    return readinessDelta;
  }
  const reasonDelta =
    REASON_ORDER[left.reason_code] - REASON_ORDER[right.reason_code];
  return reasonDelta !== 0
    ? reasonDelta
    : left.component.localeCompare(right.component);
}

export function reduceOperationalStatus(input: {
  observed_at: z.input<typeof UtcTimestampSchema>;
  qualification: z.input<typeof ReleaseQualificationSchema>;
  observations: readonly z.input<typeof OperationalObservationSchema>[];
}): OperationalStatus {
  const observedAt = UtcTimestampSchema.parse(input.observed_at);
  const qualification = ReleaseQualificationSchema.parse(input.qualification);
  const components = input.observations
    .map((observation) => OperationalObservationSchema.parse(observation))
    .sort((left, right) => left.component.localeCompare(right.component));
  if (components.length === 0) {
    throw new Error("at least one operational observation is required");
  }
  if (new Set(components.map(({ component }) => component)).size !== components.length) {
    throw new Error("component observations must be unique");
  }
  const readiness = components.reduce<OperationalReadiness>(
    (current, component) => {
      const next = COMPONENT_TO_READINESS[component.state];
      return READINESS_SEVERITY[next] > READINESS_SEVERITY[current]
        ? next
        : current;
    },
    "ready",
  );
  const reasons = components
    .flatMap((component): OperationalReason[] =>
      component.reason_code === null
        ? []
        : [
            {
              component: component.component,
              state: OperationalReasonSchema.shape.state.parse(component.state),
              reason_code: component.reason_code,
              action_code:
                OperationalReasonSchema.shape.action_code.parse(
                  component.action_code,
                ),
            },
          ],
    )
    .sort(compareOperationalReasons);
  const statusWithoutDigest = {
    schema_version: ContractVersionSchema.parse("1.0.0"),
    observed_at: observedAt,
    readiness,
    qualification,
    components,
    reasons,
    primary_reason: reasons[0]?.reason_code ?? null,
    next_action: reasons[0]?.action_code ?? ("NONE" as const),
    exit_class:
      readiness === "ready"
        ? ("success" as const)
        : readiness === "degraded"
          ? ("inspectable_degraded" as const)
          : ("operator_action_required" as const),
  };
  return OperationalStatusSchema.parse({
    ...statusWithoutDigest,
    status_digest: canonicalSha256(statusWithoutDigest),
  });
}

export const OperatorCommandSchema = z.enum([
  "restore",
  "rebuild_fts",
  "rebuild_layered_projection",
  "purge_retry",
  "key_rotate",
  "learning_rollback",
]);

export const OperationIntentSchema = z
  .object({
    schema_version: ContractVersionSchema,
    operation_id: IdentifierSchema,
    command: OperatorCommandSchema,
    principal_id: IdentifierSchema,
    root_ref: IdentifierSchema,
    source_ref: IdentifierSchema.nullable(),
    target_ref: IdentifierSchema.nullable(),
    expected_state_digest: CanonicalHashSchema,
    expected_frontier_digest: CanonicalHashSchema,
    nonce: IdentifierSchema,
    issued_at: UtcTimestampSchema,
    expires_at: UtcTimestampSchema,
    intent_hash: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.expires_at) <= Date.parse(value.issued_at)) {
      context.addIssue({
        code: "custom",
        path: ["expires_at"],
        message: "operation intent must expire after issuance",
      });
    }
    if (value.intent_hash !== canonicalSha256Omitting(value, ["intent_hash"])) {
      context.addIssue({
        code: "custom",
        path: ["intent_hash"],
        message: "operation intent hash must bind the full intent",
      });
    }
  });

export const OperatorConfirmationSchema = z
  .object({
    schema_version: ContractVersionSchema,
    confirmation_id: IdentifierSchema,
    intent_hash: CanonicalHashSchema,
    command: OperatorCommandSchema,
    principal_id: IdentifierSchema,
    nonce: IdentifierSchema,
    authority_key_id: IdentifierSchema,
    issued_at: UtcTimestampSchema,
    expires_at: UtcTimestampSchema,
    signature: z.string().regex(/^[A-Za-z0-9_-]{43,512}$/),
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.expires_at) <= Date.parse(value.issued_at)) {
      context.addIssue({
        code: "custom",
        path: ["expires_at"],
        message: "confirmation must expire after issuance",
      });
    }
  });

export const OperatorConfirmationConsumptionSchema = z
  .object({
    confirmation_id: IdentifierSchema,
    intent_hash: CanonicalHashSchema,
    consumed_at: UtcTimestampSchema,
    receipt_id: IdentifierSchema,
  })
  .strict();

export class OperatorConfirmationValidationError extends Error {
  constructor() {
    super("operator confirmation is invalid");
    this.name = "OperatorConfirmationValidationError";
  }
}

export function verifyOperatorConfirmationBinding(input: {
  intent: unknown;
  confirmation: unknown;
  now: string;
  expectedAuthorityKeyId: string;
  consumedConfirmationIds?: ReadonlySet<string>;
}): OperatorConfirmation {
  try {
    const intent = OperationIntentSchema.parse(input.intent);
    const confirmation = OperatorConfirmationSchema.parse(input.confirmation);
    const now = Date.parse(UtcTimestampSchema.parse(input.now));
    if (
      confirmation.intent_hash !== intent.intent_hash ||
      confirmation.command !== intent.command ||
      confirmation.principal_id !== intent.principal_id ||
      confirmation.nonce !== intent.nonce ||
      confirmation.authority_key_id !== input.expectedAuthorityKeyId ||
      Date.parse(intent.expires_at) <= now ||
      Date.parse(confirmation.expires_at) <= now ||
      Date.parse(confirmation.issued_at) < Date.parse(intent.issued_at) ||
      input.consumedConfirmationIds?.has(confirmation.confirmation_id) === true
    ) {
      throw new OperatorConfirmationValidationError();
    }
    return confirmation;
  } catch {
    throw new OperatorConfirmationValidationError();
  }
}

export const RootLeaseSchema = z
  .object({
    schema_version: ContractVersionSchema,
    lease_id: IdentifierSchema,
    owner_id: IdentifierSchema,
    root_ref: IdentifierSchema,
    fence_token: z.number().int().positive(),
    state: z.enum(["active", "released", "expired"]),
    acquired_at: UtcTimestampSchema,
    heartbeat_at: UtcTimestampSchema,
    expires_at: UtcTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const acquired = Date.parse(value.acquired_at);
    const heartbeat = Date.parse(value.heartbeat_at);
    const expires = Date.parse(value.expires_at);
    if (heartbeat < acquired || expires <= heartbeat) {
      context.addIssue({
        code: "custom",
        path: ["heartbeat_at"],
        message: "lease times must satisfy acquired <= heartbeat < expiry",
      });
    }
  });

export const RootLeaseRecoverySchema = z
  .object({
    root_ref: IdentifierSchema,
    previous_lease_id: IdentifierSchema,
    previous_fence_token: z.number().int().positive(),
    observed_heartbeat_at: UtcTimestampSchema,
    takeover_nonce: IdentifierSchema,
  })
  .strict();

export type OperationalActionCode = z.infer<
  typeof OperationalActionCodeSchema
>;
export type OperationalComponent = z.infer<typeof OperationalComponentSchema>;
export type OperationalExitClass = z.infer<
  typeof OperationalExitClassSchema
>;
export type OperationalObservation = z.infer<
  typeof OperationalObservationSchema
>;
export type OperationalReadiness = z.infer<
  typeof OperationalReadinessSchema
>;
export type OperationalReason = z.infer<typeof OperationalReasonSchema>;
export type OperationalStatus = z.infer<typeof OperationalStatusSchema>;
export type OperationIntent = z.infer<typeof OperationIntentSchema>;
export type OperatorCommand = z.infer<typeof OperatorCommandSchema>;
export type OperatorConfirmation = z.infer<
  typeof OperatorConfirmationSchema
>;
export type OperatorConfirmationConsumption = z.infer<
  typeof OperatorConfirmationConsumptionSchema
>;
export type ReleaseQualification = z.infer<
  typeof ReleaseQualificationSchema
>;
export type RootLease = z.infer<typeof RootLeaseSchema>;
export type RootLeaseRecovery = z.infer<typeof RootLeaseRecoverySchema>;
