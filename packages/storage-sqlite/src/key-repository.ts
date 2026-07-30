import {
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";

import type Database from "better-sqlite3";

import {
  EncryptionKeyInventorySchema,
  type EncryptionKeyInventory,
  type EncryptionReceipt,
  type CanonicalHash,
  KeyRotationProgressSchema,
  type KeyRotationProgress,
} from "@memo-graph/contracts";

import { StorageError } from "./errors.js";
import type { OperationalRepository } from "./operational-repository.js";

type InternalKeyRow = {
  key_id: string;
  key_generation: number;
  state:
    | "current"
    | "rotating_to"
    | "retired"
    | "revoked_or_compromised"
    | "unavailable";
  verification_tag: string;
  authority_key_id: string;
  authority_public_key_base64url: string;
  commitment_key_id: string;
  commitment_verification_tag: string;
  created_at: string;
  state_changed_at: string;
};

export class KeyRepository {
  readonly #database: Database.Database;
  readonly #operations: OperationalRepository;

  constructor(
    database: Database.Database,
    operations: OperationalRepository,
  ) {
    this.#database = database;
    this.#operations = operations;
  }

  inventory(): EncryptionKeyInventory {
    const rows = this.#database
      .prepare(
        `SELECT key_id, key_generation, state, authority_key_id,
                commitment_key_id, created_at, state_changed_at
         FROM encryption_keys ORDER BY key_generation`,
      )
      .all() as Array<
      Omit<
        InternalKeyRow,
        | "verification_tag"
        | "authority_public_key_base64url"
        | "commitment_verification_tag"
      >
    >;
    const rotation = this.#database
      .prepare(
        `SELECT rotation_id, state FROM key_rotations
         WHERE state IN ('prepared', 'in_progress', 'blocked')
         ORDER BY started_at, rotation_id LIMIT 1`,
      )
      .get() as
      | {
          rotation_id: string;
          state: "prepared" | "in_progress" | "blocked";
        }
      | undefined;
    const encryptedContentCount = Number(
      (
        this.#database
          .prepare(
            `SELECT count(*) AS count
             FROM encrypted_content_owners WHERE active = 1`,
          )
          .get() as { count: number }
      ).count,
    );
    return EncryptionKeyInventorySchema.parse({
      keys: rows.map((row) => ({
        key_id: row.key_id,
        generation: Number(row.key_generation),
        state: row.state,
        authority_key_id: row.authority_key_id,
        commitment_key_id: row.commitment_key_id,
        created_at: row.created_at,
        state_changed_at: row.state_changed_at,
      })),
      current_key_id:
        rows.find(({ state }) => state === "current")?.key_id ?? null,
      rotating_to_key_id:
        rows.find(({ state }) => state === "rotating_to")?.key_id ?? null,
      encrypted_content_count: encryptedContentCount,
      rotation_id: rotation?.rotation_id ?? null,
      rotation_state: rotation?.state ?? null,
    });
  }

  installCurrent(input: {
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
  }): EncryptionReceipt {
    const replay = this.#operations.replay(
      "key_install",
      input.operation_id,
      input.request_digest,
    );
    if (replay !== null) {
      return replay;
    }
    return this.#database
      .transaction(() => {
        const repeated = this.#operations.replay(
          "key_install",
          input.operation_id,
          input.request_digest,
        );
        if (repeated !== null) {
          return repeated;
        }
        const count = Number(
          (
            this.#database
              .prepare("SELECT count(*) AS count FROM encryption_keys")
              .get() as { count: number }
          ).count,
        );
        if (count !== 0) {
          throw new StorageError("KEY_STATE_AMBIGUOUS");
        }
        this.#database
          .prepare(
            `INSERT INTO encryption_keys (
               key_id, key_generation, state, verification_tag,
               authority_key_id, authority_public_key_base64url,
               commitment_key_id, commitment_verification_tag, created_at,
               state_changed_at
             ) VALUES (?, ?, 'current', ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.key_id,
            input.key_generation,
            input.verification_tag,
            input.authority_key_id,
            input.authority_public_key_base64url,
            input.commitment_key_id,
            input.commitment_verification_tag,
            input.created_at,
            input.created_at,
          );
        return this.#operations.append({
          operation: "key_install",
          operation_id: input.operation_id,
          request_digest: input.request_digest,
          key_ids: [input.key_id],
          resulting_key_generation: input.key_generation,
          created_at: input.created_at,
        });
      })
      .immediate();
  }

  currentInternal(): InternalKeyRow {
    const rows = this.#database
      .prepare(
        `SELECT key_id, key_generation, state, verification_tag,
                authority_key_id, authority_public_key_base64url,
                commitment_key_id, commitment_verification_tag, created_at,
                state_changed_at
         FROM encryption_keys WHERE state = 'current'`,
      )
      .all() as InternalKeyRow[];
    if (rows.length === 0) {
      throw new StorageError("KEY_UNAVAILABLE");
    }
    if (rows.length !== 1) {
      throw new StorageError("KEY_STATE_AMBIGUOUS");
    }
    const row = rows[0];
    if (row === undefined) {
      throw new StorageError("KEY_UNAVAILABLE");
    }
    return row;
  }

  keyInternal(keyId: string): InternalKeyRow {
    const row = this.#database
      .prepare(
        `SELECT key_id, key_generation, state, verification_tag,
                authority_key_id, authority_public_key_base64url,
                commitment_key_id, commitment_verification_tag, created_at,
                state_changed_at
         FROM encryption_keys WHERE key_id = ?`,
      )
      .get(keyId) as InternalKeyRow | undefined;
    if (row === undefined || row.state === "unavailable") {
      throw new StorageError("KEY_UNAVAILABLE");
    }
    if (row.state === "revoked_or_compromised") {
      throw new StorageError("KEY_REVOKED");
    }
    return row;
  }

  verifyProvider(input: {
    key_id: string;
    key_generation: number;
    verification_tag: string;
    forbidden_authority_public_keys?: readonly string[] | undefined;
  }): void {
    const row = this.#database
      .prepare(
        `SELECT key_id, key_generation, state, verification_tag,
                authority_key_id, authority_public_key_base64url,
                commitment_key_id, commitment_verification_tag, created_at,
                state_changed_at
         FROM encryption_keys WHERE key_id = ?`,
      )
      .get(input.key_id) as InternalKeyRow | undefined;
    if (row === undefined || row.state === "unavailable") {
      throw new StorageError("KEY_UNAVAILABLE");
    }
    if (row.state === "revoked_or_compromised") {
      throw new StorageError("KEY_REVOKED");
    }
    if (
      Number(row.key_generation) !== input.key_generation ||
      row.verification_tag !== input.verification_tag ||
      input.forbidden_authority_public_keys?.includes(
        row.authority_public_key_base64url,
      )
    ) {
      throw new StorageError("KEY_PROVIDER_INVALID");
    }
  }

  verifyCommitmentProvider(input: {
    key_id: string;
    key_generation: number;
    commitment_key_id: string;
    commitment_verification_tag: string;
  }): void {
    const row = this.#database
      .prepare(
        `SELECT key_generation, commitment_key_id,
                commitment_verification_tag
         FROM encryption_keys WHERE key_id = ?`,
      )
      .get(input.key_id) as
      | Pick<
          InternalKeyRow,
          | "key_generation"
          | "commitment_key_id"
          | "commitment_verification_tag"
        >
      | undefined;
    if (
      row === undefined ||
      Number(row.key_generation) !== input.key_generation ||
      row.commitment_key_id !== input.commitment_key_id ||
      row.commitment_verification_tag !== input.commitment_verification_tag
    ) {
      throw new StorageError("KEY_PROVIDER_INVALID");
    }
  }

  verifyAuthoritySignature(input: {
    key_id: string;
    key_generation: number;
    authority_key_id: string;
    authority_hash: string;
    signature: string;
  }): void {
    const row = this.#database
      .prepare(
        `SELECT key_generation, authority_key_id,
                authority_public_key_base64url
         FROM encryption_keys WHERE key_id = ?`,
      )
      .get(input.key_id) as
      | Pick<
          InternalKeyRow,
          | "key_generation"
          | "authority_key_id"
          | "authority_public_key_base64url"
        >
      | undefined;
    if (
      row === undefined ||
      Number(row.key_generation) !== input.key_generation ||
      row.authority_key_id !== input.authority_key_id
    ) {
      throw new StorageError("KEY_PROVIDER_INVALID");
    }
    try {
      const publicKey = createPublicKey({
        key: Buffer.from(row.authority_public_key_base64url, "base64url"),
        format: "der",
        type: "spki",
      });
      if (
        !verifySignature(
          null,
          Buffer.from(input.authority_hash, "utf8"),
          publicKey,
          Buffer.from(input.signature, "base64url"),
        )
      ) {
        throw new StorageError("KEY_PROVIDER_INVALID");
      }
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError("KEY_PROVIDER_INVALID");
    }
  }

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
  }): { progress: KeyRotationProgress; receipt: EncryptionReceipt } {
    const replay = this.#operations.replay(
      "key_rotation_begin",
      input.rotation_id,
      input.request_digest,
    );
    if (replay !== null) {
      return { progress: this.rotation(input.rotation_id), receipt: replay };
    }
    return this.#database
      .transaction(() => {
        const repeated = this.#operations.replay(
          "key_rotation_begin",
          input.rotation_id,
          input.request_digest,
        );
        if (repeated !== null) {
          return {
            progress: this.rotation(input.rotation_id),
            receipt: repeated,
          };
        }
        const current = this.currentInternal();
        const inventory = this.inventory();
        if (
          inventory.rotating_to_key_id !== null ||
          inventory.rotation_id !== null ||
          input.new_key_id === current.key_id ||
          input.new_key_generation <= Number(current.key_generation)
        ) {
          throw new StorageError("KEY_STATE_AMBIGUOUS");
        }
        const items = this.#database
          .prepare(
            `SELECT o.owner_kind, o.owner_id, o.owner_generation,
                    o.ciphertext_id
             FROM encrypted_content_owners AS o
             JOIN encrypted_contents AS c
               ON c.ciphertext_id = o.ciphertext_id
             WHERE o.active = 1 AND c.key_id = ?
             ORDER BY o.owner_kind, o.owner_id`,
          )
          .all(current.key_id) as Array<{
          owner_kind: string;
          owner_id: string;
          owner_generation: number;
          ciphertext_id: string;
        }>;
        this.#database
          .prepare(
            `INSERT INTO encryption_keys (
               key_id, key_generation, state, verification_tag,
               authority_key_id, authority_public_key_base64url,
               commitment_key_id, commitment_verification_tag, created_at,
               state_changed_at
             ) VALUES (?, ?, 'rotating_to', ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.new_key_id,
            input.new_key_generation,
            input.new_verification_tag,
            input.new_authority_key_id,
            input.new_authority_public_key_base64url,
            input.new_commitment_key_id,
            input.new_commitment_verification_tag,
            input.started_at,
            input.started_at,
          );
        this.#database
          .prepare(
            `INSERT INTO key_rotations (
               rotation_id, old_key_id, new_key_id, state, total_items,
               rewritten_items, request_digest, started_at, updated_at,
               completed_at, receipt_id
             ) VALUES (?, ?, ?, 'in_progress', ?, 0, ?, ?, ?, NULL, NULL)`,
          )
          .run(
            input.rotation_id,
            current.key_id,
            input.new_key_id,
            items.length,
            input.request_digest,
            input.started_at,
            input.started_at,
          );
        const insertItem = this.#database.prepare(
          `INSERT INTO key_rotation_items (
             rotation_id, owner_kind, owner_id, owner_generation,
             old_ciphertext_id, new_ciphertext_id, state, rewritten_at
           ) VALUES (?, ?, ?, ?, ?, NULL, 'pending', NULL)`,
        );
        for (const item of items) {
          insertItem.run(
            input.rotation_id,
            item.owner_kind,
            item.owner_id,
            item.owner_generation,
            item.ciphertext_id,
          );
        }
        const receipt = this.#operations.append({
          operation: "key_rotation_begin",
          operation_id: input.rotation_id,
          request_digest: input.request_digest,
          key_ids: [current.key_id, input.new_key_id],
          affected_owner_ids: [],
          ciphertext_ids: [],
          resulting_key_generation: Number(current.key_generation),
          created_at: input.started_at,
        });
        return {
          progress: this.rotation(input.rotation_id),
          receipt,
        };
      })
      .immediate();
  }

  rotation(rotationId: string): KeyRotationProgress {
    const row = this.#database
      .prepare(
        `SELECT rotation_id, state, old_key_id, new_key_id, total_items,
                rewritten_items, request_digest
         FROM key_rotations WHERE rotation_id = ?`,
      )
      .get(rotationId) as
      | {
          rotation_id: string;
          state: string;
          old_key_id: string;
          new_key_id: string;
          total_items: number;
          rewritten_items: number;
          request_digest: string;
        }
      | undefined;
    if (row === undefined) {
      throw new StorageError("INVALID_INPUT");
    }
    return KeyRotationProgressSchema.parse({
      ...row,
      total_items: Number(row.total_items),
      rewritten_items: Number(row.rewritten_items),
    });
  }

  completeRotation(
    rotationId: string,
  ): { progress: KeyRotationProgress; receipt: EncryptionReceipt } {
    const progress = this.rotation(rotationId);
    const operationId = `${rotationId}:complete`;
    const replay = this.#operations.replay(
      "key_rotation_complete",
      operationId,
      progress.request_digest,
    );
    if (replay !== null) {
      return { progress, receipt: replay };
    }
    if (
      progress.state !== "in_progress" ||
      progress.rewritten_items !== progress.total_items
    ) {
      throw new StorageError("ROTATION_INCOMPLETE");
    }
    return this.#database
      .transaction(() => {
        const current = this.rotation(rotationId);
        if (
          current.rewritten_items !== current.total_items ||
          current.state !== "in_progress"
        ) {
          throw new StorageError("ROTATION_INCOMPLETE");
        }
        const changedAt = new Date().toISOString();
        const retiredKey = this.#database
          .prepare(
            `UPDATE encryption_keys
             SET state = 'retired', state_changed_at = ?
             WHERE key_id = ? AND state = 'current'`,
          )
          .run(changedAt, current.old_key_id);
        const promotedKey = this.#database
          .prepare(
            `UPDATE encryption_keys
             SET state = 'current', state_changed_at = ?
             WHERE key_id = ? AND state = 'rotating_to'`,
          )
          .run(changedAt, current.new_key_id);
        if (retiredKey.changes !== 1 || promotedKey.changes !== 1) {
          throw new StorageError("ROTATION_INCOMPLETE");
        }
        const newKey = this.#database
          .prepare(
            "SELECT key_generation FROM encryption_keys WHERE key_id = ?",
          )
          .get(current.new_key_id) as { key_generation: number };
        const receipt = this.#operations.append({
          operation: "key_rotation_complete",
          operation_id: operationId,
          request_digest: current.request_digest,
          key_ids: [current.old_key_id, current.new_key_id],
          resulting_key_generation: Number(newKey.key_generation),
          created_at: changedAt,
        });
        this.#database
          .prepare(
            `UPDATE key_rotations
             SET state = 'completed', updated_at = ?, completed_at = ?,
                 receipt_id = ?
             WHERE rotation_id = ? AND state = 'in_progress'`,
          )
          .run(changedAt, changedAt, receipt.receipt_id, rotationId);
        return { progress: this.rotation(rotationId), receipt };
      })
      .immediate();
  }

  abortRotation(
    rotationId: string,
  ): { progress: KeyRotationProgress; receipt: EncryptionReceipt } {
    const progress = this.rotation(rotationId);
    const operationId = `${rotationId}:abort`;
    const replay = this.#operations.replay(
      "key_rotation_abort",
      operationId,
      progress.request_digest,
    );
    if (replay !== null) {
      return { progress, receipt: replay };
    }
    if (
      (progress.state !== "in_progress" && progress.state !== "blocked") ||
      progress.rewritten_items !== 0
    ) {
      throw new StorageError("ROTATION_INCOMPLETE");
    }
    return this.#database
      .transaction(() => {
        const current = this.rotation(rotationId);
        if (
          (current.state !== "in_progress" && current.state !== "blocked") ||
          current.rewritten_items !== 0
        ) {
          throw new StorageError("ROTATION_INCOMPLETE");
        }
        const changedAt = new Date().toISOString();
        const rotatingKey = this.#database
          .prepare(
            `SELECT state FROM encryption_keys WHERE key_id = ?`,
          )
          .get(current.new_key_id) as
          | { state: InternalKeyRow["state"] }
          | undefined;
        if (rotatingKey?.state === "rotating_to") {
          const unavailable = this.#database
            .prepare(
              `UPDATE encryption_keys
               SET state = 'unavailable', state_changed_at = ?
               WHERE key_id = ? AND state = 'rotating_to'`,
            )
            .run(changedAt, current.new_key_id);
          if (unavailable.changes !== 1) {
            throw new StorageError("ROTATION_INCOMPLETE");
          }
        } else if (
          rotatingKey?.state !== "revoked_or_compromised" &&
          rotatingKey?.state !== "unavailable"
        ) {
          throw new StorageError("ROTATION_INCOMPLETE");
        }
        const rotationUpdate = this.#database
          .prepare(
            `UPDATE key_rotations
             SET state = 'aborted', updated_at = ?
             WHERE rotation_id = ? AND state IN ('in_progress', 'blocked')
               AND rewritten_items = 0`,
          )
          .run(changedAt, rotationId);
        if (rotationUpdate.changes !== 1) {
          throw new StorageError("ROTATION_INCOMPLETE");
        }
        const oldKey = this.keyInternal(current.old_key_id);
        const receipt = this.#operations.append({
          operation: "key_rotation_abort",
          operation_id: operationId,
          request_digest: current.request_digest,
          key_ids: [current.old_key_id, current.new_key_id],
          resulting_key_generation: Number(oldKey.key_generation),
          created_at: changedAt,
        });
        return { progress: this.rotation(rotationId), receipt };
      })
      .immediate();
  }

  revoke(input: {
    operation_id: string;
    request_digest: CanonicalHash;
    key_id: string;
    changed_at: string;
  }): { inventory: EncryptionKeyInventory; receipt: EncryptionReceipt } {
    const replay = this.#operations.replay(
      "key_revoke",
      input.operation_id,
      input.request_digest,
    );
    if (replay !== null) {
      return { inventory: this.inventory(), receipt: replay };
    }
    return this.#database
      .transaction(() => {
        const repeated = this.#operations.replay(
          "key_revoke",
          input.operation_id,
          input.request_digest,
        );
        if (repeated !== null) {
          return { inventory: this.inventory(), receipt: repeated };
        }
        const row = this.#database
          .prepare(
            `SELECT key_id, key_generation, state
             FROM encryption_keys WHERE key_id = ?`,
          )
          .get(input.key_id) as
          | {
              key_id: string;
              key_generation: number;
              state: InternalKeyRow["state"];
            }
          | undefined;
        if (
          row === undefined ||
          row.state === "unavailable"
        ) {
          throw new StorageError("KEY_UNAVAILABLE");
        }
        const revoked = this.#database
          .prepare(
            `UPDATE encryption_keys
             SET state = 'revoked_or_compromised', state_changed_at = ?
             WHERE key_id = ?`,
          )
          .run(input.changed_at, input.key_id);
        if (revoked.changes !== 1) {
          throw new StorageError("KEY_STATE_AMBIGUOUS");
        }
        this.#database
          .prepare(
            `UPDATE key_rotations
             SET state = 'blocked', updated_at = ?
             WHERE state IN ('prepared', 'in_progress')
               AND (old_key_id = ? OR new_key_id = ?)`,
          )
          .run(input.changed_at, input.key_id, input.key_id);
        const receipt = this.#operations.append({
          operation: "key_revoke",
          operation_id: input.operation_id,
          request_digest: input.request_digest,
          key_ids: [input.key_id],
          resulting_key_generation: Number(row.key_generation),
          created_at: input.changed_at,
        });
        return { inventory: this.inventory(), receipt };
      })
      .immediate();
  }
}

export type { InternalKeyRow };
