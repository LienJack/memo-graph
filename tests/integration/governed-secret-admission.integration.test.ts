import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  CanonicalHashSchema,
  G6ReleaseControlSchema,
  G6ReleaseControlTrustSchema,
  IdentifierSchema,
  MemoryEpisodeCommitInputSchema,
  MemoryProposeInputSchema,
  MemoryToolNameSchema,
  RuntimeIdentitySchema,
  SecretAdmissionApprovalSchema,
  SecretAdmissionTrustSchema,
  SecretContentOwnerSchema,
  ScopeSchema,
  UtcTimestampSchema,
  canonicalSha256,
  canonicalSha256Omitting,
  g6ReleaseControlSigningPayload,
  secretAdmissionApprovalSigningPayload,
  secretAdmissionEnvelopeRequestBindingHash,
  type G6ReleaseControl,
  type SecretAdmissionApproval,
} from "../../packages/contracts/src/index.js";
import {
  verifyG6ReleaseControl,
} from "../../packages/memory-kernel/src/approval.js";
import { approveSecretAdmission } from "../../apps/operator-cli/src/secret-admission-authority.js";
import { MemoryRuntime } from "../../packages/memory-kernel/src/index.js";
import {
  SqliteStorageClient,
  restoreBackupToEmptyDataRoot,
  type SqliteStorageClientOptions,
} from "@memo-graph/storage-sqlite";
import { prepareDataRoot } from "../../packages/storage-sqlite/src/data-root.js";
import { StorageDatabase } from "../../packages/storage-sqlite/src/database.js";
import { memoryCandidate } from "../helpers/governance-examples.js";
import { testRecoveryHeadProvider } from "../helpers/recovery.js";
import { inlineEpisode } from "../helpers/storage-examples.js";

const HASH_A = CanonicalHashSchema.parse(`sha256:${"a".repeat(64)}`);
const HASH_B = CanonicalHashSchema.parse(`sha256:${"b".repeat(64)}`);
const cleanupPaths: string[] = [];
const openDescriptors: number[] = [];

