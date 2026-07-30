import { z } from "zod";
import { createPublicKey, verify, type KeyObject } from "node:crypto";

import {
  canonicalJson,
  canonicalSha256,
  canonicalSha256Omitting,
} from "./canonical-json.js";
import {
  CanonicalHashSchema,
  ContractVersionSchema,
  IdentifierSchema,
  UtcTimestampSchema,
} from "./common.js";

const BundlePathSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.split("/").some((segment) => segment === "." || segment === ".."),
    "bundle paths must be relative aliases without traversal",
  );

export const BackupKeyIdentitySchema = z
  .object({
    key_id: IdentifierSchema,
    key_generation: z.number().int().positive(),
    state: z.enum([
      "current",
      "rotating_to",
      "retired",
      "revoked_or_compromised",
      "unavailable",
    ]),
  })
  .strict();

export const BackupArtifactDescriptorSchema = z
  .object({
    kind: z.enum(["blob", "ciphertext"]),
    artifact_id: IdentifierSchema,
    storage_kind: z.enum(["inline", "external"]),
    bundle_path: BundlePathSchema.nullable(),
    raw_hash: CanonicalHashSchema,
    size_bytes: z.number().int().positive(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.kind === "blob" &&
      (value.storage_kind !== "external" || value.bundle_path === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["bundle_path"],
        message: "blob artifacts are external and require a bundle path",
      });
    }
    if (
      (value.storage_kind === "inline") !== (value.bundle_path === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["bundle_path"],
        message:
          "only database-bound inline ciphertext may omit a bundle path",
      });
    }
    if (
      value.bundle_path !== null &&
      !value.bundle_path.startsWith(
        value.kind === "blob"
          ? "artifacts/blobs/"
          : "artifacts/ciphertext/",
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["bundle_path"],
        message: "artifact bundle path must match its declared class",
      });
    }
  });

export const BackupMigrationSchema = z
  .object({
    version: z.string().regex(/^\d{4}$/),
    name: z.string().trim().min(1).max(200),
    hash: CanonicalHashSchema,
    applied_at: UtcTimestampSchema,
  })
  .strict();

export const BackupFrontiersSchema = z
  .object({
    ledger_epoch: z.number().int().nonnegative(),
    latest_receipt_hash: CanonicalHashSchema.nullable(),
    tombstone_epoch: z.number().int().nonnegative(),
    purge_frontier_hash: CanonicalHashSchema,
    purge_debt_count: z.number().int().nonnegative(),
    fts_frontier_hash: CanonicalHashSchema,
    fts_logical_frontier_hash: CanonicalHashSchema,
    layered_frontier_hash: CanonicalHashSchema,
    relation_frontier_hash: CanonicalHashSchema,
    context_frontier_hash: CanonicalHashSchema,
    learning_control_epoch: z.number().int().nonnegative(),
    learning_release_revision: z.number().int().nonnegative(),
    learning_frontier_hash: CanonicalHashSchema,
    learning_pointer_hash: CanonicalHashSchema,
    learning_monitor_hash: CanonicalHashSchema.nullable(),
    learning_rollback_hash: CanonicalHashSchema.nullable(),
    encryption_frontier_hash: CanonicalHashSchema,
    g6_release_control_hash: CanonicalHashSchema.nullable(),
  })
  .strict();

const AcceptedDecisionSchema = z
  .object({
    status: z.enum(["GO", "NO-GO"]),
    decision_hash: CanonicalHashSchema,
  })
  .strict();

