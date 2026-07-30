import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import {
  CompleteBackupManifestSchema,
  RecoveryMinimumsSchema,
  canonicalJson,
  canonicalSha256,
  canonicalSha256Omitting,
  type CompleteBackupManifest,
  type RecoveryMinimums,
} from "@memo-graph/contracts";
import Database from "better-sqlite3";

import { StorageError } from "./errors.js";
import { keyVerificationTagFromDescriptor } from "./secret-ingress.js";

export const ACCEPTED_RECOVERY_DECISIONS = {
  g3r: {
    status: "GO",
    decision_hash:
      "sha256:54cde9f9b85527a2c3bd4770a6b4f50ee34f66c3b91362502b19d5cbcb43416d",
  },
  g4a: {
    status: "NO-GO",
    decision_hash:
      "sha256:52dc230b6ad1831d070ea9f868e5754180fe903db6a385da2294750cab1f9c8c",
  },
  g4b: {
    status: "NO-GO",
    decision_hash:
      "sha256:8f638f8e685692397f5c309e27a592b703320b9c8c25da59b22e85af1d07f527",
  },
  g5: {
    status: "GO",
    decision_hash:
      "sha256:b22b2aa54d32ed9e0dc644dffac14095fa34ef6e3671782e02db78a6cbae3da8",
  },
  graph_enabled: false,
  vector_enabled: false,
  automatic_learning_publication: false,
} as const;

export const ACCEPTED_RECOVERY_DECISION_SOURCES = {
  g3r: "docs/evaluations/g3r-h3-decision.md",
  g4a: "docs/evaluations/g4a-decision.md",
  g4b: "docs/evaluations/g4b-decision.md",
  g5: "docs/evaluations/g5-decision.md",
} as const;

export function rawFileHash(path: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

export function backupDatabaseLogicalHash(
  path: string,
): `sha256:${string}` {
  return withBackupDatabase(path, (database) => {
    const tables = database
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    const logicalTables = tables.map(({ name }) => {
      const columns = database
        .prepare(`PRAGMA table_info("${name.replaceAll('"', '""')}")`)
        .all() as Array<{
        name: string;
        pk: number;
      }>;
      const orderedColumns = [...columns].sort((left, right) => {
        if (left.pk === 0 && right.pk !== 0) {
          return 1;
        }
        if (left.pk !== 0 && right.pk === 0) {
          return -1;
        }
        return left.pk - right.pk || left.name.localeCompare(right.name);
      });
      const order = orderedColumns
        .map(({ name: column }) => `"${column.replaceAll('"', '""')}"`)
        .join(", ");
      const rows = database
        .prepare(
          `SELECT * FROM "${name.replaceAll('"', '""')}"${
            order.length === 0 ? "" : ` ORDER BY ${order}`
          }`,
        )
        .all()
        .map((row) =>
          Object.fromEntries(
            Object.entries(row as Record<string, unknown>).map(
              ([column, value]) => [
                column,
                Buffer.isBuffer(value)
                  ? { bytes_base64url: value.toString("base64url") }
                  : value,
              ],
            ),
          ),
        );
      return {
        table: name,
        columns: columns.map(({ name: column }) => column),
        rows,
      };
    });
    return canonicalSha256(logicalTables);
  });
}

export function withBackupDatabase<T>(
  path: string,
  operation: (database: Database.Database) => T,
): T {
  const database = new Database(path, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return operation(database);
  } finally {
    database.close();
    for (const sidecar of [`${path}-shm`, `${path}-wal`]) {
      if (existsSync(sidecar)) {
        unlinkSync(sidecar);
      }
    }
  }
}

function fsyncPath(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function sealCompleteBackupManifest(
  value: Record<string, unknown>,
): CompleteBackupManifest {
  return CompleteBackupManifestSchema.parse({
    ...value,
    manifest_hash: canonicalSha256(value),
  });
}

export function writeCompleteBackupManifest(
  directory: string,
  manifest: CompleteBackupManifest,
): string {
  const parsed = CompleteBackupManifestSchema.parse(manifest);
  const path = join(resolve(directory), "manifest.json");
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${canonicalJson(parsed)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, 0o600);
  fsyncPath(resolve(directory));
  return path;
}

export function readCompleteBackupManifest(
  directory: string,
): CompleteBackupManifest {
  try {
    const root = realpathSync(directory);
    const path = join(root, "manifest.json");
    if (
      lstatSync(path).isSymbolicLink() ||
      realpathSync(dirname(path)) !== root
    ) {
      throw new StorageError("CORRUPTION");
    }
    return CompleteBackupManifestSchema.parse(
      JSON.parse(readFileSync(path, "utf8")) as unknown,
    );
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }
    throw new StorageError("CORRUPTION");
  }
}

function filesRecursively(root: string, cursor = root): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(cursor, { withFileTypes: true })) {
    const path = join(cursor, entry.name);
    if (entry.isSymbolicLink()) {
      throw new StorageError("CORRUPTION");
    }
    if (entry.isDirectory()) {
      files.push(...filesRecursively(root, path));
      continue;
    }
    if (!entry.isFile()) {
      throw new StorageError("CORRUPTION");
    }
    files.push(relative(root, path));
  }
  return files.sort();
}

