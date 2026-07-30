import { canonicalSha256 } from "@memo-graph/contracts";

import { inspectBackup } from "./backup.js";

export function restoreDryRun(input: {
  backupDirectory: string;
  backupRef: string;
  targetRef: string;
}) {
  const inspection = inspectBackup(input.backupDirectory);
  return {
    schema_version: "1.0.0" as const,
    status: "operator_action_required" as const,
    publication: "disabled_until_u5" as const,
    backup_id: inspection.backup_id,
    manifest_hash: inspection.manifest_hash,
    intent_digest: canonicalSha256({
      operation: "restore",
      backup_ref: input.backupRef,
      target_ref: input.targetRef,
      manifest_hash: inspection.manifest_hash,
    }),
  };
}
