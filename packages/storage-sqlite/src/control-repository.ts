import {
  MutationReceiptSchema,
  approvalGrantMatches,
  canonicalJson,
  canonicalSha256,
  receiptHashIsValid,
  scopeKey,
  sealReceipt,
} from "@memo-graph/contracts";
import type Database from "better-sqlite3";

import { StorageError } from "./errors.js";
import { invalidateLearningTargets } from "./learning-repository.js";
import {
  enqueueProjectionRefresh,
  suppressProjectionDescendants,
} from "./projection-effects.js";
import {
  MemoryControlResultSchema,
  type MemoryControlResult,
  type ParsedMemoryControlCommand,
} from "./protocol.js";

type ControlMemoryRow = {
  memory_id: string;
  principal_id: string;
  scope_kind:
    | "thread"
    | "topic"
    | "scenario"
    | "user"
    | "workspace"
    | "agent";
  scope_id: string;
  lifecycle: MemoryControlResult["lifecycle"];
  current_revision_id: string | null;
  pinned: number;
};

type ExistingControlMutation = {
  request_hash: string;
  receipt_json: string;
  result_json: string | null;
};

function stableIdentifier(prefix: string, value: unknown): string {
  return `${prefix}:${canonicalSha256(value).slice("sha256:".length, 55)}`;
}

export class ControlRepository {
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  replay(
    idempotencyKey: string,
    requestHash: string,
  ): MemoryControlResult | null {
    const existing = this.#readMutation(idempotencyKey);
    return existing === undefined
      ? null
      : this.#parseExisting(existing, requestHash);
  }

