import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type Database from "better-sqlite3";

import { StorageError } from "./errors.js";
import type { MigrationEvidence } from "./protocol.js";

type MigrationFile = {
  version: string;
  name: string;
  hash: `sha256:${string}`;
  sql: string;
};

export type OperationalMigrationFailurePoint =
  | "plaintext_guard"
  | "encrypted_storage_schema"
  | "purge_registry"
  | "operational_authority"
  | "release_control"
  | "commit";

const OPERATIONAL_MIGRATION_PHASES = [
  "plaintext_guard",
  "encrypted_storage_schema",
  "purge_registry",
  "operational_authority",
  "release_control",
] as const satisfies readonly OperationalMigrationFailurePoint[];

function sha256(content: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function discoverMigrations(migrationsDir: string): MigrationFile[] {
  const migrations = readdirSync(migrationsDir)
    .map((name) => {
      const match = /^(?<version>\d{4})-.+\.sql$/u.exec(name);
      if (match?.groups?.version === undefined) {
        return null;
      }
      const sql = readFileSync(join(migrationsDir, name), "utf8");
      return {
        version: match.groups.version,
        name,
        hash: sha256(sql),
        sql,
      };
    })
    .filter((migration): migration is MigrationFile => migration !== null)
    .sort((left, right) => left.version.localeCompare(right.version));

  if (migrations.length === 0) {
    throw new StorageError("MIGRATION_DRIFT");
  }

  migrations.forEach((migration, index) => {
    const expected = String(index + 1).padStart(4, "0");
    if (migration.version !== expected) {
      throw new StorageError("MIGRATION_DRIFT");
    }
  });
  return migrations;
}

function runOperationalMigration(
  database: Database.Database,
  sql: string,
  onFailurePoint?: (point: OperationalMigrationFailurePoint) => void,
): void {
  const checkpointPattern =
    /^-- TRELLIS_MIGRATION_CHECKPOINT:(?<point>[a-z_]+)\s*$/gmu;
  let sqlStart = 0;
  const observed: OperationalMigrationFailurePoint[] = [];

  for (const match of sql.matchAll(checkpointPattern)) {
    const point = match.groups?.point as
      | OperationalMigrationFailurePoint
      | undefined;
    if (
      point === undefined ||
      point === "commit" ||
      !OPERATIONAL_MIGRATION_PHASES.includes(point)
    ) {
      throw new StorageError("MIGRATION_DRIFT");
    }
    database.exec(sql.slice(sqlStart, match.index));
    observed.push(point);
    onFailurePoint?.(point);
    sqlStart = (match.index ?? 0) + match[0].length;
  }
  database.exec(sql.slice(sqlStart));

  if (
    observed.length !== OPERATIONAL_MIGRATION_PHASES.length ||
    observed.some(
      (point, index) => point !== OPERATIONAL_MIGRATION_PHASES[index],
    )
  ) {
    throw new StorageError("MIGRATION_DRIFT");
  }
}

function bootstrapMigrationLedger(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      hash TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;

    CREATE TRIGGER IF NOT EXISTS schema_migrations_no_update
    BEFORE UPDATE ON schema_migrations BEGIN
      SELECT RAISE(ABORT, 'APPEND_ONLY:schema_migrations');
    END;

    CREATE TRIGGER IF NOT EXISTS schema_migrations_no_delete
    BEFORE DELETE ON schema_migrations BEGIN
      SELECT RAISE(ABORT, 'APPEND_ONLY:schema_migrations');
    END;
  `);
}

export function applyMigrations(
  database: Database.Database,
  migrationsDir: string,
  options: {
    operationalFailure?: (
      point: OperationalMigrationFailurePoint,
    ) => void;
  } = {},
): MigrationEvidence[] {
  const available = discoverMigrations(migrationsDir);
  bootstrapMigrationLedger(database);

  const applied = database
    .prepare(
      "SELECT version, name, hash, applied_at FROM schema_migrations ORDER BY version",
    )
    .all() as MigrationEvidence[];

  if (applied.length > available.length) {
    throw new StorageError("MIGRATION_DRIFT");
  }

  for (let index = 0; index < applied.length; index += 1) {
    const recorded = applied[index];
    const candidate = available[index];
    if (
      recorded === undefined ||
      candidate === undefined ||
      recorded.version !== candidate.version ||
      recorded.name !== candidate.name ||
      recorded.hash !== candidate.hash
    ) {
      throw new StorageError("MIGRATION_DRIFT");
    }
  }

  const insert = database.prepare(`
    INSERT INTO schema_migrations (version, name, hash, applied_at)
    VALUES (?, ?, ?, ?)
  `);

  for (const migration of available.slice(applied.length)) {
    try {
      database
        .transaction(() => {
          if (migration.version === "0015") {
            runOperationalMigration(
              database,
              migration.sql,
              options.operationalFailure,
            );
          } else {
            database.exec(migration.sql);
          }
          insert.run(
            migration.version,
            migration.name,
            migration.hash,
            new Date().toISOString(),
          );
        })
        .immediate();
      if (migration.version === "0015") {
        options.operationalFailure?.("commit");
      }
    } catch (error) {
      if (
        migration.version === "0015" &&
        error instanceof Error &&
        (error.message.includes("operational_secret_plaintext_guard") ||
          error.message.includes("secret_rows = 0"))
      ) {
        throw new StorageError("MIGRATION_DRIFT");
      }
      throw error;
    }
  }

  return database
    .prepare(
      "SELECT version, name, hash, applied_at FROM schema_migrations ORDER BY version",
    )
    .all() as MigrationEvidence[];
}

export function verifyAppliedMigrations(
  database: Database.Database,
  migrationsDir: string,
): MigrationEvidence[] {
  const available = discoverMigrations(migrationsDir);
  const ledger = database
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name = 'schema_migrations'`,
    )
    .get();
  if (ledger === undefined) {
    throw new StorageError("MIGRATION_DRIFT");
  }
  const applied = database
    .prepare(
      "SELECT version, name, hash, applied_at FROM schema_migrations ORDER BY version",
    )
    .all() as MigrationEvidence[];
  if (
    applied.length !== available.length ||
    applied.some((recorded, index) => {
      const candidate = available[index];
      return (
        candidate === undefined ||
        recorded.version !== candidate.version ||
        recorded.name !== candidate.name ||
        recorded.hash !== candidate.hash
      );
    })
  ) {
    throw new StorageError("MIGRATION_DRIFT");
  }
  return applied;
}
