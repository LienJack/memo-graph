import {
  VectorHitSchema,
  VectorScopeSnapshotSchema,
  canonicalJson,
  type VectorHit,
  type VectorScopeSnapshot,
} from "@memo-graph/contracts";
import { z } from "zod";

type Statement = {
  run(...parameters: unknown[]): { changes: number | bigint };
  get(...parameters: unknown[]): unknown;
  all(...parameters: unknown[]): unknown[];
};

type Database = {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
  open: boolean;
};

type DatabaseConstructor = new (path: string) => Database;

const SearchRowSchema = z
  .object({
    revision_id: z.string().trim().min(1),
    source_content_hash: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/u),
    distance: z.number().finite().min(0).max(2),
  })
  .passthrough();

const MetadataRowSchema = z
  .object({
    snapshot_json: z.string().min(2),
  })
  .passthrough();

export type VectorIndex = {
  replaceScope(
    snapshot: VectorScopeSnapshot,
  ): Promise<VectorScopeSnapshot>;
  deleteScope(): Promise<void>;
  readScopeSnapshot(): Promise<VectorScopeSnapshot | null>;
  search(vector: readonly number[], topK: number): Promise<VectorHit[]>;
  close(): Promise<void>;
};

export class SqliteVecIndex implements VectorIndex {
  readonly #database: Database;
  readonly #dimensions: number;
  readonly #extensionVersion: string;
  #closed = false;
  #transactionDepth = 0;

  private constructor(
    database: Database,
    dimensions: number,
    extensionVersion: string,
  ) {
    this.#database = database;
    this.#dimensions = dimensions;
    this.#extensionVersion = extensionVersion;
  }

  static async open(options: {
    databasePath: string;
    dimensions: number;
  }): Promise<SqliteVecIndex> {
    const dimensions = z.number().int().min(1).max(4_096).parse(
      options.dimensions,
    );
    const sqliteModuleName = "better-sqlite3";
    const vectorModuleName = "sqlite-vec";
    const [sqliteModule, vectorModule] = await Promise.all([
      import(sqliteModuleName) as Promise<{
        default: DatabaseConstructor;
      }>,
      import(vectorModuleName) as Promise<{
        load(database: Database): void;
      }>,
    ]);
    const database = new sqliteModule.default(options.databasePath);
    try {
      vectorModule.load(database);
      database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS vector_scope_metadata (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          snapshot_json TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS vector_source_records (
          revision_id TEXT PRIMARY KEY,
          source_content_hash TEXT NOT NULL,
          embedding BLOB NOT NULL
        ) STRICT;
        CREATE VIRTUAL TABLE IF NOT EXISTS vector_search USING vec0(
          revision_id TEXT PRIMARY KEY,
          embedding FLOAT[${dimensions}] distance_metric=cosine
        );
      `);
      const versionRow = z
        .object({ version: z.string().trim().min(1) })
        .passthrough()
        .parse(
          database.prepare(
            "SELECT vec_version() AS version",
          ).get(),
        );
      if (versionRow.version !== "v0.1.9") {
        throw new Error("sqlite-vec extension identity mismatch");
      }
      return new SqliteVecIndex(
        database,
        dimensions,
        versionRow.version,
      );
    } catch (error) {
      database.close();
      throw error;
    }
  }

  async replaceScope(
    input: VectorScopeSnapshot,
  ): Promise<VectorScopeSnapshot> {
    const snapshot = VectorScopeSnapshotSchema.parse(input);
    if (
      snapshot.records.some(
        (record) => record.vector.length !== this.#dimensions,
      )
    ) {
      throw new Error("vector snapshot dimensions do not match the index");
    }
    await this.runInTransaction(async () => {
      this.#assertOpen();
      this.#database.exec(`
        DELETE FROM vector_search;
        DELETE FROM vector_source_records;
        DELETE FROM vector_scope_metadata;
      `);
      const insertSource = this.#database.prepare(`
        INSERT INTO vector_source_records(
          revision_id,
          source_content_hash,
          embedding
        ) VALUES (?, ?, ?)
      `);
      const insertVector = this.#database.prepare(`
        INSERT INTO vector_search(revision_id, embedding)
        VALUES (?, ?)
      `);
      for (const record of snapshot.records) {
        const embedding = Float32Array.from(record.vector);
        insertSource.run(
          record.revision_id,
          record.source_content_hash,
          Buffer.from(embedding.buffer),
        );
        insertVector.run(record.revision_id, embedding);
      }
      this.#database.prepare(`
        INSERT INTO vector_scope_metadata(singleton, snapshot_json)
        VALUES (1, ?)
      `).run(canonicalJson(snapshot));
    });
    return snapshot;
  }

  extensionVersion(): string {
    return this.#extensionVersion;
  }

  async deleteScope(): Promise<void> {
    this.#assertOpen();
    this.#database.exec(`
      DELETE FROM vector_search;
      DELETE FROM vector_source_records;
      DELETE FROM vector_scope_metadata;
    `);
  }

  async readScopeSnapshot(): Promise<VectorScopeSnapshot | null> {
    this.#assertOpen();
    const row = this.#database.prepare(`
      SELECT snapshot_json
      FROM vector_scope_metadata
      WHERE singleton = 1
    `).get();
    if (row === undefined) {
      return null;
    }
    const parsed = MetadataRowSchema.parse(row);
    return VectorScopeSnapshotSchema.parse(
      JSON.parse(parsed.snapshot_json) as unknown,
    );
  }

  async search(
    vectorInput: readonly number[],
    topKInput: number,
  ): Promise<VectorHit[]> {
    this.#assertOpen();
    const vector = z
      .array(z.number().finite())
      .length(this.#dimensions)
      .parse(vectorInput);
    const topK = z.number().int().min(1).max(100).parse(topKInput);
    const countRow = this.#database.prepare(
      "SELECT count(*) AS count FROM vector_source_records",
    ).get() as { count?: unknown } | undefined;
    const count = Number(countRow?.count ?? 0);
    if (count === 0) {
      return [];
    }
    const rows = this.#database.prepare(`
      SELECT
        vector_search.revision_id,
        vector_source_records.source_content_hash,
        vector_search.distance
      FROM vector_search
      JOIN vector_source_records
        ON vector_source_records.revision_id = vector_search.revision_id
      WHERE vector_search.embedding MATCH ? AND k = ?
      ORDER BY vector_search.distance
    `).all(Float32Array.from(vector), Math.min(topK, count));
    return VectorHitSchema.array().parse(rows.map((row, index) => {
      const parsed = SearchRowSchema.parse(row);
      return {
        revision_id: parsed.revision_id,
        source_content_hash: parsed.source_content_hash,
        distance: parsed.distance,
        rank: index + 1,
      };
    }));
  }

  async runInTransaction<T>(work: () => Promise<T>): Promise<T> {
    this.#assertOpen();
    if (this.#transactionDepth !== 0) {
      return work();
    }
    this.#database.exec("BEGIN IMMEDIATE");
    this.#transactionDepth += 1;
    try {
      const result = await work();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    } finally {
      this.#transactionDepth -= 1;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#database.close();
  }

  #assertOpen(): void {
    if (this.#closed || !this.#database.open) {
      throw new Error("vector index is closed");
    }
  }
}
