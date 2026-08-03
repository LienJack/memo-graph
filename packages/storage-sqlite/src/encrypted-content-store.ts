import { randomBytes, verify } from "node:crypto";

import type Database from "better-sqlite3";
import type { z } from "zod";

import {
  CanonicalHashSchema,
  SecretEncryptedPayloadSchema,
  G6ReleaseControlSchema,
  SecretAdmissionTrustSchema,
  secretAdmissionApprovalSigningPayload,
  secretAdmissionEnvelopeRequestBindingHash,
  SecretContentOwnerSchema,
  SecretEnvelopeMetadataSchema,
  canonicalJson,
  canonicalSha256,
  secretAadHash,
  type EncryptionReceipt,
  type CanonicalHash,
  type Scope,
  type SecretAdmissionApproval,
  type SecretContentOwner,
  type SecretEnvelopeMetadata,
  type SecretUseAuthority,
  type G6ReleaseControl,
  type G6ReleaseControlTrust,
  type RuntimeIdentity,
  type SecretAdmissionTrust,
} from "@memo-graph/contracts";

import { StorageError } from "./errors.js";
import type { KeyRepository } from "./key-repository.js";
import type { OperationalRepository } from "./operational-repository.js";
import type { EncryptedArtifactStore } from "./encrypted-artifact-store.js";
import { verifyExactG6ReleaseControl } from "./release-control.js";

type ReservationRow = {
  operation_id: string;
  idempotency_key: string;
  request_digest: string;
  key_id: string;
  key_generation: number;
  nonce_base64url: string;
  aad_hash: string;
  keyed_plaintext_commitment: string;
  owner_kind: "evidence" | "memory_revision";
  owner_id: string;
  owner_generation: number;
  rotation_id: string | null;
  state: "prepared" | "committed" | "retired";
  ciphertext_id: string | null;
};

export type ReserveSecretInput = {
  operation_id: string;
  idempotency_key: string;
  request_digest: CanonicalHash;
  owner: SecretContentOwner;
  scope: Scope;
  content_identity: string;
  media_type: string;
  keyed_plaintext_commitment: string;
  commitment_key_id: string;
  commitment_verification_tag: string;
  rotation_id?: string;
};

export type ReserveSecretResult =
  | {
      state: "prepared";
      operation_id: string;
      metadata: SecretEnvelopeMetadata;
    }
  | {
      state: "committed";
      operation_id: string;
      receipt: EncryptionReceipt;
    };

export type SecretPurgeTarget = {
  owner: SecretContentOwner;
  ciphertext_id: string;
  metadata: SecretEnvelopeMetadata;
  envelope_hash: CanonicalHash;
};

