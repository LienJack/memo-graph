import { createHash } from "node:crypto";

import { z } from "zod";

import {
  canonicalJson,
  canonicalSha256Omitting,
} from "./canonical-json.js";
import {
  CanonicalHashSchema,
  ContractVersionSchema,
  IdentifierSchema,
  ScopeSchema,
  UtcTimestampSchema,
} from "./common.js";

export const SECRET_ENVELOPE_DOMAIN = "memo-graph/secret-envelope/v1";
export const AES_256_GCM_KEY_BYTES = 32;
export const AES_256_GCM_NONCE_BYTES = 12;
export const AES_256_GCM_TAG_BYTES = 16;

function canonicalBase64UrlBytes(
  byteLength: number | null,
  maximumByteLength = 256_000,
) {
  return z
    .string()
    .min(byteLength === 0 ? 0 : 1)
    .max(Math.ceil((maximumByteLength * 4) / 3))
    .regex(/^[A-Za-z0-9_-]*$/)
    .superRefine((value, context) => {
      try {
        const decoded = Buffer.from(value, "base64url");
        if (
          decoded.toString("base64url") !== value ||
          (byteLength !== null && decoded.byteLength !== byteLength) ||
          decoded.byteLength > maximumByteLength
        ) {
          context.addIssue({
            code: "custom",
            message: "value must be canonical base64url with the required length",
          });
        }
      } catch {
        context.addIssue({
          code: "custom",
          message: "value must be canonical base64url",
        });
      }
    });
}

export const AesGcmNonceSchema = canonicalBase64UrlBytes(
  AES_256_GCM_NONCE_BYTES,
);
export const AesGcmTagSchema = canonicalBase64UrlBytes(
  AES_256_GCM_TAG_BYTES,
);
export const SecretCiphertextSchema = canonicalBase64UrlBytes(null);
export const KeyedPlaintextCommitmentSchema = z
  .string()
  .regex(/^hmac-sha256:[A-Za-z0-9_-]{43}$/);
export const Ed25519SignatureSchema = canonicalBase64UrlBytes(64, 64);
export const Ed25519PublicKeySchema = canonicalBase64UrlBytes(44, 44);

export const EncryptionKeyStateSchema = z.enum([
  "current",
  "rotating_to",
  "retired",
  "revoked_or_compromised",
  "unavailable",
]);

export const SecretContentOwnerSchema = z
  .object({
    kind: z.enum(["evidence", "memory_revision"]),
    id: IdentifierSchema,
    generation: z.number().int().positive(),
  })
  .strict();

export const SecretEnvelopeMetadataSchema = z
  .object({
    schema_version: ContractVersionSchema,
    envelope_version: z.literal(1),
    algorithm: z.literal("AES-256-GCM"),
    key_id: IdentifierSchema,
    key_generation: z.number().int().positive(),
    nonce_base64url: AesGcmNonceSchema,
    owner: SecretContentOwnerSchema,
    scope: ScopeSchema,
    sensitivity: z.literal("secret"),
    content_identity: IdentifierSchema,
    content_class: z.enum(["evidence", "memory_revision"]),
    media_type: z.string().trim().min(1).max(160),
    keyed_plaintext_commitment: KeyedPlaintextCommitmentSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.owner.kind !== value.content_class) {
      context.addIssue({
        code: "custom",
        path: ["content_class"],
        message: "content class must match the canonical owner kind",
      });
    }
  });

export function buildSecretAad(
  metadataInput: z.input<typeof SecretEnvelopeMetadataSchema>,
): Buffer {
  const metadata = SecretEnvelopeMetadataSchema.parse(metadataInput);
  return Buffer.concat([
    Buffer.from(SECRET_ENVELOPE_DOMAIN, "utf8"),
    Buffer.from(canonicalJson(metadata), "utf8"),
  ]);
}

