import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

import type Database from "better-sqlite3";

import { StorageError } from "./errors.js";

export const EXTERNAL_SECRET_THRESHOLD_BYTES = 64 * 1024;

export type EncryptedArtifactFailurePoint =
  | "after_prepare"
  | "after_file_commit";

type ArtifactRow = {
  operation_id: string;
  ciphertext_id: string;
  state: "prepared" | "committed" | "retired";
  relative_path: string;
  temporary_relative_path: string | null;
  ciphertext_hash: string;
  size_bytes: number;
};

export type PreparedEncryptedArtifact =
  | { storage_kind: "inline"; relative_path: null }
  | { storage_kind: "external"; relative_path: string };

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export class EncryptedArtifactStore {
  readonly #database: Database.Database;
  readonly #blobRoot: string;
  readonly #directory: string;
  readonly #quarantine: string;
  readonly #fault:
    | ((point: EncryptedArtifactFailurePoint) => void)
    | undefined;

  constructor(options: {
    database: Database.Database;
    blobRoot: string;
    inspectionOnly?: boolean;
    fault?: (point: EncryptedArtifactFailurePoint) => void;
  }) {
    this.#database = options.database;
    this.#blobRoot = resolve(options.blobRoot);
    this.#directory = join(this.#blobRoot, "encrypted");
    this.#quarantine = join(this.#directory, ".quarantine");
    this.#fault = options.fault;
    if (!(options.inspectionOnly ?? false)) {
      mkdirSync(this.#quarantine, { recursive: true, mode: 0o700 });
      chmodSync(this.#directory, 0o700);
      chmodSync(this.#quarantine, 0o700);
    }
  }

  prepare(input: {
    operation_id: string;
    ciphertext_id: string;
    ciphertext_hash: string;
    ciphertext: Uint8Array;
  }): PreparedEncryptedArtifact {
    if (input.ciphertext.byteLength <= EXTERNAL_SECRET_THRESHOLD_BYTES) {
      return { storage_kind: "inline", relative_path: null };
    }
    if (
      digest(input.ciphertext) !== input.ciphertext_hash ||
      input.ciphertext.byteLength <= EXTERNAL_SECRET_THRESHOLD_BYTES
    ) {
      throw new StorageError("CORRUPTION");
    }
    let row = this.#row(input.ciphertext_id);
    if (row === undefined) {
      const suffix = input.ciphertext_hash.slice("sha256:".length);
      const relativePath = `encrypted/${suffix}`;
      const temporaryRelativePath =
        `encrypted/.${suffix}.${randomUUID()}.tmp`;
      const createdAt = new Date().toISOString();
      this.#database
        .prepare(
          `INSERT INTO encrypted_artifact_operations (
             operation_id, ciphertext_id, state, relative_path,
             temporary_relative_path, ciphertext_hash, size_bytes,
             created_at, updated_at
           ) VALUES (?, ?, 'prepared', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.operation_id,
          input.ciphertext_id,
          relativePath,
          temporaryRelativePath,
          input.ciphertext_hash,
          input.ciphertext.byteLength,
          createdAt,
          createdAt,
        );
      this.#fault?.("after_prepare");
      row = this.#row(input.ciphertext_id);
    }
    if (
      row === undefined ||
      row.operation_id !== input.operation_id ||
      row.ciphertext_hash !== input.ciphertext_hash ||
      Number(row.size_bytes) !== input.ciphertext.byteLength ||
      row.state === "retired"
    ) {
      throw new StorageError("CONFLICT");
    }
    this.#ensureCommittedFile(row, input.ciphertext);
    this.#fault?.("after_file_commit");
    return {
      storage_kind: "external",
      relative_path: row.relative_path,
    };
  }

  markReferenced(ciphertextId: string): void {
    const row = this.#row(ciphertextId);
    if (row === undefined) {
      return;
    }
    if (row.state === "retired") {
      throw new StorageError("CORRUPTION");
    }
    if (row.state === "prepared") {
      this.#database
        .prepare(
          `UPDATE encrypted_artifact_operations
           SET state = 'committed', temporary_relative_path = NULL,
               updated_at = ?
           WHERE ciphertext_id = ? AND state = 'prepared'`,
        )
        .run(new Date().toISOString(), ciphertextId);
    }
  }

  markRetired(ciphertextId: string): void {
    const row = this.#row(ciphertextId);
    if (row === undefined || row.state === "retired") {
      return;
    }
    this.#database
      .prepare(
        `UPDATE encrypted_artifact_operations
         SET state = 'retired', temporary_relative_path = NULL,
             updated_at = ?
         WHERE ciphertext_id = ? AND state IN ('prepared', 'committed')`,
      )
      .run(new Date().toISOString(), ciphertextId);
  }

  read(input: {
    relative_path: string;
    ciphertext_hash: string;
    size_bytes: number;
  }): Buffer {
    const path = this.#absolute(input.relative_path);
    if (!existsSync(path)) {
      throw new StorageError("CORRUPTION");
    }
    const bytes = readFileSync(path);
    if (
      bytes.byteLength !== input.size_bytes ||
      digest(bytes) !== input.ciphertext_hash
    ) {
      throw new StorageError("CORRUPTION");
    }
    return bytes;
  }

  reconcile(): void {
    const rows = this.#database
      .prepare(
        `SELECT operation_id, ciphertext_id, state, relative_path,
                temporary_relative_path, ciphertext_hash, size_bytes
         FROM encrypted_artifact_operations
         ORDER BY created_at, operation_id`,
      )
      .all() as ArtifactRow[];
    for (const row of rows) {
      const reference = this.#database
        .prepare(
          `SELECT storage_kind, external_relative_path, retired_at
           FROM encrypted_contents WHERE ciphertext_id = ?`,
        )
        .get(row.ciphertext_id) as
        | {
            storage_kind: string;
            external_relative_path: string | null;
            retired_at: string | null;
          }
        | undefined;
      const liveReference =
        reference?.storage_kind === "external" &&
        reference.external_relative_path === row.relative_path &&
        reference.retired_at === null;
      if (liveReference) {
        this.read({
          relative_path: row.relative_path,
          ciphertext_hash: row.ciphertext_hash,
          size_bytes: Number(row.size_bytes),
        });
        if (row.state === "retired") {
          throw new StorageError("CORRUPTION");
        }
        this.markReferenced(row.ciphertext_id);
        this.#removeRelative(row.temporary_relative_path);
        continue;
      }
      if (row.state === "prepared" && reference === undefined) {
        this.#removeRelative(row.temporary_relative_path);
        this.#removeRelative(row.relative_path);
        continue;
      }
      this.#removeRelative(row.temporary_relative_path);
      this.#removeRelative(row.relative_path);
      this.markRetired(row.ciphertext_id);
    }
    const registered = new Set(
      rows.flatMap((row) =>
        [row.relative_path, row.temporary_relative_path].filter(
          (value): value is string => value !== null,
        ),
      ),
    );
    for (const entry of readdirSync(this.#directory, {
      withFileTypes: true,
    })) {
      if (!entry.isFile()) {
        continue;
      }
      const relativePath = `encrypted/${entry.name}`;
      if (registered.has(relativePath)) {
        continue;
      }
      if (
        /^[a-f0-9]{64}$/u.test(entry.name) ||
        /^\.[a-f0-9]{64}\.[A-Za-z0-9-]+\.tmp$/u.test(entry.name)
      ) {
        unlinkSync(join(this.#directory, entry.name));
        continue;
      }
      renameSync(
        join(this.#directory, entry.name),
        join(this.#quarantine, `${randomUUID()}-${basename(entry.name)}`),
      );
    }
    fsyncDirectory(this.#directory);
    fsyncDirectory(this.#quarantine);
  }

  finalizeRetired(): void {
    const rows = this.#database
      .prepare(
        `SELECT operation_id, ciphertext_id, state, relative_path,
                temporary_relative_path, ciphertext_hash, size_bytes
         FROM encrypted_artifact_operations WHERE state = 'retired'`,
      )
      .all() as ArtifactRow[];
    for (const row of rows) {
      this.#removeRelative(row.temporary_relative_path);
      this.#removeRelative(row.relative_path);
    }
    fsyncDirectory(this.#directory);
  }

  #row(ciphertextId: string): ArtifactRow | undefined {
    return this.#database
      .prepare(
        `SELECT operation_id, ciphertext_id, state, relative_path,
                temporary_relative_path, ciphertext_hash, size_bytes
         FROM encrypted_artifact_operations WHERE ciphertext_id = ?`,
      )
      .get(ciphertextId) as ArtifactRow | undefined;
  }

  #ensureCommittedFile(row: ArtifactRow, bytes: Uint8Array): void {
    const destination = this.#absolute(row.relative_path);
    if (existsSync(destination)) {
      const existing = readFileSync(destination);
      if (
        existing.byteLength !== Number(row.size_bytes) ||
        digest(existing) !== row.ciphertext_hash
      ) {
        throw new StorageError("CORRUPTION");
      }
      this.#removeRelative(row.temporary_relative_path);
      return;
    }
    if (row.temporary_relative_path === null) {
      throw new StorageError("CORRUPTION");
    }
    const temporary = this.#absolute(row.temporary_relative_path);
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, destination);
    chmodSync(destination, 0o600);
    fsyncDirectory(this.#directory);
  }

  #removeRelative(relativePath: string | null): void {
    if (relativePath === null) {
      return;
    }
    const path = this.#absolute(relativePath);
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }

  #absolute(relativePath: string): string {
    if (
      !/^encrypted\/[A-Za-z0-9._-]+$/u.test(relativePath) ||
      relativePath.includes("..")
    ) {
      throw new StorageError("CORRUPTION");
    }
    const path = resolve(this.#blobRoot, relativePath);
    if (!path.startsWith(`${this.#directory}/`)) {
      throw new StorageError("CORRUPTION");
    }
    return path;
  }
}