export class EncryptedContentStore {
  readonly #database: Database.Database;
  readonly #keys: KeyRepository;
  readonly #operations: OperationalRepository;
  readonly #artifacts: EncryptedArtifactStore;
  readonly #principalId: string | null;
  readonly #rootFenceToken: number | null;
  readonly #releaseVerification: {
    trust: G6ReleaseControlTrust;
    runtimeIdentity: RuntimeIdentity;
  } | null;
  readonly #admissionTrust: SecretAdmissionTrust | null;

  constructor(
    database: Database.Database,
    keys: KeyRepository,
    operations: OperationalRepository,
    artifacts: EncryptedArtifactStore,
    options: {
      principalId: string | null;
      rootFenceToken: number | null;
      releaseVerification?: {
        trust: G6ReleaseControlTrust;
        runtimeIdentity: RuntimeIdentity;
      } | null;
      admissionTrust?: SecretAdmissionTrust | null;
    },
  ) {
    this.#database = database;
    this.#keys = keys;
    this.#operations = operations;
    this.#artifacts = artifacts;
    this.#principalId = options.principalId;
    this.#rootFenceToken = options.rootFenceToken;
    this.#releaseVerification = options.releaseVerification ?? null;
    this.#admissionTrust = options.admissionTrust ?? null;
  }

  reserve(input: ReserveSecretInput): ReserveSecretResult {
    const existing = this.#database
      .prepare(
        `SELECT operation_id, idempotency_key, request_digest, key_id,
                key_generation, nonce_base64url, aad_hash,
                keyed_plaintext_commitment, owner_kind, owner_id,
                owner_generation, rotation_id, state, ciphertext_id
         FROM secret_nonce_reservations WHERE idempotency_key = ?`,
      )
      .get(input.idempotency_key) as ReservationRow | undefined;
    if (existing !== undefined) {
      return this.#replayReservation(existing, input);
    }
    const inventory = this.#keys.inventory();
    let current = this.#keys.currentInternal();
    if (input.rotation_id === undefined) {
      if (inventory.rotating_to_key_id !== null) {
        throw new StorageError("MAINTENANCE_BLOCKED", { retryable: true });
      }
    } else {
      const rotation = this.#keys.rotation(input.rotation_id);
      if (
        rotation.state !== "in_progress" ||
        inventory.rotation_id !== input.rotation_id ||
        inventory.rotating_to_key_id !== rotation.new_key_id
      ) {
        throw new StorageError("ROTATION_INCOMPLETE");
      }
      current = this.#keys.keyInternal(rotation.new_key_id);
    }
    this.#keys.verifyCommitmentProvider({
      key_id: current.key_id,
      key_generation: Number(current.key_generation),
      commitment_key_id: input.commitment_key_id,
      commitment_verification_tag:
        input.commitment_verification_tag,
    });
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const nonce = randomBytes(12).toString("base64url");
      const metadata = SecretEnvelopeMetadataSchema.parse({
        schema_version: "1.0.0",
        envelope_version: 1,
        algorithm: "AES-256-GCM",
        key_id: current.key_id,
        key_generation: Number(current.key_generation),
        nonce_base64url: nonce,
        owner: input.owner,
        scope: input.scope,
        sensitivity: "secret",
        content_identity: input.content_identity,
        content_class: input.owner.kind,
        media_type: input.media_type,
        keyed_plaintext_commitment: input.keyed_plaintext_commitment,
      });
      try {
        this.#database
          .prepare(
            `INSERT INTO secret_nonce_reservations (
               operation_id, idempotency_key, request_digest, key_id,
               key_generation, nonce_base64url, aad_hash,
               keyed_plaintext_commitment, owner_kind, owner_id,
               owner_generation, rotation_id, state, ciphertext_id, created_at,
               updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', NULL, ?, ?)`,
          )
          .run(
            input.operation_id,
            input.idempotency_key,
            input.request_digest,
            current.key_id,
            current.key_generation,
            nonce,
            secretAadHash(metadata),
            input.keyed_plaintext_commitment,
            input.owner.kind,
            input.owner.id,
            input.owner.generation,
            input.rotation_id ?? null,
            new Date().toISOString(),
            new Date().toISOString(),
          );
        return {
          state: "prepared",
          operation_id: input.operation_id,
          metadata,
        };
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string" &&
          error.code.startsWith("SQLITE_CONSTRAINT_UNIQUE")
        ) {
          const raced = this.#database
            .prepare(
              `SELECT operation_id, idempotency_key, request_digest, key_id,
                      key_generation, nonce_base64url, aad_hash,
                      keyed_plaintext_commitment, owner_kind, owner_id,
                      owner_generation, rotation_id, state, ciphertext_id
               FROM secret_nonce_reservations WHERE idempotency_key = ?`,
            )
            .get(input.idempotency_key) as ReservationRow | undefined;
          if (raced !== undefined) {
            return this.#replayReservation(raced, input);
          }
          continue;
        }
        throw error;
      }
    }
    throw new StorageError("NONCE_REUSE");
  }

  commit(input: {
    operation_id: string;
    request_digest: CanonicalHash;
    payload: unknown;
    approval?: SecretAdmissionApproval;
    release_control?: G6ReleaseControl | null;
    validated_at?: string;
    rotation_id?: string;
    old_ciphertext_id?: string;
  }): EncryptionReceipt {
    const payload = SecretEncryptedPayloadSchema.parse(input.payload);
    const ciphertext = Buffer.from(payload.ciphertext_base64url, "base64url");
    const ciphertextId =
      `ciphertext:${payload.envelope.envelope_hash.slice(
        "sha256:".length,
        "sha256:".length + 48,
      )}`;
    return this.#database
      .transaction(() => {
        const row = this.#database
          .prepare(
            `SELECT operation_id, idempotency_key, request_digest, key_id,
                    key_generation, nonce_base64url, aad_hash,
                    keyed_plaintext_commitment, owner_kind, owner_id,
                    owner_generation, rotation_id, state, ciphertext_id
             FROM secret_nonce_reservations WHERE operation_id = ?`,
          )
          .get(input.operation_id) as ReservationRow | undefined;
        if (row === undefined) {
          throw new StorageError("NONCE_REUSE");
        }
        if (
          row.request_digest !== input.request_digest ||
          row.rotation_id !== (input.rotation_id ?? null)
        ) {
          throw new StorageError("NONCE_REUSE");
        }
        if (row.state === "committed") {
          const replay = this.#operations.replay(
            input.rotation_id === undefined
              ? "secret_admit"
              : "key_rotation_item",
            input.operation_id,
            input.request_digest,
          );
          if (replay === null) {
            throw new StorageError("CORRUPTION");
          }
          return replay;
        }
        const expectedMetadata = SecretEnvelopeMetadataSchema.parse(
          JSON.parse(
            this.#metadataJson(row, payload.envelope.metadata),
          ) as unknown,
        );
        if (
          row.request_digest !== input.request_digest ||
          row.rotation_id !== (input.rotation_id ?? null) ||
          canonicalJson(expectedMetadata) !==
            canonicalJson(payload.envelope.metadata) ||
          row.aad_hash !== payload.envelope.aad_hash ||
          row.keyed_plaintext_commitment !==
            payload.envelope.metadata.keyed_plaintext_commitment
        ) {
          throw new StorageError("NONCE_REUSE");
        }
        if (input.rotation_id === undefined) {
          this.#installOrVerifyReleaseControl(
            input.release_control ?? null,
            input.validated_at,
          );
          const current = this.#keys.currentInternal();
          if (
            row.key_id !== current.key_id ||
            Number(row.key_generation) !== Number(current.key_generation) ||
            this.#keys.inventory().rotation_id !== null
          ) {
            throw new StorageError("MAINTENANCE_BLOCKED", {
              retryable: true,
            });
          }
          this.#validateAdmissionApproval(
            input.approval,
            payload.envelope.metadata,
            input.request_digest,
            input.validated_at,
          );
        } else {
          const rotation = this.#keys.rotation(input.rotation_id);
          if (
            rotation.state !== "in_progress" ||
            row.key_id !== rotation.new_key_id ||
            input.old_ciphertext_id === undefined
          ) {
            throw new StorageError("ROTATION_INCOMPLETE");
          }
          const item = this.#database
            .prepare(
              `SELECT state, old_ciphertext_id
               FROM key_rotation_items
               WHERE rotation_id = ? AND owner_kind = ? AND owner_id = ?
                 AND owner_generation = ?`,
            )
            .get(
              input.rotation_id,
              row.owner_kind,
              row.owner_id,
              row.owner_generation,
            ) as
            | { state: string; old_ciphertext_id: string }
            | undefined;
          if (
            item === undefined ||
            item.state !== "pending" ||
            item.old_ciphertext_id !== input.old_ciphertext_id
          ) {
            throw new StorageError("ROTATION_INCOMPLETE");
          }
        }
        const artifact = this.#artifacts.prepare({
          operation_id: input.operation_id,
          ciphertext_id: ciphertextId,
          ciphertext_hash: payload.envelope.ciphertext_hash,
          ciphertext,
        });
        const createdAt = new Date().toISOString();
        this.#database
          .prepare(
            `INSERT INTO encrypted_contents (
               ciphertext_id, envelope_version, algorithm, key_id,
               key_generation, nonce_base64url, tag_base64url, aad_json,
               aad_hash, keyed_plaintext_commitment, ciphertext,
               storage_kind, external_relative_path, ciphertext_hash,
               ciphertext_size_bytes, envelope_hash, media_type, created_at,
               retired_at
             ) VALUES (?, 1, 'AES-256-GCM', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          )
          .run(
            ciphertextId,
            row.key_id,
            row.key_generation,
            row.nonce_base64url,
            payload.envelope.tag_base64url,
            canonicalJson(payload.envelope.metadata),
            row.aad_hash,
            row.keyed_plaintext_commitment,
            artifact.storage_kind === "inline" ? ciphertext : null,
            artifact.storage_kind,
            artifact.relative_path,
            payload.envelope.ciphertext_hash,
            ciphertext.byteLength,
            payload.envelope.envelope_hash,
            payload.envelope.metadata.media_type,
            createdAt,
          );
        this.#artifacts.markReferenced(ciphertextId);
        if (input.rotation_id === undefined) {
          this.#database
            .prepare(
              `INSERT INTO encrypted_content_owners (
                 owner_kind, owner_id, owner_generation, ciphertext_id, active,
                 bound_at, retired_at
               ) VALUES (?, ?, ?, ?, 1, ?, NULL)`,
            )
            .run(
              row.owner_kind,
              row.owner_id,
              row.owner_generation,
              ciphertextId,
              createdAt,
            );
        } else {
          const oldCiphertextId = input.old_ciphertext_id;
          if (oldCiphertextId === undefined) {
            throw new StorageError("INVALID_INPUT");
          }
          const ownerUpdate = this.#database
            .prepare(
              `UPDATE encrypted_content_owners
               SET ciphertext_id = ?, bound_at = ?
               WHERE owner_kind = ? AND owner_id = ? AND owner_generation = ?
                 AND active = 1 AND ciphertext_id = ?`,
            )
            .run(
              ciphertextId,
              createdAt,
              row.owner_kind,
              row.owner_id,
              row.owner_generation,
              oldCiphertextId,
            );
          if (ownerUpdate.changes !== 1) {
            throw new StorageError("ROTATION_INCOMPLETE");
          }
          const retired = this.#database
            .prepare(
              `UPDATE encrypted_contents SET retired_at = ?
               WHERE ciphertext_id = ? AND retired_at IS NULL`,
            )
            .run(createdAt, oldCiphertextId);
          if (retired.changes !== 1) {
            throw new StorageError("ROTATION_INCOMPLETE");
          }
          this.#artifacts.markRetired(oldCiphertextId);
          this.#database
            .prepare(
              `UPDATE secret_nonce_reservations
               SET state = 'retired', updated_at = ?
               WHERE ciphertext_id = ? AND state = 'committed'`,
            )
            .run(createdAt, oldCiphertextId);
          const itemUpdate = this.#database
            .prepare(
              `UPDATE key_rotation_items
               SET state = 'rewritten', new_ciphertext_id = ?, rewritten_at = ?
               WHERE rotation_id = ? AND owner_kind = ? AND owner_id = ?
                 AND owner_generation = ? AND state = 'pending'`,
            )
            .run(
              ciphertextId,
              createdAt,
              input.rotation_id,
              row.owner_kind,
              row.owner_id,
              row.owner_generation,
            );
          if (itemUpdate.changes !== 1) {
            throw new StorageError("ROTATION_INCOMPLETE");
          }
          const progressUpdate = this.#database
            .prepare(
              `UPDATE key_rotations
               SET rewritten_items = rewritten_items + 1, updated_at = ?
               WHERE rotation_id = ? AND state = 'in_progress'`,
            )
            .run(createdAt, input.rotation_id);
          if (progressUpdate.changes !== 1) {
            throw new StorageError("ROTATION_INCOMPLETE");
          }
        }
        const reservationUpdate = this.#database
          .prepare(
            `UPDATE secret_nonce_reservations
             SET state = 'committed', ciphertext_id = ?, updated_at = ?
             WHERE operation_id = ? AND state = 'prepared'`,
          )
          .run(ciphertextId, createdAt, input.operation_id);
        if (reservationUpdate.changes !== 1) {
          throw new StorageError("NONCE_REUSE");
        }
        const receipt = this.#operations.append({
          operation:
            input.rotation_id === undefined
              ? "secret_admit"
              : "key_rotation_item",
          operation_id: input.operation_id,
          request_digest: input.request_digest,
          key_ids: [row.key_id],
          affected_owner_ids: [row.owner_id],
          ciphertext_ids: [ciphertextId],
          resulting_key_generation: Number(row.key_generation),
          created_at: createdAt,
        });
        if (input.rotation_id === undefined) {
          const approval = input.approval;
          if (approval === undefined) {
            throw new StorageError("INVALID_INPUT");
          }
          try {
            this.#database
              .prepare(
                `INSERT INTO secret_authority_consumptions (
                   authority_id, authority_kind, authority_hash, operation_id,
                   receipt_id, consumed_at
                 ) VALUES (?, 'admission', ?, ?, ?, ?)`,
              )
              .run(
                approval.approval_id,
                approval.approval_hash,
                input.operation_id,
                receipt.receipt_id,
                receipt.created_at,
              );
          } catch (error) {
            if (
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              typeof error.code === "string" &&
              error.code.startsWith("SQLITE_CONSTRAINT")
            ) {
              throw new StorageError("AUTHORITY_REPLAY");
            }
            throw error;
          }
        }
        return receipt;
      })
      .immediate();
  }

  rotationNext(rotationId: string): {
    progress: ReturnType<KeyRepository["rotation"]>;
    item: {
      rotation_id: string;
      old_ciphertext_id: string;
      owner: SecretContentOwner;
      old_metadata: SecretEnvelopeMetadata;
    } | null;
  } {
    const progress = this.#keys.rotation(rotationId);
    const row = this.#database
      .prepare(
        `SELECT i.old_ciphertext_id, i.owner_kind, i.owner_id,
                i.owner_generation, c.aad_json
         FROM key_rotation_items AS i
         JOIN encrypted_contents AS c
           ON c.ciphertext_id = i.old_ciphertext_id
         WHERE i.rotation_id = ? AND i.state = 'pending'
         ORDER BY i.owner_kind, i.owner_id LIMIT 1`,
      )
      .get(rotationId) as
      | {
          old_ciphertext_id: string;
          owner_kind: "evidence" | "memory_revision";
          owner_id: string;
          owner_generation: number;
          aad_json: string;
        }
      | undefined;
    if (row === undefined) {
      return { progress, item: null };
    }
    const metadata = SecretEnvelopeMetadataSchema.parse(
      JSON.parse(row.aad_json) as unknown,
    );
    return {
      progress,
      item: {
        rotation_id: rotationId,
        old_ciphertext_id: row.old_ciphertext_id,
        owner: SecretContentOwnerSchema.parse({
          kind: row.owner_kind,
          id: row.owner_id,
          generation: Number(row.owner_generation),
        }),
        old_metadata: metadata,
      },
    };
  }

  consumeUseAuthority(
    authority: SecretUseAuthority,
  ): {
    receipt: EncryptionReceipt;
    payload: z.output<typeof SecretEncryptedPayloadSchema>;
  } {
    return this.#database
      .transaction(() => {
        const consumed = this.#database
          .prepare(
            `SELECT authority_hash, receipt_id
             FROM secret_authority_consumptions
             WHERE authority_id = ?`,
          )
          .get(authority.authority_id) as
          | { authority_hash: string; receipt_id: string }
          | undefined;
        const now = Date.now();
        const row = this.#database
          .prepare(
            `SELECT c.key_id, c.key_generation, c.aad_json,
                    i.rotation_id, i.state
             FROM encrypted_contents AS c
             JOIN key_rotation_items AS i
               ON i.old_ciphertext_id = c.ciphertext_id
             JOIN key_rotations AS r
               ON r.rotation_id = i.rotation_id
             WHERE c.ciphertext_id = ?`,
          )
          .get(authority.ciphertext_id) as
          | {
              key_id: string;
              key_generation: number;
              aad_json: string;
              rotation_id: string;
              state: string;
            }
          | undefined;
        if (row === undefined) {
          throw new StorageError("ROTATION_INCOMPLETE");
        }
        const metadata = SecretEnvelopeMetadataSchema.parse(
          JSON.parse(row.aad_json) as unknown,
        );
        const expectedDigest = canonicalSha256({
          rotation_id: row.rotation_id,
          old_ciphertext_id: authority.ciphertext_id,
          owner: authority.owner,
        });
        const expectedAuthorityId =
          `rotation-use:${canonicalSha256({
            rotation_id: row.rotation_id,
            ciphertext_id: authority.ciphertext_id,
            request_digest: expectedDigest,
          }).slice("sha256:".length, "sha256:".length + 48)}`;
        if (
          authority.authority_id !== expectedAuthorityId ||
          authority.principal_id !== "runtime:dark-launch" ||
          authority.purpose !== "rotation" ||
          authority.request_digest !== expectedDigest ||
          row.key_id !== authority.key_id ||
          Number(row.key_generation) !== authority.key_generation ||
          metadata.owner.kind !== authority.owner.kind ||
          metadata.owner.id !== authority.owner.id ||
          metadata.owner.generation !== authority.owner.generation ||
          canonicalJson(metadata.scope) !== canonicalJson(authority.scope)
        ) {
          throw new StorageError("INVALID_INPUT");
        }
        this.#keys.verifyAuthoritySignature({
          key_id: authority.key_id,
          key_generation: authority.key_generation,
          authority_key_id: authority.authority_key_id,
          authority_hash: authority.authority_hash,
          signature: authority.signature,
        });
        if (consumed !== undefined) {
          const replay = this.#operations.replay(
            "secret_use_authority",
            authority.authority_id,
            authority.request_digest,
          );
          if (
            replay === null ||
            replay.receipt_id !== consumed.receipt_id
          ) {
            throw new StorageError("CORRUPTION");
          }
          return {
            receipt: replay,
            payload: this.#payloadForCiphertext(
              authority.ciphertext_id,
            ),
          };
        }
        if (
          row.state !== "pending" ||
          Date.parse(authority.issued_at) > now ||
          Date.parse(authority.expires_at) <= now
        ) {
          throw new StorageError("ROTATION_INCOMPLETE");
        }
        const rotation = this.#keys.rotation(row.rotation_id);
        if (rotation.state !== "in_progress") {
          throw new StorageError("ROTATION_INCOMPLETE");
        }
        const payload = this.#payloadForCiphertext(
          authority.ciphertext_id,
        );
        const receipt = this.#operations.append({
          operation: "secret_use_authority",
          operation_id: authority.authority_id,
          request_digest: authority.request_digest,
          key_ids: [authority.key_id],
          affected_owner_ids: [authority.owner.id],
          ciphertext_ids: [authority.ciphertext_id],
          resulting_key_generation: authority.key_generation,
          created_at: new Date(now).toISOString(),
        });
        try {
          this.#database
            .prepare(
              `INSERT INTO secret_authority_consumptions (
                 authority_id, authority_kind, authority_hash, operation_id,
                 receipt_id, consumed_at
               ) VALUES (?, 'use', ?, ?, ?, ?)`,
            )
            .run(
              authority.authority_id,
              authority.authority_hash,
              `rotation:${row.rotation_id}`,
              receipt.receipt_id,
              receipt.created_at,
            );
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            typeof error.code === "string" &&
            error.code.startsWith("SQLITE_CONSTRAINT")
          ) {
            throw new StorageError("AUTHORITY_REPLAY");
          }
          throw error;
        }
        return { receipt, payload };
      })
      .immediate();
  }

  replayPurge(
    operationId: string,
    requestDigest: CanonicalHash,
  ): EncryptionReceipt | null {
    return this.#operations.replay(
      "secret_purge",
      operationId,
      requestDigest,
    );
  }

  purgeTarget(owner: SecretContentOwner): SecretPurgeTarget {
    const row = this.#database
      .prepare(
        `SELECT c.ciphertext_id, c.aad_json, c.envelope_hash
         FROM encrypted_content_owners AS o
         JOIN encrypted_contents AS c
           ON c.ciphertext_id = o.ciphertext_id
         WHERE o.owner_kind = ? AND o.owner_id = ?
           AND o.owner_generation = ? AND o.active = 1`,
      )
      .get(owner.kind, owner.id, owner.generation) as
      | {
          ciphertext_id: string;
          aad_json: string;
          envelope_hash: string;
        }
      | undefined;
    if (row === undefined) {
      throw new StorageError("INVALID_INPUT");
    }
    const metadata = SecretEnvelopeMetadataSchema.parse(
      JSON.parse(row.aad_json) as unknown,
    );
    if (
      metadata.owner.kind !== owner.kind ||
      metadata.owner.id !== owner.id ||
      metadata.owner.generation !== owner.generation
    ) {
      throw new StorageError("CORRUPTION");
    }
    return {
      owner,
      ciphertext_id: row.ciphertext_id,
      metadata,
      envelope_hash: CanonicalHashSchema.parse(row.envelope_hash),
    };
  }

  validatePurgeAuthority(input: {
    operation_id: string;
    request_digest: CanonicalHash;
    authority: SecretUseAuthority;
  }, validatedAt = Date.now()): SecretPurgeTarget {
    const activeRotation = this.#database
      .prepare(
        `SELECT rotation_id FROM key_rotations
         WHERE state IN ('prepared', 'in_progress', 'blocked')
         LIMIT 1`,
      )
      .get();
    if (activeRotation !== undefined) {
      throw new StorageError("MAINTENANCE_BLOCKED", {
        retryable: true,
      });
    }
    const expectedAuthorityId =
      `secret-purge-use:${canonicalSha256({
        operation_id: input.operation_id,
        owner: input.authority.owner,
      }).slice("sha256:".length, "sha256:".length + 48)}`;
    if (
      this.#principalId === null ||
      input.authority.authority_id !== expectedAuthorityId ||
      input.authority.principal_id !== this.#principalId ||
      input.authority.purpose !== "purge" ||
      input.authority.request_digest !== input.request_digest ||
      Date.parse(input.authority.issued_at) > validatedAt ||
      Date.parse(input.authority.expires_at) <= validatedAt
    ) {
      throw new StorageError("INVALID_INPUT");
    }
    const target = this.purgeTarget(input.authority.owner);
    if (
      input.authority.ciphertext_id !== target.ciphertext_id ||
      input.authority.key_id !== target.metadata.key_id ||
      input.authority.key_generation !==
        target.metadata.key_generation ||
      canonicalJson(input.authority.scope) !==
        canonicalJson(target.metadata.scope)
    ) {
      throw new StorageError("INVALID_INPUT");
    }
    const reservedTarget = this.#database
      .prepare(
        `SELECT 1 FROM secret_nonce_reservations
         WHERE owner_kind = ? AND owner_id = ? AND owner_generation = ?
           AND ciphertext_id = ?
         LIMIT 1`,
      )
      .get(
        input.authority.owner.kind,
        input.authority.owner.id,
        input.authority.owner.generation,
        input.authority.ciphertext_id,
      );
    if (reservedTarget === undefined) {
      throw new StorageError("CORRUPTION");
    }
    this.#keys.verifyAuthoritySignature({
      key_id: input.authority.key_id,
      key_generation: input.authority.key_generation,
      authority_key_id: input.authority.authority_key_id,
      authority_hash: input.authority.authority_hash,
      signature: input.authority.signature,
    });
    const consumed = this.#database
      .prepare(
        `SELECT authority_hash FROM secret_authority_consumptions
         WHERE authority_id = ?`,
      )
      .get(input.authority.authority_id);
    if (consumed !== undefined) {
      throw new StorageError("AUTHORITY_REPLAY");
    }
    return target;
  }

  purge(input: {
    operation_id: string;
    request_digest: CanonicalHash;
    authority: SecretUseAuthority;
    validated_at?: number;
  }): EncryptionReceipt {
    const replay = this.replayPurge(
      input.operation_id,
      input.request_digest,
    );
    if (replay !== null) {
      return replay;
    }
    return this.#database
      .transaction(() => {
        const repeated = this.replayPurge(
          input.operation_id,
          input.request_digest,
        );
        if (repeated !== null) {
          return repeated;
        }
        const activeRotation = this.#database
          .prepare(
            `SELECT rotation_id FROM key_rotations
             WHERE state IN ('prepared', 'in_progress', 'blocked')
             LIMIT 1`,
          )
          .get();
        if (activeRotation !== undefined) {
          throw new StorageError("MAINTENANCE_BLOCKED", {
            retryable: true,
          });
        }
        const now = Date.now();
        const target = this.validatePurgeAuthority(
          input,
          input.validated_at,
        );
        const metadata = target.metadata;
        const ciphertextRows = this.#database
          .prepare(
            `SELECT DISTINCT r.ciphertext_id, c.key_id, c.key_generation
             FROM secret_nonce_reservations AS r
             JOIN encrypted_contents AS c
               ON c.ciphertext_id = r.ciphertext_id
             WHERE r.owner_kind = ? AND r.owner_id = ?
               AND r.owner_generation = ? AND r.ciphertext_id IS NOT NULL
             ORDER BY c.key_generation, r.ciphertext_id`,
          )
          .all(
            input.authority.owner.kind,
            input.authority.owner.id,
            input.authority.owner.generation,
          ) as Array<{
            ciphertext_id: string;
            key_id: string;
            key_generation: number;
          }>;
        const ciphertextIds = ciphertextRows.map(
          ({ ciphertext_id }) => ciphertext_id,
        );
        const keyIds = [
          ...new Set(ciphertextRows.map(({ key_id }) => key_id)),
        ];
        if (!ciphertextIds.includes(input.authority.ciphertext_id)) {
          throw new StorageError("CORRUPTION");
        }
        const purgedAt = new Date(now).toISOString();
        const ownerUpdate = this.#database
          .prepare(
            `UPDATE encrypted_content_owners
             SET active = 0, retired_at = ?
             WHERE owner_kind = ? AND owner_id = ?
               AND owner_generation = ? AND active = 1`,
          )
          .run(
            purgedAt,
            input.authority.owner.kind,
            input.authority.owner.id,
            input.authority.owner.generation,
          );
        if (ownerUpdate.changes !== 1) {
          throw new StorageError("INVALID_INPUT");
        }
        this.#database
          .prepare(
            `UPDATE secret_nonce_reservations
             SET state = 'retired', updated_at = ?
             WHERE owner_kind = ? AND owner_id = ?
               AND owner_generation = ? AND state = 'committed'`,
          )
          .run(
            purgedAt,
            input.authority.owner.kind,
            input.authority.owner.id,
            input.authority.owner.generation,
          );
        this.#database
          .prepare(
            `DELETE FROM key_rotation_items
             WHERE owner_kind = ? AND owner_id = ?
               AND owner_generation = ?`,
          )
          .run(
            input.authority.owner.kind,
            input.authority.owner.id,
            input.authority.owner.generation,
          );
        const deleteCiphertext = this.#database.prepare(
          "DELETE FROM encrypted_contents WHERE ciphertext_id = ?",
        );
        for (const ciphertextId of ciphertextIds) {
          this.#artifacts.markRetired(ciphertextId);
          if (deleteCiphertext.run(ciphertextId).changes !== 1) {
            throw new StorageError("CORRUPTION");
          }
        }
        const receipt = this.#operations.append({
          operation: "secret_purge",
          operation_id: input.operation_id,
          request_digest: input.request_digest,
          key_ids: keyIds,
          affected_owner_ids: [input.authority.owner.id],
          ciphertext_ids: ciphertextIds,
          resulting_key_generation: metadata.key_generation,
          created_at: purgedAt,
        });
        this.#database
          .prepare(
            `INSERT INTO secret_authority_consumptions (
               authority_id, authority_kind, authority_hash, operation_id,
               receipt_id, consumed_at
             ) VALUES (?, 'use', ?, ?, ?, ?)`,
          )
          .run(
            input.authority.authority_id,
            input.authority.authority_hash,
            input.operation_id,
            receipt.receipt_id,
            purgedAt,
          );
        this.#database
          .prepare(
            `INSERT INTO secret_purge_physical_maintenance (
               operation_id, request_digest, receipt_id, receipt_hash,
               state, requested_at, completed_at
             ) VALUES (?, ?, ?, ?, 'pending', ?, NULL)`,
          )
          .run(
            input.operation_id,
            input.request_digest,
            receipt.receipt_id,
            receipt.receipt_hash,
            purgedAt,
          );
        return receipt;
      })
      .immediate();
  }

  #payloadForCiphertext(
    ciphertextId: string,
  ): z.output<typeof SecretEncryptedPayloadSchema> {
    const row = this.#database
      .prepare(
        `SELECT aad_json, aad_hash, tag_base64url, ciphertext_hash,
                ciphertext_size_bytes, envelope_hash, storage_kind,
                ciphertext, external_relative_path
         FROM encrypted_contents WHERE ciphertext_id = ?`,
      )
      .get(ciphertextId) as
      | {
          aad_json: string;
          aad_hash: string;
          tag_base64url: string;
          ciphertext_hash: string;
          ciphertext_size_bytes: number;
          envelope_hash: string;
          storage_kind: "inline" | "external";
          ciphertext: Uint8Array | null;
          external_relative_path: string | null;
        }
      | undefined;
    if (row === undefined) {
      throw new StorageError("ROTATION_INCOMPLETE");
    }
    return SecretEncryptedPayloadSchema.parse({
      envelope: {
        metadata: SecretEnvelopeMetadataSchema.parse(
          JSON.parse(row.aad_json) as unknown,
        ),
        aad_hash: row.aad_hash,
        tag_base64url: row.tag_base64url,
        ciphertext_hash: row.ciphertext_hash,
        ciphertext_size_bytes: Number(row.ciphertext_size_bytes),
        envelope_hash: row.envelope_hash,
      },
      ciphertext_base64url: this.#ciphertextBytes(row).toString(
        "base64url",
      ),
    });
  }

  #ciphertextBytes(row: {
    storage_kind: "inline" | "external";
    ciphertext: Uint8Array | null;
    external_relative_path: string | null;
    ciphertext_hash: string;
    ciphertext_size_bytes: number;
  }): Buffer {
    if (row.storage_kind === "inline") {
      if (row.ciphertext === null || row.external_relative_path !== null) {
        throw new StorageError("CORRUPTION");
      }
      const bytes = Buffer.from(row.ciphertext);
      if (bytes.byteLength !== Number(row.ciphertext_size_bytes)) {
        throw new StorageError("CORRUPTION");
      }
      return bytes;
    }
    if (row.ciphertext !== null || row.external_relative_path === null) {
      throw new StorageError("CORRUPTION");
    }
    return this.#artifacts.read({
      relative_path: row.external_relative_path,
      ciphertext_hash: row.ciphertext_hash,
      size_bytes: Number(row.ciphertext_size_bytes),
    });
  }

  #validateAdmissionApproval(
    approval: SecretAdmissionApproval | undefined,
    metadata: SecretEnvelopeMetadata,
    requestDigest: CanonicalHash,
    validatedAt: string | undefined,
  ): void {
    const now =
      validatedAt === undefined ? Number.NaN : Date.parse(validatedAt);
    const envelopeBinding = secretAdmissionEnvelopeRequestBindingHash({
      key_id: metadata.key_id,
      key_generation: metadata.key_generation,
      owner: metadata.owner,
      scope: metadata.scope,
      content_identity: metadata.content_identity,
      content_class: metadata.content_class,
      media_type: metadata.media_type,
    });
    if (
      approval === undefined ||
      !Number.isFinite(now) ||
      this.#principalId === null ||
      this.#rootFenceToken === null ||
      approval.principal_id !== this.#principalId ||
      approval.root_fence_token !== this.#rootFenceToken ||
      Date.parse(approval.issued_at) > now ||
      Date.parse(approval.expires_at) <= now ||
      approval.request_digest !== requestDigest ||
      approval.envelope_aad_hash !== envelopeBinding ||
      approval.key_id !== metadata.key_id ||
      approval.key_generation !== metadata.key_generation ||
      approval.owner.kind !== metadata.owner.kind ||
      approval.owner.id !== metadata.owner.id ||
      approval.owner.generation !== metadata.owner.generation ||
      canonicalJson(approval.scope) !== canonicalJson(metadata.scope)
    ) {
      throw new StorageError("INVALID_INPUT");
    }
    if (this.#admissionTrust === null) {
      this.#keys.verifyAuthoritySignature({
        key_id: approval.key_id,
        key_generation: approval.key_generation,
        authority_key_id: approval.authority_key_id,
        authority_hash: approval.approval_hash,
        signature: approval.signature,
      });
    } else {
      const trust = SecretAdmissionTrustSchema.parse(this.#admissionTrust);
      const revokedAt =
        trust.revoked_at === null ? null : Date.parse(trust.revoked_at);
      const signatureValid = (() => {
        try {
          return verify(
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
      if (
        approval.purpose !== trust.purpose ||
        approval.authority_key_id !== trust.authority_key_id ||
        approval.authority_key_generation !==
          trust.authority_key_generation ||
        Date.parse(approval.issued_at) < Date.parse(trust.valid_from) ||
        Date.parse(approval.expires_at) > Date.parse(trust.expires_at) ||
        (Date.parse(approval.expires_at) -
          Date.parse(approval.issued_at)) /
          1_000 >
          trust.maximum_approval_ttl_seconds ||
        (revokedAt !== null && revokedAt <= now) ||
        !signatureValid
      ) {
        throw new StorageError("INVALID_INPUT");
      }
    }
    const consumed = this.#database
      .prepare(
        `SELECT authority_hash
         FROM secret_authority_consumptions WHERE authority_id = ?`,
      )
      .get(approval.approval_id);
    if (consumed !== undefined) {
      throw new StorageError("AUTHORITY_REPLAY");
    }
  }

  #installOrVerifyReleaseControl(
    controlInput: G6ReleaseControl | null,
    validatedAt: string | undefined,
  ): void {
    const verification = this.#releaseVerification;
    if (verification === null) {
      if (controlInput !== null) {
        throw new StorageError("ENCRYPTION_REQUIRED");
      }
      return;
    }
    if (controlInput === null) {
      throw new StorageError("ENCRYPTION_REQUIRED");
    }
    if (validatedAt === undefined) {
      throw new StorageError("ENCRYPTION_REQUIRED");
    }
    const control = verifyExactG6ReleaseControl({
      control: G6ReleaseControlSchema.parse(controlInput),
      trust: verification.trust,
      runtimeIdentity: verification.runtimeIdentity,
      now: validatedAt,
    });
    const existing = this.#database
      .prepare(
        `SELECT control_hash, control_json
         FROM g6_release_controls LIMIT 1`,
      )
      .get() as
      | { control_hash: string; control_json: string }
      | undefined;
    if (existing !== undefined) {
      if (
        existing.control_hash !== control.control_hash ||
        existing.control_json !== canonicalJson(control)
      ) {
        throw new StorageError("ENCRYPTION_REQUIRED");
      }
      return;
    }
    this.#database
      .prepare(
        `INSERT INTO g6_release_controls (
           control_id, runtime_identity_hash, tested_envelope_digest,
           decision, secret_admission_allowed, control_hash, control_json,
           installed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        control.control_id,
        control.runtime_identity_hash,
        control.tested_envelope_digest,
        control.decision,
        control.secret_admission_allowed ? 1 : 0,
        control.control_hash,
        canonicalJson(control),
        validatedAt,
      );
  }

  #metadataJson(
    row: ReservationRow,
    supplied: SecretEnvelopeMetadata,
  ): string {
    return canonicalJson({
      ...supplied,
      key_id: row.key_id,
      key_generation: Number(row.key_generation),
      nonce_base64url: row.nonce_base64url,
      owner: {
        kind: row.owner_kind,
        id: row.owner_id,
        generation: Number(row.owner_generation),
      },
      keyed_plaintext_commitment: row.keyed_plaintext_commitment,
    });
  }

  #replayReservation(
    row: ReservationRow,
    input: ReserveSecretInput,
  ): ReserveSecretResult {
    if (
      row.operation_id !== input.operation_id ||
      row.request_digest !== input.request_digest ||
      row.owner_kind !== input.owner.kind ||
      row.owner_id !== input.owner.id ||
      Number(row.owner_generation) !== input.owner.generation ||
      row.rotation_id !== (input.rotation_id ?? null) ||
      row.keyed_plaintext_commitment !== input.keyed_plaintext_commitment
    ) {
      throw new StorageError("NONCE_REUSE");
    }
    this.#keys.verifyCommitmentProvider({
      key_id: row.key_id,
      key_generation: Number(row.key_generation),
      commitment_key_id: input.commitment_key_id,
      commitment_verification_tag:
        input.commitment_verification_tag,
    });
    if (row.state === "committed") {
      const receipt = this.#operations.replay(
        row.rotation_id === null
          ? "secret_admit"
          : "key_rotation_item",
        input.operation_id,
        input.request_digest,
      );
      if (receipt === null) {
        throw new StorageError("CORRUPTION");
      }
      return { state: "committed", operation_id: row.operation_id, receipt };
    }
    if (row.state !== "prepared") {
      throw new StorageError("NONCE_REUSE");
    }
    const metadata = SecretEnvelopeMetadataSchema.parse({
      schema_version: "1.0.0",
      envelope_version: 1,
      algorithm: "AES-256-GCM",
      key_id: row.key_id,
      key_generation: Number(row.key_generation),
      nonce_base64url: row.nonce_base64url,
      owner: input.owner,
      scope: input.scope,
      sensitivity: "secret",
      content_identity: input.content_identity,
      content_class: input.owner.kind,
      media_type: input.media_type,
      keyed_plaintext_commitment: input.keyed_plaintext_commitment,
    });
    if (secretAadHash(metadata) !== row.aad_hash) {
      throw new StorageError("NONCE_REUSE");
    }
    return { state: "prepared", operation_id: row.operation_id, metadata };
  }
}
