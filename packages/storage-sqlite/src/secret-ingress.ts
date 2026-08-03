import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  timingSafeEqual,
  verify as verifyBytes,
} from "node:crypto";
import {
  fstatSync,
  readSync,
} from "node:fs";

import {
  buildSecretAad,
  CanonicalHashSchema,
  IdentifierSchema,
  ScopeSchema,
  SecretContentOwnerSchema,
  canonicalJson,
  canonicalSha256,
  sealSecretEnvelope,
  type EncryptionKeyInventory,
  type EncryptionReceipt,
  type CanonicalHash,
  type KeyRotationProgress,
  type Scope,
  type SecretContentOwner,
  type SecretEncryptedPayload,
  SecretEncryptedPayloadSchema,
  SecretAdmissionApprovalSchema,
  SecretAdmissionTrustSchema,
  G6ReleaseControlSchema,
  secretAdmissionApprovalSigningPayload,
  secretAdmissionEnvelopeBindingHash,
  secretAdmissionEnvelopeRequestBindingHash,
  SecretUseAuthoritySchema,
  type SecretAdmissionApproval,
  type SecretAdmissionTrust,
  type G6ReleaseControl,
  type SecretUseAuthority,
} from "@memo-graph/contracts";

import { StorageError } from "./errors.js";
import type {
  ReserveSecretInput,
  ReserveSecretResult,
  SecretPurgeTarget,
} from "./encrypted-content-store.js";

type SecretIngressDependencies = {
  installKey(input: {
    operation_id: string;
    request_digest: CanonicalHash;
    key_id: string;
    key_generation: number;
    verification_tag: string;
    authority_key_id: string;
    authority_public_key_base64url: string;
    commitment_key_id: string;
    commitment_verification_tag: string;
    created_at: string;
  }): Promise<EncryptionReceipt>;
  inspectKeys(): Promise<EncryptionKeyInventory>;
  verifyKey(input: {
    key_id: string;
    key_generation: number;
    verification_tag: string;
    forbidden_authority_public_keys?: string[];
  }): Promise<void>;
  reserve(input: ReserveSecretInput): Promise<ReserveSecretResult>;
  commit(input: {
    operation_id: string;
    request_digest: CanonicalHash;
    payload: SecretEncryptedPayload;
    approval: SecretAdmissionApproval;
    release_control: G6ReleaseControl | null;
    validated_at: string;
  }): Promise<EncryptionReceipt>;
  rootFenceToken(): number;
  beginRotation(input: {
    rotation_id: string;
    request_digest: CanonicalHash;
    new_key_id: string;
    new_key_generation: number;
    new_verification_tag: string;
    new_authority_key_id: string;
    new_authority_public_key_base64url: string;
    new_commitment_key_id: string;
    new_commitment_verification_tag: string;
    started_at: string;
  }): Promise<{ progress: KeyRotationProgress; receipt: EncryptionReceipt }>;
  rotation(rotationId: string): Promise<KeyRotationProgress>;
  rotationNext(rotationId: string): Promise<{
    progress: KeyRotationProgress;
    item: {
      rotation_id: string;
      old_ciphertext_id: string;
      owner: SecretContentOwner;
      old_metadata: SecretEncryptedPayload["envelope"]["metadata"];
    } | null;
  }>;
  consumeUseAuthority(
    authority: SecretUseAuthority,
  ): Promise<{
    receipt: EncryptionReceipt;
    payload: SecretEncryptedPayload;
  }>;
  reserveRotation(
    input: ReserveSecretInput & { rotation_id: string },
  ): Promise<ReserveSecretResult>;
  commitRotation(input: {
    rotation_id: string;
    old_ciphertext_id: string;
    operation_id: string;
    request_digest: CanonicalHash;
    payload: SecretEncryptedPayload;
  }): Promise<EncryptionReceipt>;
  completeRotation(rotationId: string): Promise<{
    progress: KeyRotationProgress;
    receipt: EncryptionReceipt;
  }>;
  abortRotation(rotationId: string): Promise<{
    progress: KeyRotationProgress;
    receipt: EncryptionReceipt;
  }>;
  revokeKey(input: {
    operation_id: string;
    request_digest: CanonicalHash;
    key_id: string;
    changed_at: string;
  }): Promise<{
    inventory: EncryptionKeyInventory;
    receipt: EncryptionReceipt;
  }>;
  replayPurge(input: {
    operation_id: string;
    request_digest: CanonicalHash;
  }): Promise<EncryptionReceipt | null>;
  purgeTarget(owner: SecretContentOwner): Promise<SecretPurgeTarget>;
  purge(input: {
    operation_id: string;
    request_digest: CanonicalHash;
    authority: SecretUseAuthority;
  }): Promise<EncryptionReceipt>;
};

export type DarkLaunchInstallEncryptionKeyInput = {
  idempotency_key: string;
  key_id: string;
  key_generation: number;
  key_descriptor: number;
  authority_key_id: string;
  authority_descriptor: number;
  commitment_key_id: string;
  commitment_descriptor: number;
};

export type DarkLaunchAdmitSecretInput = {
  idempotency_key: string;
  request_digest: string;
  principal_id: string;
  owner: {
    kind: "evidence" | "memory_revision";
    id: string;
    generation: number;
  };
  scope: {
    kind:
      | "thread"
      | "topic"
      | "scenario"
      | "user"
      | "workspace"
      | "agent";
    id: string;
  };
  content_identity: string;
  media_type: string;
  input_descriptor: number;
};

export type GovernedAdmitSecretInput = DarkLaunchAdmitSecretInput & {
  approval: SecretAdmissionApproval;
};

export type SecretAdmissionVerifier = {
  trust: SecretAdmissionTrust;
  commitment_key_descriptor: number;
  release_authority_public_key_base64url: string;
  encryption_provider?: {
    key_id: string;
    key_generation: number;
    key_descriptor: number;
    commitment_key_id: string;
    commitment_descriptor: number;
  };
  now?: () => string;
};

export type DarkLaunchBeginKeyRotationInput = {
  rotation_id: string;
  new_key_id: string;
  new_key_generation: number;
  new_key_descriptor: number;
  new_authority_key_id: string;
  new_authority_descriptor: number;
  new_commitment_key_id: string;
  new_commitment_descriptor: number;
};

