import {
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { fstatSync, readSync } from "node:fs";

import {
  OperatorConfirmationSchema,
  OperatorConfirmationTrustSchema,
  canonicalSha256,
  operatorConfirmationSigningPayload,
  verifyOperatorConfirmationBinding,
  type OperationIntent,
  type OperatorConfirmation,
  type OperatorConfirmationTrust,
} from "@memo-graph/contracts";

const MAX_CONFIRMATION_KEY_BYTES = 16 * 1024;

function readPrivateDescriptor(descriptor: number): Buffer {
  const before = fstatSync(descriptor);
  const expectedOwner = process.getuid?.();
  if (
    !before.isFile() ||
    before.size <= 0 ||
    before.size > MAX_CONFIRMATION_KEY_BYTES ||
    (before.mode & 0o077) !== 0 ||
    (expectedOwner !== undefined && before.uid !== expectedOwner)
  ) {
    throw new Error("operator confirmation key is invalid");
  }
  const bytes = Buffer.alloc(before.size);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(
      descriptor,
      bytes,
      offset,
      bytes.length - offset,
      offset,
    );
    if (count === 0) {
      bytes.fill(0);
      throw new Error("operator confirmation key is invalid");
    }
    offset += count;
  }
  const after = fstatSync(descriptor);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    bytes.fill(0);
    throw new Error("operator confirmation key is invalid");
  }
  return bytes;
}

export function signOperatorConfirmationFromDescriptor(input: {
  descriptor: number;
  intent: OperationIntent;
  trust: OperatorConfirmationTrust;
  confirmationId: string;
  issuedAt: string;
  expiresAt: string;
}): OperatorConfirmation {
  const trust = OperatorConfirmationTrustSchema.parse(input.trust);
  const unsigned = {
    schema_version: "1.0.0" as const,
    confirmation_id: input.confirmationId,
    intent_hash: input.intent.intent_hash,
    command: input.intent.command,
    principal_id: input.intent.principal_id,
    nonce: input.intent.nonce,
    algorithm: trust.algorithm,
    purpose: trust.purpose,
    authority_key_id: trust.authority_key_id,
    authority_key_generation: trust.authority_key_generation,
    issued_at: input.issuedAt,
    expires_at: input.expiresAt,
  };
  const confirmation = {
    ...unsigned,
    signed_payload_hash: canonicalSha256(unsigned),
  };
  const keyBytes = readPrivateDescriptor(input.descriptor);
  try {
    const privateKey = createPrivateKey({
      key: keyBytes,
      type: "pkcs8",
      format: "der",
    });
    if (privateKey.asymmetricKeyType !== "ed25519") {
      throw new Error("operator confirmation key is invalid");
    }
    const publicKey = createPublicKey(privateKey)
      .export({ type: "spki", format: "der" })
      .toString("base64url");
    if (publicKey !== trust.public_key_spki) {
      throw new Error("operator confirmation key is invalid");
    }
    return OperatorConfirmationSchema.parse({
      ...confirmation,
      signature: sign(
        null,
        Buffer.from(operatorConfirmationSigningPayload(confirmation), "utf8"),
        privateKey,
      ).toString("base64url"),
    });
  } finally {
    keyBytes.fill(0);
  }
}

export function verifyPinnedOperatorConfirmation(input: {
  intent: unknown;
  confirmation: unknown;
  trust: unknown;
  now: string;
  consumedConfirmationIds?: ReadonlySet<string>;
}): OperatorConfirmation {
  return verifyOperatorConfirmationBinding({
    intent: input.intent,
    confirmation: input.confirmation,
    trust: input.trust,
    now: input.now,
    ...(input.consumedConfirmationIds === undefined
      ? {}
      : { consumedConfirmationIds: input.consumedConfirmationIds }),
    verifySignature: ({ payload, signature, publicKeySpki }) =>
      verify(
        null,
        Buffer.from(payload, "utf8"),
        {
          key: Buffer.from(publicKeySpki, "base64url"),
          type: "spki",
          format: "der",
        },
        Buffer.from(signature, "base64url"),
      ),
  });
}