export function verifyCompleteBackupBundle(input: {
  directory: string;
  expectedManifest?: CompleteBackupManifest;
}): CompleteBackupManifest {
  const directory = realpathSync(input.directory);
  const manifest = readCompleteBackupManifest(directory);
  if (
    input.expectedManifest !== undefined &&
    manifest.manifest_hash !== input.expectedManifest.manifest_hash
  ) {
    throw new StorageError("CORRUPTION");
  }
  const expectedFiles = [
    manifest.database.bundle_path,
    "manifest.json",
    ...manifest.artifacts.flatMap(({ bundle_path }) =>
      bundle_path === null ? [] : [bundle_path],
    ),
  ].sort();
  const actualFiles = filesRecursively(directory);
  if (
    expectedFiles.length !== actualFiles.length ||
    expectedFiles.some((path, index) => path !== actualFiles[index])
  ) {
    throw new StorageError("CORRUPTION");
  }
  const databasePath = join(directory, manifest.database.bundle_path);
  if (
    !existsSync(databasePath) ||
    statSync(databasePath).size !== manifest.database.size_bytes ||
    rawFileHash(databasePath) !== manifest.database.raw_hash ||
    backupDatabaseLogicalHash(databasePath) !==
      manifest.database.logical_hash
  ) {
    throw new StorageError("CORRUPTION");
  }
  verifyManifestDatabaseFacts({
    databasePath,
    manifest,
  });
  for (const artifact of manifest.artifacts) {
    if (artifact.storage_kind === "inline") {
      continue;
    }
    if (artifact.bundle_path === null) {
      throw new StorageError("CORRUPTION");
    }
    const path = join(directory, artifact.bundle_path);
    if (
      !existsSync(path) ||
      lstatSync(path).isSymbolicLink() ||
      statSync(path).size !== artifact.size_bytes ||
      rawFileHash(path) !== artifact.raw_hash
    ) {
      throw new StorageError("CORRUPTION");
    }
  }
  return manifest;
}

export function recoveryMinimumsFromManifest(
  manifest: CompleteBackupManifest,
): RecoveryMinimums {
  return RecoveryMinimumsSchema.parse({
    ledger_epoch: manifest.frontiers.ledger_epoch,
    latest_receipt_hash: manifest.frontiers.latest_receipt_hash,
    tombstone_epoch: manifest.frontiers.tombstone_epoch,
    purge_frontier_hash: manifest.frontiers.purge_frontier_hash,
    projection_frontier_hash: canonicalSha256({
      fts: manifest.frontiers.fts_logical_frontier_hash,
      layered: manifest.frontiers.layered_frontier_hash,
      relation: manifest.frontiers.relation_frontier_hash,
    }),
    context_frontier_hash: manifest.frontiers.context_frontier_hash,
    learning_control_epoch: manifest.frontiers.learning_control_epoch,
    learning_release_revision:
      manifest.frontiers.learning_release_revision,
    learning_frontier_hash: manifest.frontiers.learning_frontier_hash,
    required_keys: manifest.encryption.required_keys,
    encryption_frontier_hash:
      manifest.frontiers.encryption_frontier_hash,
    key_live_ciphertexts:
      manifest.encryption.key_live_ciphertexts,
    g6_release_control_hash: manifest.frontiers.g6_release_control_hash,
  });
}

