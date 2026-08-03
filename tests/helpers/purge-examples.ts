export const PURGE_NOW = "2026-07-28T13:00:00.000Z";
export const PURGE_SCOPE = {
  kind: "workspace",
  id: "workspace_local",
} as const;

export function deleteRequest(options: {
  memoryId: string;
  revisionId: string;
  idempotencyKey: string;
  approvalId: string | null;
  dryRun?: boolean;
}) {
  return {
    envelope: {
      schema_version: "1.0.0",
      request_id: `request_${options.idempotencyKey}`,
      tool: "memory_delete",
      safety_class: "destructive",
      actor_claim: {
        principal_id: "user_local",
        authority: "user_stated",
      },
      scopes: [PURGE_SCOPE],
      purpose: "Delete one governed memory and purge its content",
      reason: "The local user requested this exact deletion",
      requested_at: PURGE_NOW,
      idempotency_key: options.idempotencyKey,
      expected_revision_id: options.revisionId,
      approval_id: options.approvalId,
      dry_run: options.dryRun ?? false,
    },
    memory_id: options.memoryId,
  } as const;
}