export type DarkLaunchResumeKeyRotationInput = {
  rotation_id: string;
  old_key_descriptor: number;
  new_key_descriptor: number;
  old_authority_descriptor: number;
  new_commitment_descriptor: number;
  max_items?: number;
};

export type DarkLaunchRevokeEncryptionKeyInput = {
  idempotency_key: string;
  key_id: string;
};

export type DarkLaunchPurgeSecretInput = {
  idempotency_key: string;
  principal_id: string;
  owner: {
    kind: "evidence" | "memory_revision";
    id: string;
    generation: number;
  };
  authority_descriptor: number;
};

export type SecretIngress = {
  installKey(
    input: DarkLaunchInstallEncryptionKeyInput,
  ): Promise<EncryptionReceipt>;
  admit(input: DarkLaunchAdmitSecretInput): Promise<EncryptionReceipt>;
  preflightGoverned(input: GovernedAdmitSecretInput): Promise<void>;
  admitGoverned(
    input: GovernedAdmitSecretInput,
    releaseControl: G6ReleaseControl,
  ): Promise<EncryptionReceipt>;
  beginRotation(
    input: DarkLaunchBeginKeyRotationInput,
  ): Promise<{ progress: KeyRotationProgress; receipt: EncryptionReceipt }>;
  resumeRotation(
    input: DarkLaunchResumeKeyRotationInput,
  ): Promise<KeyRotationProgress>;
  abortRotation(rotationId: string): Promise<{
    progress: KeyRotationProgress;
    receipt: EncryptionReceipt;
  }>;
  revokeKey(input: DarkLaunchRevokeEncryptionKeyInput): Promise<{
    inventory: EncryptionKeyInventory;
    receipt: EncryptionReceipt;
  }>;
  purge(input: DarkLaunchPurgeSecretInput): Promise<EncryptionReceipt>;
};

type DescriptorIdentity = {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mode: bigint;
  uid: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
};

function descriptorIdentity(descriptor: number): DescriptorIdentity {
  const stat = fstatSync(descriptor, { bigint: true });
  const expectedOwner = process.getuid?.();
  if (
    !stat.isFile() ||
    (stat.mode & 0o077n) !== 0n ||
    (expectedOwner !== undefined && stat.uid !== BigInt(expectedOwner))
  ) {
    throw new StorageError("KEY_PROVIDER_INVALID");
  }
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mode: stat.mode,
    uid: stat.uid,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function sameDescriptor(
  left: DescriptorIdentity,
  right: DescriptorIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function descriptorRecord(identity: DescriptorIdentity) {
  return {
    dev: identity.dev.toString(),
    ino: identity.ino.toString(),
    size: Number(identity.size),
    mode: Number(identity.mode),
    uid: Number(identity.uid),
    mtime_ns: identity.mtimeNs.toString(),
    ctime_ns: identity.ctimeNs.toString(),
  };
}

function readPrivateDescriptor(
  descriptor: number,
  options: { exactBytes?: number; maximumBytes: number },
): Buffer {
  let before: DescriptorIdentity;
  try {
    before = descriptorIdentity(descriptor);
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }
    throw new StorageError("KEY_PROVIDER_INVALID");
  }
  const size = Number(before.size);
  if (
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > options.maximumBytes ||
    (options.exactBytes !== undefined && size !== options.exactBytes)
  ) {
    throw new StorageError("KEY_PROVIDER_INVALID");
  }
  const bytes = Buffer.alloc(size);
  try {
    let offset = 0;
    while (offset < size) {
      const read = readSync(descriptor, bytes, offset, size - offset, offset);
      if (read <= 0) {
        throw new StorageError("KEY_PROVIDER_INVALID");
      }
      offset += read;
    }
    const after = descriptorIdentity(descriptor);
    if (!sameDescriptor(before, after)) {
      throw new StorageError("KEY_PROVIDER_INVALID");
    }
    return bytes;
  } catch (error) {
    bytes.fill(0);
    if (error instanceof StorageError) {
      throw error;
    }
    throw new StorageError("KEY_PROVIDER_INVALID");
  }
}

function keyVerificationTag(key: Uint8Array): string {
  return `hmac-sha256:${createHmac("sha256", key)
    .update("memo-graph/key-verification/v1", "utf8")
    .digest("base64url")}`;
}

export function keyVerificationTagFromDescriptor(
  descriptor: number,
): string {
  const key = readPrivateDescriptor(descriptor, {
    exactBytes: 32,
    maximumBytes: 32,
  });
  try {
    return keyVerificationTag(key);
  } finally {
    key.fill(0);
  }
}

function commitmentVerificationTag(key: Uint8Array): string {
  return `hmac-sha256:${createHmac("sha256", key)
    .update("memo-graph/commitment-key-verification/v1", "utf8")
    .digest("base64url")}`;
}

function authorityPrivateKey(seed: Uint8Array) {
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  return createPrivateKey({
    key: Buffer.concat([prefix, seed]),
    format: "der",
    type: "pkcs8",
  });
}

function authorityPublicKey(seed: Uint8Array): string {
  return createPublicKey(authorityPrivateKey(seed))
    .export({ format: "der", type: "spki" })
    .toString("base64url");
}

function authoritySignature(seed: Uint8Array, authorityHash: string): string {
  return signBytes(
    null,
    Buffer.from(authorityHash, "utf8"),
    authorityPrivateKey(seed),
  ).toString("base64url");
}

function assertDistinctProviderKeys(keys: readonly Buffer[]): void {
  for (let left = 0; left < keys.length; left += 1) {
    for (let right = left + 1; right < keys.length; right += 1) {
      const leftKey = keys[left];
      const rightKey = keys[right];
      if (
        leftKey !== undefined &&
        rightKey !== undefined &&
        timingSafeEqual(leftKey, rightKey)
      ) {
        throw new StorageError("KEY_PROVIDER_INVALID");
      }
    }
  }
}

function plaintextCommitment(
  key: Uint8Array,
  plaintext: Uint8Array,
  input: DarkLaunchAdmitSecretInput,
): string {
  return `hmac-sha256:${createHmac("sha256", key)
    .update("memo-graph/secret-commitment/v1", "utf8")
    .update(
      canonicalJson({
        principal_id: input.principal_id,
        owner: input.owner,
        scope: input.scope,
        content_identity: input.content_identity,
        request_digest: input.request_digest,
      }),
      "utf8",
    )
    .update(plaintext)
    .digest("base64url")}`;
}

function admissionDescriptorCommitment(input: {
  key: Uint8Array;
  approval: SecretAdmissionApproval;
  identity: DescriptorIdentity;
  plaintext: Uint8Array;
}): string {
  const {
    approval_id: _approvalId,
    descriptor_commitment: _descriptorCommitment,
    approval_hash: _approvalHash,
    signature: _signature,
    ...binding
  } = input.approval;
  void _approvalId;
  void _descriptorCommitment;
  void _approvalHash;
  void _signature;
  return `hmac-sha256:${createHmac("sha256", input.key)
    .update("memo-graph/secret-admission-descriptor/v1", "utf8")
    .update(input.approval.request_nonce, "utf8")
    .update(canonicalJson(descriptorRecord(input.identity)), "utf8")
    .update(canonicalJson(binding), "utf8")
    .update(input.plaintext)
    .digest("base64url")}`;
}

function encrypt(
  key: Uint8Array,
  plaintext: Uint8Array,
  metadata: ReserveSecretResult & { state: "prepared" },
): SecretEncryptedPayload {
  const nonce = Buffer.from(metadata.metadata.nonce_base64url, "base64url");
  const cipher = createCipheriv("aes-256-gcm", key, nonce, {
    authTagLength: 16,
  });
  cipher.setAAD(buildSecretAad(metadata.metadata));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const envelope = sealSecretEnvelope({
    metadata: metadata.metadata,
    aad_hash: metadata.metadata
      ? `sha256:${createHash("sha256")
          .update(buildSecretAad(metadata.metadata))
          .digest("hex")}`
      : canonicalSha256(null),
    tag_base64url: tag.toString("base64url"),
    ciphertext_hash: `sha256:${createHash("sha256")
      .update(ciphertext)
      .digest("hex")}`,
    ciphertext_size_bytes: ciphertext.byteLength,
  });
  return {
    envelope,
    ciphertext_base64url: ciphertext.toString("base64url"),
  };
}

function decrypt(key: Uint8Array, payloadInput: unknown): Buffer {
  const payload = SecretEncryptedPayloadSchema.parse(payloadInput);
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(
        payload.envelope.metadata.nonce_base64url,
        "base64url",
      ),
      { authTagLength: 16 },
    );
    decipher.setAAD(buildSecretAad(payload.envelope.metadata));
    decipher.setAuthTag(
      Buffer.from(payload.envelope.tag_base64url, "base64url"),
    );
    return Buffer.concat([
      decipher.update(
        Buffer.from(payload.ciphertext_base64url, "base64url"),
      ),
      decipher.final(),
    ]);
  } catch {
    throw new StorageError("KEY_PROVIDER_INVALID");
  }
}

