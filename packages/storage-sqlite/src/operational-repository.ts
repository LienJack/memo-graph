import type Database from "better-sqlite3";

import {
  ArtifactPurgeAuditSchema,
  ArtifactPurgeStoreAuditSchema,
  ArtifactStoreIdSchema,
  EncryptionReceiptSchema,
  OperatorActionReceiptSchema,
  canonicalJson,
  canonicalSha256,
  sealReceipt,
  type ArtifactPurgeAudit,
  type EncryptionReceipt,
  type CanonicalHash,
  type OperatorActionReceipt,
} from "@memo-graph/contracts";

import { StorageError } from "./errors.js";
import {
  OperationalRepairInputSchema,
  OperationalRepairResultSchema,
  OperatorConfirmationBindingSchema,
  type OperationalRepairInput,
  type OperationalRepairResult,
  type CompleteOperationalRepairInput,
} from "./protocol.js";

type StoredReceiptRow = {
  request_digest: string;
  receipt_json: string;
};

type ArtifactStoreRegistryRow = {
  store_id: string;
  store_version: number;
  required_for_purge: number;
};

type ArtifactPurgeFrontierRow = {
  tombstone_epoch: number;
  debt_count: number;
  frontier_hash: string;
  source_purge_job_id: string | null;
};

type StoredPurgeAuditRow = {
  request_hash: string;
  audit_json: string;
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

  auditPurgeArtifacts(input: {
    audit_id: string;
    expected_tombstone_epoch: number;
    checked_at: string;
  }): ArtifactPurgeAudit {
    const requestHash = canonicalSha256(input);
    const existing = this.#database
      .prepare(
        `SELECT request_hash, audit_json
         FROM operational_purge_audits
         WHERE audit_id = ?`,
      )
      .get(input.audit_id) as StoredPurgeAuditRow | undefined;
    if (existing !== undefined) {
      if (existing.request_hash !== requestHash) {
        throw new StorageError("CONFLICT");
      }
      return ArtifactPurgeAuditSchema.parse(
        JSON.parse(existing.audit_json) as unknown,
      );
    }
    const tombstoneEpoch = Number(
      (
        this.#database
          .prepare(
            `SELECT tombstone_epoch
             FROM tombstone_state WHERE singleton = 1`,
          )
          .get() as { tombstone_epoch: number }
      ).tombstone_epoch,
    );
    if (tombstoneEpoch !== input.expected_tombstone_epoch) {
      throw new StorageError("STALE_REVISION");
    }
    const rows = this.#database
      .prepare(
        `SELECT store_id, store_version, required_for_purge
         FROM artifact_store_registry
         ORDER BY rowid`,
      )
      .all() as ArtifactStoreRegistryRow[];
    if (
      rows.length !== ArtifactStoreIdSchema.options.length ||
      rows.some(
        (row, index) =>
          row.store_id !== ArtifactStoreIdSchema.options[index],
      )
    ) {
      throw new StorageError("CORRUPTION");
    }
    const stores = rows.map((row) => {
      const storeId = ArtifactStoreIdSchema.parse(row.store_id);
      const frontier = this.#database
        .prepare(
          `SELECT tombstone_epoch, debt_count, frontier_hash,
                  source_purge_job_id
           FROM artifact_purge_frontiers WHERE store_id = ?`,
        )
        .get(storeId) as ArtifactPurgeFrontierRow | undefined;
      const activeEncryptedContent =
        storeId === "encrypted_content"
          ? Number(
              (
                this.#database
                  .prepare(
                    `SELECT count(*) AS count
                     FROM encrypted_content_owners
                     WHERE active = 1`,
                  )
                  .get() as { count: number }
              ).count,
            )
          : 0;
      const debtCount = Math.max(
        frontier?.debt_count ?? 0,
        activeEncryptedContent,
      );
      const expectedFrontierHash = canonicalSha256({
        store_id: storeId,
        tombstone_epoch: frontier?.tombstone_epoch ?? tombstoneEpoch,
        debt_count: debtCount,
        ...(frontier?.source_purge_job_id === undefined ||
        frontier.source_purge_job_id === null
          ? {}
          : { source_purge_job_id: frontier.source_purge_job_id }),
      });
      const genesis = tombstoneEpoch === 0 && frontier === undefined;
      const frontierValid =
        genesis ||
        (frontier !== undefined &&
          frontier.tombstone_epoch === tombstoneEpoch &&
          frontier.frontier_hash === expectedFrontierHash &&
          activeEncryptedContent === 0);
      const frontierError =
        activeEncryptedContent > 0
          ? "ENCRYPTED_CONTENT_OWNERSHIP_ACTIVE"
          : frontier === undefined
          ? "PURGE_FRONTIER_MISSING"
          : frontier.tombstone_epoch !== tombstoneEpoch
            ? "PURGE_FRONTIER_STALE"
            : "PURGE_FRONTIER_INVALID";
      const disabled =
        storeId === "graph_projection_disabled" ||
        storeId === "vector_projection_disabled";
      const retainedIdentity =
        storeId === "canonical_evidence" ||
        storeId === "canonical_memory";
      const outcome =
        !frontierValid
          ? ("blocked" as const)
          : debtCount > 0
          ? ("retryable" as const)
          : disabled
            ? ("verified_ineligible" as const)
            : retainedIdentity
              ? ("verified_retained_identity_only" as const)
              : ("verified_removed" as const);
      return ArtifactPurgeStoreAuditSchema.parse({
        store_id: storeId,
        store_version: row.store_version,
        required_for_purge: row.required_for_purge === 1,
        outcome,
        debt_count: debtCount,
        frontier_hash:
          frontier?.frontier_hash ??
          canonicalSha256({
            store_id: storeId,
            tombstone_epoch: tombstoneEpoch,
            debt_count: debtCount,
          }),
        checked_at: input.checked_at,
        error_code:
          !frontierValid
            ? frontierError
            : debtCount > 0
              ? "PURGE_DEBT_REMAINS"
              : null,
      });
    });
    const body = {
      schema_version: "1.0.0" as const,
      audit_id: input.audit_id,
      tombstone_epoch: tombstoneEpoch,
      stores,
      completed: stores.every(
        ({ outcome, required_for_purge, debt_count }) =>
          outcome !== "retryable" &&
          outcome !== "blocked" &&
          (!required_for_purge || debt_count === 0),
      ),
    };
    const audit = ArtifactPurgeAuditSchema.parse({
      ...body,
      audit_hash: canonicalSha256(body),
    });
    this.#database
      .transaction(() => {
        this.#database
          .prepare(
            `INSERT INTO operational_purge_audits (
               audit_id, request_hash, tombstone_epoch, audit_hash,
               audit_json, created_at
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            audit.audit_id,
            requestHash,
            audit.tombstone_epoch,
            audit.audit_hash,
            canonicalJson(audit),
            input.checked_at,
          );
      })
      .immediate();
    return audit;
  }

  appendOperatorActionReceipt(
    receiptInput: OperatorActionReceipt,
  ): OperatorActionReceipt {
    const receipt = OperatorActionReceiptSchema.parse(receiptInput);
    const existing = this.#database
      .prepare(
        `SELECT receipt_json FROM operator_action_receipts
         WHERE operation_id = ?`,
      )
      .get(receipt.operation_id) as { receipt_json: string } | undefined;
    if (existing !== undefined) {
      const stored = OperatorActionReceiptSchema.parse(
        JSON.parse(existing.receipt_json) as unknown,
      );
      if (canonicalJson(stored) !== canonicalJson(receipt)) {
        throw new StorageError("CONFLICT");
      }
      return stored;
    }
    this.#database
      .prepare(
        `INSERT INTO operator_action_receipts (
           receipt_id, operation_id, command, intent_hash, confirmation_id,
           receipt_hash, receipt_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.receipt_id,
        receipt.operation_id,
        receipt.command,
        receipt.intent_hash,
        receipt.confirmation_id,
        receipt.receipt_hash,
        canonicalJson(receipt),
        receipt.completed_at,
      );
    return receipt;
  }

  bindOperatorConfirmation(input: unknown) {
    const binding = OperatorConfirmationBindingSchema.parse(input);
    const existing = this.#database
      .prepare(
        `SELECT confirmation_id, operation_id, intent_hash, command,
                parameters_digest, created_at
         FROM operator_confirmation_bindings
         WHERE confirmation_id = ? OR operation_id = ?`,
      )
      .get(binding.confirmation_id, binding.operation_id) as
      | typeof binding
      | undefined;
    if (existing !== undefined) {
      if (canonicalJson(existing) !== canonicalJson(binding)) {
        throw new StorageError("AUTHORITY_REPLAY");
      }
      return existing;
    }
    this.#database
      .prepare(
        `INSERT INTO operator_confirmation_bindings (
           confirmation_id, operation_id, intent_hash, command,
           parameters_digest, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        binding.confirmation_id,
        binding.operation_id,
        binding.intent_hash,
        binding.command,
        binding.parameters_digest,
        binding.created_at,
      );
    return binding;
  }

  inspectRepair(operationId: string): OperationalRepairResult | null {
    const row = this.#database
      .prepare(
        `SELECT operation_id, repair_kind, state, source_frontier_hash,
                artifact_count, relation_count, ledger_epoch,
                result_hash, completed_at
         FROM operational_repair_jobs WHERE operation_id = ?`,
      )
      .get(operationId) as
      | {
          operation_id: string;
          repair_kind:
            | "fts"
            | "layered_projection"
            | "sqlite_relations";
          state: "rebuilding" | "completed" | "blocked";
          source_frontier_hash: string;
          artifact_count: number | null;
          relation_count: number | null;
          ledger_epoch: number | null;
          result_hash: string | null;
          completed_at: string | null;
        }
      | undefined;
    if (row === undefined) {
      return null;
    }
    const repairResult = {
      schema_version: "1.0.0",
      operation_id: row.operation_id,
      repair_kind: row.repair_kind,
      source: "canonical_sqlite",
      state: row.state,
      source_frontier_hash: row.source_frontier_hash,
      artifact_count: row.artifact_count,
      relation_count: row.relation_count,
      ledger_epoch: row.ledger_epoch,
      result_hash: row.result_hash,
      completed_at: row.completed_at,
    };
    return OperationalRepairResultSchema.parse(repairResult);
  }

  prepareRepair(input: OperationalRepairInput): OperationalRepairResult {
    const command = OperationalRepairInputSchema.parse(input);
    const requestHash = canonicalSha256(command);
    const existing = this.#database
      .prepare(
        `SELECT request_hash FROM operational_repair_jobs
         WHERE operation_id = ?`,
      )
      .get(command.operation_id) as { request_hash: string } | undefined;
    if (existing !== undefined) {
      if (existing.request_hash !== requestHash) {
        throw new StorageError("CONFLICT");
      }
      return this.inspectRepair(command.operation_id) ??
        (() => {
          throw new StorageError("CORRUPTION");
        })();
    }
    this.#database
      .transaction(() => {
        this.#database
          .prepare(
            `INSERT INTO operational_repair_jobs (
               operation_id, repair_kind, request_hash, state,
               source_frontier_hash, artifact_count, relation_count,
               ledger_epoch, result_hash, started_at, completed_at
             ) VALUES (
               ?, ?, ?, 'rebuilding', ?, NULL, NULL, NULL, NULL, ?, NULL
             )`,
          )
          .run(
            command.operation_id,
            command.repair_kind,
            requestHash,
            command.expected_frontier_hash,
            command.started_at,
          );
        if (command.repair_kind === "fts") {
          this.#database
            .prepare(
              `UPDATE projection_state
               SET status = 'rebuilding', updated_at = ?,
                   error_code = 'OPERATIONAL_REPAIR_INTERRUPTED'
               WHERE projection_name IN ('fts', 'memory_fts')`,
            )
            .run(command.started_at);
        } else {
          const errorCode =
            command.repair_kind === "layered_projection"
              ? "OPERATIONAL_LAYERED_REPAIR_INTERRUPTED"
              : "OPERATIONAL_RELATION_REPAIR_INTERRUPTED";
          this.#database
            .prepare(
              `INSERT INTO projection_write_guard (
                 singleton, operation, opened_at
               ) VALUES (1, ?, ?)`,
            )
            .run(
              `operational-${command.repair_kind}-repair`,
              command.started_at,
            );
          try {
            this.#database
              .prepare(
                `UPDATE layered_projection_state
                 SET status = 'rebuilding', updated_at = ?,
                     error_code = ?
                 WHERE singleton = 1`,
              )
              .run(command.started_at, errorCode);
            this.#database
              .prepare(
                `UPDATE layered_projection_scope_state
                 SET status = 'rebuilding', updated_at = ?,
                     error_code = ?`,
              )
              .run(command.started_at, errorCode);
          } finally {
            this.#database
              .prepare(
                "DELETE FROM projection_write_guard WHERE singleton = 1",
              )
              .run();
          }
        }
      })
      .immediate();
    return this.inspectRepair(command.operation_id) ??
      (() => {
        throw new StorageError("CORRUPTION");
      })();
  }

  completeRepair(
    input: CompleteOperationalRepairInput,
  ): OperationalRepairResult {
    const command = OperationalRepairInputSchema.parse(input.command);
    const row = this.#database
      .prepare(
        `SELECT request_hash FROM operational_repair_jobs
         WHERE operation_id = ?`,
      )
      .get(command.operation_id) as
      | { request_hash: string }
      | undefined;
    if (row === undefined) {
      throw new StorageError("INVALID_INPUT");
    }
    if (row.request_hash !== canonicalSha256(command)) {
      throw new StorageError("CONFLICT");
    }
    const existing = this.inspectRepair(command.operation_id);
    if (existing === null) {
      throw new StorageError("CORRUPTION");
    }
    if (existing.state === "completed") {
      return existing;
    }
    const resultHash = canonicalSha256({
      operation_id: command.operation_id,
      repair_kind: command.repair_kind,
      source: command.source,
      source_frontier_hash: command.expected_frontier_hash,
      artifact_count: input.artifact_count,
      relation_count: input.relation_count,
      ledger_epoch: input.ledger_epoch,
    });
    this.#database
      .prepare(
        `UPDATE operational_repair_jobs
         SET state = 'completed', artifact_count = ?,
             relation_count = ?, ledger_epoch = ?,
             result_hash = ?, completed_at = ?
         WHERE operation_id = ? AND state = 'rebuilding'`,
      )
      .run(
        input.artifact_count,
        input.relation_count,
        input.ledger_epoch,
        resultHash,
        command.completed_at,
        command.operation_id,
      );
    return this.inspectRepair(command.operation_id) ??
      (() => {
        throw new StorageError("CORRUPTION");
      })();
  }
}
