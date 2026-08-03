import { generateKeyPairSync, sign } from "node:crypto";

import {
  CompleteBackupManifestSchema,
  RecoveryAnchorSchema,
  canonicalJson,
  canonicalSha256,
  canonicalSha256Omitting,
  verifyRecoveryAnchor,
} from "../../packages/contracts/src/index.js";
import {
  MemoryRecoveryHeadProvider,
  assertRecoveryProtectionBinding,
  recoveryMinimumsFromManifest,
  recoveryStateCommitment,
} from "@memo-graph/storage-sqlite";
import {
  recoveryContentHash,
} from "../../packages/storage-sqlite/src/recovery-hash.js";
import { describe, expect, it } from "vitest";

const HASH_A = `sha256:${"a".repeat(64)}` as const;
const HASH_B = `sha256:${"b".repeat(64)}` as const;
const HASH_C = `sha256:${"c".repeat(64)}` as const;

function manifest() {
  const unsigned = {
    schema_version: "1.0.0",
    backup_id: "backup_complete_1",
    created_at: "2026-07-30T12:00:00.000Z",
    root_identity: {
      root_id: "root_primary",
      principal_id: "principal_local",
    },
    database: {
      bundle_path: "database/memory.db",
      raw_hash: HASH_A,
      size_bytes: 1024,
      logical_hash: HASH_B,
    },
    artifacts: [
      {
        kind: "blob",
        artifact_id: "blob_1",
        storage_kind: "external",
        bundle_path: "artifacts/blobs/blob_1",
        raw_hash: HASH_B,
        size_bytes: 32,
      },
      {
        kind: "ciphertext",
        artifact_id: "ciphertext_1",
        storage_kind: "inline",
        bundle_path: null,
        raw_hash: HASH_C,
        size_bytes: 48,
      },
    ],
    schema: {
      current_version: "0016",
      migration_set_hash: HASH_A,
      migrations: [
        {
          version: "0016",
          name: "recovery anchors",
          hash: HASH_B,
          applied_at: "2026-07-30T11:59:00.000Z",
        },
      ],
    },
    frontiers: {
      ledger_epoch: 7,
      latest_receipt_hash: HASH_A,
      tombstone_epoch: 2,
      purge_frontier_hash: HASH_B,
      purge_debt_count: 0,
      fts_frontier_hash: HASH_A,
      fts_logical_frontier_hash: HASH_C,
      layered_frontier_hash: HASH_B,
      relation_frontier_hash: HASH_C,
      context_frontier_hash: HASH_A,
      learning_control_epoch: 3,
      learning_release_revision: 4,
      learning_frontier_hash: HASH_C,
      learning_pointer_hash: HASH_A,
      learning_monitor_hash: null,
      learning_rollback_hash: null,
      encryption_frontier_hash: HASH_B,
      g6_release_control_hash: null,
    },
    encryption: {
      format_version: 1,
      required_keys: [
        {
          key_id: "key_current",
          key_generation: 1,
          state: "current",
        },
      ],
      key_live_ciphertexts: [
        {
          key_id: "key_current",
          live_ciphertext_count: 0,
        },
      ],
    },
    decisions: {
      g3r: { status: "GO", decision_hash: HASH_A },
      g4a: { status: "NO-GO", decision_hash: HASH_B },
      g4b: { status: "NO-GO", decision_hash: HASH_C },
      g5: { status: "GO", decision_hash: HASH_A },
      graph_enabled: false,
      vector_enabled: false,
      automatic_learning_publication: false,
    },
    creation_identity: {
      config_hash: HASH_A,
      environment_hash: canonicalSha256({
        platform: "darwin",
        architecture: "arm64",
        node_version: "24.18.0",
        filesystem_type: 17,
      }),
      filesystem_type: 17,
      platform: "darwin",
      architecture: "arm64",
      node_version: "24.18.0",
    },
  } as const;
  return CompleteBackupManifestSchema.parse({
    ...unsigned,
    manifest_hash: canonicalSha256(unsigned),
  });
}