function temporaryRoot(prefix: string): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-graph-${prefix}-`)),
  );
  cleanupPaths.push(root);
  return root;
}

function privateDescriptor(
  root: string,
  name: string,
  bytes: Uint8Array,
): number {
  const path = join(root, name);
  writeFileSync(path, bytes, { mode: 0o600 });
  const descriptor = openSync(path, "r");
  openDescriptors.push(descriptor);
  return descriptor;
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

function reissueApproval(
  approval: SecretAdmissionApproval,
  changes: Partial<SecretAdmissionApproval>,
  privateKey: ReturnType<typeof rawPrivateKey>,
): SecretAdmissionApproval {
  const unsigned = {
    ...approval,
    ...changes,
    approval_hash: HASH_A,
    signature: Buffer.alloc(64).toString("base64url"),
  };
  const approvalHash = CanonicalHashSchema.parse(
    canonicalSha256Omitting(unsigned, ["approval_hash", "signature"]),
  );
  return SecretAdmissionApprovalSchema.parse({
    ...unsigned,
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
}

function secretEffectCounts(dataRoot: string) {
  const database = new DatabaseSync(join(dataRoot, "ledger", "memory.db"), {
    readOnly: true,
  });
  try {
    const count = (sql: string): number =>
      Number(
        (
          database.prepare(sql).get() as {
            count: number;
          }
        ).count,
      );
    return {
      ledger_epoch: Number(
        (
          database
            .prepare(
              "SELECT ledger_epoch FROM ledger_state WHERE singleton = 1",
            )
            .get() as { ledger_epoch: number }
        ).ledger_epoch,
      ),
      nonce_reservations: count(
        "SELECT count(*) AS count FROM secret_nonce_reservations",
      ),
      encrypted_contents: count(
        "SELECT count(*) AS count FROM encrypted_contents",
      ),
      encrypted_owners: count(
        "SELECT count(*) AS count FROM encrypted_content_owners",
      ),
      admission_receipts: count(
        `SELECT count(*) AS count FROM operational_receipts
         WHERE operation_kind = 'secret_admit'`,
      ),
      approval_consumptions: count(
        `SELECT count(*) AS count FROM secret_authority_consumptions
         WHERE authority_kind = 'admission'`,
      ),
      release_controls: count(
        "SELECT count(*) AS count FROM g6_release_controls",
      ),
    };
  } finally {
    database.close();
  }
}

function expectMarkerAbsent(root: string, marker: string): void {
  const visit = (path: string): void => {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) {
        visit(join(path, entry));
      }
      return;
    }
    expect(
      readFileSync(path).includes(Buffer.from(marker, "utf8")),
      `plaintext marker leaked into ${path}`,
    ).toBe(false);
  };
  visit(root);
}

afterEach(() => {
  while (openDescriptors.length > 0) {
    const descriptor = openDescriptors.pop();
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path !== undefined) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe("governed secret admission", () => {
  it("rejects MCP secret plaintext proposal shapes and exposes no admission tool", () => {
    const episode = inlineEpisode({
      episodeId: "episode_u9_secret_transport",
      evidenceId: "evidence_u9_secret_transport",
      idempotencyKey: "commit:u9:secret-transport",
      text: "U9_SECRET_TRANSPORT_MARKER",
    });
    const secretEvidence = episode.evidence.map((evidence) => ({
      ...evidence,
      sensitivity: "secret" as const,
    }));
    const envelope = {
      schema_version: "1.0.0",
      request_id: "request_u9_secret_transport",
      tool: "memory_episode_commit" as const,
      actor_claim: {
        principal_id: "user_local",
        authority: "user_stated" as const,
      },
      scopes: [{ kind: "workspace" as const, id: "workspace_local" }],
      purpose: "prove the MCP plaintext boundary",
      reason: "U9 must keep the sole plaintext ingress in operator CLI",
      requested_at: "2026-07-30T07:30:00.000Z",
      safety_class: "proposal" as const,
      idempotency_key: episode.idempotencyKey,
    };
    expect(
      MemoryEpisodeCommitInputSchema.safeParse({
        envelope,
        episode: episode.episode,
        evidence: secretEvidence,
        blobs: [],
      }).success,
    ).toBe(false);
    expect(
      MemoryProposeInputSchema.safeParse({
        envelope: {
          ...envelope,
          request_id: "request_u9_secret_propose",
          tool: "memory_propose",
          idempotency_key: "memory-propose:u9-secret",
        },
        candidate: memoryCandidate({
          candidateId: "candidate:u9-secret",
          sensitivity: "secret",
          evidenceIds: ["evidence:encrypted-u9"],
          text: "U9_SECRET_CANDIDATE_MARKER",
        }),
      }).success,
    ).toBe(false);
    expect(
      MemoryToolNameSchema.options.some((name) =>
        /secret|admi(?:t|ssion)/u.test(name),
      ),
    ).toBe(false);
  });

  it("fails closed for invalid, non-private, non-regular, unreadable, and closed descriptors", () => {
    const descriptorRoot = temporaryRoot("governed-secret-invalid-fd");
    const signingSeed = Buffer.alloc(32, 0x61);
    const commitmentKey = Buffer.alloc(32, 0x62);
    const signingDescriptor = privateDescriptor(
      descriptorRoot,
      "signing.bin",
      signingSeed,
    );
    const commitmentDescriptor = privateDescriptor(
      descriptorRoot,
      "commitment.bin",
      commitmentKey,
    );
    const trust = SecretAdmissionTrustSchema.parse({
      schema_version: "1.0.0",
      purpose: "secret_admission" as const,
      authority_key_id: "secret-admission-authority:descriptor-test",
      authority_key_generation: 1,
      public_key_spki_base64url: createPublicKey(rawPrivateKey(signingSeed))
        .export({ format: "der", type: "spki" })
        .toString("base64url"),
      valid_from: "2026-07-29T00:00:00.000Z",
      expires_at: "2026-08-01T00:00:00.000Z",
      revoked_at: null,
      maximum_approval_ttl_seconds: 3_600,
      commitment_key_id: "secret-admission-commitment:descriptor-test",
      commitment_key_verification_tag:
        `hmac-sha256:${createHmac("sha256", commitmentKey)
          .update(
            "memo-graph/secret-admission-commitment-key-verification/v1",
            "utf8",
          )
          .digest("base64url")}`,
    });
    const publicPath = join(descriptorRoot, "public.txt");
    writeFileSync(publicPath, "public", { mode: 0o600 });
    chmodSync(publicPath, 0o644);
    const publicDescriptor = openSync(publicPath, "r");
    openDescriptors.push(publicDescriptor);
    const writeOnlyPath = join(descriptorRoot, "write-only.txt");
    writeFileSync(writeOnlyPath, "write-only", { mode: 0o600 });
    const writeOnlyDescriptor = openSync(
      writeOnlyPath,
      constants.O_WRONLY,
    );
    openDescriptors.push(writeOnlyDescriptor);
    const directoryDescriptor = openSync(descriptorRoot, "r");
    openDescriptors.push(directoryDescriptor);
    const deviceDescriptor = openSync("/dev/null", "r");
    openDescriptors.push(deviceDescriptor);
    const closedDescriptor = privateDescriptor(
      descriptorRoot,
      "closed.txt",
      Buffer.from("closed", "utf8"),
    );
    expect(openDescriptors.pop()).toBe(closedDescriptor);
    closeSync(closedDescriptor);
    const invalidDescriptors = [
      privateDescriptor(descriptorRoot, "empty.txt", Buffer.alloc(0)),
      privateDescriptor(
        descriptorRoot,
        "oversized.txt",
        Buffer.alloc(256_001, 0x63),
      ),
      publicDescriptor,
      writeOnlyDescriptor,
      directoryDescriptor,
      deviceDescriptor,
      closedDescriptor,
    ];
    for (const inputDescriptor of invalidDescriptors) {
      expect(() =>
        approveSecretAdmission({
          inputDescriptor,
          signingKeyDescriptor: signingDescriptor,
          commitmentKeyDescriptor: commitmentDescriptor,
          trust,
          binding: {
            schema_version: "1.0.0",
            principal_id: "principal:descriptor-test",
            purpose: "secret_admission",
            sensitivity: "secret",
            envelope_version: 1,
            request_nonce: "request-nonce:descriptor-test",
            owner: {
              kind: "evidence",
              id: "evidence:descriptor-test",
              generation: 1,
            },
            scope: {
              kind: "workspace",
              id: "workspace:descriptor-test",
            },
            request_digest: HASH_A,
            envelope_aad_hash: HASH_B,
            key_id: "key:descriptor-test",
            key_generation: 1,
            authority_key_id: trust.authority_key_id,
            authority_key_generation: 1,
            signature_algorithm: "Ed25519",
            root_fence_token: 1,
            issued_at: "2026-07-30T07:00:00.000Z",
            expires_at: "2026-07-30T08:00:00.000Z",
          },
        }),
      ).toThrow();
    }
  });

  it("accepts only a purpose-bound exact-runtime synthetic G6 GO control", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const trust = G6ReleaseControlTrustSchema.parse({
      schema_version: "1.0.0",
      purpose: "g6_release_control" as const,
      authority_key_id: "g6-authority:synthetic-u9",
      authority_key_generation: 1,
      public_key_spki_base64url: publicKey
        .export({ format: "der", type: "spki" })
        .toString("base64url"),
      valid_from: "2026-07-29T00:00:00.000Z",
      expires_at: "2026-08-01T00:00:00.000Z",
      revoked_at: null,
      maximum_control_ttl_seconds: 600,
    });
    const identityBase = {
      schema_version: "1.0.0",
      tested_implementation_digest: HASH_A,
      tested_envelope_digest: HASH_B,
      dependency_lock_digest: HASH_A,
      migration_set_digest: HASH_B,
      platform: {
        node: "24.18.0",
        os: "darwin",
        architecture: "arm64",
        sqlite: "3.50.4",
        filesystem: "apfs",
      },
      configuration_digest: HASH_A,
      decision_authority_hash: canonicalSha256(trust),
    };
    const identity = RuntimeIdentitySchema.parse({
      ...identityBase,
      runtime_identity_hash: canonicalSha256(identityBase),
    });
    const controlBase = {
      schema_version: "1.0.0",
      control_id: "g6-control:synthetic-u9",
      purpose: "g6_release_control" as const,
      decision: "GO" as const,
      runtime_identity_hash: identity.runtime_identity_hash,
      tested_envelope_digest: identity.tested_envelope_digest,
      secret_admission_allowed: true,
      authority_key_id: "g6-authority:synthetic-u9",
      authority_key_generation: 1,
      signature_algorithm: "Ed25519" as const,
      issued_at: "2026-07-30T00:00:00.000Z",
      expires_at: "2026-07-30T00:05:00.000Z",
    };
    const unsigned = {
      ...controlBase,
      control_hash: canonicalSha256(controlBase),
      signature: Buffer.alloc(64).toString("base64url"),
    };
    const control = G6ReleaseControlSchema.parse({
      ...unsigned,
      control_hash: canonicalSha256Omitting(unsigned, [
        "control_hash",
        "signature",
      ]),
      signature: sign(
        null,
        Buffer.from(
          g6ReleaseControlSigningPayload({
            control_hash: CanonicalHashSchema.parse(
              unsigned.control_hash,
            ),
          }),
          "utf8",
        ),
        privateKey,
      ).toString("base64url"),
    });
    await expect(
      verifyG6ReleaseControl({
        control,
        trust,
        runtimeIdentityProvider: { current: async () => identity },
        now: "2026-07-30T00:01:00.000Z",
      }),
    ).resolves.toEqual(control);
    await expect(
      verifyG6ReleaseControl({
        control: { ...control, signature: Buffer.alloc(64).toString("base64url") },
        trust,
        runtimeIdentityProvider: { current: async () => identity },
        now: "2026-07-30T00:01:00.000Z",
      }),
    ).rejects.toThrow();
  });

  it("atomically binds a synthetic GO control, approval consumption, ciphertext, receipt, and recovery frontier", async () => {
    const dataRoot = temporaryRoot("governed-secret");
    const descriptorRoot = temporaryRoot("governed-secret-descriptors");
    const keyDescriptor = privateDescriptor(
      descriptorRoot,
      "data-key.bin",
      Buffer.alloc(32, 0x21),
    );
    const dataAuthorityDescriptor = privateDescriptor(
      descriptorRoot,
      "data-authority.bin",
      Buffer.alloc(32, 0x22),
    );
    const dataCommitmentDescriptor = privateDescriptor(
      descriptorRoot,
      "data-commitment.bin",
      Buffer.alloc(32, 0x23),
    );
    const admissionSigningSeed = Buffer.alloc(32, 0x24);
    const admissionSigningDescriptor = privateDescriptor(
      descriptorRoot,
      "admission-signing.bin",
      admissionSigningSeed,
    );
    const admissionCommitment = Buffer.alloc(32, 0x25);
    const admissionCommitmentDescriptor = privateDescriptor(
      descriptorRoot,
      "admission-commitment.bin",
      admissionCommitment,
    );
    const secretMarker = "u9-governed-secret-marker-884201";
    const secretDescriptor = privateDescriptor(
      descriptorRoot,
      "secret.txt",
      Buffer.from(secretMarker, "utf8"),
    );
    const pinnedFixture = JSON.parse(
      readFileSync(
        join(
          process.cwd(),
          "tests/fixtures/g6-pinned-secret-admission.json",
        ),
        "utf8",
      ),
    ) as {
      runtime_identity: unknown;
      release_artifact: { control: unknown; trust: unknown };
    };
    const releaseTrust = G6ReleaseControlTrustSchema.parse(
      pinnedFixture.release_artifact.trust,
    );
    const identity = RuntimeIdentitySchema.parse(
      pinnedFixture.runtime_identity,
    );
    const control = G6ReleaseControlSchema.parse(
      pinnedFixture.release_artifact.control,
    );
    const admissionPrivateKey = rawPrivateKey(admissionSigningSeed);
    const admissionTrust = SecretAdmissionTrustSchema.parse({
      schema_version: "1.0.0",
      purpose: "secret_admission" as const,
      authority_key_id: "secret-admission-authority:u9",
      authority_key_generation: 1,
      public_key_spki_base64url: createPublicKey(admissionPrivateKey)
        .export({ format: "der", type: "spki" })
        .toString("base64url"),
      valid_from: "2026-07-29T00:00:00.000Z",
      expires_at: "2026-08-01T00:00:00.000Z",
      revoked_at: null,
      maximum_approval_ttl_seconds: 3_600,
      commitment_key_id: "secret-admission-commitment:u9",
      commitment_key_verification_tag:
        `hmac-sha256:${createHmac("sha256", admissionCommitment)
          .update(
            "memo-graph/secret-admission-commitment-key-verification/v1",
            "utf8",
          )
          .digest("base64url")}`,
    });
    const recovery = testRecoveryHeadProvider(
      "recovery_authority:governed-secret-u9",
    );
    const bootstrap = await SqliteStorageClient.open({
      dataRoot,
      testOperations: true,
      secretPrincipalId: "principal:u9",
      recoveryHeadProvider: recovery,
    });
    await bootstrap.darkLaunchInstallEncryptionKey({
      idempotency_key: "install-governed-u9-key-001",
      key_id: "key:governed-u9:1",
      key_generation: 1,
      key_descriptor: keyDescriptor,
      authority_key_id: "data-authority:governed-u9:1",
      authority_descriptor: dataAuthorityDescriptor,
      commitment_key_id: "data-commitment:governed-u9:1",
      commitment_descriptor: dataCommitmentDescriptor,
    });
    await bootstrap.close();
    const providerMetadataDatabase = new DatabaseSync(
      join(dataRoot, "ledger", "memory.db"),
      { readOnly: true },
    );
    const providerMetadata = providerMetadataDatabase
      .prepare(
        `SELECT verification_tag, authority_public_key_base64url
         FROM encryption_keys WHERE key_id = ?`,
      )
      .get("key:governed-u9:1") as {
      verification_tag: string;
      authority_public_key_base64url: string;
    };
    providerMetadataDatabase.close();
    const providerVerifier = new StorageDatabase({
      layout: prepareDataRoot(dataRoot),
      migrationsDir: join(process.cwd(), "migrations"),
      busyTimeoutMs: 5_000,
      testOperations: true,
      secretPrincipalId: "principal:u9",
    });
    expect(() =>
      providerVerifier.verifyEncryptionKey({
        key_id: "key:governed-u9:1",
        key_generation: 1,
        verification_tag: providerMetadata.verification_tag,
        forbidden_authority_public_keys: [
          providerMetadata.authority_public_key_base64url,
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "KEY_PROVIDER_INVALID" }));
    expect(
      providerVerifier.verifyEncryptionKey({
        key_id: "key:governed-u9:1",
        key_generation: 1,
        verification_tag: providerMetadata.verification_tag,
        forbidden_authority_public_keys: [
          admissionTrust.public_key_spki_base64url,
          releaseTrust.public_key_spki_base64url,
        ],
      }),
    ).toBeNull();
    providerVerifier.close();
    let currentRuntimeIdentity = identity;
    const secretAdmission: NonNullable<
      SqliteStorageClientOptions["secretAdmission"]
    > = {
      enabled: true,
      approvalTrust: admissionTrust,
      approvalCommitmentDescriptor: admissionCommitmentDescriptor,
      encryptionProvider: {
        key_id: "key:governed-u9:1",
        key_generation: 1,
        key_descriptor: keyDescriptor,
        commitment_key_id: "data-commitment:governed-u9:1",
        commitment_descriptor: dataCommitmentDescriptor,
      },
      releaseControl: control,
      releaseTrust,
      runtimeIdentityProvider: {
        current: async () => currentRuntimeIdentity,
      },
      now: () => "2026-07-30T07:30:00.000Z",
    };
    let admissionMode:
      | "normal"
      | "pressure"
      | "maintenance_at_transaction" = "normal";
    let admissionStage = 0;
    const storage = await SqliteStorageClient.open({
      dataRoot,
      secretPrincipalId: "principal:u9",
      recoveryHeadProvider: recovery,
      secretAdmission,
      admission: {
        policy: {
          max_queue_depth: 4,
          max_queue_age_ms: 1_000,
          min_available_bytes_enter: 100,
          min_available_bytes_recover: 200,
          max_wal_bytes_enter: 1_000_000,
          max_wal_bytes_recover: 100_000,
        },
        observe: () => {
          admissionStage += 1;
          return {
            available_bytes: admissionMode === "pressure" ? 50 : 1_000,
            wal_bytes: 0,
            checkpoint_healthy: true,
            active_maintenance:
              admissionMode === "maintenance_at_transaction" &&
              admissionStage >= 2
                ? "backup"
                : null,
          };
        },
      },
    });
    const owner = SecretContentOwnerSchema.parse({
      kind: "evidence",
      id: "evidence:governed-u9:1",
      generation: 1,
    });
    const scope = ScopeSchema.parse({
      kind: "workspace",
      id: "workspace:u9",
    });
    const requestNonce = IdentifierSchema.parse(
      "request-nonce:governed-u9-001",
    );
    const requestDigest = CanonicalHashSchema.parse(
      canonicalSha256({
        schema_version: "1.0.0",
        purpose: "secret_admission",
        sensitivity: "secret",
        envelope_version: 1,
        idempotency_key: "governed-admit-u9-001",
        principal_id: "principal:u9",
        owner,
        scope,
        content_identity: "content:governed-u9:1",
        media_type: "text/plain",
        request_nonce: requestNonce,
      }),
    );
    const rootFence = (await storage.health()).root_lease?.fence_token;
    expect(rootFence).toBeTypeOf("number");
    const approval = approveSecretAdmission({
      inputDescriptor: secretDescriptor,
      signingKeyDescriptor: admissionSigningDescriptor,
      commitmentKeyDescriptor: admissionCommitmentDescriptor,
      trust: admissionTrust,
      binding: {
        schema_version: "1.0.0",
        principal_id: "principal:u9",
        purpose: "secret_admission",
        sensitivity: "secret",
        envelope_version: 1,
        request_nonce: requestNonce,
        owner,
        scope,
        request_digest: requestDigest,
        envelope_aad_hash: secretAdmissionEnvelopeRequestBindingHash({
          key_id: "key:governed-u9:1",
          key_generation: 1,
          owner,
          scope,
          content_identity: "content:governed-u9:1",
          content_class: "evidence",
          media_type: "text/plain",
        }),
        key_id: "key:governed-u9:1",
        key_generation: 1,
        authority_key_id: admissionTrust.authority_key_id,
        authority_key_generation: 1,
        signature_algorithm: "Ed25519",
        root_fence_token: rootFence as number,
        issued_at: "2026-07-30T07:00:00.000Z",
        expires_at: "2026-07-30T08:00:00.000Z",
      },
    });
    const {
      approval_id: _approvalId,
      descriptor_identity_hash: _descriptorIdentityHash,
      descriptor_commitment: _descriptorCommitment,
      approval_hash: _approvalHash,
      signature: _signature,
      ...approvalBinding
    } = approval;
    void _approvalId;
    void _descriptorIdentityHash;
    void _descriptorCommitment;
    void _approvalHash;
    void _signature;
    const governedInput = {
      idempotency_key: "governed-admit-u9-001",
      request_digest: requestDigest,
      principal_id: "principal:u9",
      owner,
      scope,
      content_identity: "content:governed-u9:1",
      media_type: "text/plain",
      input_descriptor: secretDescriptor,
      approval,
    };
    const baselineEffects = secretEffectCounts(dataRoot);
    const trustFailureRoot = temporaryRoot(
      "governed-secret-trust-failures",
    );
    const trustFailureRecovery = testRecoveryHeadProvider(
      "recovery_authority:governed-secret-trust-failures",
    );
    const trustFailureBootstrap = await SqliteStorageClient.open({
      dataRoot: trustFailureRoot,
      testOperations: true,
      secretPrincipalId: "principal:u9",
      recoveryHeadProvider: trustFailureRecovery,
    });
    await trustFailureBootstrap.darkLaunchInstallEncryptionKey({
      idempotency_key: "install-governed-u9-trust-failure-key-001",
      key_id: "key:governed-u9:1",
      key_generation: 1,
      key_descriptor: keyDescriptor,
      authority_key_id: "data-authority:governed-u9:1",
      authority_descriptor: dataAuthorityDescriptor,
      commitment_key_id: "data-commitment:governed-u9:1",
      commitment_descriptor: dataCommitmentDescriptor,
    });
    await trustFailureBootstrap.close();
    const trustFailureBaseline = secretEffectCounts(trustFailureRoot);
    const expectTrustFailure = async (input: {
      trust: typeof admissionTrust;
      issuedAt: string;
      expiresAt: string;
    }) => {
      const blocked = await SqliteStorageClient.open({
        dataRoot: trustFailureRoot,
        secretPrincipalId: "principal:u9",
        recoveryHeadProvider: trustFailureRecovery,
        secretAdmission: {
          ...secretAdmission,
          approvalTrust: input.trust,
        },
      });
      try {
        const blockedFence = (await blocked.health()).root_lease?.fence_token;
        expect(blockedFence).toBeTypeOf("number");
        const blockedApproval = approveSecretAdmission({
          inputDescriptor: secretDescriptor,
          signingKeyDescriptor: admissionSigningDescriptor,
          commitmentKeyDescriptor: admissionCommitmentDescriptor,
          trust: input.trust,
          binding: {
            ...approvalBinding,
            authority_key_id: input.trust.authority_key_id,
            authority_key_generation:
              input.trust.authority_key_generation,
            root_fence_token: blockedFence as number,
            issued_at: input.issuedAt,
            expires_at: input.expiresAt,
          },
        });
        await expect(
          blocked.governedAdmitSecret({
            ...governedInput,
            approval: blockedApproval,
          }),
        ).rejects.toThrow();
      } finally {
        await blocked.close();
      }
      expect(secretEffectCounts(trustFailureRoot)).toEqual(
        trustFailureBaseline,
      );
    };
    await expectTrustFailure({
      trust: SecretAdmissionTrustSchema.parse({
        ...admissionTrust,
        revoked_at: "2026-07-30T07:15:00.000Z",
      }),
      issuedAt: "2026-07-30T07:00:00.000Z",
      expiresAt: "2026-07-30T08:00:00.000Z",
    });
    await expectTrustFailure({
      trust: SecretAdmissionTrustSchema.parse({
        ...admissionTrust,
        valid_from: "2026-07-29T00:00:00.000Z",
        expires_at: "2026-07-30T07:00:00.000Z",
      }),
      issuedAt: "2026-07-30T06:00:00.000Z",
      expiresAt: "2026-07-30T06:30:00.000Z",
    });

    secretAdmission.releaseControl = null;
    await expect(
      storage.governedAdmitSecret(governedInput),
    ).rejects.toMatchObject({ code: "ENCRYPTION_REQUIRED" });
    secretAdmission.releaseControl = {} as G6ReleaseControl;
    await expect(
      storage.governedAdmitSecret(governedInput),
    ).rejects.toMatchObject({ code: "ENCRYPTION_REQUIRED" });
    secretAdmission.releaseControl = {
      ...control,
      control_id: IdentifierSchema.parse(
        "g6-control:synthetic-u9-no-go",
      ),
      decision: "NO-GO",
      secret_admission_allowed: false,
    };
    await expect(
      storage.governedAdmitSecret(governedInput),
    ).rejects.toMatchObject({ code: "ENCRYPTION_REQUIRED" });
    secretAdmission.releaseControl = {
      ...control,
      secret_admission_allowed: false,
    } as G6ReleaseControl;
    await expect(
      storage.governedAdmitSecret(governedInput),
    ).rejects.toMatchObject({ code: "ENCRYPTION_REQUIRED" });
    secretAdmission.releaseControl = {
      ...control,
      signature: Buffer.alloc(64).toString("base64url"),
    };
    await expect(
      storage.governedAdmitSecret(governedInput),
    ).rejects.toMatchObject({ code: "ENCRYPTION_REQUIRED" });
    secretAdmission.releaseControl = control;
    secretAdmission.releaseTrust = {
      ...releaseTrust,
      public_key_spki_base64url:
        admissionTrust.public_key_spki_base64url,
    };
    await expect(
      storage.governedAdmitSecret(governedInput),
    ).rejects.toMatchObject({ code: "ENCRYPTION_REQUIRED" });
    secretAdmission.releaseTrust = releaseTrust;
    const {
      runtime_identity_hash: _runtimeIdentityHash,
      ...runtimeIdentityBase
    } = identity;
    void _runtimeIdentityHash;
    const driftedRuntimeBase = {
      ...runtimeIdentityBase,
      configuration_digest: HASH_B,
    };
    currentRuntimeIdentity = RuntimeIdentitySchema.parse({
      ...driftedRuntimeBase,
      runtime_identity_hash: canonicalSha256(driftedRuntimeBase),
    });
    await expect(
      storage.governedAdmitSecret(governedInput),
    ).rejects.toMatchObject({ code: "ENCRYPTION_REQUIRED" });
    currentRuntimeIdentity = identity;

    const approvalMutations: Array<
      [string, Partial<SecretAdmissionApproval>]
    > = [
      [
        "stale",
        {
          expires_at: UtcTimestampSchema.parse(
            "2026-07-30T07:20:00.000Z",
          ),
        },
      ],
      [
        "principal",
        { principal_id: IdentifierSchema.parse("principal:other") },
      ],
      [
        "owner",
        {
          owner: SecretContentOwnerSchema.parse({
            kind: "evidence",
            id: "evidence:governed-u9:other",
            generation: 1,
          }),
        },
      ],
      [
        "scope",
        {
          scope: ScopeSchema.parse({
            kind: "workspace",
            id: "workspace:other",
          }),
        },
      ],
      ["request", { request_digest: HASH_B }],
      ["envelope", { envelope_aad_hash: HASH_A }],
      [
        "key",
        { key_id: IdentifierSchema.parse("key:governed-u9:other") },
      ],
      ["key-generation", { key_generation: 2 }],
      ["fence", { root_fence_token: (rootFence as number) + 1 }],
      ["descriptor-stat", { descriptor_identity_hash: HASH_A }],
      [
        "descriptor-hmac",
        {
          descriptor_commitment:
            `hmac-sha256:${Buffer.alloc(32, 0x55).toString("base64url")}`,
        },
      ],
      [
        "authority",
        {
          authority_key_id: IdentifierSchema.parse(
            "secret-admission-authority:unknown",
          ),
        },
      ],
      ["authority-generation", { authority_key_generation: 2 }],
    ];
    for (const [_name, mutation] of approvalMutations) {
      void _name;
      await expect(
        storage.governedAdmitSecret({
          ...governedInput,
          approval: reissueApproval(
            approval,
            mutation,
            admissionPrivateKey,
          ),
        }),
      ).rejects.toThrow();
    }
    await expect(
      storage.governedAdmitSecret({
        ...governedInput,
        approval: reissueApproval(
          approval,
          {},
          rawPrivateKey(Buffer.alloc(32, 0x77)),
        ),
      }),
    ).rejects.toThrow();
    await expect(
      storage.governedAdmitSecret({
        ...governedInput,
        approval: undefined as never,
      }),
    ).rejects.toThrow();
    await expect(
      storage.governedAdmitSecret({
        ...governedInput,
        approval: {
          ...approval,
          purpose: "rotation",
        } as unknown as SecretAdmissionApproval,
      }),
    ).rejects.toThrow();

    admissionMode = "pressure";
    admissionStage = 0;
    await expect(
      storage.governedAdmitSecret(governedInput),
    ).rejects.toMatchObject({ code: "RESOURCE_PRESSURE" });
    admissionMode = "maintenance_at_transaction";
    admissionStage = 0;
    await expect(
      storage.governedAdmitSecret(governedInput),
    ).rejects.toMatchObject({ code: "MAINTENANCE_BLOCKED" });
    admissionMode = "normal";
    admissionStage = 0;
    expect(secretEffectCounts(dataRoot)).toEqual(baselineEffects);

    await expect(
      storage.governedAdmitSecret({
        ...governedInput,
        idempotency_key: "governed-admit-u9-changed",
      }),
    ).rejects.toMatchObject({ code: "AUTHORITY_REPLAY" });

    writeFileSync(
      join(descriptorRoot, "secret.txt"),
      Buffer.from("mutated-after-approval", "utf8"),
      { mode: 0o600 },
    );
    await expect(
      storage.governedAdmitSecret(governedInput),
    ).rejects.toMatchObject({ code: "AUTHORITY_REPLAY" });

    const replacementSecretDescriptor = privateDescriptor(
      descriptorRoot,
      "replacement-secret.txt",
      Buffer.from(secretMarker, "utf8"),
    );
    await expect(
      storage.governedAdmitSecret({
        ...governedInput,
        input_descriptor: replacementSecretDescriptor,
      }),
    ).rejects.toMatchObject({ code: "AUTHORITY_REPLAY" });
    const replacementApproval = approveSecretAdmission({
      inputDescriptor: replacementSecretDescriptor,
      signingKeyDescriptor: admissionSigningDescriptor,
      commitmentKeyDescriptor: admissionCommitmentDescriptor,
      trust: admissionTrust,
      binding: approvalBinding,
    });
    const receipt = await storage.governedAdmitSecret({
      ...governedInput,
      input_descriptor: replacementSecretDescriptor,
      approval: replacementApproval,
    });
    await expect(
      storage.governedAdmitSecret({
        ...governedInput,
        input_descriptor: replacementSecretDescriptor,
        approval: replacementApproval,
      }),
    ).resolves.toEqual(receipt);
    await expect(
      storage.getEvidence({
        evidence_id: owner.id,
        principal_id: "principal:u9",
        scope,
      }),
    ).resolves.toBeNull();
    await expect(
      storage.explainEvidence({
        evidence_id: owner.id,
        principal_id: "principal:u9",
        scope,
      }),
    ).resolves.toBeNull();
    await expect(
      storage.searchEvidence({
        query: secretMarker,
        principal_id: "principal:u9",
        scope,
        limit: 20,
      }),
    ).resolves.toMatchObject({ status: "NO_MATCH", items: [] });
    await expect(
      storage.traverseRelations({
        principal_id: "principal:u9",
        scope,
        start_revision_ids: [owner.id],
        direction: "both",
        max_depth: 4,
        max_fanout: 100,
        as_of: "2026-07-30T07:30:00.000Z",
      }),
    ).resolves.toMatchObject({ hits: [] });
    const runtime = new MemoryRuntime({
      storage,
      clock: () => "2026-07-30T07:30:00.000Z",
      policy: {
        principal: {
          principal_id: "principal:u9",
          allowed_scopes: [scope],
          allowed_authorities: ["user_stated"],
          destructive_tools_enabled: false,
        },
        default_token_budget: 1_800,
      },
    });
    const compiled = await runtime.memoryContextCompile({
      envelope: {
        schema_version: "1.0.0",
        request_id: "request_u9_secret_context",
        tool: "memory_context_compile",
        actor_claim: {
          principal_id: "principal:u9",
          authority: "user_stated",
        },
        scopes: [scope],
        purpose: "prove secret content exclusion",
        reason: "U9 encrypted evidence must never enter Context",
        requested_at: "2026-07-30T07:30:00.000Z",
        safety_class: "read_only",
      },
      recall: {
        schema_version: "1.0.0",
        request_id: "request_u9_secret_context",
        goal: "recover the governed secret",
        query: "governed encrypted evidence",
        scopes: [scope],
        as_of: "2026-07-30T07:30:00.000Z",
        token_budget: 1_800,
        include_sensitive: true,
      },
    });
    expect(compiled.status).toBe("NO_MATCH");
    expect(JSON.stringify(compiled)).not.toContain(
      secretMarker,
    );
    secretAdmission.enabled = false;
    await expect(
      storage.governedAdmitSecret({
        ...governedInput,
        input_descriptor: replacementSecretDescriptor,
        approval: replacementApproval,
      }),
    ).rejects.toMatchObject({ code: "ENCRYPTION_REQUIRED" });
    const backup = await storage.createBackup();
    expect(backup.manifest.frontiers.g6_release_control_hash).toBe(
      control.control_hash,
    );
    expect(receipt.operation).toBe("secret_admit");
    expect(
      JSON.stringify({ approval: replacementApproval, control, receipt }),
    ).not.toContain(secretMarker);
    expectMarkerAbsent(dataRoot, secretMarker);
    expectMarkerAbsent(backup.directory, secretMarker);
    await storage.close();

    const database = new DatabaseSync(join(dataRoot, "ledger", "memory.db"), {
      readOnly: true,
    });
    expect(
      database
        .prepare("SELECT control_hash FROM g6_release_controls")
        .get(),
    ).toEqual({ control_hash: control.control_hash });
    expect(
      database
        .prepare(
          `SELECT count(*) AS count FROM secret_authority_consumptions
           WHERE authority_kind = 'admission'`,
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare("SELECT count(*) AS count FROM secret_nonce_reservations")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare("SELECT count(*) AS count FROM encrypted_contents")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare(
          `SELECT owner_id, owner_kind
           FROM encrypted_content_owners`,
        )
        .get(),
    ).toEqual({
      owner_id: "evidence:governed-u9:1",
      owner_kind: "evidence",
    });
    expect(
      database
        .prepare("SELECT count(*) AS count FROM g6_release_controls")
        .get(),
    ).toEqual({ count: 1 });
    database.close();

    const newKeyDescriptor = privateDescriptor(
      descriptorRoot,
      "data-key-rotated.bin",
      Buffer.alloc(32, 0x31),
    );
    const newAuthorityDescriptor = privateDescriptor(
      descriptorRoot,
      "data-authority-rotated.bin",
      Buffer.alloc(32, 0x32),
    );
    const newCommitmentDescriptor = privateDescriptor(
      descriptorRoot,
      "data-commitment-rotated.bin",
      Buffer.alloc(32, 0x33),
    );
    const restarted = await SqliteStorageClient.open({
      dataRoot,
      testOperations: true,
      secretPrincipalId: "principal:u9",
      recoveryHeadProvider: recovery,
    });
    await restarted.darkLaunchBeginKeyRotation({
      rotation_id: "rotation:governed-u9:1",
      new_key_id: "key:governed-u9:2",
      new_key_generation: 2,
      new_key_descriptor: newKeyDescriptor,
      new_authority_key_id: "data-authority:governed-u9:2",
      new_authority_descriptor: newAuthorityDescriptor,
      new_commitment_key_id: "data-commitment:governed-u9:2",
      new_commitment_descriptor: newCommitmentDescriptor,
    });
    await expect(
      restarted.darkLaunchResumeKeyRotation({
        rotation_id: "rotation:governed-u9:1",
        old_key_descriptor: keyDescriptor,
        new_key_descriptor: newKeyDescriptor,
        old_authority_descriptor: dataAuthorityDescriptor,
        new_commitment_descriptor: newCommitmentDescriptor,
      }),
    ).resolves.toMatchObject({ state: "completed" });
    const rotatedBackup = await restarted.createBackup();
    expect(
      rotatedBackup.manifest.frontiers.g6_release_control_hash,
    ).toBe(control.control_hash);
    expectMarkerAbsent(dataRoot, secretMarker);
    expectMarkerAbsent(rotatedBackup.directory, secretMarker);
    await restarted.close();

    const wrongKeyDescriptor = privateDescriptor(
      descriptorRoot,
      "wrong-rotated-key.bin",
      Buffer.alloc(32, 0x7f),
    );
    const wrongTarget = join(
      temporaryRoot("governed-secret-wrong-restore"),
      "target",
    );
    await expect(
      restoreBackupToEmptyDataRoot({
        backup: rotatedBackup,
        dataRoot: wrongTarget,
        recoveryHeadProvider: recovery,
        requiredKeyDescriptors: {
          "key:governed-u9:1": keyDescriptor,
          "key:governed-u9:2": wrongKeyDescriptor,
        },
      }),
    ).rejects.toMatchObject({ code: "KEY_UNAVAILABLE" });
    expect(existsSync(wrongTarget)).toBe(false);

    const restoredTarget = join(
      temporaryRoot("governed-secret-restored"),
      "target",
    );
    await restoreBackupToEmptyDataRoot({
      backup: rotatedBackup,
      dataRoot: restoredTarget,
      recoveryHeadProvider: recovery,
      requiredKeyDescriptors: {
        "key:governed-u9:1": keyDescriptor,
        "key:governed-u9:2": newKeyDescriptor,
      },
    });
    const restoredStorage = await SqliteStorageClient.open({
      dataRoot: restoredTarget,
      testOperations: true,
      secretPrincipalId: "principal:u9",
      recoveryHeadProvider: recovery,
    });
    await expect(
      restoredStorage.governedAdmitSecret({
        ...governedInput,
        input_descriptor: replacementSecretDescriptor,
        approval: replacementApproval,
      }),
    ).rejects.toMatchObject({ code: "ENCRYPTION_REQUIRED" });
    await expect(
      restoredStorage.darkLaunchPurgeSecret({
        idempotency_key: "purge-governed-u9-after-restore",
        principal_id: "principal:u9",
        owner,
        authority_descriptor: newAuthorityDescriptor,
      }),
    ).resolves.toMatchObject({ operation: "secret_purge" });
    await restoredStorage.close();

    const purgedDatabase = new DatabaseSync(
      join(restoredTarget, "ledger", "memory.db"),
      { readOnly: true },
    );
    expect(
      purgedDatabase
        .prepare("SELECT count(*) AS count FROM encrypted_contents")
        .get(),
    ).toEqual({ count: 0 });
    expect(
      purgedDatabase
        .prepare(
          `SELECT count(*) AS count FROM encrypted_content_owners
           WHERE active = 1`,
        )
        .get(),
    ).toEqual({ count: 0 });
    purgedDatabase.close();
  });
});
