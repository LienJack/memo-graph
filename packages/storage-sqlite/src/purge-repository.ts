import type Database from "better-sqlite3";

import type { PurgeCounts } from "./protocol.js";

function count(database: Database.Database, table: string): number {
  return Number(
    (
      database
        .prepare(`SELECT count(*) AS count FROM ${table}`)
        .get() as { count: number }
    ).count,
  );
}

export class PurgeRepository {
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  tombstoneEpoch(): number {
    return Number(
      (
        this.#database
          .prepare(
            `SELECT tombstone_epoch
             FROM tombstone_state WHERE singleton = 1`,
          )
          .get() as { tombstone_epoch: number }
      ).tombstone_epoch,
    );
  }

  counts(): PurgeCounts {
    return {
      memory_tombstones: count(this.#database, "memory_tombstones"),
      purge_jobs: count(this.#database, "purge_jobs"),
      purge_store_outcomes: count(this.#database, "purge_store_outcomes"),
      purge_receipts: count(this.#database, "purge_receipts"),
      approval_consumptions: count(
        this.#database,
        "approval_consumptions",
      ),
    };
  }
}
