import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

import {
  IdentifierSchema,
  canonicalJson,
  canonicalSha256,
  verifyRecoveryAnchor,
  type CompleteBackupManifest,
} from "@memo-graph/contracts";

import {
  recoveryStateCommitment,
  type RecoveryHeadProvider,
} from "./anchor-coordinator.js";
import {
  ACCEPTED_RECOVERY_DECISIONS,
  recoveryMinimumsFromManifest,
  verifyBackupKeyDescriptors,
  verifyCompleteBackupBundle,
} from "./backup-manifest.js";
import { SqliteStorageClient } from "./client.js";
import { prepareDataRoot } from "./data-root.js";
import { StorageError } from "./errors.js";
import { TargetNameReservation } from "./no-replace-publish.js";
import {
  BackupResultSchema,
  type BackupResult,
  type RestoreVerificationResult,
  type StorageHealth,
} from "./protocol.js";

const PUBLICATION_MARKER = ".verified-publication.json";
const PUBLICATION_INTENT_MARKER = ".verified-publication-intent.json";

export type RestoreBackupOptions = {
  backup: BackupResult;
  dataRoot: string;
  recoveryHeadProvider: RecoveryHeadProvider;
  operationId?: string;
  requiredKeyDescriptors?: Readonly<Record<string, number>>;
  migrationsDir?: string;
  testFaultAt?:
    | "after_key_verification"
    | "after_database_copy"
    | "after_artifact_copy"
    | "after_staging_open"
    | "after_restore_verification"
    | "after_derived_degradation"
    | "after_marker_fsync"
    | "after_staging_close"
    | "after_staging_fsync"
    | "before_publish"
    | "after_publish_parent_fsync"
    | "after_publish_before_response";
};

export type RestoreBackupResult = {
  data_root: string;
  recovery_generation: number;
  recovery_anchor_hash: string;
  minimum_tombstone_epoch: number;
  minimum_learning_control_epoch: number;
  minimum_learning_release_revision: number;
  health: StorageHealth;
  verified_blobs: number;
  verification: RestoreVerificationResult;
  publication: "published" | "reconciled";
};

type PublicationMarker = {
  schema_version: "1.0.0";
  operation_id: string;
  manifest_hash: string;
  recovery_anchor_hash: string;
  marker_hash: string;
};