describe("complete backup and external recovery contracts", () => {
  it("accepts a complete manifest and rejects every omitted binding family", () => {
    const complete = manifest();
    expect(complete.artifacts).toHaveLength(2);

    for (const incomplete of [
      { ...complete, database: undefined },
      {
        ...complete,
        schema: {
          ...complete.schema,
          migrations: [],
        },
      },
      { ...complete, frontiers: undefined },
      {
        ...complete,
        encryption: {
          ...complete.encryption,
          required_keys: undefined,
        },
      },
      {
        ...complete,
        decisions: {
          ...complete.decisions,
          g5: undefined,
        },
      },
      {
        ...complete,
        creation_identity: {
          ...complete.creation_identity,
          config_hash: undefined,
        },
      },
      {
        ...complete,
        creation_identity: {
          ...complete.creation_identity,
          environment_hash: undefined,
        },
      },
    ]) {
      expect(() =>
        CompleteBackupManifestSchema.parse(incomplete),
      ).toThrow();
    }
    expect(() =>
      CompleteBackupManifestSchema.parse({
        ...complete,
        artifacts: [...complete.artifacts, complete.artifacts[0]],
      }),
    ).toThrow();
    expect(() =>
      CompleteBackupManifestSchema.parse({
        ...complete,
        database: {
          ...complete.database,
          bundle_path: "/Users/local/private/memory.db",
        },
      }),
    ).toThrow();
    expect(() =>
      CompleteBackupManifestSchema.parse({
        ...complete,
        raw_key: "never",
      }),
    ).toThrow();
  });

  it("authenticates every minimum and rejects tampering or an unauthorized signer", () => {
    const authority = generateKeyPairSync("ed25519");
    const other = generateKeyPairSync("ed25519");
    const payloadWithoutHash = {
      schema_version: "1.0.0",
      anchor_id: "anchor_1",
      generation: 9,
      previous_head_hash: HASH_A,
      root_id: "root_primary",
      principal_id: "principal_local",
      trust_root_version: 2,
      state_commitment_hash: HASH_C,
      backup_manifest_hash: manifest().manifest_hash,
      minimums: {
        ledger_epoch: 7,
        latest_receipt_hash: HASH_A,
        tombstone_epoch: 2,
        purge_frontier_hash: HASH_B,
        projection_frontier_hash: HASH_C,
        context_frontier_hash: HASH_A,
        learning_control_epoch: 3,
        learning_release_revision: 4,
        learning_frontier_hash: HASH_C,
        encryption_frontier_hash: HASH_B,
        required_keys: [
          {
            key_id: "key_current",
            key_generation: 1,
            state: "current",
          },
        ],
        key_live_ciphertexts: [
          {
            key_id: "key_current",
            live_ciphertext_count: 0,
          },
        ],
        g6_release_control_hash: null,
      },
      issued_at: "2026-07-30T12:01:00.000Z",
    } as const;
    const payload = {
      ...payloadWithoutHash,
      payload_hash: canonicalSha256(payloadWithoutHash),
    };
    const anchor = RecoveryAnchorSchema.parse({
      payload,
      authority_key_id: "recovery_authority_1",
      signature: sign(
        null,
        Buffer.from(canonicalJson(payload), "utf8"),
        authority.privateKey,
      ).toString("base64url"),
      anchor_hash: canonicalSha256({
        payload,
        authority_key_id: "recovery_authority_1",
      }),
    });

    expect(
      verifyRecoveryAnchor({
        anchor,
        expectedAuthorityKeyId: "recovery_authority_1",
        publicKey: authority.publicKey,
      }),
    ).toEqual(anchor);
    expect(() =>
      verifyRecoveryAnchor({
        anchor: {
          ...anchor,
          payload: {
            ...anchor.payload,
            minimums: {
              ...anchor.payload.minimums,
              tombstone_epoch: 99,
            },
          },
        },
        expectedAuthorityKeyId: "recovery_authority_1",
        publicKey: authority.publicKey,
      }),
    ).toThrow();
    expect(() =>
      verifyRecoveryAnchor({
        anchor,
        expectedAuthorityKeyId: "recovery_authority_1",
        publicKey: other.publicKey,
      }),
    ).toThrow();
    expect(anchor.payload.payload_hash).toBe(
      canonicalSha256Omitting(anchor.payload, ["payload_hash"]),
    );
  });

  it("refuses to issue a backup anchor for a different logical root even when minimums match", () => {
    const authority = generateKeyPairSync("ed25519");
    const provider = new MemoryRecoveryHeadProvider({
      authorityKeyId: "recovery_authority_root_binding",
      trustRootVersion: 1,
      privateKey: authority.privateKey,
      publicKey: authority.publicKey,
    });
    const complete = manifest();
    const minimums = recoveryMinimumsFromManifest(complete);
    provider.bootstrap({
      root_id: "root_other",
      principal_id: complete.root_identity.principal_id,
      minimums,
      state_commitment_hash: recoveryStateCommitment({
        root_id: "root_other",
        principal_id: complete.root_identity.principal_id,
        minimums,
      }),
    });

    expect(() =>
      provider.issueBackupAnchor({
        manifest: complete,
        minimums,
      }),
    ).toThrowError(expect.objectContaining({
      code: "STALE_RECOVERY_HEAD",
    }));
  });

  it("rejects worker mutation bypass and wrong-operation protected envelopes", () => {
    expect(() =>
      assertRecoveryProtectionBinding("commit_episode", null),
    ).toThrowError(expect.objectContaining({
      code: "RECOVERY_AUTHORITY_INVALID",
    }));
    expect(() =>
      assertRecoveryProtectionBinding(
        "commit_episode",
        "projection",
      ),
    ).toThrowError(expect.objectContaining({
      code: "RECOVERY_AUTHORITY_INVALID",
    }));
    expect(() =>
      assertRecoveryProtectionBinding("health", "canonical"),
    ).toThrowError(expect.objectContaining({
      code: "RECOVERY_AUTHORITY_INVALID",
    }));
    expect(() =>
      assertRecoveryProtectionBinding(
        "commit_episode",
        "canonical",
      ),
    ).not.toThrow();
    expect(() =>
      assertRecoveryProtectionBinding(
        "preview_memory_revision",
        null,
      ),
    ).not.toThrow();
    expect(() =>
      assertRecoveryProtectionBinding(
        "preview_memory_control",
        null,
      ),
    ).not.toThrow();
    expect(() =>
      assertRecoveryProtectionBinding(
        "preview_memory_delete",
        null,
      ),
    ).not.toThrow();
    expect(() =>
      assertRecoveryProtectionBinding(
        "preview_memory_delete",
        "purge",
      ),
    ).toThrowError(expect.objectContaining({
      code: "RECOVERY_AUTHORITY_INVALID",
    }));
  });

  it("excludes only replay transport metadata from recovery result commitments", () => {
    const durableResult = {
      receipt: {
        receipt_hash: HASH_A,
        outcome: "APPLIED",
      },
      replayed: false,
      committed: true,
    };
    expect(
      recoveryContentHash({
        ...durableResult,
        replayed: true,
      }),
    ).toBe(recoveryContentHash(durableResult));
    expect(
      recoveryContentHash({
        ...durableResult,
        committed: false,
      }),
    ).not.toBe(recoveryContentHash(durableResult));
    expect(
      recoveryContentHash({
        ...durableResult,
        receipt: {
          ...durableResult.receipt,
          receipt_hash: HASH_B,
        },
      }),
    ).not.toBe(recoveryContentHash(durableResult));
  });
});
