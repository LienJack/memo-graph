import { canonicalSha256 } from "@memo-graph/contracts";
import { verifyCompleteBackupBundle } from "@memo-graph/storage-sqlite";

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