function fsyncPath(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function injectTestFault(
  options: RestoreBackupOptions,
  point: NonNullable<RestoreBackupOptions["testFaultAt"]>,
): void {
  if (options.testFaultAt === point) {
    throw new StorageError("STORAGE_UNAVAILABLE");
  }
}

function markerFor(input: {
  operationId: string;
  manifestHash: string;
  anchorHash: string;
}): PublicationMarker {
  const body = {
    schema_version: "1.0.0" as const,
    operation_id: input.operationId,
    manifest_hash: input.manifestHash,
    recovery_anchor_hash: input.anchorHash,
  };
  return {
    ...body,
    marker_hash: canonicalSha256(body),
  };
}

function writePublicationMarker(
  root: string,
  marker: PublicationMarker,
  filename = PUBLICATION_MARKER,
): void {
  const path = join(root, filename);
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${canonicalJson(marker)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, 0o600);
  fsyncPath(root);
}

function hasExactPublicationMarker(
  target: string,
  expected: PublicationMarker,
  filename = PUBLICATION_MARKER,
): boolean {
  try {
    const path = join(target, filename);
    if (
      lstatSync(target).isSymbolicLink() ||
      lstatSync(path).isSymbolicLink() ||
      realpathSync(target) !== target
    ) {
      return false;
    }
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PublicationMarker;
    return (
      parsed.schema_version === "1.0.0" &&
      parsed.operation_id === expected.operation_id &&
      parsed.manifest_hash === expected.manifest_hash &&
      parsed.recovery_anchor_hash === expected.recovery_anchor_hash &&
      parsed.marker_hash ===
        canonicalSha256({
          schema_version: parsed.schema_version,
          operation_id: parsed.operation_id,
          manifest_hash: parsed.manifest_hash,
          recovery_anchor_hash: parsed.recovery_anchor_hash,
        }) &&
      canonicalJson(parsed) === canonicalJson(expected)
    );
  } catch {
    return false;
  }
}

function removePublicationIntent(target: string): void {
  rmSync(join(target, PUBLICATION_INTENT_MARKER), { force: true });
  fsyncPath(target);
}

function assertCurrentRecoveryAuthority(input: {
  backup: BackupResult;
  provider: RecoveryHeadProvider;
  manifest: CompleteBackupManifest;
}): void {
  let verified;
  try {
    verified = verifyRecoveryAnchor({
      anchor: input.backup.recovery_anchor,
      expectedAuthorityKeyId: input.provider.authorityKeyId,
      publicKey: input.provider.publicKey,
    });
  } catch {
    throw new StorageError("RECOVERY_AUTHORITY_INVALID");
  }
  const current = input.provider.readCurrent();
  if (current === null) {
    throw new StorageError("RECOVERY_AUTHORITY_INVALID");
  }
  if (
    input.provider.unresolvedPending().length !== 0 ||
    verified.payload.trust_root_version !== input.provider.trustRootVersion
  ) {
    throw new StorageError("RECOVERY_AUTHORITY_INVALID");
  }
  if (
    verified.anchor_hash !== current.anchor_hash ||
    verified.payload.generation !== current.payload.generation ||
    verified.payload.previous_head_hash !== current.payload.previous_head_hash
  ) {
    throw new StorageError("STALE_RECOVERY_HEAD");
  }
  if (
    verified.payload.backup_manifest_hash !== input.manifest.manifest_hash ||
    verified.payload.root_id !== input.manifest.root_identity.root_id ||
    verified.payload.principal_id !==
      input.manifest.root_identity.principal_id ||
    canonicalJson(verified.payload.minimums) !==
      canonicalJson(recoveryMinimumsFromManifest(input.manifest))
  ) {
    throw new StorageError("RECOVERY_AUTHORITY_INVALID");
  }
  if (
    verified.payload.state_commitment_hash !==
    recoveryStateCommitment({
      root_id: input.manifest.root_identity.root_id,
      principal_id: input.manifest.root_identity.principal_id,
      minimums: recoveryMinimumsFromManifest(input.manifest),
    })
  ) {
    throw new StorageError("RECOVERY_AUTHORITY_INVALID");
  }
}

function assertRequiredKeyInventory(
  health: StorageHealth,
  manifest: CompleteBackupManifest,
): void {
  const actual = new Map(
    health.encryption.keys.map((key) => [key.key_id, key]),
  );
  for (const required of manifest.encryption.required_keys) {
    const key = actual.get(required.key_id);
    if (
      key === undefined ||
      key.generation !== required.key_generation ||
      key.state !== required.state
    ) {
      throw new StorageError("KEY_UNAVAILABLE");
    }
  }
}

function assertManifestHealth(
  health: StorageHealth,
  manifest: CompleteBackupManifest,
  verification: RestoreVerificationResult,
): void {
  if (
    health.ledger_epoch !== manifest.frontiers.ledger_epoch ||
    health.tombstone_epoch !== manifest.frontiers.tombstone_epoch ||
    health.latest_receipt_hash !== manifest.frontiers.latest_receipt_hash ||
    health.learning_frontier.control_epoch !==
      manifest.frontiers.learning_control_epoch ||
    health.learning_frontier.release_revision !==
      manifest.frontiers.learning_release_revision ||
    health.learning_frontier.frontier_hash !==
      manifest.frontiers.learning_frontier_hash ||
    canonicalJson(health.migrations) !==
      canonicalJson(manifest.schema.migrations) ||
    verification.verified_artifacts !==
      manifest.artifacts.filter(({ kind }) => kind === "blob").length ||
    verification.verified_encrypted_contents !==
      manifest.artifacts.filter(({ kind }) => kind === "ciphertext").length
  ) {
    throw new StorageError("CORRUPTION");
  }
  assertRequiredKeyInventory(health, manifest);
}

async function inspectPublishedTarget(input: {
  target: string;
  options: RestoreBackupOptions;
  manifest: CompleteBackupManifest;
  publication: "published" | "reconciled";
}): Promise<RestoreBackupResult> {
  const client = await SqliteStorageClient.open({
    dataRoot: input.target,
    secretPrincipalId: input.manifest.root_identity.principal_id,
    recoveryHeadProvider: input.options.recoveryHeadProvider,
    ...(input.options.migrationsDir === undefined
      ? {}
      : { migrationsDir: input.options.migrationsDir }),
  });
  try {
    const health = await client.health();
    const verification = await client.verifyRestoreCandidate();
    assertManifestHealth(health, input.manifest, verification);
    return {
      data_root: input.target,
      recovery_generation:
        input.options.recoveryHeadProvider.readCurrent()?.payload
          .generation ??
        (() => {
          throw new StorageError("RECOVERY_AUTHORITY_INVALID");
        })(),
      recovery_anchor_hash:
        input.options.recoveryHeadProvider.readCurrent()?.anchor_hash ??
        (() => {
          throw new StorageError("RECOVERY_AUTHORITY_INVALID");
        })(),
      minimum_tombstone_epoch: input.manifest.frontiers.tombstone_epoch,
      minimum_learning_control_epoch:
        input.manifest.frontiers.learning_control_epoch,
      minimum_learning_release_revision:
        input.manifest.frontiers.learning_release_revision,
      health,
      verified_blobs: verification.verified_artifacts,
      verification,
      publication: input.publication,
    };
  } finally {
    await client.close();
  }
}

async function finalizePublishedTarget(input: {
  target: string;
  options: RestoreBackupOptions;
  manifest: CompleteBackupManifest;
  operationId: string;
  publication: "published" | "reconciled";
}): Promise<RestoreBackupResult> {
  const client = await SqliteStorageClient.open({
    dataRoot: input.target,
    secretPrincipalId: input.manifest.root_identity.principal_id,
    recoveryHeadProvider: input.options.recoveryHeadProvider,
    ...(input.options.migrationsDir === undefined
      ? {}
      : { migrationsDir: input.options.migrationsDir }),
  });
  try {
    const restoredAt = new Date().toISOString();
    await client.markGraphRestoreUnavailable({ restored_at: restoredAt });
    await client.markVectorRestoreDegraded({ restored_at: restoredAt });
    injectTestFault(input.options, "after_derived_degradation");
    const publicationAnchor =
      input.options.recoveryHeadProvider.readCurrent() ??
      (() => {
        throw new StorageError("RECOVERY_AUTHORITY_INVALID");
      })();
    const marker = markerFor({
      operationId: input.operationId,
      manifestHash: input.manifest.manifest_hash,
      anchorHash: publicationAnchor.anchor_hash,
    });
    const health = await client.health();
    const verification = await client.verifyRestoreCandidate();
    assertManifestHealth(health, input.manifest, verification);
    if (!hasExactPublicationMarker(input.target, marker)) {
      writePublicationMarker(input.target, marker);
    }
    removePublicationIntent(input.target);
    return {
      data_root: input.target,
      recovery_generation: publicationAnchor.payload.generation,
      recovery_anchor_hash: publicationAnchor.anchor_hash,
      minimum_tombstone_epoch: input.manifest.frontiers.tombstone_epoch,
      minimum_learning_control_epoch:
        input.manifest.frontiers.learning_control_epoch,
      minimum_learning_release_revision:
        input.manifest.frontiers.learning_release_revision,
      health,
      verified_blobs: verification.verified_artifacts,
      verification,
      publication: input.publication,
    };
  } finally {
    await client.close();
  }
}

export async function restoreBackupToEmptyDataRoot(
  options: RestoreBackupOptions,
): Promise<RestoreBackupResult> {
  const backup = BackupResultSchema.parse(options.backup);
  const operationId = IdentifierSchema.parse(
    options.operationId ?? backup.backup_id,
  );
  const target = resolve(options.dataRoot);
  if (
    !isAbsolute(options.dataRoot) ||
    target === parse(target).root
  ) {
    throw new StorageError("INVALID_DATA_ROOT");
  }

  const backupDirectory = realpathSync(backup.directory);
  const manifest = verifyCompleteBackupBundle({
    directory: backupDirectory,
    expectedManifest: backup.manifest,
  });
  if (
    canonicalJson(manifest.decisions) !==
      canonicalJson(ACCEPTED_RECOVERY_DECISIONS) ||
    backup.backup_id !== manifest.backup_id ||
    backup.ledger_epoch !== manifest.frontiers.ledger_epoch ||
    backup.tombstone_epoch !== manifest.frontiers.tombstone_epoch ||
    backup.learning_control_epoch !==
      manifest.frontiers.learning_control_epoch ||
    backup.learning_release_revision !==
      manifest.frontiers.learning_release_revision ||
    backup.learning_frontier_hash !==
      manifest.frontiers.learning_frontier_hash ||
    backup.latest_receipt_hash !==
      manifest.frontiers.latest_receipt_hash ||
    backup.size_bytes !== manifest.database.size_bytes ||
    realpathSync(backup.path) !==
      realpathSync(join(backupDirectory, manifest.database.bundle_path)) ||
    realpathSync(backup.manifest_path) !==
      realpathSync(join(backupDirectory, "manifest.json"))
  ) {
    throw new StorageError("CORRUPTION");
  }
  if (
    manifest.encryption.required_keys.length !== 0 &&
    options.requiredKeyDescriptors === undefined
  ) {
    throw new StorageError("KEY_UNAVAILABLE");
  }
  if (options.requiredKeyDescriptors !== undefined) {
    verifyBackupKeyDescriptors({
      databasePath: join(
        backupDirectory,
        manifest.database.bundle_path,
      ),
      manifest,
      descriptors: options.requiredKeyDescriptors,
    });
  }
  injectTestFault(options, "after_key_verification");

  const intentMarker = markerFor({
    operationId,
    manifestHash: manifest.manifest_hash,
    anchorHash: backup.recovery_anchor.anchor_hash,
  });
  if (existsSync(target)) {
    const current = options.recoveryHeadProvider.readCurrent();
    if (current !== null) {
      const currentMarker = markerFor({
        operationId,
        manifestHash: manifest.manifest_hash,
        anchorHash: current.anchor_hash,
      });
      if (
        current.anchor_hash !== backup.recovery_anchor.anchor_hash &&
        hasExactPublicationMarker(target, currentMarker)
      ) {
        return inspectPublishedTarget({
          target,
          options,
          manifest,
          publication: "reconciled",
        });
      }
    }
    if (
      hasExactPublicationMarker(
        target,
        intentMarker,
        PUBLICATION_INTENT_MARKER,
      )
    ) {
      return finalizePublishedTarget({
        target,
        options,
        manifest,
        operationId,
        publication: "reconciled",
      });
    }
    throw new StorageError("TARGET_EXISTS");
  }
  assertCurrentRecoveryAuthority({
    backup,
    provider: options.recoveryHeadProvider,
    manifest,
  });

  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const reservation = TargetNameReservation.acquire(target);
  const staging = join(
    dirname(target),
    `.memo-restore-${randomUUID()}.staging`,
  );
  let client: SqliteStorageClient | undefined;
  try {
    const layout = prepareDataRoot(staging);
    if (
      layout.filesystem_type !==
        manifest.creation_identity.filesystem_type ||
      process.platform !== manifest.creation_identity.platform ||
      process.arch !== manifest.creation_identity.architecture ||
      process.versions.node !== manifest.creation_identity.node_version
    ) {
      throw new StorageError("RECOVERY_AUTHORITY_INVALID");
    }
    const backupDatabase = join(
      backupDirectory,
      manifest.database.bundle_path,
    );
    copyFileSync(backupDatabase, layout.database, constants.COPYFILE_EXCL);
    chmodSync(layout.database, 0o600);
    fsyncPath(layout.database);
    injectTestFault(options, "after_database_copy");

    const encryptedDirectory = join(layout.blobs, "encrypted");
    mkdirSync(encryptedDirectory, { mode: 0o700 });
    for (const artifact of manifest.artifacts) {
      if (artifact.bundle_path === null) {
        continue;
      }
      const source = join(backupDirectory, artifact.bundle_path);
      const destination =
        artifact.kind === "blob"
          ? join(
              layout.blobs,
              artifact.raw_hash.slice("sha256:".length),
            )
          : join(
              encryptedDirectory,
              artifact.raw_hash.slice("sha256:".length),
            );
      copyFileSync(source, destination, constants.COPYFILE_EXCL);
      chmodSync(destination, 0o600);
      fsyncPath(destination);
    }
    fsyncPath(encryptedDirectory);
    fsyncPath(layout.blobs);
    injectTestFault(options, "after_artifact_copy");
    fsyncPath(layout.ledger);
    fsyncPath(layout.root);

    client = await SqliteStorageClient.open({
      dataRoot: layout.root,
      secretPrincipalId: manifest.root_identity.principal_id,
      recoveryHeadProvider: options.recoveryHeadProvider,
      ...(options.migrationsDir === undefined
        ? {}
        : { migrationsDir: options.migrationsDir }),
    });
    injectTestFault(options, "after_staging_open");
    const health = await client.health();
    const verification = await client.verifyRestoreCandidate();
    assertManifestHealth(health, manifest, verification);
    injectTestFault(options, "after_restore_verification");
    writePublicationMarker(
      layout.root,
      intentMarker,
      PUBLICATION_INTENT_MARKER,
    );
    injectTestFault(options, "after_marker_fsync");
    await client.close();
    client = undefined;
    injectTestFault(options, "after_staging_close");
    fsyncPath(layout.ledger);
    fsyncPath(layout.blobs);
    fsyncPath(layout.backups);
    fsyncPath(layout.root);
    injectTestFault(options, "after_staging_fsync");

    injectTestFault(options, "before_publish");
    reservation.publish(staging);
    injectTestFault(options, "after_publish_parent_fsync");
    const published = await finalizePublishedTarget({
      target,
      options,
      manifest,
      operationId,
      publication: "published",
    });
    injectTestFault(options, "after_publish_before_response");
    return published;
  } catch (error) {
    if (client !== undefined) {
      await client.close().catch(() => undefined);
    }
    if (
      options.testFaultAt !== "after_publish_before_response" &&
      existsSync(target)
    ) {
      const current = options.recoveryHeadProvider.readCurrent();
      if (current !== null) {
        const currentMarker = markerFor({
          operationId,
          manifestHash: manifest.manifest_hash,
          anchorHash: current.anchor_hash,
        });
        if (hasExactPublicationMarker(target, currentMarker)) {
          return inspectPublishedTarget({
            target,
            options,
            manifest,
            publication: "reconciled",
          });
        }
      }
    }
    throw error;
  } finally {
    reservation.release();
    if (existsSync(staging)) {
      rmSync(staging, { recursive: true, force: true });
    }
  }
}