function rotationPlaintextCommitment(
  key: Uint8Array,
  plaintext: Uint8Array,
  input: {
    owner: SecretContentOwner;
    scope: Scope;
    content_identity: string;
    request_digest: CanonicalHash;
  },
): string {
  return `hmac-sha256:${createHmac("sha256", key)
    .update("memo-graph/secret-commitment/v1", "utf8")
    .update(canonicalJson(input), "utf8")
    .update(plaintext)
    .digest("base64url")}`;
}

function createRotationUseAuthority(input: {
  authorityKey: Uint8Array;
  authorityKeyId: string;
  item: {
    rotation_id: string;
    old_ciphertext_id: string;
    owner: SecretContentOwner;
    old_metadata: SecretEncryptedPayload["envelope"]["metadata"];
  };
  request_digest: CanonicalHash;
}): SecretUseAuthority {
  const issuedAt = new Date();
  const base = {
    schema_version: "1.0.0",
    authority_id:
      `rotation-use:${canonicalSha256({
        rotation_id: input.item.rotation_id,
        ciphertext_id: input.item.old_ciphertext_id,
        request_digest: input.request_digest,
      }).slice("sha256:".length, "sha256:".length + 48)}`,
    principal_id: "runtime:dark-launch",
    purpose: "rotation" as const,
    owner: input.item.owner,
    scope: input.item.old_metadata.scope,
    request_digest: input.request_digest,
    key_id: input.item.old_metadata.key_id,
    key_generation: input.item.old_metadata.key_generation,
    authority_key_id: input.authorityKeyId,
    signature_algorithm: "Ed25519" as const,
    ciphertext_id: input.item.old_ciphertext_id,
    issued_at: issuedAt.toISOString(),
    expires_at: new Date(issuedAt.getTime() + 60_000).toISOString(),
  };
  const authorityHash = CanonicalHashSchema.parse(canonicalSha256(base));
  return SecretUseAuthoritySchema.parse({
    ...base,
    authority_hash: authorityHash,
    signature: authoritySignature(input.authorityKey, authorityHash),
  });
}

