import { verify } from "node:crypto";

import {
  G6ReleaseControlSchema,
  G6ReleaseControlTrustSchema,
  RuntimeIdentitySchema,
  g6ReleaseControlSigningPayload,
  type G6ReleaseControl,
  type G6ReleaseControlTrust,
  type RuntimeIdentity,
} from "@memo-graph/contracts";

import { StorageError } from "./errors.js";

export function verifyExactG6ReleaseControl(input: {
  control: unknown;
  trust: G6ReleaseControlTrust;
  runtimeIdentity: RuntimeIdentity;
  now: string;
}): G6ReleaseControl {
  const parsedControl = G6ReleaseControlSchema.safeParse(input.control);
  const parsedTrust = G6ReleaseControlTrustSchema.safeParse(input.trust);
  const parsedRuntimeIdentity = RuntimeIdentitySchema.safeParse(
    input.runtimeIdentity,
  );
  if (
    !parsedControl.success ||
    !parsedTrust.success ||
    !parsedRuntimeIdentity.success
  ) {
    throw new StorageError("ENCRYPTION_REQUIRED");
  }
  const control = parsedControl.data;
  const trust = parsedTrust.data;
  const runtimeIdentity = parsedRuntimeIdentity.data;
  const now = Date.parse(input.now);
  const issuedAt = Date.parse(control.issued_at);
  const expiresAt = Date.parse(control.expires_at);
  const revokedAt =
    trust.revoked_at === null ? null : Date.parse(trust.revoked_at);
  const validSignature = (() => {
    try {
      return verify(
        null,
        Buffer.from(g6ReleaseControlSigningPayload(control), "utf8"),
        {
          key: Buffer.from(
            trust.public_key_spki_base64url,
            "base64url",
          ),
          format: "der",
          type: "spki",
        },
        Buffer.from(control.signature, "base64url"),
      );
    } catch {
      return false;
    }
  })();
  if (
    !Number.isFinite(now) ||
    control.purpose !== trust.purpose ||
    control.authority_key_id !== trust.authority_key_id ||
    control.authority_key_generation !== trust.authority_key_generation ||
    issuedAt < Date.parse(trust.valid_from) ||
    expiresAt > Date.parse(trust.expires_at) ||
    issuedAt > now ||
    expiresAt <= now ||
    (expiresAt - issuedAt) / 1_000 >
      trust.maximum_control_ttl_seconds ||
    (revokedAt !== null && revokedAt <= now) ||
    control.decision !== "GO" ||
    !control.secret_admission_allowed ||
    control.runtime_identity_hash !== runtimeIdentity.runtime_identity_hash ||
    control.tested_envelope_digest !==
      runtimeIdentity.tested_envelope_digest ||
    !validSignature
  ) {
    throw new StorageError("ENCRYPTION_REQUIRED");
  }
  return control;
}
