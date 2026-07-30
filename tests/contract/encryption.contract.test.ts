import { createCipheriv, createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  EncryptionKeyInventorySchema,
  EncryptionKeyStateSchema,
  SecretAdmissionApprovalSchema,
  SecretEncryptedPayloadSchema,
  SecretEnvelopeMetadataSchema,
  SecretUseAuthoritySchema,
  buildSecretAad,
  canonicalSha256Omitting,
  sealSecretEnvelope,
  secretAadHash,
} from "../../packages/contracts/src/index.js";

const NOW = "2026-07-30T00:00:00.000Z";
const LATER = "2026-07-30T00:05:00.000Z";
const HASH_A = `sha256:${"a".repeat(64)}` as const;
const HASH_B = `sha256:${"b".repeat(64)}` as const;

function metadata() {
  return SecretEnvelopeMetadataSchema.parse({
    schema_version: "1.0.0",
    envelope_version: 1,
    algorithm: "AES-256-GCM",
    key_id: "key:test:1",
    key_generation: 1,
    nonce_base64url: "AAECAwQFBgcICQoL",
    owner: {
      kind: "evidence",
      id: "evidence:secret:1",
      generation: 1,
    },
    scope: { kind: "workspace", id: "workspace:test" },
    sensitivity: "secret",
    content_identity: "content:secret:1",
    content_class: "evidence",
    media_type: "text/plain",
    keyed_plaintext_commitment:
      "hmac-sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
}

describe("secret encryption contract", () => {
  it("freezes domain-separated canonical AAD and envelope seals", () => {
    const aad = buildSecretAad(metadata());
    expect(aad.subarray(0, 29).toString("utf8")).toBe(
      "memo-graph/secret-envelope/v1",
    );
    expect(secretAadHash(metadata())).toBe(
      `sha256:${createHash("sha256").update(aad).digest("hex")}`,
    );
    const cipher = createCipheriv(
      "aes-256-gcm",
      Buffer.from(Array.from({ length: 32 }, (_, index) => index)),
      Buffer.from(metadata().nonce_base64url, "base64url"),
      { authTagLength: 16 },
    );
    cipher.setAAD(aad);
    const knownAnswer = Buffer.concat([
      cipher.update(Buffer.from("memo-graph-known-answer-v1", "utf8")),
      cipher.final(),
    ]);
    expect(knownAnswer.toString("hex")).toBe(
      "2a67bb74e882b07afd29bae0df860f03aeb7e947871e2d514e56",
    );
    expect(cipher.getAuthTag().toString("hex")).toBe(
      "bc4cb8e30e1fc4903a47bd93bcee702c",
    );

    const ciphertext = Buffer.from("known-answer-ciphertext", "utf8");
    const envelope = sealSecretEnvelope({
      metadata: metadata(),
      aad_hash: secretAadHash(metadata()),
      tag_base64url: "AAECAwQFBgcICQoLDA0ODw",
      ciphertext_hash: `sha256:${createHash("sha256")
        .update(ciphertext)
        .digest("hex")}`,
      ciphertext_size_bytes: ciphertext.byteLength,
    });
    expect(
      SecretEncryptedPayloadSchema.parse({
        envelope,
        ciphertext_base64url: ciphertext.toString("base64url"),
      }),
    ).toMatchObject({ envelope });

    expect(() =>
      SecretEncryptedPayloadSchema.parse({
        envelope: {
          ...envelope,
          metadata: {
            ...envelope.metadata,
            scope: { kind: "workspace", id: "workspace:other" },
          },
        },
        ciphertext_base64url: ciphertext.toString("base64url"),
      }),
    ).toThrow();
    expect(() =>
      SecretEncryptedPayloadSchema.parse({
        envelope: { ...envelope, tag_base64url: "too-short" },
        ciphertext_base64url: ciphertext.toString("base64url"),
      }),
    ).toThrow();
  });

  it("accepts only bounded, unambiguous key inventories", () => {
    for (const state of [
      "current",
      "rotating_to",
      "retired",
      "revoked_or_compromised",
      "unavailable",
    ]) {
      expect(EncryptionKeyStateSchema.parse(state)).toBe(state);
    }
    const key = {
      key_id: "key:test:1",
      generation: 1,
      state: "current" as const,
      authority_key_id: "authority:test:1",
      commitment_key_id: "commitment:test:1",
      created_at: NOW,
      state_changed_at: NOW,
    };
    expect(
      EncryptionKeyInventorySchema.parse({
        keys: [key],
        current_key_id: key.key_id,
        rotating_to_key_id: null,
        encrypted_content_count: 0,
        rotation_id: null,
        rotation_state: null,
      }),
    ).toMatchObject({ current_key_id: key.key_id });
    expect(() =>
      EncryptionKeyInventorySchema.parse({
        keys: [
          key,
          { ...key, key_id: "key:test:2", generation: 2 },
        ],
        current_key_id: key.key_id,
        rotating_to_key_id: null,
        encrypted_content_count: 0,
        rotation_id: null,
        rotation_state: null,
      }),
    ).toThrow();
  });

  it("binds use and admission authority to exact purpose and request state", () => {
    const use = {
      schema_version: "1.0.0",
      authority_id: "secret-use:1",
      purpose: "rotation",
      principal_id: "principal:test",
      owner: metadata().owner,
      scope: metadata().scope,
      request_digest: HASH_A,
      ciphertext_id: "ciphertext:1",
      key_id: "key:test:1",
      key_generation: 1,
      authority_key_id: "authority:test:1",
      signature_algorithm: "Ed25519",
      issued_at: NOW,
      expires_at: LATER,
      authority_hash: HASH_B,
      signature: Buffer.alloc(64, 0x11).toString("base64url"),
    };
    const sealedUse = {
      ...use,
      authority_hash: canonicalSha256Omitting(use, [
        "authority_hash",
        "signature",
      ]),
    };
    expect(SecretUseAuthoritySchema.parse(sealedUse)).toMatchObject({
      purpose: "rotation",
      ciphertext_id: "ciphertext:1",
    });
    expect(() =>
      SecretUseAuthoritySchema.parse({
        ...sealedUse,
        purpose: "purge",
      }),
    ).toThrow();

    const approval = {
      schema_version: "1.0.0",
      approval_id: "secret-admission:1",
      principal_id: "principal:test",
      purpose: "secret_admission",
      sensitivity: "secret",
      envelope_version: 1,
      request_nonce: "request-nonce:test:1",
      descriptor_identity_hash: HASH_B,
      descriptor_commitment:
        `hmac-sha256:${Buffer.alloc(32, 0x33).toString("base64url")}`,
      owner: metadata().owner,
      scope: metadata().scope,
      request_digest: HASH_A,
      envelope_aad_hash: secretAadHash(metadata()),
      key_id: "key:test:1",
      key_generation: 1,
      authority_key_id: "authority:test:1",
      authority_key_generation: 1,
      signature_algorithm: "Ed25519",
      root_fence_token: 1,
      issued_at: NOW,
      expires_at: LATER,
      approval_hash: HASH_B,
      signature: Buffer.alloc(64, 0x22).toString("base64url"),
    };
    const sealedApproval = {
      ...approval,
      approval_hash: canonicalSha256Omitting(approval, [
        "approval_hash",
        "signature",
      ]),
    };
    expect(SecretAdmissionApprovalSchema.parse(sealedApproval)).toMatchObject({
      key_id: "key:test:1",
      root_fence_token: 1,
    });
    expect(() =>
      SecretAdmissionApprovalSchema.parse({
        ...sealedApproval,
        scope: { kind: "workspace", id: "workspace:other" },
      }),
    ).toThrow();
  });
});
