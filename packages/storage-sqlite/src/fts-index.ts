import type Database from "better-sqlite3";

import { StorageError } from "./errors.js";
import type {
  DrainFtsResult,
  RebuildFtsResult,
  ParsedSearchEvidenceQuery,
  SearchEvidenceResult,
} from "./protocol.js";

type ProjectionRow = {
  status: "ready" | "pending" | "rebuilding" | "unavailable";
  last_epoch: number;
  error_code: string | null;
};

type EvidenceFtsRow = {
  evidence_id: string;
  scope_kind: string;
  scope_id: string;
  source: string;
  occurred_at: string;
  payload_inline: string;
};

type MemoryFtsRow = {
  memory_id: string;
  revision_id: string;
  principal_id: string;
  scope_kind: string;
  scope_id: string;
  kind: string;
  valid_from: string;
  content_inline: string;
};

const CREATE_FTS_SQL = `
  CREATE VIRTUAL TABLE evidence_fts USING fts5(
    evidence_id UNINDEXED,
    scope_kind UNINDEXED,
    scope_id UNINDEXED,
    source UNINDEXED,
    occurred_at UNINDEXED,
    searchable_text,
    tokenize = 'unicode61 remove_diacritics 2'
  )
`;

function now(): string {
  return new Date().toISOString();
}

function compileQuery(input: string): string {
  const terms = input.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  if (terms.length === 0) {
    throw new StorageError("INVALID_INPUT");
  }
  return terms
    .slice(0, 32)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" AND ");
}

