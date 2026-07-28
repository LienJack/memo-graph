import type Database from "better-sqlite3";

import type {
  ContentReferenceCounts,
  GovernanceCounts,
} from "./protocol.js";

function count(
  database: Database.Database,
  table: string,
  where = "",
): number {
  return Number(
    (
      database
        .prepare(`SELECT count(*) AS count FROM ${table} ${where}`)
        .get() as { count: number }
    ).count,
  );
}

export class GovernanceRepository {
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  counts(): GovernanceCounts {
    return {
      memory_candidates: count(this.#database, "memory_candidates"),
      memory_objects: count(this.#database, "memory_objects"),
      memory_revisions: count(this.#database, "memory_revisions"),
      admission_decisions: count(this.#database, "admission_decisions"),
      conflict_groups: count(this.#database, "memory_conflict_groups"),
      status_events: count(this.#database, "memory_status_events"),
      pin_events: count(this.#database, "memory_pin_events"),
      usage_rules: count(this.#database, "memory_usage_rules"),
    };
  }

  contentReferenceCounts(contentHash: string): ContentReferenceCounts {
    const countHash = (table: string): number =>
      Number(
        (
          this.#database
            .prepare(
              `SELECT count(*) AS count FROM ${table} WHERE content_hash = ?`,
            )
            .get(contentHash) as { count: number }
        ).count,
      );
    const evidenceEvents = countHash("evidence_events");
    const memoryCandidates = countHash("memory_candidates");
    const memoryRevisions = countHash("memory_revisions");
    const artifacts = countHash("artifacts");
    const liveRevisionLinks = Number(
      (
        this.#database
          .prepare(
            `SELECT count(DISTINCT r.revision_id) AS count
             FROM memory_revision_evidence AS re
             JOIN evidence_events AS e
               ON e.evidence_id = re.evidence_id
             JOIN memory_revisions AS r
               ON r.revision_id = re.revision_id
             JOIN memory_objects AS m
               ON m.memory_id = r.memory_id
             WHERE e.content_hash = ?
               AND m.lifecycle = 'active'
               AND r.lifecycle = 'active'`,
          )
          .get(contentHash) as { count: number }
      ).count,
    );

    return {
      content_hash: contentHash,
      evidence_events: evidenceEvents,
      memory_candidates: memoryCandidates,
      memory_revisions: memoryRevisions,
      live_revision_links: liveRevisionLinks,
      artifacts,
      total:
        evidenceEvents + memoryCandidates + memoryRevisions + artifacts,
    };
  }

  governedWrite<T>(operation: string, effect: () => T): T {
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