export const CompleteBackupManifestSchema = z
  .object({
    schema_version: z.literal("1.0.0"),
    backup_id: IdentifierSchema,
    created_at: UtcTimestampSchema,
    root_identity: z
      .object({
        root_id: IdentifierSchema,
        principal_id: IdentifierSchema,
      })
      .strict(),
    database: z
      .object({
        bundle_path: BundlePathSchema,
        raw_hash: CanonicalHashSchema,
        size_bytes: z.number().int().positive(),
        logical_hash: CanonicalHashSchema,
      })
      .strict(),
    artifacts: z.array(BackupArtifactDescriptorSchema),
    schema: z
      .object({
        current_version: z.string().regex(/^\d{4}$/),
        migration_set_hash: CanonicalHashSchema,
        migrations: z.array(BackupMigrationSchema).min(1),
      })
      .strict(),
    frontiers: BackupFrontiersSchema,
    encryption: z
      .object({
        format_version: z.literal(1),
        required_keys: z.array(BackupKeyIdentitySchema),
        key_live_ciphertexts: z.array(
          z
            .object({
              key_id: IdentifierSchema,
              live_ciphertext_count: z.number().int().nonnegative(),
            })
            .strict(),
        ),
      })
      .strict(),
    decisions: z
      .object({
        g3r: AcceptedDecisionSchema,
        g4a: AcceptedDecisionSchema,
        g4b: AcceptedDecisionSchema,
        g5: AcceptedDecisionSchema,
        graph_enabled: z.literal(false),
        vector_enabled: z.literal(false),
        automatic_learning_publication: z.literal(false),
      })
      .strict(),
    creation_identity: z
      .object({
        config_hash: CanonicalHashSchema,
        environment_hash: CanonicalHashSchema,
        filesystem_type: z.number().int(),
        platform: z.string().trim().min(1).max(80),
        architecture: z.string().trim().min(1).max(80),
        node_version: z.string().regex(/^24\./),
      })
      .strict(),
    manifest_hash: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const artifactIds = value.artifacts.map(({ artifact_id }) => artifact_id);
    const artifactPaths = value.artifacts.flatMap(({ bundle_path }) =>
      bundle_path === null ? [] : [bundle_path],
    );
    if (
      new Set(artifactIds).size !== artifactIds.length ||
      new Set(artifactPaths).size !== artifactPaths.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["artifacts"],
        message: "artifact identities and external bundle paths must be unique",
      });
    }
    const migrationVersions = value.schema.migrations.map(
      ({ version }) => version,
    );
    if (new Set(migrationVersions).size !== migrationVersions.length) {
      context.addIssue({
        code: "custom",
        path: ["schema", "migrations"],
        message: "migration versions must be unique",
      });
    }
    if (
      value.schema.migrations.at(-1)?.version !== value.schema.current_version
    ) {
      context.addIssue({
        code: "custom",
        path: ["schema", "current_version"],
        message: "current schema must equal the last migration",
      });
    }
    if (value.manifest_hash !== canonicalSha256Omitting(value, ["manifest_hash"])) {
      context.addIssue({
        code: "custom",
        path: ["manifest_hash"],
        message: "manifest hash must bind the complete logical manifest",
      });
    }
    if (
      value.creation_identity.environment_hash !==
      canonicalSha256({
        platform: value.creation_identity.platform,
        architecture: value.creation_identity.architecture,
        node_version: value.creation_identity.node_version,
        filesystem_type: value.creation_identity.filesystem_type,
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["creation_identity", "environment_hash"],
        message: "environment hash must bind the declared creation identity",
      });
    }
  });