export class FtsIndex {
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
    this.#verifyTable();
  }

  state(): ProjectionRow {
    return this.#database
      .prepare(
        `SELECT status, last_epoch, error_code
         FROM projection_state WHERE projection_name = 'fts'`,
      )
      .get() as ProjectionRow;
  }

  markPending(epoch: number): void {
    this.#database
      .prepare(
        `UPDATE projection_state
         SET status = 'pending', last_epoch = ?, updated_at = ?, error_code = NULL
         WHERE projection_name = 'fts'`,
      )
      .run(epoch, now());
  }

  drain(limit = 1_000): DrainFtsResult {
    const jobs = this.#database
      .prepare(
        `SELECT job_id, kind, aggregate_id
         FROM outbox_jobs
         WHERE kind IN (
           'fts_evidence_upsert',
           'fts_memory_upsert',
           'fts_memory_delete',
           'fts_memory_invalidate'
         )
           AND status IN ('pending', 'failed')
           AND available_at <= ?
         ORDER BY available_at, job_id
         LIMIT ?`,
      )
      .all(now(), limit) as Array<{
      job_id: string;
      kind:
        | "fts_evidence_upsert"
        | "fts_memory_upsert"
        | "fts_memory_delete"
        | "fts_memory_invalidate";
      aggregate_id: string;
    }>;

    let processed = 0;
    let failed = 0;
    const insertFts = this.#database.prepare(
      `INSERT INTO evidence_fts (
         evidence_id, scope_kind, scope_id, source, occurred_at, searchable_text
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const deleteFts = this.#database.prepare(
      "DELETE FROM evidence_fts WHERE evidence_id = ?",
    );
    const readEvidence = this.#database.prepare(
      `SELECT evidence_id, scope_kind, scope_id, source, occurred_at, payload_inline
       FROM evidence_events
       WHERE evidence_id = ? AND payload_storage = 'inline'`,
    );
    const insertMemoryFts = this.#database.prepare(
      `INSERT INTO memory_fts (
         memory_id, revision_id, principal_id, scope_kind, scope_id, kind,
         valid_from, searchable_text
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const deleteMemoryRevision = this.#database.prepare(
      "DELETE FROM memory_fts WHERE revision_id = ?",
    );
    const deleteMemory = this.#database.prepare(
      "DELETE FROM memory_fts WHERE memory_id = ?",
    );
    const readMemory = this.#database.prepare(
      `SELECT o.memory_id, r.revision_id, o.principal_id, r.scope_kind,
              r.scope_id, r.kind, r.valid_from, r.content_inline
       FROM memory_revisions AS r
       JOIN memory_objects AS o
         ON o.memory_id = r.memory_id
        AND o.current_revision_id = r.revision_id
       WHERE r.revision_id = ?
         AND o.lifecycle = 'active'
         AND o.context_eligible = 1
         AND r.lifecycle = 'active'
         AND r.content_storage = 'inline'
         AND EXISTS (
           SELECT 1 FROM admission_decisions AS d
           WHERE d.revision_id = r.revision_id AND d.decision = 'activate'
         )
         AND EXISTS (
           SELECT 1 FROM memory_revision_evidence AS l
           WHERE l.revision_id = r.revision_id
         )
         AND NOT EXISTS (
           SELECT 1
           FROM memory_revision_evidence AS l
           JOIN evidence_events AS e ON e.evidence_id = l.evidence_id
           WHERE l.revision_id = r.revision_id
             AND (
               e.purged_at IS NOT NULL
               OR e.principal_id <> o.principal_id
               OR e.scope_kind <> r.scope_kind
               OR e.scope_id <> r.scope_id
             )
         )
         AND NOT EXISTS (
           SELECT 1 FROM memory_conflict_groups AS c
           WHERE c.logical_key_hash = o.logical_key_hash
             AND c.principal_id = o.principal_id
             AND c.scope_kind = o.scope_kind
             AND c.scope_id = o.scope_id
             AND c.status = 'open'
         )`,
    );
    const markProcessed = this.#database.prepare(
      `UPDATE outbox_jobs
       SET status = 'processed', attempts = attempts + 1,
           processed_at = ?, last_error_code = NULL
       WHERE job_id = ?`,
    );
    const markFailed = this.#database.prepare(
      `UPDATE outbox_jobs
       SET status = 'failed', attempts = attempts + 1,
           last_error_code = 'FTS_UNAVAILABLE'
       WHERE job_id = ?`,
    );

    for (const job of jobs) {
      try {
        this.#database
          .transaction(() => {
            if (job.kind === "fts_evidence_upsert") {
              const evidence = readEvidence.get(
                job.aggregate_id,
              ) as EvidenceFtsRow | undefined;
              deleteFts.run(job.aggregate_id);
              if (evidence !== undefined) {
                insertFts.run(
                  evidence.evidence_id,
                  evidence.scope_kind,
                  evidence.scope_id,
                  evidence.source,
                  evidence.occurred_at,
                  evidence.payload_inline,
                );
              }
            } else if (job.kind === "fts_memory_upsert") {
              const memory = readMemory.get(
                job.aggregate_id,
              ) as MemoryFtsRow | undefined;
              deleteMemoryRevision.run(job.aggregate_id);
              if (memory !== undefined) {
                deleteMemory.run(memory.memory_id);
                insertMemoryFts.run(
                  memory.memory_id,
                  memory.revision_id,
                  memory.principal_id,
                  memory.scope_kind,
                  memory.scope_id,
                  memory.kind,
                  memory.valid_from,
                  memory.content_inline,
                );
              }
            } else if (job.kind === "fts_memory_delete") {
              deleteMemoryRevision.run(job.aggregate_id);
            } else {
              deleteMemory.run(job.aggregate_id);
            }
            markProcessed.run(now(), job.job_id);
          })
          .immediate();
        processed += 1;
      } catch {
        markFailed.run(job.job_id);
        failed += 1;
      }
    }

    const evidenceRemaining = Number(
      (
        this.#database
          .prepare(
            `SELECT count(*) AS count FROM outbox_jobs
             WHERE kind = 'fts_evidence_upsert'
               AND status IN ('pending', 'failed')`,
          )
          .get() as { count: number }
      ).count,
    );
    const memoryRemaining = Number(
      (
        this.#database
          .prepare(
            `SELECT count(*) AS count FROM outbox_jobs
             WHERE kind IN (
               'fts_memory_upsert',
               'fts_memory_delete',
               'fts_memory_invalidate'
             )
               AND status IN ('pending', 'failed')`,
          )
          .get() as { count: number }
      ).count,
    );
    const remaining = evidenceRemaining + memoryRemaining;
    const epoch = this.#ledgerEpoch();
    const projectionState =
      failed > 0 ? "unavailable" : remaining > 0 ? "pending" : "ready";
    this.#database
      .prepare(
        `UPDATE projection_state
         SET status = ?, last_epoch = ?, updated_at = ?, error_code = ?
         WHERE projection_name = 'fts'`,
      )
      .run(
        failed > 0
          ? "unavailable"
          : evidenceRemaining > 0
            ? "pending"
            : "ready",
        epoch,
        now(),
        failed > 0 ? "FTS_UNAVAILABLE" : null,
      );
    this.#database
      .prepare(
        `UPDATE projection_state
         SET status = ?, last_epoch = ?, updated_at = ?, error_code = ?
         WHERE projection_name = 'memory_fts'`,
      )
      .run(
        failed > 0
          ? "unavailable"
          : memoryRemaining > 0
            ? "pending"
            : "ready",
        epoch,
        now(),
        failed > 0 ? "FTS_UNAVAILABLE" : null,
      );

    return {
      processed,
      failed,
      remaining,
      projection_state: projectionState,
    };
  }

  search(input: ParsedSearchEvidenceQuery): SearchEvidenceResult {
    const state = this.state().status;
    if (state !== "ready") {
      const reasonCode = {
        pending: "FTS_PENDING",
        rebuilding: "FTS_REBUILDING",
        unavailable: "FTS_UNAVAILABLE",
      }[state] as
        | "FTS_PENDING"
        | "FTS_REBUILDING"
        | "FTS_UNAVAILABLE";
      return { status: "DEGRADED", reason_code: reasonCode, items: [] };
    }

    try {
      const rows = this.#database
        .prepare(
          `SELECT f.evidence_id, f.scope_kind, f.scope_id, f.source,
                  f.occurred_at, f.searchable_text AS text,
                  bm25(evidence_fts) AS rank
           FROM evidence_fts AS f
           JOIN evidence_events AS e ON e.evidence_id = f.evidence_id
           WHERE evidence_fts MATCH ?
             AND e.principal_id = ?
             AND f.scope_kind = ?
             AND f.scope_id = ?
           ORDER BY rank, f.occurred_at DESC, f.evidence_id
           LIMIT ?`,
        )
        .all(
          compileQuery(input.query),
          input.principal_id,
          input.scope.kind,
          input.scope.id,
          input.limit,
        ) as SearchEvidenceResult["items"];
      if (rows.length === 0) {
        return { status: "NO_MATCH", items: [] };
      }
      return { status: "OK", items: rows };
    } catch {
      this.#database
        .prepare(
          `UPDATE projection_state
           SET status = 'unavailable', updated_at = ?,
               error_code = 'FTS_UNAVAILABLE'
           WHERE projection_name = 'fts'`,
        )
        .run(now());
      return {
        status: "DEGRADED",
        reason_code: "FTS_UNAVAILABLE",
        items: [],
      };
    }
  }

  rebuild(): RebuildFtsResult {
    const epoch = this.#ledgerEpoch();
    this.#database
      .prepare(
        `UPDATE projection_state
         SET status = 'rebuilding', updated_at = ?, error_code = NULL
         WHERE projection_name = 'fts'`,
      )
      .run(now());

    try {
      const indexed = this.#database
        .transaction(() => {
          this.#database.exec("DROP TABLE IF EXISTS evidence_fts");
          this.#database.exec(CREATE_FTS_SQL);
          this.#database.exec("DROP TABLE IF EXISTS memory_fts");
          this.#database.exec(`
            CREATE VIRTUAL TABLE memory_fts USING fts5(
              memory_id UNINDEXED,
              revision_id UNINDEXED,
              principal_id UNINDEXED,
              scope_kind UNINDEXED,
              scope_id UNINDEXED,
              kind UNINDEXED,
              valid_from UNINDEXED,
              searchable_text,
              tokenize = 'unicode61 remove_diacritics 2'
            )
          `);
          this.#database.exec(
            "INSERT INTO evidence_fts(evidence_fts, rank) VALUES('secure-delete', 1)",
          );
          this.#database.exec(
            "INSERT INTO memory_fts(memory_fts, rank) VALUES('secure-delete', 1)",
          );
          this.#database.exec(`
            INSERT INTO evidence_fts (
              evidence_id, scope_kind, scope_id, source, occurred_at,
              searchable_text
            )
            SELECT evidence_id, scope_kind, scope_id, source, occurred_at,
                   payload_inline
            FROM evidence_events
            WHERE payload_storage = 'inline'
            ORDER BY evidence_id
          `);
          this.#database.exec(`
            INSERT INTO memory_fts (
              memory_id, revision_id, principal_id, scope_kind, scope_id,
              kind, valid_from, searchable_text
            )
            SELECT o.memory_id, r.revision_id, o.principal_id, r.scope_kind,
                   r.scope_id, r.kind, r.valid_from, r.content_inline
            FROM memory_objects AS o
            JOIN memory_revisions AS r
              ON r.revision_id = o.current_revision_id
            WHERE o.lifecycle = 'active'
              AND o.context_eligible = 1
              AND r.lifecycle = 'active'
              AND r.content_storage = 'inline'
              AND EXISTS (
                SELECT 1 FROM admission_decisions AS d
                WHERE d.revision_id = r.revision_id
                  AND d.decision = 'activate'
              )
              AND EXISTS (
                SELECT 1 FROM memory_revision_evidence AS l
                WHERE l.revision_id = r.revision_id
              )
              AND NOT EXISTS (
                SELECT 1
                FROM memory_revision_evidence AS l
                JOIN evidence_events AS e ON e.evidence_id = l.evidence_id
                WHERE l.revision_id = r.revision_id
                  AND (
                    e.purged_at IS NOT NULL
                    OR e.principal_id <> o.principal_id
                    OR e.scope_kind <> r.scope_kind
                    OR e.scope_id <> r.scope_id
                  )
              )
              AND NOT EXISTS (
                SELECT 1 FROM memory_conflict_groups AS c
                WHERE c.logical_key_hash = o.logical_key_hash
                  AND c.principal_id = o.principal_id
                  AND c.scope_kind = o.scope_kind
                  AND c.scope_id = o.scope_id
                  AND c.status = 'open'
              )
            ORDER BY r.revision_id
          `);
          this.#database
            .prepare(
              `UPDATE outbox_jobs
               SET status = 'processed', attempts = attempts + 1,
                   processed_at = ?, last_error_code = NULL
               WHERE kind IN (
                 'fts_evidence_upsert',
                 'fts_memory_upsert',
                 'fts_memory_delete',
                 'fts_memory_invalidate'
               )
                 AND status IN ('pending', 'failed')`,
            )
            .run(now());
          this.#database
            .prepare(
              `UPDATE projection_state
               SET status = 'ready', last_epoch = ?, updated_at = ?,
                   error_code = NULL
               WHERE projection_name = 'fts'`,
            )
            .run(epoch, now());
          this.#database
            .prepare(
              `UPDATE projection_state
               SET status = 'ready', last_epoch = ?, updated_at = ?,
                   error_code = NULL
               WHERE projection_name = 'memory_fts'`,
            )
            .run(epoch, now());
          return Number(
            (
              this.#database
                .prepare("SELECT count(*) AS count FROM evidence_fts")
                .get() as { count: number }
            ).count,
          );
        })
        .immediate();
      return { indexed, ledger_epoch: epoch };
    } catch {
      this.#database
        .prepare(
          `UPDATE projection_state
           SET status = 'unavailable', updated_at = ?,
               error_code = 'FTS_UNAVAILABLE'
           WHERE projection_name = 'fts'`,
        )
        .run(now());
      throw new StorageError("FTS_UNAVAILABLE");
    }
  }

  #verifyTable(): void {
    const table = this.#database
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name = 'evidence_fts'`,
      )
      .get();
    if (table === undefined) {
      this.#database
        .prepare(
          `UPDATE projection_state
           SET status = 'unavailable', updated_at = ?,
               error_code = 'FTS_UNAVAILABLE'
           WHERE projection_name = 'fts'`,
        )
        .run(now());
    }
  }

  #ledgerEpoch(): number {
    return Number(
      (
        this.#database
          .prepare(
            "SELECT ledger_epoch FROM ledger_state WHERE singleton = 1",
          )
          .get() as { ledger_epoch: number }
      ).ledger_epoch,
    );
  }
}