function createAdmissionApproval(input: {
  authorityKey: Uint8Array;
  authorityKeyId: string;
  principal_id: string;
  request_digest: CanonicalHash;
  metadata: SecretEncryptedPayload["envelope"]["metadata"];
  aad_hash: CanonicalHash;
  root_fence_token: number;
  descriptor_identity_hash: CanonicalHash;
  descriptor_commitment: string;
}): SecretAdmissionApproval {
  const issuedAt = new Date();
  const base = {
    schema_version: "1.0.0",
    approval_id:
      `secret-admission:${canonicalSha256({
        request_digest: input.request_digest,
        envelope_aad_hash: input.aad_hash,
      }).slice("sha256:".length, "sha256:".length + 48)}`,
    principal_id: input.principal_id,
    purpose: "secret_admission" as const,
    sensitivity: "secret" as const,
    envelope_version: 1 as const,
    request_nonce:
      `dark-launch:${canonicalSha256(input.request_digest).slice(
        "sha256:".length,
        "sha256:".length + 40,
      )}`,
    descriptor_identity_hash: input.descriptor_identity_hash,
    descriptor_commitment: input.descriptor_commitment,
    owner: input.metadata.owner,
    scope: input.metadata.scope,
    request_digest: input.request_digest,
    envelope_aad_hash: secretAdmissionEnvelopeBindingHash(input.metadata),
    key_id: input.metadata.key_id,
    key_generation: input.metadata.key_generation,
    authority_key_id: input.authorityKeyId,
    authority_key_generation: input.metadata.key_generation,
    signature_algorithm: "Ed25519" as const,
    root_fence_token: input.root_fence_token,
    issued_at: issuedAt.toISOString(),
    expires_at: new Date(issuedAt.getTime() + 60_000).toISOString(),
  };
  const approvalHash = CanonicalHashSchema.parse(canonicalSha256(base));
  return SecretAdmissionApprovalSchema.parse({
    ...base,
    approval_hash: approvalHash,
    signature: authoritySignature(input.authorityKey, approvalHash),
  });
}

function createPurgeUseAuthority(input: {
  authorityKey: Uint8Array;
  authorityKeyId: string;
  principal_id: string;
  request_digest: CanonicalHash;
  target: SecretPurgeTarget;
  authority_id: string;
}): SecretUseAuthority {
  const issuedAt = new Date();
  const metadata = input.target.metadata;
  const base = {
    schema_version: "1.0.0",
    authority_id: input.authority_id,
    principal_id: input.principal_id,
    purpose: "purge" as const,
    owner: input.target.owner,
    scope: metadata.scope,
    request_digest: input.request_digest,
    key_id: metadata.key_id,
    key_generation: metadata.key_generation,
    authority_key_id: input.authorityKeyId,
    signature_algorithm: "Ed25519" as const,
    ciphertext_id: input.target.ciphertext_id,
    issued_at: issuedAt.toISOString(),
    expires_at: new Date(issuedAt.getTime() + 60_000).toISOString(),
  };
  const authorityHash = CanonicalHashSchema.parse(canonicalSha256(base));
  return SecretUseAuthoritySchema.parse({
    ...base,
    authority_hash: authorityHash,
    signature: authoritySignature(input.authorityKey, authorityHash),
  });
}

class SecretIngressCoordinator implements SecretIngress {
  readonly #dependencies: SecretIngressDependencies;
  readonly #principalId: string | null;
  readonly #admissionVerifier: SecretAdmissionVerifier | null;
  readonly #keyDescriptors = new Map<
    string,
    {
      generation: number;
      keyDescriptor: number;
      authorityKeyId: string | null;
      authorityDescriptor: number | null;
      commitmentKeyId: string;
      commitmentDescriptor: number;
    }
  >();