export function secretAadHash(
  metadata: z.input<typeof SecretEnvelopeMetadataSchema>,
): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(buildSecretAad(metadata))
    .digest("hex")}`;
}

export const SecretEnvelopeSchema = z
  .object({
    metadata: SecretEnvelopeMetadataSchema,
    aad_hash: CanonicalHashSchema,
    tag_base64url: AesGcmTagSchema,
    ciphertext_hash: CanonicalHashSchema,
    ciphertext_size_bytes: z.number().int().positive().max(256_000),
    envelope_hash: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.aad_hash !== secretAadHash(value.metadata)) {
      context.addIssue({
        code: "custom",
        path: ["aad_hash"],
        message: "AAD hash must bind domain-separated canonical metadata",
      });
    }
    if (
      value.envelope_hash !==
      canonicalSha256Omitting(value, ["envelope_hash"])
    ) {
      context.addIssue({
        code: "custom",
        path: ["envelope_hash"],
        message: "envelope hash must bind authenticated metadata and ciphertext identity",
      });
    }
  });

export function sealSecretEnvelope(
  input: Omit<z.input<typeof SecretEnvelopeSchema>, "envelope_hash">,
): SecretEnvelope {
  const value = {
    ...input,
    envelope_hash: canonicalSha256Omitting(
      { ...input, envelope_hash: `sha256:${"0".repeat(64)}` },
      ["envelope_hash"],
    ),
  };
  return SecretEnvelopeSchema.parse(value);
}

export const SecretEncryptedPayloadSchema = z
  .object({
    envelope: SecretEnvelopeSchema,
    ciphertext_base64url: SecretCiphertextSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const ciphertext = Buffer.from(value.ciphertext_base64url, "base64url");
    if (ciphertext.byteLength !== value.envelope.ciphertext_size_bytes) {
      context.addIssue({
        code: "custom",
        path: ["ciphertext_base64url"],
        message: "ciphertext byte length must match the envelope",
      });
    }
    const hash = `sha256:${createHash("sha256")
      .update(ciphertext)
      .digest("hex")}`;
    if (hash !== value.envelope.ciphertext_hash) {
      context.addIssue({
        code: "custom",
        path: ["ciphertext_base64url"],
        message: "ciphertext hash must match the envelope",
      });
    }
  });

export const EncryptionKeyDescriptorSchema = z
  .object({
    key_id: IdentifierSchema,
    generation: z.number().int().positive(),
    state: EncryptionKeyStateSchema,
    authority_key_id: IdentifierSchema,
    commitment_key_id: IdentifierSchema,
    created_at: UtcTimestampSchema,
    state_changed_at: UtcTimestampSchema,
  })
  .strict();

export const EncryptionKeyInventorySchema = z
  .object({
    keys: z.array(EncryptionKeyDescriptorSchema),
    current_key_id: IdentifierSchema.nullable(),
    rotating_to_key_id: IdentifierSchema.nullable(),
    encrypted_content_count: z.number().int().nonnegative(),
    rotation_id: IdentifierSchema.nullable(),
    rotation_state: z
      .enum(["prepared", "in_progress", "completed", "aborted", "blocked"])
      .nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.keys.map(({ key_id }) => key_id);
    const generations = value.keys.map(({ generation }) => generation);
    if (
      new Set(ids).size !== ids.length ||
      new Set(generations).size !== generations.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["keys"],
        message: "key IDs and generations must be unique",
      });
    }
    const ordered = [...value.keys].sort(
      (left, right) => left.generation - right.generation,
    );
    if (
      ordered.some(
        (key, index) => key.key_id !== value.keys[index]?.key_id,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["keys"],
        message: "keys must use ascending generation order",
      });
    }
    const current = value.keys.filter(({ state }) => state === "current");
    const rotating = value.keys.filter(
      ({ state }) => state === "rotating_to",
    );
    if (
      current.length > 1 ||
      rotating.length > 1 ||
      (current[0]?.key_id ?? null) !== value.current_key_id ||
      (rotating[0]?.key_id ?? null) !== value.rotating_to_key_id ||
      (value.rotation_id === null) !== (value.rotation_state === null) ||
      (value.rotation_id === null && rotating.length !== 0) ||
      (value.rotation_state === "in_progress" && rotating.length !== 1)
    ) {
      context.addIssue({
        code: "custom",
        path: ["current_key_id"],
        message: "inventory pointers must name the unique current and rotating keys",
      });
    }
  });

export const KeyRotationProgressSchema = z
  .object({
    rotation_id: IdentifierSchema,
    state: z.enum([
      "prepared",
      "in_progress",
      "completed",
      "aborted",
      "blocked",
    ]),
    old_key_id: IdentifierSchema,
    new_key_id: IdentifierSchema,
    total_items: z.number().int().nonnegative(),
    rewritten_items: z.number().int().nonnegative(),
    request_digest: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.old_key_id === value.new_key_id ||
      value.rewritten_items > value.total_items ||
      (value.state === "completed" &&
        value.rewritten_items !== value.total_items)
    ) {
      context.addIssue({
        code: "custom",
        path: ["rewritten_items"],
        message: "rotation progress must be bounded and complete only at total",
      });
    }
  });

const SecretAuthorityBaseShape = {
  schema_version: ContractVersionSchema,
  principal_id: IdentifierSchema,
  owner: SecretContentOwnerSchema,
  scope: ScopeSchema,
  request_digest: CanonicalHashSchema,
  key_id: IdentifierSchema,
  key_generation: z.number().int().positive(),
  authority_key_id: IdentifierSchema,
  signature_algorithm: z.literal("Ed25519"),
  issued_at: UtcTimestampSchema,
  expires_at: UtcTimestampSchema,
  signature: Ed25519SignatureSchema,
};

export const SecretUseAuthoritySchema = z
  .object({
    ...SecretAuthorityBaseShape,
    authority_id: IdentifierSchema,
    purpose: z.enum([
      "integrity_verification",
      "rotation",
      "backup_restore_verification",
      "purge",
    ]),
    ciphertext_id: IdentifierSchema,
    authority_hash: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.expires_at) <= Date.parse(value.issued_at)) {
      context.addIssue({
        code: "custom",
        path: ["expires_at"],
        message: "secret-use authority must expire after issuance",
      });
    }
    if (
      value.authority_hash !==
      canonicalSha256Omitting(value, ["authority_hash", "signature"])
    ) {
      context.addIssue({
        code: "custom",
        path: ["authority_hash"],
        message: "authority hash must bind exact purpose and ciphertext identity",
      });
    }
  });

export const SecretAdmissionApprovalSchema = z
  .object({
    ...SecretAuthorityBaseShape,
    approval_id: IdentifierSchema,
    envelope_aad_hash: CanonicalHashSchema,
    root_fence_token: z.number().int().positive(),
    approval_hash: CanonicalHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.expires_at) <= Date.parse(value.issued_at)) {
      context.addIssue({
        code: "custom",
        path: ["expires_at"],
        message: "secret-admission approval must expire after issuance",
      });
    }
    if (
      value.approval_hash !==
      canonicalSha256Omitting(value, ["approval_hash", "signature"])
    ) {
      context.addIssue({
        code: "custom",
        path: ["approval_hash"],
        message: "approval hash must bind exact admission state",
      });
    }
  });

export type EncryptionKeyDescriptor = z.infer<
  typeof EncryptionKeyDescriptorSchema
>;
export type EncryptionKeyInventory = z.infer<
  typeof EncryptionKeyInventorySchema
>;
export type EncryptionKeyState = z.infer<typeof EncryptionKeyStateSchema>;
export type KeyRotationProgress = z.infer<
  typeof KeyRotationProgressSchema
>;
export type SecretAdmissionApproval = z.infer<
  typeof SecretAdmissionApprovalSchema
>;
export type SecretContentOwner = z.infer<typeof SecretContentOwnerSchema>;
export type SecretEncryptedPayload = z.infer<
  typeof SecretEncryptedPayloadSchema
>;
export type SecretEnvelope = z.infer<typeof SecretEnvelopeSchema>;
export type SecretEnvelopeMetadata = z.infer<
  typeof SecretEnvelopeMetadataSchema
>;
export type SecretUseAuthority = z.infer<typeof SecretUseAuthoritySchema>;
