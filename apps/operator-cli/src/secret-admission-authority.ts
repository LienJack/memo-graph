import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign,
  timingSafeEqual,
} from "node:crypto";
import { fstatSync, readSync } from "node:fs";
import type { z } from "zod";

import {
  CanonicalHashSchema,
  SecretAdmissionApprovalSchema,
  SecretAdmissionTrustSchema,
  canonicalJson,
  canonicalSha256,
  secretAdmissionApprovalSigningPayload,
  type SecretAdmissionApproval,
  type SecretAdmissionTrust,
} from "@memo-graph/contracts";

export const MAX_SECRET_ADMISSION_BYTES = 256_000;

export class SecretAdmissionAuthorityError extends Error {
  constructor() {
    super("secret-admission authority is invalid");
    this.name = "SecretAdmissionAuthorityError";
  }
}

export type SecretDescriptorIdentity = {
  dev: string;
  ino: string;
  size: number;
  mode: number;
  uid: number;
  mtime_ns: string;
  ctime_ns: string;
};

function descriptorIdentity(descriptor: number): SecretDescriptorIdentity {
  const stat = fstatSync(descriptor, { bigint: true });
  const expectedOwner = process.getuid?.();
  const size = Number(stat.size);
  if (
    !stat.isFile() ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > MAX_SECRET_ADMISSION_BYTES ||
    (stat.mode & 0o077n) !== 0n ||
    (expectedOwner !== undefined && stat.uid !== BigInt(expectedOwner))
  ) {
    throw new SecretAdmissionAuthorityError();
  }
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size,
    mode: Number(stat.mode),
    uid: Number(stat.uid),
    mtime_ns: stat.mtimeNs.toString(),
    ctime_ns: stat.ctimeNs.toString(),
  };
}

function readBoundDescriptor(descriptor: number): {
  bytes: Buffer;
  identity: SecretDescriptorIdentity;
} {
  let bytes: Buffer | undefined;
  try {
    const before = descriptorIdentity(descriptor);
    bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (count <= 0) {
        bytes.fill(0);
        throw new SecretAdmissionAuthorityError();
      }
      offset += count;
    }
    const after = descriptorIdentity(descriptor);
    if (canonicalJson(after) !== canonicalJson(before)) {
      throw new SecretAdmissionAuthorityError();
    }
    return { bytes, identity: before };
  } catch (error) {
    bytes?.fill(0);
    if (error instanceof SecretAdmissionAuthorityError) {
      throw error;
    }
    throw new SecretAdmissionAuthorityError();
  }
}

function rawPrivateKey(seed: Uint8Array) {
  return createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      seed,
    ]),
    format: "der",
    type: "pkcs8",
  });
}

function readExactKey(descriptor: number): Buffer {
  const read = readBoundDescriptor(descriptor);
  if (read.bytes.byteLength !== 32) {
    read.bytes.fill(0);
    throw new SecretAdmissionAuthorityError();
  }
  return read.bytes;
}

export function secretDescriptorCommitment(input: {
  commitmentKey: Uint8Array;
  requestNonce: string;
  descriptorIdentity: SecretDescriptorIdentity;
  binding: unknown;
  plaintext: Uint8Array;
}): string {
  return `hmac-sha256:${createHmac("sha256", input.commitmentKey)
    .update("memo-graph/secret-admission-descriptor/v1", "utf8")
    .update(input.requestNonce, "utf8")
    .update(canonicalJson(input.descriptorIdentity), "utf8")
    .update(canonicalJson(input.binding), "utf8")
    .update(input.plaintext)
    .digest("base64url")}`;
}

export function approveSecretAdmission(input: {
  inputDescriptor: number;
  signingKeyDescriptor: number;
  commitmentKeyDescriptor: number;
  trust: SecretAdmissionTrust;
  binding: Omit<
    z.input<typeof SecretAdmissionApprovalSchema>,
    | "approval_id"
    | "descriptor_identity_hash"
    | "descriptor_commitment"
    | "approval_hash"
    | "signature"
  >;
}): SecretAdmissionApproval {
  const trust = SecretAdmissionTrustSchema.parse(input.trust);
  let signingKey: Buffer | undefined;
  let commitmentKey: Buffer | undefined;
  let secret: ReturnType<typeof readBoundDescriptor> | undefined;
  try {
    signingKey = readExactKey(input.signingKeyDescriptor);
    commitmentKey = readExactKey(input.commitmentKeyDescriptor);
    secret = readBoundDescriptor(input.inputDescriptor);
    if (timingSafeEqual(signingKey, commitmentKey)) {
      throw new SecretAdmissionAuthorityError();
    }
    const privateKey = rawPrivateKey(signingKey);
    const publicKey = createPublicKey(privateKey)
      .export({ format: "der", type: "spki" })
      .toString("base64url");
    if (
      input.binding.purpose !== "secret_admission" ||
      input.binding.authority_key_id !== trust.authority_key_id ||
      input.binding.authority_key_generation !==
        trust.authority_key_generation ||
      publicKey !== trust.public_key_spki_base64url ||
      `hmac-sha256:${createHmac("sha256", commitmentKey)
        .update(
          "memo-graph/secret-admission-commitment-key-verification/v1",
          "utf8",
        )
        .digest("base64url")}` !==
        trust.commitment_key_verification_tag
    ) {
      throw new SecretAdmissionAuthorityError();
    }
    const descriptorIdentityHash = CanonicalHashSchema.parse(
      canonicalSha256(secret.identity),
    );
    const commitmentBinding = {
      ...input.binding,
      descriptor_identity_hash: descriptorIdentityHash,
    };
    const descriptorCommitment = secretDescriptorCommitment({
      commitmentKey,
      requestNonce: input.binding.request_nonce,
      descriptorIdentity: secret.identity,
      binding: commitmentBinding,
      plaintext: secret.bytes,
    });
    const base = {
      ...input.binding,
      approval_id:
        `secret-admission:${canonicalSha256({
          request_digest: input.binding.request_digest,
          request_nonce: input.binding.request_nonce,
          descriptor_commitment: descriptorCommitment,
        }).slice("sha256:".length, "sha256:".length + 48)}`,
      descriptor_identity_hash: descriptorIdentityHash,
      descriptor_commitment: descriptorCommitment,
    };
    const approvalHash = CanonicalHashSchema.parse(canonicalSha256(base));
    return SecretAdmissionApprovalSchema.parse({
      ...base,
      approval_hash: approvalHash,
      signature: sign(
        null,
        Buffer.from(
          secretAdmissionApprovalSigningPayload({
            approval_hash: approvalHash,
          }),
          "utf8",
        ),
        privateKey,
      ).toString("base64url"),
    });
  } finally {
    secret?.bytes.fill(0);
    signingKey?.fill(0);
    commitmentKey?.fill(0);
  }
}