export const RecoveryMinimumsSchema = z
  .object({
    ledger_epoch: z.number().int().nonnegative(),
    latest_receipt_hash: CanonicalHashSchema.nullable(),
    tombstone_epoch: z.number().int().nonnegative(),
    purge_frontier_hash: CanonicalHashSchema,
    projection_frontier_hash: CanonicalHashSchema,
    context_frontier_hash: CanonicalHashSchema,
    learning_control_epoch: z.number().int().nonnegative(),
    learning_release_revision: z.number().int().nonnegative(),
    learning_frontier_hash: CanonicalHashSchema,
    required_keys: z.array(BackupKeyIdentitySchema),
    encryption_frontier_hash: CanonicalHashSchema,
    key_live_ciphertexts: z.array(
      z
        .object({
          key_id: IdentifierSchema,
          live_ciphertext_count: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    g6_release_control_hash: CanonicalHashSchema.nullable(),
  })
  .strict();

export const RecoveryAnchorPayloadSchema = z
  .object({
    schema_version: z.literal("1.0.0"),
    anchor_id: IdentifierSchema,
    generation: z.number().int().positive(),
    previous_head_hash: CanonicalHashSchema.nullable(),
    root_id: IdentifierSchema,
    principal_id: IdentifierSchema,
    trust_root_version: z.number().int().positive(),
    state_commitment_hash: CanonicalHashSchema,
    backup_manifest_hash: CanonicalHashSchema.nullable(),
    minimums: RecoveryMinimumsSchema,
    issued_at: UtcTimestampSchema,
    payload_hash: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.payload_hash !== canonicalSha256Omitting(value, ["payload_hash"])
    ) {
      context.addIssue({
        code: "custom",
        path: ["payload_hash"],
        message: "recovery anchor payload hash mismatch",
      });
    }
  });

export const RecoveryAnchorSchema = z
  .object({
    payload: RecoveryAnchorPayloadSchema,
    authority_key_id: IdentifierSchema,
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
    anchor_hash: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.anchor_hash !==
      canonicalSha256({
        payload: value.payload,
        authority_key_id: value.authority_key_id,
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["anchor_hash"],
        message: "recovery anchor hash mismatch",
      });
    }
  });

export const RecoveryPendingReservationSchema = z
  .object({
    pending_id: IdentifierSchema,
    operation: z.enum([
      "canonical",
      "control",
      "purge",
      "projection",
      "context",
      "learning",
      "key",
      "release_control",
    ]),
    idempotency_key: IdentifierSchema,
    request_hash: CanonicalHashSchema,
    prior_minimums: RecoveryMinimumsSchema,
    prior_state_commitment_hash: CanonicalHashSchema,
    prior_head_hash: CanonicalHashSchema.nullable(),
    state: z.enum(["pending", "committed", "reconciled", "aborted"]),
    reserved_at: UtcTimestampSchema,
  })
  .strict();

export const RecoveryPendingAuthorizationSchema = z
  .object({
    reservation: RecoveryPendingReservationSchema,
    authority_key_id: IdentifierSchema,
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .strict();

export type RecoveryAnchor = z.infer<typeof RecoveryAnchorSchema>;
export type RecoveryMinimums = z.infer<typeof RecoveryMinimumsSchema>;
export type RecoveryPendingReservation = z.infer<
  typeof RecoveryPendingReservationSchema
>;
export type RecoveryPendingAuthorization = z.infer<
  typeof RecoveryPendingAuthorizationSchema
>;
export type CompleteBackupManifest = z.infer<
  typeof CompleteBackupManifestSchema
>;

export function verifyRecoveryAnchor(input: {
  anchor: unknown;
  expectedAuthorityKeyId: string;
  publicKey: KeyObject;
}): RecoveryAnchor {
  const anchor = RecoveryAnchorSchema.parse(input.anchor);
  if (
    anchor.authority_key_id !== input.expectedAuthorityKeyId ||
    !verify(
      null,
      Buffer.from(canonicalJson(anchor.payload), "utf8"),
      input.publicKey,
      Buffer.from(anchor.signature, "base64url"),
    )
  ) {
    throw new Error("recovery anchor is invalid");
  }
  return anchor;
}

export function verifyRecoveryPendingAuthorization(input: {
  authorization: unknown;
  expectedAuthorityKeyId: string;
  publicKey: KeyObject;
}): RecoveryPendingAuthorization {
  const authorization = RecoveryPendingAuthorizationSchema.parse(
    input.authorization,
  );
  if (
    authorization.authority_key_id !== input.expectedAuthorityKeyId ||
    !verify(
      null,
      Buffer.from(canonicalJson(authorization.reservation), "utf8"),
      input.publicKey,
      Buffer.from(authorization.signature, "base64url"),
    )
  ) {
    throw new Error("recovery pending authorization is invalid");
  }
  return authorization;
}

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

export const OperatorConfirmationAlgorithmSchema = z.literal("Ed25519");
export const OperatorConfirmationPurposeSchema = z.literal(
  "memo-graph/operator-confirmation/v1",
);

export const OperationIntentSchema = z
  .object({
    schema_version: ContractVersionSchema,
    operation_id: IdentifierSchema,
    command: OperatorCommandSchema,
    principal_id: IdentifierSchema,
    root_ref: IdentifierSchema,
    source_ref: IdentifierSchema.nullable(),
    target_ref: IdentifierSchema.nullable(),
    recovery_anchor_hash: CanonicalHashSchema.nullable(),
    configuration_digest: CanonicalHashSchema,
    key_state_digest: CanonicalHashSchema,
    expected_state_digest: CanonicalHashSchema,
    expected_frontier_digest: CanonicalHashSchema,
    parameters_digest: CanonicalHashSchema,
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
    algorithm: OperatorConfirmationAlgorithmSchema,
    purpose: OperatorConfirmationPurposeSchema,
    authority_key_id: IdentifierSchema,
    authority_key_generation: z.number().int().positive(),
    issued_at: UtcTimestampSchema,
    expires_at: UtcTimestampSchema,
    signed_payload_hash: CanonicalHashSchema,
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
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
    if (
      value.signed_payload_hash !==
      canonicalSha256(operatorConfirmationSigningFields(value))
    ) {
      context.addIssue({
        code: "custom",
        path: ["signed_payload_hash"],
        message: "confirmation signing payload hash mismatch",
      });
    }
  });

export const OperatorConfirmationTrustSchema = z
  .object({
    algorithm: OperatorConfirmationAlgorithmSchema,
    purpose: OperatorConfirmationPurposeSchema,
    authority_key_id: IdentifierSchema,
    authority_key_generation: z.number().int().positive(),
    public_key_spki: z.string().regex(/^[A-Za-z0-9_-]{50,256}$/),
    max_ttl_seconds: z.number().int().positive().max(3_600),
    revoked_key_ids: z.array(IdentifierSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.revoked_key_ids).size !== value.revoked_key_ids.length) {
      context.addIssue({
        code: "custom",
        path: ["revoked_key_ids"],
        message: "revoked confirmation key identities must be unique",
      });
    }
    try {
      const key = createPublicKey({
        key: Buffer.from(value.public_key_spki, "base64url"),
        type: "spki",
        format: "der",
      });
      if (key.asymmetricKeyType !== "ed25519") {
        throw new Error("wrong key type");
      }
    } catch {
      context.addIssue({
        code: "custom",
        path: ["public_key_spki"],
        message: "confirmation verifier must be an Ed25519 SPKI key",
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

function operatorConfirmationSigningFields(
  confirmation: Omit<
    z.input<typeof OperatorConfirmationSchema>,
    "signature" | "signed_payload_hash"
  >,
) {
  return {
    schema_version: confirmation.schema_version,
    confirmation_id: confirmation.confirmation_id,
    intent_hash: confirmation.intent_hash,
    command: confirmation.command,
    principal_id: confirmation.principal_id,
    nonce: confirmation.nonce,
    algorithm: confirmation.algorithm,
    purpose: confirmation.purpose,
    authority_key_id: confirmation.authority_key_id,
    authority_key_generation: confirmation.authority_key_generation,
    issued_at: confirmation.issued_at,
    expires_at: confirmation.expires_at,
  };
}

export function operatorConfirmationSigningPayload(
  confirmation: Omit<
    z.input<typeof OperatorConfirmationSchema>,
    "signature"
  >,
): string {
  return canonicalJson(operatorConfirmationSigningFields(confirmation));
}

export function verifyOperatorConfirmationBinding(input: {
  intent: unknown;
  confirmation: unknown;
  now: string;
  trust: unknown;
  consumedConfirmationIds?: ReadonlySet<string>;
  verifySignature: (input: {
    payload: string;
    signature: string;
    publicKeySpki: string;
  }) => boolean;
}): OperatorConfirmation {
  try {
    const intent = OperationIntentSchema.parse(input.intent);
    const confirmation = OperatorConfirmationSchema.parse(input.confirmation);
    const trust = OperatorConfirmationTrustSchema.parse(input.trust);
    const now = Date.parse(UtcTimestampSchema.parse(input.now));
    const ttlMilliseconds =
      Date.parse(confirmation.expires_at) -
      Date.parse(confirmation.issued_at);
    if (
      confirmation.intent_hash !== intent.intent_hash ||
      confirmation.command !== intent.command ||
      confirmation.principal_id !== intent.principal_id ||
      confirmation.nonce !== intent.nonce ||
      confirmation.algorithm !== trust.algorithm ||
      confirmation.purpose !== trust.purpose ||
      confirmation.authority_key_id !== trust.authority_key_id ||
      confirmation.authority_key_generation !==
        trust.authority_key_generation ||
      trust.revoked_key_ids.includes(confirmation.authority_key_id) ||
      ttlMilliseconds > trust.max_ttl_seconds * 1_000 ||
      Date.parse(intent.expires_at) <= now ||
      Date.parse(confirmation.expires_at) <= now ||
      Date.parse(confirmation.issued_at) > now ||
      Date.parse(confirmation.issued_at) < Date.parse(intent.issued_at) ||
      Date.parse(confirmation.expires_at) > Date.parse(intent.expires_at) ||
      input.consumedConfirmationIds?.has(confirmation.confirmation_id) ===
        true ||
      !input.verifySignature({
        payload: operatorConfirmationSigningPayload(confirmation),
        signature: confirmation.signature,
        publicKeySpki: trust.public_key_spki,
      })
    ) {
      throw new OperatorConfirmationValidationError();
    }
    return confirmation;
  } catch {
    throw new OperatorConfirmationValidationError();
  }
}

export const OperatorActionStateSchema = z.enum([
  "authorized",
  "effect_prepared",
  "effect_committed",
  "receipt_committed",
  "responded",
]);

export const OperatorActionReceiptSchema = z
  .object({
    schema_version: ContractVersionSchema,
    receipt_id: IdentifierSchema,
    operation_id: IdentifierSchema,
    command: OperatorCommandSchema,
    intent_hash: CanonicalHashSchema,
    confirmation_id: IdentifierSchema,
    confirmation_key_id: IdentifierSchema,
    confirmation_key_generation: z.number().int().positive(),
    state: z.literal("receipt_committed"),
    effect_digest: CanonicalHashSchema,
    result_digest: CanonicalHashSchema,
    created_at: UtcTimestampSchema,
    completed_at: UtcTimestampSchema,
    receipt_hash: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.completed_at) < Date.parse(value.created_at)) {
      context.addIssue({
        code: "custom",
        path: ["completed_at"],
        message: "operator action completion cannot precede creation",
      });
    }
    if (
      value.receipt_hash !==
      canonicalSha256Omitting(value, ["receipt_hash"])
    ) {
      context.addIssue({
        code: "custom",
        path: ["receipt_hash"],
        message: "operator action receipt hash mismatch",
      });
    }
  });

export const ArtifactStoreIdSchema = z.enum([
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

export const OperationalArtifactClassSchema = z.enum([
  "canonical",
  "context",
  "projection",
  "learning",
  "backup",
  "log",
  "temp",
  "quarantine",
  "ciphertext",
]);

export const OperationalArtifactClassAuditSchema = z
  .object({
    artifact_class: OperationalArtifactClassSchema,
    outcome: z.enum([
      "verified_present",
      "quarantined_non_publishable",
      "blocked",
    ]),
    file_count: z.number().int().nonnegative(),
    byte_count: z.number().int().nonnegative(),
    inventory_hash: CanonicalHashSchema.nullable(),
    error_code: IdentifierSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const blocked = value.outcome === "blocked";
    if (
      blocked !== (value.error_code !== null) ||
      blocked === (value.inventory_hash !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "artifact class audit outcome is inconsistent",
      });
    }
    if (
      value.artifact_class === "quarantine" &&
      !blocked &&
      value.outcome !== "quarantined_non_publishable"
    ) {
      context.addIssue({
        code: "custom",
        path: ["artifact_class"],
        message: "quarantine cannot become a publishable artifact class",
      });
    }
  });

export const OperationalArtifactResidualAuditSchema = z
  .object({
    schema_version: z.literal("1.0.0"),
    audit_id: IdentifierSchema,
    checked_at: UtcTimestampSchema,
    classes: z.array(OperationalArtifactClassAuditSchema),
    completed: z.boolean(),
    audit_hash: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.classes.length !== OperationalArtifactClassSchema.options.length ||
      value.classes.some(
        (entry, index) =>
          entry.artifact_class !==
          OperationalArtifactClassSchema.options[index],
      ) ||
      value.completed !==
        value.classes.every(({ outcome }) => outcome !== "blocked") ||
      value.audit_hash !==
        canonicalSha256Omitting(value, ["audit_hash"])
    ) {
      context.addIssue({
        code: "custom",
        path: ["classes"],
        message: "artifact residual audit is incomplete or invalid",
      });
    }
  });

export const ArtifactPurgeOutcomeSchema = z.enum([
  "verified_removed",
  "verified_ineligible",
  "verified_retained_identity_only",
  "retryable",
  "blocked",
]);

export const ArtifactPurgeStoreAuditSchema = z
  .object({
    store_id: ArtifactStoreIdSchema,
    store_version: z.number().int().positive(),
    required_for_purge: z.boolean(),
    outcome: ArtifactPurgeOutcomeSchema,
    debt_count: z.number().int().nonnegative(),
    frontier_hash: CanonicalHashSchema,
    checked_at: UtcTimestampSchema,
    error_code: z.string().trim().min(1).max(200).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const unsuccessful =
      value.outcome === "retryable" || value.outcome === "blocked";
    if (unsuccessful !== (value.error_code !== null)) {
      context.addIssue({
        code: "custom",
        path: ["error_code"],
        message: "only retryable or blocked audit outcomes require an error",
      });
    }
    if (
      value.outcome !== "verified_retained_identity_only" &&
      value.debt_count !== 0 &&
      !unsuccessful
    ) {
      context.addIssue({
        code: "custom",
        path: ["debt_count"],
        message: "verified removal or ineligibility cannot retain purge debt",
      });
    }
  });

export const ArtifactPurgeAuditSchema = z
  .object({
    schema_version: ContractVersionSchema,
    audit_id: IdentifierSchema,
    tombstone_epoch: z.number().int().nonnegative(),
    stores: z.array(ArtifactPurgeStoreAuditSchema),
    completed: z.boolean(),
    audit_hash: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const expectedStores = [...ArtifactStoreIdSchema.options].sort();
    const actualStores = value.stores.map(({ store_id }) => store_id).sort();
    if (
      actualStores.length !== expectedStores.length ||
      actualStores.some((store, index) => store !== expectedStores[index])
    ) {
      context.addIssue({
        code: "custom",
        path: ["stores"],
        message: "purge audit must cover every versioned artifact store",
      });
    }
    const canComplete = value.stores.every(
      (store) =>
        store.outcome !== "retryable" &&
        store.outcome !== "blocked" &&
        (!store.required_for_purge || store.debt_count === 0),
    );
    if (value.completed !== canComplete) {
      context.addIssue({
        code: "custom",
        path: ["completed"],
        message: "purge audit completion must match all required outcomes",
      });
    }
    if (value.audit_hash !== canonicalSha256Omitting(value, ["audit_hash"])) {
      context.addIssue({
        code: "custom",
        path: ["audit_hash"],
        message: "purge audit hash mismatch",
      });
    }
  });

export const OperationalPurgeVerificationSchema = z
  .object({
    schema_version: ContractVersionSchema,
    purge_audit: ArtifactPurgeAuditSchema,
    residual_audit: OperationalArtifactResidualAuditSchema,
    completed: z.boolean(),
    verification_hash: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.completed !==
      (value.purge_audit.completed &&
        value.residual_audit.completed)
    ) {
      context.addIssue({
        code: "custom",
        path: ["completed"],
        message:
          "purge verification requires both frontier and residual completion",
      });
    }
    if (
      value.verification_hash !==
      canonicalSha256Omitting(value, ["verification_hash"])
    ) {
      context.addIssue({
        code: "custom",
        path: ["verification_hash"],
        message: "purge verification hash mismatch",
      });
    }
  });

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
export type OperatorActionReceipt = z.infer<
  typeof OperatorActionReceiptSchema
>;
export type OperatorActionState = z.infer<typeof OperatorActionStateSchema>;
export type OperatorConfirmation = z.infer<
  typeof OperatorConfirmationSchema
>;
export type OperatorConfirmationTrust = z.infer<
  typeof OperatorConfirmationTrustSchema
>;
export type OperatorConfirmationConsumption = z.infer<
  typeof OperatorConfirmationConsumptionSchema
>;
export type ArtifactPurgeAudit = z.infer<typeof ArtifactPurgeAuditSchema>;
export type ArtifactPurgeOutcome = z.infer<
  typeof ArtifactPurgeOutcomeSchema
>;
export type ArtifactPurgeStoreAudit = z.infer<
  typeof ArtifactPurgeStoreAuditSchema
>;
export type ArtifactStoreId = z.infer<typeof ArtifactStoreIdSchema>;
export type OperationalArtifactClass = z.infer<
  typeof OperationalArtifactClassSchema
>;
export type OperationalArtifactResidualAudit = z.infer<
  typeof OperationalArtifactResidualAuditSchema
>;
export type OperationalPurgeVerification = z.infer<
  typeof OperationalPurgeVerificationSchema
>;
export type ReleaseQualification = z.infer<
  typeof ReleaseQualificationSchema
>;
export type RootLease = z.infer<typeof RootLeaseSchema>;
export type RootLeaseRecovery = z.infer<typeof RootLeaseRecoverySchema>;
