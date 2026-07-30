import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  timingSafeEqual,
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
  SecretUseAuthoritySchema,
  type SecretAdmissionApproval,
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
  }): Promise<void>;
  reserve(input: ReserveSecretInput): Promise<ReserveSecretResult>;
  commit(input: {
    operation_id: string;
    request_digest: CanonicalHash;
    payload: SecretEncryptedPayload;
    approval: SecretAdmissionApproval;
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
    owner: input.metadata.owner,
    scope: input.metadata.scope,
    request_digest: input.request_digest,
    envelope_aad_hash: input.aad_hash,
    key_id: input.metadata.key_id,
    key_generation: input.metadata.key_generation,
    authority_key_id: input.authorityKeyId,
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
  readonly #keyDescriptors = new Map<
    string,
    {
      generation: number;
      keyDescriptor: number;
      authorityKeyId: string;
      authorityDescriptor: number;
      commitmentKeyId: string;
      commitmentDescriptor: number;
    }
  >();

  constructor(
    dependencies: SecretIngressDependencies,
    principalId: string | null,
  ) {
    this.#dependencies = dependencies;
    this.#principalId = principalId;
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
      keyDescriptor.authorityDescriptor,
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
          authorityKeyId: keyDescriptor.authorityKeyId,
          principal_id: normalized.principal_id,
          request_digest: normalized.request_digest,
          metadata: payload.envelope.metadata,
          aad_hash: payload.envelope.aad_hash,
          root_fence_token: this.#dependencies.rootFenceToken(),
        }),
      });
    } finally {
      plaintext?.fill(0);
      key.fill(0);
      authorityKey.fill(0);
      commitmentKey.fill(0);
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
): SecretIngress {
  return new SecretIngressCoordinator(dependencies, principalId);
}
