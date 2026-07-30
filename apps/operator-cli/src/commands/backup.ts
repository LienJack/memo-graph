import { canonicalSha256 } from "@memo-graph/contracts";
import { join } from "node:path";
import {
  BackupResultSchema,
  verifyCompleteBackupBundle,
  type RecoveryHeadProvider,
} from "@memo-graph/storage-sqlite";

export function inspectBackup(directory: string) {
  const manifest = verifyCompleteBackupBundle({ directory });
  return {
    schema_version: "1.0.0" as const,
    status: "bundle_verified" as const,
    freshness: "external_head_not_checked" as const,
    backup_id: manifest.backup_id,
    manifest_hash: manifest.manifest_hash,
    database_logical_hash: manifest.database.logical_hash,
    artifact_count: manifest.artifacts.length,
    required_key_count: manifest.encryption.required_keys.length,
    frontier_digest: canonicalSha256(manifest.frontiers),
  };
}

export function loadBackupResult(
  directory: string,
  recoveryHeadProvider: RecoveryHeadProvider,
) {
  const manifest = verifyCompleteBackupBundle({ directory });
  const anchor = recoveryHeadProvider.readCurrent();
  if (
    anchor === null ||
    anchor.payload.backup_manifest_hash !== manifest.manifest_hash
  ) {
    throw new Error("backup recovery anchor is not current");
  }
  return BackupResultSchema.parse({
    backup_id: manifest.backup_id,
    directory,
    path: join(directory, manifest.database.bundle_path),
    ledger_epoch: manifest.frontiers.ledger_epoch,
    tombstone_epoch: manifest.frontiers.tombstone_epoch,
    learning_control_epoch:
      manifest.frontiers.learning_control_epoch,
    learning_release_revision:
      manifest.frontiers.learning_release_revision,
    learning_frontier_hash:
      manifest.frontiers.learning_frontier_hash,
    latest_receipt_hash: manifest.frontiers.latest_receipt_hash,
    blob_hashes: manifest.artifacts
      .filter(({ kind }) => kind === "blob")
      .map(({ raw_hash }) => raw_hash),
    integrity_check: "ok",
    size_bytes: manifest.database.size_bytes,
    manifest_path: join(directory, "manifest.json"),
    manifest,
    recovery_anchor: anchor,
  });
}
