import { describe, expect, it } from "vitest";

import {
  G6ReleaseControlSchema,
  RuntimeIdentitySchema,
  canonicalSha256,
  canonicalSha256Omitting,
} from "../../packages/contracts/src/index.js";

const HASH_A = `sha256:${"a".repeat(64)}` as const;
const HASH_B = `sha256:${"b".repeat(64)}` as const;

describe("G6 release control contract", () => {
  it("keeps secret admission default-off and binds an exact runtime identity", () => {
    const runtime = RuntimeIdentitySchema.parse({
      schema_version: "1.0.0",
      tested_implementation_digest: HASH_A,
      tested_envelope_digest: HASH_B,
      dependency_lock_digest: HASH_B,
      migration_set_digest: HASH_A,
      platform: {
        node: "24.18.0",
        os: "darwin",
        architecture: "arm64",
        sqlite: "3.50.4",
        filesystem: "apfs",
      },
      configuration_digest: HASH_B,
      runtime_identity_hash: canonicalSha256({
        schema_version: "1.0.0",
        tested_implementation_digest: HASH_A,
        tested_envelope_digest: HASH_B,
        dependency_lock_digest: HASH_B,
        migration_set_digest: HASH_A,
        platform: {
          node: "24.18.0",
          os: "darwin",
          architecture: "arm64",
          sqlite: "3.50.4",
          filesystem: "apfs",
        },
        configuration_digest: HASH_B,
      }),
    });
    const base = {
      schema_version: "1.0.0",
      control_id: "g6-control:test",
      purpose: "g6_release_control" as const,
      decision: "NO-GO" as const,
      runtime_identity_hash: runtime.runtime_identity_hash,
      tested_envelope_digest: HASH_A,
      secret_admission_allowed: false,
      authority_key_id: "g6-authority:test",
      authority_key_generation: 1,
      signature_algorithm: "Ed25519",
      issued_at: "2026-07-30T00:00:00.000Z",
      expires_at: "2026-08-30T00:00:00.000Z",
      control_hash: HASH_B,
      signature: Buffer.alloc(64, 0x33).toString("base64url"),
    };
    const control = {
      ...base,
      control_hash: canonicalSha256Omitting(base, [
        "control_hash",
        "signature",
      ]),
    };
    expect(G6ReleaseControlSchema.parse(control)).toMatchObject({
      decision: "NO-GO",
      secret_admission_allowed: false,
    });
    expect(() =>
      G6ReleaseControlSchema.parse({
        ...control,
        secret_admission_allowed: true,
      }),
    ).toThrow();
  });
});