  constructor(
    dependencies: SecretIngressDependencies,
    principalId: string | null,
    admissionVerifier: SecretAdmissionVerifier | null,
  ) {
    this.#dependencies = dependencies;
    this.#principalId = principalId;
    this.#admissionVerifier = admissionVerifier;
    const provider = admissionVerifier?.encryption_provider;
    if (provider !== undefined) {
      this.#keyDescriptors.set(provider.key_id, {
        generation: provider.key_generation,
        keyDescriptor: provider.key_descriptor,
        authorityKeyId: null,
        authorityDescriptor: null,
        commitmentKeyId: provider.commitment_key_id,
        commitmentDescriptor: provider.commitment_descriptor,
      });
    }
  }

  async #verifyGovernedInput(
    input: GovernedAdmitSecretInput,
  ): Promise<{
    plaintext: Buffer;
    identity: DescriptorIdentity;
    approval: SecretAdmissionApproval;
    validatedAt: string;
  }> {
    const verifier = this.#admissionVerifier;
    if (verifier === null) {
      throw new StorageError("ENCRYPTION_REQUIRED");
    }
    const parsedApproval = SecretAdmissionApprovalSchema.safeParse(
      input.approval,
    );
    if (!parsedApproval.success) {
      throw new StorageError("AUTHORITY_REPLAY");
    }
    const approval = parsedApproval.data;
    const trust = SecretAdmissionTrustSchema.parse(verifier.trust);
    if (
      trust.public_key_spki_base64url ===
      verifier.release_authority_public_key_base64url
    ) {
      throw new StorageError("ENCRYPTION_REQUIRED");
    }
    const validatedAt = (
      verifier.now ?? (() => new Date().toISOString())
    )();
    const now = Date.parse(validatedAt);
    const issuedAt = Date.parse(approval.issued_at);
    const expiresAt = Date.parse(approval.expires_at);
    const revokedAt =
      trust.revoked_at === null ? null : Date.parse(trust.revoked_at);
    const expectedRequestDigest = canonicalSha256({
      schema_version: "1.0.0",
      purpose: "secret_admission",
      sensitivity: "secret",
      envelope_version: 1,
      idempotency_key: input.idempotency_key,
      principal_id: input.principal_id,
      owner: input.owner,
      scope: input.scope,
      content_identity: input.content_identity,
      media_type: input.media_type,
      request_nonce: approval.request_nonce,
    });
    if (
      input.request_digest !== expectedRequestDigest ||
      approval.request_digest !== expectedRequestDigest
    ) {
      throw new StorageError("AUTHORITY_REPLAY");
    }
    let before: DescriptorIdentity;
    try {
      before = descriptorIdentity(input.input_descriptor);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError("KEY_PROVIDER_INVALID");
    }
    const plaintext = readPrivateDescriptor(input.input_descriptor, {
      maximumBytes: 256_000,
    });
    try {
      const after = descriptorIdentity(input.input_descriptor);
      const commitmentKey = readPrivateDescriptor(
        verifier.commitment_key_descriptor,
        { exactBytes: 32, maximumBytes: 32 },
      );
      try {
        const signatureValid = (() => {
          try {
            return verifyBytes(
              null,
              Buffer.from(
                secretAdmissionApprovalSigningPayload(approval),
                "utf8",
              ),
              {
                key: Buffer.from(
                  trust.public_key_spki_base64url,
                  "base64url",
                ),
                format: "der",
                type: "spki",
              },
              Buffer.from(approval.signature, "base64url"),
            );
          } catch {
            return false;
          }
        })();
        const inventory = await this.#dependencies.inspectKeys();
        const current = inventory.keys.find(
          ({ key_id }) => key_id === inventory.current_key_id,
        );
        if (
          this.#principalId === null ||
          input.principal_id !== this.#principalId ||
          approval.principal_id !== input.principal_id ||
          approval.purpose !== trust.purpose ||
          approval.authority_key_id !== trust.authority_key_id ||
          approval.authority_key_generation !==
            trust.authority_key_generation ||
          approval.owner.kind !== input.owner.kind ||
          approval.owner.id !== input.owner.id ||
          approval.owner.generation !== input.owner.generation ||
          canonicalJson(approval.scope) !== canonicalJson(input.scope) ||
          approval.request_digest !== input.request_digest ||
          approval.sensitivity !== "secret" ||
          approval.envelope_version !== 1 ||
          approval.root_fence_token !==
            this.#dependencies.rootFenceToken() ||
          current === undefined ||
          approval.key_id !== current.key_id ||
          approval.key_generation !== current.generation ||
          issuedAt < Date.parse(trust.valid_from) ||
          expiresAt > Date.parse(trust.expires_at) ||
          issuedAt > now ||
          expiresAt <= now ||
          (expiresAt - issuedAt) / 1_000 >
            trust.maximum_approval_ttl_seconds ||
          (revokedAt !== null && revokedAt <= now) ||
          !sameDescriptor(before, after) ||
          approval.descriptor_identity_hash !==
            canonicalSha256(descriptorRecord(before)) ||
          approval.envelope_aad_hash !==
            (current === undefined
              ? null
              : secretAdmissionEnvelopeRequestBindingHash({
                  key_id: current.key_id,
                  key_generation: current.generation,
                  owner: SecretContentOwnerSchema.parse(input.owner),
                  scope: ScopeSchema.parse(input.scope),
                  content_identity: IdentifierSchema.parse(
                    input.content_identity,
                  ),
                  content_class: input.owner.kind,
                  media_type: input.media_type,
                })) ||
          `hmac-sha256:${createHmac("sha256", commitmentKey)
            .update(
              "memo-graph/secret-admission-commitment-key-verification/v1",
              "utf8",
            )
            .digest("base64url")}` !==
            trust.commitment_key_verification_tag ||
          approval.descriptor_commitment !==
            admissionDescriptorCommitment({
              key: commitmentKey,
              approval,
              identity: before,
              plaintext,
            }) ||
          !signatureValid
        ) {
          throw new StorageError("AUTHORITY_REPLAY");
        }
        return { plaintext, identity: before, approval, validatedAt };
      } finally {
        commitmentKey.fill(0);
      }
    } catch (error) {
      plaintext.fill(0);
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError("KEY_PROVIDER_INVALID");
    }
  }

  async preflightGoverned(input: GovernedAdmitSecretInput): Promise<void> {
    const verified = await this.#verifyGovernedInput(input);
    verified.plaintext.fill(0);
  }

  async installKey(
    input: DarkLaunchInstallEncryptionKeyInput,
  ): Promise<EncryptionReceipt> {
    const key = readPrivateDescriptor(input.key_descriptor, {
      exactBytes: 32,
      maximumBytes: 32,
    });
    const authorityKey = readPrivateDescriptor(input.authority_descriptor, {
      exactBytes: 32,
      maximumBytes: 32,
    });
    const commitmentKey = readPrivateDescriptor(
      input.commitment_descriptor,
      {
        exactBytes: 32,
        maximumBytes: 32,
      },
    );
    try {
      assertDistinctProviderKeys([key, authorityKey, commitmentKey]);
      const authorityKeyId = IdentifierSchema.parse(input.authority_key_id);
      const commitmentKeyId = IdentifierSchema.parse(input.commitment_key_id);
      const requestDigest = CanonicalHashSchema.parse(
        canonicalSha256({
          idempotency_key: input.idempotency_key,
          key_id: input.key_id,
          key_generation: input.key_generation,
          verification_tag: keyVerificationTag(key),
          authority_key_id: authorityKeyId,
          authority_public_key_base64url:
            authorityPublicKey(authorityKey),
          commitment_key_id: commitmentKeyId,
          commitment_verification_tag:
            commitmentVerificationTag(commitmentKey),
        }),
      );
      const receipt = await this.#dependencies.installKey({
        operation_id: input.idempotency_key,
        request_digest: requestDigest,
        key_id: input.key_id,
        key_generation: input.key_generation,
        verification_tag: keyVerificationTag(key),
        authority_key_id: authorityKeyId,
        authority_public_key_base64url: authorityPublicKey(authorityKey),
        commitment_key_id: commitmentKeyId,
        commitment_verification_tag:
          commitmentVerificationTag(commitmentKey),
        created_at: new Date().toISOString(),
      });
      this.#keyDescriptors.set(input.key_id, {
        generation: input.key_generation,
        keyDescriptor: input.key_descriptor,
        authorityKeyId,
        authorityDescriptor: input.authority_descriptor,
        commitmentKeyId,
        commitmentDescriptor: input.commitment_descriptor,
      });
      return receipt;
    } finally {
      key.fill(0);
      authorityKey.fill(0);
      commitmentKey.fill(0);
    }
  }

  async admit(
    input: DarkLaunchAdmitSecretInput,
  ): Promise<EncryptionReceipt> {
    const normalized = {
      ...input,
      request_digest: CanonicalHashSchema.parse(input.request_digest),
      principal_id: IdentifierSchema.parse(input.principal_id),
      owner: SecretContentOwnerSchema.parse(input.owner),
      scope: ScopeSchema.parse(input.scope),
      content_identity: IdentifierSchema.parse(input.content_identity),
    };
    if (
      this.#principalId === null ||
      normalized.principal_id !== this.#principalId
    ) {
      throw new StorageError("KEY_PROVIDER_INVALID");
    }
    const inventory = await this.#dependencies.inspectKeys();
    const keyId = inventory.current_key_id;
    if (keyId === null) {
      throw new StorageError("KEY_UNAVAILABLE");
    }
    const keyDescriptor = this.#keyDescriptors.get(keyId);
    const keyMetadata = inventory.keys.find(({ key_id }) => key_id === keyId);
    if (keyDescriptor === undefined || keyMetadata === undefined) {
      throw new StorageError("KEY_UNAVAILABLE");
    }
    const key = readPrivateDescriptor(keyDescriptor.keyDescriptor, {
      exactBytes: 32,
      maximumBytes: 32,
    });
    const authorityKey = readPrivateDescriptor(
      keyDescriptor.authorityDescriptor ?? -1,
      { exactBytes: 32, maximumBytes: 32 },
    );
    const commitmentKey = readPrivateDescriptor(
      keyDescriptor.commitmentDescriptor,
      { exactBytes: 32, maximumBytes: 32 },
    );
    let plaintext: Buffer | undefined;
    try {
      await this.#dependencies.verifyKey({
        key_id: keyId,
        key_generation: keyMetadata.generation,
        verification_tag: keyVerificationTag(key),
      });
      assertDistinctProviderKeys([key, authorityKey, commitmentKey]);
      plaintext = readPrivateDescriptor(normalized.input_descriptor, {
        maximumBytes: 256_000,
      });
      const operationId =
        `secret-admit:${canonicalSha256(normalized.idempotency_key).slice(
          "sha256:".length,
          "sha256:".length + 48,
        )}`;
      const reservation = await this.#dependencies.reserve({
        operation_id: operationId,
        idempotency_key: normalized.idempotency_key,
        request_digest: normalized.request_digest,
        owner: normalized.owner,
        scope: normalized.scope,
        content_identity: normalized.content_identity,
        media_type: normalized.media_type,
        keyed_plaintext_commitment: plaintextCommitment(
          commitmentKey,
          plaintext,
          normalized,
        ),
        commitment_key_id: keyDescriptor.commitmentKeyId,
        commitment_verification_tag:
          commitmentVerificationTag(commitmentKey),
      });
      if (reservation.state === "committed") {
        return reservation.receipt;
      }
      const payload = encrypt(key, plaintext, reservation);
      return await this.#dependencies.commit({
        operation_id: reservation.operation_id,
        request_digest: normalized.request_digest,
        payload,
        approval: createAdmissionApproval({
          authorityKey,
          authorityKeyId:
            keyDescriptor.authorityKeyId ??
            (() => {
              throw new StorageError("KEY_PROVIDER_INVALID");
            })(),
          principal_id: normalized.principal_id,
          request_digest: normalized.request_digest,
          metadata: payload.envelope.metadata,
          aad_hash: payload.envelope.aad_hash,
          root_fence_token: this.#dependencies.rootFenceToken(),
          descriptor_identity_hash: CanonicalHashSchema.parse(
            canonicalSha256(
              descriptorRecord(descriptorIdentity(normalized.input_descriptor)),
            ),
          ),
          descriptor_commitment:
            `hmac-sha256:${createHmac("sha256", commitmentKey)
              .update("memo-graph/dark-launch-descriptor/v1", "utf8")
              .update(plaintext)
              .digest("base64url")}`,
        }),
        release_control: null,
        validated_at: new Date().toISOString(),
      });
    } finally {
      plaintext?.fill(0);
      key.fill(0);
      authorityKey.fill(0);
      commitmentKey.fill(0);
    }
  }

  async admitGoverned(
    input: GovernedAdmitSecretInput,
    releaseControlInput: G6ReleaseControl,
  ): Promise<EncryptionReceipt> {
    const admissionVerifier = this.#admissionVerifier;
    if (admissionVerifier === null) {
      throw new StorageError("ENCRYPTION_REQUIRED");
    }
    const releaseControl = G6ReleaseControlSchema.parse(releaseControlInput);
    const verified = await this.#verifyGovernedInput(input);
    const inventory = await this.#dependencies.inspectKeys();
    const keyId = inventory.current_key_id;
    const keyMetadata = inventory.keys.find(({ key_id }) => key_id === keyId);
    const keyDescriptor =
      keyId === null ? undefined : this.#keyDescriptors.get(keyId);
    if (
      keyId === null ||
      keyMetadata === undefined ||
      keyDescriptor === undefined
    ) {
      verified.plaintext.fill(0);
      throw new StorageError("KEY_UNAVAILABLE");
    }
    let key: Buffer | undefined;
    let contentCommitmentKey: Buffer | undefined;
    let admissionCommitmentKey: Buffer | undefined;
    try {
      key = readPrivateDescriptor(keyDescriptor.keyDescriptor, {
        exactBytes: 32,
        maximumBytes: 32,
      });
      contentCommitmentKey = readPrivateDescriptor(
        keyDescriptor.commitmentDescriptor,
        { exactBytes: 32, maximumBytes: 32 },
      );
      admissionCommitmentKey = readPrivateDescriptor(
        admissionVerifier.commitment_key_descriptor,
        { exactBytes: 32, maximumBytes: 32 },
      );
      assertDistinctProviderKeys([
        key,
        contentCommitmentKey,
        admissionCommitmentKey,
      ]);
      const forbiddenSigningPublicKeys = new Set([
        admissionVerifier.trust.public_key_spki_base64url,
        admissionVerifier.release_authority_public_key_base64url,
      ]);
      if (
        [key, contentCommitmentKey, admissionCommitmentKey].some(
          (providerKey) =>
            forbiddenSigningPublicKeys.has(
              authorityPublicKey(providerKey),
            ),
        )
      ) {
        throw new StorageError("KEY_PROVIDER_INVALID");
      }
      await this.#dependencies.verifyKey({
        key_id: keyId,
        key_generation: keyMetadata.generation,
        verification_tag: keyVerificationTag(key),
        forbidden_authority_public_keys: [
          admissionVerifier.trust.public_key_spki_base64url,
          admissionVerifier.release_authority_public_key_base64url,
        ],
      });
      const operationId =
        `secret-admit:${canonicalSha256(input.idempotency_key).slice(
          "sha256:".length,
          "sha256:".length + 48,
        )}`;
      const reservation = await this.#dependencies.reserve({
        operation_id: operationId,
        idempotency_key: input.idempotency_key,
        request_digest: CanonicalHashSchema.parse(input.request_digest),
        owner: SecretContentOwnerSchema.parse(input.owner),
        scope: ScopeSchema.parse(input.scope),
        content_identity: IdentifierSchema.parse(input.content_identity),
        media_type: input.media_type,
        keyed_plaintext_commitment: plaintextCommitment(
          contentCommitmentKey,
          verified.plaintext,
          input,
        ),
        commitment_key_id: keyDescriptor.commitmentKeyId,
        commitment_verification_tag:
          commitmentVerificationTag(contentCommitmentKey),
      });
      if (reservation.state === "committed") {
        return reservation.receipt;
      }
      const payload = encrypt(key, verified.plaintext, reservation);
      if (
        input.approval.envelope_aad_hash !==
          secretAdmissionEnvelopeBindingHash(payload.envelope.metadata)
      ) {
        throw new StorageError("AUTHORITY_REPLAY");
      }
      return await this.#dependencies.commit({
        operation_id: reservation.operation_id,
        request_digest: CanonicalHashSchema.parse(input.request_digest),
        payload,
        approval: verified.approval,
        release_control: releaseControl,
        validated_at: verified.validatedAt,
      });
    } finally {
      verified.plaintext.fill(0);
      key?.fill(0);
      contentCommitmentKey?.fill(0);
      admissionCommitmentKey?.fill(0);
    }
  }

  async beginRotation(
    input: DarkLaunchBeginKeyRotationInput,
  ): Promise<{ progress: KeyRotationProgress; receipt: EncryptionReceipt }> {
    const key = readPrivateDescriptor(input.new_key_descriptor, {
      exactBytes: 32,
      maximumBytes: 32,
    });
    const authorityKey = readPrivateDescriptor(
      input.new_authority_descriptor,
      { exactBytes: 32, maximumBytes: 32 },
    );
    const commitmentKey = readPrivateDescriptor(
      input.new_commitment_descriptor,
      { exactBytes: 32, maximumBytes: 32 },
    );
    try {
      assertDistinctProviderKeys([key, authorityKey, commitmentKey]);
      const authorityKeyId = IdentifierSchema.parse(
        input.new_authority_key_id,
      );
      const commitmentKeyId = IdentifierSchema.parse(
        input.new_commitment_key_id,
      );
      const requestDigest = CanonicalHashSchema.parse(
        canonicalSha256({
          rotation_id: input.rotation_id,
          new_key_id: input.new_key_id,
          new_key_generation: input.new_key_generation,
          new_verification_tag: keyVerificationTag(key),
          new_authority_key_id: authorityKeyId,
          new_authority_public_key_base64url:
            authorityPublicKey(authorityKey),
          new_commitment_key_id: commitmentKeyId,
          new_commitment_verification_tag:
            commitmentVerificationTag(commitmentKey),
        }),
      );
      const result = await this.#dependencies.beginRotation({
        rotation_id: input.rotation_id,
        request_digest: requestDigest,
        new_key_id: input.new_key_id,
        new_key_generation: input.new_key_generation,
        new_verification_tag: keyVerificationTag(key),
        new_authority_key_id: authorityKeyId,
        new_authority_public_key_base64url:
          authorityPublicKey(authorityKey),
        new_commitment_key_id: commitmentKeyId,
        new_commitment_verification_tag:
          commitmentVerificationTag(commitmentKey),
        started_at: new Date().toISOString(),
      });
      this.#keyDescriptors.set(input.new_key_id, {
        generation: input.new_key_generation,
        keyDescriptor: input.new_key_descriptor,
        authorityKeyId,
        authorityDescriptor: input.new_authority_descriptor,
        commitmentKeyId,
        commitmentDescriptor: input.new_commitment_descriptor,
      });
      return result;
    } finally {
      key.fill(0);
      authorityKey.fill(0);
      commitmentKey.fill(0);
    }
  }

  async resumeRotation(
    input: DarkLaunchResumeKeyRotationInput,
  ): Promise<KeyRotationProgress> {
    const starting = await this.#dependencies.rotation(input.rotation_id);
    if (starting.state === "completed") {
      return starting;
    }
    if (starting.state !== "in_progress") {
      throw new StorageError("ROTATION_INCOMPLETE");
    }
    const inventory = await this.#dependencies.inspectKeys();
    const oldMetadata = inventory.keys.find(
      ({ key_id }) => key_id === starting.old_key_id,
    );
    const newMetadata = inventory.keys.find(
      ({ key_id }) => key_id === starting.new_key_id,
    );
    if (oldMetadata === undefined || newMetadata === undefined) {
      throw new StorageError("KEY_STATE_AMBIGUOUS");
    }
    const oldKey = readPrivateDescriptor(input.old_key_descriptor, {
      exactBytes: 32,
      maximumBytes: 32,
    });
    const newKey = readPrivateDescriptor(input.new_key_descriptor, {
      exactBytes: 32,
      maximumBytes: 32,
    });
    const oldAuthorityKey = readPrivateDescriptor(
      input.old_authority_descriptor,
      { exactBytes: 32, maximumBytes: 32 },
    );
    const newCommitmentKey = readPrivateDescriptor(
      input.new_commitment_descriptor,
      { exactBytes: 32, maximumBytes: 32 },
    );
    try {
      assertDistinctProviderKeys([
        oldKey,
        newKey,
        oldAuthorityKey,
        newCommitmentKey,
      ]);
      await this.#dependencies.verifyKey({
        key_id: starting.old_key_id,
        key_generation: oldMetadata.generation,
        verification_tag: keyVerificationTag(oldKey),
      });
      await this.#dependencies.verifyKey({
        key_id: starting.new_key_id,
        key_generation: newMetadata.generation,
        verification_tag: keyVerificationTag(newKey),
      });
      if (
        input.max_items !== undefined &&
        (!Number.isSafeInteger(input.max_items) || input.max_items < 0)
      ) {
        throw new StorageError("INVALID_INPUT");
      }
      const maximum = input.max_items ?? Number.MAX_SAFE_INTEGER;
      let rewritten = 0;
      while (rewritten < maximum) {
        const next = await this.#dependencies.rotationNext(input.rotation_id);
        if (next.item === null) {
          return (
            await this.#dependencies.completeRotation(input.rotation_id)
          ).progress;
        }
        const requestDigest = CanonicalHashSchema.parse(
          canonicalSha256({
            rotation_id: input.rotation_id,
            old_ciphertext_id: next.item.old_ciphertext_id,
            owner: next.item.owner,
          }),
        );
        const authorized = await this.#dependencies.consumeUseAuthority(
          createRotationUseAuthority({
            authorityKey: oldAuthorityKey,
            authorityKeyId: oldMetadata.authority_key_id,
            item: next.item,
            request_digest: requestDigest,
          }),
        );
        const plaintext = decrypt(oldKey, authorized.payload);
        try {
          const operationId =
            `rotation-item:${canonicalSha256({
              rotation_id: input.rotation_id,
              owner: next.item.owner,
            }).slice("sha256:".length, "sha256:".length + 48)}`;
          const oldMetadataEnvelope =
            next.item.old_metadata;
          const reservation = await this.#dependencies.reserveRotation({
            rotation_id: input.rotation_id,
            operation_id: operationId,
            idempotency_key: operationId,
            request_digest: requestDigest,
            owner: next.item.owner,
            scope: oldMetadataEnvelope.scope,
            content_identity: oldMetadataEnvelope.content_identity,
            media_type: oldMetadataEnvelope.media_type,
            keyed_plaintext_commitment: rotationPlaintextCommitment(
              newCommitmentKey,
              plaintext,
              {
                owner: next.item.owner,
                scope: oldMetadataEnvelope.scope,
                content_identity: oldMetadataEnvelope.content_identity,
                request_digest: requestDigest,
              },
            ),
            commitment_key_id: newMetadata.commitment_key_id,
            commitment_verification_tag:
              commitmentVerificationTag(newCommitmentKey),
          });
          if (reservation.state === "prepared") {
            await this.#dependencies.commitRotation({
              rotation_id: input.rotation_id,
              old_ciphertext_id: next.item.old_ciphertext_id,
              operation_id: operationId,
              request_digest: requestDigest,
              payload: encrypt(newKey, plaintext, reservation),
            });
          }
          rewritten += 1;
        } finally {
          plaintext.fill(0);
        }
      }
      const progress = await this.#dependencies.rotation(input.rotation_id);
      if (progress.rewritten_items === progress.total_items) {
        return (
          await this.#dependencies.completeRotation(input.rotation_id)
        ).progress;
      }
      return progress;
    } finally {
      oldKey.fill(0);
      newKey.fill(0);
      oldAuthorityKey.fill(0);
      newCommitmentKey.fill(0);
    }
  }

  async abortRotation(rotationId: string): Promise<{
    progress: KeyRotationProgress;
    receipt: EncryptionReceipt;
  }> {
    const result = await this.#dependencies.abortRotation(rotationId);
    this.#keyDescriptors.delete(result.progress.new_key_id);
    return result;
  }

  async revokeKey(
    input: DarkLaunchRevokeEncryptionKeyInput,
  ): Promise<{
    inventory: EncryptionKeyInventory;
    receipt: EncryptionReceipt;
  }> {
    const requestDigest = CanonicalHashSchema.parse(
      canonicalSha256({
        operation: "key-revoke",
        idempotency_key: input.idempotency_key,
        key_id: input.key_id,
      }),
    );
    const result = await this.#dependencies.revokeKey({
      operation_id: input.idempotency_key,
      request_digest: requestDigest,
      key_id: input.key_id,
      changed_at: new Date().toISOString(),
    });
    this.#keyDescriptors.delete(input.key_id);
    return result;
  }

  async purge(
    input: DarkLaunchPurgeSecretInput,
  ): Promise<EncryptionReceipt> {
    const owner = SecretContentOwnerSchema.parse(input.owner);
    const principalId = IdentifierSchema.parse(input.principal_id);
    if (this.#principalId === null || principalId !== this.#principalId) {
      throw new StorageError("KEY_PROVIDER_INVALID");
    }
    const operationId =
      `secret-purge:${canonicalSha256(input.idempotency_key).slice(
        "sha256:".length,
        "sha256:".length + 48,
      )}`;
    const requestDigest = CanonicalHashSchema.parse(
      canonicalSha256({
        operation: "secret-purge",
        idempotency_key: input.idempotency_key,
        principal_id: principalId,
        owner,
      }),
    );
    const replay = await this.#dependencies.replayPurge({
      operation_id: operationId,
      request_digest: requestDigest,
    });
    if (replay !== null) {
      return replay;
    }
    const target = await this.#dependencies.purgeTarget(owner);
    const inventory = await this.#dependencies.inspectKeys();
    const key = inventory.keys.find(
      ({ key_id }) => key_id === target.metadata.key_id,
    );
    if (key === undefined) {
      throw new StorageError("KEY_UNAVAILABLE");
    }
    const authorityKey = readPrivateDescriptor(
      input.authority_descriptor,
      { exactBytes: 32, maximumBytes: 32 },
    );
    try {
      return await this.#dependencies.purge({
        operation_id: operationId,
        request_digest: requestDigest,
        authority: createPurgeUseAuthority({
          authorityKey,
          authorityKeyId: key.authority_key_id,
          principal_id: principalId,
          request_digest: requestDigest,
          target,
          authority_id:
            `secret-purge-use:${canonicalSha256({
              operation_id: operationId,
              owner,
            }).slice("sha256:".length, "sha256:".length + 48)}`,
        }),
      });
    } finally {
      authorityKey.fill(0);
    }
  }
}

export function createSecretIngressCoordinator(
  dependencies: SecretIngressDependencies,
  principalId: string | null,
  admissionVerifier: SecretAdmissionVerifier | null = null,
): SecretIngress {
  return new SecretIngressCoordinator(
    dependencies,
    principalId,
    admissionVerifier,
  );
}
