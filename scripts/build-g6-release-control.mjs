import { Buffer } from "node:buffer";
import {
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import { fstatSync, readFileSync, readSync } from "node:fs";
import process from "node:process";

import {
  canonicalJson,
  canonicalSha256,
  readJson,
  writeCanonicalJson,
} from "./g6-evidence-common.mjs";

const ED25519_PKCS8_SEED_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

function requireCanonicalHash(value, label) {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`G6 ${label} must be a canonical SHA-256 hash`);
  }
}

function requireRestrictedSeedDescriptor(descriptor) {
  if (!Number.isInteger(descriptor) || descriptor < 0) {
    throw new Error("G6 decision key descriptor is required");
  }
  const stat = fstatSync(descriptor, { bigint: true });
  if (
    !stat.isFile() ||
    stat.size !== 32n ||
    (stat.mode & 0o777n) !== 0o600n ||
    (typeof process.getuid === "function" &&
      stat.uid !== BigInt(process.getuid()))
  ) {
    throw new Error(
      "G6 decision key must be an owned regular 32-byte mode-0600 file",
    );
  }
  return stat;
}

function sameSeedDescriptorIdentity(left, right) {
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

function privateKeyFromSeed(seed) {
  const pkcs8 = Buffer.concat([ED25519_PKCS8_SEED_PREFIX, seed]);
  try {
    return createPrivateKey({
      key: pkcs8,
      format: "der",
      type: "pkcs8",
    });
  } finally {
    pkcs8.fill(0);
  }
}

export function deriveG6DecisionPublicKey(seed) {
  if (!Buffer.isBuffer(seed) || seed.byteLength !== 32) {
    throw new Error("G6 Ed25519 seed must be exactly 32 bytes");
  }
  const privateKey = privateKeyFromSeed(seed);
  return createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .toString("base64url");
}

export function buildG6ReleaseControl(input) {
  const seedIdentity = requireRestrictedSeedDescriptor(
    input.privateKeyDescriptor,
  );
  const verification = input.verification;
  requireCanonicalHash(
    verification?.evidence_bundle_hash,
    "evidence bundle",
  );
  if (
    verification?.schema_version !== "1.0.0" ||
    verification.gate !== "G6" ||
    verification.runtime_identity_hash !==
      input.runtimeIdentity.runtime_identity_hash ||
    verification.tested_implementation_digest !==
      input.runtimeIdentity.tested_implementation_digest ||
    verification.eligible !== (verification.state === "pass") ||
    (verification.eligible &&
      verification.first_non_pass !== null) ||
    (!verification.eligible &&
      verification.first_non_pass === null) ||
    verification.decision_recorded !== false ||
    verification.current_control_verified !== false
  ) {
    throw new Error("G6 verification report is not signable");
  }
  const decision = verification.eligible ? "GO" : "NO-GO";
  const secretAdmissionAllowed = verification.eligible;
  const issuedAt = Date.parse(input.issuedAt);
  const expiresAt = Date.parse(input.expiresAt);
  if (
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= issuedAt
  ) {
    throw new Error("G6 release-control lifetime is invalid");
  }
  const fixture = readJson("fixtures/g6/release-control.json");
  const maximumTtlSeconds = fixture.maximum_control_ttl_seconds;
  if ((expiresAt - issuedAt) / 1_000 > maximumTtlSeconds) {
    throw new Error("G6 release-control lifetime exceeds frozen TTL");
  }

  const seed = Buffer.alloc(32);
  const overflow = Buffer.alloc(1);
  let privateKey;
  try {
    const bytesRead = readSync(
      input.privateKeyDescriptor,
      seed,
      0,
      seed.byteLength,
      0,
    );
    const overflowBytes = readSync(
      input.privateKeyDescriptor,
      overflow,
      0,
      overflow.byteLength,
      seed.byteLength,
    );
    const observedIdentity = fstatSync(input.privateKeyDescriptor, {
      bigint: true,
    });
    if (
      bytesRead !== seed.byteLength ||
      overflowBytes !== 0 ||
      !sameSeedDescriptorIdentity(seedIdentity, observedIdentity)
    ) {
      throw new Error("G6 decision key descriptor changed during use");
    }
    privateKey = privateKeyFromSeed(seed);
  } finally {
    seed.fill(0);
    overflow.fill(0);
  }
  const publicKey = createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .toString("base64url");
  const evidenceTag =
    verification.evidence_bundle_hash.slice("sha256:".length);
  const boundControlId = `${input.controlId}:${evidenceTag}`;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(boundControlId) ||
    boundControlId.length > 160
  ) {
    throw new Error("G6 evidence-bound control ID is invalid");
  }
  const controlBase = {
    schema_version: "1.0.0",
    control_id: boundControlId,
    purpose: "g6_release_control",
    decision,
    runtime_identity_hash: input.runtimeIdentity.runtime_identity_hash,
    tested_envelope_digest:
      input.runtimeIdentity.tested_envelope_digest,
    secret_admission_allowed: secretAdmissionAllowed,
    authority_key_id: input.authorityKeyId,
    authority_key_generation: input.authorityKeyGeneration,
    signature_algorithm: "Ed25519",
    issued_at: input.issuedAt,
    expires_at: input.expiresAt,
  };
  const controlHash = canonicalSha256(controlBase);
  const signature = sign(
    null,
    Buffer.from(
      `memo-graph/g6-release-control/v1:${controlHash}`,
      "utf8",
    ),
    privateKey,
  ).toString("base64url");
  const control = {
    ...controlBase,
    control_hash: controlHash,
    signature,
  };
  const trust = {
    schema_version: "1.0.0",
    purpose: "g6_release_control",
    authority_key_id: input.authorityKeyId,
    authority_key_generation: input.authorityKeyGeneration,
    public_key_spki_base64url: publicKey,
    valid_from: input.trustValidFrom ?? input.issuedAt,
    expires_at:
      input.trustExpiresAt ??
      new Date(issuedAt + 365 * 24 * 60 * 60 * 1_000).toISOString(),
    revoked_at: input.revokedAt ?? null,
    maximum_control_ttl_seconds: maximumTtlSeconds,
  };
  return {
    control,
    trust,
    evidence_binding: {
      evidence_bundle_hash: verification.evidence_bundle_hash,
      release_binding_hash: canonicalSha256({
        control_hash: controlHash,
        evidence_bundle_hash: verification.evidence_bundle_hash,
      }),
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const descriptor = Number.parseInt(
    process.env.G6_DECISION_KEY_FD ?? "",
    10,
  );
  const request = JSON.parse(readFileSync(0, "utf8"));
  const expectedRequestKeys = [
    "control_id",
    "expires_at",
    "issued_at",
    "verification_time",
  ];
  if (
    request === null ||
    typeof request !== "object" ||
    canonicalJson(Object.keys(request).sort()) !==
      canonicalJson(expectedRequestKeys)
  ) {
    throw new Error("G6 signer request fields are invalid");
  }
  const authority = readJson("fixtures/g6/decision-authority.json");
  const storedVerification = readJson(
    "docs/evaluations/g6-verification-report.json",
  );
  const { verifyG6Evidence } = await import(
    "./verify-g6-evidence.mjs"
  );
  const verified = await verifyG6Evidence({ write: false });
  if (
    canonicalJson(storedVerification) !==
      canonicalJson(verified.verification)
  ) {
    throw new Error("G6 stored verification report is not canonical");
  }
  const result = buildG6ReleaseControl({
    verification: verified.verification,
    runtimeIdentity: verified.runtimeIdentity,
    controlId: request.control_id,
    issuedAt: request.issued_at,
    expiresAt: request.expires_at,
    privateKeyDescriptor: descriptor,
    authorityKeyId: authority.authority_key_id,
    authorityKeyGeneration: authority.authority_key_generation,
    trustValidFrom: authority.valid_from,
    trustExpiresAt: authority.expires_at,
    revokedAt: authority.revoked_at,
  });
  if (
    result.trust.public_key_spki_base64url !==
    authority.public_key_spki_base64url
  ) {
    throw new Error("G6 decision key does not match pinned authority");
  }
  const artifact = {
    ...result,
    verification_time: request.verification_time,
  };
  writeCanonicalJson(
    "docs/evaluations/g6-release-control.json",
    artifact,
  );
  process.stdout.write(
    `${JSON.stringify({
      control_id: result.control.control_id,
      control_hash: result.control.control_hash,
      release_binding_hash:
        result.evidence_binding.release_binding_hash,
    })}\n`,
  );
}