  apply(command: ParsedMemoryControlCommand): MemoryControlResult {
    const requestHash = canonicalSha256(command.request);
    const idempotencyKey = command.request.envelope.idempotency_key;
    const existing = this.#readMutation(idempotencyKey);
    if (existing !== undefined) {
      return this.#parseExisting(existing, requestHash);
    }
    return this.#governedWrite(command.request.envelope.tool, () => {
      const repeated = this.#readMutation(idempotencyKey);
      if (repeated !== undefined) {
        return this.#parseExisting(repeated, requestHash);
      }
      const memory = this.#readMemory(command.request.memory_id);
      this.#validateTarget(command, memory);
      if (memory.current_revision_id === null) {
        throw new StorageError("STALE_REVISION");
      }
      if (command.request.envelope.dry_run) {
        return this.#seal({
          command,
          requestHash,
          memory,
          outcome: "DRY_RUN",
          pinned: memory.pinned === 1,
          lifecycle: memory.lifecycle,
          usageRuleId: null,
          projectionJobs: [],
          advanceEpoch: false,
        });
      }
      if (command.approval === null) {
        throw new StorageError("APPROVAL_INVALID");
      }
      this.#validateApproval(command, requestHash);

      const applied = this.#applyEffect(command, memory, requestHash);
      const result = this.#seal({
        command,
        requestHash,
        memory,
        ...applied,
        advanceEpoch: true,
      });
      this.#consumeApproval(
        command,
        requestHash,
        result.receipt.receipt_id,
      );
      return result;
    });
  }

  #applyEffect(
    command: ParsedMemoryControlCommand,
    memory: ControlMemoryRow,
    requestHash: string,
  ): {
    outcome: Exclude<MemoryControlResult["outcome"], "DRY_RUN">;
    pinned: boolean;
    lifecycle: MemoryControlResult["lifecycle"];
    usageRuleId: string | null;
    projectionJobs: string[];
  } {
    const request = command.request;
    const revisionId = memory.current_revision_id as string;
    const occurredAt = request.envelope.requested_at;
    switch (request.envelope.tool) {
      case "memory_pin": {
        if (!("pinned" in request)) {
          throw new StorageError("INVALID_INPUT");
        }
        this.#database
          .prepare(
            `UPDATE memory_objects
             SET pinned = ?, updated_at = ?
             WHERE memory_id = ? AND current_revision_id = ?`,
          )
          .run(
            request.pinned ? 1 : 0,
            occurredAt,
            memory.memory_id,
            revisionId,
          );
        this.#database
          .prepare(
            `INSERT INTO memory_pin_events (
               pin_event_id, memory_id, revision_id, pinned, principal_id,
               actor_authority, reason, occurred_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            stableIdentifier("pin", {
              idempotency_key: request.envelope.idempotency_key,
              request_hash: requestHash,
            }),
            memory.memory_id,
            revisionId,
            request.pinned ? 1 : 0,
            request.envelope.actor_claim.principal_id,
            request.envelope.actor_claim.authority,
            request.envelope.reason,
            occurredAt,
          );
        return {
          outcome: request.pinned ? "PINNED" : "UNPINNED",
          pinned: request.pinned,
          lifecycle: memory.lifecycle,
          usageRuleId: null,
          projectionJobs: [],
        };
      }
      case "memory_usage_set": {
        if (!("effect" in request)) {
          throw new StorageError("INVALID_INPUT");
        }
        const usageRuleId = stableIdentifier("usage", {
          idempotency_key: request.envelope.idempotency_key,
          request_hash: requestHash,
        });
        this.#database
          .prepare(
            `INSERT INTO memory_usage_rules (
               usage_rule_id, memory_id, revision_id, effect,
               context_scope_kind, context_scope_id, principal_id,
               actor_authority, reason, occurred_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            usageRuleId,
            memory.memory_id,
            revisionId,
            request.effect,
            request.context_scope?.kind ?? null,
            request.context_scope?.id ?? null,
            request.envelope.actor_claim.principal_id,
            request.envelope.actor_claim.authority,
            request.envelope.reason,
            occurredAt,
          );
        return {
          outcome:
            request.effect === "allow"
              ? "USAGE_ALLOWED"
              : "USAGE_BLOCKED",
          pinned: memory.pinned === 1,
          lifecycle: memory.lifecycle,
          usageRuleId,
          projectionJobs: [
            request.effect === "block"
              ? suppressProjectionDescendants(this.#database, {
                  causeId: request.envelope.idempotency_key,
                  memoryId: memory.memory_id,
                  revisionId,
                  principalId:
                    request.envelope.actor_claim.principal_id,
                  scope: {
                    kind: memory.scope_kind,
                    id: memory.scope_id,
                  },
                  occurredAt,
                })
              : enqueueProjectionRefresh(this.#database, {
                  causeId: request.envelope.idempotency_key,
                  memoryId: memory.memory_id,
                  revisionId,
                  principalId:
                    request.envelope.actor_claim.principal_id,
                  scope: {
                    kind: memory.scope_kind,
                    id: memory.scope_id,
                  },
                  occurredAt,
                }),
          ],
        };
      }
      case "memory_demote": {
        if (memory.lifecycle !== "active") {
          throw new StorageError("CONFLICT");
        }
        this.#setLifecycle(memory.memory_id, revisionId, "candidate", occurredAt);
        this.#insertStatus(
          request,
          revisionId,
          "demote",
          "candidate",
        );
        return {
          outcome: "DEMOTED",
          pinned: memory.pinned === 1,
          lifecycle: "candidate",
          usageRuleId: null,
          projectionJobs: [
            this.#insertInvalidation(memory.memory_id, occurredAt),
            suppressProjectionDescendants(this.#database, {
              causeId: request.envelope.idempotency_key,
              memoryId: memory.memory_id,
              revisionId,
              principalId:
                request.envelope.actor_claim.principal_id,
              scope: {
                kind: memory.scope_kind,
                id: memory.scope_id,
              },
              occurredAt,
            }),
          ],
        };
      }
      case "memory_revoke": {
        if (memory.lifecycle === "purged") {
          throw new StorageError("CONFLICT");
        }
        this.#setLifecycle(memory.memory_id, revisionId, "revoked", occurredAt);
        invalidateLearningTargets(this.#database, {
          memoryId: memory.memory_id,
          revisionId,
          reason: "revoked",
          tombstoneEpoch: null,
          createdAt: occurredAt,
        });
        this.#insertStatus(
          request,
          revisionId,
          "revoke",
          "revoked",
        );
        return {
          outcome: "REVOKED",
          pinned: memory.pinned === 1,
          lifecycle: "revoked",
          usageRuleId: null,
          projectionJobs: [
            this.#insertInvalidation(memory.memory_id, occurredAt),
            suppressProjectionDescendants(this.#database, {
              causeId: request.envelope.idempotency_key,
              memoryId: memory.memory_id,
              revisionId,
              principalId:
                request.envelope.actor_claim.principal_id,
              scope: {
                kind: memory.scope_kind,
                id: memory.scope_id,
              },
              occurredAt,
            }),
          ],
        };
      }
      default:
        throw new StorageError("INVALID_INPUT");
    }
  }

  #readMemory(memoryId: string): ControlMemoryRow {
    const memory = this.#database
      .prepare(
        `SELECT memory_id, principal_id, scope_kind, scope_id, lifecycle,
                current_revision_id, pinned
         FROM memory_objects WHERE memory_id = ?`,
      )
      .get(memoryId) as ControlMemoryRow | undefined;
    if (memory === undefined) {
      throw new StorageError("INVALID_INPUT");
    }
    return memory;
  }

  #validateTarget(
    command: ParsedMemoryControlCommand,
    memory: ControlMemoryRow,
  ): void {
    const envelope = command.request.envelope;
    if (
      memory.principal_id !== envelope.actor_claim.principal_id ||
      !envelope.scopes.some(
        (scope) =>
          scopeKey(scope) ===
          `${memory.scope_kind}:${memory.scope_id}`,
      )
    ) {
      throw new StorageError("INVALID_INPUT");
    }
    if (memory.current_revision_id !== envelope.expected_revision_id) {
      throw new StorageError("STALE_REVISION");
    }
  }

  #validateApproval(
    command: ParsedMemoryControlCommand,
    requestHash: string,
  ): void {
    const approval = command.approval;
    const approvalId = command.request.envelope.approval_id;
    if (
      approval === null ||
      approvalId === null ||
      !approvalGrantMatches(
        {
          approval_id: approvalId,
          principal_id:
            command.request.envelope.actor_claim.principal_id,
          tool: command.request.envelope.tool,
          safety_class: command.request.envelope.safety_class,
          scopes: command.request.envelope.scopes,
          request_hash: requestHash,
        },
        approval.grant,
        approval.verified_at,
      ) ||
      this.#database
        .prepare(
          "SELECT 1 FROM approval_consumptions WHERE approval_id = ?",
        )
        .get(approvalId) !== undefined
    ) {
      throw new StorageError("APPROVAL_INVALID");
    }
  }

  #consumeApproval(
    command: ParsedMemoryControlCommand,
    requestHash: string,
    receiptId: string,
  ): void {
    const approval = command.approval;
    if (approval === null) {
      throw new StorageError("APPROVAL_INVALID");
    }
    try {
      this.#database
        .prepare(
          `INSERT INTO approval_consumptions (
             approval_id, idempotency_key, request_hash, manifest_hash,
             principal_id, tool, scopes_json, consumed_at, receipt_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          approval.grant.approval_id,
          command.request.envelope.idempotency_key,
          requestHash,
          approval.grant.manifest_hash,
          command.request.envelope.actor_claim.principal_id,
          command.request.envelope.tool,
          canonicalJson(
            [...command.request.envelope.scopes].sort((left, right) =>
              scopeKey(left).localeCompare(scopeKey(right)),
            ),
          ),
          approval.verified_at,
          receiptId,
        );
    } catch {
      throw new StorageError("APPROVAL_INVALID");
    }
  }

  #setLifecycle(
    memoryId: string,
    revisionId: string,
    lifecycle: "candidate" | "revoked",
    occurredAt: string,
  ): void {
    const changed = this.#database
      .prepare(
        `UPDATE memory_objects
         SET lifecycle = ?, context_eligible = 0, updated_at = ?
         WHERE memory_id = ? AND current_revision_id = ?`,
      )
      .run(lifecycle, occurredAt, memoryId, revisionId);
    if (changed.changes !== 1) {
      throw new StorageError("STALE_REVISION");
    }
  }

  #insertStatus(
    request: ParsedMemoryControlCommand["request"],
    revisionId: string,
    action: "demote" | "revoke",
    lifecycle: "candidate" | "revoked",
  ): void {
    this.#database
      .prepare(
        `INSERT INTO memory_status_events (
           status_event_id, memory_id, revision_id, action, lifecycle,
           principal_id, actor_authority, reason, tombstone_epoch,
           occurred_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        stableIdentifier("status", {
          idempotency_key: request.envelope.idempotency_key,
          action,
        }),
        request.memory_id,
        revisionId,
        action,
        lifecycle,
        request.envelope.actor_claim.principal_id,
        request.envelope.actor_claim.authority,
        request.envelope.reason,
        request.envelope.requested_at,
      );
  }

  #insertInvalidation(memoryId: string, createdAt: string): string {
    const jobId = stableIdentifier("job", {
      kind: "fts_memory_invalidate",
      memory_id: memoryId,
      created_at: createdAt,
    });
    this.#database
      .prepare(
        `INSERT INTO outbox_jobs (
           job_id, kind, aggregate_id, status, attempts, available_at,
           created_at
         ) VALUES (?, 'fts_memory_invalidate', ?, 'pending', 0, ?, ?)`,
      )
      .run(jobId, memoryId, createdAt, createdAt);
    this.#database
      .prepare(
        `UPDATE projection_state
         SET status = 'pending', updated_at = ?, error_code = NULL
         WHERE projection_name = 'memory_fts'`,
      )
      .run(createdAt);
    return jobId;
  }

  #seal(options: {
    command: ParsedMemoryControlCommand;
    requestHash: string;
    memory: ControlMemoryRow;
    outcome: MemoryControlResult["outcome"];
    pinned: boolean;
    lifecycle: MemoryControlResult["lifecycle"];
    usageRuleId: string | null;
    projectionJobs: string[];
    advanceEpoch: boolean;
  }): MemoryControlResult {
    const request = options.command.request;
    if (options.advanceEpoch) {
      this.#database
        .prepare(
          `UPDATE ledger_state
           SET ledger_epoch = ledger_epoch + 1, updated_at = ?
           WHERE singleton = 1`,
        )
        .run(request.envelope.requested_at);
    }
    const epoch = Number(
      (
        this.#database
          .prepare(
            "SELECT ledger_epoch FROM ledger_state WHERE singleton = 1",
          )
          .get() as { ledger_epoch: number }
      ).ledger_epoch,
    );
    const receipt = MutationReceiptSchema.parse(
      sealReceipt({
        schema_version: "1.0.0",
        receipt_id: stableIdentifier("receipt", {
          idempotency_key: request.envelope.idempotency_key,
          request_hash: options.requestHash,
        }),
        created_at: request.envelope.requested_at,
        state:
          options.projectionJobs.length > 0
            ? "projection_pending"
            : "durable",
        request_hash: options.requestHash,
        receipt_hash: `sha256:${"0".repeat(64)}`,
        kind: "mutation",
        idempotency_key: request.envelope.idempotency_key,
        affected_memory_ids: options.advanceEpoch ? [options.memory.memory_id] : [],
        affected_revision_ids:
          options.advanceEpoch &&
          options.memory.current_revision_id !== null
            ? [options.memory.current_revision_id]
            : [],
        resulting_epoch: epoch,
        projection_jobs: options.projectionJobs,
        warnings: options.advanceEpoch ? [] : ["DRY_RUN"],
      }),
    );
    const result = MemoryControlResultSchema.parse({
      receipt,
      replayed: false,
      outcome: options.outcome,
      memory_id: options.memory.memory_id,
      current_revision_id: options.memory.current_revision_id,
      lifecycle: options.lifecycle,
      pinned: options.pinned,
      usage_rule_id: options.usageRuleId,
    });
    if (options.advanceEpoch) {
      this.#database
        .prepare(
          `INSERT INTO mutation_receipts (
             receipt_id, idempotency_key, request_hash, receipt_hash, state,
             resulting_epoch, receipt_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          receipt.receipt_id,
          receipt.idempotency_key,
          receipt.request_hash,
          receipt.receipt_hash,
          receipt.state,
          receipt.resulting_epoch,
          canonicalJson(receipt),
          receipt.created_at,
        );
      this.#database
        .prepare(
          `INSERT INTO idempotency_keys (
             idempotency_key, request_hash, receipt_id, created_at
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(
          receipt.idempotency_key,
          receipt.request_hash,
          receipt.receipt_id,
          receipt.created_at,
        );
      this.#database
        .prepare(
          `INSERT INTO receipt_access_scopes (
             receipt_id, receipt_kind, principal_id, scope_kind, scope_id,
             created_at
           ) VALUES (?, 'mutation', ?, ?, ?, ?)`,
        )
        .run(
          receipt.receipt_id,
          request.envelope.actor_claim.principal_id,
          options.memory.scope_kind,
          options.memory.scope_id,
          receipt.created_at,
        );
      this.#database
        .prepare(
          `INSERT INTO governance_mutation_results (
             receipt_id, result_json, created_at
           ) VALUES (?, ?, ?)`,
        )
        .run(
          receipt.receipt_id,
          canonicalJson(result),
          receipt.created_at,
        );
    }
    return result;
  }

  #readMutation(
    idempotencyKey: string,
  ): ExistingControlMutation | undefined {
    return this.#database
      .prepare(
        `SELECT i.request_hash, r.receipt_json, g.result_json
         FROM idempotency_keys AS i
         JOIN mutation_receipts AS r ON r.receipt_id = i.receipt_id
         LEFT JOIN governance_mutation_results AS g
           ON g.receipt_id = r.receipt_id
         WHERE i.idempotency_key = ?`,
      )
      .get(idempotencyKey) as ExistingControlMutation | undefined;
  }

  #parseExisting(
    existing: ExistingControlMutation,
    requestHash: string,
  ): MemoryControlResult {
    if (
      existing.request_hash !== requestHash ||
      existing.result_json === null
    ) {
      throw new StorageError("CONFLICT");
    }
    const receipt = MutationReceiptSchema.parse(
      JSON.parse(existing.receipt_json) as unknown,
    );
    const result = MemoryControlResultSchema.parse(
      JSON.parse(existing.result_json) as unknown,
    );
    if (
      !receiptHashIsValid(receipt) ||
      result.receipt.receipt_hash !== receipt.receipt_hash
    ) {
      throw new StorageError("CORRUPTION");
    }
    return { ...result, replayed: true };
  }

  #governedWrite<T>(operation: string, effect: () => T): T {
    return this.#database
      .transaction(() => {
        this.#database
          .prepare(
            `INSERT INTO governance_write_guard (
               singleton, operation, opened_at
             ) VALUES (1, ?, ?)`,
          )
          .run(operation, new Date().toISOString());
        try {
          return effect();
        } finally {
          this.#database
            .prepare(
              "DELETE FROM governance_write_guard WHERE singleton = 1",
            )
            .run();
        }
      })
      .immediate();
  }
}