export function verifyManifestDatabaseFacts(input: {
  databasePath: string;
  manifest: CompleteBackupManifest;
}): void {
  const manifest = CompleteBackupManifestSchema.parse(input.manifest);
  withBackupDatabase(input.databasePath, (database) => {
    try {
    const scalar = (sql: string, column: string): number =>
      Number(
        (database.prepare(sql).get() as Record<string, unknown>)[column],
      );
    const migrations = database
      .prepare(
        `SELECT version, name, hash, applied_at
         FROM schema_migrations ORDER BY version`,
      )
      .all();
    const rootIdentity = database
      .prepare(
        `SELECT root_id, principal_id
         FROM recovery_root_identity WHERE singleton = 1`,
      )
      .get();
    const latestReceipt = database
      .prepare(
        `SELECT receipt.receipt_hash
         FROM mutation_receipts AS receipt
         WHERE NOT EXISTS (
           SELECT 1
           FROM json_each(receipt.receipt_json, '$.warnings')
           WHERE value = 'DRY_RUN'
         )
         ORDER BY receipt.resulting_epoch DESC, receipt.receipt_id DESC
         LIMIT 1`,
      )
      .get() as { receipt_hash: string } | undefined;
    const purgeRows = database
      .prepare(
        `SELECT store_id, tombstone_epoch, debt_count, frontier_hash,
                source_purge_job_id
         FROM artifact_purge_frontiers ORDER BY store_id`,
      )
      .all();
    const relationRows = database
      .prepare(
        `SELECT relation_id, current_relation_revision_id, lifecycle
         FROM relation_objects ORDER BY relation_id`,
      )
      .all();
    const contextRows = database
      .prepare(
        `SELECT context_slice_id, frozen_hash
         FROM context_slices ORDER BY context_slice_id`,
      )
      .all();
    const ftsState = database
      .prepare(
        `SELECT status, last_epoch, error_code
         FROM projection_state WHERE projection_name = 'fts'`,
      )
      .get();
    const layered = database
      .prepare(
        `SELECT ledger_epoch, tombstone_epoch, projection_epoch,
                source_frontier_hash, projection_frontier_hash,
                transform_versions_json
         FROM layered_projection_state WHERE singleton = 1`,
      )
      .get() as {
      ledger_epoch: number;
      tombstone_epoch: number;
      projection_epoch: number;
      source_frontier_hash: string | null;
      projection_frontier_hash: string | null;
      transform_versions_json: string;
    };
    const layeredFrontier = {
      schema_version: "1.0.0",
      ledger_epoch: Number(layered.ledger_epoch),
      tombstone_epoch: Number(layered.tombstone_epoch),
      projection_epoch: Number(layered.projection_epoch),
      source_frontier_hash: layered.source_frontier_hash,
      projection_frontier_hash: layered.projection_frontier_hash,
      transform_versions: JSON.parse(layered.transform_versions_json) as unknown,
    };
    const controls = database
      .prepare(
        `SELECT principal_id, status, control_epoch, frontier_hash,
                runtime_identity_hash, configuration_hash, corpus_hash
         FROM learning_control_state ORDER BY principal_id`,
      )
      .all() as Array<{ control_epoch: number }>;
    const pointers = database
      .prepare(
        `SELECT release_slot_hash, active_release_id, pointer_revision,
                pointer_hash
         FROM learning_release_pointers ORDER BY release_slot_hash`,
      )
      .all() as Array<{ pointer_revision: number }>;
    const learningFrontier = {
      control_epoch: Math.max(
        0,
        ...controls.map(({ control_epoch }) => Number(control_epoch)),
      ),
      release_revision: Math.max(
        0,
        ...pointers.map(({ pointer_revision }) =>
          Number(pointer_revision),
        ),
      ),
      frontier_hash: canonicalSha256Omitting(
        { controls, pointers, frontier_hash: null },
        ["frontier_hash"],
      ),
    };
    const monitors = database
      .prepare(
        `SELECT monitor_id, monitor_hash
         FROM learning_monitor_results ORDER BY monitored_at, monitor_id`,
      )
      .all();
    const rollbacks = database
      .prepare(
        `SELECT release_id, release_hash
         FROM learning_release_versions
         WHERE action = 'rollback'
         ORDER BY activated_at, release_id`,
      )
      .all();
    const g6 = database
      .prepare("SELECT control_hash FROM g6_release_controls LIMIT 1")
      .get() as { control_hash: string } | undefined;
    const requiredKeys = database
      .prepare(
        `SELECT k.key_id, k.key_generation, k.state
         FROM encryption_keys AS k
         WHERE k.state IN ('current', 'rotating_to', 'retired')
            OR (
              k.state = 'revoked_or_compromised'
              AND EXISTS (
                SELECT 1
                FROM encrypted_contents AS c
                JOIN encrypted_content_owners AS o
                  ON o.ciphertext_id = c.ciphertext_id
                WHERE c.key_id = k.key_id AND o.active = 1
              )
            )
         ORDER BY k.key_generation, k.key_id`,
      )
      .all();
    const blobArtifacts = (
      database
        .prepare(
          `SELECT content_hash, size_bytes
           FROM artifacts ORDER BY content_hash`,
        )
        .all() as Array<{
        content_hash: `sha256:${string}`;
        size_bytes: number;
      }>
    ).map(({ content_hash, size_bytes }) => ({
      kind: "blob" as const,
      artifact_id: content_hash,
      storage_kind: "external" as const,
      bundle_path:
        `artifacts/blobs/${content_hash.slice("sha256:".length)}`,
      raw_hash: content_hash,
      size_bytes: Number(size_bytes),
    }));
    const ciphertextArtifacts = (
      database
        .prepare(
          `SELECT c.ciphertext_id, c.storage_kind,
                  c.external_relative_path, c.ciphertext_hash,
                  c.ciphertext_size_bytes
           FROM encrypted_contents AS c
           JOIN encrypted_content_owners AS o
             ON o.ciphertext_id = c.ciphertext_id
           WHERE c.retired_at IS NULL AND o.active = 1
           GROUP BY c.ciphertext_id
           ORDER BY c.ciphertext_id`,
        )
        .all() as Array<{
        ciphertext_id: string;
        storage_kind: "inline" | "external";
        external_relative_path: string | null;
        ciphertext_hash: `sha256:${string}`;
        ciphertext_size_bytes: number;
      }>
    ).map((ciphertext) => {
      if (
        (ciphertext.storage_kind === "external" &&
          ciphertext.external_relative_path === null) ||
        (ciphertext.storage_kind === "inline" &&
          ciphertext.external_relative_path !== null)
      ) {
        throw new StorageError("CORRUPTION");
      }
      return {
        kind: "ciphertext" as const,
        artifact_id: ciphertext.ciphertext_id,
        storage_kind: ciphertext.storage_kind,
        bundle_path:
          ciphertext.storage_kind === "inline"
            ? null
            : `artifacts/ciphertext/${ciphertext.ciphertext_id.replaceAll(":", "_")}`,
        raw_hash: ciphertext.ciphertext_hash,
        size_bytes: Number(ciphertext.ciphertext_size_bytes),
      };
    });
    const sortArtifacts = <
      T extends { kind: string; artifact_id: string },
    >(artifacts: readonly T[]): T[] =>
      [...artifacts].sort(
        (left, right) =>
          left.kind.localeCompare(right.kind) ||
          left.artifact_id.localeCompare(right.artifact_id),
      );
    const expectedArtifacts = sortArtifacts([
      ...blobArtifacts,
      ...ciphertextArtifacts,
    ]);
    const declaredArtifacts = sortArtifacts(manifest.artifacts);
    const keyStateRows = database
      .prepare(
        `SELECT key_id, key_generation, state, authority_key_id,
                commitment_key_id, created_at, state_changed_at
         FROM encryption_keys ORDER BY key_generation, key_id`,
      )
      .all();
    const rotationRows = database
      .prepare(
        `SELECT rotation_id, old_key_id, new_key_id, state,
                total_items, rewritten_items, request_digest,
                started_at, updated_at, completed_at, receipt_id
         FROM key_rotations ORDER BY started_at, rotation_id`,
      )
      .all();
    const keyReceipts = database
      .prepare(
        `SELECT operation_kind, operation_id, request_digest, receipt_hash
         FROM operational_receipts
         WHERE operation_kind LIKE 'key_%'
            OR operation_kind = 'secret_purge'
         ORDER BY created_at, receipt_id`,
      )
      .all();
    const liveCiphertextRows = database
      .prepare(
        `SELECT c.key_id, count(DISTINCT c.ciphertext_id) AS value
         FROM encrypted_contents AS c
         JOIN encrypted_content_owners AS o
           ON o.ciphertext_id = c.ciphertext_id
         WHERE o.active = 1
         GROUP BY c.key_id`,
      )
      .all() as Array<{ key_id: string; value: number }>;
    const liveCiphertexts = new Map(
      liveCiphertextRows.map(({ key_id, value }) => [
        key_id,
        Number(value),
      ]),
    );
    const keyLiveCiphertexts = keyStateRows.map(
      (row) => ({
        key_id: (row as { key_id: string }).key_id,
        live_ciphertext_count:
          liveCiphertexts.get((row as { key_id: string }).key_id) ?? 0,
      }),
    );
    const expectedFrontiers = {
      ledger_epoch: scalar(
        "SELECT ledger_epoch FROM ledger_state WHERE singleton = 1",
        "ledger_epoch",
      ),
      latest_receipt_hash: latestReceipt?.receipt_hash ?? null,
      tombstone_epoch: scalar(
        "SELECT tombstone_epoch FROM tombstone_state WHERE singleton = 1",
        "tombstone_epoch",
      ),
      purge_frontier_hash: canonicalSha256(purgeRows),
      purge_debt_count: scalar(
        `SELECT coalesce(sum(debt_count), 0) AS value
         FROM artifact_purge_frontiers`,
        "value",
      ),
      fts_frontier_hash: canonicalSha256(ftsState),
      fts_logical_frontier_hash: canonicalSha256({
        last_epoch: Number(
          (ftsState as { last_epoch: number }).last_epoch,
        ),
      }),
      layered_frontier_hash: canonicalSha256(layeredFrontier),
      relation_frontier_hash: canonicalSha256(relationRows),
      context_frontier_hash: canonicalSha256(contextRows),
      learning_control_epoch: learningFrontier.control_epoch,
      learning_release_revision: learningFrontier.release_revision,
      learning_frontier_hash: learningFrontier.frontier_hash,
      learning_pointer_hash: canonicalSha256(pointers),
      learning_monitor_hash:
        monitors.length === 0 ? null : canonicalSha256(monitors),
      learning_rollback_hash:
        rollbacks.length === 0 ? null : canonicalSha256(rollbacks),
      encryption_frontier_hash: canonicalSha256({
        keys: keyStateRows,
        rotations: rotationRows,
        receipts: keyReceipts,
        live_ciphertexts: keyLiveCiphertexts,
      }),
      g6_release_control_hash: g6?.control_hash ?? null,
    };
    if (
      canonicalJson(rootIdentity) !== canonicalJson(manifest.root_identity)
    ) {
      throw new StorageError("INVALID_INPUT");
    }
    if (
      canonicalJson(expectedArtifacts) !==
      canonicalJson(declaredArtifacts)
    ) {
      throw new StorageError("CORRUPTION");
    }
    if (
      canonicalJson(migrations) !== canonicalJson(manifest.schema.migrations) ||
      canonicalSha256(migrations) !== manifest.schema.migration_set_hash
    ) {
      throw new StorageError("MIGRATION_DRIFT");
    }
    if (
      canonicalJson(expectedFrontiers) !==
      canonicalJson(manifest.frontiers)
    ) {
      throw new StorageError("STALE_TOMBSTONE_FRONTIER");
    }
    if (
      canonicalJson(requiredKeys) !==
        canonicalJson(manifest.encryption.required_keys) ||
      canonicalJson(keyLiveCiphertexts) !==
        canonicalJson(manifest.encryption.key_live_ciphertexts)
    ) {
      throw new StorageError("KEY_UNAVAILABLE");
    }
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError("CORRUPTION");
    }
  });
}

export function verifyBackupKeyDescriptors(input: {
  databasePath: string;
  manifest: CompleteBackupManifest;
  descriptors: Readonly<Record<string, number>>;
}): void {
  withBackupDatabase(input.databasePath, (database) => {
    try {
    for (const required of input.manifest.encryption.required_keys) {
      const descriptor = input.descriptors[required.key_id];
      const row = database
        .prepare(
          `SELECT key_generation, state, verification_tag
           FROM encryption_keys WHERE key_id = ?`,
        )
        .get(required.key_id) as
        | {
            key_generation: number;
            state: string;
            verification_tag: string;
          }
        | undefined;
      if (
        descriptor === undefined ||
        row === undefined ||
        Number(row.key_generation) !== required.key_generation ||
        row.state !== required.state ||
        row.verification_tag !==
          keyVerificationTagFromDescriptor(descriptor)
      ) {
        throw new StorageError("KEY_UNAVAILABLE");
      }
    }
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError("KEY_UNAVAILABLE");
    }
  });
}
