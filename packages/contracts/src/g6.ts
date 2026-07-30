import { z } from "zod";

import { canonicalSha256Omitting } from "./canonical-json.js";
import {
  CanonicalHashSchema,
  ContractVersionSchema,
  IdentifierSchema,
  UtcTimestampSchema,
} from "./common.js";
import { Ed25519SignatureSchema } from "./encryption.js";

export const RuntimePlatformIdentitySchema = z
  .object({
    node: z.string().trim().min(1).max(80),
    os: z.string().trim().min(1).max(80),
    architecture: z.string().trim().min(1).max(80),
    sqlite: z.string().trim().min(1).max(80),
    filesystem: z.string().trim().min(1).max(80),
  })
  .strict();

export const RuntimeIdentitySchema = z
  .object({
    schema_version: ContractVersionSchema,
    tested_implementation_digest: CanonicalHashSchema,
    tested_envelope_digest: CanonicalHashSchema,
    dependency_lock_digest: CanonicalHashSchema,
    migration_set_digest: CanonicalHashSchema,
    platform: RuntimePlatformIdentitySchema,
    configuration_digest: CanonicalHashSchema,
    runtime_identity_hash: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.runtime_identity_hash !==
      canonicalSha256Omitting(value, ["runtime_identity_hash"])
    ) {
      context.addIssue({
        code: "custom",
        path: ["runtime_identity_hash"],
        message: "runtime identity hash must bind the complete tested envelope",
      });
    }
  });

export const G6ReleaseControlSchema = z
  .object({
    schema_version: ContractVersionSchema,
    control_id: IdentifierSchema,
    purpose: z.literal("g6_release_control"),
    decision: z.enum(["GO", "NO-GO"]),
    runtime_identity_hash: CanonicalHashSchema,
    tested_envelope_digest: CanonicalHashSchema,
    secret_admission_allowed: z.boolean(),
    authority_key_id: IdentifierSchema,
    authority_key_generation: z.number().int().positive(),
    signature_algorithm: z.literal("Ed25519"),
    issued_at: UtcTimestampSchema,
    expires_at: UtcTimestampSchema,
    control_hash: CanonicalHashSchema,
    signature: Ed25519SignatureSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.expires_at) <= Date.parse(value.issued_at)) {
      context.addIssue({
        code: "custom",
        path: ["expires_at"],
        message: "release control must expire after issuance",
      });
    }
    if (value.secret_admission_allowed !== (value.decision === "GO")) {
      context.addIssue({
        code: "custom",
        path: ["secret_admission_allowed"],
        message: "only a G6 GO control may permit secret admission",
      });
    }
    if (
      value.control_hash !==
      canonicalSha256Omitting(value, ["control_hash", "signature"])
    ) {
      context.addIssue({
        code: "custom",
        path: ["control_hash"],
        message: "release-control hash must bind the exact tested envelope",
      });
    }
  });

export const G6ReleaseControlTrustSchema = z
  .object({
    schema_version: ContractVersionSchema,
    purpose: z.literal("g6_release_control"),
    authority_key_id: IdentifierSchema,
    authority_key_generation: z.number().int().positive(),
    public_key_spki_base64url: z
      .string()
      .regex(/^[A-Za-z0-9_-]{59}$/),
    valid_from: UtcTimestampSchema,
    expires_at: UtcTimestampSchema,
    revoked_at: UtcTimestampSchema.nullable(),
    maximum_control_ttl_seconds: z.number().int().positive().max(86_400),
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.expires_at) <= Date.parse(value.valid_from)) {
      context.addIssue({
        code: "custom",
        path: ["expires_at"],
        message: "G6 trust must expire after becoming valid",
      });
    }
    if (
      value.revoked_at !== null &&
      (Date.parse(value.revoked_at) < Date.parse(value.valid_from) ||
        Date.parse(value.revoked_at) > Date.parse(value.expires_at))
    ) {
      context.addIssue({
        code: "custom",
        path: ["revoked_at"],
        message: "G6 revocation must fall within the trust lifetime",
      });
    }
  });

/**
 * U6's offline signer signs these exact UTF-8 bytes with Ed25519.
 * Keeping the domain and hash projection here gives the signer and runtime
 * verifier one immutable semantic contract without exposing a signing key.
 */
export function g6ReleaseControlSigningPayload(
  control: Pick<G6ReleaseControl, "control_hash">,
): string {
  return `memo-graph/g6-release-control/v1:${control.control_hash}`;
}

export interface RuntimeIdentityProvider {
  current(): Promise<RuntimeIdentity>;
}

export type G6ReleaseControl = z.infer<typeof G6ReleaseControlSchema>;
export type G6ReleaseControlTrust = z.infer<
  typeof G6ReleaseControlTrustSchema
>;
export type RuntimeIdentity = z.infer<typeof RuntimeIdentitySchema>;
export type RuntimePlatformIdentity = z.infer<
  typeof RuntimePlatformIdentitySchema
>;
