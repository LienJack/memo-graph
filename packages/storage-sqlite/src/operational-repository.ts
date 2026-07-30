import type Database from "better-sqlite3";

import {
  EncryptionReceiptSchema,
  canonicalJson,
  canonicalSha256,
  sealReceipt,
  type EncryptionReceipt,
  type CanonicalHash,
} from "@memo-graph/contracts";

import { StorageError } from "./errors.js";

type StoredReceiptRow = {
  request_digest: string;
  receipt_json: string;
};

export class OperationalRepository {
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  replay(
    operation: EncryptionReceipt["operation"],
    operationId: string,
    requestDigest: string,
  ): EncryptionReceipt | null {
    const row = this.#database
      .prepare(
        `SELECT request_digest, receipt_json
         FROM operational_receipts
         WHERE operation_kind = ? AND operation_id = ?`,
      )
      .get(operation, operationId) as StoredReceiptRow | undefined;
    if (row === undefined) {
      return null;
    }
    if (row.request_digest !== requestDigest) {
      throw new StorageError("CONFLICT");
    }
    const receipt = EncryptionReceiptSchema.parse(
      JSON.parse(row.receipt_json) as unknown,
    );
    if (
      receipt.receipt_hash !==
      canonicalSha256(
        Object.fromEntries(
          Object.entries(receipt).filter(([key]) => key !== "receipt_hash"),
        ),
      )
    ) {
      throw new StorageError("CORRUPTION");
    }
    return receipt;
  }

  append(input: {
    operation: EncryptionReceipt["operation"];
    operation_id: string;
    request_digest: CanonicalHash;
    key_ids: string[];
    affected_owner_ids?: string[];
    ciphertext_ids?: string[];
    resulting_key_generation: number;
    created_at: string;
  }): EncryptionReceipt {
    const existing = this.replay(
      input.operation,
      input.operation_id,
      input.request_digest,
    );
    if (existing !== null) {
      return existing;
    }
    const receipt = EncryptionReceiptSchema.parse(
      sealReceipt({
        schema_version: "1.0.0",
        receipt_id: `encryption-receipt:${canonicalSha256({
          operation: input.operation,
          operation_id: input.operation_id,
          request_digest: input.request_digest,
        }).slice("sha256:".length, "sha256:".length + 48)}`,
        created_at: input.created_at,
        state: "durable",
        request_hash: input.request_digest,
        receipt_hash: `sha256:${"0".repeat(64)}`,
        kind: "encryption",
        operation: input.operation,
        operation_id: input.operation_id,
        key_ids: input.key_ids,
        affected_owner_ids: input.affected_owner_ids ?? [],
        ciphertext_ids: input.ciphertext_ids ?? [],
        resulting_key_generation: input.resulting_key_generation,
      }),
    );
    this.#database
      .prepare(
        `INSERT INTO operational_receipts (
           receipt_id, operation_kind, operation_id, request_digest,
           receipt_hash, receipt_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.receipt_id,
        receipt.operation,
        receipt.operation_id,
        receipt.request_hash,
        receipt.receipt_hash,
        canonicalJson(receipt),
        receipt.created_at,
      );
    return receipt;
  }
}
